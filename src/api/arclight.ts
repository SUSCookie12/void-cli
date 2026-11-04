const ARCLIGHT_RELEASES = 'https://api.github.com/repos/IzzelAliz/Arclight/releases';

type GitHubRelease = {
  tag_name: string;
  assets: { name: string; browser_download_url: string }[];
};

export interface ArclightVersion {
  version: string;
  variant: 'forge' | 'neoforge';
}

export async function getArclightVersions(max = 50): Promise<ArclightVersion[]> {
  const res = await fetch(ARCLIGHT_RELEASES, {
    headers: { Accept: 'application/vnd.github.v3+json' },
  });
  if (!res.ok) throw new Error(`Arclight GitHub API error: ${res.status}`);
  const releases = (await res.json()) as GitHubRelease[];

  const seen = new Set<string>();
  const results: ArclightVersion[] = [];

  for (const release of releases) {
    for (const asset of release.assets) {
      const match = asset.name.match(/arclight-(forge|neoforge)-(\d+\.\d+(?:\.\d+)?)/);
      if (match) {
        const key = `${match[2]}-${match[1]}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ version: match[2], variant: match[1] as 'forge' | 'neoforge' });
        }
      }
    }
  }

  return results.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true })).slice(0, max);
}

export async function getArclightDownloadInfo(mcVersion: string, variant?: 'forge' | 'neoforge'): Promise<{ url: string; jarName: string }> {
  const res = await fetch(ARCLIGHT_RELEASES, {
    headers: { Accept: 'application/vnd.github.v3+json' },
  });
  if (!res.ok) throw new Error(`Arclight GitHub API error: ${res.status}`);
  const releases = (await res.json()) as GitHubRelease[];

  for (const release of releases) {
    for (const asset of release.assets) {
      if (asset.name.endsWith('.jar') && asset.name.includes(mcVersion) && !asset.name.includes('-sources')) {
        if (variant && !asset.name.includes(variant)) continue;
        return { url: asset.browser_download_url, jarName: asset.name };
      }
    }
  }

  throw new Error(`No Arclight download found for Minecraft ${mcVersion}`);
}

export function getArclightVariantLabel(variant: 'forge' | 'neoforge'): string {
  return variant === 'forge' ? 'Forge' : 'NeoForge';
}
