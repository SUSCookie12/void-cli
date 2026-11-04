import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export function getVoidDir(): string {
  const dir = path.join(os.homedir(), '.void');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getServersDir(): string {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (cfg && typeof cfg.serversDir === 'string' && cfg.serversDir.trim().length > 0) {
        const customDir = cfg.serversDir.trim();
        if (!fs.existsSync(customDir)) fs.mkdirSync(customDir, { recursive: true });
        return customDir;
      }
    }
  } catch {}
  const dir = path.join(getVoidDir(), 'servers');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getServerDir(name: string): string {
  return path.join(getServersDir(), name);
}

export function getLocalBackupsDir(serverId: string): string {
  const dir = path.join(getVoidDir(), 'backups', serverId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getConfigPath(): string {
  return path.join(getVoidDir(), 'config.json');
}

export function getLogsDir(): string {
  const dir = path.join(getVoidDir(), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getTrashDir(): string {
  const dir = path.join(getVoidDir(), 'trash');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getTrashManifestPath(): string {
  return path.join(getTrashDir(), 'manifest.json');
}
