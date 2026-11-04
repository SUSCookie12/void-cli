import { DAEMON_VERSION } from '../version.js';

/** Raw JSON from void-versions (must match this shape). */
export type VoidServerVersionJson = {
  /** Latest published daemon version, e.g. `"0.1.5"`. */
  latestVersion: string;
  /**
   * If `true`, running an older build than `latestVersion` is treated as a hard requirement to update.
   * If `false`, an outdated build only shows a non-blocking notice.
   */
  updateMandatory: boolean;
};

const VOID_SERVER_VERSION_URL =
  'https://suscookie12.github.io/void-versions/void_server.json';

const FETCH_TIMEOUT_MS = 12_000;

function compareSemverLike(a: string, b: string): number {
  const pa = a.trim().split('.').map(p => parseInt(p, 10) || 0);
  const pb = b.trim().split('.').map(p => parseInt(p, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}

function parsePayload(data: unknown): VoidServerVersionJson | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  const latestVersion = o.latestVersion;
  const updateMandatory = o.updateMandatory;
  if (typeof latestVersion !== 'string' || latestVersion.length === 0) return null;
  if (typeof updateMandatory !== 'boolean') return null;
  return { latestVersion, updateMandatory };
}

/**
 * Fetches remote version policy and applies exit rules for mandatory updates.
 * Logs optional notices; may call `process.exit(1)` when mandatory and outdated.
 */
export async function enforceVoidServerVersionFromRemote(): Promise<void> {
  let raw: string;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(VOID_SERVER_VERSION_URL, {
      signal: ac.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn(`[VOID] Version check skipped (HTTP ${res.status}).`);
      return;
    }
    raw = await res.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[VOID] Version check skipped (network): ${msg}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    console.warn('[VOID] Version check skipped (invalid JSON).');
    return;
  }

  const payload = parsePayload(parsed);
  if (!payload) {
    console.warn('[VOID] Version check skipped (unexpected JSON shape).');
    return;
  }

  const cmp = compareSemverLike(DAEMON_VERSION, payload.latestVersion);
  if (cmp >= 0) {
    return;
  }

  const line = `[VOID] A newer Void Server is available: ${payload.latestVersion} (you have ${DAEMON_VERSION}).`;

  if (payload.updateMandatory) {
    console.error(line);
    console.error('[VOID] Update is required. Install the latest release, then try again.');
    process.exit(1);
  }

  console.warn(line);
  console.warn('[VOID] This version is still allowed; consider updating when convenient.');
}
