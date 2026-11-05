import { RTCPeerConnection, RTCSessionDescription } from 'werift';
import { collection, query, where, onSnapshot, doc } from 'firebase/firestore';
import { getDb } from '../config/firebase.js';
import {
  subscribeToLogs,
  sendCommand,
  startServer,
  stopServer,
  restartServer,
  killServer,
  isRunning,
  getServerStatus,
  getServerStats,
  getServerLogs,
  getOnlinePlayers,
  subscribeToAllStatus,
  isEulaAccepted,
  subscribeToCrash,
  getServerLogsText,
  getLatestCrash
} from '../server/instance.js';
import { listServers, deleteServer, renameServer, getNextAvailablePort, getServerMeta, saveServerMeta } from '../server/manager.js';
import { installServer, importServerFromSource, inspectServerDirectory } from '../server/installer.js';
import { listServerJarsInDir, resolveServerJarName } from '../server/instance.js';
import { readProperties, writeProperties } from '../server/properties.js';
import { uploadToMclogs } from '../server/crashAnalyzer.js';
import { 
  getWorldDimensions, 
  getDimensionRegions, 
  resetDimension, 
  deleteRegionFiles 
} from '../server/worldManager.js';
import { detectJava, getLocalJavaPath } from '../utils/java.js';
import { getPlayerLists } from '../server/players.js';
import { getPlayerDetail } from '../utils/playerDetail.js';
import { 
  listEntries, 
  readTextFile, 
  writeTextFile, 
  deleteEntry, 
  createEntry, 
  renameEntry 
} from '../utils/fileExplorer.js';
import { listPlugins, togglePlugin } from '../utils/plugins.js';
import { listMods, toggleMod } from '../utils/mods.js';
import { compressFolder, extractArchive } from '../utils/zipper.js';
import { 
  getTrashSummary, 
  restoreTrashItem, 
  deleteTrashItemPermanent, 
  emptyTrash, 
  setTrashRetentionDays,
  pruneExpiredTrash 
} from '../utils/trash.js';
import { getServerDir } from '../utils/paths.js';
import { getRunningServers } from '../server/instance.js';
import { DAEMON_VERSION } from '../version.js';
import { startExpose, stopExpose, getTunnelState } from './tunnelManager.js';
import { isValidSubdomain } from './dnsManager.js';
import { getArclightVersions } from '../api/arclight.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { clearSession } from '../auth/session.js';
import { notifySessionRevoked } from '../auth/sessionEvents.js';
import { getHostCpuPercent, getHostMemoryStats } from '../utils/hostStats.js';
import { logDaemonActivity } from '../utils/activityLogger.js';

const PROJECT = 'cookiemovie-27669';
const DB = '(default)';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DB}`;
const API_KEY = 'AIzaSyAxkQA5tBqp_5fco6Y_8i2mhI15ECJeNh0';

function docName(path: string): string {
  return `projects/${PROJECT}/databases/${DB}/documents/${path}`;
}

async function restCommit(writes: any[]): Promise<void> {
  try {
    await fetch(`${FIRESTORE_BASE}/documents:commit?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes }),
    });
  } catch {}
}

async function restDelete(name: string): Promise<void> {
  try {
    await fetch(`${FIRESTORE_BASE}/documents/${encodeURIComponent(name)}?key=${API_KEY}`, {
      method: 'DELETE',
    });
  } catch {}
}

let isInitialized = false;
let currentOwnerUid = '';
let currentDaemonId = '';

export const openChannels = new Set<any>();
const channelUserMap = new WeakMap<any, string>();

export interface ServerAccessGrant {
  id: string;
  ownerUid: string;
  ownerUsername?: string;
  recipientUid: string;
  recipientUsername?: string;
  serverName: string;
  ownerNodeId?: string;
  permissions: Record<string, boolean>;
}

let cachedGrants: ServerAccessGrant[] = [];

function parseFirestoreFields(fields: Record<string, any> | undefined): Record<string, any> {
  if (!fields) return {};
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v.stringValue !== undefined) result[k] = v.stringValue;
    else if (v.booleanValue !== undefined) result[k] = Boolean(v.booleanValue);
    else if (v.integerValue !== undefined) result[k] = Number(v.integerValue);
    else if (v.doubleValue !== undefined) result[k] = Number(v.doubleValue);
    else if (v.mapValue?.fields) result[k] = parseFirestoreFields(v.mapValue.fields);
    else if (v.timestampValue !== undefined) result[k] = v.timestampValue;
  }
  return result;
}

export async function refreshServerAccessGrants(): Promise<void> {
  if (!currentOwnerUid) return;
  try {
    const res = await fetch(`${FIRESTORE_BASE}/documents:runQuery?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'server_access' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'ownerUid' },
              op: 'EQUAL',
              value: { stringValue: currentOwnerUid },
            },
          },
        },
      }),
    });
    if (!res.ok) return;
    const rows = (await res.json()) as any[];
    const grants: ServerAccessGrant[] = [];
    for (const row of rows) {
      if (!row?.document) continue;
      const docNameStr = String(row.document.name || '');
      const id = docNameStr.split('/').pop() || '';
      const data = parseFirestoreFields(row.document.fields);
      if (data.recipientUid && data.serverName) {
        grants.push({
          id,
          ownerUid: String(data.ownerUid || currentOwnerUid),
          ownerUsername: data.ownerUsername ? String(data.ownerUsername) : undefined,
          recipientUid: String(data.recipientUid),
          recipientUsername: data.recipientUsername ? String(data.recipientUsername) : undefined,
          serverName: String(data.serverName),
          ownerNodeId: data.ownerNodeId ? String(data.ownerNodeId) : undefined,
          permissions: typeof data.permissions === 'object' && data.permissions ? data.permissions : {},
        });
      }
    }
    cachedGrants = grants;
  } catch (e) {
    // ignore transient network errors
  }
}

export function getPeerGrant(peerUid: string, serverName: string): ServerAccessGrant | undefined {
  return cachedGrants.find(
    g =>
      g.recipientUid === peerUid &&
      g.serverName === serverName &&
      (!g.ownerNodeId || g.ownerNodeId === currentDaemonId)
  );
}

export function hasServerPerm(peerUid: string, serverName: string, perm: string): boolean {
  if (!peerUid || peerUid === currentOwnerUid) return true;
  const grant = getPeerGrant(peerUid, serverName);
  if (!grant) return false;
  const p = grant.permissions || {};
  if (p[perm] !== undefined) return Boolean(p[perm]);

  if (perm === 'canStop' || perm === 'canRestart' || perm === 'canForceKill') {
    return Boolean(p.canStopRestart);
  }
  if (perm === 'canViewConsole' || perm === 'canSendConsole') {
    return Boolean(p.canConsole);
  }
  if (perm === 'canViewPlayers' || perm === 'canManagePlayers') {
    return Boolean(p.canPlayers);
  }
  if (perm === 'canViewFiles' || perm === 'canEditFiles') {
    return Boolean(p.canFiles);
  }
  return false;
}

export function broadcastLogLine(serverName: string, log: any) {
  const payload = JSON.stringify({ type: 'log', server: serverName, log });
  for (const chan of openChannels) {
    if (chan.readyState === 'open') {
      const peerUid = channelUserMap.get(chan) || currentOwnerUid;
      if (peerUid === currentOwnerUid || hasServerPerm(peerUid, serverName, 'canViewConsole')) {
        try {
          chan.send(payload);
        } catch {
          openChannels.delete(chan);
        }
      }
    } else {
      openChannels.delete(chan);
    }
  }
}

export function broadcastToWebRtc(message: Record<string, unknown>) {
  const payload = JSON.stringify(message);
  for (const chan of openChannels) {
    if (chan.readyState === 'open') {
      try {
        chan.send(payload);
      } catch (e) {
        openChannels.delete(chan);
      }
    } else {
      openChannels.delete(chan);
    }
  }
}

const activeBackupControllers = new Map<string, AbortController>();

export interface ActiveBackupState {
  server: string;
  status: 'idle' | 'zipping' | 'uploading' | 'downloading' | 'extracting';
  progress: number;
  activeType: 'local' | 'cloud' | 'restore_local' | 'restore_cloud' | 'idle';
}

let activeBackupState: ActiveBackupState = {
  server: '',
  status: 'idle',
  progress: 0,
  activeType: 'idle'
};

function updateBackupState(
  server: string,
  status: 'idle' | 'zipping' | 'uploading' | 'downloading' | 'extracting',
  progress: number,
  activeType: 'local' | 'cloud' | 'restore_local' | 'restore_cloud' | 'idle'
) {
  activeBackupState = { server, status, progress, activeType };
  const payload = JSON.stringify({
    type: 'backup_status',
    status,
    progress,
    activeType,
    server
  });
  for (const chan of openChannels) {
    if (chan.readyState === 'open') {
      try {
        chan.send(payload);
      } catch (e) {
        openChannels.delete(chan);
      }
    } else {
      openChannels.delete(chan);
    }
  }
}


function __agentDebugLog(
  runId: string,
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>
) {
  fetch('http://127.0.0.1:7682/ingest/c404c6bb-707c-4b12-a2d4-6585416bd364', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': 'e1600b'
    },
    body: JSON.stringify({
      sessionId: 'e1600b',
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now()
    })
  }).catch(() => {});
}

async function performUpdateCli() {
  console.log('[Update] Stopping all running servers...');
  const running = getRunningServers();
  for (const name of running) {
    killServer(name);
  }
  // Short wait for processes to wind down
  await new Promise(r => setTimeout(r, 3000));

  const plat = os.platform();
  const installCmd =
    plat === 'win32'
      ? 'powershell -Command "iwr \'https://raw.githubusercontent.com/SUSCookie12/void-cli/main/dist_scripts/install.ps1\' -useb | iex"'
      : '/bin/sh -c "curl -fsSL https://raw.githubusercontent.com/SUSCookie12/void-cli/main/dist_scripts/install.sh | bash"';

  console.log(`[Update] Running install command for ${plat}...`);
  try {
    const { execSync } = await import('node:child_process');
    execSync(installCmd, { stdio: 'inherit', timeout: 120_000 });
    console.log('[Update] CLI updated successfully. Exiting...');
  } catch (e: any) {
    console.error('[Update] Install command failed:', e.message);
  }

  process.exit(0);
}

export function initWebRTCSignaling(uid: string, daemonId: string): () => void {
  if (isInitialized) {
    console.log('[WebRTC] Signaling already active, skipping duplicate initialization.');
    return () => {};
  }
  isInitialized = true;
  currentOwnerUid = uid;
  currentDaemonId = daemonId;
  void refreshServerAccessGrants();
  const grantsIntervalId = setInterval(() => {
    void refreshServerAccessGrants();
  }, 20000);
  const db = getDb();

  // Register node presence (via REST API to avoid gRPC IAM issues)
  const nodeDocPath = `users/${uid}/nodes/${daemonId}`;
  const registerNode = async (status: 'online' | 'offline') => {
    try {
      if (status === 'online') {
        await restCommit([{
          update: {
            name: docName(nodeDocPath),
            fields: {
              daemonId: { stringValue: daemonId },
              hostname: { stringValue: os.hostname() },
              status: { stringValue: 'online' },
              lastSeen: { stringValue: new Date().toISOString() },
            },
          },
        }]);
      } else {
        await restCommit([{
          update: {
            name: docName(nodeDocPath),
            fields: { status: { stringValue: 'offline' } },
          },
        }]);
      }
    } catch (e) {
      console.error('[WebRTC] Failed to update node presence:', e);
    }
  };

  registerNode('online');
  const heartbeatId = setInterval(() => registerNode('online'), 30000);

  const nodeRef = doc(db, 'users', uid, 'nodes', daemonId);
  let hadPresenceDoc = false;
  let revokeHandled = false;

  const connectionsRef = collection(db, 'daemon_connections');
  const q = query(
    connectionsRef,
    where('daemonId', '==', daemonId),
    where('status', '==', 'offer')
  );

  let unsubConnections: (() => void) | undefined;
  let unsubNodeDoc: (() => void) | undefined;

  const teardown = () => {
    clearInterval(heartbeatId);
    clearInterval(grantsIntervalId);
    unsubConnections?.();
    unsubConnections = undefined;
    unsubNodeDoc?.();
    unsubNodeDoc = undefined;
    isInitialized = false;
  };

  unsubNodeDoc = onSnapshot(nodeRef, snap => {
    if (revokeHandled) return;
    if (snap.exists()) {
      hadPresenceDoc = true;
      const data = snap.data();
      if (data.pendingCommand === 'update_cli') {
        console.log('[WebRTC] Received update_cli command from Firestore');
        (async () => {
          try {
            await restCommit([{ update: { name: docName(`users/${uid}/nodes/${daemonId}`), fields: { pendingCommand: { stringValue: '' } } } }]);
          } catch {}
          performUpdateCli();
        })();
      }
      return;
    }
    if (!hadPresenceDoc) return;
    revokeHandled = true;
    console.warn('[WebRTC] Node session was revoked from the dashboard. Signing out…');
    teardown();
    clearSession();
    notifySessionRevoked();
  });

  const inFlightOffers = new Set<string>();

  const handleIncomingOffer = async (docId: string, data: any) => {
    if (inFlightOffers.has(docId)) return;
    inFlightOffers.add(docId);

    try {
      // 1. Filter out stale offers (older than 45 seconds) to avoid hanging on abandoned client sessions
      const offerTime = data.createdAt ? new Date(data.createdAt).getTime() : Number(docId.split('_').pop());
      const isStale = offerTime > 0 && !isNaN(offerTime) && (Date.now() - offerTime > 45000);
      if (isStale) {
        console.log(`[WebRTC] Skipping stale offer ${docId} (created ${Math.round((Date.now() - offerTime) / 1000)}s ago)`);
        try {
          await restCommit([{
            update: {
              name: docName(`daemon_connections/${docId}`),
              fields: { status: { stringValue: 'stale' } },
            },
          }]);
        } catch {}
        return;
      }

      let offerData: any;
      if (typeof data.offer === 'string') {
        offerData = JSON.parse(data.offer);
      } else if (typeof data.offer?.toJSON === 'function') {
        offerData = data.offer.toJSON();
      } else {
        offerData = JSON.parse(JSON.stringify(data.offer || {}));
      }

      if (!offerData?.sdp || !offerData?.type) {
        console.error(`[WebRTC] Invalid offer ${docId} - missing sdp/type`);
        try {
          await restCommit([{
            update: {
              name: docName(`daemon_connections/${docId}`),
              fields: { status: { stringValue: 'invalid' } },
            },
          }]);
        } catch {}
        return;
      }

      // #region agent log
      __agentDebugLog(
        'run2',
        'H2',
        'void_server/src/network/webrtc.ts:received-offer',
        'Received matching offer',
        {
          daemonId,
          docId,
          offerType: offerData?.type,
        }
      );
      // #endregion
      console.log(`[WebRTC] Received offer for node ${daemonId} from ${docId}`);
      const peerUserId = String(data.userId || data.clientUid || uid);
      if (peerUserId !== currentOwnerUid) {
        await refreshServerAccessGrants();
      }

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' },
        ],
      });

      pc.onDataChannel.subscribe((channel) => {
        channelUserMap.set(channel, peerUserId);
        // #region agent log
        __agentDebugLog(
          'run2',
          'H3',
          'void_server/src/network/webrtc.ts:onDataChannel',
          'DataChannel opened',
          {
            daemonId,
            label: channel.label,
            readyState: channel.readyState,
          }
        );
        // #endregion
        console.log(`[WebRTC] DataChannel ${channel.label} opened`);

        if (channel.label.startsWith('tunnel::')) {
          const parts = channel.label.split('::');
          const serverName = parts[1];
          const connId = parts[2];

          const targetServer = listServers().find((s) => s.name === serverName);
          if (!targetServer || !isRunning(serverName)) {
            console.log(`[WebRTC Tunnel] Server ${serverName} not running, rejecting tunnel.`);
            channel.close();
            return;
          }

          import('node:net').then((net) => {
            const tcpSocket = new net.Socket();
            tcpSocket.connect(targetServer.port, '127.0.0.1', () => {
              console.log(`[WebRTC Tunnel] Connected TCP proxy for ${serverName}:${targetServer.port} [${connId}]`);
            });

            tcpSocket.on('data', (sockData) => {
              if (channel.readyState === 'open') {
                channel.send(sockData);
              }
            });

            channel.onMessage.subscribe((msgBuf) => {
              if (msgBuf instanceof Buffer) {
                tcpSocket.write(msgBuf);
              }
            });

            const cleanup = () => {
              tcpSocket.destroy();
              if (channel.readyState !== 'closed') channel.close();
            };

            tcpSocket.on('close', cleanup);
            tcpSocket.on('error', (err) => {
              console.error(`[WebRTC Tunnel] TCP Error on ${connId}:`, err);
              cleanup();
            });
          });
          return;
        }

        openChannels.add(channel);

        const activeTransfers = new Map<
          string,
          {
            writeStream?: fs.WriteStream;
            path: string;
            size: number;
            received: number;
          }
        >();

        let statsInterval: NodeJS.Timeout | undefined;
        let unsubStatus: (() => void) | undefined;
        let unsubCrash: (() => void) | undefined;

        const cleanupChannel = () => {
          openChannels.delete(channel);
          if (statsInterval) {
            clearInterval(statsInterval);
            statsInterval = undefined;
          }
          if (unsubStatus) {
            unsubStatus();
            unsubStatus = undefined;
          }
          if (unsubCrash) {
            unsubCrash();
            unsubCrash = undefined;
          }
        };

        channel.stateChanged.subscribe(() => {
          if (channel.readyState !== 'open') {
            cleanupChannel();
          }
        });

        statsInterval = setInterval(async () => {
          if (channel.readyState === 'open') {
            const peerUid = channelUserMap.get(channel) || currentOwnerUid;
            const servers = listServers();
            const statsMap: Record<string, any> = {};
            for (const s of servers) {
              if (peerUid !== currentOwnerUid && !getPeerGrant(peerUid, s.name)) continue;
              if (isRunning(s.name)) {
                const stats = await getServerStats(s.name);
                if (stats) statsMap[s.name] = stats;
              }
            }
            channel.send(JSON.stringify({ type: 'stats_update', stats: statsMap }));
          } else {
            cleanupChannel();
          }
        }, 2000);

        unsubStatus = subscribeToAllStatus(() => {
          if (channel.readyState === 'open') {
            void sendServersList(channel);
          } else {
            cleanupChannel();
          }
        });

        unsubCrash = subscribeToCrash((name, analysis) => {
          if (channel.readyState === 'open') {
            const peerUid = channelUserMap.get(channel) || currentOwnerUid;
            if (peerUid === currentOwnerUid || hasServerPerm(peerUid, name, 'canDiagnostics')) {
              channel.send(
                JSON.stringify({
                  type: 'crash_detected',
                  server: name,
                  analysis,
                })
              );
            }
          } else {
            cleanupChannel();
          }
        });

        channel.onMessage.subscribe(async (msgBuf) => {
          const text = typeof msgBuf === 'string' ? msgBuf : Buffer.from(msgBuf).toString('utf-8');
          logDaemonActivity('webrtc', `[WebRTC onMessage] ${text?.slice(0, 120)}`);
          try {
            if (text && (text.startsWith('{') || text.startsWith('['))) {
              JSON.parse(text);
              handleClientMessage(channel, text, activeTransfers);
              return;
            }
          } catch (e) {
            logDaemonActivity('warn', `[WebRTC onMessage parse error]: ${e}`);
          }
          handleBinaryMessage(channel, Buffer.isBuffer(msgBuf) ? msgBuf : Buffer.from(msgBuf), activeTransfers);
        });
      });

      let disconnectTimer: NodeJS.Timeout | undefined;
      pc.iceConnectionStateChange.subscribe((state) => {
        console.log(`[WebRTC] Connection state (${docId}): ${state}`);
        if (state === 'connected' || state === 'completed') {
          if (disconnectTimer) {
            clearTimeout(disconnectTimer);
            disconnectTimer = undefined;
          }
        } else if (state === 'disconnected') {
          if (!disconnectTimer) {
            disconnectTimer = setTimeout(() => {
              console.log(`[WebRTC] ICE connection remained disconnected for 5s (${docId}), closing`);
              pc.close();
            }, 5000);
          }
        } else if (state === 'failed') {
          if (disconnectTimer) clearTimeout(disconnectTimer);
          pc.close();
        }
      });

      await pc.setRemoteDescription(new RTCSessionDescription(offerData.sdp, offerData.type));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      console.log(`[WebRTC] Gathering ICE candidates (${docId})...`);
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
          return;
        }
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            console.log(`[WebRTC] ICE gathering timed out after 3s (${docId}), proceeding with available candidates`);
            resolve();
          }
        }, 3000);
        const sub = pc.iceGatheringStateChange.subscribe((state) => {
          if (state === 'complete' && !resolved) {
            resolved = true;
            clearTimeout(timer);
            sub?.unSubscribe?.();
            resolve();
          }
        });
      });

      const finalAnswer = pc.localDescription;
      if (!finalAnswer) throw new Error('Failed to get local description');

      await restCommit([
        {
          update: {
            name: docName(`daemon_connections/${docId}`),
            fields: {
              status: { stringValue: 'answer' },
              answer: {
                mapValue: {
                  fields: {
                    type: { stringValue: finalAnswer.type },
                    sdp: { stringValue: finalAnswer.sdp },
                  },
                },
              },
            },
          },
        },
      ]);
      console.log(`[WebRTC] Answer sent to Firestore for ${docId}`);
    } catch (error) {
      console.error(`[WebRTC] Failed to handle offer ${docId}:`, error);
      try {
        await restCommit([
          {
            update: {
              name: docName(`daemon_connections/${docId}`),
              fields: { status: { stringValue: 'error' } },
            },
          },
        ]);
      } catch {}
    } finally {
      inFlightOffers.delete(docId);
    }
  };

  unsubConnections = onSnapshot(
    q,
    (snapshot) => {
      // #region agent log
      __agentDebugLog(
        'run2',
        'H1',
        'void_server/src/network/webrtc.ts:onSnapshot-offers',
        'Offer snapshot update',
        {
          daemonId,
          changes: snapshot.docChanges().map((c) => ({
            type: c.type,
            id: c.doc.id,
            status: c.doc.data()?.status,
          })),
        }
      );
      // #endregion
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data();
          const docId = change.doc.id;

          if (data.offer && data.status === 'offer') {
            void handleIncomingOffer(docId, data);
          }
        }
      }
    },
    (err) => {
      console.error('[WebRTC] Offers query onSnapshot error:', err?.message || err);
    }
  );

  return () => {
    teardown();
    void registerNode('offline');
  };
}

// Keep track of which channels are subscribed to which server's logs
const channelSubscriptions = new WeakMap<any, () => void>();

function isJson(buf: Buffer) {
  try {
    JSON.parse(buf.toString());
    return true;
  } catch { return false; }
}

async function handleBinaryMessage(channel: any, data: Buffer, transfers: Map<string, any>) {
  // Simple header: 36 bytes UUID for transfer session
  const sessionId = data.subarray(0, 36).toString();
  const chunk = data.subarray(36);
  
  const transfer = transfers.get(sessionId);
  if (!transfer || !transfer.writeStream) return;

  transfer.writeStream.write(chunk);
  transfer.received += chunk.length;

  if (transfer.received >= transfer.size) {
    transfer.writeStream.end();
    transfers.delete(sessionId);
    channel.send(JSON.stringify({ type: 'upload_success', path: transfer.path }));
  }
}

async function getLocalIp() {
  const os = await import('node:os');
  const nets = os.networkInterfaces();
  const results: string[] = [];
  
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]!) {
      if (net.family === 'IPv4' && !net.internal) {
        // Skip APIPA (Link-local)
        if (net.address.startsWith('169.254.')) continue;
        results.push(net.address);
      }
    }
  }
  
  // Prioritize common LAN ranges
  const priority = results.find(ip => 
    ip.startsWith('192.168.') || 
    ip.startsWith('10.') || 
    ip.startsWith('172.16.') ||
    ip.startsWith('172.17.') ||
    ip.startsWith('172.18.') ||
    ip.startsWith('172.19.') ||
    ip.startsWith('172.20.') ||
    ip.startsWith('172.21.') ||
    ip.startsWith('172.22.') ||
    ip.startsWith('172.23.') ||
    ip.startsWith('172.24.') ||
    ip.startsWith('172.25.') ||
    ip.startsWith('172.26.') ||
    ip.startsWith('172.27.') ||
    ip.startsWith('172.28.') ||
    ip.startsWith('172.29.') ||
    ip.startsWith('172.30.') ||
    ip.startsWith('172.31.')
  );

  return priority || results[0] || '127.0.0.1';
}

export async function sendServersList(channel?: any) {
  if (!channel) {
    for (const ch of openChannels) {
      if (ch.readyState === 'open') {
        await sendServersList(ch);
      }
    }
    return;
  }
  const peerUid = channelUserMap.get(channel) || currentOwnerUid;
  if (peerUid && peerUid !== currentOwnerUid) {
    await refreshServerAccessGrants();
  }
  const localIp = await getLocalIp();
  const servers = listServers();
  const running = getRunningServers();
  const serverData: any[] = [];
  for (const meta of servers) {
    let sharedPermissions: Record<string, boolean> | undefined;
    if (peerUid && peerUid !== currentOwnerUid) {
      const grant = getPeerGrant(peerUid, meta.name);
      if (!grant) continue;
      sharedPermissions = grant.permissions;
    }
    const tunnel = getTunnelState(meta.name);
    serverData.push({
      ...meta,
      isRunning: running.includes(meta.name),
      status: getServerStatus(meta.name),
      localIp,
      tunnelAddress: tunnel?.address || null,
      tunnelStatus: tunnel ? 'active' : 'idle',
      tunnelStrategy: tunnel?.strategy || null,
      autoExpose: meta.autoExpose,
      subdomain: meta.subdomain,
      ...(sharedPermissions ? { sharedPermissions } : {}),
    });
  }
  // #region agent log
  __agentDebugLog(
    'run2',
    'H4',
    'void_server/src/network/webrtc.ts:sendServersList',
    'Sending servers_list payload',
    {
      count: serverData.length,
      servers: serverData.map(s => ({
        name: s.name,
        status: s.status,
        isRunning: s.isRunning
      }))
    }
  );
  // #endregion
  channel.send(JSON.stringify({ type: 'servers_list', servers: serverData }));
}

export async function broadcastServersList() {
  await sendServersList();
}

function checkPeerActionAllowed(peerUid: string, payload: any): boolean {
  if (!peerUid || peerUid === currentOwnerUid) return true;
  const action = String(payload.action || '');
  const srv = String(payload.server || payload.name || payload.serverName || payload.oldName || '');

  // Always allowed non-mutating/global queries
  if (
    action === 'ping' ||
    action === 'refresh_auth' ||
    action === 'get_host_info' ||
    action === 'get_versions' ||
    action === 'get_loader_builds' ||
    action === 'get_java_versions' ||
    action === 'list_servers' ||
    action === 'unsubscribe_logs' ||
    action === 'modrinth_search' ||
    action === 'curseforge_search'
  ) {
    return true;
  }

  // Strictly owner-only actions
  if (
    action === 'create_server' ||
    action === 'delete_server' ||
    action === 'rename_server' ||
    action === 'import_server' ||
    action === 'import_upload_start' ||
    action === 'inspect_server_jars' ||
    action === 'update_cli'
  ) {
    return false;
  }

  if (!srv) return false;

  switch (action) {
    case 'start':
    case 'start_server':
    case 'set_eula':
      return hasServerPerm(peerUid, srv, 'canStart');

    case 'stop':
    case 'stop_server':
      return hasServerPerm(peerUid, srv, 'canStop');

    case 'restart':
    case 'restart_server':
      return hasServerPerm(peerUid, srv, 'canRestart');

    case 'kill':
    case 'kill_server':
      return hasServerPerm(peerUid, srv, 'canForceKill');

    case 'get_logs':
    case 'subscribe_logs':
      return hasServerPerm(peerUid, srv, 'canViewConsole');

    case 'command':
    case 'send_command':
      return hasServerPerm(peerUid, srv, 'canSendConsole');

    case 'get_players':
    case 'get_player_details':
    case 'get_player_detail':
      return hasServerPerm(peerUid, srv, 'canViewPlayers') || hasServerPerm(peerUid, srv, 'canManagePlayers');

    case 'player_action':
    case 'kick_player':
    case 'ban_player':
    case 'unban_player':
    case 'op_player':
    case 'deop_player':
    case 'whitelist_add':
    case 'whitelist_remove':
    case 'whitelist_on':
    case 'whitelist_off':
      return hasServerPerm(peerUid, srv, 'canManagePlayers');

    case 'files_list':
    case 'list_files':
    case 'files_read':
    case 'read_file':
    case 'files_download':
    case 'download_file':
    case 'get_trash':
      return hasServerPerm(peerUid, srv, 'canViewFiles') || hasServerPerm(peerUid, srv, 'canEditFiles');

    case 'trash_action':
      if (payload.trashAction === 'list') {
        return hasServerPerm(peerUid, srv, 'canViewFiles') || hasServerPerm(peerUid, srv, 'canEditFiles');
      }
      return hasServerPerm(peerUid, srv, 'canEditFiles');

    case 'files_write':
    case 'write_file':
    case 'files_create':
    case 'files_mkdir':
    case 'files_delete':
    case 'files_rename':
    case 'files_copy':
    case 'files_move':
    case 'file_action':
    case 'files_zip':
    case 'files_unzip':
    case 'archive_action':
    case 'upload_start':
    case 'upload_chunk':
    case 'restore_trash_item':
    case 'delete_trash_item_permanent':
    case 'empty_trash':
    case 'set_trash_retention':
      return hasServerPerm(peerUid, srv, 'canEditFiles');

    case 'get_plugins':
    case 'list_plugins':
    case 'toggle_plugin':
    case 'delete_plugin':
    case 'install_plugin':
    case 'get_mods':
    case 'list_mods':
    case 'toggle_mod':
    case 'delete_mod':
    case 'install_mod':
      return hasServerPerm(peerUid, srv, 'canPluginsMods');

    case 'get_properties':
    case 'save_properties':
    case 'get_icon':
    case 'set_icon':
    case 'set_motd':
    case 'set_server_ram':
    case 'set_server_startup':
    case 'get_java_runtimes':
      return hasServerPerm(peerUid, srv, 'canProperties');

    case 'get_crash_history':
    case 'get_crash_analysis':
    case 'dismiss_crash':
    case 'upload_mclogs':
    case 'install_spark':
      return hasServerPerm(peerUid, srv, 'canDiagnostics');

    case 'get_world_info':
    case 'get_world_dimensions':
    case 'get_dimension_regions':
    case 'delete_chunks':
    case 'delete_regions':
    case 'trim_world':
    case 'reset_dimension':
    case 'delete_world':
    case 'export_world':
    case 'import_world_start':
    case 'get_map_regions':
    case 'get_map_metadata':
    case 'get_map_tile':
    case 'render_map':
    case 'start_map_watcher':
    case 'stop_map_watcher':
    case 'force_map_refresh':
      return hasServerPerm(peerUid, srv, 'canWorlds');

    case 'get_backup_config':
    case 'set_backup_config':
    case 'save_backup_config':
    case 'get_backup_status':
    case 'list_backups':
    case 'list_cloud_backups':
    case 'create_backup':
    case 'create_cloud_backup':
    case 'delete_backup':
    case 'delete_cloud_backup':
    case 'restore_backup':
    case 'restore_cloud_backup':
    case 'list_local_backups':
    case 'create_local_backup':
    case 'delete_local_backup':
    case 'restore_local_backup':
    case 'download_local_backup':
    case 'get_local_backup_limit':
    case 'set_local_backup_limit':
    case 'save_local_backup_limit':
    case 'cancel_backup':
      return hasServerPerm(peerUid, srv, 'canBackups');

    case 'start_tunnel':
    case 'stop_tunnel':
    case 'get_tunnel_status':
    case 'set_networking_settings':
    case 'install_playit':
    case 'reset_playit':
    case 'get_dns_records':
    case 'create_dns_subdomain':
    case 'delete_dns_subdomain':
    case 'get_status_config':
    case 'save_status_config':
    case 'generate_status_id':
    case 'set_status_page_settings':
      return hasServerPerm(peerUid, srv, 'canNetworking');

    case 'get_schedules':
    case 'schedule_list':
    case 'create_schedule':
    case 'update_schedule':
    case 'schedule_save':
    case 'delete_schedule':
    case 'run_schedule_now':
    case 'schedule_logs':
    case 'schedule_logs_clear':
      return hasServerPerm(peerUid, srv, 'canSchedule');

    default:
      return false;
  }
}

async function handleClientMessage(channel: any, message: string, transfers: Map<string, any>) {
  try {
    const payload = JSON.parse(message);
    // Normalize server name field — client sends `server`, daemon expects `name`
    if (!payload.name && payload.server) payload.name = payload.server;
    if (!payload.name && payload.serverName) payload.name = payload.serverName;
    if (!payload.server && payload.name) payload.server = payload.name;
    if (!payload.oldName && (payload.server || payload.name)) payload.oldName = payload.server ?? payload.name;
    logDaemonActivity('webrtc', `[WebRTC] Action: ${payload.action}`);

    const peerUid = channelUserMap.get(channel) || currentOwnerUid;
    if (peerUid && peerUid !== currentOwnerUid) {
      if (!checkPeerActionAllowed(peerUid, payload)) {
        channel.send(JSON.stringify({ type: 'error', message: 'Permission denied for this action.' }));
        return;
      }
    }
    switch (payload.action) {
      case 'ping': {
        const { getPublicIp } = await import('./portForwarding.js');
        const publicIp = await getPublicIp();
        const memory = getHostMemoryStats();
        
        channel.send(JSON.stringify({ 
          type: 'pong', 
          timestamp: Date.now(),
          daemonVersion: DAEMON_VERSION,
          system: {
            ...memory,
            hostCpuPercent: getHostCpuPercent(),
            publicIp
          }
        }));
        break;
      }

      case 'list_servers': {
        await sendServersList(channel);
        break;
      }

      case 'start_server': {
        const name = payload.name;
        console.log(`[WebRTC] Received start_server request for: ${name}`);
        const targetServer = listServers().find(s => s.name === name);
        if (targetServer) {
          if (!isEulaAccepted(name)) {
            channel.send(JSON.stringify({ type: 'eula_required', name }));
            break;
          }

          console.log(`[WebRTC] Server metadata found, calling startServer...`);
          try {
            await startServer(targetServer);
            console.log(`[WebRTC] startServer completed for: ${name}`);
            
            // Auto Expose check
            if (targetServer.autoExpose && targetServer.subdomain) {
              console.log(`[WebRTC] Triggering auto-exposure for ${name} on subdomain ${targetServer.subdomain}`);
              startExpose(name, targetServer.port, targetServer.subdomain, (event) => {
                channel.send(JSON.stringify({ ...event, type: 'tunnel_event', serverName: name }));
              }).catch(console.error);
            }

            await sendServersList(channel);
          } catch (err: any) {
            console.error(`[WebRTC] startServer FAILED for: ${name}`, err);
          }
        } else {
          console.error(`[WebRTC] Server NOT found in list: ${name}`);
        }
        break;
      }

      case 'set_eula': {
        const eulaName: string = payload.name;
        const eulaDir = getServerDir(eulaName);
        const eulaFilePath = path.join(eulaDir, 'eula.txt');
        fs.writeFileSync(eulaFilePath, '#Accepted by user via Void UI\neula=true\n');
        channel.send(JSON.stringify({ type: 'eula_set', name: eulaName }));
        break;
      }
      
      case 'generate_status_id': {
        const { serverName, statusId: clientStatusId } = payload;
        const { getServerMeta, saveServerMeta } = await import('../server/manager.js');
        const meta = getServerMeta(serverName);
        if (meta) {
          if (!meta.statusId) {
            meta.statusId = clientStatusId || (Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10));
            saveServerMeta(meta);
          }
          channel.send(JSON.stringify({ action: 'status_id_generated', serverName, statusId: meta.statusId }));
        } else {
          channel.send(JSON.stringify({ action: 'error', message: `Server "${serverName}" not found` }));
        }
        break;
      }

      case 'set_status_page_settings': {
        const { serverName, ...settings } = payload;
        const { getServerMeta, saveServerMeta } = await import('../server/manager.js');
        const meta = getServerMeta(serverName);
        if (meta) {
          if (settings.statusId !== undefined && settings.statusId !== meta.statusId) {
            const db = getDb();
            try {
              const { getDoc } = await import('firebase/firestore');
              const existingRef = doc(db, 'server_status', settings.statusId);
              const existingSnap = await getDoc(existingRef);
              if (existingSnap.exists() && existingSnap.data().name !== meta.name) {
                channel.send(JSON.stringify({ action: 'error', message: `Custom ID "${settings.statusId}" is already taken by another server` }));
                break;
              }
            } catch {}
            meta.statusId = settings.statusId;
            saveServerMeta(meta);
            try {
              await restCommit([{
                update: {
                  name: docName(`server_status/${settings.statusId}`),
                  fields: {
                    name: { stringValue: meta.name },
                    online: { booleanValue: false },
                    status: { stringValue: 'offline' },
                    playerCount: { integerValue: '0' },
                    maxPlayers: { integerValue: '20' },
                    version: { stringValue: meta.version },
                    serverType: { stringValue: meta.type },
                    motd: { stringValue: 'Loading...' },
                    ip: { stringValue: '' },
                    port: { integerValue: String(meta.port) },
                    showIp: { booleanValue: meta.statusPageShowIp ?? false },
                    theme: { stringValue: settings.theme || 'default' },
                    description: { stringValue: settings.description || '' },
                    lastUpdated: { stringValue: new Date().toISOString() },
                  },
                },
              }]);
            } catch {}
          }
          if (settings.showIp !== undefined) meta.statusPageShowIp = settings.showIp;
          if (settings.theme !== undefined) meta.statusPageTheme = settings.theme;
          if (settings.description !== undefined) meta.statusPageDescription = settings.description;
          saveServerMeta(meta);
          channel.send(JSON.stringify({ action: 'status_page_settings_saved', serverName }));
          await sendServersList(channel);
        } else {
          channel.send(JSON.stringify({ action: 'error', message: `Server "${serverName}" not found` }));
        }
        break;
      }

      case 'create_server': {
        try {
          const serverOpts = payload.serverOpts || {};
          console.log('[WebRTC] Handling create_server action with opts:', serverOpts);
          channel.send(JSON.stringify({
            type: 'install_progress',
            progress: { stage: 'creating', progress: 5, message: 'Starting installer on daemon...' }
          }));

          const port = serverOpts.port || getNextAvailablePort();
          const statusId = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
          const meta = {
            ...serverOpts,
            port,
            createdAt: new Date().toISOString(),
            statusId,
          };
          
          await installServer(meta, (progress) => {
            console.log('[WebRTC] installServer progress:', progress);
            channel.send(JSON.stringify({ type: 'install_progress', progress }));
          });
          
          if (serverOpts.initialProperties && typeof serverOpts.initialProperties === 'object') {
            try {
              await writeProperties(meta.name, serverOpts.initialProperties);
            } catch (pErr) {
              console.warn('[WebRTC] Could not write initialProperties post-install:', pErr);
            }
          }

          if (serverOpts.javaVersion) {
            try {
              const jv = typeof serverOpts.javaVersion === 'number' ? serverOpts.javaVersion : parseInt(serverOpts.javaVersion, 10);
              if (!isNaN(jv)) {
                meta.javaVersion = jv;
                if (serverOpts.launchJar) meta.launchJar = String(serverOpts.launchJar).trim();
                saveServerMeta(meta);
              }
            } catch (sErr) {
              console.warn('[WebRTC] Could not set server startup post-install:', sErr);
            }
          }

          await sendServersList(channel);
        } catch (err: any) {
          console.error('[WebRTC] create_server failed:', err);
          channel.send(JSON.stringify({ type: 'error', message: `Creation failed: ${err.message || err}` }));
        }
        break;
      }

      case 'stop_server': {
        stopServer(payload.name);
        await sendServersList(channel);
        break;
      }

      case 'kill_server': {
        killServer(payload.name);
        await sendServersList(channel);
        break;
      }

      case 'delete_server': {
        const { name } = payload;
        if (isRunning(name)) killServer(name);
        // Auto-delete DNS for tunnel if server had one
        const tunnelState = getTunnelState(name);
        if (tunnelState) {
          stopExpose(name, tunnelState.subdomain).catch(console.error);
        }
        deleteServer(name);
        await sendServersList(channel);
        channel.send(JSON.stringify({ type: 'action_success', action: `Server ${name} deleted successfully` }));
        break;
      }

      case 'start_tunnel': {
        const { serverName, subdomain } = payload;
        if (!isValidSubdomain(subdomain)) {
          channel.send(JSON.stringify({ type: 'error', message: 'Invalid subdomain format' }));
          break;
        }
        const server = listServers().find(s => s.name === serverName);
        if (server) {
          startExpose(serverName, server.port, subdomain, (event) => {
            channel.send(JSON.stringify({ ...event, type: 'tunnel_event', serverName }));
          }).catch(err => {
            console.error('[WebRTC] startExpose Error:', err);
            channel.send(JSON.stringify({ type: 'tunnel_event', type_orig: 'tunnel_error', serverName, payload: { message: err.message } }));
          });
        }
        break;
      }

      case 'stop_tunnel': {
        const { serverName, subdomain } = payload;
        await stopExpose(serverName, subdomain);
        channel.send(JSON.stringify({ type: 'tunnel_stopped', serverName }));
        break;
      }

      case 'set_networking_settings': {
        const { serverName, autoExpose, subdomain } = payload;
        const { getServerMeta, saveServerMeta } = await import('../server/manager.js');
        const meta = getServerMeta(serverName);
        if (meta) {
          meta.autoExpose = autoExpose;
          if (subdomain) meta.subdomain = subdomain;
          saveServerMeta(meta);
          await sendServersList(channel);
          channel.send(JSON.stringify({ type: 'action_success', action: 'Networking preferences saved' }));
        }
        break;
      }

      case 'rename_server': {
        const { oldName, newName } = payload;
        if (isRunning(oldName)) {
           channel.send(JSON.stringify({ type: 'error', message: 'Stop server before renaming' }));
           break;
        }
        if (renameServer(oldName, newName)) {
          await sendServersList(channel);
          channel.send(JSON.stringify({ type: 'action_success', action: `Renamed to ${newName}` }));
        } else {
          channel.send(JSON.stringify({ type: 'error', message: 'Rename failed. Check name validity or if it already exists.' }));
        }
        break;
      }

      case 'get_versions': {
        const { getVanillaReleases } = await import('../api/mojang.js');
        const { getPaperVersions } = await import('../api/paper.js');
        const { getFabricGameVersions } = await import('../api/fabric.js');
        const { getForgeGameVersions } = await import('../api/forge.js');
        const { getPurpurVersions } = await import('../api/purpur.js');
        const { getNeoForgeGameVersions } = await import('../api/neoforge.js');
        const { getQuiltGameVersions } = await import('../api/quilt.js');
        try {
          const [vanillaRes, paperRes, fabricRes, forgeRes, purpurRes, neoforgeRes, quiltRes, arclightRaw] = await Promise.all([
            getVanillaReleases().then(v => v.map(x => x.id)).catch(() => [] as string[]),
            getPaperVersions().catch(() => [] as string[]),
            getFabricGameVersions(50).catch(() => [] as string[]),
            getForgeGameVersions(50).catch(() => [] as string[]),
            getPurpurVersions().catch(() => [] as string[]),
            getNeoForgeGameVersions(50).catch(() => [] as string[]),
            getQuiltGameVersions(50).catch(() => [] as string[]),
            getArclightVersions().catch(() => []),
          ]);
          const vanilla = Array.isArray(vanillaRes) ? vanillaRes : [];
          const paper = Array.isArray(paperRes) ? paperRes : [];
          const fabric = Array.isArray(fabricRes) ? fabricRes : [];
          const forge = Array.isArray(forgeRes) ? forgeRes : [];
          const purpur = Array.isArray(purpurRes) ? purpurRes : [];
          const neoforge = Array.isArray(neoforgeRes) ? neoforgeRes : [];
          const quilt = Array.isArray(quiltRes) ? quiltRes : [];
          const arclightExtracted = Array.from(new Set(arclightRaw.map(v => v.version)));
          const arclight = arclightExtracted.length > 0
            ? arclightExtracted
            : ['1.21.1', '1.20.4', '1.20.1', '1.19.2', '1.18.2', '1.16.5'];

          channel.send(JSON.stringify({ 
            type: 'versions_manifest', 
            vanilla: vanilla.slice(0, 50), 
            paper: paper.slice(0, 50),
            fabric: fabric.slice(0, 50),
            forge: forge.slice(0, 50),
            purpur: purpur.slice(0, 50),
            neoforge: neoforge.slice(0, 50),
            quilt: quilt.slice(0, 50),
            arclight: arclight.slice(0, 50),
          }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Fetch failed: ${err.message}` }));
        }
        break;
      }

      case 'restart_server': {
        const target = listServers().find(s => s.name === payload.name);
        if (target) {
          if (isRunning(target.name)) {
            restartServer(target.name);
          } else {
            if (!isEulaAccepted(target.name)) {
              channel.send(JSON.stringify({ type: 'eula_required', name: target.name }));
              break;
            }
            await startServer(target);
          }
          await sendServersList(channel);
        }
        break;
      }

      case 'send_command':
        sendCommand(payload.name, payload.command);
        break;

      case 'subscribe_logs':
        // Unsubscribe from previous if existed
        if (channelSubscriptions.has(channel)) {
          channelSubscriptions.get(channel)!();
        }
        
        // 1. Clear client logs and stream history individually
        const history = getServerLogs(payload.name);
        console.log(`[WebRTC] Syncing ${history.length} logs for ${payload.name}`);
        channel.send(JSON.stringify({ type: 'log_history_clear' }));
        
        // Stream logs with small delays to prevent buffer saturation
        for (const log of history) {
          if (channel.readyState === 'open') {
            channel.send(JSON.stringify({ type: 'log', server: payload.name, log }));
          }
        }

        // 2. Subscribe to new logs
        const unsub = subscribeToLogs(payload.name, (log) => {
          if (channel.readyState === 'open') {
            const peerUid = channelUserMap.get(channel) || currentOwnerUid;
            if (peerUid === currentOwnerUid || hasServerPerm(peerUid, payload.name, 'canViewConsole')) {
              channel.send(JSON.stringify({ type: 'log', server: payload.name, log }));
            }
          } else {
            unsub();
          }
        });
        channelSubscriptions.set(channel, unsub);
        break;

      case 'unsubscribe_logs':
        if (channelSubscriptions.has(channel)) {
          channelSubscriptions.get(channel)!();
          channelSubscriptions.delete(channel);
        }
        break;

      case 'get_properties':
        const props = await readProperties(payload.name);
        channel.send(JSON.stringify({ type: 'properties', server: payload.name, properties: props }));
        break;

      case 'save_properties':
        await writeProperties(payload.name, payload.properties);
        channel.send(JSON.stringify({ type: 'save_success', server: payload.name }));
        break;

      case 'set_motd': {
        const targetServer = payload.server || payload.name;
        const formattedMotd = String(payload.motd || '').replace(/\r?\n/g, '\\n');
        await writeProperties(targetServer, { motd: formattedMotd });
        const updated = await readProperties(targetServer);
        channel.send(JSON.stringify({ type: 'properties_data', server: targetServer, properties: updated }));
        channel.send(JSON.stringify({ type: 'properties', server: targetServer, properties: updated }));
        channel.send(JSON.stringify({ type: 'save_success', server: targetServer }));
        break;
      }

      case 'get_players':
        const currentPlayers = await getPlayerLists(payload.name);
        currentPlayers.online = getOnlinePlayers(payload.name);
        channel.send(JSON.stringify({ type: 'players_list', server: payload.name, players: currentPlayers }));
        break;

      case 'get_player_detail': {
        const { server, uuid, name } = payload as { server: string; uuid: string; name?: string };
        try {
          const detail = await getPlayerDetail(server, uuid, name);
          channel.send(JSON.stringify({ type: 'player_detail', server, uuid, detail }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Player detail failed: ${err?.message || String(err)}` }));
        }
        break;
      }

      case 'player_action': {
        const { server, playerAction, player, reason } = payload;
        console.log(`[WebRTC] Executing ${playerAction} on ${player} for ${server}`);
        
        const isOnline = isRunning(server);

        switch(playerAction) {
          case 'op': 
            if (isOnline) sendCommand(server, `op ${player}`); 
            break;
          case 'deop': 
            if (isOnline) sendCommand(server, `deop ${player}`); 
            break;
          case 'whitelist_add': 
            if (isOnline) sendCommand(server, `whitelist add ${player}`); 
            break;
          case 'whitelist_remove': 
            if (isOnline) sendCommand(server, `whitelist remove ${player}`); 
            break;
          case 'ban': 
            if (isOnline) sendCommand(server, `ban ${player} ${reason || 'Banned by admin'}`); 
            break;
          case 'unban': 
            if (isOnline) sendCommand(server, `pardon ${player}`); 
            break;
          case 'kick': 
            if (isOnline) sendCommand(server, `kick ${player} ${reason || 'Kicked by admin'}`); 
            break;
        }
        
        // Immediate sync hint
        channel.send(JSON.stringify({ type: 'player_action_received', server, player }));

        // Refresh lists with delay to allow server I/O (800ms for memory, more for disk)
        setTimeout(async () => {
          const updated = await getPlayerLists(server);
          updated.online = getOnlinePlayers(server);
          console.log(`[WebRTC] Broadcasting updated player lists for ${server}`);
          channel.send(JSON.stringify({ type: 'players_list', server, players: updated }));
        }, 1200);
        break;
      }

      case 'list_files': {
        const { server, path: subPath } = payload;
        try {
          const files = listEntries(server, subPath || '');
          channel.send(JSON.stringify({ type: 'files_list', server, path: subPath || '', files }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'read_file': {
        const { server, path: filePath } = payload;
        try {
          const content = readTextFile(server, filePath);
          channel.send(JSON.stringify({ type: 'file_content', server, path: filePath, content }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'write_file': {
        const { server, path: filePath, content } = payload;
        try {
          writeTextFile(server, filePath, content);
          channel.send(JSON.stringify({ type: 'write_success', server, path: filePath }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'file_action': {
        const { server, fileAction, path: targetPath, name, newPath, permanent } = payload;
        try {
          switch (fileAction) {
            case 'create_folder':
              createEntry(server, targetPath, true);
              break;
            case 'create_file':
              createEntry(server, targetPath, false);
              break;
            case 'delete':
              deleteEntry(server, targetPath, permanent === true);
              break;
            case 'rename':
              renameEntry(server, targetPath, newPath);
              break;
          }
          channel.send(JSON.stringify({ type: 'action_success', server, action: fileAction }));
          
          // Refresh list automatically after action
          const dirPath = fileAction === 'delete' || fileAction === 'rename' 
            ? targetPath.split('/').slice(0, -1).join('/')
            : targetPath.split('/').slice(0, -1).join('/'); // Simplification, usually parent
          
          const files = listEntries(server, dirPath || '');
          channel.send(JSON.stringify({ type: 'files_list', server, path: dirPath || '', files }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'trash_action': {
        const { trashAction, id, days } = payload;
        try {
          switch (trashAction) {
            case 'list': {
              const summary = getTrashSummary();
              channel.send(JSON.stringify({ type: 'trash_list', ...summary }));
              break;
            }
            case 'restore': {
              restoreTrashItem(id);
              const summary = getTrashSummary();
              channel.send(JSON.stringify({ type: 'trash_list', ...summary, restoredId: id }));
              break;
            }
            case 'delete_item': {
              deleteTrashItemPermanent(id);
              const summary = getTrashSummary();
              channel.send(JSON.stringify({ type: 'trash_list', ...summary }));
              break;
            }
            case 'empty': {
              emptyTrash();
              const summary = getTrashSummary();
              channel.send(JSON.stringify({ type: 'trash_list', ...summary }));
              break;
            }
            case 'set_retention': {
              if (typeof days === 'number') setTrashRetentionDays(days);
              const summary = getTrashSummary();
              channel.send(JSON.stringify({ type: 'trash_list', ...summary }));
              break;
            }
          }
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'upload_start': {
        const { server, path: subPath, name, size } = payload;
        const root = getServerDir(server);
        const fullPath = path.resolve(root, subPath, name);
        
        if (!fullPath.startsWith(root)) {
          channel.send(JSON.stringify({ type: 'error', message: 'Path traversal blocked' }));
          return;
        }

        const sessionId = uuidv4();
        const writeStream = fs.createWriteStream(fullPath);
        
        transfers.set(sessionId, {
          writeStream,
          path: fullPath,
          size,
          received: 0
        });

        channel.send(JSON.stringify({ type: 'upload_ready', sessionId, name, size }));
        break;
      }

      case 'download_file': {
        const { server, path: subPath } = payload;
        const root = getServerDir(server);
        const fullPath = path.resolve(root, subPath);
        
        if (!fullPath.startsWith(root) || !fs.existsSync(fullPath)) {
          channel.send(JSON.stringify({ type: 'error', message: 'Invalid file' }));
          return;
        }

        const stats = fs.statSync(fullPath);
        if (stats.isDirectory()) {
          channel.send(JSON.stringify({ type: 'error', message: 'You cannot download a folder directly. Please right-click and Zip it first.' }));
          return;
        }

        const sessionId = uuidv4();
        
        channel.send(JSON.stringify({ type: 'download_ready', sessionId, name: path.basename(fullPath), size: stats.size }));

        const readStream = fs.createReadStream(fullPath, { highWaterMark: 16384 });
        readStream.on('data', (chunk: Buffer) => {
          if (channel.readyState === 'open') {
            const header = Buffer.from(sessionId);
            channel.send(Buffer.concat([header, chunk]));
          }
        });
        readStream.on('end', () => {
          channel.send(JSON.stringify({ type: 'download_complete', sessionId }));
        });
        break;
      }

      case 'archive_action': {
        const { server, archiveAction, path: targetPath } = payload;
        const root = getServerDir(server);
        const fullPath = path.resolve(root, targetPath);
        
        try {
          if (archiveAction === 'extract') {
            await extractArchive(fullPath, path.dirname(fullPath));
          } else if (archiveAction === 'compress') {
            const zipPath = fullPath + '.zip';
            const stats = fs.statSync(fullPath);
            if (stats.isDirectory()) {
              await compressFolder(fullPath, zipPath);
            } else {
              // Simple one-file zip
              const zip = new (await import('adm-zip')).default();
              zip.addLocalFile(fullPath);
              zip.writeZip(zipPath);
            }
          }
          
          const dirPath = targetPath.split('/').slice(0, -1).join('/');
          const files = listEntries(server, dirPath || '');
          channel.send(JSON.stringify({ type: 'files_list', server, path: dirPath || '', files }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'list_plugins': {
        const { server } = payload;
        try {
          const plugins = listPlugins(server);
          channel.send(JSON.stringify({ type: 'plugins_list', server, plugins }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'toggle_plugin': {
        const { server, fileName, enable } = payload;
        try {
          togglePlugin(server, fileName, enable);
          const plugins = listPlugins(server);
          channel.send(JSON.stringify({ type: 'plugins_list', server, plugins }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'install_plugin': {
        const { server, url, fileName } = payload;
        const root = getServerDir(server);
        const pluginsPath = path.join(root, 'plugins');
        const sanitizedFileName = fileName.replace(/[^a-z0-9.-]/gi, '_');
        const fullPath = path.join(pluginsPath, sanitizedFileName.endsWith('.jar') ? sanitizedFileName : sanitizedFileName + '.jar');
        
        try {
          if (!fs.existsSync(pluginsPath)) fs.mkdirSync(pluginsPath, { recursive: true });
          channel.send(JSON.stringify({ type: 'action_info', server, action: `Downloading ${sanitizedFileName}...` }));
          
          const https = await import('node:https');
          
          const download = (targetUrl: string): Promise<void> => {
            return new Promise((resolve, reject) => {
              https.get(targetUrl, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                  download(res.headers.location!).then(resolve).catch(reject);
                  return;
                }
                
                if (res.statusCode !== 200) {
                  reject(new Error(`Server responded with ${res.statusCode}`));
                  return;
                }

                const fileStream = fs.createWriteStream(fullPath);
                res.pipe(fileStream);
                
                fileStream.on('finish', () => {
                  fileStream.close();
                  resolve();
                });
                
                fileStream.on('error', (err) => {
                  fs.unlink(fullPath, () => {});
                  reject(err);
                });
              }).on('error', reject);
            });
          };

          await download(url);
          
          const plugins = listPlugins(server);
          channel.send(JSON.stringify({ type: 'plugins_list', server, plugins }));
          channel.send(JSON.stringify({ type: 'action_success', server, action: `Successfully installed ${sanitizedFileName}!` }));
        } catch (err: any) {
          console.error('[WebRTC] Installation Error:', err);
          channel.send(JSON.stringify({ type: 'error', message: `Installation failed: ${err.message}` }));
        }
        break;
      }

      case 'list_mods': {
        const { server } = payload;
        try {
          const mods = listMods(server);
          channel.send(JSON.stringify({ type: 'mods_list', server, mods }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'toggle_mod': {
        const { server, fileName, enable } = payload;
        try {
          toggleMod(server, fileName, enable);
          const mods = listMods(server);
          channel.send(JSON.stringify({ type: 'mods_list', server, mods }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'install_mod': {
        const { server, url, fileName } = payload;
        const root = getServerDir(server);
        const modsPath = path.join(root, 'mods');
        const sanitizedFileName = fileName.replace(/[^a-z0-9.-]/gi, '_');
        const fullPath = path.join(modsPath, sanitizedFileName.endsWith('.jar') ? sanitizedFileName : sanitizedFileName + '.jar');

        try {
          if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, { recursive: true });
          channel.send(JSON.stringify({ type: 'action_info', server, action: `Downloading ${sanitizedFileName}...` }));

          const https = await import('node:https');

          const download = (targetUrl: string): Promise<void> => {
            return new Promise((resolve, reject) => {
              https.get(targetUrl, (res) => {
                if (res.statusCode === 301 || res.statusCode === 302) {
                  download(res.headers.location!).then(resolve).catch(reject);
                  return;
                }

                if (res.statusCode !== 200) {
                  reject(new Error(`Server responded with ${res.statusCode}`));
                  return;
                }

                const fileStream = fs.createWriteStream(fullPath);
                res.pipe(fileStream);

                fileStream.on('finish', () => {
                  fileStream.close();
                  resolve();
                });

                fileStream.on('error', (err) => {
                  fs.unlink(fullPath, () => {});
                  reject(err);
                });
              }).on('error', reject);
            });
          };

          await download(url);

          const mods = listMods(server);
          channel.send(JSON.stringify({ type: 'mods_list', server, mods }));
          channel.send(JSON.stringify({ type: 'action_success', server, action: `Successfully installed ${sanitizedFileName}!` }));
        } catch (err: any) {
          console.error('[WebRTC] Mod installation error:', err);
          channel.send(JSON.stringify({ type: 'error', message: `Installation failed: ${err.message}` }));
        }
        break;
      }

      // ── Modrinth / CurseForge Search ────────────────────────────────────────
      case 'modrinth_search': {
        const { query, facets, limit, index, modrinthToken } = payload;
        try {
          const params = new URLSearchParams({ query: query || '' });
          if (facets) params.set('facets', facets);
          if (limit) params.set('limit', String(limit));
          if (index) params.set('index', index);
          const headers: Record<string, string> = {};
          if (modrinthToken) headers['Authorization'] = modrinthToken;
          const res = await fetch(`https://api.modrinth.com/v2/search?${params}`, { headers });
          const data = await res.json();
          channel.send(JSON.stringify({ type: 'modrinth_search_result', result: data }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Modrinth search failed: ${err.message}` }));
        }
        break;
      }

      case 'curseforge_search': {
        const { query, gameVersion, modLoaderType, curseforgeApiKey, limit } = payload;
        try {
          const params = new URLSearchParams({
            searchFilter: query || '',
            gameId: '432',
            ...(gameVersion ? { gameVersion } : {}),
            ...(modLoaderType ? { modLoaderType: String(modLoaderType) } : {}),
            pageSize: String(limit || 24),
            index: '0',
          });
          const res = await fetch(`https://api.curseforge.com/v1/mods/search?${params}`, {
            headers: { 'x-api-key': curseforgeApiKey || '' },
          });
          const data = await res.json();
          channel.send(JSON.stringify({ type: 'curseforge_search_result', result: data }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `CurseForge search failed: ${err.message}` }));
        }
        break;
      }

      // ── World Map ──────────────────────────────────────────────────────────
      case 'start_map_watcher': {
        const { server } = payload;
        if (server) {
          const { startMapWatcher } = await import('../utils/worldMap.js');
          startMapWatcher(server);
          channel.send(JSON.stringify({ type: 'map_watcher_started', server }));
        }
        break;
      }

      case 'stop_map_watcher': {
        const { server } = payload;
        if (server) {
          const { stopMapWatcher } = await import('../utils/worldMap.js');
          stopMapWatcher(server);
          channel.send(JSON.stringify({ type: 'map_watcher_stopped', server }));
        }
        break;
      }

      case 'get_map_metadata': {
        const { server } = payload;
        if (server) {
          const { getMapMetadata } = await import('../utils/worldMap.js');
          const meta = getMapMetadata(server);
          channel.send(JSON.stringify({ type: 'map_metadata', server, ...meta }));
        }
        break;
      }

      case 'get_map_tile': {
        const { server, dim, rx, rz, y } = payload;
        if (server) {
          const { getMapTile } = await import('../utils/worldMap.js');
          
          const sendTile = (t: Buffer) => {
            const sessionId = uuidv4();
            channel.send(JSON.stringify({ type: 'map_tile_ready', sessionId, rx, rz, dim, y, size: t.length }));
            const header   = Buffer.from(sessionId);
            const combined = Buffer.concat([header, t]);
            channel.send(combined);
          };

          getMapTile(server, dim, rx, rz, y).then(tile => {
            if (tile) {
              sendTile(tile);
            } else {
              channel.send(JSON.stringify({ type: 'map_tile_missing', rx, rz, dim, y }));
            }
          }).catch(() => {
            channel.send(JSON.stringify({ type: 'map_tile_missing', rx, rz, dim, y }));
          });
        }
        break;
      }

      case 'force_map_refresh': {
        const { server } = payload;
        if (server) {
          // Send save-all command to the Minecraft server
          sendCommand(server, 'save-all');
          // Wait for Minecraft to finish writing, then re-render all tiles
          setTimeout(async () => {
            const { refreshAllTiles } = await import('../utils/worldMap.js');
            refreshAllTiles(server);
            channel.send(JSON.stringify({ type: 'map_refresh_started', server }));
          }, 3500);
        }
        break;
      }

      case 'get_backup_status': {
        channel.send(JSON.stringify({
          type: 'backup_status',
          status: activeBackupState.status,
          progress: activeBackupState.progress,
          activeType: activeBackupState.activeType,
          server: activeBackupState.server
        }));
        break;
      }

      case 'get_backup_config': {
        const { loadBackupConfig } = await import('../auth/session.js');
        const config = loadBackupConfig();
        channel.send(JSON.stringify({ type: 'backup_config', ...config }));
        break;
      }

      case 'save_backup_config': {
        const { backupServerUrl, backupToken } = payload;
        const { saveBackupConfig } = await import('../auth/session.js');
        saveBackupConfig({ backupServerUrl, backupToken });
        channel.send(JSON.stringify({ type: 'backup_config_saved', success: true }));
        break;
      }

      case 'list_cloud_backups': {
        const { server } = payload;
        const { getDaemonId, loadBackupConfig } = await import('../auth/session.js');
        const daemonId = getDaemonId();
        const { backupServerUrl, backupToken } = loadBackupConfig();

        if (!backupServerUrl || !backupToken) {
          channel.send(JSON.stringify({ type: 'cloud_backups_list', server, backups: [], error: 'Backup server URL or authorization token not configured!' }));
          break;
        }

        try {
          const res = await fetch(`${backupServerUrl}/api/backup/list?nodeId=${daemonId}&serverId=${server}`, {
            headers: {
              'Authorization': `Bearer ${backupToken}`
            }
          });

          if (!res.ok) {
            const errData = (await res.json().catch(() => ({}))) as any;
            channel.send(JSON.stringify({ type: 'error', message: errData.error || 'Failed to list cloud backups' }));
            break;
          }

          const maxCloudBackupsStr = res.headers.get('x-max-cloud-backups');
          const maxCloudBackups = maxCloudBackupsStr ? parseInt(maxCloudBackupsStr, 10) : 6;
          const backups = await res.json();
          channel.send(JSON.stringify({ type: 'cloud_backups_list', server, backups, maxCloudBackups }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Could not connect to backup server: ${err.message}. Our servers might be experiencing high traffic or offline. Please try again later.` }));
        }
        break;
      }

      case 'create_cloud_backup': {
        const { server } = payload;
        const { getDaemonId, loadBackupConfig } = await import('../auth/session.js');
        const daemonId = getDaemonId();
        const { backupServerUrl, backupToken } = loadBackupConfig();

        if (!backupServerUrl || !backupToken) {
          channel.send(JSON.stringify({ type: 'error', message: 'Backup server URL or authorization token not configured!' }));
          break;
        }

        updateBackupState(server, 'zipping', 0, 'cloud');

        const serverDir = getServerDir(server);
        const tempZipPath = path.join(os.tmpdir(), `void_backup_${server}_${Date.now()}.zip`);

        const controller = new AbortController();
        activeBackupControllers.set(server, controller);

        try {
          // Zip the server folder
          const { compressFolder } = await import('../utils/zipper.js');
          await compressFolder(serverDir, tempZipPath, (percent) => {
            const overallProgress = Math.round(percent * 0.5);
            updateBackupState(server, 'zipping', overallProgress, 'cloud');
          }, controller.signal);

          const stats = fs.statSync(tempZipPath);
          console.log(`[WebRTC Cloud Backup] Zipped size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
          updateBackupState(server, 'uploading', 50, 'cloud');

          // Upload using fetch and stream progress
          const fileStream = fs.createReadStream(tempZipPath);
          const filename = `backup_${Date.now()}.zip`;

          let bytesUploaded = 0;
          const totalBytes = stats.size;

          const progressTrackingStream = new ReadableStream({
            start(controller) {
              fileStream.pause();
              fileStream.on('data', (chunk: Buffer) => {
                bytesUploaded += chunk.length;
                const pct = Math.round((bytesUploaded / totalBytes) * 100);
                const overallProgress = Math.min(99, 50 + Math.round(pct * 0.5));
                updateBackupState(server, 'uploading', overallProgress, 'cloud');
                
                controller.enqueue(chunk);
                if (controller.desiredSize !== null && controller.desiredSize <= 0) {
                  fileStream.pause();
                }
              });
              fileStream.on('end', () => {
                controller.close();
              });
              fileStream.on('error', (err) => {
                controller.error(err);
              });
            },
            pull() {
              fileStream.resume();
            },
            cancel() {
              fileStream.destroy();
            }
          });

          const res = await fetch(`${backupServerUrl}/api/backup/upload`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${backupToken}`,
              'X-Node-ID': daemonId,
              'X-Server-ID': server,
              'X-Filename': filename,
              'Content-Type': 'application/octet-stream',
              'Content-Length': totalBytes.toString()
            },
            body: progressTrackingStream,
            // @ts-ignore
            duplex: 'half'
          });

          // Clean up temp zip file
          if (fs.existsSync(tempZipPath)) {
            fs.unlinkSync(tempZipPath);
          }

          if (res.status === 507) {
            updateBackupState(server, 'idle', 0, 'idle');
            channel.send(JSON.stringify({ 
              type: 'error', 
              message: 'Our backup servers are currently experiencing high traffic. Please try again later.' 
            }));
            break;
          }

          if (!res.ok) {
            const errData = (await res.json().catch(() => ({}))) as any;
            const errMsg = errData.error || `Upload failed with status code ${res.status}`;
            console.error('[WebRTC Cloud Backup Error] Server rejected upload:', errMsg);
            updateBackupState(server, 'idle', 0, 'idle');
            channel.send(JSON.stringify({ type: 'error', message: errMsg }));
            break;
          }

          updateBackupState(server, 'idle', 0, 'idle');
          channel.send(JSON.stringify({ type: 'backup_success', server }));
        } catch (err: any) {
          console.error('[WebRTC Cloud Backup Error] Exception occurred:', err);
          if (fs.existsSync(tempZipPath)) {
            fs.unlinkSync(tempZipPath);
          }
          updateBackupState(server, 'idle', 0, 'idle');
          channel.send(JSON.stringify({ 
            type: 'error', 
            message: `Could not connect to backup server: ${err.message}. Our backup servers are currently experiencing high traffic. Please try again later.` 
          }));
        }
        break;
      }

      case 'delete_cloud_backup': {
        const { server, filename } = payload;
        const { getDaemonId, loadBackupConfig } = await import('../auth/session.js');
        const daemonId = getDaemonId();
        const { backupServerUrl, backupToken } = loadBackupConfig();

        if (!backupServerUrl || !backupToken) {
          channel.send(JSON.stringify({ type: 'error', message: 'Backup server URL or authorization token not configured!' }));
          break;
        }

        try {
          const res = await fetch(`${backupServerUrl}/api/backup/delete`, {
            method: 'DELETE',
            headers: {
              'Authorization': `Bearer ${backupToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              nodeId: daemonId,
              serverId: server,
              filename
            })
          });

          if (!res.ok) {
            const errData = (await res.json().catch(() => ({}))) as any;
            channel.send(JSON.stringify({ type: 'error', message: errData.error || 'Failed to delete cloud backup' }));
            break;
          }

          // Trigger list reload immediately
          const listRes = await fetch(`${backupServerUrl}/api/backup/list?nodeId=${daemonId}&serverId=${server}`, {
            headers: {
              'Authorization': `Bearer ${backupToken}`
            }
          });
          const backups = await listRes.json();
          channel.send(JSON.stringify({ type: 'cloud_backups_list', server, backups }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Could not connect to backup server: ${err.message}` }));
        }
        break;
      }

      case 'restore_cloud_backup': {
        const { server, filename } = payload;
        const { getDaemonId, loadBackupConfig } = await import('../auth/session.js');
        const daemonId = getDaemonId();
        const { backupServerUrl, backupToken } = loadBackupConfig();

        if (!backupServerUrl || !backupToken) {
          channel.send(JSON.stringify({ type: 'error', message: 'Backup server URL or authorization token not configured!' }));
          break;
        }

        updateBackupState(server, 'downloading', 0, 'restore_cloud');
        const tempZipPath = path.join(os.tmpdir(), `void_restore_${server}_${Date.now()}.zip`);

        try {
          // Download backup file
          const downloadUrl = `${backupServerUrl}/api/backup/download?nodeId=${daemonId}&serverId=${server}&filename=${filename}&token=${backupToken}`;
          const res = await fetch(downloadUrl);

          if (!res.ok) {
            throw new Error(`Server returned HTTP ${res.status}`);
          }

          const fileStream = fs.createWriteStream(tempZipPath);
          const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
          let bytesDownloaded = 0;

          // Pipe fetch body stream to file and track progress
          // Node fetch response body is a Node Readable stream which also acts as async iterable
          // @ts-ignore
          for await (const chunk of res.body) {
            fileStream.write(chunk);
            bytesDownloaded += chunk.length;
            const pct = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 50;
            const overallProgress = Math.round(pct * 0.9);
            updateBackupState(server, 'downloading', overallProgress, 'restore_cloud');
          }
          fileStream.end();

          // Unzip/Extract backup
          updateBackupState(server, 'extracting', 90, 'restore_cloud');
          const serverDir = getServerDir(server);
          const { extractArchive } = await import('../utils/zipper.js');

          await extractArchive(tempZipPath, serverDir);
          
          updateBackupState(server, 'extracting', 100, 'restore_cloud');
          // Clean up temp file
          if (fs.existsSync(tempZipPath)) {
            fs.unlinkSync(tempZipPath);
          }

          updateBackupState(server, 'idle', 0, 'idle');
          channel.send(JSON.stringify({ type: 'restore_success', server }));
        } catch (err: any) {
          if (fs.existsSync(tempZipPath)) {
            fs.unlinkSync(tempZipPath);
          }
          updateBackupState(server, 'idle', 0, 'idle');
          channel.send(JSON.stringify({ type: 'error', message: `Restore failed: ${err.message}` }));
        }
        break;
      }

      case 'restore_backup': {
        const { server, filename, mode, newServerName } = payload;
        const { getServerMeta, saveServerMeta, serverExists, renameServer } = await import('../server/manager.js');
        const { stopServer, waitForServerStop, isRunning } = await import('../server/instance.js');
        const { getLocalBackupsDir, getServerDir } = await import('../utils/paths.js');
        const { extractArchive } = await import('../utils/zipper.js');

        try {
          let targetDir: string;
          let finalNewName: string = '';
          let archivedServerName: string | undefined;

          // Stop server if currently running
          if (isRunning(server)) {
            updateBackupState(server, 'idle', 0, payload.backupType === 'cloud' ? 'restore_cloud' : 'restore_local');
            channel.send(JSON.stringify({ type: 'backup_status', server, status: 'stopping', progress: 0, activeType: 'restore_local' }));
            stopServer(server);
            await waitForServerStop(server);
          }

          if (mode === 'new') {
            // 1. Calculate clean base name (strip -NEW or -OLD.* suffixes)
            const baseName = server.replace(/-NEW$/i, '').replace(/-OLD.*$/i, '') || 'server';

            // 2. Format human-readable timestamp: YYYY.MM.DD_HH-mm
            const now = new Date();
            const pad = (n: number) => String(n).padStart(2, '0');
            const dateStr = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;

            let oldTargetName = `${baseName}-OLD-${dateStr}`;
            let counter = 1;
            while (serverExists(oldTargetName)) {
              oldTargetName = `${baseName}-OLD-${dateStr}_${counter++}`;
            }

            finalNewName = newServerName?.trim() || `${baseName}-NEW`;
            archivedServerName = oldTargetName;

            const sourceMeta = getServerMeta(server);
            if (!sourceMeta) {
              channel.send(JSON.stringify({ type: 'error', message: `Source server "${server}" not found` }));
              break;
            }

            // Path to source backup file BEFORE directory renaming
            const sourceBackupsDir = getLocalBackupsDir(server);
            const sourceBackupFilePath = path.join(sourceBackupsDir, filename);

            // 3. Rename existing server directory & metadata to OLD-[date]
            const renameOk = renameServer(server, oldTargetName);
            if (renameOk) {
              console.log(`[RESTORE] Safely archived old server "${server}" -> "${oldTargetName}"`);
              // Ensure old server keeps its backups directory
              const oldBackupsDir = getLocalBackupsDir(oldTargetName);
              if (fs.existsSync(sourceBackupsDir) && sourceBackupsDir !== oldBackupsDir) {
                try {
                  fs.cpSync(sourceBackupsDir, oldBackupsDir, { recursive: true });
                } catch {}
              }
            }

            // 4. Create metadata for the new server
            const newMeta = {
              ...sourceMeta,
              name: finalNewName,
              createdAt: new Date().toISOString(),
              statusId: Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10),
            };
            saveServerMeta(newMeta);
            targetDir = getServerDir(finalNewName);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }

            // Copy backups to the new server's backup directory as well
            const newBackupsDir = getLocalBackupsDir(finalNewName);
            if (fs.existsSync(sourceBackupsDir) && sourceBackupsDir !== newBackupsDir) {
              try {
                fs.cpSync(sourceBackupsDir, newBackupsDir, { recursive: true });
              } catch {}
            }

            // 5. Extract the backup into targetDir
            if (payload.backupType === 'cloud') {
              const { getDaemonId, loadBackupConfig } = await import('../auth/session.js');
              const daemonId = getDaemonId();
              const { backupServerUrl, backupToken } = loadBackupConfig();
              if (!backupServerUrl || !backupToken) {
                channel.send(JSON.stringify({ type: 'error', message: 'Backup server URL or authorization token not configured!' }));
                break;
              }

              updateBackupState(finalNewName, 'downloading', 0, 'restore_cloud');
              const tempZipPath = path.join(os.tmpdir(), `void_restore_${finalNewName}_${Date.now()}.zip`);
              const downloadUrl = `${backupServerUrl}/api/backup/download?nodeId=${daemonId}&serverId=${server}&filename=${filename}&token=${backupToken}`;
              const res = await fetch(downloadUrl);
              if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);

              const fileStream = fs.createWriteStream(tempZipPath);
              const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
              let bytesDownloaded = 0;
              for await (const chunk of (res.body as any)) {
                fileStream.write(chunk);
                bytesDownloaded += chunk.length;
                const pct = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 50;
                updateBackupState(finalNewName, 'downloading', Math.round(pct * 0.9), 'restore_cloud');
              }
              fileStream.end();

              updateBackupState(finalNewName, 'extracting', 90, 'restore_cloud');
              await extractArchive(tempZipPath, targetDir);
              if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
            } else {
              const backupFileToExtract = fs.existsSync(sourceBackupFilePath) 
                ? sourceBackupFilePath 
                : path.join(getLocalBackupsDir(oldTargetName), filename);

              if (!fs.existsSync(backupFileToExtract)) {
                throw new Error(`Backup file "${filename}" not found`);
              }

              updateBackupState(finalNewName, 'extracting', 50, 'restore_local');
              await extractArchive(backupFileToExtract, targetDir);
            }

            // Synchronize meta.json name in targetDir
            const targetMetaPath = path.join(targetDir, 'meta.json');
            if (fs.existsSync(targetMetaPath)) {
              try {
                const targetMeta = JSON.parse(fs.readFileSync(targetMetaPath, 'utf-8'));
                targetMeta.name = finalNewName;
                fs.writeFileSync(targetMetaPath, JSON.stringify(targetMeta, null, 2));
              } catch {}
            }

            updateBackupState(finalNewName, 'idle', 0, 'idle');
            channel.send(JSON.stringify({ 
              type: 'restore_success', 
              server: finalNewName, 
              mode, 
              newServerName: finalNewName,
              archivedServerName: oldTargetName 
            }));
            await sendServersList(channel);
          } else {
            // mode === 'current' (overwrite in place)
            targetDir = getServerDir(server);

            if (payload.backupType === 'cloud') {
              const { getDaemonId, loadBackupConfig } = await import('../auth/session.js');
              const daemonId = getDaemonId();
              const { backupServerUrl, backupToken } = loadBackupConfig();
              if (!backupServerUrl || !backupToken) {
                channel.send(JSON.stringify({ type: 'error', message: 'Backup server URL or authorization token not configured!' }));
                break;
              }

              updateBackupState(server, 'downloading', 0, 'restore_cloud');
              const tempZipPath = path.join(os.tmpdir(), `void_restore_${server}_${Date.now()}.zip`);
              const downloadUrl = `${backupServerUrl}/api/backup/download?nodeId=${daemonId}&serverId=${server}&filename=${filename}&token=${backupToken}`;
              const res = await fetch(downloadUrl);
              if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);

              const fileStream = fs.createWriteStream(tempZipPath);
              const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
              let bytesDownloaded = 0;
              for await (const chunk of (res.body as any)) {
                fileStream.write(chunk);
                bytesDownloaded += chunk.length;
                const pct = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 50;
                updateBackupState(server, 'downloading', Math.round(pct * 0.9), 'restore_cloud');
              }
              fileStream.end();

              updateBackupState(server, 'extracting', 90, 'restore_cloud');
              await extractArchive(tempZipPath, targetDir);
              if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
            } else {
              const backupsDir = getLocalBackupsDir(server);
              const filePath = path.join(backupsDir, filename);
              const relative = path.relative(backupsDir, filePath);
              if (relative.includes('..') || path.isAbsolute(relative)) throw new Error('Access Denied');
              if (!fs.existsSync(filePath)) throw new Error('Backup file does not exist');
              updateBackupState(server, 'extracting', 50, 'restore_local');
              await extractArchive(filePath, targetDir);
            }

            updateBackupState(server, 'idle', 0, 'idle');
            channel.send(JSON.stringify({ type: 'restore_success', server, mode }));
          }
        } catch (err: any) {
          updateBackupState(server, 'idle', 0, 'idle');
          channel.send(JSON.stringify({ type: 'error', message: `Restore failed: ${err.message}` }));
        }
        break;
      }

      case 'get_local_backup_limit': {
        const { loadLocalBackupLimit } = await import('../auth/session.js');
        const limit = loadLocalBackupLimit();
        channel.send(JSON.stringify({ type: 'local_backup_limit', limitEnabled: limit.enabled, limitType: limit.type, limitValue: limit.value }));
        break;
      }

      case 'save_local_backup_limit': {
        const { limitEnabled, limitType, limitValue } = payload;
        const { saveLocalBackupLimit } = await import('../auth/session.js');
        saveLocalBackupLimit({ enabled: limitEnabled ?? true, type: limitType, value: limitValue });
        channel.send(JSON.stringify({ type: 'local_backup_limit_saved', success: true, limitEnabled: limitEnabled ?? true, limitType, limitValue }));
        break;
      }

      case 'list_local_backups': {
        const { server } = payload;
        const { getLocalBackupsDir } = await import('../utils/paths.js');
        const backupsDir = getLocalBackupsDir(server);
        
        try {
          if (!fs.existsSync(backupsDir)) {
            channel.send(JSON.stringify({ type: 'local_backups_list', server, backups: [] }));
            break;
          }
          const files = fs.readdirSync(backupsDir);
          const backups = files
            .filter(f => f.startsWith('backup_') && f.endsWith('.zip'))
            .map(filename => {
              const fullPath = path.join(backupsDir, filename);
              const stat = fs.statSync(fullPath);
              return {
                filename,
                size: stat.size,
                createdAt: stat.mtime.toISOString()
              };
            });
          backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          channel.send(JSON.stringify({ type: 'local_backups_list', server, backups }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Failed to list local backups: ${err.message}` }));
        }
        break;
      }

      case 'create_local_backup': {
        const { server } = payload;
        const { getLocalBackupsDir, getServerDir } = await import('../utils/paths.js');
        const { loadLocalBackupLimit } = await import('../auth/session.js');
        
        const backupsDir = getLocalBackupsDir(server);
        const serverDir = getServerDir(server);
        const limit = loadLocalBackupLimit();
        
        if (limit.enabled) {
          if (limit.type === 'size_gb') {
            const limitBytes = limit.value * 1024 * 1024 * 1024;
            let serverDirSize = 0;
            const calculateSize = (dir: string) => {
              if (!fs.existsSync(dir)) return;
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                  calculateSize(fullPath);
                } else {
                  serverDirSize += fs.statSync(fullPath).size;
                }
              }
            };
            calculateSize(serverDir);
            
            if (serverDirSize > limitBytes) {
              channel.send(JSON.stringify({ type: 'error', message: `Server folder size (${(serverDirSize / (1024*1024*1024)).toFixed(2)} GB) exceeds the total retention limit (${limit.value} GB). Increase limit to create a backup.` }));
              break;
            }
          }
        }
        
        const backupFilename = `backup_local_${Date.now()}.zip`;
        const finalBackupPath = path.join(backupsDir, backupFilename);
        const tempBackupPath = path.join(os.tmpdir(), `temp_${backupFilename}`);
        
        updateBackupState(server, 'zipping', 0, 'local');
        
        const controller = new AbortController();
        activeBackupControllers.set(server, controller);

        try {
          const { compressFolder } = await import('../utils/zipper.js');
          await compressFolder(serverDir, tempBackupPath, (percent) => {
            updateBackupState(server, 'zipping', percent, 'local');
          }, controller.signal);
          
          // Move the complete zip to the local backups directory
          fs.copyFileSync(tempBackupPath, finalBackupPath);
          fs.unlinkSync(tempBackupPath);
          
          const files = fs.readdirSync(backupsDir)
            .filter(f => f.startsWith('backup_') && f.endsWith('.zip'))
            .map(f => {
              const full = path.join(backupsDir, f);
              return { filename: f, fullPath: full, mtime: fs.statSync(full).mtime.getTime(), size: fs.statSync(full).size };
            });
            
          files.sort((a, b) => a.mtime - b.mtime);
          
          if (limit.enabled) {
            if (limit.type === 'quantity') {
              if (files.length > limit.value) {
                const deleteCount = files.length - limit.value;
                console.log(`[Local Backup FIFO] Exceeded limit of ${limit.value}. Deleting ${deleteCount} oldest backup(s).`);
                for (let i = 0; i < deleteCount; i++) {
                  if (fs.existsSync(files[i].fullPath)) {
                    fs.unlinkSync(files[i].fullPath);
                    console.log(`[Local Backup FIFO] Deleted old backup: ${files[i].filename}`);
                  }
                }
              }
            } else if (limit.type === 'size_gb') {
              const limitBytes = limit.value * 1024 * 1024 * 1024;
              let currentTotalSize = files.reduce((acc, f) => acc + f.size, 0);
              
              while (currentTotalSize > limitBytes && files.length > 0) {
                const oldest = files.shift();
                if (oldest && fs.existsSync(oldest.fullPath)) {
                  fs.unlinkSync(oldest.fullPath);
                  currentTotalSize -= oldest.size;
                  console.log(`[Local Backup Size FIFO] Deleted old backup: ${oldest.filename} to free up space.`);
                }
              }
            }
          }
          
          updateBackupState(server, 'idle', 0, 'idle');
          channel.send(JSON.stringify({ type: 'local_backup_success', server }));
          
          const updatedFiles = fs.readdirSync(backupsDir);
          const backups = updatedFiles
            .filter(f => f.startsWith('backup_') && f.endsWith('.zip'))
            .map(filename => {
              const fullPath = path.join(backupsDir, filename);
              const stat = fs.statSync(fullPath);
              return {
                filename,
                size: stat.size,
                createdAt: stat.mtime.toISOString()
              };
            });
          backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          channel.send(JSON.stringify({ type: 'local_backups_list', server, backups }));
          activeBackupControllers.delete(server);
        } catch (err: any) {
          activeBackupControllers.delete(server);
          if (fs.existsSync(tempBackupPath)) {
            fs.unlinkSync(tempBackupPath);
          }
          
          if (err.name === 'AbortError' || err.message === 'Backup aborted') {
            updateBackupState(server, 'idle', 0, 'idle');
            channel.send(JSON.stringify({ type: 'action_success', action: 'Backup Cancelled' }));
            return;
          }
          
          updateBackupState(server, 'idle', 0, 'idle');
          channel.send(JSON.stringify({ type: 'error', message: `Local backup failed: ${err.message}` }));
        }
        break;
      }

      case 'cancel_backup': {
        const { server } = payload;
        const controller = activeBackupControllers.get(server);
        if (controller) {
          controller.abort();
          activeBackupControllers.delete(server);
        }
        break;
      }

      case 'delete_local_backup': {
        const { server, filename } = payload;
        const { getLocalBackupsDir } = await import('../utils/paths.js');
        const backupsDir = getLocalBackupsDir(server);
        const filePath = path.join(backupsDir, filename);
        
        try {
          const relative = path.relative(backupsDir, filePath);
          if (relative.includes('..') || path.isAbsolute(relative)) {
            throw new Error('Access Denied');
          }
          
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
          
          const updatedFiles = fs.readdirSync(backupsDir);
          const backups = updatedFiles
            .filter(f => f.startsWith('backup_') && f.endsWith('.zip'))
            .map(fName => {
              const fullPath = path.join(backupsDir, fName);
              const stat = fs.statSync(fullPath);
              return {
                filename: fName,
                size: stat.size,
                createdAt: stat.mtime.toISOString()
              };
            });
          backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          channel.send(JSON.stringify({ type: 'local_backups_list', server, backups }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Delete failed: ${err.message}` }));
        }
        break;
      }

      case 'restore_local_backup': {
        const { server, filename } = payload;
        const { getLocalBackupsDir, getServerDir } = await import('../utils/paths.js');
        const backupsDir = getLocalBackupsDir(server);
        const filePath = path.join(backupsDir, filename);
        const serverDir = getServerDir(server);
        
        updateBackupState(server, 'extracting', 0, 'restore_local');
        
        try {
          const relative = path.relative(backupsDir, filePath);
          if (relative.includes('..') || path.isAbsolute(relative)) {
            throw new Error('Access Denied');
          }
          
          if (!fs.existsSync(filePath)) {
            throw new Error('Backup file does not exist');
          }
          
          updateBackupState(server, 'extracting', 50, 'restore_local');
          const { extractArchive } = await import('../utils/zipper.js');
          await extractArchive(filePath, serverDir);
          
          updateBackupState(server, 'extracting', 100, 'restore_local');
          updateBackupState(server, 'idle', 0, 'idle');
          channel.send(JSON.stringify({ type: 'restore_success', server }));
        } catch (err: any) {
          updateBackupState(server, 'idle', 0, 'idle');
          channel.send(JSON.stringify({ type: 'error', message: `Local restore failed: ${err.message}` }));
        }
        break;
      }
      // ── Schedule ────────────────────────────────────────────────────
      case 'schedule_save': {
        const { server, schedules } = payload;
        try {
          const scheduleDir = path.join(getServerDir(''), '.schedules');
          if (!fs.existsSync(scheduleDir)) fs.mkdirSync(scheduleDir, { recursive: true });
          const filePath = path.join(scheduleDir, `${server}.json`);
          fs.writeFileSync(filePath, JSON.stringify(schedules || [], null, 2));
          channel.send(JSON.stringify({ action: 'schedule_save_success', server, schedules }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Schedule save failed: ${err.message}` }));
        }
        break;
      }
      case 'schedule_list': {
        const { server } = payload;
        try {
          const scheduleDir = path.join(getServerDir(''), '.schedules');
          const filePath = path.join(scheduleDir, `${server}.json`);
          const schedules = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : [];
          channel.send(JSON.stringify({ action: 'schedule_list', server, schedules }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }
      case 'schedule_logs': {
        const { server } = payload;
        try {
          const scheduleDir = path.join(getServerDir(''), '.schedules');
          const logPath = path.join(scheduleDir, `${server}_logs.json`);
          const logs: any[] = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf-8')) : [];
          channel.send(JSON.stringify({ action: 'schedule_logs', server, logs }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }
      case 'schedule_logs_clear': {
        const { server } = payload;
        try {
          const scheduleDir = path.join(getServerDir(''), '.schedules');
          const logPath = path.join(scheduleDir, `${server}_logs.json`);
          if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
          channel.send(JSON.stringify({ action: 'schedule_logs_clear_success', server }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'get_crash_analysis': {
        const { server } = payload;
        try {
          const analysis = getLatestCrash(server);
          channel.send(JSON.stringify({ type: 'crash_analysis', server, analysis }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Crash analysis failed: ${err.message}` }));
        }
        break;
      }

      case 'upload_mclogs': {
        const { server, customContent } = payload;
        try {
          const logText = customContent || getServerLogsText(server);
          if (!logText || !logText.trim()) {
            channel.send(JSON.stringify({ type: 'mclogs_result', server, success: false, error: 'Log is empty' }));
            break;
          }
          const result = await uploadToMclogs(logText);
          channel.send(JSON.stringify({ type: 'mclogs_result', server, ...result }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'mclogs_result', server, success: false, error: err.message }));
        }
        break;
      }

      case 'get_java_runtimes': {
        const { server } = payload;
        try {
          const meta = getServerMeta(server);
          const installedLocal: number[] = [];
          for (const v of [8, 17, 21]) {
            const p = getLocalJavaPath(v);
            if (p && fs.existsSync(p)) installedLocal.push(v);
          }
          const sysInfo = detectJava(17);
          channel.send(JSON.stringify({
            type: 'java_runtimes',
            server,
            current: {
              javaVersion: meta?.javaVersion,
              customJavaPath: meta?.customJavaPath,
              jvmPreset: meta?.jvmPreset || 'aikar',
              customJvmArgs: meta?.customJvmArgs || '',
              launchJar: meta?.launchJar || (meta ? resolveServerJarName(meta, getServerDir(server)) : 'server.jar'),
              serverType: meta?.type || 'paper',
              serverVersion: meta?.version || '1.21.4',
            },
            availableJars: listServerJarsInDir(getServerDir(server)),
            installedLocal,
            systemJava: sysInfo.found ? { version: sysInfo.version, versionString: sysInfo.versionString, executablePath: sysInfo.executablePath } : null,
          }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'set_server_startup': {
        const { server, javaVersion, customJavaPath, jvmPreset, customJvmArgs, launchJar, serverType, serverVersion } = payload;
        try {
          const meta = getServerMeta(server);
          if (!meta) {
            channel.send(JSON.stringify({ type: 'error', message: `Server "${server}" not found` }));
            break;
          }
          meta.javaVersion = javaVersion ? parseInt(String(javaVersion), 10) : undefined;
          meta.customJavaPath = customJavaPath ? String(customJavaPath).trim() : undefined;
          meta.jvmPreset = jvmPreset;
          meta.customJvmArgs = customJvmArgs ? String(customJvmArgs).trim() : undefined;
          saveServerMeta(meta);
          if (launchJar !== undefined) meta.launchJar = launchJar ? String(launchJar).trim() : undefined;
          if (serverType) meta.type = serverType;
          if (serverVersion) meta.version = String(serverVersion).trim();
          saveServerMeta(meta);
          channel.send(JSON.stringify({ type: 'save_startup_success', server, meta }));
          await sendServersList(channel);
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'import_upload_start': {
        const { name, size } = payload;
        const safeExt = String(name || 'server.zip').toLowerCase().endsWith('.tar.gz') ? '.tar.gz' : '.zip';
        const sessionId = uuidv4();
        const archivePath = path.join(os.tmpdir(), `void_import_${sessionId}${safeExt}`);
        const writeStream = fs.createWriteStream(archivePath);
        transfers.set(sessionId, {
          writeStream,
          path: archivePath,
          size: Number(size) || 0,
          received: 0,
        });
        channel.send(JSON.stringify({ type: 'import_upload_ready', sessionId, archivePath, name, size }));
        break;
      }

      case 'inspect_server_jars': {
        const { server, folderPath } = payload;
        try {
          const targetDir = folderPath ? path.resolve(String(folderPath)) : getServerDir(server);
          const inspection = await inspectServerDirectory(targetDir);
          channel.send(JSON.stringify({ type: 'server_jars_inspection', server, folderPath: targetDir, ...inspection }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'import_server': {
        const { importOpts } = payload;
        try {
          if (!importOpts || !importOpts.name) {
            throw new Error('Missing server name for import');
          }
          const meta = await importServerFromSource(importOpts, (progress) => {
            channel.send(JSON.stringify({ type: 'install_progress', progress }));
          });
          await sendServersList(channel);
          channel.send(JSON.stringify({ type: 'import_server_success', server: meta.name, meta }));
        } catch (err: any) {
          console.error('[WebRTC] import_server failed:', err);
          channel.send(JSON.stringify({ type: 'error', message: `Import failed: ${err.message || err}` }));
        }
        break;
      }

      case 'get_world_dimensions': {
        const { server } = payload;
        try {
          const data = await getWorldDimensions(server);
          channel.send(JSON.stringify({ type: 'world_dimensions', server, ...data }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'get_dimension_regions': {
        const { server, dimensionId } = payload;
        try {
          const regions = await getDimensionRegions(server, dimensionId);
          channel.send(JSON.stringify({ type: 'dimension_regions', server, dimensionId, regions }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'reset_dimension': {
        const { server, dimensionId } = payload;
        try {
          if (isRunning(server)) {
            channel.send(JSON.stringify({ type: 'error', message: 'Please stop the server before resetting a dimension to prevent file locking and world corruption.' }));
            break;
          }
          const result = await resetDimension(server, dimensionId);
          channel.send(JSON.stringify({ type: 'reset_dimension_success', server, dimensionId, ...result }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'delete_regions': {
        const { server, dimensionId, files } = payload;
        try {
          if (isRunning(server)) {
            channel.send(JSON.stringify({ type: 'error', message: 'Please stop the server before deleting region files.' }));
            break;
          }
          const result = await deleteRegionFiles(server, dimensionId, files);
          channel.send(JSON.stringify({ type: 'delete_regions_success', server, dimensionId, ...result }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }

      case 'install_spark': {
        const { server } = payload;
        try {
          const meta = getServerMeta(server);
          if (!meta) throw new Error(`Server ${server} not found`);
          if (meta.type === 'vanilla') {
            throw new Error('Spark requires a plugin or mod loader (Paper, Purpur, Fabric, Forge, NeoForge, or Quilt). Vanilla does not support plugins or mods.');
          }
          const isPlugin = meta.type === 'paper' || meta.type === 'purpur';
          const targetFolder = isPlugin
            ? path.join(getServerDir(server), 'plugins')
            : path.join(getServerDir(server), 'mods');
          if (!fs.existsSync(targetFolder)) fs.mkdirSync(targetFolder, { recursive: true });

          const loaderFilter = isPlugin ? 'bukkit' : (meta.type === 'quilt' ? 'fabric' : meta.type);
          const loaderParam = encodeURIComponent(JSON.stringify([loaderFilter]));
          const searchUrl = `https://api.modrinth.com/v2/project/spark/version?loaders=${loaderParam}`;
          
          channel.send(JSON.stringify({ type: 'install_spark_status', server, stage: 'Searching Modrinth for compatible Spark version…' }));

          const res = await fetch(searchUrl, { headers: { 'User-Agent': 'VoidServerManager/1.0' } });
          if (!res.ok) throw new Error(`Modrinth returned ${res.status}`);
          const versions = await res.json() as any[];
          if (!versions || versions.length === 0) throw new Error(`No compatible Spark version found for ${meta.type}`);

          // Find matching game version or fallback to latest
          const matchedVersion = (meta.version ? versions.find((v: any) => v.game_versions?.includes(meta.version)) : null) || versions[0];
          const primaryFile = matchedVersion.files.find((f: any) => f.primary) || matchedVersion.files[0];
          if (!primaryFile || !primaryFile.url) throw new Error('Spark download URL not found');

          channel.send(JSON.stringify({ type: 'install_spark_status', server, stage: `Downloading ${primaryFile.filename}…` }));

          const jarRes = await fetch(primaryFile.url);
          if (!jarRes.ok) throw new Error(`Failed to download Spark jar: ${jarRes.status}`);
          const arrayBuffer = await jarRes.arrayBuffer();
          const savePath = path.join(targetFolder, primaryFile.filename);
          fs.writeFileSync(savePath, Buffer.from(arrayBuffer));

          channel.send(JSON.stringify({
            type: 'install_spark_success',
            server,
            filename: primaryFile.filename,
            target: isPlugin ? 'plugins' : 'mods',
          }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'install_spark_error', server, message: err.message }));
        }
        break;
      }

      case 'update_cli': {
        channel.send(JSON.stringify({ type: 'action_info', action: 'Update started — stopping all servers…' }));
        performUpdateCli();
        break;
      }
    }

  } catch (err: any) {
    console.error('[WebRTC] Dispatch Error:', err);
    console.error('[WebRTC] Stack:', err.stack);
    channel.send(JSON.stringify({ type: 'error', message: `Internal dispatcher error: ${err.message}` }));
  }
};
