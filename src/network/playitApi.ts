import https from 'node:https';
import os from 'node:os';

const PLAYIT_API_BASE = 'https://api.playit.gg';

export interface PlayitTunnelAllocation {
  id: string;
  ip_hostname: string;
  assigned_domain: string;
  assigned_srv?: string | null;
  tunnel_ip: string;
  port_start: number;
  port_end: number;
  region: string;
}

export interface PlayitTunnel {
  id: string;
  name?: string | null;
  tunnel_type?: string | null;
  port_type: 'tcp' | 'udp' | 'both';
  port_count: number;
  created_at: string;
  active: boolean;
  alloc: {
    status: 'pending' | 'disabled' | 'allocated';
    data?: PlayitTunnelAllocation & { reason?: string };
  };
  origin?: {
    type: string;
    data?: {
      agent_id?: string;
      agent_name?: string;
      local_ip?: string;
      local_port?: number | null;
    };
  };
}

export interface PlayitRunData {
  agent_id: string;
  permissions?: {
    is_self_managed: boolean;
    has_premium: boolean;
    account_status: string;
  };
}

function playitRequest<T = any>(
  endpoint: string,
  payload: Record<string, any> = {},
  secretKey?: string
): Promise<{ status: string; data: T }> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
      'User-Agent': 'VoidServers-Daemon/1.0',
    };
    if (secretKey) {
      headers['Authorization'] = `Agent-Key ${secretKey.trim()}`;
    }

    const url = new URL(`${PLAYIT_API_BASE}/${endpoint.replace(/^\/+/, '')}`);
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers,
        timeout: 15000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            resolve(parsed);
          } catch (err) {
            reject(new Error(`Invalid JSON from Playit API (${endpoint}): ${raw.slice(0, 200)}`));
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Playit API request timed out (${endpoint})`));
    });

    req.write(body);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function getAgentRunData(secretKey: string): Promise<PlayitRunData> {
  const res = await playitRequest<PlayitRunData>('agents/rundata', {}, secretKey);
  if (res.status !== 'success' || !res.data?.agent_id) {
    throw new Error(`Playit agents/rundata failed: ${JSON.stringify(res)}`);
  }
  return res.data;
}

export async function registerPlayitProtocol(secretKey: string, version = '0.16.2'): Promise<string | null> {
  const platform = os.platform() === 'win32' ? 'windows' : os.platform() === 'darwin' ? 'macos' : 'linux';
  const res = await playitRequest<{ key: string }>(
    'proto/register',
    {
      agent_version: {
        official: true,
        details_website: null,
        version: {
          platform,
          version,
        },
      },
      client_addr: '0.0.0.0:0',
      tunnel_addr: '0.0.0.0:0',
    },
    secretKey
  );
  if (res.status === 'success' && res.data?.key) {
    return res.data.key;
  }
  return null;
}

export async function listPlayitTunnels(
  secretKey: string,
  agentId: string
): Promise<{ tunnels: PlayitTunnel[]; maxAllowed: number }> {
  const res = await playitRequest<{
    tunnels: PlayitTunnel[];
    tcp_alloc?: { allowed: number; claimed: number; desired: number };
  }>('tunnels/list', { agent_id: agentId }, secretKey);

  if (res.status !== 'success' || !Array.isArray(res.data?.tunnels)) {
    throw new Error(`Playit tunnels/list failed: ${JSON.stringify(res)}`);
  }

  return {
    tunnels: res.data.tunnels,
    maxAllowed: res.data.tcp_alloc?.allowed || 4,
  };
}

export async function updatePlayitTunnelPort(
  secretKey: string,
  tunnelId: string,
  agentId: string,
  localPort: number
): Promise<boolean> {
  const res = await playitRequest(
    'tunnels/update',
    {
      tunnel_id: tunnelId,
      local_ip: '127.0.0.1',
      local_port: localPort,
      agent_id: agentId,
      enabled: true,
    },
    secretKey
  );
  return res.status === 'success';
}

export async function deletePlayitTunnel(secretKey: string, tunnelId: string): Promise<boolean> {
  const res = await playitRequest('tunnels/delete', { tunnel_id: tunnelId }, secretKey);
  return res.status === 'success';
}

export async function createPlayitMinecraftTunnel(
  secretKey: string,
  agentId: string,
  localPort: number,
  serverName: string
): Promise<string> {
  const safeSuffix = serverName.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'mc';
  const res = await playitRequest<{ id: string }>(
    'tunnels/create',
    {
      name: `void-${safeSuffix}-${localPort}`,
      tunnel_type: 'minecraft-java',
      port_type: 'tcp',
      port_count: 1,
      enabled: true,
      origin: {
        type: 'agent',
        data: {
          agent_id: agentId,
          local_ip: '127.0.0.1',
          local_port: localPort,
        },
      },
    },
    secretKey
  );

  if (res.status !== 'success' || !res.data?.id) {
    throw new Error(`Playit tunnels/create failed: ${JSON.stringify(res)}`);
  }
  return res.data.id;
}

export async function waitForClaimExchange(
  claimCode: string,
  onLog?: (msg: string) => void,
  maxWaitSeconds = 120
): Promise<string | null> {
  const code = claimCode.trim();
  // 1. Setup claim code so Playit knows the agent is ready to be claimed
  try {
    await playitRequest('claim/setup', {
      code,
      agent_type: 'self-managed',
      version: '0.16.2',
    });
  } catch (err: any) {
    onLog?.(`[Playit API] Note: claim/setup response: ${err.message}`);
  }

  // 2. Poll claim/exchange until user clicks the 1-time claim button in browser
  for (let i = 0; i < maxWaitSeconds; i++) {
    try {
      const ex = await playitRequest<{ secret_key?: string }>('claim/exchange', { code });
      if (ex.status === 'success' && ex.data?.secret_key) {
        return ex.data.secret_key;
      }
      const errReason = String(ex.data || '');
      if (errReason === 'CodeExpired' || errReason === 'UserRejected') {
        throw new Error(`Playit claim ${errReason}`);
      }
    } catch (err: any) {
      if (err.message?.includes('CodeExpired') || err.message?.includes('UserRejected')) {
        throw err;
      }
    }
    await sleep(1000);
  }
  return null;
}

/**
 * Ensures a Playit TCP tunnel is allocated and routed to `127.0.0.1:<localPort>`.
 * - Reuses an existing tunnel if one already points to `localPort`.
 * - Remaps an idle tunnel slot (`POST /tunnels/update`) if all 4 slots exist and one belongs to an offline server.
 * - Creates a new `minecraft-java` tunnel (`POST /tunnels/create`) if free slots (< 4) remain.
 */
export async function ensureServerTunnelAllocation(
  secretKey: string,
  localPort: number,
  serverName: string,
  activePortsInUse: Set<number>,
  onLog?: (msg: string) => void
): Promise<{
  tunnelId: string;
  agentId: string;
  assignedDomain: string;
  publicPort: number;
}> {
  onLog?.('[Playit API] Authenticating agent secret key and fetching agent run data...');
  const runData = await getAgentRunData(secretKey);
  const agentId = runData.agent_id;
  onLog?.(`[Playit API] Agent authenticated (ID: ${agentId.slice(0, 8)}..., status: ${runData.permissions?.account_status || 'active'}).`);

  await registerPlayitProtocol(secretKey, '0.16.2').catch(() => null);

  const { tunnels, maxAllowed } = await listPlayitTunnels(secretKey, agentId);
  const tcpTunnels = tunnels.filter((t) => t.port_type === 'tcp' || t.port_type === 'both');
  onLog?.(`[Playit API] Found ${tcpTunnels.length}/${maxAllowed} existing TCP tunnel slot(s) on this agent.`);

  // 1. Check if a tunnel already targets this exact localPort
  const exactMatch = tcpTunnels.find(
    (t) => Number(t.origin?.data?.local_port) === localPort
  );

  let targetTunnelId: string | null = null;

  if (exactMatch) {
    targetTunnelId = exactMatch.id;
    onLog?.(`[Playit API] Reusing existing tunnel slot ${exactMatch.id.slice(0, 8)} already mapped to 127.0.0.1:${localPort}.`);
  } else {
    // 2. Check if there is an idle tunnel slot (not used by any currently running server) that we can remap in-place
    const idleTunnels = tcpTunnels
      .filter((t) => {
        const p = Number(t.origin?.data?.local_port);
        return !p || !activePortsInUse.has(p);
      })
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    const totalCost = tcpTunnels.reduce((acc, t) => acc + (t.port_count || 1), 0);

    if (totalCost < maxAllowed) {
      // We have free quota to create a dedicated tunnel for this port
      onLog?.(`[Playit API] Creating new minecraft-java TCP tunnel for 127.0.0.1:${localPort}...`);
      targetTunnelId = await createPlayitMinecraftTunnel(secretKey, agentId, localPort, serverName);
      onLog?.(`[Playit API] Created tunnel ${targetTunnelId.slice(0, 8)}. Waiting for public address allocation...`);
    } else if (idleTunnels.length > 0) {
      // All 4 slots are created, so reuse the oldest offline server's tunnel slot via tunnels/update!
      const candidate = idleTunnels[0];
      const oldPort = candidate.origin?.data?.local_port;
      onLog?.(
        `[Playit API] All ${maxAllowed} tunnel slots exist — remapping offline slot ${candidate.id.slice(0, 8)} (port ${oldPort ?? 'none'} -> ${localPort})...`
      );
      const updated = await updatePlayitTunnelPort(secretKey, candidate.id, agentId, localPort);
      if (updated) {
        targetTunnelId = candidate.id;
        onLog?.(`[Playit API] Successfully remapped tunnel slot ${candidate.id.slice(0, 8)} to 127.0.0.1:${localPort}.`);
      } else {
        // Fallback: delete oldest idle tunnel and create fresh one
        onLog?.(`[Playit API] In-place update unsupported for slot ${candidate.id.slice(0, 8)}, recycling slot...`);
        await deletePlayitTunnel(secretKey, candidate.id);
        targetTunnelId = await createPlayitMinecraftTunnel(secretKey, agentId, localPort, serverName);
      }
    } else {
      throw new Error(
        `QUOTA_EXCEEDED: All ${maxAllowed} Playit tunnel slots on this agent are actively in use by running servers.`
      );
    }
  }

  // 3. Poll until tunnel allocation is ready (`alloc.status === 'allocated'`)
  for (let attempt = 0; attempt < 25; attempt++) {
    const currentList = await listPlayitTunnels(secretKey, agentId);
    const found = currentList.tunnels.find((t) => t.id === targetTunnelId);
    if (
      found &&
      found.alloc?.status === 'allocated' &&
      found.alloc.data?.assigned_domain &&
      found.alloc.data?.port_start
    ) {
      const assignedDomain = found.alloc.data.assigned_domain;
      const publicPort = Number(found.alloc.data.port_start);
      onLog?.(`[Playit API] Tunnel allocated: ${assignedDomain}:${publicPort} -> 127.0.0.1:${localPort}`);
      return {
        tunnelId: found.id,
        agentId,
        assignedDomain,
        publicPort,
      };
    }
    await sleep(1000);
  }

  throw new Error('Timed out waiting for Playit.gg to allocate a public address for the tunnel.');
}
