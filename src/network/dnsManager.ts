import {
  CLOUDFLARE_CONFIG,
  VOID_DOMAIN,
  VOID_DNS_API_URL,
  isDirectCloudflareConfigured,
} from '../config/dns.js';
import { loadSession } from '../auth/session.js';
import { containsDisallowedWords } from '../utils/subdomainFilter.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

interface CloudflareResponse {
  success: boolean;
  errors?: { message: string }[];
  result?: any;
}

export interface DnsRegistrationResult {
  domain: string;
  subdomain: string;
  resolvedCollision?: boolean;
}

async function cfRequest(method: string, endpoint: string, body?: object): Promise<CloudflareResponse> {
  const res = await fetch(`${CF_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${CLOUDFLARE_CONFIG.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as CloudflareResponse;
}

/**
 * Registers a direct connection (UPnP / Port Forwarded) on `<subdomain>.void.borgov.dev`
 */
export async function registerDirectDns(
  subdomain: string,
  ip: string,
  port: number,
  serverName?: string
): Promise<DnsRegistrationResult> {
  const cleanSub = subdomain.trim().toLowerCase();
  if (!isValidSubdomain(cleanSub)) {
    throw new Error(`Invalid or disallowed subdomain: "${cleanSub}"`);
  }
  const fullDomain = `${cleanSub}.${VOID_DOMAIN}`;

  // 1. Prefer autonomous Void DNS Broker API using daemon session
  const session = loadSession();
  if (session?.uid && session?.daemonId && !isDirectCloudflareConfigured()) {
    try {
      const res = await fetch(VOID_DNS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'register_direct',
          uid: session.uid,
          daemonId: session.daemonId,
          subdomain: cleanSub,
          ip,
          port,
          serverName,
        }),
      });
      const data = (await res.json()) as any;
      if (data?.success && data?.domain) {
        return {
          domain: data.domain,
          subdomain: data.subdomain || cleanSub,
          resolvedCollision: Boolean(data.resolvedCollision),
        };
      }
    } catch {
      // Fallback below if broker is unreachable
    }
  }

  // 2. Optional direct Cloudflare API fallback if local env vars are set
  if (!isDirectCloudflareConfigured()) {
    return { domain: fullDomain, subdomain: cleanSub };
  }

  await deleteTunnelDns(cleanSub);

  const aRes = await cfRequest('POST', `/zones/${CLOUDFLARE_CONFIG.zoneId}/dns_records`, {
    type: 'A',
    name: fullDomain,
    content: ip,
    ttl: 60,
    proxied: false,
  });

  if (!aRes.success) {
    throw new Error(`A record creation failed: ${(aRes.errors || []).map((e) => e.message).join(', ')}`);
  }

  await cfRequest('POST', `/zones/${CLOUDFLARE_CONFIG.zoneId}/dns_records`, {
    type: 'SRV',
    name: `_minecraft._tcp.${fullDomain}`,
    data: {
      service: '_minecraft',
      proto: '_tcp',
      name: fullDomain,
      priority: 0,
      weight: 5,
      port,
      target: fullDomain,
    },
    ttl: 60,
  });

  return { domain: fullDomain, subdomain: cleanSub };
}

/**
 * Registers a tunnel connection (Playit.gg) on `<subdomain>.void.borgov.dev`
 * Creates `_minecraft._tcp.<subdomain>.void.borgov.dev` SRV -> `targetHost:port`
 */
export async function registerTunnelDns(
  subdomain: string,
  targetHost: string,
  port: number,
  serverName?: string
): Promise<DnsRegistrationResult> {
  const cleanSub = subdomain.trim().toLowerCase();
  if (!isValidSubdomain(cleanSub)) {
    throw new Error(`Invalid or disallowed subdomain: "${cleanSub}"`);
  }
  const fullDomain = `${cleanSub}.${VOID_DOMAIN}`;

  // 1. Prefer autonomous Void DNS Broker API using daemon session
  const session = loadSession();
  if (session?.uid && session?.daemonId && !isDirectCloudflareConfigured()) {
    try {
      const res = await fetch(VOID_DNS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'register_tunnel',
          uid: session.uid,
          daemonId: session.daemonId,
          subdomain: cleanSub,
          targetHost,
          port,
          serverName,
        }),
      });
      const data = (await res.json()) as any;
      if (data?.success && data?.domain) {
        return {
          domain: data.domain,
          subdomain: data.subdomain || cleanSub,
          resolvedCollision: Boolean(data.resolvedCollision),
        };
      }
    } catch {
      // Fallback below if broker is unreachable
    }
  }

  // 2. Optional direct Cloudflare API fallback if local env vars are set
  if (!isDirectCloudflareConfigured()) {
    return { domain: fullDomain, subdomain: cleanSub };
  }

  await deleteTunnelDns(cleanSub);

  await cfRequest('POST', `/zones/${CLOUDFLARE_CONFIG.zoneId}/dns_records`, {
    type: 'CNAME',
    name: fullDomain,
    content: targetHost,
    ttl: 60,
    proxied: false,
  });

  const srvRes = await cfRequest('POST', `/zones/${CLOUDFLARE_CONFIG.zoneId}/dns_records`, {
    type: 'SRV',
    name: `_minecraft._tcp.${fullDomain}`,
    data: {
      service: '_minecraft',
      proto: '_tcp',
      name: fullDomain,
      priority: 0,
      weight: 5,
      port,
      target: targetHost,
    },
    ttl: 60,
  });

  if (!srvRes.success) {
    throw new Error(`SRV creation failed: ${(srvRes.errors || []).map((e) => e.message).join(', ')}`);
  }

  return { domain: fullDomain, subdomain: cleanSub };
}

/**
 * Deletes existing DNS records for `<subdomain>.void.borgov.dev`
 */
export async function deleteTunnelDns(subdomain: string): Promise<void> {
  const cleanSub = (subdomain || '').trim().toLowerCase();
  if (!cleanSub) return;

  const session = loadSession();
  if (session?.uid && session?.daemonId && !isDirectCloudflareConfigured()) {
    try {
      await fetch(VOID_DNS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'delete',
          uid: session.uid,
          daemonId: session.daemonId,
          subdomain: cleanSub,
        }),
      });
      return;
    } catch {
      // Ignore cleanup errors
    }
  }

  if (!isDirectCloudflareConfigured()) return;

  const fullDomain = `${cleanSub}.${VOID_DOMAIN}`;
  const srvDomain = `_minecraft._tcp.${fullDomain}`;

  try {
    for (const name of [fullDomain, srvDomain]) {
      const listRes = await cfRequest('GET', `/zones/${CLOUDFLARE_CONFIG.zoneId}/dns_records?name=${encodeURIComponent(name)}`);
      if (listRes.success && Array.isArray(listRes.result)) {
        for (const rec of listRes.result) {
          await cfRequest('DELETE', `/zones/${CLOUDFLARE_CONFIG.zoneId}/dns_records/${rec.id}`);
        }
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

export const cleanupDns = deleteTunnelDns;

/**
 * Sends a heartbeat ping to renew the 5-minute Dead-Man's Switch lease on Cloudflare DNS
 */
export async function sendDnsHeartbeat(subdomain: string, serverName?: string): Promise<boolean> {
  const cleanSub = (subdomain || '').trim().toLowerCase();
  if (!cleanSub) return false;

  const session = loadSession();
  if (!session?.uid || !session?.daemonId || isDirectCloudflareConfigured()) {
    return false;
  }

  try {
    const res = await fetch(VOID_DNS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action: 'heartbeat',
        uid: session.uid,
        daemonId: session.daemonId,
        subdomain: cleanSub,
        serverName,
      }),
    });
    const data = (await res.json()) as any;
    return Boolean(data?.success);
  } catch {
    return false;
  }
}

export function isValidSubdomain(sub: string): boolean {
  if (!sub || sub.length < 3 || sub.length > 48) return false;
  if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(sub)) return false;
  return !containsDisallowedWords(sub);
}
