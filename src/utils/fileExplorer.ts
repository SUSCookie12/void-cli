import fs from 'node:fs';
import path from 'node:path';
import { getServerDir } from './paths.js';
import { moveToTrash } from './trash.js';

export interface FileEntry {
  name: string;
  type: 'file' | 'folder';
  size: number;
  mtime: string;
  isEditable: boolean;
}

const EDITABLE_EXTENSIONS = new Set([
  '.properties', '.yml', '.yaml', '.json', '.txt', '.log', '.sh', '.bat', '.cmd', '.cfg', '.conf', '.toml', '.ini', '.mcmeta', '.md', '.json5'
]);

const HIDDEN_FILES = new Set([
  'meta.json', 'void-config.json', '.DS_Store'
]);

/**
 * Sandboxes a path within the server directory.
 * Throws error if path escapes.
 */
function getSafePath(serverName: string, subPath: string): string {
  const root = getServerDir(serverName);
  const fullPath = path.resolve(root, subPath);
  
  if (!fullPath.startsWith(root)) {
    throw new Error('Path traversal attempt blocked');
  }
  
  return fullPath;
}

export function listEntries(serverName: string, subPath: string = ''): FileEntry[] {
  const targetDir = getSafePath(serverName, subPath);
  
  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    return [];
  }

  const entries = fs.readdirSync(targetDir, { withFileTypes: true });
  
  const result: FileEntry[] = entries
    .filter(entry => !HIDDEN_FILES.has(entry.name))
    .map(entry => {
      const fullPath = path.join(targetDir, entry.name);
      const stats = fs.statSync(fullPath);
      const ext = path.extname(entry.name).toLowerCase();

      return {
        name: entry.name,
        type: entry.isDirectory() ? 'folder' : 'file',
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        isEditable: !entry.isDirectory() && EDITABLE_EXTENSIONS.has(ext)
      };
    });

  // Windows Explorer sorting: folders first, then files, both alphabetical
  return result.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

export function readTextFile(serverName: string, filePath: string): string {
  const safePath = getSafePath(serverName, filePath);
  
  const stats = fs.statSync(safePath);
  if (stats.size > 5 * 1024 * 1024) { // 5MB limit
    throw new Error('File too large to open in editor');
  }

  return fs.readFileSync(safePath, 'utf8');
}

export function writeTextFile(serverName: string, filePath: string, content: string): void {
  const safePath = getSafePath(serverName, filePath);
  fs.writeFileSync(safePath, content, 'utf8');
}

export function deleteEntry(serverName: string, targetPath: string, permanent: boolean = false): void {
  if (permanent) {
    const safePath = getSafePath(serverName, targetPath);
    fs.rmSync(safePath, { recursive: true, force: true });
  } else {
    moveToTrash(serverName, targetPath);
  }
}

export function createEntry(serverName: string, targetPath: string, isFolder: boolean): void {
  const safePath = getSafePath(serverName, targetPath);
  if (isFolder) {
    fs.mkdirSync(safePath, { recursive: true });
  } else {
    fs.writeFileSync(safePath, '', 'utf8');
  }
}

export function renameEntry(serverName: string, oldSubPath: string, newSubPath: string): void {
  const oldPath = getSafePath(serverName, oldSubPath);
  const newPath = getSafePath(serverName, newSubPath);
  fs.renameSync(oldPath, newPath);
}
