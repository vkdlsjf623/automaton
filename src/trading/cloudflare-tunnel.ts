/**
 * Cloudflare Quick Tunnel
 *
 * Exposes a local port at a public https://*.trycloudflare.com URL, no
 * account or domain required. Spawned as a subprocess (execFile-style
 * argument array, no shell interpolation) — the URL is ephemeral and
 * changes every run, which is fine for V1; a Named Tunnel (stable custom
 * domain) is a documented follow-up, not built here.
 */

import { spawn } from "child_process";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("cloudflare-tunnel");
const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const START_TIMEOUT_MS = 30_000;

export interface QuickTunnelHandle {
  url: string;
  stop: () => void;
}

/**
 * Start a cloudflared quick tunnel pointing at http://localhost:<port>.
 * Resolves once the public URL has been assigned.
 */
export function startQuickTunnel(port: number): Promise<QuickTunnelHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://localhost:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        child.kill();
        reject(new Error("Timed out waiting for cloudflared to assign a public URL"));
      }
    }, START_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      const match = text.match(QUICK_TUNNEL_URL_RE);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({
          url: match[0],
          stop: () => child.kill(),
        });
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData); // cloudflared logs the URL to stderr

    child.on("error", (err) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`Failed to start cloudflared: ${err.message}`));
      }
    });

    child.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited before assigning a URL (code ${code})`));
      } else {
        logger.info(`cloudflared tunnel exited (code ${code})`);
      }
    });
  });
}
