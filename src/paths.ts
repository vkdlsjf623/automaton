import os from "os";

/**
 * Resolve the user's home directory. `process.env.HOME` is unset on native
 * Windows shells (PowerShell/cmd use USERPROFILE instead), so falling back
 * to a hardcoded "/root" silently redirects everything under a Windows
 * drive root (e.g. C:\root\.automaton) instead of the real profile.
 * os.homedir() resolves correctly on every platform.
 */
export function getHomeDir(): string {
  return process.env.HOME || os.homedir();
}
