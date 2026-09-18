/**
 * Superteam Earn Client Tests
 *
 * - registerAgent stores credentials via KV and is idempotent
 * - getLiveListings sends the bearer token and query params correctly
 * - submitWork posts the expected body
 * - non-ok responses surface a clear error
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { AutomatonDatabase } from "../types.js";
import {
  registerAgent,
  getStoredCredentials,
  getLiveListings,
  submitWork,
} from "../trading/superteam-earn.js";

function makeDb(): AutomatonDatabase {
  const kv = new Map<string, string>();
  return {
    getKV: (key: string) => kv.get(key),
    setKV: (key: string, value: string) => {
      kv.set(key, value);
    },
  } as unknown as AutomatonDatabase;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("superteam-earn client", () => {
  it("registerAgent stores credentials and is idempotent", async () => {
    const db = makeDb();
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        apiKey: "sk_test123",
        claimCode: "ABC123",
        agentId: "agent-1",
        username: "autome",
      }),
    );
    vi.stubGlobal("fetch", mockFetch);

    const creds = await registerAgent(db, "autome");
    expect(creds.apiKey).toBe("sk_test123");
    expect(getStoredCredentials(db)).toEqual(creds);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call should NOT re-register — reuses stored credentials.
    const creds2 = await registerAgent(db, "autome");
    expect(creds2).toEqual(creds);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("getLiveListings sends the bearer token and query params", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ listings: [] }));
    vi.stubGlobal("fetch", mockFetch);

    await getLiveListings("sk_test123", { type: "bounty", take: 5 });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/listings/live?");
    expect(url).toContain("type=bounty");
    expect(url).toContain("take=5");
    expect((opts.headers as Record<string, string>).Authorization).toBe("Bearer sk_test123");
  });

  it("submitWork posts the expected body", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ id: "sub-1" }));
    vi.stubGlobal("fetch", mockFetch);

    await submitWork("sk_test123", {
      listingId: "listing-1",
      link: "https://example.com/work",
      otherInfo: "Built a thing",
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/agents/submissions/create");
    expect(opts.method).toBe("POST");
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({
      listingId: "listing-1",
      link: "https://example.com/work",
      otherInfo: "Built a thing",
    });
  });

  it("surfaces a clear error on a non-ok response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ error: "nope" }, false, 403));
    vi.stubGlobal("fetch", mockFetch);

    await expect(registerAgent(makeDb(), "autome")).rejects.toThrow(/403/);
  });
});
