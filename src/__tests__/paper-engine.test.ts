/**
 * Paper Trading Engine Tests
 *
 * - buy debits paper cash and creates a position
 * - sell credits paper cash and computes realized P&L
 * - buy rejected when it would exceed paper cash
 * - sell rejected when it exceeds held qty
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";
import type { AutomatonDatabase } from "../types.js";
import {
  simulateBuy,
  simulateSell,
  getPaperCash,
  getPaperPositions,
} from "../trading/paper-engine.js";

function createTestDb(): { raw: Database.Database; db: AutomatonDatabase } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paper-engine-test-"));
  const raw = new Database(path.join(tmpDir, "test.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      side TEXT NOT NULL CHECK(side IN ('buy','sell')),
      qty INTEGER NOT NULL,
      price_krw INTEGER NOT NULL,
      cost_krw INTEGER NOT NULL,
      realized_pnl_krw INTEGER,
      cash_after_krw INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const db: AutomatonDatabase = {
    raw,
    getKV: (key: string) => {
      const row = raw.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row?.value;
    },
    setKV: (key: string, value: string) => {
      raw
        .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
    },
    runTransaction: <T>(fn: () => T): T => raw.transaction(fn)(),
  } as unknown as AutomatonDatabase;

  return { raw, db };
}

describe("paper-engine", () => {
  let raw: Database.Database;
  let db: AutomatonDatabase;

  beforeEach(() => {
    ({ raw, db } = createTestDb());
  });

  afterEach(() => {
    raw.close();
  });

  it("seeds and returns the paper cash balance on first read", () => {
    expect(getPaperCash(db, 1_000_000)).toBe(1_000_000);
    // Second read returns the persisted value, not a re-seed
    expect(getPaperCash(db, 999)).toBe(1_000_000);
  });

  it("buy debits paper cash and creates a position", () => {
    const result = simulateBuy(db, { code: "005930", qty: 10, priceKrw: 70_000 }, 1_000_000);
    expect(result.ok).toBe(true);
    expect(result.cashAfterKrw).toBe(1_000_000 - 700_000);

    const positions = getPaperPositions(db);
    expect(positions).toEqual([{ code: "005930", qty: 10, avgCostKrw: 70_000 }]);
  });

  it("rejects a buy that would exceed paper cash", () => {
    const result = simulateBuy(db, { code: "005930", qty: 100, priceKrw: 70_000 }, 1_000_000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Insufficient paper cash/);
    expect(getPaperPositions(db)).toEqual([]);
  });

  it("sell credits paper cash and computes realized P&L", () => {
    simulateBuy(db, { code: "005930", qty: 10, priceKrw: 70_000 }, 1_000_000);
    const result = simulateSell(db, { code: "005930", qty: 10, priceKrw: 80_000 }, 1_000_000);
    expect(result.ok).toBe(true);
    expect(result.trade?.realizedPnlKrw).toBe(100_000); // (80000-70000)*10
    expect(result.cashAfterKrw).toBe(1_000_000 - 700_000 + 800_000);
    expect(getPaperPositions(db)).toEqual([]);
  });

  it("rejects a sell that exceeds the held quantity", () => {
    simulateBuy(db, { code: "005930", qty: 5, priceKrw: 70_000 }, 1_000_000);
    const result = simulateSell(db, { code: "005930", qty: 10, priceKrw: 80_000 }, 1_000_000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only 5 held/);
  });

  it("rejects a sell with no position at all", () => {
    const result = simulateSell(db, { code: "005930", qty: 1, priceKrw: 80_000 }, 1_000_000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only 0 held/);
  });
});
