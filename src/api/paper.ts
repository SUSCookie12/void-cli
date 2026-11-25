const PAPER_API = 'https://fill.papermc.io/v3/projects/paper';
const USER_AGENT = 'VoidMC/1.0 (contact@voidmc.net)';

async function apiFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getPaperVersions(): Promise<string[]> {
  const res = await apiFetch(PAPER_API);
  const data = await res.json() as { versions?: unknown };
  if (!data || !data.versions) return [];

  const all: string[] = [];
  const versions = data.versions;

  // New Paper v3 shape: array of { version: { id, support, java }, builds: number[] }.
  if (Array.isArray(versions)) {
    for (const item of versions) {
      if (typeof item === 'string') {
        all.push(item);
      } else if (item && typeof item === 'object') {
        const id = (item as { version?: { id?: unknown } })?.version?.id;
        if (typeof id === 'string') all.push(id);
      }
    }
  } else if (versions && typeof versions === 'object') {
    // Legacy shape: object/array of version strings.
    for (const group of Object.values(versions as Record<string, unknown>)) {
      if (Array.isArray(group)) {
        for (const v of group) all.push(String(v));
      }
    }
  }

  // Drop pre-releases (e.g. "26.2-rc-2") and sort semantic versioning descending.
  return [...new Set(all)].filter(v => !v.includes('-')).sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const da = pa[i] ?? 0;
      const db = pb[i] ?? 0;
      if (da !== db) return db - da;
    }
    return 0;
  });
}

export async function getLatestPaperBuild(version: string): Promise<number> {
  const info = await getLatestPaperInfo(version);
  return info.build;
}

export async function getPaperDownloadUrl(version: string, _build?: number): Promise<string> {
  const info = await getLatestPaperInfo(version);
  return info.url;
}

export async function getLatestPaperInfo(version: string): Promise<{ build: number; url: string }> {
  try {
    const res = await apiFetch(`${PAPER_API}/versions/${encodeURIComponent(version)}/builds/latest`);
    const data = (await res.json()) as { id?: number; downloads?: Record<string, { url?: string; name?: string }> };
    const url = data?.downloads?.['server:default']?.url;
    if (data?.id && url) {
      return { build: data.id, url };
    }
  } catch (e) {
    // Fall through to the version-based fallback below.
  }

  // Fallback: read the newest build number from /versions/{version}, then fetch
  // its download info. (Paper v3's /builds endpoint does not return objects.)
  const verRes = await apiFetch(`${PAPER_API}/versions/${encodeURIComponent(version)}`);
  const verData = (await verRes.json()) as { builds?: number[] };
  const build = Array.isArray(verData.builds) && verData.builds.length ? verData.builds[0] : null;
  if (build == null) throw new Error(`No builds found for Paper ${version}`);

  const buildRes = await apiFetch(`${PAPER_API}/versions/${encodeURIComponent(version)}/builds/${build}`);
  const buildData = (await buildRes.json()) as { id?: number; downloads?: Record<string, { url?: string }> };
  const url = buildData?.downloads?.['server:default']?.url;
  if (!buildData?.id || !url) throw new Error(`No download url found for Paper ${version}`);
  return { build: buildData.id, url };
}
