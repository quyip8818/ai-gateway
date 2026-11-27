import { setTimeout as delay } from "node:timers/promises";
import { request } from "./core.ts";

const HISTORY_TIMEOUT_MS = 2_000;
const CONSUMPTION_TYPES = new Set<unknown>([2, "2", "CONSUME", "CONSUMED"]);

type CreditRecord = {
  submit_id?: unknown;
  history_type?: unknown;
  status?: unknown;
  amount?: unknown;
};

function settledCredits(records: unknown, submitId: string): number | null {
  if (!Array.isArray(records)) return null;
  const matches = (records as (CreditRecord | null)[]).filter((row) =>
    row?.submit_id === submitId && row.status === "Checked" && CONSUMPTION_TYPES.has(row.history_type),
  );
  // The top-level amount is the total shown in the ledger. Its sub-records
  // break down that same charge.
  const [record] = matches;
  if (!record || matches.length !== 1) return null;
  const { amount } = record;
  const value = typeof amount === "string" && /^-?\d+$/.test(amount) ? Number(amount) : amount;
  return typeof value === "number" && Number.isSafeInteger(value) ? Math.abs(value) : null;
}

/** Check the first consumption page once and use only the current task's settled record. */
export async function readImageCredits(token: string, submitId: string): Promise<number | null> {
  const lookup = new AbortController();
  try {
    const page = await Promise.race([
      request("post", "/commerce/v1/benefits/user_credit_history", token, {
        data: { cursor: "0", count: 20, history_type: 2, need_with_hold: false },
        signal: lookup.signal,
        timeout: HISTORY_TIMEOUT_MS,
      }, { retry: false, browserFallback: false, logPayload: false }),
      delay(HISTORY_TIMEOUT_MS, undefined, { signal: lookup.signal }),
    ]);
    return settledCredits(page?.records, submitId);
  } catch {
    return null;
  } finally {
    lookup.abort();
  }
}
