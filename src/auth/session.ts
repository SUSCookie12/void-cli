import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { getConfigPath, getVoidDir } from '../utils/paths.js';

export interface UserSession {
  uid: string;
  email: string;
  displayName?: string;
  token: string;
  daemonId: string;
  authenticatedAt: string;
}

function loadConfig(): Record<string, unknown> {
  const p = getConfigPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function saveConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
}

export function getDaemonId(): string {
  const config = loadConfig();
  if (typeof config.daemonId === 'string') return config.daemonId;
  const newId = uuidv4();
  saveConfig({ ...config, daemonId: newId });
  return newId;
}

export function loadSession(): UserSession | null {
  const config = loadConfig();
  if (typeof config.uid !== 'string' || !config.uid) return null;
  if (typeof config.token !== 'string' || !config.token) return null;
  return {
    uid: config.uid,
    email: typeof config.email === 'string' ? config.email : '',
    displayName: typeof config.displayName === 'string' ? config.displayName : undefined,
    token: config.token,
    daemonId: getDaemonId(),
    authenticatedAt: typeof config.authenticatedAt === 'string' ? config.authenticatedAt : new Date().toISOString(),
  };
}

export function saveSession(session: UserSession): void {
  const config = loadConfig();
  saveConfig({
    ...config,
    uid: session.uid,
    email: session.email,
    displayName: session.displayName,
    token: session.token,
    daemonId: session.daemonId,
    authenticatedAt: session.authenticatedAt,
  });
}

export function clearSession(): void {
  const config = loadConfig();
  const { uid, email, displayName, token, authenticatedAt, ...rest } = config;
  saveConfig(rest);
}

export interface BackupConfig {
  backupServerUrl: string;
  backupToken: string;
}

export function loadBackupConfig(): BackupConfig {
  const config = loadConfig();
  let backupServerUrl = typeof config.backupServerUrl === 'string' ? config.backupServerUrl : 'https://voidbackuphub.fold-elevator.ts.net';

  // Automatically upgrade public domains to HTTPS to prevent Cloudflare 308 redirect failures on node streams,
  // but do not upgrade direct IP addresses since they do not have SSL certificates installed.
  // Also, avoid upgrading local hostnames (.local, .lan) and private Tailscale names (.ts.net).
  let shouldUpgrade = false;
  if (
    backupServerUrl &&
    backupServerUrl.startsWith('http://') &&
    !backupServerUrl.includes('localhost') &&
    !backupServerUrl.includes('127.0.0.1') &&
    !backupServerUrl.includes('192.168.')
  ) {
    try {
      const url = new URL(backupServerUrl);
      const hostname = url.hostname;
      const isIP = /^[0-9.]+$/.test(hostname) || hostname.includes(':');
      const isLocal = !hostname.includes('.') || hostname.endsWith('.local') || hostname.endsWith('.lan') || hostname.endsWith('.ts.net');
      if (!isIP && !isLocal) {
        shouldUpgrade = true;
      }
    } catch (e) {
      shouldUpgrade = true;
    }
  }

  if (shouldUpgrade) {
    backupServerUrl = backupServerUrl.replace('http://', 'https://');
  }

  return {
    backupServerUrl,
    backupToken: typeof config.backupToken === 'string' ? config.backupToken : '',
  };
}

export function saveBackupConfig(backupConfig: BackupConfig): void {
  const config = loadConfig();
  saveConfig({
    ...config,
    backupServerUrl: backupConfig.backupServerUrl,
    backupToken: backupConfig.backupToken,
  });
}

export interface LocalBackupLimit {
  enabled: boolean;
  type: 'quantity' | 'size_gb';
  value: number;
}

export function loadLocalBackupLimit(): LocalBackupLimit {
  const config = loadConfig();
  if (typeof config.localBackupLimit === 'number') {
    return { enabled: true, type: 'quantity', value: config.localBackupLimit };
  }
  if (config.localBackupLimit && typeof config.localBackupLimit === 'object') {
    const lim = config.localBackupLimit as any;
    return { 
      enabled: typeof lim.enabled === 'boolean' ? lim.enabled : true,
      type: (lim.type === 'size_gb' ? 'size_gb' : 'quantity'), 
      value: typeof lim.value === 'number' ? lim.value : 3 
    };
  }
  return { enabled: false, type: 'quantity', value: 3 };
}

export function saveLocalBackupLimit(limit: LocalBackupLimit): void {
  const config = loadConfig();
  saveConfig({
    ...config,
    localBackupLimit: limit
  });
}

