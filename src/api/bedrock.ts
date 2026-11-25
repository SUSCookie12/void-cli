import { fetchWithTimeout } from './fetch.js';

const BDS_LINKS_API = 'https://net-secondary.web.minecraft-services.net/api/v1.0/download/links';
const BDS_VERSIONS_ARCHIVE_URL = 'https://raw.githubusercontent.com/Bedrock-OSS/BDS-Versions/main/versions.json';
const BDS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) VoidServer/1.0';

const FALLBACK_BEDROCK_VERSIONS = [
  '1.26.66.1',
  '1.26.65.1',
  '1.26.63.1',
  '1.26.62.1',
  '1.26.61.1',
  '1.26.60.6',
  '1.26.52.3',
  '1.26.51.1',
  '1.26.45.1',
  '1.26.44.3',
];

interface DownloadLinkEntry {
  downloadType: string;
  downloadUrl: string;
}

interface BdsLinksResponse {
  result?: {
    links?: DownloadLinkEntry[];
  };
}

interface BdsArchivePlatform {
  stable?: string;
  preview?: string;
  versions?: string[];
  preview_versions?: string[];
}

interface BdsArchiveResponse {
  windows?: BdsArchivePlatform;
  linux?: BdsArchivePlatform;
}

interface CachedBdsLinks {
  fetchedAt: number;
  winUrl: string | null;
  linuxUrl: string | null;
  version: string | null;
  previewWinUrl: string | null;
  previewLinuxUrl: string | null;
  previewVersion: string | null;
}

let cachedLatest: CachedBdsLinks | null = null;
let cachedArchive: { fetchedAt: number; versions: string[] } | null = null;

function extractVersionFromUrl(url: string): string | null {
  const match = url.match(/bedrock-server-([\d.]+)\.zip/i);
  return match ? match[1] : null;
}

async function fetchLatestBdsLinks(): Promise<CachedBdsLinks> {
  if (cachedLatest && Date.now() - cachedLatest.fetchedAt < 10 * 60 * 1000) {
    return cachedLatest;
  }

  try {
    const res = await fetchWithTimeout(BDS_LINKS_API, {
      headers: {
        'User-Agent': BDS_UA,
        Accept: 'application/json',
      },
    });
    if (res.ok) {
      const json = (await res.json()) as BdsLinksResponse;
      const links = json?.result?.links || [];
      const winUrl = links.find(l => l.downloadType === 'serverBedrockWindows')?.downloadUrl || null;
      const linuxUrl = links.find(l => l.downloadType === 'serverBedrockLinux')?.downloadUrl || null;
      const previewWinUrl = links.find(l => l.downloadType === 'serverBedrockPreviewWindows')?.downloadUrl || null;
      const previewLinuxUrl = links.find(l => l.downloadType === 'serverBedrockPreviewLinux')?.downloadUrl || null;

      const version =
        (winUrl ? extractVersionFromUrl(winUrl) : null) ||
        (linuxUrl ? extractVersionFromUrl(linuxUrl) : null);
      const previewVersion =
        (previewWinUrl ? extractVersionFromUrl(previewWinUrl) : null) ||
        (previewLinuxUrl ? extractVersionFromUrl(previewLinuxUrl) : null);

      cachedLatest = {
        fetchedAt: Date.now(),
        winUrl,
        linuxUrl,
        version,
        previewWinUrl,
        previewLinuxUrl,
        previewVersion,
      };
      return cachedLatest;
    }
  } catch {
    // Fall back to archive/defaults
  }

  return {
    fetchedAt: 0,
    winUrl: null,
    linuxUrl: null,
    version: null,
    previewWinUrl: null,
    previewLinuxUrl: null,
    previewVersion: null,
  };
}

async function fetchHistoricalBdsVersions(): Promise<string[]> {
  if (cachedArchive && Date.now() - cachedArchive.fetchedAt < 15 * 60 * 1000) {
    return cachedArchive.versions;
  }
  try {
    const res = await fetchWithTimeout(BDS_VERSIONS_ARCHIVE_URL, {
      headers: { 'User-Agent': BDS_UA, Accept: 'application/json' },
    });
    if (res.ok) {
      const json = (await res.json()) as BdsArchiveResponse;
      const plat = process.platform === 'win32' ? json.windows : json.linux;
      const list = Array.isArray(plat?.versions) ? [...plat.versions].reverse() : [];
      if (list.length > 0) {
        cachedArchive = { fetchedAt: Date.now(), versions: list };
        return list;
      }
    }
  } catch {
    // Fall back to defaults
  }
  return [];
}

async function urlExists(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': BDS_UA },
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export async function getBedrockVersions(): Promise<string[]> {
  const [latest, historical] = await Promise.all([
    fetchLatestBdsLinks(),
    fetchHistoricalBdsVersions(),
  ]);

  const seen = new Set<string>();
  const ordered: string[] = [];
  const pushUnique = (v: string | null | undefined) => {
    if (!v || seen.has(v)) return;
    seen.add(v);
    ordered.push(v);
  };

  pushUnique(latest.version);
  for (const v of historical) {
    pushUnique(v);
  }
  if (ordered.length === 0) {
    for (const v of FALLBACK_BEDROCK_VERSIONS) {
      pushUnique(v);
    }
  }
  return ordered;
}

export async function getBedrockDownloadInfo(requestedVersion?: string): Promise<{
  version: string;
  url: string;
  platform: 'win' | 'linux';
}> {
  const isWin = process.platform === 'win32';
  const platform: 'win' | 'linux' = isWin ? 'win' : 'linux';
  const latest = await fetchLatestBdsLinks();
  const cleanRequested = (requestedVersion || '').replace(/\s*\(Preview\)\s*/i, '').trim();
  const wantsPreview = /\(Preview\)/i.test(requestedVersion || '');

  // 1. Exact match for Preview
  if (wantsPreview || (cleanRequested && latest.previewVersion && cleanRequested === latest.previewVersion)) {
    const previewUrl = isWin ? latest.previewWinUrl : latest.previewLinuxUrl;
    if (previewUrl && latest.previewVersion) {
      return { version: latest.previewVersion, url: previewUrl, platform };
    }
  }

  // 2. Empty, 'latest', or matches live stable version -> use live Mojang URL directly
  const liveReleaseUrl = isWin ? latest.winUrl : latest.linuxUrl;
  if (!cleanRequested || cleanRequested === 'latest' || (latest.version && cleanRequested === latest.version)) {
    if (liveReleaseUrl && latest.version) {
      return { version: latest.version, url: liveReleaseUrl, platform };
    }
  }

  // 3. Specific historical version requested -> verify URL exists on Mojang CDN; if 404, fall back to live official release
  if (cleanRequested) {
    const folder = isWin ? 'bin-win' : 'bin-linux';
    const candidateUrl = `https://www.minecraft.net/bedrockdedicatedserver/${folder}/bedrock-server-${cleanRequested}.zip`;
    if (await urlExists(candidateUrl)) {
      return { version: cleanRequested, url: candidateUrl, platform };
    }
  }

  if (liveReleaseUrl && latest.version) {
    return { version: latest.version, url: liveReleaseUrl, platform };
  }

  const folder = isWin ? 'bin-win' : 'bin-linux';
  const fallbackVer = FALLBACK_BEDROCK_VERSIONS[0];
  return {
    version: fallbackVer,
    url: `https://www.minecraft.net/bedrockdedicatedserver/${folder}/bedrock-server-${fallbackVer}.zip`,
    platform,
  };
}
