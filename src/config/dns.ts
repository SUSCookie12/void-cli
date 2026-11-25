import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Void Network — DNS & Relay Configuration
 *
 * By default, the daemon communicates with the autonomous Void DNS Broker API
 * (`https://borgov.dev/api/void/dns`) authenticated via the host's Firebase
 * node credentials (`uid` + `daemonId`), so end-user machines never require
 * raw Cloudflare API tokens.
 */

// Helper to read local .env or ~/.void/.env if present
function loadLocalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.void', '.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf-8');
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const key = trimmed.slice(0, eq).trim();
            const val = trimmed.slice(eq + 1).trim();
            if (!process.env[key]) {
              process.env[key] = val;
            }
            env[key] = val;
          }
        }
      } catch {}
    }
  }
  return env;
}

loadLocalEnv();

const rawDomain = process.env.VOID_SERVER_DOMAIN || process.env.VOID_DOMAIN;
export const VOID_DOMAIN = (rawDomain && rawDomain !== 'void.borgov.dev')
  ? rawDomain
  : 's.borgov.dev';

export const VOID_DNS_API_URL =
  process.env.VOID_DNS_API_URL || 'https://borgov.dev/api/void/dns';

export const VOID_RELAY_HOST = process.env.VOID_RELAY_HOST || `relay.${VOID_DOMAIN}`;

export const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN || '';
export const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID || '';

export const CLOUDFLARE_CONFIG = {
  apiToken: CLOUDFLARE_API_TOKEN,
  zoneId: CLOUDFLARE_ZONE_ID,
};

/** Returns true if direct local Cloudflare credentials are set. */
export function isDirectCloudflareConfigured(): boolean {
  return Boolean(CLOUDFLARE_CONFIG.apiToken && CLOUDFLARE_CONFIG.zoneId);
}

