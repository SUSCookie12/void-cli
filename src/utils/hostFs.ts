import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getServerDir, getLocalBackupsDir, getServersDir } from './paths.js';

export interface SystemDrive {
  path: string;
  label: string;
  freeBytes?: number;
  totalBytes?: number;
  isSystem?: boolean;
}

export interface DirectoryEntry {
  name: string;
  path: string;
  canWrite: boolean;
}

export interface BrowseResult {
  currentPath: string;
  parentPath: string | null;
  directories: DirectoryEntry[];
  freeBytes?: number;
  totalBytes?: number;
  canWrite: boolean;
  platform: string;
}

export interface ServerDiskSize {
  serverBytes: number;
  backupsBytes: number;
  totalBytes: number;
}

const diskSizeCache = new Map<string, { data: ServerDiskSize; timestamp: number }>();
const CACHE_TTL_MS = 20_000; // 20-second cache for fast responsive UI

export function invalidateServerDiskCache(serverName?: string): void {
  if (serverName) {
    diskSizeCache.delete(serverName);
  } else {
    diskSizeCache.clear();
  }
}

export function getSystemDrives(): SystemDrive[] {
  const platform = process.platform;
  const drives: SystemDrive[] = [];

  if (platform === 'win32') {
    const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB';
    for (const letter of letters) {
      const driveRoot = `${letter}:\\`;
      try {
        if (fs.existsSync(driveRoot)) {
          let freeBytes: number | undefined;
          let totalBytes: number | undefined;
          try {
            const stat = fs.statfsSync(driveRoot);
            freeBytes = stat.bavail * stat.bsize;
            totalBytes = stat.blocks * stat.bsize;
          } catch {}

          drives.push({
            path: driveRoot,
            label: letter === 'C' ? 'Local Disk (C:)' : `Drive (${letter}:)`,
            freeBytes,
            totalBytes,
            isSystem: letter === 'C',
          });
        }
      } catch {}
    }
  } else {
    // Linux / macOS / Unix
    const candidates: { path: string; label: string; isSystem?: boolean }[] = [
      { path: '/', label: 'Root (/)', isSystem: true },
      { path: os.homedir(), label: `Home (${path.basename(os.homedir())})` },
    ];

    const mediaDirs = ['/mnt', '/media', `/media/${os.userInfo().username || ''}`];
    for (const mediaDir of mediaDirs) {
      if (fs.existsSync(mediaDir)) {
        try {
          const subdirs = fs.readdirSync(mediaDir, { withFileTypes: true });
          for (const s of subdirs) {
            if (s.isDirectory() || s.isSymbolicLink()) {
              candidates.push({
                path: path.join(mediaDir, s.name),
                label: `Mount (${s.name})`,
              });
            }
          }
        } catch {}
      }
    }

    const seenPaths = new Set<string>();
    for (const cand of candidates) {
      if (!cand.path || seenPaths.has(cand.path)) continue;
      seenPaths.add(cand.path);
      try {
        if (fs.existsSync(cand.path)) {
          let freeBytes: number | undefined;
          let totalBytes: number | undefined;
          try {
            const stat = fs.statfsSync(cand.path);
            freeBytes = stat.bavail * stat.bsize;
            totalBytes = stat.blocks * stat.bsize;
          } catch {}

          drives.push({
            path: cand.path,
            label: cand.label,
            freeBytes,
            totalBytes,
            isSystem: cand.isSystem,
          });
        }
      } catch {}
    }
  }

  return drives;
}

export function browseHostDirectories(requestedPath?: string): BrowseResult {
  const platform = process.platform;
  let targetPath = requestedPath ? path.resolve(requestedPath.trim()) : '';

  if (!targetPath || !fs.existsSync(targetPath)) {
    if (platform === 'win32') {
      targetPath = fs.existsSync('D:\\') ? 'D:\\' : 'C:\\';
    } else {
      targetPath = fs.existsSync(os.homedir()) ? os.homedir() : '/';
    }
  }

  let statfsInfo: { freeBytes?: number; totalBytes?: number } = {};
  try {
    const s = fs.statfsSync(targetPath);
    statfsInfo = {
      freeBytes: s.bavail * s.bsize,
      totalBytes: s.blocks * s.bsize,
    };
  } catch {}

  let canWrite = false;
  try {
    fs.accessSync(targetPath, fs.constants.W_OK);
    canWrite = true;
  } catch {}

  const directories: DirectoryEntry[] = [];
  try {
    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    for (const entry of entries) {
      // Exclude Windows special / hidden system folders
      if (entry.name.startsWith('$') || entry.name === 'System Volume Information' || entry.name === 'hiberfil.sys') {
        continue;
      }

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        const full = path.join(targetPath, entry.name);
        let folderWritable = false;
        try {
          fs.accessSync(full, fs.constants.W_OK);
          folderWritable = true;
        } catch {}

        directories.push({
          name: entry.name,
          path: full,
          canWrite: folderWritable,
        });
      }
    }
  } catch (err: any) {
    // If permission denied reading folder, directories stays empty
  }

  directories.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  const parent = path.dirname(targetPath);
  const isRoot = parent === targetPath || (platform === 'win32' && /^[a-zA-Z]:\\?$/.test(targetPath));

  return {
    currentPath: targetPath,
    parentPath: isRoot ? null : parent,
    directories,
    freeBytes: statfsInfo.freeBytes,
    totalBytes: statfsInfo.totalBytes,
    canWrite,
    platform,
  };
}

export function createHostDirectory(parentPath: string, folderName: string): string {
  const cleanParent = path.resolve(parentPath.trim());
  const cleanName = folderName.trim().replace(/[\\/:*?"<>|]/g, '');
  if (!cleanName || cleanName === '.' || cleanName === '..') {
    throw new Error('Invalid folder name');
  }

  const newPath = path.join(cleanParent, cleanName);
  if (fs.existsSync(newPath)) {
    throw new Error(`Directory "${cleanName}" already exists`);
  }

  fs.mkdirSync(newPath, { recursive: true });
  return newPath;
}

export function getFastFolderSize(dirPath: string, excludedDir?: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const normExcluded = excludedDir ? path.resolve(excludedDir).toLowerCase() : null;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      const normFull = full.toLowerCase();

      // Skip backups directory
      if (entry.name === 'backups') continue;
      if (normExcluded && (normFull === normExcluded || normFull.startsWith(normExcluded + path.sep))) continue;

      if (entry.isDirectory()) {
        total += getFastFolderSize(full, excludedDir);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
  } catch {}

  return total;
}

export function calculateServerDiskSize(serverName: string): ServerDiskSize {
  const now = Date.now();
  const cached = diskSizeCache.get(serverName);
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const serverDir = getServerDir(serverName);
  const backupsDir = getLocalBackupsDir(serverName);

  let serverBytes = 0;
  let backupsBytes = 0;

  if (fs.existsSync(serverDir)) {
    serverBytes = getFastFolderSize(serverDir, backupsDir);
  }

  if (fs.existsSync(backupsDir)) {
    try {
      const files = fs.readdirSync(backupsDir);
      for (const f of files) {
        if (f.startsWith('backup_') && f.endsWith('.zip')) {
          try {
            backupsBytes += fs.statSync(path.join(backupsDir, f)).size;
          } catch {}
        }
      }
    } catch {}
  }

  const data: ServerDiskSize = {
    serverBytes,
    backupsBytes,
    totalBytes: serverBytes + backupsBytes,
  };

  diskSizeCache.set(serverName, { data, timestamp: now });
  return data;
}
