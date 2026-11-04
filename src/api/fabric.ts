const META = 'https://meta.fabricmc.net/v2';

export type FabricGameVersion = { version: string; stable: boolean };

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

export async function getFabricGameVersions(max = 50): Promise<string[]> {
  const res = await apiFetch(`${META}/versions/game`);
  const data = (await res.json()) as FabricGameVersion[];
  return data.filter(g => g.stable).map(g => g.version).slice(0, max);
}

export async function getFabricAllVersions(max = 50): Promise<string[]> {
  const res = await apiFetch(`${META}/versions/game`);
  const data = (await res.json()) as FabricGameVersion[];
  return data.map(g => g.version).slice(0, max);
}

type LoaderEntry = { loader: { version: string; stable: boolean } };

export async function getLatestStableLoaderForGame(gameVersion: string): Promise<string> {
  const res = await apiFetch(`${META}/versions/loader/${encodeURIComponent(gameVersion)}`);
  const entries = (await res.json()) as LoaderEntry[];
  const stable = entries.find(e => e.loader?.stable);
  if (stable?.loader?.version) return stable.loader.version;
  if (entries[0]?.loader?.version) return entries[0].loader.version;
  throw new Error(`No Fabric loader found for Minecraft ${gameVersion}`);
}

type InstallerEntry = { url: string; version: string; stable: boolean };

export async function getLatestStableFabricInstaller(): Promise<{ url: string; version: string }> {
  const res = await apiFetch(`${META}/versions/installer`);
  const data = (await res.json()) as InstallerEntry[];
  const stable = data.find(e => e.stable);
  if (stable) return { url: stable.url, version: stable.version };
  if (data[0]) return { url: data[0].url, version: data[0].version };
  throw new Error('No Fabric installer found');
}
