/**
 * Kiwoom CLI Wrapper
 *
 * Shells out to the locally installed `kiwoomcli` binary for real KRW
 * market data and account queries. Read-only by design: only `quotes` and
 * `accounts` subcommands are ever invoked here. No code in this module
 * (or anywhere in src/trading/) constructs a `domestic orders` command —
 * real order submission is out of scope for the paper-trading engine.
 *
 * Uses execFile with an argument array (no shell interpolation), matching
 * the convention in src/self-mod/upstream.ts.
 */

import { execFile } from "child_process";

const KIWOOM_BIN = "kiwoomcli";
const KIWOOM_PROFILE = "종합";
const TIMEOUT_MS = 15_000;

/**
 * Run a read-only kiwoomcli subcommand and parse its JSON output.
 *
 * @param args e.g. ["domestic", "quotes", "price", "--code", "005930"]
 */
export function runKiwoomCli(args: string[]): Promise<any> {
  const fullArgs = [...args, "--format", "json", "--profile", KIWOOM_PROFILE];
  return new Promise((resolve, reject) => {
    execFile(
      KIWOOM_BIN,
      fullArgs,
      { timeout: TIMEOUT_MS, encoding: "utf-8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`kiwoomcli failed: ${stderr || err.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error(`kiwoomcli returned non-JSON output: ${stdout.slice(0, 500)}`));
        }
      },
    );
  });
}

/** Fetch the current price for a 6-digit KR stock code. */
export async function getStockQuote(code: string): Promise<any> {
  return runKiwoomCli(["domestic", "quotes", "price", "--code", code]);
}

/** Fetch the real 종합계좌 cash balance (예수금 상세). Informational only. */
export async function getCashBalance(): Promise<any> {
  return runKiwoomCli(["domestic", "accounts", "cash", "--cash-basis", "estimated"]);
}
