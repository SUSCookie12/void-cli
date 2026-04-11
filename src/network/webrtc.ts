import { RTCPeerConnection, RTCSessionDescription } from 'werift';
import { collection, query, where, onSnapshot, doc, updateDoc, type Firestore, setDoc } from 'firebase/firestore';
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
  subscribeToAllStatus
} from '../server/instance.js';
import { listServers, deleteServer, renameServer } from '../server/manager.js';
import { readProperties, writeProperties } from '../server/properties.js';
import { getPlayerLists } from '../server/players.js';
import { 
  listEntries, 
  readTextFile, 
  writeTextFile, 
  deleteEntry, 
  createEntry, 
  renameEntry 
} from '../utils/fileExplorer.js';
import { listPlugins, togglePlugin } from '../utils/plugins.js';
import { compressFolder, extractArchive } from '../utils/zipper.js';
import { getServerDir } from '../utils/paths.js';
import { getRunningServers } from '../server/instance.js';
import { startExpose, stopExpose, getTunnelState } from './tunnelManager.js';
import { isValidSubdomain } from './dnsManager.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';

let isInitialized = false;

export function initWebRTCSignaling(uid: string, daemonId: string): () => void {
  if (isInitialized) {
    console.log('[WebRTC] Signaling already active, skipping duplicate initialization.');
    return () => {};
  }
  isInitialized = true;
  const db = getDb();

  // Register node presence
  const nodeRef = doc(db, 'users', uid, 'nodes', daemonId);
  const registerNode = async (status: 'online' | 'offline') => {
    try {
      if (status === 'online') {
        await setDoc(nodeRef, {
          daemonId,
          hostname: os.hostname(),
          status: 'online',
          lastSeen: new Date().toISOString()
        }, { merge: true });
      } else {
        await updateDoc(nodeRef, { status: 'offline' });
      }
    } catch (e) {
      console.error('[WebRTC] Failed to update node presence:', e);
    }
  };

  registerNode('online');
  const heartbeatId = setInterval(() => registerNode('online'), 30000);

  const connectionsRef = collection(db, 'daemon_connections');
  const q = query(
    connectionsRef,
    where('daemonId', '==', daemonId),
    where('status', '==', 'offer')
  );

  const unsubscribe = onSnapshot(q, async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        const data = change.doc.data();
        const docId = change.doc.id;

        if (data.offer && data.status === 'offer') {
          console.log(`[WebRTC] Received offer for node ${daemonId} from ${docId}`);
          try {
            const pc = new RTCPeerConnection({
              iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
            });

            pc.onDataChannel.subscribe((channel) => {
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
                
                import('node:net').then((net) => {
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
                });
                return;
              }
              
              const activeTransfers = new Map<string, {
                writeStream?: fs.WriteStream;
                path: string;
                size: number;
                received: number;
              }>();
              const statsInterval = setInterval(async () => {
                if (channel.readyState === 'open') {
                  const servers = listServers();
                  const statsMap: Record<string, any> = {};
                  for (const s of servers) {
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

              const unsubStatus = subscribeToAllStatus((name, status) => {
                if (channel.readyState === 'open') {
                  const servers = listServers();
                  channel.send(JSON.stringify({ 
                    type: 'servers_list', 
                    servers: servers.map(s => ({ 
                      ...s, 
                      isRunning: isRunning(s.name),
                      status: getServerStatus(s.name)
                    })) 
                  }));
                } else {
                  unsubStatus();
                }
              });

              channel.onMessage.subscribe(async (msgBuf) => {
                if (typeof msgBuf === 'string' || (msgBuf instanceof Buffer && isJson(msgBuf))) {
                  handleClientMessage(channel, msgBuf.toString(), activeTransfers);
                } else {
                  handleBinaryMessage(channel, msgBuf as Buffer, activeTransfers);
                }
              });
            });

            pc.iceConnectionStateChange.subscribe(state => {
              console.log(`[WebRTC] Connection state: ${state}`);
              if (state === 'disconnected' || state === 'failed') pc.close();
            });

            await pc.setRemoteDescription(new RTCSessionDescription(data.offer.sdp, data.offer.type));
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

            const docRef = doc(db, 'daemon_connections', docId);
            await updateDoc(docRef, {
              status: 'answer',
              answer: { type: finalAnswer.type, sdp: finalAnswer.sdp },
            });
            console.log('[WebRTC] Answer sent to Firestore');
          } catch (error) {
            console.error('[WebRTC] Failed to handle offer:', error);
          }
        }
      }
    }
  });

  return () => {
    clearInterval(heartbeatId);
    unsubscribe();
    registerNode('offline');
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

async function sendServersList(channel: any) {
  const localIp = await getLocalIp();
  const servers = listServers();
  const running = getRunningServers();
  const serverData = servers.map(meta => {
    const tunnel = getTunnelState(meta.name);
    return {
      ...meta,
      isRunning: running.includes(meta.name),
      status: getServerStatus(meta.name),
      localIp,
      tunnelAddress: tunnel?.address || null,
      tunnelStatus: tunnel ? 'active' : 'idle',
      tunnelStrategy: tunnel?.strategy || null,
      autoExpose: meta.autoExpose,
      subdomain: meta.subdomain
    };
  });
  channel.send(JSON.stringify({ type: 'servers_list', servers: serverData }));
}

async function handleClientMessage(channel: any, message: string, transfers: Map<string, any>) {
  try {
    const payload = JSON.parse(message);
    console.log(`[WebRTC] Incoming Action: ${payload.action}`, payload);
    switch (payload.action) {
      case 'ping': {
        const os = await import('node:os');
        const { getPublicIp } = await import('./portForwarding.js');
        const publicIp = await getPublicIp();
        
        channel.send(JSON.stringify({ 
          type: 'pong', 
          timestamp: Date.now(),
          system: {
            freeMem: os.freemem(),
            totalMem: os.totalmem(),
            cpuUsage: os.loadavg()[0],
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
      
      case 'create_server': {
        const { serverOpts } = payload;
        const { installServer } = await import('../server/installer.js');
        const { getNextAvailablePort } = await import('../server/manager.js');
        
        try {
          const port = serverOpts.port || getNextAvailablePort();
          const meta = {
            ...serverOpts,
            port,
            createdAt: new Date().toISOString()
          };
          
          await installServer(meta, (progress) => {
            channel.send(JSON.stringify({ type: 'install_progress', progress }));
          });
          
          await sendServersList(channel);
        } catch (err: any) {
          channel.send(JSON.stringify({ type: 'error', message: `Creation failed: ${err.message}` }));
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
        try {
          const vanilla = (await getVanillaReleases()).map(v => v.id);
          const paper = await getPaperVersions();
          channel.send(JSON.stringify({ 
            type: 'versions_manifest', 
            vanilla: vanilla.slice(0, 50), 
            paper: paper.slice(0, 50) 
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
            channel.send(JSON.stringify({ type: 'log', server: payload.name, log }));
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

      case 'get_players':
        const currentPlayers = await getPlayerLists(payload.name);
        currentPlayers.online = getOnlinePlayers(payload.name);
        channel.send(JSON.stringify({ type: 'players_list', server: payload.name, players: currentPlayers }));
        break;

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
        const { server, fileAction, path: targetPath, name, newPath } = payload;
        try {
          switch (fileAction) {
            case 'create_folder':
              createEntry(server, targetPath, true);
              break;
            case 'create_file':
              createEntry(server, targetPath, false);
              break;
            case 'delete':
              deleteEntry(server, targetPath);
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
            extractArchive(fullPath, path.dirname(fullPath));
          } else if (archiveAction === 'compress') {
            const zipPath = fullPath + '.zip';
            const stats = fs.statSync(fullPath);
            if (stats.isDirectory()) {
              compressFolder(fullPath, zipPath);
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
    }
  } catch (err: any) {
    console.error('[WebRTC] Dispatch Error:', err);
    console.error('[WebRTC] Stack:', err.stack);
    channel.send(JSON.stringify({ type: 'error', message: `Internal dispatcher error: ${err.message}` }));
  }
};
