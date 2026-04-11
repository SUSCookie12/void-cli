import fs from 'node:fs/promises';
import path from 'node:path';
import { getServerDir } from '../utils/paths.js';

export interface Player {
  uuid: string;
  name: string;
}

export interface BannedPlayer extends Player {
  reason: string;
  expires: string;
}

export interface PlayerLists {
  all: Player[];
  ops: Player[];
  whitelist: Player[];
  banned: BannedPlayer[];
  online: string[];
}

export async function getPlayerLists(serverName: string): Promise<PlayerLists> {
  const dir = getServerDir(serverName);
  
  const readJson = async (file: string) => {
    try {
      const content = await fs.readFile(path.join(dir, file), 'utf-8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  };

  const opsRaw = await readJson('ops.json');
  const whitelistRaw = await readJson('whitelist.json');
  const bannedRaw = await readJson('banned-players.json');
  const cacheRaw = await readJson('usercache.json');

  const ensureArray = (val: any) => Array.isArray(val) ? val : [];

  return {
    all: ensureArray(cacheRaw).map((p: any) => ({ 
      uuid: p?.uuid || '', 
      name: p?.name || 'Unknown Player' 
    })),
    ops: ensureArray(opsRaw).map((p: any) => ({ 
      uuid: p?.uuid || '', 
      name: p?.name || '' 
    })),
    whitelist: ensureArray(whitelistRaw).map((p: any) => ({ 
      uuid: p?.uuid || '', 
      name: p?.name || '' 
    })),
    banned: ensureArray(bannedRaw).map((p: any) => ({ 
      uuid: p?.uuid || '', 
      name: p?.name || '',
      reason: p?.reason || 'No reason provided',
      expires: p?.expires || 'Never'
    })),
    online: []
  };
}
