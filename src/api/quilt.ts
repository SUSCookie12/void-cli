const QUILT_META = 'https://meta.quiltmc.org/v3';

type QuiltGameVersion = { version: string; stable: boolean };

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

export async function getQuiltGameVersions(max = 50): Promise<string[]> {
  const data = await (await apiFetch(`${QUILT_META}/versions/game`)).json() as QuiltGameVersion[];
  return data.filter(g => g.stable).map(g => g.version).slice(0, max);
}

export async function getQuiltAllVersions(max = 50): Promise<string[]> {
  const data = await (await apiFetch(`${QUILT_META}/versions/game`)).json() as QuiltGameVersion[];
  return data.map(g => g.version).slice(0, max);
}

type LoaderEntry = { loader: { version: string; stable: boolean } };
type InstallerEntry = { url: string; version: string; stable: boolean };

export async function getQuiltInstallerInfo(mcVersion: string): Promise<{ installerUrl: string; loaderVersion: string }> {
  const [loaderRes, installerRes] = await Promise.all([
    fetch(`${QUILT_META}/versions/loader/${encodeURIComponent(mcVersion)}`),
    fetch(`${QUILT_META}/versions/installer`),
  ]);

  if (!loaderRes.ok) throw new Error(`Quilt loader list failed: ${loaderRes.status}`);
  if (!installerRes.ok) throw new Error(`Quilt installer list failed: ${installerRes.status}`);

  const loaderEntries = (await loaderRes.json()) as LoaderEntry[];
  const installerEntries = (await installerRes.json()) as InstallerEntry[];

  const stableLoader = loaderEntries.find(e => e.loader?.stable);
  const loaderVersion = stableLoader?.loader?.version || loaderEntries[0]?.loader?.version;
  if (!loaderVersion) throw new Error(`No Quilt loader found for Minecraft ${mcVersion}`);

  const stableInstaller = installerEntries.find(e => e.stable);
  const installer = stableInstaller || installerEntries[0];
  if (!installer) throw new Error('No Quilt installer found');

  return { installerUrl: installer.url, loaderVersion };
}
