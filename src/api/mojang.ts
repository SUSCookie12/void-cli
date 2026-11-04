const MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

export interface MinecraftVersion {
  id: string;
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha';
  url: string;
  releaseTime: string;
}

interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: MinecraftVersion[];
}

async function mojangFetch(url: string): Promise<Response> {
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

export async function getVersionManifest(): Promise<VersionManifest> {
  const res = await mojangFetch(MANIFEST_URL);
  return res.json() as Promise<VersionManifest>;
}

export async function getVanillaReleases(): Promise<MinecraftVersion[]> {
  const manifest = await getVersionManifest();
  return manifest.versions.filter(v => v.type === 'release');
}

export async function getVanillaAllVersions(max = 50): Promise<string[]> {
  const manifest = await getVersionManifest();
  return manifest.versions.map(v => v.id).slice(0, max);
}

export async function getVanillaServerUrl(versionId: string): Promise<string> {
  const manifest = await getVersionManifest();
  const version = manifest.versions.find(v => v.id === versionId);
  if (!version) throw new Error(`Version ${versionId} not found`);

  const versionData = (await (await mojangFetch(version.url)).json()) as {
    downloads?: { server?: { url: string } };
  };

  const url = versionData?.downloads?.server?.url;
  if (!url) throw new Error(`No server JAR for version ${versionId}`);
  return url;
}
