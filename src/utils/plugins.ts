import fs from 'node:fs';
import path from 'node:path';
import { getServerDir } from './paths.js';

export interface PluginInfo {
  name: string;
  fileName: string;
  enabled: boolean;
  size: number;
}

export function listPlugins(serverName: string): PluginInfo[] {
  const serverDir = getServerDir(serverName);
  const pluginsDir = path.join(serverDir, 'plugins');

  if (!fs.existsSync(pluginsDir)) {
    return [];
  }

  const files = fs.readdirSync(pluginsDir);
  const plugins: PluginInfo[] = [];

  for (const file of files) {
    if (file.endsWith('.jar') || file.endsWith('.jar.disabled')) {
      const fullPath = path.join(pluginsDir, file);
      const stats = fs.statSync(fullPath);
      
      plugins.push({
        name: file.replace('.jar', '').replace('.disabled', ''),
        fileName: file,
        enabled: file.endsWith('.jar'),
        size: stats.size
      });
    }
  }

  return plugins;
}

export function togglePlugin(serverName: string, fileName: string, enable: boolean): void {
  const serverDir = getServerDir(serverName);
  const pluginsDir = path.join(serverDir, 'plugins');
  const oldPath = path.join(pluginsDir, fileName);

  let newFileName = fileName;
  if (enable && fileName.endsWith('.disabled')) {
    newFileName = fileName.replace('.disabled', '');
  } else if (!enable && !fileName.endsWith('.disabled')) {
    newFileName = fileName + '.disabled';
  }

  const newPath = path.join(pluginsDir, newFileName);
  
  if (fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
  } else {
    throw new Error('Plugin file not found');
  }
}
