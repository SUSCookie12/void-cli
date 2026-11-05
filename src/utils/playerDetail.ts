import fsp from 'node:fs/promises';
import * as nbt from 'prismarine-nbt';
import path from 'node:path';
import { getServerDir } from './paths.js';
import { readProperties } from '../server/properties.js';
import { sendCommandWithResponse, getServerStatus, getServerLogs } from '../server/instance.js';

type NbtItem = {
  slot: number;
  id: string;
  count: number;
};

export type PlayerDetail = {
  uuid: string;
  name?: string;
  health?: number;
  hunger?: number;
  saturation?: number;
  xpLevel?: number;
  inventory: NbtItem[];
  enderChest: NbtItem[];
  /** Source file mtime, helpful for “stale while online” cases. */
  dataUpdatedAt?: string;
};

function normalizeUuid(uuid: string): string {
  return uuid.trim().toLowerCase();
}

function stripUuidDashes(uuid: string): string {
  return uuid.replace(/-/g, '');
}

function getTagValue(tag: any): any {
  // prismarine-nbt usually yields { type, value } wrappers
  if (tag && typeof tag === 'object' && 'value' in tag) return (tag as any).value;
  return tag;
}

function asNumber(tag: any): number | undefined {
  const v = getTagValue(tag);
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

function parseItemList(listTag: any): NbtItem[] {
  const list = getTagValue(listTag);
  if (!Array.isArray(list)) return [];

  const items: NbtItem[] = [];
  for (const entry of list) {
    const e = getTagValue(entry);
    if (!e || typeof e !== 'object') continue;

    // Try multiple field name conventions (pre-1.20.5 vs 1.20.5+)
    const slot = asNumber(e?.Slot) ?? asNumber(e?.slot);
    const id = getTagValue(e?.id) || getTagValue(e?.item) || '';
    const count = asNumber(e?.Count) ?? asNumber(e?.count) ?? 1;

    if (typeof slot !== 'number' || typeof id !== 'string') continue;
    if (!id || id === 'minecraft:air') continue;
    items.push({ slot, id, count });
  }

  return items.sort((a, b) => a.slot - b.slot);
}

function parseNbtNumber(val: string): number {
  const cleaned = val.replace(/[bsLfd]/g, '').trim();
  const num = Number(cleaned);
  return isNaN(num) ? 0 : num;
}

function parseNbtItemList(text: string): NbtItem[] {
  const items: NbtItem[] = [];
  const compoundRegex = /\{\s*Slot\s*:\s*([^,]+),\s*id\s*:\s*"([^"]+)",\s*Count\s*:\s*([^}]+)\s*\}/gi;
  let match;
  while ((match = compoundRegex.exec(text)) !== null) {
    items.push({
      slot: parseNbtNumber(match[1]),
      id: match[2],
      count: parseNbtNumber(match[3]),
    });
  }
  return items.sort((a, b) => a.slot - b.slot);
}

async function fetchDataTag(serverName: string, target: string, tag: string, isUuid: boolean): Promise<string> {
  const escaped = isUuid
    ? target.replace(/-/g, '\\-?')
    : target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const responsePattern = new RegExp(`${escaped}\\s+has the following entity data:`);

  const recentLogs = getServerLogs(serverName);
  for (const log of recentLogs) {
    const match = log.text.match(responsePattern);
    if (match) return log.text;
  }

  return sendCommandWithResponse(
    serverName,
    `/data get entity ${target} ${tag}`,
    responsePattern,
    3000,
  );
}

async function getOnlinePlayerDetail(serverName: string, uuid: string, name?: string): Promise<PlayerDetail | null> {
  const status = getServerStatus(serverName);
  if (status !== 'online') return null;

  const normalized = normalizeUuid(uuid);
  const target = name || normalized;
  const isUuid = !name;

  try {
    const invText = await fetchDataTag(serverName, target, 'Inventory', isUuid);
    const enderText = await fetchDataTag(serverName, target, 'EnderItems', isUuid);

    return {
      uuid: normalized,
      name: name,
      inventory: parseNbtItemList(invText),
      enderChest: parseNbtItemList(enderText),
    };
  } catch {
    return null;
  }
}

export async function getPlayerDetail(serverName: string, uuid: string, playerName?: string): Promise<PlayerDetail> {
  const serverDir = getServerDir(serverName);
  const props = await readProperties(serverName);
  const worldName = (props['level-name'] || 'world').trim() || 'world';

  const normalized = normalizeUuid(uuid);
  const normalizedNoDash = stripUuidDashes(normalized);
  const worldDir = path.join(serverDir, worldName);
  const playerDir = path.join(worldDir, 'playerdata');

  const candidates = [
    // Standard Minecraft: world/playerdata/<uuid>.dat
    path.join(playerDir, `${normalizedNoDash}.dat`),
    path.join(playerDir, `${normalized}.dat`),
    // Spigot/Paper layout: world/players/data/<uuid>.dat
    path.join(worldDir, 'players', 'data', `${normalizedNoDash}.dat`),
    path.join(worldDir, 'players', 'data', `${normalized}.dat`),
    // With _old variants
    path.join(playerDir, `${normalizedNoDash}.dat_old`),
    path.join(playerDir, `${normalized}.dat_old`),
    path.join(worldDir, 'players', 'data', `${normalizedNoDash}.dat_old`),
    path.join(worldDir, 'players', 'data', `${normalized}.dat_old`),
  ];

  let raw: Buffer | null = null;
  let stat: { mtime: Date } | null = null;
  let chosenPath: string | null = null;

  for (const p of candidates) {
    try {
      raw = await fsp.readFile(p);
      stat = await fsp.stat(p);
      chosenPath = p;
      break;
    } catch {
      // keep trying
    }
  }

  if (!raw || !stat || !chosenPath) {
    const online = await getOnlinePlayerDetail(serverName, uuid, playerName);
    if (online) return online;

    let dirContents = 'N/A';
    for (const d of [playerDir, path.join(worldDir, 'players', 'data')]) {
      try {
        const files = await fsp.readdir(d);
        dirContents = `${d}: ${files.join(', ')}`;
        break;
      } catch (e) { console.warn("[swallowed error in playerDetail.ts]:", e); }
    }

    throw new Error(
      `Player data not found. Checked:\n` +
      `  dirs: ${playerDir}, ${path.join(worldDir, 'players', 'data')}\n` +
      `  files found: ${dirContents}\n` +
      `  candidates: ${candidates.join(', ')}\n` +
      `  uuid: ${normalized} (name: ${playerName || '?'})`,
    );
  }

  // Lazy import so normal flows don’t pay cost
  const nbtModule = (nbt as any).default || (nbt as any);
  const { parse, simplify } = nbtModule;

  // `.dat` is gzipped NBT
  const parsed = await new Promise<any>((resolve, reject) => {
    parse(raw, (err: any, data: any) => (err ? reject(err) : resolve(data)));
  });
  const data = simplify(parsed);

  return {
    uuid: normalized,
    name: playerName,
    health: asNumber(data?.Health),
    hunger: asNumber(data?.foodLevel),
    saturation: asNumber(data?.foodSaturationLevel),
    xpLevel: asNumber(data?.XpLevel),
    inventory: parseItemList(data?.Inventory),
    enderChest: parseItemList(data?.EnderItems),
    dataUpdatedAt: stat.mtime.toISOString(),
  };
}

