import fs from 'node:fs';
import path from 'node:path';
import { getServersDir, getServerDir } from '../utils/paths.js';

export type JvmPreset = 'standard' | 'aikar' | 'shenandoah' | 'zgc' | 'low_ram' | 'custom';

export interface ServerMeta {
  name: string;
  type: 'vanilla' | 'paper' | 'fabric' | 'forge' | 'purpur' | 'neoforge' | 'quilt' | 'arclight';
  version: string;
  build?: number;
  fabricLoader?: string;
  forgeVersion?: string;
  neoforgeVersion?: string;
  launchJar?: string;
  ram: string;
  port: number;
  createdAt: string;
  autoExpose?: boolean;
  subdomain?: string;
  statusId?: string;
  localIp?: string;
  statusPageShowIp?: boolean;
  statusPageTheme?: string;
  statusPageDescription?: string;
  javaVersion?: number;
  customJavaPath?: string;
  jvmPreset?: JvmPreset;
  customJvmArgs?: string;
  initialProperties?: Record<string, string>;
}

export function listServers(): ServerMeta[] {
  const dir = getServersDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const servers: ServerMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(dir, entry.name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      servers.push(JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ServerMeta);
    } catch {
      // Skip corrupted metadata
    }
  }

  return servers.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export function getServerMeta(name: string): ServerMeta | null {
  const metaPath = path.join(getServerDir(name), 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ServerMeta;
  } catch {
    return null;
  }
}

export function saveServerMeta(meta: ServerMeta): void {
  const serverDir = getServerDir(meta.name);
  if (!fs.existsSync(serverDir)) fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

export function deleteServer(name: string): void {
  const serverDir = getServerDir(name);
  if (fs.existsSync(serverDir)) {
    fs.rmSync(serverDir, { recursive: true, force: true });
  }
}

export function renameServer(oldName: string, newName: string): boolean {
  if (!isValidServerName(newName) || serverExists(newName)) return false;
  
  const oldPath = getServerDir(oldName);
  const newPath = getServerDir(newName);
  
  if (!fs.existsSync(oldPath)) return false;
  
  try {
    // 1. Rename directory
    fs.renameSync(oldPath, newPath);
    
    // 2. Update meta.json
    const metaPath = path.join(newPath, 'meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ServerMeta;
      meta.name = newName;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    }
    return true;
  } catch (err) {
    console.error(`[MANAGER] Failed to rename server:`, err);
    return false;
  }
}

export function serverExists(name: string): boolean {
  return getServerMeta(name) !== null;
}

export function isValidServerName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,32}$/.test(name);
}

export function getNextAvailablePort(start = 25565): number {
  const used = new Set(listServers().map(s => s.port));
  let port = start;
  while (used.has(port)) port++;
  return port;
}
