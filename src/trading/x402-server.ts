/**
 * x402 Resource Server
 *
 * Sells the automaton's own inference capability as a priced HTTP endpoint,
 * paid in USDC via the x402 protocol (EIP-3009 TransferWithAuthorization,
 * Base mainnet). This is the mirror image of the existing x402 CLIENT
 * implementation in src/conway/x402.ts (checkX402/x402Fetch/signPayment) —
 * same wire format, so any client compatible with that code (including
 * this automaton's own x402Fetch) can pay this endpoint.
 *
 * The automaton acts as its own facilitator: it verifies the EIP-712
 * signature offline, then submits the transferWithAuthorization call
 * itself to settle on-chain. This needs a small ETH balance on Base for
 * gas — see README note in the plan.
 *
 * No third-party x402 package is used; this hand-rolls the protocol the
 * same way src/conway/x402.ts already does, for consistency.
 */

import http from "http";
import {
  createPublicClient,
  createWalletClient,
  http as viemHttp,
  hexToSignature,
  recoverTypedDataAddress,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base } from "viem/chains";
import { insertDedupKey } from "../state/database.js";
import type { AutomatonDatabase, InferenceClient } from "../types.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("x402-server");

const USDC_ADDRESS_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NETWORK = "eip155:8453";
const REQUIRED_DEADLINE_SECONDS = 300;
const NONCE_TTL_MS = REQUIRED_DEADLINE_SECONDS * 1000 + 60_000;

const TRANSFER_WITH_AUTH_ABI = [
  {
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "transferWithAuthorization",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

interface PaymentAuthorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: { signature: `0x${string}`; authorization: PaymentAuthorization };
}

export interface X402ServerOptions {
  port: number;
  route: string;
  priceUsdc: number;
  payToAddress: Address;
  account: PrivateKeyAccount;
  db: AutomatonDatabase;
  inference: InferenceClient;
  rpcUrl?: string;
  /** Injectable for tests — replaces the real on-chain settlement call. */
  settleFn?: (auth: PaymentAuthorization, signature: `0x${string}`) => Promise<{ txHash: string }>;
}

function priceToAtomicUnits(priceUsdc: number): bigint {
  // USDC has 6 decimals
  return BigInt(Math.round(priceUsdc * 1_000_000));
}

function paymentRequiredBody(opts: X402ServerOptions) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        maxAmountRequired: priceToAtomicUnits(opts.priceUsdc).toString(),
        payToAddress: opts.payToAddress,
        requiredDeadlineSeconds: REQUIRED_DEADLINE_SECONDS,
        usdcAddress: USDC_ADDRESS_BASE,
      },
    ],
  };
}

function parsePaymentHeader(header: string): PaymentPayload | null {
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded);
    if (
      typeof parsed !== "object" ||
      !parsed?.payload?.signature ||
      !parsed?.payload?.authorization
    ) {
      return null;
    }
    return parsed as PaymentPayload;
  } catch {
    return null;
  }
}

async function verifyPayment(
  payment: PaymentPayload,
  opts: X402ServerOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { authorization, signature } = payment.payload;
  const requiredAtomic = priceToAtomicUnits(opts.priceUsdc);
  const value = BigInt(authorization.value);
  const now = Math.floor(Date.now() / 1000);

  if (authorization.to.toLowerCase() !== opts.payToAddress.toLowerCase()) {
    return { ok: false, error: "Payment recipient does not match this service" };
  }
  if (value < requiredAtomic) {
    return { ok: false, error: `Payment amount ${value} below required ${requiredAtomic}` };
  }
  if (now < Number(authorization.validAfter) || now > Number(authorization.validBefore)) {
    return { ok: false, error: "Payment authorization is not currently valid (time window)" };
  }

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

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      domain,
      types,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value,
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    });
  } catch (err: any) {
    return { ok: false, error: `Signature recovery failed: ${err?.message || err}` };
  }

  if (recovered.toLowerCase() !== authorization.from.toLowerCase()) {
    return { ok: false, error: "Signature does not match the claimed payer address" };
  }

  // Replay protection: each nonce may settle exactly once.
  const inserted = insertDedupKey(
    opts.db.raw,
    `x402:nonce:${authorization.nonce}`,
    "x402_payment",
    NONCE_TTL_MS,
  );
  if (!inserted) {
    return { ok: false, error: "Payment authorization already used (replay)" };
  }

  return { ok: true };
}

async function settlePaymentOnChain(
  authorization: PaymentAuthorization,
  signature: `0x${string}`,
  opts: X402ServerOptions,
): Promise<{ txHash: string }> {
  if (opts.settleFn) {
    return opts.settleFn(authorization, signature);
  }

  const { v, r, s, yParity } = hexToSignature(signature);
  // viem may return v as bigint|undefined depending on the signature form;
  // the contract ABI needs a plain uint8 (27/28). Derive from yParity if v is absent.
  const vNumber = v !== undefined ? Number(v) : (yParity === 0 ? 27 : 28);
  const walletClient = createWalletClient({
    account: opts.account,
    chain: base,
    transport: viemHttp(opts.rpcUrl),
  });
  const publicClient = createPublicClient({ chain: base, transport: viemHttp(opts.rpcUrl) });

  const txHash = await walletClient.writeContract({
    address: USDC_ADDRESS_BASE,
    abi: TRANSFER_WITH_AUTH_ABI,
    functionName: "transferWithAuthorization",
    args: [
      authorization.from,
      authorization.to,
      BigInt(authorization.value),
      BigInt(authorization.validAfter),
      BigInt(authorization.validBefore),
      authorization.nonce,
      vNumber,
      r,
      s,
    ],
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Create (but do not start listening on) the x402 resource server.
 * Call `.listen(opts.port)` on the returned server.
 */
export function createX402Server(opts: X402ServerOptions): http.Server {
  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Payment");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url !== opts.route || req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const paymentHeader = req.headers["x-payment"];
    const headerValue = Array.isArray(paymentHeader) ? paymentHeader[0] : paymentHeader;

    if (!headerValue) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify(paymentRequiredBody(opts)));
      return;
    }

    const payment = parsePaymentHeader(headerValue);
    if (!payment) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Malformed X-Payment header" }));
      return;
    }

    const verification = await verifyPayment(payment, opts);
    if (!verification.ok) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: verification.error, ...paymentRequiredBody(opts) }));
      return;
    }

    let settlement: { txHash: string };
    try {
      settlement = await settlePaymentOnChain(payment.payload.authorization, payment.payload.signature, opts);
    } catch (err: any) {
      logger.error("x402 settlement failed", err instanceof Error ? err : undefined);
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Settlement failed: ${err?.message || err}` }));
      return;
    }

    const body = await readBody(req);
    let prompt: string;
    try {
      const parsed = JSON.parse(body);
      prompt = typeof parsed.prompt === "string" ? parsed.prompt : body;
    } catch {
      prompt = body;
    }

    try {
      const response = await opts.inference.chat([{ role: "user", content: prompt }]);
      // Logged in onchain_transactions (revenue), NOT spend_tracking — the
      // latter feeds treasury limit-checking (checkLimit) and is a pure
      // spend ledger; mixing revenue into it would distort daily/hourly
      // spend caps for unrelated categories.
      opts.db.raw
        .prepare(
          `INSERT INTO onchain_transactions (id, tx_hash, chain, operation, status, metadata)
           VALUES (?, ?, 'base', 'x402_receive', 'confirmed', ?)`,
        )
        .run(
          settlement.txHash,
          settlement.txHash,
          JSON.stringify({ priceUsdc: opts.priceUsdc, from: payment.payload.authorization.from }),
        );

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ response: response.message.content, txHash: settlement.txHash }));
    } catch (err: any) {
      logger.error("x402 service inference failed", err instanceof Error ? err : undefined);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Inference failed", txHash: settlement.txHash }));
    }
  });
}
