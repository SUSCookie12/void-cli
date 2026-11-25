import { RTCPeerConnection, RTCSessionDescription } from 'werift';
import { collection, query, where, onSnapshot, doc, getDoc } from 'firebase/firestore';
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
  getLatestCrash,
  waitForServerStop
} from '../server/instance.js';
import { listServers, deleteServer, renameServer, getNextAvailablePort, getServerMeta, saveServerMeta, serverExists, isValidServerName, slugifyServerName } from '../server/manager.js';
import { installServer, reinstallServer, importServerFromSource, inspectServerDirectory } from '../server/installer.js';
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
import { listPlugins, togglePlugin, savePluginMetadata, resolveMissingPluginMetadata } from '../utils/plugins.js';
import { listMods, toggleMod, saveModMetadata, resolveMissingModMetadata } from '../utils/mods.js';
import { compressFolder, extractArchive } from '../utils/zipper.js';
import { 
  getTrashSummary, 
  restoreTrashItem, 
  deleteTrashItemPermanent, 
  emptyTrash, 
  setTrashRetentionDays,
  pruneExpiredTrash 
} from '../utils/trash.js';
import { getServerDir, getLocalBackupsDir } from '../utils/paths.js';
import { calculateServerDiskSize, invalidateServerDiskCache, getSystemDrives, browseHostDirectories, createHostDirectory, getFastFolderSize } from '../utils/hostFs.js';
import { getRunningServers } from '../server/instance.js';
import { DAEMON_VERSION } from '../version.js';
import { startExpose, stopExpose, getTunnelState } from './tunnelManager.js';
import { isValidSubdomain, deleteTunnelDns } from './dnsManager.js';
import { containsDisallowedWords } from '../utils/subdomainFilter.js';
import { VOID_DOMAIN } from '../config/dns.js';
import { generateRandomSubdomain } from '../utils/wordGenerator.js';
import { updateAllServerStatusPages, setServerFrozenStatus } from '../server/statusPage.js';
import { getArclightVersions } from '../api/arclight.js';
import { getBedrockVersions } from '../api/bedrock.js';
import { getVanillaReleases } from '../api/mojang.js';
import { getPaperVersions } from '../api/paper.js';
import { getFabricGameVersions } from '../api/fabric.js';
import { getForgeGameVersions } from '../api/forge.js';
import { getPurpurVersions } from '../api/purpur.js';
import { getNeoForgeGameVersions } from '../api/neoforge.js';
import { getQuiltGameVersions } from '../api/quilt.js';
import { getSchedules, saveSchedules, getScheduleLogs, clearScheduleLogs, runScheduleNow } from '../server/scheduler.js';
import net from 'node:net';
import https from 'node:https';
import { execSync } from 'node:child_process';
import AdmZip from 'adm-zip';
import { getPublicIp } from './portForwarding.js';
import { startMapWatcher, stopMapWatcher, getMapMetadata, getMapTile, refreshAllTiles } from '../utils/worldMap.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { clearSession, getDaemonId, loadBackupConfig, saveBackupConfig, loadLocalBackupLimit, saveLocalBackupLimit } from '../auth/session.js';
import { notifySessionRevoked } from '../auth/sessionEvents.js';
import { getHostCpuPercent, getHostMemoryStats } from '../utils/hostStats.js';

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

const broadcastToPeers = (message: Record<string, unknown>) => broadcastToWebRtc(message);

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

export function registerActiveBackupController(server: string, controller: AbortController) {
  activeBackupControllers.set(server, controller);
}

export function clearActiveBackupController(server: string) {
  for (const key of Array.from(activeBackupControllers.keys())) {
    if (key.toLowerCase() === server.toLowerCase()) {
      activeBackupControllers.delete(key);
    }
  }
}

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

export function isServerBackupActive(server?: string): boolean {
  if (activeBackupState.status === 'idle') return false;
  if (!server) return true;
  return activeBackupState.server.toLowerCase() === server.toLowerCase();
}

export function updateBackupState(
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

const activeFileUploads = new Map<string, Set<string>>();

function registerActiveFileUpload(server: string, sessionId: string) {
  const key = server.toLowerCase();
  let set = activeFileUploads.get(key);
  if (!set) {
    set = new Set<string>();
    activeFileUploads.set(key, set);
  }
  set.add(sessionId);
  broadcastToWebRtc({ type: 'upload_status', server, active: true, count: set.size });
}

function unregisterActiveFileUpload(server: string, sessionId: string) {
  const key = server.toLowerCase();
  const set = activeFileUploads.get(key);
  if (!set) return;
  set.delete(sessionId);
  const count = set.size;
  if (count === 0) {
    activeFileUploads.delete(key);
  }
  broadcastToWebRtc({ type: 'upload_status', server, active: count > 0, count });
}

export function isServerFileUploadActive(server: string): boolean {
  return (activeFileUploads.get(server.toLowerCase())?.size || 0) > 0;
}

function sendBackupBusyError(channel: any): boolean {
  if (activeBackupState.status === 'idle') return false;
  channel.send(JSON.stringify({
    type: 'error',
    code: 'SERVER_BUSY_BACKUP',
    preserveBackupState: true,
    message: `Server "${activeBackupState.server}" is currently ${activeBackupState.status} a backup (${activeBackupState.progress}%). Please wait for it to finish or cancel it first.`
  }));
  return true;
}

function isBackupAbortError(err: any, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted || err?.name === 'AbortError' || err?.message === 'Backup aborted');
}


function __agentDebugLog(
  _runId: string,
  _hypothesisId: string,
  _location: string,
  _message: string,
  _data: Record<string, unknown>
) {
  // Debug endpoint removed for production security
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

  unsubConnections = onSnapshot(q, async (snapshot) => {
    // #region agent log
    __agentDebugLog(
      'run2',
      'H1',
      'void_server/src/network/webrtc.ts:onSnapshot-offers',
      'Offer snapshot update',
      {
        daemonId,
        changes: snapshot.docChanges().map(c => ({
          type: c.type,
          id: c.doc.id,
          status: c.doc.data()?.status
        }))
      }
    );
    // #endregion
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        const data = change.doc.data();
        const docId = change.doc.id;

        if (data.offer && data.status === 'offer') {
          // #region agent log
          __agentDebugLog(
            'run2',
            'H2',
            'void_server/src/network/webrtc.ts:received-offer',
            'Received matching offer',
            {
              daemonId,
              docId,
              offerType: data.offer?.type
            }
          );
          // #endregion
          console.log(`[WebRTC] Received offer for node ${daemonId} from ${docId}`);
          const peerUserId = String(data.userId || data.clientUid || uid);
          if (peerUserId !== currentOwnerUid) {
            await refreshServerAccessGrants();
          }
          try {
            const pc = new RTCPeerConnection({
              iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
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
                  readyState: channel.readyState
                }
              );
              // #endregion
              console.log(`[WebRTC] DataChannel ${channel.label} opened`);
              
              if (channel.label.startsWith('tunnel::')) {
                const parts = channel.label.split('::');
                const serverName = parts[1];
                const connId = parts[2];
                
                const targetServer = listServers().find(s => s.name === serverName);
                if (!targetServer || !isRunning(serverName)) {
                    console.log(`[WebRTC Tunnel] Server ${serverName} not running, rejecting tunnel.`);
                    channel.close();
                    return;
                }
                
                try {
                    const tcpSocket = new net.Socket();
                    tcpSocket.connect(targetServer.port, '127.0.0.1', () => {
                        console.log(`[WebRTC Tunnel] Connected TCP proxy for ${serverName}:${targetServer.port} [${connId}]`);
                    });
                    
                    tcpSocket.on('data', (data) => {
                        if (channel.readyState === 'open') {
                            channel.send(data);
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
                } catch (netErr) {
                    console.error(`[WebRTC Tunnel] TCP Error on ${connId}:`, netErr);
                    channel.close();
                }
                return;
              }
              
              openChannels.add(channel);
              const pushInitialServers = () => {
                if (channel.readyState === 'open') {
                  void sendServersList(channel);
                }
              };
              if (channel.readyState === 'open') {
                setTimeout(pushInitialServers, 50);
              }
              const activeTransfers = new Map<string, {
                writeStream?: fs.WriteStream;
                path: string;
                size: number;
                received: number;
                server?: string;
              }>();
              channel.stateChanged.subscribe((state) => {
                if (state === 'open') {
                  setTimeout(pushInitialServers, 50);
                } else {
                  openChannels.delete(channel);
                  for (const [sid, t] of activeTransfers.entries()) {
                    try { t.writeStream?.destroy(); } catch {}
                    try {
                      if (t.path && fs.existsSync(t.path)) fs.unlinkSync(t.path);
                    } catch {}
                    if (t.server) unregisterActiveFileUpload(t.server, sid);
                  }
                  activeTransfers.clear();
                }
              });
              const statsInterval = setInterval(async () => {
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
                  clearInterval(statsInterval);
                }
              }, 2000);

              const unsubStatus = subscribeToAllStatus(() => {
                if (channel.readyState === 'open') {
                  void sendServersList(channel);
                } else {
                  unsubStatus();
                }
              });

              const unsubCrash = subscribeToCrash((name, analysis) => {
                if (channel.readyState === 'open') {
                  const peerUid = channelUserMap.get(channel) || currentOwnerUid;
                  if (peerUid === currentOwnerUid || hasServerPerm(peerUid, name, 'canDiagnostics')) {
                    channel.send(JSON.stringify({
                      type: 'crash_detected',
                      server: name,
                      analysis
                    }));
                  }
                } else {
                  unsubCrash();
                }
              });

              channel.onMessage.subscribe(async (msgBuf) => {
                const text = typeof msgBuf === 'string' ? msgBuf : Buffer.from(msgBuf).toString('utf-8');
                console.log('[WebRTC onMessage]', text?.slice(0, 120));
                try {
                  if (text && (text.startsWith('{') || text.startsWith('['))) {
                    JSON.parse(text);
                    handleClientMessage(channel, text, activeTransfers);
                    return;
                  }
                } catch (e) {
                  console.warn('[WebRTC onMessage parse error]:', e);
                }
                handleBinaryMessage(channel, Buffer.isBuffer(msgBuf) ? msgBuf : Buffer.from(msgBuf), activeTransfers);
              });
            });

            pc.iceConnectionStateChange.subscribe(state => {
              console.log(`[WebRTC] Connection state: ${state}`);
              if (state === 'disconnected' || state === 'failed') pc.close();
            });

            let offerData: any;
            if (typeof data.offer === 'string') {
              offerData = JSON.parse(data.offer);
            } else if (typeof data.offer.toJSON === 'function') {
              offerData = data.offer.toJSON();
            } else {
              offerData = JSON.parse(JSON.stringify(data.offer));
            }
            if (!offerData?.sdp || !offerData?.type) {
              console.error('[WebRTC] Invalid offer - missing sdp/type');
              return;
            }
            await pc.setRemoteDescription(new RTCSessionDescription(offerData.sdp, offerData.type));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            console.log('[WebRTC] Gathering ICE candidates...');
            await new Promise<void>((resolve) => {
              if (pc.iceGatheringState === 'complete') resolve();
              else {
                pc.iceGatheringStateChange.subscribe(state => {
                  if (state === 'complete') resolve();
                });
              }
            });

            const finalAnswer = pc.localDescription;
            if (!finalAnswer) throw new Error('Failed to get local description');

            await restCommit([{
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
            }]);
            console.log('[WebRTC] Answer sent to Firestore');
          } catch (error) {
            console.error('[WebRTC] Failed to handle offer:', error);
          }
        }
      }
    }
  }, (err) => {
    console.error('[WebRTC] Offers query onSnapshot error:', err?.message || err);
  });

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
    if (transfer.server) unregisterActiveFileUpload(transfer.server, sessionId);
    channel.send(JSON.stringify({ type: 'upload_success', path: transfer.path }));
  }
}

async function getLocalIp() {
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
    const hasActiveBackup =
      activeBackupState.status !== 'idle' &&
      activeBackupState.server.toLowerCase() === meta.name.toLowerCase();
    serverData.push({
      ...meta,
      isRunning: running.includes(meta.name),
      status: getServerStatus(meta.name),
      localIp,
      tunnelAddress: tunnel?.address || (meta.subdomain ? `${meta.subdomain}.s.borgov.dev` : null),
      tunnelStatus: tunnel ? tunnel.status : 'idle',
      tunnelStrategy: tunnel?.strategy || null,
      tunnelClaimUrl: null,
      diskSize: calculateServerDiskSize(meta.name),
      autoExpose: meta.autoExpose !== false,
      subdomain: meta.subdomain,
      domain: meta.subdomain ? `${meta.subdomain}.s.borgov.dev` : undefined,
      activeBackup: hasActiveBackup
        ? {
            status: activeBackupState.status,
            progress: activeBackupState.progress,
            activeType: activeBackupState.activeType,
          }
        : null,
      activeFileUpload: isServerFileUploadActive(meta.name),
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
  if (activeBackupState.status !== 'idle') {
    try {
      channel.send(JSON.stringify({
        type: 'backup_status',
        status: activeBackupState.status,
        progress: activeBackupState.progress,
        activeType: activeBackupState.activeType,
        server: activeBackupState.server,
      }));
    } catch {}
  }
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
    action === 'get_platform_versions' ||
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
    action === 'reinstall_server' ||
    action === 'freeze_server' ||
    action === 'unfreeze_server' ||
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
    case 'cancel_upload':
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
    case 'set_server_meta':
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
    case 'get_server_backup_dir':
    case 'set_server_backup_dir':
    case 'get_system_drives':
    case 'browse_directories':
    case 'create_directory':
      return hasServerPerm(peerUid, srv, 'canBackups');

    case 'start_tunnel':
    case 'stop_tunnel':
    case 'regenerate_subdomain':
    case 'set_custom_subdomain':
    case 'check_subdomain_availability':
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

const FROZEN_BLOCKED_ACTIONS = new Set([
  'write_file', 'files_write', 'create_file', 'files_create', 'create_folder', 'files_mkdir', 'create_directory',
  'delete_file', 'files_delete', 'rename_file', 'files_rename', 'upload_file', 'upload_file_chunk',
  'upload_start', 'upload_chunk', 'upload_finish', 'move_file', 'files_move', 'copy_file', 'files_copy',
  'unzip_file', 'files_unzip', 'zip_files', 'files_zip', 'file_action', 'archive_action', 'trash_action',
  'restore_trash_item', 'delete_trash_item_permanent', 'empty_trash', 'set_trash_retention',
  'install_plugin', 'uninstall_plugin', 'delete_plugin', 'toggle_plugin', 'enable_plugin', 'disable_plugin',
  'install_mod', 'uninstall_mod', 'delete_mod', 'toggle_mod', 'enable_mod', 'disable_mod',
  'create_backup', 'create_local_backup', 'create_cloud_backup', 'restore_backup', 'restore_local_backup',
  'restore_cloud_backup', 'delete_backup', 'delete_local_backup', 'delete_cloud_backup',
  'set_server_backup_dir', 'cancel_backup', 'save_backup_config', 'set_backup_config',
  'set_local_backup_limit', 'save_local_backup_limit',
  'start', 'start_server', 'stop', 'stop_server', 'restart', 'restart_server', 'kill', 'kill_server',
  'command', 'send_command',
  'save_properties', 'set_properties', 'set_motd', 'set_server_icon', 'set_icon', 'set_eula',
  'set_server_ram', 'set_server_startup', 'set_server_meta', 'reinstall_server',
  'change_subdomain', 'release_subdomain', 'generate_subdomain', 'regenerate_subdomain', 'regenerate_ip',
  'set_custom_subdomain', 'start_expose', 'stop_expose', 'start_tunnel', 'stop_tunnel', 'set_networking_settings',
  'create_dns_subdomain', 'delete_dns_subdomain',
  'update_status_settings', 'set_status_page_settings', 'save_status_config',
  'op', 'op_player', 'deop', 'deop_player', 'kick', 'kick_player', 'ban', 'ban_player', 'unban', 'unban_player',
  'whitelist_add', 'whitelist_remove', 'whitelist_on', 'whitelist_off', 'player_action',
  'schedule_add', 'schedule_delete', 'schedule_toggle', 'schedule_save', 'delete_schedule',
  'run_schedule_now', 'schedule_logs_clear', 'create_schedule', 'update_schedule',
  'rename_server',
  'delete_chunks', 'delete_regions', 'trim_world', 'reset_dimension', 'delete_world',
  'start_map_watcher', 'stop_map_watcher', 'render_map', 'force_map_refresh',
  'import_server', 'import_world_start', 'install_spark', 'upload_mclogs', 'freeze_server'
]);

const BACKUP_LOCKED_ACTIONS = new Set([
  ...FROZEN_BLOCKED_ACTIONS,
  'delete_server',
  'unfreeze_server',
  'generate_status_id'
]);
BACKUP_LOCKED_ACTIONS.delete('cancel_backup');

async function handleClientMessage(channel: any, message: string, transfers: Map<string, any>) {
  try {
    const payload = JSON.parse(message);
    // Normalize server name field — client sends `server`, daemon expects `name`.
    // Do not overwrite payload.name if this is a file upload or player detail action where `name` is the file or player name.
    const isNameNonServerAction = payload.action === 'upload_start' || payload.action === 'get_player_detail';
    if (!payload.name && payload.server) payload.name = payload.server;
    if (!payload.name && payload.serverName) payload.name = payload.serverName;
    if (!payload.server && payload.name && !isNameNonServerAction) payload.server = payload.name;
    if (!payload.oldName && (payload.server || payload.name)) payload.oldName = payload.server ?? payload.name;
    console.log(`[WebRTC] Incoming Action: ${payload.action}`, payload);

    const peerUid = channelUserMap.get(channel) || currentOwnerUid;
    if (peerUid && peerUid !== currentOwnerUid) {
      if (!checkPeerActionAllowed(peerUid, payload)) {
        channel.send(JSON.stringify({ type: 'error', message: 'Permission denied for this action.' }));
        return;
      }
    }

    // Accurately resolve target server name across all action variants
    const targetServer = payload.action === 'rename_server'
      ? (payload.oldName || payload.server || payload.serverName || payload.name)
      : (payload.server || payload.serverName || (isNameNonServerAction ? undefined : payload.name) || payload.oldName);

    if (targetServer) {
      let targetMeta = getServerMeta(targetServer);
      if (!targetMeta) {
        targetMeta = listServers().find(s => s.name.toLowerCase() === String(targetServer).toLowerCase()) || null;
      }
      if (targetMeta?.isFrozen && FROZEN_BLOCKED_ACTIONS.has(payload.action)) {
        channel.send(JSON.stringify({
          type: 'error',
          message: `Server "${targetServer}" is frozen in cold storage. Mutating actions (file writes, deletes, uploads, backups, plugins, mods, player management) are disabled. Unfreeze the server first.`
        }));
        return;
      }

      const isReadOnlyTrashList = payload.action === 'trash_action' && payload.trashAction === 'list';

      if (isServerBackupActive(String(targetServer))) {
        if (!isReadOnlyTrashList && BACKUP_LOCKED_ACTIONS.has(payload.action)) {
          channel.send(JSON.stringify({
            type: 'error',
            code: 'SERVER_BUSY_BACKUP',
            preserveBackupState: true,
            message: `Server "${targetServer}" is currently ${activeBackupState.status} a backup (${activeBackupState.progress}%). All actions are disabled until it finishes or is cancelled.`
          }));
          return;
        }
      }

      if (isServerFileUploadActive(String(targetServer))) {
        const isUploadLifecycleAction =
          payload.action === 'upload_start' ||
          payload.action === 'upload_chunk' ||
          payload.action === 'upload_finish' ||
          payload.action === 'cancel_upload';
        if (!isUploadLifecycleAction && !isReadOnlyTrashList && BACKUP_LOCKED_ACTIONS.has(payload.action)) {
          channel.send(JSON.stringify({
            type: 'error',
            code: 'SERVER_BUSY_UPLOAD',
            preserveBackupState: true,
            message: `Server "${targetServer}" has an active file upload in progress. All actions are disabled until the upload finishes or is cancelled.`
          }));
          return;
        }
      }
    }
    switch (payload.action) {
      case 'ping': {
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
            
            // Auto Expose check (enabled by default for all servers - auto-generate subdomain if missing)
            if (!targetServer.subdomain) {
              const usedSubs = new Set(
                listServers()
                  .map(s => s.subdomain?.toLowerCase())
                  .filter((s): s is string => Boolean(s))
              );
              targetServer.subdomain = generateRandomSubdomain(usedSubs);
              targetServer.autoExpose = true;
              if (!targetServer.statusId || targetServer.statusId === targetServer.subdomain) {
                targetServer.statusId = slugifyServerName(targetServer.name);
              }
              saveServerMeta(targetServer);
            } else if (!targetServer.statusId || targetServer.statusId === targetServer.subdomain) {
              targetServer.statusId = slugifyServerName(targetServer.name);
              saveServerMeta(targetServer);
            }

            if (targetServer.autoExpose !== false && targetServer.subdomain) {
              console.log(`[WebRTC] Triggering auto-exposure for ${name} on subdomain ${targetServer.subdomain}`);
              startExpose(name, targetServer.port, targetServer.subdomain, (event) => {
                if (channel.readyState === 'open') {
                  channel.send(JSON.stringify({ ...event, serverName: name }));
                }
                if (event.type === 'tunnel_active' || event.type === 'tunnel_claim_needed' || event.type === 'tunnel_error') {
                  void sendServersList(channel);
                }
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
        const { serverName } = payload;
        const meta = getServerMeta(serverName);
        if (meta) {
          meta.statusId = slugifyServerName(meta.name);
          saveServerMeta(meta);
          channel.send(JSON.stringify({ action: 'status_id_generated', serverName, statusId: meta.statusId }));
        } else {
          channel.send(JSON.stringify({ action: 'error', message: `Server "${serverName}" not found` }));
        }
        break;
      }

      case 'set_status_page_settings': {
        const { serverName, ...settings } = payload;
        const meta = serverName ? getServerMeta(serverName) : null;
        if (meta) {
          if (settings.showIp !== undefined) meta.statusPageShowIp = Boolean(settings.showIp);
          if (settings.isPublic !== undefined) meta.isPublic = Boolean(settings.isPublic);
          if (settings.theme !== undefined) meta.statusPageTheme = String(settings.theme);
          if (settings.description !== undefined) meta.statusPageDescription = String(settings.description);
          if (settings.subdomain) {
            meta.subdomain = String(settings.subdomain).trim().toLowerCase();
          }
          if (!meta.statusId || meta.statusId === meta.subdomain) {
            meta.statusId = slugifyServerName(meta.name);
          }
          saveServerMeta(meta);

          // Immediately push to Firestore
          try {
            void updateAllServerStatusPages();
          } catch {}

          channel.send(JSON.stringify({ type: 'action_success', action: 'Status page settings saved', serverName }));
          await sendServersList(channel);
        } else {
          channel.send(JSON.stringify({ type: 'error', message: `Server "${serverName}" not found` }));
        }
        break;
      }

      case 'create_server': {
        try {
          const serverOpts = payload.serverOpts || {};
          console.log('[WebRTC] Handling create_server action with opts:', serverOpts);

          if (!serverOpts.name || !isValidServerName(serverOpts.name)) {
            channel.send(JSON.stringify({
              type: 'error',
              message: `Creation failed: Invalid server name "${serverOpts?.name || ''}". Names must be 1-32 alphanumeric characters, dashes, or underscores.`
            }));
            break;
          }
          if (serverExists(serverOpts.name)) {
            channel.send(JSON.stringify({
              type: 'error',
              message: `Creation failed: Server "${serverOpts.name}" already exists.`
            }));
            break;
          }

          try {
            channel.send(JSON.stringify({
              type: 'install_progress',
              progress: { stage: 'creating', progress: 5, message: 'Starting installer on daemon...' }
            }));
          } catch (sendErr) {
            console.warn('[WebRTC] Could not send initial install_progress:', sendErr);
          }

          const defaultPortStart = String(serverOpts.type || '').toLowerCase() === 'bedrock' ? 19132 : 25565;
          const port = serverOpts.port || getNextAvailablePort(defaultPortStart);
          const usedSubdomains = new Set(
            listServers()
              .map(s => s.subdomain?.toLowerCase())
              .filter((s): s is string => Boolean(s))
          );
          const assignedSubdomain =
            serverOpts.subdomain && isValidSubdomain(String(serverOpts.subdomain).trim().toLowerCase())
              ? String(serverOpts.subdomain).trim().toLowerCase()
              : generateRandomSubdomain(usedSubdomains);

          const meta = {
            ...serverOpts,
            port,
            createdAt: new Date().toISOString(),
            statusId: assignedSubdomain,
            subdomain: assignedSubdomain,
            autoExpose: serverOpts.autoExpose ?? true,
          };
          
          await installServer(meta, (progress) => {
            console.log('[WebRTC] installServer progress:', progress);
            try {
              if (channel.readyState === 'open') {
                channel.send(JSON.stringify({ type: 'install_progress', progress }));
              }
            } catch (sendErr) {
              console.warn('[WebRTC] Could not send install_progress:', sendErr);
            }
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

          try {
            await sendServersList(channel);
          } catch (listErr) {
            console.warn('[WebRTC] Could not send servers list post-install:', listErr);
          }
        } catch (err: any) {
          console.error('[WebRTC] create_server failed:', err);
          try {
            channel.send(JSON.stringify({ type: 'error', message: `Creation failed: ${err.message || err}` }));
          } catch {}
        }
        break;
      }

      case 'stop_server': {
        stopServer(payload.name);
        await stopExpose(payload.name).catch(() => {});
        channel.send(JSON.stringify({ type: 'tunnel_stopped', serverName: payload.name }));
        await sendServersList(channel);
        break;
      }

      case 'kill_server': {
        killServer(payload.name);
        await stopExpose(payload.name).catch(() => {});
        channel.send(JSON.stringify({ type: 'tunnel_stopped', serverName: payload.name }));
        await sendServersList(channel);
        break;
      }

      case 'delete_server': {
        const { name } = payload;
        if (isRunning(name)) killServer(name);
        // Auto-delete DNS for tunnel if server had one
        const meta = getServerMeta(name);
        const tunnelState = getTunnelState(name);
        const subToCleanup = tunnelState?.subdomain || meta?.subdomain;
        await stopExpose(name, subToCleanup).catch(console.error);

        // Purge local backups
        try {
          const backupsDir = getLocalBackupsDir(name);
          if (fs.existsSync(backupsDir)) {
            fs.rmSync(backupsDir, { recursive: true, force: true });
            console.log(`[WebRTC] Purged local backups directory for "${name}"`);
          }
        } catch (err) {
          console.warn('[WebRTC] Error deleting local backups:', err);
        }

        // Purge cloud backups in BackupHub
        try {
          const { backupServerUrl, backupToken } = loadBackupConfig();
          const daemonId = getDaemonId();
          if (backupServerUrl && backupToken) {
            await fetch(`${backupServerUrl}/api/backup/server`, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${backupToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ nodeId: daemonId, serverId: name }),
            });
            console.log(`[WebRTC] Successfully requested BackupHub to purge all cloud backups for "${name}"`);
          }
        } catch (hubErr) {
          console.warn('[WebRTC] BackupHub cloud backup purge notice:', hubErr);
        }

        deleteServer(name);
        await sendServersList(channel);
        channel.send(JSON.stringify({ type: 'action_success', action: `Server ${name} deleted successfully` }));
        break;
      }

      case 'freeze_server': {
        const server = payload.server || payload.name;
        const meta = getServerMeta(server);
        if (!meta) {
          channel.send(JSON.stringify({ type: 'error', message: `Server "${server}" not found` }));
          break;
        }
        if (meta.isFrozen) {
          channel.send(JSON.stringify({ type: 'error', message: `Server "${server}" is already frozen` }));
          break;
        }

        try {
          channel.send(JSON.stringify({ type: 'action_info', action: `Freezing server "${server}"... stopping processes.` }));

          // 1. Stop if running
          if (isRunning(server)) {
            killServer(server);
            await waitForServerStop(server).catch(() => {});
          }

          // 2. Stop expose / tunnel
          const tunnelState = getTunnelState(server);
          const subToCleanup = tunnelState?.subdomain || meta?.subdomain;
          await stopExpose(server, subToCleanup).catch(() => {});

          // Release subdomain from DNS & Broker so others can claim it
          if (meta.subdomain) {
            try {
              await deleteTunnelDns(meta.subdomain);
            } catch (dnsErr) {
              console.warn('[FREEZE] Error deleting DNS for subdomain:', dnsErr);
            }
            meta.previousSubdomain = meta.subdomain;
            delete meta.subdomain;
            saveServerMeta(meta);
          }

          // Terminate any active in-flight transfers targeting this server
          const activeServerDir = getServerDir(server);
          for (const [sId, t] of transfers.entries()) {
            if (t?.path && (t.path === activeServerDir || t.path.startsWith(activeServerDir + path.sep) || t.path.startsWith(activeServerDir + '/'))) {
              try { t.writeStream?.end(); } catch {}
              transfers.delete(sId);
            }
          }

          // 3. Purge all local backups
          const backupsDir = getLocalBackupsDir(server);
          if (fs.existsSync(backupsDir)) {
            try {
              fs.rmSync(backupsDir, { recursive: true, force: true });
            } catch (delErr) {
              console.warn('[FREEZE] Error purging local backups:', delErr);
            }
          }

          // 4. Purge all cloud backups in BackupHub
          const { backupServerUrl, backupToken } = loadBackupConfig();
          const daemonId = getDaemonId();
          if (backupServerUrl && backupToken) {
            try {
              await fetch(`${backupServerUrl}/api/backup/server`, {
                method: 'DELETE',
                headers: {
                  'Authorization': `Bearer ${backupToken}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ nodeId: daemonId, serverId: server }),
              });
              console.log(`[FREEZE] Purged cloud backups from BackupHub for "${server}"`);
            } catch (hubErr) {
              console.warn('[FREEZE] BackupHub purge notice:', hubErr);
            }
          }

          // 5. Compress server directory into frozen_archive.zip
          const serverDir = getServerDir(server);
          const tempArchive = path.join(os.tmpdir(), `void_freeze_${server}_${Date.now()}.zip`);
          const finalArchive = path.join(serverDir, 'frozen_archive.zip');

          channel.send(JSON.stringify({ type: 'action_info', action: `Compressing files for "${server}"...` }));
          await compressFolder(serverDir, tempArchive, undefined, undefined, backupsDir);

          if (!fs.existsSync(tempArchive) || fs.statSync(tempArchive).size === 0) {
            throw new Error('Compression failed: output archive is missing or empty.');
          }

          // Move temp archive to server folder safely across drives (handles EXDEV)
          try {
            fs.renameSync(tempArchive, finalArchive);
          } catch (mvErr: any) {
            if (mvErr.code === 'EXDEV' || String(mvErr?.message || '').includes('cross-device')) {
              fs.copyFileSync(tempArchive, finalArchive);
              try { fs.unlinkSync(tempArchive); } catch {}
            } else {
              throw mvErr;
            }
          }

          if (!fs.existsSync(finalArchive) || fs.statSync(finalArchive).size === 0) {
            throw new Error('Failed to verify frozen archive in server directory.');
          }

          const archiveStat = fs.statSync(finalArchive);

          // Only after the archive is safely verified, delete files in serverDir EXCEPT meta.json and frozen_archive.zip
          const entries = fs.readdirSync(serverDir);
          for (const entry of entries) {
            if (entry === 'meta.json' || entry === 'frozen_archive.zip') continue;
            const fullP = path.join(serverDir, entry);
            try {
              fs.rmSync(fullP, { recursive: true, force: true });
            } catch (delErr) {
              console.warn(`[FREEZE] Could not remove file during freeze: ${entry}`, delErr);
            }
          }

          meta.isFrozen = true;
          meta.frozenAt = Date.now();
          meta.frozenArchiveSize = archiveStat.size;
          saveServerMeta(meta);

          // Update status page immediately to reflect frozen state
          await setServerFrozenStatus(meta).catch(() => {});

          invalidateServerDiskCache(server);
          await sendServersList(channel);
          channel.send(JSON.stringify({
            type: 'freeze_server_success',
            server,
            archiveSize: archiveStat.size,
          }));
          channel.send(JSON.stringify({
            type: 'action_success',
            action: `Server "${server}" is now FROZEN. Storage compressed, network IP released, and all backups purged.`,
          }));
        } catch (err: any) {
          console.error(`[FREEZE] Server freeze failed:`, err);
          channel.send(JSON.stringify({ type: 'error', message: `Freeze failed: ${err.message}` }));
        }
        break;
      }

      case 'unfreeze_server': {
        const server = payload.server || payload.name;
        const meta = getServerMeta(server);
        if (!meta) {
          channel.send(JSON.stringify({ type: 'error', message: `Server "${server}" not found` }));
          break;
        }
        if (!meta.isFrozen) {
          channel.send(JSON.stringify({ type: 'error', message: `Server "${server}" is not frozen` }));
          break;
        }

        const serverDir = getServerDir(server);
        const archivePath = path.join(serverDir, 'frozen_archive.zip');
        if (!fs.existsSync(archivePath)) {
          channel.send(JSON.stringify({ type: 'error', message: 'Frozen archive file (frozen_archive.zip) not found on host machine!' }));
          break;
        }

        try {
          channel.send(JSON.stringify({ type: 'action_info', action: `Unfreezing "${server}"... extracting files.` }));
          await extractArchive(archivePath, serverDir);
          try {
            fs.unlinkSync(archivePath);
          } catch {}

          meta.isFrozen = false;
          delete meta.frozenAt;
          delete meta.frozenArchiveSize;
          delete meta.previousSubdomain;

          if (!meta.subdomain) {
            const used = new Set(listServers().map(s => s.subdomain?.toLowerCase()).filter(Boolean) as string[]);
            meta.subdomain = generateRandomSubdomain(used);
            meta.statusId = slugifyServerName(meta.name);
          }
          saveServerMeta(meta);

          invalidateServerDiskCache(server);
          await sendServersList(channel);
          await updateAllServerStatusPages().catch(() => {});

          channel.send(JSON.stringify({
            type: 'unfreeze_server_success',
            server,
          }));
          channel.send(JSON.stringify({
            type: 'action_success',
            action: `Server "${server}" successfully unfrozen and restored!`,
          }));
        } catch (err: any) {
          console.error(`[UNFREEZE] Server unfreeze failed:`, err);
          channel.send(JSON.stringify({ type: 'error', message: `Unfreeze failed: ${err.message}` }));
        }
        break;
      }

      case 'start_tunnel': {
        const { serverName, subdomain } = payload;
        const server = listServers().find(s => s.name === serverName);
        if (!server) {
          channel.send(JSON.stringify({ type: 'error', message: `Server "${serverName}" not found` }));
          break;
        }
        const chosenSubdomain =
          (subdomain && String(subdomain).trim().toLowerCase()) ||
          server.subdomain ||
          generateRandomSubdomain();

        if (!isValidSubdomain(chosenSubdomain)) {
          channel.send(JSON.stringify({ type: 'error', message: 'Invalid subdomain format' }));
          break;
        }

        server.subdomain = chosenSubdomain;
        server.autoExpose = true;
        saveServerMeta(server);

        startExpose(serverName, server.port, chosenSubdomain, (event) => {
          if (channel.readyState === 'open') {
            channel.send(JSON.stringify({ ...event, serverName }));
          }
          if (event.type === 'tunnel_active' || event.type === 'tunnel_claim_needed' || event.type === 'tunnel_error') {
            void sendServersList(channel);
          }
        }).catch(err => {
          console.error('[WebRTC] startExpose Error:', err);
          if (channel.readyState === 'open') {
            channel.send(JSON.stringify({ type: 'tunnel_error', serverName, payload: { message: err.message } }));
          }
        });
        await sendServersList(channel);
        break;
      }

      case 'stop_tunnel': {
        const { serverName, subdomain } = payload;
        await stopExpose(serverName, subdomain);
        channel.send(JSON.stringify({ type: 'tunnel_stopped', serverName }));
        await sendServersList(channel);
        break;
      }

      case 'regenerate_subdomain': {
        const serverName = payload.serverName || payload.name;
        const meta = serverName ? getServerMeta(serverName) : null;
        if (!meta) {
          channel.send(JSON.stringify({ type: 'error', message: `Server "${serverName || ''}" not found` }));
          break;
        }

        const oldSubdomain = meta.subdomain;
        const usedSubs = new Set(
          listServers()
            .map(s => s.subdomain?.toLowerCase())
            .filter((s): s is string => Boolean(s))
        );
        if (oldSubdomain) usedSubs.add(oldSubdomain.toLowerCase());

        const newSubdomain = generateRandomSubdomain(usedSubs);
        meta.subdomain = newSubdomain;
        meta.autoExpose = true;
        saveServerMeta(meta);

        const wasExposed = Boolean(getTunnelState(meta.name));
        const runningNow = isRunning(meta.name);

        if (wasExposed) {
          await stopExpose(meta.name, oldSubdomain).catch(() => {});
        } else if (oldSubdomain) {
          void deleteTunnelDns(oldSubdomain);
        }

        const newDomain = `${newSubdomain}.${VOID_DOMAIN}`;
        channel.send(JSON.stringify({
          type: 'subdomain_regenerated',
          serverName: meta.name,
          subdomain: newSubdomain,
          domain: newDomain,
        }));
        channel.send(JSON.stringify({
          type: 'action_success',
          action: `New server IP assigned: ${newDomain}`,
        }));

        if (wasExposed || runningNow) {
          startExpose(meta.name, meta.port, newSubdomain, (event) => {
            if (channel.readyState === 'open') {
              channel.send(JSON.stringify({ ...event, serverName: meta.name }));
            }
            if (event.type === 'tunnel_active' || event.type === 'tunnel_claim_needed' || event.type === 'tunnel_error') {
              void sendServersList(channel);
            }
          }).catch(console.error);
        }

        await sendServersList(channel);
        break;
      }

      case 'set_custom_subdomain': {
        const serverName = payload.serverName || payload.name;
        const meta = serverName ? getServerMeta(serverName) : null;
        if (!meta) {
          channel.send(JSON.stringify({ type: 'error', message: `Server "${serverName || ''}" not found` }));
          break;
        }

        const rawSub = String(payload.subdomain || '').trim().toLowerCase();
        if (containsDisallowedWords(rawSub)) {
          channel.send(JSON.stringify({ type: 'error', message: 'This subdomain contains disallowed or sensitive words.' }));
          break;
        }
        if (!isValidSubdomain(rawSub)) {
          channel.send(JSON.stringify({ type: 'error', message: 'Invalid subdomain format' }));
          break;
        }

        const oldSubdomain = meta.subdomain;
        meta.subdomain = rawSub;
        if (!meta.statusId || meta.statusId === oldSubdomain) {
          meta.statusId = slugifyServerName(meta.name);
        }
        saveServerMeta(meta);

        const wasExposed = Boolean(getTunnelState(meta.name));
        const runningNow = isRunning(meta.name);

        if (wasExposed) {
          await stopExpose(meta.name, oldSubdomain).catch(() => {});
        } else if (oldSubdomain && oldSubdomain !== rawSub) {
          void deleteTunnelDns(oldSubdomain);
        }

        // Only create DNS / tunnel if server is actively running!
        if (runningNow) {
          startExpose(meta.name, meta.port, rawSub, (event) => {
            if (channel.readyState === 'open') {
              channel.send(JSON.stringify({ ...event, serverName: meta.name }));
            }
            if (event.type === 'tunnel_active' || event.type === 'tunnel_claim_needed' || event.type === 'tunnel_error') {
              void sendServersList(channel);
            }
          }).catch(console.error);
        }

        const newDomain = `${rawSub}.${VOID_DOMAIN}`;
        channel.send(JSON.stringify({
          type: 'subdomain_regenerated',
          serverName: meta.name,
          subdomain: rawSub,
          domain: newDomain,
        }));
        channel.send(JSON.stringify({
          type: 'action_success',
          action: `Server address prefix updated to "${rawSub}"${runningNow ? '' : ' (will activate when server is started)'}`,
        }));

        await sendServersList(channel);
        break;
      }

      case 'set_server_meta': {
        const { serverName, autoRestart, ...otherMeta } = payload;
        const meta = serverName ? getServerMeta(serverName) : null;
        if (meta) {
          if (autoRestart !== undefined) meta.autoRestart = Boolean(autoRestart);
          Object.assign(meta, otherMeta);
          saveServerMeta(meta);
          await sendServersList(channel);
          channel.send(JSON.stringify({ type: 'action_success', action: 'Server configuration saved' }));
        }
        break;
      }

      case 'set_networking_settings': {
        const { serverName, autoExpose, subdomain } = payload;
        const meta = getServerMeta(serverName);
        if (meta) {
          meta.autoExpose = autoExpose;
          if (subdomain) {
            const cleanSub = String(subdomain).trim().toLowerCase();
            if (containsDisallowedWords(cleanSub)) {
              channel.send(JSON.stringify({ type: 'error', message: 'This subdomain contains disallowed or sensitive words.' }));
              break;
            }
            if (!isValidSubdomain(cleanSub)) {
              channel.send(JSON.stringify({ type: 'error', message: 'Invalid subdomain format' }));
              break;
            }
            meta.subdomain = cleanSub;
          }
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
        try {
          const [vanillaRes, paperRes, fabricRes, forgeRes, purpurRes, neoforgeRes, quiltRes, arclightRaw, bedrockRes] = await Promise.all([
            getVanillaReleases().then(v => v.map(x => x.id)).catch(() => [] as string[]),
            getPaperVersions().catch(() => [] as string[]),
            getFabricGameVersions(50).catch(() => [] as string[]),
            getForgeGameVersions(50).catch(() => [] as string[]),
            getPurpurVersions().catch(() => [] as string[]),
            getNeoForgeGameVersions(50).catch(() => [] as string[]),
            getQuiltGameVersions(50).catch(() => [] as string[]),
            getArclightVersions().catch(() => []),
            getBedrockVersions().catch(() => [] as string[]),
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
          const bedrock = Array.isArray(bedrockRes) && bedrockRes.length > 0
            ? bedrockRes
            : ['1.21.62.01', '1.21.61.01', '1.21.60.10'];

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
            bedrock: bedrock.slice(0, 50),
          }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Fetch failed: ${err.message}` }));
        }
        break;
      }

      case 'get_platform_versions': {
        const { platform } = payload;
        try {
          let versions: string[] = [];
          if (platform === 'paper') {
            versions = await getPaperVersions();
          } else if (platform === 'purpur') {
            versions = await getPurpurVersions();
          } else if (platform === 'fabric') {
            versions = await getFabricGameVersions(200);
          } else if (platform === 'vanilla') {
            versions = (await getVanillaReleases()).map(x => x.id);
          } else if (platform === 'forge') {
            versions = await getForgeGameVersions(200);
          } else if (platform === 'neoforge') {
            versions = await getNeoForgeGameVersions(200);
          } else if (platform === 'quilt') {
            versions = await getQuiltGameVersions(200);
          } else if (platform === 'arclight') {
            const raw = await getArclightVersions();
            versions = Array.from(new Set(raw.map(v => v.version)));
            if (versions.length === 0) {
              versions = ['1.21.1', '1.20.4', '1.20.1', '1.19.2', '1.18.2', '1.16.5'];
            }
          } else if (platform === 'bedrock') {
            versions = await getBedrockVersions();
          } else {
            const [vanillaRes, paperRes, fabricRes, forgeRes, purpurRes, neoforgeRes, quiltRes, arclightRaw, bedrockRes] = await Promise.all([
              getVanillaReleases().then(v => v.map(x => x.id)).catch(() => [] as string[]),
              getPaperVersions().catch(() => [] as string[]),
              getFabricGameVersions(200).catch(() => [] as string[]),
              getForgeGameVersions(200).catch(() => [] as string[]),
              getPurpurVersions().catch(() => [] as string[]),
              getNeoForgeGameVersions(200).catch(() => [] as string[]),
              getQuiltGameVersions(200).catch(() => [] as string[]),
              getArclightVersions().catch(() => []),
              getBedrockVersions().catch(() => [] as string[]),
            ]);
            const arclightExtracted = Array.from(new Set(arclightRaw.map(v => v.version)));
            channel.send(JSON.stringify({
              type: 'platform_versions',
              manifest: {
                vanilla: vanillaRes,
                paper: paperRes,
                fabric: fabricRes,
                forge: forgeRes,
                purpur: purpurRes,
                neoforge: neoforgeRes,
                quilt: quiltRes,
                arclight: arclightExtracted.length > 0 ? arclightExtracted : ['1.21.1', '1.20.4', '1.20.1', '1.19.2', '1.18.2', '1.16.5'],
                bedrock: bedrockRes,
              }
            }));
            break;
          }

          channel.send(JSON.stringify({
            type: 'platform_versions',
            platform,
            versions,
          }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Fetch platform versions failed: ${err.message}` }));
        }
        break;
      }

      case 'reinstall_server': {
        const { server, platform, version, build, retentionScope, createBackup } = payload;
        const targetServer = server || payload.name;
        if (!targetServer || !platform || !version) {
          channel.send(JSON.stringify({ type: 'error', message: 'Missing server name, platform, or version for reinstallation.' }));
          break;
        }

        try {
          console.log(`[WebRTC] Reinstalling server "${targetServer}" to ${platform} ${version} (retention: ${retentionScope || 'in_place'})...`);
          try {
            channel.send(JSON.stringify({
              type: 'reinstall_progress',
              server: targetServer,
              stage: 'creating',
              progress: 2,
              message: 'Daemon accepted reinstallation request...',
            }));
          } catch {}
          await reinstallServer(
            {
              serverName: targetServer,
              type: platform,
              version,
              build: typeof build === 'number' ? build : undefined,
              retentionScope: retentionScope || 'in_place',
              createBackup: createBackup !== false,
            },
            (p) => {
              try {
                channel.send(JSON.stringify({
                  type: 'reinstall_progress',
                  server: targetServer,
                  stage: p.stage,
                  progress: p.progress,
                  message: p.message,
                  error: p.error,
                }));
              } catch {}
            }
          );

          channel.send(JSON.stringify({
            type: 'reinstall_complete',
            server: targetServer,
            success: true,
            platform,
            version,
          }));

          await broadcastServersList();
        } catch (err: any) {
          console.error(`[WebRTC] Reinstallation failed for ${targetServer}:`, err);
          channel.send(JSON.stringify({
            type: 'reinstall_complete',
            server: targetServer,
            success: false,
            error: err?.message || String(err),
          }));
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
          case 'gamemode':
            if (isOnline) sendCommand(server, `gamemode ${payload.gamemode || 'survival'} ${player}`);
            break;
          case 'kill':
            if (isOnline) sendCommand(server, `kill ${player}`);
            break;
          case 'hit':
            if (isOnline) {
              sendCommand(server, `damage ${player} ${payload.amount || 4}`);
            }
            break;
          case 'heal':
            if (isOnline) {
              sendCommand(server, `effect give ${player} minecraft:instant_health 1 255 true`);
              sendCommand(server, `effect give ${player} minecraft:saturation 1 255 true`);
            }
            break;
          case 'feed':
            if (isOnline) sendCommand(server, `effect give ${player} minecraft:saturation 1 255 true`);
            break;
          case 'starve':
            if (isOnline) sendCommand(server, `effect give ${player} minecraft:hunger 15 255 true`);
            break;
          case 'add_xp':
            if (isOnline) sendCommand(server, `xp add ${player} ${payload.amount || 1} levels`);
            break;
          case 'set_level':
            if (isOnline) sendCommand(server, `experience set ${player} ${payload.level || 0} levels`);
            break;
          case 'clear':
            if (isOnline) sendCommand(server, `clear ${player}`);
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

          if (payload.uuid) {
            try {
              const detail = await getPlayerDetail(server, payload.uuid, player);
              channel.send(JSON.stringify({ type: 'player_detail', server, uuid: payload.uuid, detail }));
            } catch {}
          }
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
          received: 0,
          server
        });
        registerActiveFileUpload(server, sessionId);

        channel.send(JSON.stringify({ type: 'upload_ready', sessionId, name, size }));
        break;
      }

      case 'cancel_upload': {
        const { server, sessionId } = payload;
        if (sessionId && transfers.has(sessionId)) {
          const transfer = transfers.get(sessionId);
          try { transfer?.writeStream?.destroy(); } catch {}
          try {
            if (transfer?.path && fs.existsSync(transfer.path)) fs.unlinkSync(transfer.path);
          } catch {}
          transfers.delete(sessionId);
          const srvName = transfer?.server || server;
          if (srvName) unregisterActiveFileUpload(srvName, sessionId);
        } else if (server) {
          for (const [sid, transfer] of Array.from(transfers.entries())) {
            if (transfer?.server?.toLowerCase() === String(server).toLowerCase()) {
              try { transfer.writeStream?.destroy(); } catch {}
              try {
                if (transfer.path && fs.existsSync(transfer.path)) fs.unlinkSync(transfer.path);
              } catch {}
              transfers.delete(sid);
              unregisterActiveFileUpload(transfer.server, sid);
            }
          }
          // Ensure any orphaned entries for this server are cleared too
          const leftover = activeFileUploads.get(String(server).toLowerCase());
          if (leftover) {
            for (const sid of Array.from(leftover)) {
              unregisterActiveFileUpload(String(server), sid);
            }
          }
        }
        channel.send(JSON.stringify({ type: 'upload_cancelled', server, sessionId }));
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
              const zip = new AdmZip();
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
          resolveMissingPluginMetadata(server)
            .then((updated) => {
              if (updated && channel.readyState === 'open') {
                channel.send(JSON.stringify({ type: 'plugins_list', server, plugins: listPlugins(server) }));
              }
            })
            .catch(() => {});
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
        const { server, url, fileName, meta } = payload;
        const root = getServerDir(server);
        const pluginsPath = path.join(root, 'plugins');
        const sanitizedFileName = fileName.replace(/[^a-z0-9.-]/gi, '_');
        const targetFileName = sanitizedFileName.endsWith('.jar') ? sanitizedFileName : sanitizedFileName + '.jar';
        const fullPath = path.join(pluginsPath, targetFileName);
        
        try {
          if (!fs.existsSync(pluginsPath)) fs.mkdirSync(pluginsPath, { recursive: true });
          channel.send(JSON.stringify({ type: 'action_info', server, action: `Downloading ${sanitizedFileName}...` }));
          
          const download = (targetUrl: string): Promise<void> => {
            return new Promise((resolve, reject) => {
              https.get(targetUrl, { headers: { 'User-Agent': 'VoidServers/1.0' } }, (res) => {
                if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
                  download(res.headers.location).then(resolve).catch(reject);
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

          if (meta && typeof meta === 'object') {
            savePluginMetadata(
              server,
              targetFileName,
              {
                name: typeof meta.name === 'string' ? meta.name : undefined,
                description: typeof meta.description === 'string' ? meta.description : undefined,
                author: typeof meta.author === 'string' ? meta.author : undefined,
                iconUrl: typeof meta.iconUrl === 'string' ? meta.iconUrl : typeof meta.icon_url === 'string' ? meta.icon_url : undefined,
                version: typeof meta.version === 'string' ? meta.version : undefined,
                source: typeof meta.source === 'string' ? meta.source : undefined,
                projectId: typeof meta.projectId === 'string' ? meta.projectId : typeof meta.id === 'string' ? meta.id : undefined,
              },
              fullPath,
            );
          } else {
            await resolveMissingPluginMetadata(server).catch(() => false);
          }
          
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
          resolveMissingModMetadata(server)
            .then((updated) => {
              if (updated && channel.readyState === 'open') {
                channel.send(JSON.stringify({ type: 'mods_list', server, mods: listMods(server) }));
              }
            })
            .catch(() => {});
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
        const { server, url, fileName, meta } = payload;
        const root = getServerDir(server);
        const modsPath = path.join(root, 'mods');
        const sanitizedFileName = fileName.replace(/[^a-z0-9.-]/gi, '_');
        const targetFileName = sanitizedFileName.endsWith('.jar') ? sanitizedFileName : sanitizedFileName + '.jar';
        const fullPath = path.join(modsPath, targetFileName);

        try {
          if (!fs.existsSync(modsPath)) fs.mkdirSync(modsPath, { recursive: true });
          channel.send(JSON.stringify({ type: 'action_info', server, action: `Downloading ${sanitizedFileName}...` }));

          const download = (targetUrl: string): Promise<void> => {
            return new Promise((resolve, reject) => {
              https.get(targetUrl, { headers: { 'User-Agent': 'VoidServers/1.0' } }, (res) => {
                if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
                  download(res.headers.location).then(resolve).catch(reject);
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

          if (meta && typeof meta === 'object') {
            saveModMetadata(
              server,
              targetFileName,
              {
                name: typeof meta.name === 'string' ? meta.name : undefined,
                description: typeof meta.description === 'string' ? meta.description : undefined,
                author: typeof meta.author === 'string' ? meta.author : undefined,
                iconUrl: typeof meta.iconUrl === 'string' ? meta.iconUrl : typeof meta.icon_url === 'string' ? meta.icon_url : undefined,
                version: typeof meta.version === 'string' ? meta.version : undefined,
                source: typeof meta.source === 'string' ? meta.source : undefined,
                projectId: typeof meta.projectId === 'string' ? meta.projectId : typeof meta.id === 'string' ? meta.id : undefined,
              },
              fullPath,
            );
          } else {
            await resolveMissingModMetadata(server).catch(() => false);
          }

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
          startMapWatcher(server);
          channel.send(JSON.stringify({ type: 'map_watcher_started', server }));
        }
        break;
      }

      case 'stop_map_watcher': {
        const { server } = payload;
        if (server) {
          stopMapWatcher(server);
          channel.send(JSON.stringify({ type: 'map_watcher_stopped', server }));
        }
        break;
      }

      case 'get_map_metadata': {
        const { server } = payload;
        if (server) {
          const meta = getMapMetadata(server);
          channel.send(JSON.stringify({ type: 'map_metadata', server, ...meta }));
        }
        break;
      }

      case 'get_map_tile': {
        const { server, dim, rx, rz, y } = payload;
        if (server) {
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
        const config = loadBackupConfig();
        channel.send(JSON.stringify({ type: 'backup_config', ...config }));
        break;
      }

      case 'save_backup_config': {
        const { backupServerUrl, backupToken } = payload;
        saveBackupConfig({ backupServerUrl, backupToken });
        channel.send(JSON.stringify({ type: 'backup_config_saved', success: true }));
        break;
      }

      case 'list_cloud_backups': {
        const { server } = payload;
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
        if (sendBackupBusyError(channel)) break;
        const { server } = payload;
        const daemonId = getDaemonId();
        const { backupServerUrl, backupToken } = loadBackupConfig();

        if (!backupServerUrl || !backupToken) {
          channel.send(JSON.stringify({ type: 'error', message: 'Backup server URL or authorization token not configured!' }));
          break;
        }

        updateBackupState(server, 'zipping', 0, 'cloud');

        const serverDir = getServerDir(server);
        const backupsDir = getLocalBackupsDir(server);
        const tempZipPath = path.join(os.tmpdir(), `void_backup_${server}_${Date.now()}.zip`);

        const controller = new AbortController();
        registerActiveBackupController(server, controller);

        let fileStream: fs.ReadStream | null = null;
        const onAbort = () => {
          try { fileStream?.destroy(); } catch {}
        };
        controller.signal.addEventListener('abort', onAbort);

        try {
          // Zip the server folder (excluding local backups directory)
          await compressFolder(serverDir, tempZipPath, (percent) => {
            const overallProgress = Math.min(49, Math.max(1, Math.round(percent * 0.5)));
            updateBackupState(server, 'zipping', overallProgress, 'cloud');
          }, controller.signal, backupsDir);

          if (controller.signal.aborted) {
            throw new Error('Backup aborted');
          }

          const stats = fs.statSync(tempZipPath);
          console.log(`[WebRTC Cloud Backup] Zipped size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
          updateBackupState(server, 'uploading', 50, 'cloud');

          // Upload using fetch and stream progress
          fileStream = fs.createReadStream(tempZipPath);
          const streamRef = fileStream;
          const filename = `backup_${Date.now()}.zip`;

          let bytesUploaded = 0;
          const totalBytes = stats.size;

          const progressTrackingStream = new ReadableStream({
            start(streamController) {
              streamRef.pause();
              streamRef.on('data', (chunk: Buffer) => {
                if (controller.signal.aborted) {
                  try { streamRef.destroy(); } catch {}
                  try { streamController.error(new Error('Backup aborted')); } catch {}
                  return;
                }
                bytesUploaded += chunk.length;
                const pct = totalBytes > 0 ? Math.round((bytesUploaded / totalBytes) * 100) : 0;
                const overallProgress = Math.min(99, 50 + Math.round(pct * 0.5));
                updateBackupState(server, 'uploading', overallProgress, 'cloud');
                
                streamController.enqueue(chunk);
                if (streamController.desiredSize !== null && streamController.desiredSize <= 0) {
                  streamRef.pause();
                }
              });
              streamRef.on('end', () => {
                streamController.close();
              });
              streamRef.on('error', (err) => {
                streamController.error(err);
              });
            },
            pull() {
              streamRef.resume();
            },
            cancel() {
              streamRef.destroy();
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
            signal: controller.signal,
            // @ts-ignore
            duplex: 'half'
          });

          // Clean up temp zip file
          if (fs.existsSync(tempZipPath)) {
            try { fs.unlinkSync(tempZipPath); } catch {}
          }

          if (res.status === 507) {
            updateBackupState(server, 'idle', 0, 'idle');
            broadcastToPeers({ 
              type: 'error', 
              message: 'Our backup servers are currently experiencing high traffic. Please try again later.' 
            });
            break;
          }

          if (!res.ok) {
            const errData = (await res.json().catch(() => ({}))) as any;
            const errMsg = errData.error || `Upload failed with status code ${res.status}`;
            console.error('[WebRTC Cloud Backup Error] Server rejected upload:', errMsg);
            updateBackupState(server, 'idle', 0, 'idle');
            broadcastToPeers({ type: 'error', message: errMsg });
            break;
          }

          updateBackupState(server, 'idle', 0, 'idle');
          broadcastToPeers({ type: 'backup_success', server });
        } catch (err: any) {
          if (fs.existsSync(tempZipPath)) {
            try { fs.unlinkSync(tempZipPath); } catch {}
          }
          if (isBackupAbortError(err, controller.signal)) {
            updateBackupState(server, 'idle', 0, 'idle');
            broadcastToPeers({ type: 'action_success', action: 'Backup Cancelled' });
            break;
          }
          console.error('[WebRTC Cloud Backup Error] Exception occurred:', err);
          updateBackupState(server, 'idle', 0, 'idle');
          broadcastToPeers({ 
            type: 'error', 
            message: `Could not connect to backup server: ${err.message}. Our backup servers are currently experiencing high traffic. Please try again later.` 
          });
        } finally {
          controller.signal.removeEventListener('abort', onAbort);
          clearActiveBackupController(server);
        }
        break;
      }

      case 'delete_cloud_backup': {
        const { server, filename } = payload;
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
        if (sendBackupBusyError(channel)) break;
        const { server, filename } = payload;
        const daemonId = getDaemonId();
        const { backupServerUrl, backupToken } = loadBackupConfig();

        if (!backupServerUrl || !backupToken) {
          channel.send(JSON.stringify({ type: 'error', message: 'Backup server URL or authorization token not configured!' }));
          break;
        }

        updateBackupState(server, 'downloading', 0, 'restore_cloud');
        const tempZipPath = path.join(os.tmpdir(), `void_restore_${server}_${Date.now()}.zip`);
        const controller = new AbortController();
        registerActiveBackupController(server, controller);

        try {
          // Download backup file
          const downloadUrl = `${backupServerUrl}/api/backup/download?nodeId=${daemonId}&serverId=${server}&filename=${filename}&token=${backupToken}`;
          const res = await fetch(downloadUrl, { signal: controller.signal });

          if (!res.ok) {
            throw new Error(`Server returned HTTP ${res.status}`);
          }

          const fileStream = fs.createWriteStream(tempZipPath);
          const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
          let bytesDownloaded = 0;

          try {
            // Pipe fetch body stream to file and track progress
            // @ts-ignore
            for await (const chunk of res.body) {
              if (controller.signal.aborted) {
                throw new Error('Backup aborted');
              }
              fileStream.write(chunk);
              bytesDownloaded += chunk.length;
              const pct = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 50;
              const overallProgress = Math.round(pct * 0.9);
              updateBackupState(server, 'downloading', overallProgress, 'restore_cloud');
            }
          } finally {
            fileStream.end();
          }

          if (controller.signal.aborted) {
            throw new Error('Backup aborted');
          }

          // Unzip/Extract backup
          updateBackupState(server, 'extracting', 90, 'restore_cloud');
          const serverDir = getServerDir(server);
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
            try { fs.unlinkSync(tempZipPath); } catch {}
          }
          if (isBackupAbortError(err, controller.signal)) {
            updateBackupState(server, 'idle', 0, 'idle');
            broadcastToPeers({ type: 'action_success', action: 'Backup Cancelled' });
            break;
          }
          updateBackupState(server, 'idle', 0, 'idle');
          channel.send(JSON.stringify({ type: 'error', message: `Restore failed: ${err.message}` }));
        } finally {
          clearActiveBackupController(server);
        }
        break;
      }

      case 'restore_backup': {
        if (sendBackupBusyError(channel)) break;
        const { server, filename, mode, newServerName } = payload;
        const controller = new AbortController();
        registerActiveBackupController(server, controller);
        let finalNewName: string = '';

        try {
          let targetDir: string;
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
            registerActiveBackupController(finalNewName, controller);

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
            const existingSubs = new Set(listServers().map(s => s.subdomain).filter(Boolean) as string[]);
            const newSub = generateRandomSubdomain(existingSubs);
            const newMeta = {
              ...sourceMeta,
              name: finalNewName,
              createdAt: new Date().toISOString(),
              statusId: slugifyServerName(finalNewName),
              subdomain: newSub,
              autoExpose: true,
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
              const daemonId = getDaemonId();
              const { backupServerUrl, backupToken } = loadBackupConfig();
              if (!backupServerUrl || !backupToken) {
                channel.send(JSON.stringify({ type: 'error', message: 'Backup server URL or authorization token not configured!' }));
                break;
              }

              updateBackupState(finalNewName, 'downloading', 0, 'restore_cloud');
              const tempZipPath = path.join(os.tmpdir(), `void_restore_${finalNewName}_${Date.now()}.zip`);
              const downloadUrl = `${backupServerUrl}/api/backup/download?nodeId=${daemonId}&serverId=${server}&filename=${filename}&token=${backupToken}`;
              const res = await fetch(downloadUrl, { signal: controller.signal });
              if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);

              const fileStream = fs.createWriteStream(tempZipPath);
              const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
              let bytesDownloaded = 0;
              try {
                for await (const chunk of (res.body as any)) {
                  if (controller.signal.aborted) {
                    if (fs.existsSync(tempZipPath)) try { fs.unlinkSync(tempZipPath); } catch {}
                    throw new Error('Backup aborted');
                  }
                  fileStream.write(chunk);
                  bytesDownloaded += chunk.length;
                  const pct = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 50;
                  updateBackupState(finalNewName, 'downloading', Math.round(pct * 0.9), 'restore_cloud');
                }
              } finally {
                fileStream.end();
              }

              if (controller.signal.aborted) {
                if (fs.existsSync(tempZipPath)) try { fs.unlinkSync(tempZipPath); } catch {}
                throw new Error('Backup aborted');
              }

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

            // Synchronize meta.json in targetDir with new server's identity & subdomain
            const targetMetaPath = path.join(targetDir, 'meta.json');
            if (fs.existsSync(targetMetaPath)) {
              try {
                const targetMeta = JSON.parse(fs.readFileSync(targetMetaPath, 'utf-8'));
                targetMeta.name = finalNewName;
                targetMeta.subdomain = newMeta.subdomain;
                targetMeta.statusId = newMeta.statusId;
                targetMeta.autoExpose = true;
                targetMeta.createdAt = newMeta.createdAt;
                fs.writeFileSync(targetMetaPath, JSON.stringify(targetMeta, null, 2));
              } catch {}
            } else {
              saveServerMeta(newMeta);
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
              const daemonId = getDaemonId();
              const { backupServerUrl, backupToken } = loadBackupConfig();
              if (!backupServerUrl || !backupToken) {
                channel.send(JSON.stringify({ type: 'error', message: 'Backup server URL or authorization token not configured!' }));
                break;
              }

              updateBackupState(server, 'downloading', 0, 'restore_cloud');
              const tempZipPath = path.join(os.tmpdir(), `void_restore_${server}_${Date.now()}.zip`);
              const downloadUrl = `${backupServerUrl}/api/backup/download?nodeId=${daemonId}&serverId=${server}&filename=${filename}&token=${backupToken}`;
              const res = await fetch(downloadUrl, { signal: controller.signal });
              if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);

              const fileStream = fs.createWriteStream(tempZipPath);
              const totalBytes = parseInt(res.headers.get('content-length') || '0', 10);
              let bytesDownloaded = 0;
              try {
                for await (const chunk of (res.body as any)) {
                  if (controller.signal.aborted) {
                    if (fs.existsSync(tempZipPath)) try { fs.unlinkSync(tempZipPath); } catch {}
                    throw new Error('Backup aborted');
                  }
                  fileStream.write(chunk);
                  bytesDownloaded += chunk.length;
                  const pct = totalBytes > 0 ? Math.round((bytesDownloaded / totalBytes) * 100) : 50;
                  updateBackupState(server, 'downloading', Math.round(pct * 0.9), 'restore_cloud');
                }
              } finally {
                fileStream.end();
              }

              if (controller.signal.aborted) {
                if (fs.existsSync(tempZipPath)) try { fs.unlinkSync(tempZipPath); } catch {}
                throw new Error('Backup aborted');
              }

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
          if (isBackupAbortError(err, controller.signal)) {
            updateBackupState(finalNewName || server, 'idle', 0, 'idle');
            broadcastToPeers({ type: 'action_success', action: 'Backup Cancelled' });
            break;
          }
          updateBackupState(finalNewName || server, 'idle', 0, 'idle');
          channel.send(JSON.stringify({ type: 'error', message: `Restore failed: ${err.message}` }));
        } finally {
          clearActiveBackupController(server);
          if (finalNewName) clearActiveBackupController(finalNewName);
        }
        break;
      }

      case 'get_local_backup_limit': {
        const { server } = payload;
        const meta = server ? getServerMeta(server) : null;
        const limit = (meta && meta.localBackupLimit) ? meta.localBackupLimit : loadLocalBackupLimit();
        channel.send(JSON.stringify({ type: 'local_backup_limit', server, limitEnabled: limit.enabled, limitType: limit.type, limitValue: limit.value }));
        break;
      }

      case 'save_local_backup_limit': {
        const { server, limitEnabled, limitType, limitValue } = payload;
        const newLimit = { enabled: limitEnabled ?? true, type: limitType || 'quantity', value: Number(limitValue) || 3 };
        if (server) {
          const meta = getServerMeta(server);
          if (meta) {
            meta.localBackupLimit = newLimit;
            saveServerMeta(meta);
          }
        } else {
          saveLocalBackupLimit(newLimit);
        }

        channel.send(JSON.stringify({ type: 'local_backup_limit_saved', server, success: true, limitEnabled: newLimit.enabled, limitType: newLimit.type, limitValue: newLimit.value }));
        break;
      }

      case 'list_local_backups': {
        const { server } = payload;
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
        if (sendBackupBusyError(channel)) break;
        const { server } = payload;
        
        const backupsDir = getLocalBackupsDir(server);
        const serverDir = getServerDir(server);
        const meta = server ? getServerMeta(server) : null;
        const limit = (meta && meta.localBackupLimit) ? meta.localBackupLimit : loadLocalBackupLimit();
        
        if (limit.enabled) {
          if (limit.type === 'size_gb') {
            const limitBytes = limit.value * 1024 * 1024 * 1024;
            const serverDirSize = getFastFolderSize(serverDir, backupsDir);
            
            if (serverDirSize > limitBytes) {
              channel.send(JSON.stringify({ type: 'error', message: `Server folder size (${(serverDirSize / (1024*1024*1024)).toFixed(2)} GB) exceeds the total retention limit (${limit.value} GB). Increase limit to create a backup.` }));
              break;
            }
          }
        }
        
        if (!fs.existsSync(backupsDir)) {
          fs.mkdirSync(backupsDir, { recursive: true });
        }

        const backupFilename = `backup_local_${Date.now()}.zip`;
        const finalBackupPath = path.join(backupsDir, backupFilename);
        const tempBackupPath = path.join(backupsDir, `.${backupFilename}.tmp`);
        
        updateBackupState(server, 'zipping', 0, 'local');
        
        const controller = new AbortController();
        activeBackupControllers.set(server, controller);

        try {

          await compressFolder(serverDir, tempBackupPath, (percent) => {
            updateBackupState(server, 'zipping', percent, 'local');
          }, controller.signal, backupsDir);
          
          // Move the complete zip to the local backups directory instantly
          if (fs.existsSync(tempBackupPath)) {
            try {
              fs.renameSync(tempBackupPath, finalBackupPath);
            } catch {
              fs.copyFileSync(tempBackupPath, finalBackupPath);
              fs.unlinkSync(tempBackupPath);
            }
          }
          
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

          updateBackupState(server, 'idle', 0, 'idle');
          invalidateServerDiskCache(server);
          void sendServersList();
          broadcastToPeers({ type: 'local_backup_success', server });
          broadcastToPeers({ type: 'local_backups_list', server, backups });
          activeBackupControllers.delete(server);
        } catch (err: any) {
          activeBackupControllers.delete(server);
          if (fs.existsSync(tempBackupPath)) {
            try { fs.unlinkSync(tempBackupPath); } catch {}
          }
          
          if (err.name === 'AbortError' || err.message === 'Backup aborted') {
            updateBackupState(server, 'idle', 0, 'idle');
            broadcastToPeers({ type: 'action_success', action: 'Backup Cancelled' });
            return;
          }
          
          updateBackupState(server, 'idle', 0, 'idle');
          broadcastToPeers({ type: 'error', message: `Local backup failed: ${err.message}` });
        }
        break;
      }

      case 'cancel_backup': {
        const { server } = payload;
        let controller = server ? activeBackupControllers.get(server) : undefined;
        let matchedKey: string | undefined = server;
        if (!controller && server) {
          for (const [k, c] of activeBackupControllers.entries()) {
            if (k.toLowerCase() === String(server).toLowerCase()) {
              controller = c;
              matchedKey = k;
              break;
            }
          }
        }
        if (controller) {
          controller.abort();
          if (matchedKey) clearActiveBackupController(matchedKey);
        } else if (
          activeBackupState.status !== 'idle' &&
          (!server || activeBackupState.server.toLowerCase() === String(server).toLowerCase())
        ) {
          updateBackupState(activeBackupState.server, 'idle', 0, 'idle');
          broadcastToPeers({ type: 'action_success', action: 'Backup Cancelled' });
        }
        break;
      }

      case 'delete_local_backup': {
        const { server, filename } = payload;
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
        if (sendBackupBusyError(channel)) break;
        const { server, filename } = payload;
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

      case 'get_server_backup_dir': {
        const { server } = payload;
        const meta = getServerMeta(server);
        const defaultDir = path.join(getServerDir(server), 'backups');
        const effectiveDir = (meta?.backupDir && meta.backupDir.trim()) || defaultDir;
        channel.send(JSON.stringify({
          type: 'server_backup_dir',
          server,
          backupDir: meta?.backupDir || null,
          defaultDir,
          effectiveDir,
          defaultBackupDir: defaultDir
        }));
        break;
      }

      case 'set_server_backup_dir': {
        const { server, backupDir } = payload;
        const meta = getServerMeta(server);
        if (meta) {
          meta.backupDir = backupDir ? String(backupDir).trim() : undefined;
          saveServerMeta(meta);
          invalidateServerDiskCache(server);
          void sendServersList();
          const defaultDir = path.join(getServerDir(server), 'backups');
          const effectiveDir = (meta.backupDir && meta.backupDir.trim()) || defaultDir;
          channel.send(JSON.stringify({
            type: 'server_backup_dir_saved',
            server,
            backupDir: meta.backupDir || null,
            defaultDir,
            effectiveDir,
            success: true
          }));
        } else {
          channel.send(JSON.stringify({ type: 'error', message: `Server ${server} not found` }));
        }
        break;
      }

      case 'get_system_drives': {
        try {
          const drives = getSystemDrives();
          channel.send(JSON.stringify({
            type: 'system_drives',
            drives,
            platform: process.platform
          }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Failed to get system drives: ${err.message}` }));
        }
        break;
      }

      case 'browse_directories': {
        const { path: reqPath } = payload;
        try {
          const result = browseHostDirectories(reqPath);
          channel.send(JSON.stringify({
            type: 'browse_directories_result',
            ...result
          }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Browse failed: ${err.message}` }));
        }
        break;
      }

      case 'create_directory': {
        const { parentPath, folderName } = payload;
        try {
          const createdPath = createHostDirectory(parentPath, folderName);
          const result = browseHostDirectories(createdPath);
          channel.send(JSON.stringify({
            type: 'create_directory_result',
            createdPath,
            ...result
          }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Create folder failed: ${err.message}` }));
        }
        break;
      }

      // ── Schedule ────────────────────────────────────────────────────
      case 'schedule_save': {
        const { server, schedules } = payload;
        try {
          saveSchedules(server, schedules || []);
          channel.send(JSON.stringify({ action: 'schedule_save_success', server, schedules: getSchedules(server) }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Schedule save failed: ${err.message}` }));
        }
        break;
      }
      case 'schedule_list': {
        const { server } = payload;
        try {
          const schedules = getSchedules(server);
          channel.send(JSON.stringify({ action: 'schedule_list', server, schedules }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }
      case 'schedule_logs': {
        const { server } = payload;
        try {
          const logs = getScheduleLogs(server);
          channel.send(JSON.stringify({ action: 'schedule_logs', server, logs }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }
      case 'schedule_logs_clear': {
        const { server } = payload;
        try {
          clearScheduleLogs(server);
          channel.send(JSON.stringify({ action: 'schedule_logs_clear_success', server }));
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: err.message }));
        }
        break;
      }
      case 'run_schedule_now': {
        const { server, scheduleId } = payload;
        try {
          const success = await runScheduleNow(server, scheduleId);
          if (success) {
            channel.send(JSON.stringify({ action: 'run_schedule_now_success', server, scheduleId }));
          } else {
            channel.send(JSON.stringify({ type: 'error', message: `Schedule not found or failed to execute` }));
          }
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Run schedule failed: ${err.message}` }));
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

      default: {
        if (payload.action) {
          channel.send(JSON.stringify({
            type: 'error',
            action: payload.action,
            message: `Unsupported daemon action: ${payload.action}`,
          }));
        }
        break;
      }
    }

  } catch (err: any) {
    console.error('[WebRTC] Dispatch Error:', err);
    console.error('[WebRTC] Stack:', err.stack);
    channel.send(JSON.stringify({ type: 'error', message: `Internal dispatcher error: ${err.message}` }));
  }
};
