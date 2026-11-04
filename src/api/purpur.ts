const PURPUR_API = 'https://api.purpurmc.org/v2/purpur';

export async function getPurpurVersions(): Promise<string[]> {
  const res = await fetch(PURPUR_API);
  if (!res.ok) throw new Error(`Purpur API error: ${res.status}`);
  const data = (await res.json()) as { versions: string[] };
  return [...data.versions].reverse();
}

export async function getLatestPurpurBuild(version: string): Promise<{ build: number; url: string }> {
  const res = await fetch(`${PURPUR_API}/${version}`);
  if (!res.ok) throw new Error(`Failed to fetch Purpur builds for ${version}: ${res.status}`);
  const data = (await res.json()) as { builds: Record<string, { build: number; result: string }> };
  const buildKeys = Object.keys(data.builds);
  if (!buildKeys.length) throw new Error(`No builds found for Purpur ${version}`);
  const latestKey = buildKeys[buildKeys.length - 1];
  const latest = data.builds[latestKey];
  return {
    build: latest.build,
    url: `${PURPUR_API}/${version}/${latest.build}/download`,
  };
}
