const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

/**
 * Map a NeoForge maven version to the Minecraft version it belongs to.
 *
 * Legacy naming (NeoForge 20.x / 21.x): "21.1.250" -> 1.21.1, "20.6.141" -> 1.20.6,
 * "1.20.1-48.1.0" -> 1.20.1. The last number is the NeoForge build counter.
 *
 * New Minecraft naming (from the 26.x line Minecraft no longer prefixes "1."):
 * "26.1.2.107" -> 26.1.2 and "26.2.0.82" -> 26.2 (the trailing number is the build).
 */
export function parseNeoForgeMcVersion(ver: string): string | null {
  if (ver.startsWith('1.20.1-')) return '1.20.1';
  const parts = ver.split('.').map(p => Number(p));
  if (parts.length < 2 || parts.some(n => !Number.isFinite(n))) return null;
  const [major, minor, patch] = parts;
  if (major >= 25) {
    const base = `${major}.${minor}`;
    return Number.isFinite(patch) && patch !== 0 ? `${base}.${patch}` : base;
  }
  if (major < 20) return null;
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`;
}

function compareDesc(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function fetchAllVersions(): Promise<string[]> {
  const res = await fetch(`${NEOFORGE_MAVEN}/maven-metadata.xml`);
  if (!res.ok) throw new Error(`NeoForge metadata failed: ${res.status}`);
  const xml = await res.text();
  const versionRegex = /<version>([^<]+)<\/version>/g;
  const all: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = versionRegex.exec(xml)) !== null) {
    all.push(match[1]);
  }
  return all;
}

export async function getNeoForgeGameVersions(max = 50): Promise<string[]> {
  const all = await fetchAllVersions();
  const mcVersions = new Set<string>();
  for (const ver of all) {
    const mc = parseNeoForgeMcVersion(ver);
    if (mc) mcVersions.add(mc);
  }
  return Array.from(mcVersions).sort(compareDesc).slice(0, max);
}

export async function getNeoForgeInstallerInfo(mcVersion: string): Promise<{ installerUrl: string; fullVersion: string }> {
  const trimmed = mcVersion.trim();
  const all = await fetchAllVersions();

  const exact = all.find(v => v === trimmed);
  if (exact) {
    return {
      fullVersion: exact,
      installerUrl: `${NEOFORGE_MAVEN}/${exact}/neoforge-${exact}-installer.jar`,
    };
  }

  const candidates = all.filter(v => parseNeoForgeMcVersion(v) === trimmed);
  if (!candidates.length) {
    throw new Error(`No NeoForge version found for Minecraft ${mcVersion}`);
  }

  const nonBeta = candidates.filter(v => !/beta|alpha/i.test(v));
  const pool = nonBeta.length > 0 ? nonBeta : candidates;
  const fullVersion = [...pool].sort(compareDesc)[0];

  return {
    fullVersion,
    installerUrl: `${NEOFORGE_MAVEN}/${fullVersion}/neoforge-${fullVersion}-installer.jar`,
  };
}
