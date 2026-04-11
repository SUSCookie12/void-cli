import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export function getVoidDir(): string {
  const dir = path.join(os.homedir(), '.void');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getServersDir(): string {
  const dir = path.join(getVoidDir(), 'servers');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getServerDir(name: string): string {
  return path.join(getServersDir(), name);
}

export function getConfigPath(): string {
  return path.join(getVoidDir(), 'config.json');
}

export function getLogsDir(): string {
  const dir = path.join(getVoidDir(), 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
