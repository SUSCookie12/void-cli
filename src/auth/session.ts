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
