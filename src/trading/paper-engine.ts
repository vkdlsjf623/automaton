/**
 * Paper Trading Engine (KRW)
 *
 * A local, simulated trading ledger against a notional KRW cash balance —
 * intentionally NOT tied to the real 종합계좌 cash balance (see
 * kiwoom-cli.ts's getCashBalance, which stays purely informational). Real
 * quotes are used to price simulated fills; no real orders are ever
 * placed. Positions are derived from the trade log rather than stored
 * separately, so there's one source of truth.
 */

import { ulid } from "ulid";
import type { AutomatonDatabase } from "../types.js";

const PAPER_CASH_KEY = "paper_cash_krw";
export const DEFAULT_PAPER_STARTING_BALANCE_KRW = 1_000_000;

export interface PaperPosition {
  code: string;
  qty: number;
  avgCostKrw: number;
}

export interface PaperTrade {
  id: string;
  code: string;
  side: "buy" | "sell";
  qty: number;
  priceKrw: number;
  costKrw: number;
  realizedPnlKrw?: number;
}

export interface PaperTradeResult {
  ok: boolean;
  error?: string;
  trade?: PaperTrade;
  cashAfterKrw: number;
}

interface PaperTradeRow {
  code: string;
  side: "buy" | "sell";
  qty: number;
  price_krw: number;
}

/** Get the current paper cash balance, seeding it on first read. */
export function getPaperCash(
  db: AutomatonDatabase,
  startingBalanceKrw: number = DEFAULT_PAPER_STARTING_BALANCE_KRW,
): number {
  const raw = db.getKV(PAPER_CASH_KEY);
  if (raw === undefined) {
    db.setKV(PAPER_CASH_KEY, String(startingBalanceKrw));
    return startingBalanceKrw;
  }
  return parseInt(raw, 10);
}

/** Derive current positions (qty > 0) from the trade log — no separate positions table. */
export function getPaperPositions(db: AutomatonDatabase): PaperPosition[] {
  const rows = db.raw
    .prepare(`SELECT code, side, qty, price_krw FROM paper_trades ORDER BY created_at ASC`)
    .all() as PaperTradeRow[];

  const byCode = new Map<string, { qty: number; totalCostKrw: number }>();
  for (const row of rows) {
    const pos = byCode.get(row.code) ?? { qty: 0, totalCostKrw: 0 };
    if (row.side === "buy") {
      pos.qty += row.qty;
      pos.totalCostKrw += row.qty * row.price_krw;
    } else {
      const avgCost = pos.qty > 0 ? pos.totalCostKrw / pos.qty : 0;
      pos.qty -= row.qty;
      pos.totalCostKrw -= avgCost * row.qty;
    }
    byCode.set(row.code, pos);
  }

  return [...byCode.entries()]
    .filter(([, pos]) => pos.qty > 0)
    .map(([code, pos]) => ({
      code,
      qty: pos.qty,
      avgCostKrw: pos.totalCostKrw / pos.qty,
    }));
}

function insertTrade(
  db: AutomatonDatabase,
  trade: PaperTrade,
  cashAfterKrw: number,
): void {
  db.raw
    .prepare(
      `INSERT INTO paper_trades (id, code, side, qty, price_krw, cost_krw, realized_pnl_krw, cash_after_krw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      trade.id,
      trade.code,
      trade.side,
      trade.qty,
      trade.priceKrw,
      trade.costKrw,
      trade.realizedPnlKrw ?? null,
      cashAfterKrw,
    );
}

/** Simulate a buy: rejected if it would exceed the paper cash balance. */
export function simulateBuy(
  db: AutomatonDatabase,
  params: { code: string; qty: number; priceKrw: number },
  startingBalanceKrw: number = DEFAULT_PAPER_STARTING_BALANCE_KRW,
): PaperTradeResult {
  const { code, qty, priceKrw } = params;
  if (qty <= 0 || priceKrw <= 0) {
    return {
      ok: false,
      error: "qty and priceKrw must be positive",
      cashAfterKrw: getPaperCash(db, startingBalanceKrw),
    };
  }

  return db.runTransaction(() => {
    const cash = getPaperCash(db, startingBalanceKrw);
    const cost = qty * priceKrw;
    if (cost > cash) {
      return {
        ok: false,
        error: `Insufficient paper cash: need ₩${cost.toLocaleString()}, have ₩${cash.toLocaleString()}`,
        cashAfterKrw: cash,
      };
    }

    const cashAfter = cash - cost;
    db.setKV(PAPER_CASH_KEY, String(cashAfter));
    const trade: PaperTrade = { id: ulid(), code, side: "buy", qty, priceKrw, costKrw: cost };
    insertTrade(db, trade, cashAfter);
    return { ok: true, trade, cashAfterKrw: cashAfter };
  });
}

/** Simulate a sell: rejected if it exceeds the currently held quantity. */
export function simulateSell(
  db: AutomatonDatabase,
  params: { code: string; qty: number; priceKrw: number },
  startingBalanceKrw: number = DEFAULT_PAPER_STARTING_BALANCE_KRW,
): PaperTradeResult {
  const { code, qty, priceKrw } = params;
  if (qty <= 0 || priceKrw <= 0) {
    return {
      ok: false,
      error: "qty and priceKrw must be positive",
      cashAfterKrw: getPaperCash(db, startingBalanceKrw),
    };
  }

  return db.runTransaction(() => {
    const position = getPaperPositions(db).find((p) => p.code === code);
    const held = position?.qty ?? 0;
    if (qty > held) {
      return {
        ok: false,
        error: `Cannot sell ${qty} of ${code}: only ${held} held`,
        cashAfterKrw: getPaperCash(db, startingBalanceKrw),
      };
    }

    const proceeds = qty * priceKrw;
    const cash = getPaperCash(db, startingBalanceKrw);
    const cashAfter = cash + proceeds;
    db.setKV(PAPER_CASH_KEY, String(cashAfter));
    const realizedPnlKrw = Math.round((priceKrw - position!.avgCostKrw) * qty);
    const trade: PaperTrade = {
      id: ulid(),
      code,
      side: "sell",
      qty,
      priceKrw,
      costKrw: proceeds,
      realizedPnlKrw,
    };
    insertTrade(db, trade, cashAfter);
    return { ok: true, trade, cashAfterKrw: cashAfter };
  });
}
