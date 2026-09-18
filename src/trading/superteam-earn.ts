/**
 * Superteam Earn — Agent Bounty Channel
 *
 * Superteam Earn ships a first-class, agent-native API: an agent
 * self-registers (no human account needed), discovers agent-eligible
 * bounty/project/hackathon listings, and submits work directly. Payout
 * is the only step gated on a human — the agent hands the human a
 * claimCode, and only the human (with their own Privy token) can claim
 * it, so there is no "paper vs real" ambiguity to design around here:
 * submissions are real, but nothing pays out without the creator's own
 * action, matching the genesis prompt's "explicit creator approval
 * before anything material happens" posture for free.
 *
 * Docs: https://superteam.fun/earn/agents/
 */

import { ResilientHttpClient } from "../conway/http-client.js";
import type { AutomatonDatabase } from "../types.js";

const BASE_URL = "https://superteam.fun";
const httpClient = new ResilientHttpClient();

const KV_API_KEY = "superteam_api_key";
const KV_CLAIM_CODE = "superteam_claim_code";
const KV_AGENT_ID = "superteam_agent_id";
const KV_USERNAME = "superteam_username";

export interface SuperteamCredentials {
  apiKey: string;
  claimCode: string;
  agentId: string;
  username: string;
}

export function getStoredCredentials(db: AutomatonDatabase): SuperteamCredentials | null {
  const apiKey = db.getKV(KV_API_KEY);
  if (!apiKey) return null;
  return {
    apiKey,
    claimCode: db.getKV(KV_CLAIM_CODE) || "",
    agentId: db.getKV(KV_AGENT_ID) || "",
    username: db.getKV(KV_USERNAME) || "",
  };
}

/** Idempotent: returns existing credentials if already registered rather than re-registering. */
export async function registerAgent(
  db: AutomatonDatabase,
  name: string,
): Promise<SuperteamCredentials> {
  const existing = getStoredCredentials(db);
  if (existing) return existing;

  const resp = await httpClient.request(`${BASE_URL}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!resp.ok) {
    throw new Error(`Superteam Earn registration failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as SuperteamCredentials;

  db.setKV(KV_API_KEY, data.apiKey);
  db.setKV(KV_CLAIM_CODE, data.claimCode);
  db.setKV(KV_AGENT_ID, data.agentId);
  db.setKV(KV_USERNAME, data.username);

  return data;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

export interface ListingsQuery {
  take?: number;
  type?: "bounty" | "project" | "hackathon";
  deadline?: string; // ISO-8601, lower-bound filter
}

export async function getLiveListings(apiKey: string, query: ListingsQuery = {}): Promise<any> {
  const params = new URLSearchParams();
  if (query.take) params.set("take", String(query.take));
  if (query.type) params.set("type", query.type);
  if (query.deadline) params.set("deadline", query.deadline);
  const qs = params.toString();

  const resp = await httpClient.request(
    `${BASE_URL}/api/agents/listings/live${qs ? `?${qs}` : ""}`,
    { headers: authHeaders(apiKey) },
  );
  if (!resp.ok) {
    throw new Error(`Failed to fetch listings: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

export async function getListingDetails(apiKey: string, slug: string): Promise<any> {
  const resp = await httpClient.request(
    `${BASE_URL}/api/agents/listings/details/${encodeURIComponent(slug)}`,
    { headers: authHeaders(apiKey) },
  );
  if (!resp.ok) {
    throw new Error(`Failed to fetch listing details: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

export interface SubmissionParams {
  listingId: string;
  link: string;
  otherInfo?: string;
  eligibilityAnswers?: { question: string; answer: string }[];
  ask?: number | null;
  telegram?: string;
}

export async function submitWork(apiKey: string, params: SubmissionParams): Promise<any> {
  const resp = await httpClient.request(`${BASE_URL}/api/agents/submissions/create`, {
    method: "POST",
    headers: { ...authHeaders(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({ tweet: "", ask: null, ...params }),
  });
  if (!resp.ok) {
    throw new Error(`Submission failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}
