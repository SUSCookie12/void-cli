import fs from 'node:fs';
import path from 'node:path';
import { getServersDir, getServerDir } from '../utils/paths.js';
import { generateRandomSubdomain } from '../utils/wordGenerator.js';

export type JvmPreset = 'standard' | 'aikar' | 'shenandoah' | 'zgc' | 'low_ram' | 'custom';


export function slugifyServerName(name: string): string {
  if (!name) return 'server';
  const clean = name
    .toLowerCase()
    .trim()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'server';
}

export interface ServerMeta {
  name: string;
  type: 'vanilla' | 'paper' | 'fabric' | 'forge' | 'purpur' | 'neoforge' | 'quilt' | 'arclight' | 'bedrock';
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
  isPublic?: boolean;
  javaVersion?: number;
  customJavaPath?: string;
  jvmPreset?: JvmPreset;
  customJvmArgs?: string;
  initialProperties?: Record<string, string>;
  backupDir?: string;
  localBackupLimit?: {
    enabled: boolean;
    type: 'quantity' | 'size_gb';
    value: number;
  };
  autoRestart?: boolean;
  preset?: string;
  isFrozen?: boolean;
  frozenAt?: number;
  frozenArchiveSize?: number;
  previousSubdomain?: string;
  diskSize?: {
    serverBytes: number;
    backupsBytes: number;
    totalBytes: number;
  };
}

/**
 * Ensures every existing server has a random two-word subdomain (`<word-word>.void.borgov.dev`)
 * and `autoExpose: true` persisted in its `meta.json`.
 */
export function ensureAllServerSubdomains(): void {
  const dir = getServersDir();
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const usedSubdomains = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(dir, entry.name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ServerMeta;
      if (meta.isFrozen) continue;
      if (meta.subdomain) {
        usedSubdomains.add(meta.subdomain.toLowerCase());
      }
    } catch {}
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(dir, entry.name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ServerMeta;
      if (meta.isFrozen) continue;
      let changed = false;
      if (!meta.subdomain || !meta.subdomain.trim()) {
        const sub = generateRandomSubdomain(usedSubdomains);
        usedSubdomains.add(sub);
        meta.subdomain = sub;
        changed = true;
      }
      if (!meta.statusId || meta.statusId === meta.subdomain) {
        meta.statusId = slugifyServerName(meta.name);
        changed = true;
      }
      if (meta.autoExpose === undefined) {
        meta.autoExpose = true;
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }
    } catch {}
  }
}

export function listServers(): ServerMeta[] {
  const dir = getServersDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const servers: ServerMeta[] = [];
  const usedSubdomains = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(dir, entry.name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ServerMeta;
      if (!meta.isFrozen && meta.subdomain) {
        usedSubdomains.add(meta.subdomain.toLowerCase());
      }
      servers.push(meta);
    } catch {
      // Skip corrupted metadata
    }
  }

  for (const meta of servers) {
    if (meta.isFrozen) continue;
    let changed = false;
    if (!meta.subdomain || !meta.subdomain.trim()) {
      const sub = generateRandomSubdomain(usedSubdomains);
      usedSubdomains.add(sub);
      meta.subdomain = sub;
      changed = true;
    }
    if (!meta.statusId || meta.statusId === meta.subdomain) {
      meta.statusId = slugifyServerName(meta.name);
      changed = true;
    }
    if (meta.autoExpose === undefined) {
      meta.autoExpose = true;
      changed = true;
    }
    if (changed) {
      try {
        saveServerMeta(meta);
      } catch {}
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
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as ServerMeta;
    if (meta.isFrozen) return meta;
    let changed = false;
    if (!meta.subdomain || !meta.subdomain.trim()) {
      meta.subdomain = generateRandomSubdomain();
      changed = true;
    }
    if (meta.autoExpose === undefined) {
      meta.autoExpose = true;
      changed = true;
    }
    if (changed) {
      try {
        saveServerMeta(meta);
      } catch {}
    }
    return meta;
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
  const oldMeta = getServerMeta(oldName);
  if (oldMeta?.isFrozen) return false;
  
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
      meta.statusId = slugifyServerName(newName);
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
