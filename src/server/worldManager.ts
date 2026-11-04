import fs from 'node:fs';
import path from 'node:path';
import { getServerDir } from '../utils/paths.js';
import { readProperties } from './properties.js';

export interface WorldDimensionInfo {
  id: string; // 'overworld' | 'nether' | 'the_end' | custom
  name: string;
  folder: string;
  regionCount: number;
  totalSizeBytes: number;
  lastModified?: string;
  canReset: boolean;
}

export interface RegionFileInfo {
  fileName: string;
  regionX: number;
  regionZ: number;
  minBlockX: number;
  maxBlockX: number;
  minBlockZ: number;
  maxBlockZ: number;
  sizeBytes: number;
  lastModified: string;
}

function getDirectorySizeAndFiles(dirPath: string): { size: number; count: number; mtime: number } {
  if (!fs.existsSync(dirPath)) return { size: 0, count: 0, mtime: 0 };
  let size = 0;
  let count = 0;
  let mtime = 0;

  function traverse(current: string) {
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          traverse(full);
        } else {
          try {
            const stat = fs.statSync(full);
            size += stat.size;
            count++;
            if (stat.mtimeMs > mtime) mtime = stat.mtimeMs;
          } catch {}
        }
      }
    } catch {}
  }

  traverse(dirPath);
  return { size, count, mtime };
}

function resolveDimensionRegionDir(serverDir: string, levelName: string, dimId: string): string | null {
  if (dimId === 'overworld') {
    const candidates = [
      path.join(serverDir, levelName, 'region'),
      path.join(serverDir, levelName, 'dimensions', 'minecraft', 'overworld', 'region'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  if (dimId === 'nether') {
    // Paper/Purpur: levelName_nether/DIM-1/region or levelName_nether/region
    const paperCandidates = [
      path.join(serverDir, `${levelName}_nether`, 'DIM-1', 'region'),
      path.join(serverDir, `${levelName}_nether`, 'region'),
      path.join(serverDir, levelName, 'DIM-1', 'region'),
      path.join(serverDir, levelName, 'dimensions', 'minecraft', 'the_nether', 'region'),
    ];
    for (const c of paperCandidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  if (dimId === 'the_end') {
    // Paper/Purpur: levelName_the_end/DIM1/region or levelName_the_end/region
    const endCandidates = [
      path.join(serverDir, `${levelName}_the_end`, 'DIM1', 'region'),
      path.join(serverDir, `${levelName}_the_end`, 'region'),
      path.join(serverDir, levelName, 'DIM1', 'region'),
      path.join(serverDir, levelName, 'dimensions', 'minecraft', 'the_end', 'region'),
    ];
    for (const c of endCandidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  return null;
}

export async function getWorldDimensions(serverName: string): Promise<{
  dimensions: WorldDimensionInfo[];
  levelName: string;
  seed: string;
}> {
  const serverDir = getServerDir(serverName);
  const props = await readProperties(serverName);
  const levelName = props['level-name'] || 'world';
  const seed = props['level-seed'] || 'Default';

  const dimensions: WorldDimensionInfo[] = [];

  // 1. Overworld
  const overworldRegionDir = resolveDimensionRegionDir(serverDir, levelName, 'overworld');
  const overworldTotalDir = path.join(serverDir, levelName);
  if (fs.existsSync(overworldTotalDir)) {
    const stats = getDirectorySizeAndFiles(overworldTotalDir);
    const regionCount = overworldRegionDir && fs.existsSync(overworldRegionDir)
      ? fs.readdirSync(overworldRegionDir).filter(f => f.endsWith('.mca')).length
      : 0;

    dimensions.push({
      id: 'overworld',
      name: 'Overworld',
      folder: levelName,
      regionCount,
      totalSizeBytes: stats.size,
      lastModified: stats.mtime ? new Date(stats.mtime).toISOString() : undefined,
      canReset: false, // Don't allow 1-click wipe of overworld
    });
  }

  // 2. Nether
  const netherRegionDir = resolveDimensionRegionDir(serverDir, levelName, 'nether');
  const netherTotalDir = fs.existsSync(path.join(serverDir, `${levelName}_nether`))
    ? path.join(serverDir, `${levelName}_nether`)
    : path.join(serverDir, levelName, 'DIM-1');

  if (fs.existsSync(netherTotalDir) || (netherRegionDir && fs.existsSync(netherRegionDir))) {
    const stats = getDirectorySizeAndFiles(netherTotalDir);
    const regionCount = netherRegionDir && fs.existsSync(netherRegionDir)
      ? fs.readdirSync(netherRegionDir).filter(f => f.endsWith('.mca')).length
      : 0;

    dimensions.push({
      id: 'nether',
      name: 'The Nether',
      folder: path.basename(netherTotalDir),
      regionCount,
      totalSizeBytes: stats.size,
      lastModified: stats.mtime ? new Date(stats.mtime).toISOString() : undefined,
      canReset: true,
    });
  }

  // 3. The End
  const endRegionDir = resolveDimensionRegionDir(serverDir, levelName, 'the_end');
  const endTotalDir = fs.existsSync(path.join(serverDir, `${levelName}_the_end`))
    ? path.join(serverDir, `${levelName}_the_end`)
    : path.join(serverDir, levelName, 'DIM1');

  if (fs.existsSync(endTotalDir) || (endRegionDir && fs.existsSync(endRegionDir))) {
    const stats = getDirectorySizeAndFiles(endTotalDir);
    const regionCount = endRegionDir && fs.existsSync(endRegionDir)
      ? fs.readdirSync(endRegionDir).filter(f => f.endsWith('.mca')).length
      : 0;

    dimensions.push({
      id: 'the_end',
      name: 'The End',
      folder: path.basename(endTotalDir),
      regionCount,
      totalSizeBytes: stats.size,
      lastModified: stats.mtime ? new Date(stats.mtime).toISOString() : undefined,
      canReset: true,
    });
  }

  return { dimensions, levelName, seed };
}

export async function getDimensionRegions(serverName: string, dimensionId: string): Promise<RegionFileInfo[]> {
  const serverDir = getServerDir(serverName);
  const props = await readProperties(serverName);
  const levelName = props['level-name'] || 'world';

  const regionDir = resolveDimensionRegionDir(serverDir, levelName, dimensionId);
  if (!regionDir || !fs.existsSync(regionDir)) return [];

  const files = fs.readdirSync(regionDir);
  const regions: RegionFileInfo[] = [];

  for (const file of files) {
    const match = file.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/);
    if (!match) continue;

    const rx = parseInt(match[1], 10);
    const rz = parseInt(match[2], 10);
    const fullPath = path.join(regionDir, file);

    try {
      const stat = fs.statSync(fullPath);
      regions.push({
        fileName: file,
        regionX: rx,
        regionZ: rz,
        minBlockX: rx * 512,
        maxBlockX: (rx + 1) * 512 - 1,
        minBlockZ: rz * 512,
        maxBlockZ: (rz + 1) * 512 - 1,
        sizeBytes: stat.size,
        lastModified: stat.mtime.toISOString(),
      });
    } catch {}
  }

  // Sort by coordinate closeness to spawn / size
  return regions.sort((a, b) => {
    const distA = Math.abs(a.regionX) + Math.abs(a.regionZ);
    const distB = Math.abs(b.regionX) + Math.abs(b.regionZ);
    return distA - distB;
  });
}

export async function resetDimension(serverName: string, dimensionId: 'nether' | 'the_end'): Promise<{ success: boolean; deletedCount: number }> {
  const serverDir = getServerDir(serverName);
  const props = await readProperties(serverName);
  const levelName = props['level-name'] || 'world';

  const regionDir = resolveDimensionRegionDir(serverDir, levelName, dimensionId);
  if (!regionDir || !fs.existsSync(regionDir)) {
    return { success: false, deletedCount: 0 };
  }

  let deletedCount = 0;
  const files = fs.readdirSync(regionDir);
  for (const f of files) {
    if (f.endsWith('.mca')) {
      try {
        fs.unlinkSync(path.join(regionDir, f));
        deletedCount++;
      } catch {}
    }
  }

  // Also clean entities & poi folders in that dimension if present
  const parentDir = path.dirname(regionDir);
  for (const sub of ['entities', 'poi']) {
    const subDir = path.join(parentDir, sub);
    if (fs.existsSync(subDir)) {
      try {
        fs.rmSync(subDir, { recursive: true, force: true });
      } catch {}
    }
  }

  return { success: true, deletedCount };
}

export async function deleteRegionFiles(serverName: string, dimensionId: string, fileNames: string[]): Promise<{ success: boolean; deleted: string[] }> {
  const serverDir = getServerDir(serverName);
  const props = await readProperties(serverName);
  const levelName = props['level-name'] || 'world';

  const regionDir = resolveDimensionRegionDir(serverDir, levelName, dimensionId);
  if (!regionDir || !fs.existsSync(regionDir)) {
    return { success: false, deleted: [] };
  }

  const deleted: string[] = [];
  for (const name of fileNames) {
    // Sanitize filename to prevent directory traversal
    const safeName = path.basename(name);
    if (!safeName.startsWith('r.') || !safeName.endsWith('.mca')) continue;

    const fullPath = path.join(regionDir, safeName);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
        deleted.push(safeName);
      } catch {}
    }
  }

  return { success: true, deleted };
}
