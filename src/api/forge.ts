import { getVanillaReleases } from './mojang.js';

async function apiFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getForgeGameVersions(max = 50): Promise<string[]> {
  const res = await apiFetch('https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json');
  const data = (await res.json()) as { promos: Record<string, string> };
  const promos = data.promos || {};
  
  const forgeMcVersions = new Set<string>();
  for (const key of Object.keys(promos)) {
    const match = key.match(/^(.+)-(latest|recommended)$/);
    if (match) {
      forgeMcVersions.add(match[1]);
    }
  }

  // Get chronological releases from Mojang
  const releases = await getVanillaReleases();
  const ordered = releases
    .map(r => r.id)
    .filter(v => forgeMcVersions.has(v));
    
  return ordered.slice(0, max);
}

export async function getForgeVersionForGame(mcVersion: string): Promise<string> {
  const res = await apiFetch('https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json');
  const data = (await res.json()) as { promos: Record<string, string> };
  const promos = data.promos || {};
  
  const recKey = `${mcVersion}-recommended`;
  const latKey = `${mcVersion}-latest`;
  
  if (promos[recKey]) return promos[recKey];
  if (promos[latKey]) return promos[latKey];
  
  throw new Error(`No Forge version found for Minecraft ${mcVersion}`);
}
