import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {
  registerTunnelDns,
  registerDirectDns,
  deleteTunnelDns,
  sendDnsHeartbeat,
  isValidSubdomain,
} from './dnsManager.js';
import { tryPortForward, removePortForward, getPublicIp } from './portForwarding.js';
import { VOID_DOMAIN } from '../config/dns.js';
import { generateRandomSubdomain } from '../utils/wordGenerator.js';
import { getServerMeta, saveServerMeta, listServers } from '../server/manager.js';
import { sendCommand, appendServerLog } from '../server/instance.js';

const VOID_DIR = path.join(os.homedir(), '.void');
const isWin = os.platform() === 'win32';

export interface TunnelEvent {
  type: 'tunnel_status' | 'tunnel_active' | 'tunnel_error' | 'tunnel_log';
  payload: any;
}

export interface TunnelState {
  process?: ChildProcess;
  address?: string;
  rawTunnelAddress?: string;
  subdomain: string;
  port: number;
  serverName: string;
  strategy: 'upnp' | 'pinggy';
  status: 'starting' | 'active' | 'error';
  region?: string;
  heartbeatTimer?: NodeJS.Timeout;
  warningTimers?: NodeJS.Timeout[];
  rotationTimer?: NodeJS.Timeout;
}

const activeExposures = new Map<string, TunnelState>();

interface EdgeRegion {
  code: string;
  name: string;
  flag: string;
  host: string;
}

const REGIONAL_EDGES: EdgeRegion[] = [
  { code: 'eu', name: 'Europe (Frankfurt)', flag: '🇪🇺', host: 'eu.a.pinggy.io' },
  { code: 'us', name: 'North America (Fremont/NJ)', flag: '🇺🇸', host: 'us.a.pinggy.io' },
  { code: 'ap', name: 'Asia-Pacific (Singapore/Tokyo)', flag: '🇸🇬', host: 'ap.a.pinggy.io' },
  { code: 'br', name: 'South America (São Paulo)', flag: '🇧🇷', host: 'br.a.pinggy.io' },
  { code: 'au', name: 'Oceania (Sydney)', flag: '🇦🇺', host: 'au.a.pinggy.io' },
];

const ROTATION_INTERVAL_MS = 55 * 60 * 1000; // 55 minutes
const WARNING_5M_MS = 50 * 60 * 1000;        // 50 minutes (5m warning)
const WARNING_2M_MS = 53 * 60 * 1000;        // 53 minutes (2m warning)
const WARNING_1M_MS = 54 * 60 * 1000;        // 54 minutes (1m warning)

/** Strip ANSI escape sequences from CLI stdout/stderr so regex matching is reliable. */
function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

/**
 * Removes legacy binaries from ~/.void so system stays completely clean.
 */
function purgeLegacyBinaries(): void {
  const candidates = [
    path.join(VOID_DIR, 'bore'),
    path.join(VOID_DIR, 'bin', 'bore'),
    path.join(VOID_DIR, 'playit'),
    path.join(VOID_DIR, 'bin', 'playit'),
  ];
  for (const target of candidates) {
    try {
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch {
      // Ignore locked or already removed files
    }
  }
}

/**
 * Measures TCP 443 connect time in milliseconds to a given host.
 */
function pingEdge(host: string, port = 443, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const done = (time: number) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(time);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(Date.now() - start));
    socket.once('timeout', () => done(9999));
    socket.once('error', () => done(9999));
    socket.connect(port, host);
  });
}

/**
 * Probes all global edge servers concurrently and selects the lowest-latency edge.
 */
async function findFastestGlobalRegion(emitLog: (msg: string) => void): Promise<EdgeRegion> {
  emitLog('[Region Radar] Measuring latency to global edge servers (EU, US, Asia, SA, AU)...');
  const results = await Promise.all(
    REGIONAL_EDGES.map(async (reg) => {
      const rtt = await pingEdge(reg.host, 443, 1800);
      return { reg, rtt };
    })
  );

  const report = results
    .map(({ reg, rtt }) => `${reg.flag} ${reg.code.toUpperCase()}: ${rtt < 9000 ? `${rtt}ms` : 'timeout'}`)
    .join(' | ');
  emitLog(`[Region Radar] ${report}`);

  results.sort((a, b) => a.rtt - b.rtt);
  const best = results[0]?.reg || REGIONAL_EDGES[0];
  const bestRtt = results[0]?.rtt < 9000 ? `${results[0].rtt}ms` : 'fallback';
  emitLog(`[Region Radar] Selected closest edge: ${best.flag} ${best.name} (${bestRtt})`);
  return best;
}

/**
 * Sends an in-game announcement into Minecraft chat via server console stdin.
 */
function broadcastInGameNotice(serverName: string, message: string): void {
  try {
    sendCommand(serverName, `say ${message}`);
  } catch {}
}

/**
 * Spawns an anonymous Pinggy SSH reverse tunnel to the selected edge region.
 */
function spawnPinggyTunnel(
  serverPort: number,
  regionHost: string,
  emitLog: (msg: string) => void
): {
  process: ChildProcess;
  endpointPromise: Promise<{ host: string; port: number; rawAddress: string }>;
} {
  const nullDevice = isWin ? 'NUL' : '/dev/null';
  const sshArgs = [
    '-p',
    '443',
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    `UserKnownHostsFile=${nullDevice}`,
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ExitOnForwardFailure=yes',
    '-T',
    `-R0:127.0.0.1:${serverPort}`,
    `tcp@${regionHost}`,
  ];

  emitLog(`[Pinggy] Initiating outbound reverse tunnel to ${regionHost}:443...`);

  const proc = spawn('ssh', sshArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const endpointPromise = new Promise<{ host: string; port: number; rawAddress: string }>(
    (resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Timed out waiting for tunnel endpoint from ${regionHost}`));
        }
      }, 25000);

      const handleOutput = (data: Buffer) => {
        const text = stripAnsi(data.toString());
        const lines = text.split(/\r?\n/);

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          emitLog(`[Pinggy Edge] ${line}`);

          const match = line.match(/tcp:\/\/([a-zA-Z0-9.-]+):(\d+)/i);
          if (match && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            const host = match[1];
            const port = parseInt(match[2], 10);
            resolve({ host, port, rawAddress: `${host}:${port}` });
          }
        }
      };

      proc.stdout?.on('data', handleOutput);
      proc.stderr?.on('data', handleOutput);

      proc.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`SSH tunnel spawn error: ${err.message}`));
        }
      });

      proc.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(`SSH tunnel exited early with code ${code ?? 'unknown'}`));
        }
      });
    }
  );

  return { process: proc, endpointPromise };
}

/**
 * Sets up 5m, 2m, and 1m in-game broadcast warnings and schedules seamless 55m rotation.
 */
function scheduleRotationAndWarnings(
  serverName: string,
  serverPort: number,
  subdomain: string,
  regionHost: string,
  emitLog: (msg: string) => void,
  onEvent: (event: { type: string; payload: any }) => void
): void {
  const state = activeExposures.get(serverName);
  if (!state) return;

  // Clear any existing timers
  if (state.warningTimers) {
    for (const t of state.warningTimers) clearTimeout(t);
  }
  if (state.rotationTimer) clearTimeout(state.rotationTimer);

  const timers: NodeJS.Timeout[] = [];

  // T - 5 minutes warning
  timers.push(
    setTimeout(() => {
      if (activeExposures.get(serverName)?.status === 'active') {
        emitLog('[In-Game Warning] Broadcasting 5-minute refresh notice to Minecraft players...');
        broadcastInGameNotice(
          serverName,
          '[Void Bridge] Notice: Connection bridge will refresh in 5 minutes to maintain low latency. You may briefly disconnect, then reconnect to the same IP!'
        );
      }
    }, WARNING_5M_MS)
  );

  // T - 2 minutes warning
  timers.push(
    setTimeout(() => {
      if (activeExposures.get(serverName)?.status === 'active') {
        emitLog('[In-Game Warning] Broadcasting 2-minute refresh notice to Minecraft players...');
        broadcastInGameNotice(
          serverName,
          '[Void Bridge] Warning: Connection bridge refreshing in 2 minutes! Find a safe spot.'
        );
      }
    }, WARNING_2M_MS)
  );

  // T - 1 minute warning
  timers.push(
    setTimeout(() => {
      if (activeExposures.get(serverName)?.status === 'active') {
        emitLog('[In-Game Warning] Broadcasting 1-minute refresh notice to Minecraft players...');
        broadcastInGameNotice(
          serverName,
          '[Void Bridge] Final warning: Connection bridge refreshing in 1 minute. Reconnect to this same server address right after!'
        );
      }
    }, WARNING_1M_MS)
  );

  state.warningTimers = timers;

  // T = 55 minutes: Seamless rotation
  state.rotationTimer = setTimeout(async () => {
    const currentState = activeExposures.get(serverName);
    if (!currentState || currentState.status !== 'active') return;

    emitLog('[Pinggy Rotation] 55 minutes elapsed. Seamlessly rotating tunnel to a fresh session...');
    try {
      const oldProc = currentState.process;
      const { process: newProc, endpointPromise } = spawnPinggyTunnel(serverPort, regionHost, emitLog);
      const newEndpoint = await endpointPromise;

      emitLog(`[Pinggy Rotation] New tunnel active (${newEndpoint.rawAddress}). Updating Cloudflare SRV...`);
      const dnsRes = await registerTunnelDns(
        subdomain,
        newEndpoint.host,
        newEndpoint.port,
        serverName
      );

      currentState.process = newProc;
      currentState.rawTunnelAddress = newEndpoint.rawAddress;
      currentState.address = dnsRes.domain;

      // Cleanly terminate old tunnel process now that the new one is routing
      try {
        oldProc?.kill();
      } catch {}

      emitLog(`[Pinggy Rotation] Successfully rotated! ${dnsRes.domain} is now routed to ${newEndpoint.rawAddress}.`);

      onEvent({
        type: 'tunnel_active',
        payload: {
          address: dnsRes.domain,
          rawAddress: newEndpoint.rawAddress,
          subdomain,
          strategy: 'pinggy',
          mode: 'pinggy',
        },
      });

      // Schedule next rotation cycle
      scheduleRotationAndWarnings(serverName, serverPort, subdomain, regionHost, emitLog, onEvent);
    } catch (rotErr: any) {
      emitLog(`[Pinggy Rotation Warning] Rotation attempt failed: ${rotErr.message}. Will retry in 2 minutes.`);
      setTimeout(() => {
        scheduleRotationAndWarnings(serverName, serverPort, subdomain, regionHost, emitLog, onEvent);
      }, 2 * 60 * 1000);
    }
  }, ROTATION_INTERVAL_MS);
}

export async function startExpose(
  serverName: string,
  serverPort: number,
  subdomain: string,
  onEvent: (event: { type: string; payload: any }) => void
): Promise<void> {
  purgeLegacyBinaries();

  const emitLog = (message: string) => {
    appendServerLog(serverName, '[Void Bridge] ' + message, 'system');
    onEvent({
      type: 'tunnel_log',
      payload: { message, timestamp: new Date().toLocaleTimeString() },
    });
  };

  if (activeExposures.has(serverName)) {
    await stopExpose(serverName);
  }

  let finalSubdomain = (subdomain || '').trim().toLowerCase();
  if (!isValidSubdomain(finalSubdomain)) {
    const existing = new Set(
      listServers()
        .map((s) => s.subdomain?.toLowerCase())
        .filter((s): s is string => Boolean(s))
    );
    finalSubdomain = generateRandomSubdomain(existing);
  }

  const meta = getServerMeta(serverName);
  if (meta && (meta.subdomain !== finalSubdomain || meta.autoExpose === undefined)) {
    meta.subdomain = finalSubdomain;
    meta.autoExpose = true;
    saveServerMeta(meta);
  }

  const targetDomain = `${finalSubdomain}.${VOID_DOMAIN}`;

  emitLog(`Starting bridge setup for ${serverName} (local port ${serverPort}) -> ${targetDomain}`);
  onEvent({
    type: 'tunnel_status',
    payload: {
      status: 'starting',
      subdomain: finalSubdomain,
      domain: targetDomain,
      message: `Binding ${targetDomain} (checking router UPnP)...`,
    },
  });

  // 1. Try UPnP (Direct 0ms Connection)
  try {
    const upnp = await tryPortForward(serverPort, serverPort);
    if (upnp) {
      const ip = await getPublicIp();
      if (ip) {
        emitLog(`[UPnP] Direct port forward succeeded (${ip}:${serverPort}). Registering Cloudflare DNS...`);
        const dnsRes = await registerDirectDns(finalSubdomain, ip, serverPort, serverName);
        if (dnsRes.subdomain && dnsRes.subdomain !== finalSubdomain) {
          finalSubdomain = dnsRes.subdomain;
          const m = getServerMeta(serverName);
          if (m) {
            m.subdomain = finalSubdomain;
            saveServerMeta(m);
          }
        }

        const state: TunnelState = {
          strategy: 'upnp',
          status: 'active',
          subdomain: finalSubdomain,
          port: serverPort,
          serverName,
          address: dnsRes.domain,
          rawTunnelAddress: `${ip}:${serverPort}`,
        };

        // Start Dead-Man's Switch heartbeat
        state.heartbeatTimer = setInterval(() => {
          void sendDnsHeartbeat(finalSubdomain, serverName);
        }, 60 * 1000);

        activeExposures.set(serverName, state);
        emitLog(`[UPnP] Bridge active: ${dnsRes.domain} -> ${ip}:${serverPort} (Dead-Man's Switch heartbeat enabled)`);
        onEvent({
          type: 'tunnel_active',
          payload: {
            address: dnsRes.domain,
            rawAddress: `${ip}:${serverPort}`,
            subdomain: finalSubdomain,
            strategy: 'upnp',
            mode: 'upnp',
          },
        });
        return;
      }
    }
  } catch (e: any) {
    emitLog(`[UPnP] Direct router port forwarding unavailable (${e?.message || 'CGNAT/Firewall'}), switching to global reverse tunnel...`);
  }

  // 2. Primary Strategy: Zero-Login Global Reverse Tunnel (Pinggy Multi-Region)
  onEvent({
    type: 'tunnel_status',
    payload: {
      status: 'starting',
      subdomain: finalSubdomain,
      domain: targetDomain,
      message: 'Probing nearest global edge server...',
    },
  });

  try {
    const bestRegion = await findFastestGlobalRegion(emitLog);

    onEvent({
      type: 'tunnel_status',
      payload: {
        status: 'starting',
        subdomain: finalSubdomain,
        domain: targetDomain,
        message: `Connecting to ${bestRegion.name}...`,
      },
    });

    const { process: proc, endpointPromise } = spawnPinggyTunnel(serverPort, bestRegion.host, emitLog);

    const state: TunnelState = {
      process: proc,
      subdomain: finalSubdomain,
      port: serverPort,
      serverName,
      address: targetDomain,
      strategy: 'pinggy',
      status: 'starting',
      region: bestRegion.code,
    };
    activeExposures.set(serverName, state);

    const endpoint = await endpointPromise;
    state.rawTunnelAddress = endpoint.rawAddress;
    state.status = 'active';

    emitLog(
      `[Cloudflare DNS] Binding SRV _minecraft._tcp.${state.subdomain}.${VOID_DOMAIN} -> ${endpoint.host}:${endpoint.port}...`
    );
    onEvent({
      type: 'tunnel_status',
      payload: {
        status: 'connecting_dns',
        subdomain: state.subdomain,
        message: `Tunnel active (${state.rawTunnelAddress})! Binding ${state.subdomain}.${VOID_DOMAIN}...`,
      },
    });

    try {
      const dnsRes = await registerTunnelDns(
        state.subdomain,
        endpoint.host,
        endpoint.port,
        serverName
      );
      if (dnsRes.subdomain && dnsRes.subdomain !== state.subdomain) {
        state.subdomain = dnsRes.subdomain;
        const m = getServerMeta(serverName);
        if (m) {
          m.subdomain = dnsRes.subdomain;
          saveServerMeta(m);
        }
      }
      state.address = dnsRes.domain;
      emitLog(
        `[Bridge Ready] ${dnsRes.domain} is live and routed to ${state.rawTunnelAddress} (${bestRegion.flag} ${bestRegion.name})!`
      );
    } catch (dnsErr: any) {
      state.address = `${state.subdomain}.${VOID_DOMAIN}`;
      emitLog(`[Cloudflare DNS Warning] ${dnsErr.message} — fallback raw address: ${state.rawTunnelAddress}`);
    }

    // Start 60-second Dead-Man's Switch heartbeat
    state.heartbeatTimer = setInterval(() => {
      void sendDnsHeartbeat(state.subdomain, serverName);
    }, 60 * 1000);

    // Schedule 5m, 2m, 1m in-game warnings and 55m rotation
    scheduleRotationAndWarnings(serverName, serverPort, state.subdomain, bestRegion.host, emitLog, onEvent);

    onEvent({
      type: 'tunnel_active',
      payload: {
        address: state.address,
        rawAddress: state.rawTunnelAddress,
        subdomain: state.subdomain,
        strategy: 'pinggy',
        mode: 'pinggy',
        region: bestRegion.code,
      },
    });

    // Handle unexpected process exit while active
    proc.on('exit', (code) => {
      const current = activeExposures.get(serverName);
      if (current && current.process === proc && current.status === 'active') {
        emitLog(`[Pinggy Notice] Tunnel connection dropped (code ${code ?? 'unknown'}). Auto-reconnecting in 3s...`);
        setTimeout(() => {
          if (activeExposures.has(serverName)) {
            void startExpose(serverName, serverPort, subdomain, onEvent);
          }
        }, 3000);
      }
    });
  } catch (err: any) {
    activeExposures.delete(serverName);
    emitLog(`[Tunnel Error] ${err.message}`);
    onEvent({
      type: 'tunnel_error',
      payload: { message: `Tunnel failed to start: ${err.message}` },
    });
  }
}

export async function stopExpose(serverName: string, passedSubdomain?: string): Promise<void> {
  const state = activeExposures.get(serverName);
  const targetSubdomain = state?.subdomain || passedSubdomain;

  if (state) {
    console.log(`[Tunnel] Stopping exposure for ${serverName} (Strategy: ${state.strategy})...`);

    // Cancel all timers
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
    if (state.warningTimers) {
      for (const t of state.warningTimers) clearTimeout(t);
    }
    if (state.rotationTimer) clearTimeout(state.rotationTimer);

    try {
      state.process?.kill();
    } catch {}

    if (state.strategy === 'upnp') {
      try {
        await removePortForward(state.port);
      } catch (err) {
        console.warn(`[Tunnel] Non-fatal: UPnP cleanup failed for ${serverName}:`, err);
      }
    }
    activeExposures.delete(serverName);
  }

  if (targetSubdomain) {
    console.log(`[Tunnel] Cleaning up DNS for subdomain: ${targetSubdomain}`);
    await deleteTunnelDns(targetSubdomain);
  }
}

export async function stopAllExposures(): Promise<void> {
  const names = Array.from(activeExposures.keys());
  for (const name of names) {
    await stopExpose(name);
  }
}

export function getTunnelState(serverName: string) {
  const state = activeExposures.get(serverName);
  if (!state) return undefined;
  return {
    address: state.address,
    rawAddress: state.rawTunnelAddress,
    status: state.status || 'active',
    strategy: state.strategy,
    subdomain: state.subdomain,
    region: state.region,
  };
}

export const getExposeState = getTunnelState;
