import fs from 'node:fs';
import path from 'node:path';
import { getServerDir } from './paths.js';

export interface ModInfo {
  name: string;
  fileName: string;
  enabled: boolean;
  size: number;
}

export function listMods(serverName: string): ModInfo[] {
  const serverDir = getServerDir(serverName);
  const modsDir = path.join(serverDir, 'mods');

  if (!fs.existsSync(modsDir)) {
    return [];
  }

  const files = fs.readdirSync(modsDir);
  const mods: ModInfo[] = [];

  for (const file of files) {
    if (file.endsWith('.jar') || file.endsWith('.jar.disabled')) {
      const fullPath = path.join(modsDir, file);
      const stats = fs.statSync(fullPath);

      mods.push({
        name: file.replace(/\.jar(\.disabled)?$/, '').replace('.disabled', ''),
        fileName: file,
        enabled: file.endsWith('.jar'),
        size: stats.size,
      });
    }
  }

  return mods;
}

export function toggleMod(serverName: string, fileName: string, enable: boolean): void {
  const serverDir = getServerDir(serverName);
  const modsDir = path.join(serverDir, 'mods');
  const oldPath = path.join(modsDir, fileName);

  let newFileName = fileName;
  if (enable && fileName.endsWith('.disabled')) {
    newFileName = fileName.replace('.disabled', '');
  } else if (!enable && !fileName.endsWith('.disabled')) {
    newFileName = fileName + '.disabled';
  }

  const newPath = path.join(modsDir, newFileName);

  if (fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
  } else {
    throw new Error('Mod file not found');
  }
}
