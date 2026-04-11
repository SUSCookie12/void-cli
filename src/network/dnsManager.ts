import { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, VOID_DOMAIN } from '../config/dns.js';

const CF_API = 'https://api.cloudflare.com/client/v4';

interface CloudflareResponse {
  success: boolean;
  errors: { message: string }[];
  result?: any;
}

async function cfRequest(method: string, path: string, body?: object): Promise<CloudflareResponse> {
  const res = await fetch(`${CF_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<CloudflareResponse>;
}

/**
 * Finds existing DNS records for a given server subdomain.
 * Returns a list of record IDs so we can delete them.
 */
async function findRecords(subdomain: string): Promise<string[]> {
  const fullDomain = `${subdomain}.${VOID_DOMAIN}`;
  const res = await cfRequest('GET', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${fullDomain}`);
  if (!res.success || !res.result) return [];
  return res.result.map((r: any) => r.id);
}

/**
 * Creates or updates DNS records for a server tunnel.
 * subdomain: the user-chosen ID (e.g. "survival")
 * playitHost: the playit.gg hostname (e.g. "auto.playit.gg" or "abc.joinmc.link")
 * port: the port assigned by playit.gg
 */
export async function registerTunnelDns(subdomain: string, playitHost: string, port: number): Promise<string> {
  const fullDomain = `${subdomain}.${VOID_DOMAIN}`;
  console.log(`[DNS] Registering ${fullDomain} → ${playitHost}:${port}`);

  // Delete any existing records first (clean slate on re-register)
  await deleteTunnelDns(subdomain);

  // 1. CNAME record: survival.void.cspack.online → playit host
  const cnameRes = await cfRequest('POST', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records`, {
    type: 'CNAME',
    name: fullDomain,
    content: playitHost,
    ttl: 1, // Auto TTL
    proxied: false, // Must be false for game servers (non-HTTP traffic)
  });

  if (!cnameRes.success) {
    throw new Error(`CNAME creation failed: ${cnameRes.errors.map(e => e.message).join(', ')}`);
  }

  // 2. SRV record: so players don't need to type the port
  // Format: _minecraft._tcp.survival.void.cspack.online
  const srvRes = await cfRequest('POST', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records`, {
    type: 'SRV',
    name: `_minecraft._tcp.${fullDomain}`,
    data: {
      service: '_minecraft',
      proto: '_tcp',
      name: fullDomain,
      priority: 0,
      weight: 5,
      port: port,
      target: playitHost,
    },
    ttl: 1,
  });

  if (!srvRes.success) {
    console.warn(`[DNS] SRV creation warning: ${srvRes.errors.map(e => e.message).join(', ')}`);
    // Non-fatal: CNAME works, players just need to include port
  }

  console.log(`[DNS] ✓ ${fullDomain} registered (via Tunnel)`);
  return fullDomain;
}

/**
 * Creates or updates DNS records for a DIRECT connection (no tunnel).
 */
export async function registerDirectDns(subdomain: string, ip: string, port: number): Promise<string> {
  const fullDomain = `${subdomain}.${VOID_DOMAIN}`;
  console.log(`[DNS] Registering ${fullDomain} → ${ip}:${port} (Direct)`);

  await deleteTunnelDns(subdomain);

  // 1. A record: survival.void.cspack.online → Public IP
  const aRes = await cfRequest('POST', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records`, {
    type: 'A',
    name: fullDomain,
    content: ip,
    ttl: 1,
    proxied: false,
  });

  if (!aRes.success) {
    throw new Error(`A record creation failed: ${aRes.errors.map(e => e.message).join(', ')}`);
  }

  // 2. SRV record
  const srvRes = await cfRequest('POST', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records`, {
    type: 'SRV',
    name: `_minecraft._tcp.${fullDomain}`,
    data: {
      service: '_minecraft',
      proto: '_tcp',
      name: fullDomain,
      priority: 0,
      weight: 5,
      port: port,
      target: fullDomain,
    },
    ttl: 1,
  });

  if (!srvRes.success) {
    console.warn(`[DNS] SRV creation warning: ${srvRes.errors.map(e => e.message).join(', ')}`);
  }

  console.log(`[DNS] ✓ ${fullDomain} registered (Direct IP: ${ip})`);
  return fullDomain;
}

/**
 * Removes all DNS records for a server subdomain.
 * Called when a server is deleted.
 */
export async function deleteTunnelDns(subdomain: string): Promise<void> {
  const records = await findRecords(subdomain);

  // Also check for SRV records
  const srvFullDomain = `_minecraft._tcp.${subdomain}.${VOID_DOMAIN}`;
  const srvRes = await cfRequest('GET', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${srvFullDomain}`);
  if (srvRes.success && srvRes.result) {
    records.push(...srvRes.result.map((r: any) => r.id));
  }

  for (const id of records) {
    await cfRequest('DELETE', `/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${id}`);
    console.log(`[DNS] Deleted record ${id}`);
  }

  if (records.length > 0) {
    console.log(`[DNS] ✓ Cleaned up ${records.length} record(s) for ${subdomain}.${VOID_DOMAIN}`);
  }
}

/**
 * Validates that a subdomain is safe to use (alphanumeric + hyphens only)
 */
export function isValidSubdomain(sub: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(sub);
}
