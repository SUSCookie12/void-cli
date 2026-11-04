import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getServerDir, getTrashDir, getTrashManifestPath } from './paths.js';

export interface TrashItem {
  id: string;
  name: string;
  serverName: string;
  originalPath: string; // relative to server root
  trashName: string;    // filename inside ~/.void/trash
  type: 'file' | 'folder';
  size: number;
  deletedAt: string;
  expiresAt: string;
}

export interface TrashManifest {
  retentionDays: number;
  items: TrashItem[];
}

const DEFAULT_RETENTION_DAYS = 15;

function loadManifest(): TrashManifest {
  const manifestPath = getTrashManifestPath();
  try {
    if (fs.existsSync(manifestPath)) {
      const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return {
        retentionDays: typeof data.retentionDays === 'number' ? data.retentionDays : DEFAULT_RETENTION_DAYS,
        items: Array.isArray(data.items) ? data.items : []
      };
    }
  } catch (e) {
    console.error('[Trash] Failed to parse manifest.json, creating new one:', e);
  }
  return { retentionDays: DEFAULT_RETENTION_DAYS, items: [] };
}

function saveManifest(manifest: TrashManifest): void {
  const manifestPath = getTrashManifestPath();
  const dir = getTrashDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

function calculatePathSize(targetPath: string): number {
  try {
    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) return stats.size;

    let total = 0;
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(targetPath, entry.name);
      if (entry.isDirectory()) {
        total += calculatePathSize(full);
      } else {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
    return total;
  } catch {
    return 0;
  }
}

function safeMove(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err: any) {
    if (err.code === 'EXDEV') {
      // Cross-device move fallback
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/**
 * Prunes expired items from trash directory and manifest.
 */
export function pruneExpiredTrash(): void {
  const manifest = loadManifest();
  const now = Date.now();
  const trashDir = getTrashDir();
  let changed = false;

  const validItems: TrashItem[] = [];
  for (const item of manifest.items) {
    const exp = Date.parse(item.expiresAt);
    if (exp && exp <= now) {
      const fullTrashPath = path.join(trashDir, item.trashName);
      try {
        if (fs.existsSync(fullTrashPath)) {
          fs.rmSync(fullTrashPath, { recursive: true, force: true });
        }
      } catch (e) {
        console.error(`[Trash] Failed to remove expired item ${item.trashName}:`, e);
      }
      changed = true;
    } else {
      validItems.push(item);
    }
  }

  if (changed) {
    manifest.items = validItems;
    saveManifest(manifest);
  }
}

/**
 * Moves a file or folder from server to the trash folder.
 */
export function moveToTrash(serverName: string, relativePath: string): TrashItem {
  pruneExpiredTrash();
  const root = getServerDir(serverName);
  const fullPath = path.resolve(root, relativePath);

  if (!fullPath.startsWith(root)) {
    throw new Error('Path traversal blocked');
  }
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Item does not exist: ${relativePath}`);
  }

  const manifest = loadManifest();
  const id = crypto.randomUUID();
  const baseName = path.basename(fullPath);
  const cleanBase = baseName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const trashName = `${id}_${cleanBase}`;
  const trashDir = getTrashDir();
  const targetTrashPath = path.join(trashDir, trashName);

  const stats = fs.statSync(fullPath);
  const isDir = stats.isDirectory();
  const size = calculatePathSize(fullPath);

  safeMove(fullPath, targetTrashPath);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + manifest.retentionDays * 24 * 60 * 60 * 1000);

  const item: TrashItem = {
    id,
    name: baseName,
    serverName,
    originalPath: relativePath.replace(/\\/g, '/'),
    trashName,
    type: isDir ? 'folder' : 'file',
    size,
    deletedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString()
  };

  manifest.items.unshift(item);
  saveManifest(manifest);
  return item;
}

/**
 * Restores a trash item to its original server path.
 */
export function restoreTrashItem(id: string): TrashItem {
  const manifest = loadManifest();
  const idx = manifest.items.findIndex(i => i.id === id);
  if (idx === -1) {
    throw new Error(`Trash item not found: ${id}`);
  }

  const item = manifest.items[idx];
  const trashDir = getTrashDir();
  const trashPath = path.join(trashDir, item.trashName);

  if (!fs.existsSync(trashPath)) {
    manifest.items.splice(idx, 1);
    saveManifest(manifest);
    throw new Error(`File is missing from trash storage: ${item.name}`);
  }

  const root = getServerDir(item.serverName);
  const restorePath = path.resolve(root, item.originalPath);

  if (!restorePath.startsWith(root)) {
    throw new Error('Restore path escapes server directory');
  }

  const parentDir = path.dirname(restorePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // If destination exists, replace or overwrite
  if (fs.existsSync(restorePath)) {
    fs.rmSync(restorePath, { recursive: true, force: true });
  }

  safeMove(trashPath, restorePath);

  manifest.items.splice(idx, 1);
  saveManifest(manifest);
  return item;
}

/**
 * Permanently deletes a single item from trash.
 */
export function deleteTrashItemPermanent(id: string): void {
  const manifest = loadManifest();
  const idx = manifest.items.findIndex(i => i.id === id);
  if (idx === -1) return;

  const item = manifest.items[idx];
  const trashPath = path.join(getTrashDir(), item.trashName);
  try {
    if (fs.existsSync(trashPath)) {
      fs.rmSync(trashPath, { recursive: true, force: true });
    }
  } catch (e) {
    console.error(`[Trash] Error deleting ${item.trashName}:`, e);
  }

  manifest.items.splice(idx, 1);
  saveManifest(manifest);
}

/**
 * Empties all items in trash permanently.
 */
export function emptyTrash(): void {
  const manifest = loadManifest();
  const trashDir = getTrashDir();

  for (const item of manifest.items) {
    const p = path.join(trashDir, item.trashName);
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    } catch {}
  }

  manifest.items = [];
  saveManifest(manifest);
}

/**
 * Gets trash overview, items list, and total bytes consumed.
 */
export function getTrashSummary(): { items: TrashItem[]; totalBytes: number; retentionDays: number } {
  pruneExpiredTrash();
  const manifest = loadManifest();
  const totalBytes = manifest.items.reduce((acc, item) => acc + (item.size || 0), 0);
  return {
    items: manifest.items,
    totalBytes,
    retentionDays: manifest.retentionDays
  };
}

/**
 * Updates default auto-deletion retention days.
 */
export function setTrashRetentionDays(days: number): void {
  const manifest = loadManifest();
  manifest.retentionDays = Math.max(1, Math.min(365, days));
  saveManifest(manifest);
}
