/**
 * x402 Resource Server Tests
 *
 * - responds 402 with a well-formed challenge when no payment is presented
 * - accepts a validly signed payment, settles (stubbed), and serves the response
 * - rejects a replayed (already-used) payment nonce
 * - rejects a payment signed for the wrong recipient
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import type { PrivateKeyAccount } from "viem";
import type { AutomatonDatabase, InferenceClient } from "../types.js";
import { createX402Server } from "../trading/x402-server.js";

const USDC_ADDRESS_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// EIP-712 typed-data signing enforces EIP-55 checksummed addresses, so test
// addresses must come from real accounts rather than hand-typed hex.
const PAY_TO = privateKeyToAccount(generatePrivateKey()).address;
const WRONG_RECIPIENT = privateKeyToAccount(generatePrivateKey()).address;

function createTestDb(): { raw: Database.Database; db: AutomatonDatabase } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "x402-server-test-"));
  const raw = new Database(path.join(tmpDir, "test.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS heartbeat_dedup (
      dedup_key TEXT PRIMARY KEY,
      task_name TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS onchain_transactions (
      id TEXT PRIMARY KEY,
      tx_hash TEXT NOT NULL UNIQUE,
      chain TEXT NOT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return { raw, db: { raw } as unknown as AutomatonDatabase };
}

function stubInference(): InferenceClient {
  return {
    chat: async () => ({
      id: "test",
      model: "test-model",
      message: { role: "assistant", content: "test response" },
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    }),
    setLowComputeMode: () => {},
    getDefaultModel: () => "test-model",
  };
}

/** Mirrors src/conway/x402.ts's private signPayment(), for test payers. */
async function signTestPayment(
  account: PrivateKeyAccount,
  opts: { to: `0x${string}`; valueAtomic: bigint; nonce?: `0x${string}`; validAfterOffset?: number; validBeforeOffset?: number },
) {
  const nonce =
    opts.nonce ?? (`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}` as const);
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now + (opts.validAfterOffset ?? -60);
  const validBefore = now + (opts.validBeforeOffset ?? 300);

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: base.id,
    verifyingContract: USDC_ADDRESS_BASE,
  } as const;
  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  } as const;
  const message = {
    from: account.address,
    to: opts.to,
    value: opts.valueAtomic,
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce,
  };

  const signature = await account.signTypedData({
    domain,
    types,
    primaryType: "TransferWithAuthorization",
    message,
  });

  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: "eip155:8453",
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: opts.to,
        value: opts.valueAtomic.toString(),
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("x402 resource server", () => {
  let raw: Database.Database;
  let db: AutomatonDatabase;
  let payerAccount: PrivateKeyAccount;
  let server: import("http").Server;
  let baseUrl: string;

  beforeEach(async () => {
    ({ raw, db } = createTestDb());
    payerAccount = privateKeyToAccount(generatePrivateKey());

    server = createX402Server({
      port: 0,
      route: "/v1/ask",
      priceUsdc: 0.02,
      payToAddress: PAY_TO,
      account: privateKeyToAccount(generatePrivateKey()), // service's own account (unused when settleFn is stubbed)
      db,
      inference: stubInference(),
      settleFn: async () => ({ txHash: `0xstub${Math.random().toString(16).slice(2)}` }),
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    raw.close();
  });

  it("responds 402 with a well-formed challenge when no payment is presented", async () => {
    const resp = await fetch(`${baseUrl}/v1/ask`, { method: "POST", body: "{}" });
    expect(resp.status).toBe(402);
    const body = await resp.json();
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:8453",
      payToAddress: PAY_TO,
      usdcAddress: USDC_ADDRESS_BASE,
    });
    expect(body.accepts[0].maxAmountRequired).toBe(String(Math.round(0.02 * 1_000_000)));
  });

  it("accepts a validly signed payment, settles, and serves the response", async () => {
    const header = await signTestPayment(payerAccount, {
      to: PAY_TO,
      valueAtomic: BigInt(Math.round(0.02 * 1_000_000)),
    });

    const resp = await fetch(`${baseUrl}/v1/ask`, {
      method: "POST",
      headers: { "X-Payment": header, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.response).toBe("test response");
    expect(body.txHash).toMatch(/^0xstub/);

    const rows = raw.prepare("SELECT * FROM onchain_transactions WHERE operation = 'x402_receive'").all();
    expect(rows).toHaveLength(1);
  });

  it("rejects a replayed (already-used) payment nonce", async () => {
    const header = await signTestPayment(payerAccount, {
      to: PAY_TO,
      valueAtomic: BigInt(Math.round(0.02 * 1_000_000)),
    });

    const first = await fetch(`${baseUrl}/v1/ask`, {
      method: "POST",
      headers: { "X-Payment": header },
      body: "{}",
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/v1/ask`, {
      method: "POST",
      headers: { "X-Payment": header },
      body: "{}",
    });
    expect(second.status).toBe(402);
    const body = await second.json();
    expect(body.error).toMatch(/already used/i);
  });

  it("rejects a payment signed for the wrong recipient", async () => {
    const header = await signTestPayment(payerAccount, {
      to: WRONG_RECIPIENT,
      valueAtomic: BigInt(Math.round(0.02 * 1_000_000)),
    });

    const resp = await fetch(`${baseUrl}/v1/ask`, {
      method: "POST",
      headers: { "X-Payment": header },
      body: "{}",
    });
    expect(resp.status).toBe(402);
    const body = await resp.json();
    expect(body.error).toMatch(/recipient/i);
  });

  it("rejects a payment below the required amount", async () => {
    const header = await signTestPayment(payerAccount, {
      to: PAY_TO,
      valueAtomic: 1n, // far below the 20000-atomic-unit price
    });

    const resp = await fetch(`${baseUrl}/v1/ask`, {
      method: "POST",
      headers: { "X-Payment": header },
      body: "{}",
    });
    expect(resp.status).toBe(402);
    const body = await resp.json();
    expect(body.error).toMatch(/below required/i);
  });
});
