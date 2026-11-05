import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { registerTunnelDns, registerDirectDns, deleteTunnelDns } from './dnsManager.js';
import { tryPortForward, removePortForward, getPublicIp } from './portForwarding.js';

const VOID_DIR = path.join(os.homedir(), '.void');
const BORE_DIR = path.join(VOID_DIR, 'bore');
const BORE_BIN = path.join(BORE_DIR, os.platform() === 'win32' ? 'bore.exe' : 'bore');
const PLAYIT_DIR = path.join(VOID_DIR, 'playit');
const PLAYIT_BIN = path.join(PLAYIT_DIR, os.platform() === 'win32' ? 'playit.exe' : 'playit');

interface TunnelState {
  process?: ChildProcess;
  address?: string;
  claimUrl?: string;
  subdomain: string;
  port: number;
  strategy: 'upnp' | 'bore' | 'playit';
}

const activeExposures = new Map<string, TunnelState>();

async function downloadBore(onProgress?: (msg: string) => void): Promise<void> {
  const platform = os.platform();
  const arch = os.arch();
  let assetName = '';
  
  if (platform === 'win32' && arch === 'x64') assetName = 'bore-v0.6.0-x86_64-pc-windows-msvc.zip';
  else if (platform === 'linux' && arch === 'x64') assetName = 'bore-v0.6.0-x86_64-unknown-linux-musl.tar.gz';
  else throw new Error(`Unsupported platform/arch for bore: ${platform}/${arch}`);

  const url = `https://github.com/ekzhang/bore/releases/download/v0.6.0/${assetName}`;
  onProgress?.('Downloading zero-account tunnel agent (bore)...');

  fs.mkdirSync(BORE_DIR, { recursive: true });
  const archivePath = path.join(BORE_DIR, assetName);

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(archivePath);
    const download = (redirectUrl: string) => {
      https.get(redirectUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return download(res.headers.location!);
        if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        res.pipe(file);
        file.on('finish', async () => {
          file.close();
          try {
            if (assetName.endsWith('.zip')) {

              const zip = new AdmZip(archivePath);
              zip.extractAllTo(BORE_DIR, true);
            } else {

              await tar.extract({ file: archivePath, cwd: BORE_DIR });
            }
            if (os.platform() !== 'win32') fs.chmodSync(BORE_BIN, 0o755);
            fs.unlinkSync(archivePath);
            resolve();
          } catch (e) { reject(e); }
        });
      }).on('error', reject);
    };
    download(url);
  });
}

async function downloadPlayit(onProgress?: (msg: string) => void): Promise<void> {
  const platform = os.platform();
  const arch = os.arch();
  let url = '';
  if (platform === 'win32') url = 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-windows-x86_64.exe';
  else if (platform === 'linux') {
    url = arch === 'arm64' 
      ? 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-aarch64'
      : 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-linux-amd64';
  }
  
  onProgress?.(`Downloading tunnel agent...`);
  return new Promise((resolve, reject) => {
    fs.mkdirSync(PLAYIT_DIR, { recursive: true });
    const file = fs.createWriteStream(PLAYIT_BIN);
    const download = (redirectUrl: string) => {
      https.get(redirectUrl, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) return download(res.headers.location!);
        if (res.statusCode !== 200) return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          if (os.platform() !== 'win32') fs.chmodSync(PLAYIT_BIN, 0o755);
          resolve();
        });
      }).on('error', reject);
    };
    download(url);
  });
}

export async function startExpose(
  serverName: string,
  serverPort: number,
  subdomain: string,
  onEvent: (event: { type: string; payload: any }) => void
): Promise<void> {
  if (activeExposures.has(serverName)) return;

  onEvent({ type: 'tunnel_status', payload: { status: 'starting', message: 'Detecting network...' } });

  // 1. UPnP
  const upnp = await tryPortForward(serverPort, serverPort);
  if (upnp) {
    const ip = await getPublicIp();
    if (ip) {
      try {
        const addr = await registerDirectDns(subdomain, ip, serverPort);
        activeExposures.set(serverName, { strategy: 'upnp', subdomain, port: serverPort, address: addr });
        onEvent({ type: 'tunnel_active', payload: { address: addr, strategy: 'upnp' } });
        return;
      } catch (e) { console.warn("[swallowed error in tunnelManager.ts]:", e); }
    }
  }

  // 2. Bore (Zero-Account Automted)
  onEvent({ type: 'tunnel_status', payload: { status: 'starting', message: 'Starting zero-account tunnel (bore)...' } });
  try {
    if (!fs.existsSync(BORE_BIN)) await downloadBore((msg) => onEvent({ type: 'tunnel_status', payload: { status: 'downloading', message: msg } }));
    
    const proc = spawn(BORE_BIN, ['local', String(serverPort), '--to', 'bore.pub']);
    const state: TunnelState = { process: proc, subdomain, port: serverPort, strategy: 'bore' };
    activeExposures.set(serverName, state);

    proc.stdout?.on('data', async (data: Buffer) => {
      const line = data.toString().trim();
      // Match: listening at bore.pub:12345
      const match = line.match(/listening at bore\.pub:(\d+)/);
      if (match) {
        const remotePort = parseInt(match[1]);
        state.address = `bore.pub:${remotePort}`;
        onEvent({ type: 'tunnel_status', payload: { status: 'connecting_dns', message: 'Mapping your domain to bore.pub...' } });
        try {
          const addr = await registerTunnelDns(subdomain, 'bore.pub', remotePort);
          onEvent({ type: 'tunnel_active', payload: { address: addr, strategy: 'bore' } });
        } catch (err: any) {
          onEvent({ type: 'tunnel_error', payload: { message: `DNS failed: ${err.message}` } });
        }
      }
    });

    proc.on('exit', () => activeExposures.delete(serverName));
    return;
  } catch (err) {
    console.warn('[Tunnel] Bore failed, falling back to Playit:', err);
  }

  // 3. Playit Fallback
  onEvent({ type: 'tunnel_status', payload: { status: 'starting', message: 'Direct/Bore failed. Final fallback to Playit...' } });
  try {
    if (!fs.existsSync(PLAYIT_BIN)) await downloadPlayit();
    const configDir = path.join(PLAYIT_DIR, 'agents', serverName);
    fs.mkdirSync(configDir, { recursive: true });
    const proc = spawn(PLAYIT_BIN, [], {
      cwd: configDir,
      env: { ...process.env, PLAYIT_SECRET_PATH: path.join(configDir, 'secret.key') },
    });
    const state: TunnelState = { process: proc, subdomain, port: serverPort, strategy: 'playit' };
    activeExposures.set(serverName, state);
    proc.stdout?.on('data', async (data: Buffer) => {
      const line = data.toString().trim();
      const claim = line.match(/https:\/\/playit\.gg\/claim\/[a-zA-Z0-9_-]+/);
      if (claim) onEvent({ type: 'tunnel_claim_needed', payload: { url: claim[0] } });
      const addr = line.match(/(?:tcp:\/\/|join at[:\s]+)?([a-zA-Z0-9.-]+\.(?:playit\.gg|joinmc\.link)):(\d+)/i);
      if (addr) {
        const pHost = addr[1], pPort = parseInt(addr[2]);
        if (state.address === `${pHost}:${pPort}`) return;
        state.address = `${pHost}:${pPort}`;
        try {
          const publicAddress = await registerTunnelDns(subdomain, pHost, pPort);
          onEvent({ type: 'tunnel_active', payload: { address: publicAddress, strategy: 'playit' } });
        } catch (e) { console.warn("[swallowed error in tunnelManager.ts]:", e); }
      }
    });
    proc.on('exit', () => activeExposures.delete(serverName));
  } catch (err: any) {
    onEvent({ type: 'tunnel_error', payload: { message: `All strategies failed: ${err.message}` } });
  }
}

export async function stopExpose(serverName: string, passedSubdomain?: string): Promise<void> {
  const state = activeExposures.get(serverName);
  const targetSubdomain = state?.subdomain || passedSubdomain;

  if (state) {
    console.log(`[Tunnel] Stopping exposure for ${serverName} (Strategy: ${state.strategy})...`);
    state.process?.kill();
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

export function getTunnelState(serverName: string) {
  const state = activeExposures.get(serverName);
  if (!state) return undefined;
  return { address: state.address, status: 'active', strategy: state.strategy, subdomain: state.subdomain };
}
