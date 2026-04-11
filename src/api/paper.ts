const PAPER_API = 'https://api.papermc.io/v2/projects/paper';

export async function getPaperVersions(): Promise<string[]> {
  const res = await fetch(PAPER_API);
  if (!res.ok) throw new Error(`PaperMC API error: ${res.status}`);
  const data = (await res.json()) as { versions: string[] };
  // Return latest versions first (filter to only those with actual server JARs)
  return [...data.versions].reverse();
}

export async function getLatestPaperBuild(version: string): Promise<number> {
  const res = await fetch(`${PAPER_API}/versions/${version}`);
  if (!res.ok) throw new Error(`Failed to fetch Paper builds for ${version}`);
  const data = (await res.json()) as { builds: number[] };
  if (!data.builds.length) throw new Error(`No builds found for Paper ${version}`);
  return data.builds[data.builds.length - 1];
}

export async function getPaperDownloadUrl(version: string, build: number): Promise<string> {
  const fileName = `paper-${version}-${build}.jar`;
  return `${PAPER_API}/versions/${version}/builds/${build}/downloads/${fileName}`;
}

export async function getLatestPaperInfo(version: string): Promise<{ build: number; url: string }> {
  const build = await getLatestPaperBuild(version);
  const url = await getPaperDownloadUrl(version, build);
  return { build, url };
}
