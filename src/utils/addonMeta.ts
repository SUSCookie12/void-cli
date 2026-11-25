import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { getServerDir, getVoidDir } from './paths.js';

export type AddonKind = 'plugin' | 'mod';

export interface AddonMetadata {
  name?: string;
  description?: string;
  author?: string;
  iconUrl?: string;
  version?: string;
  source?: string;
  projectId?: string;
  sha1?: string;
  notFound?: boolean;
  checkedAt?: number;
}

export interface AddonInfo {
  name: string;
  fileName: string;
  enabled: boolean;
  size: number;
  description?: string;
  author?: string;
  iconUrl?: string;
  version?: string;
  source?: string;
  projectId?: string;
}

const inFlightResolutions = new Set<string>();

export function normalizeAddonKey(fileName: string): string {
  return fileName.replace(/\.disabled$/i, '');
}

export function fallbackAddonName(fileName: string): string {
  return fileName.replace(/\.disabled$/i, '').replace(/\.jar$/i, '');
}

function getAddonSubdir(serverName: string, kind: AddonKind): string {
  return path.join(getServerDir(serverName), kind === 'plugin' ? 'plugins' : 'mods');
}

function getMetaFilePath(serverName: string, kind: AddonKind): string {
  const metaDir = path.join(getVoidDir(), 'addon-meta');
  if (!fs.existsSync(metaDir)) {
    fs.mkdirSync(metaDir, { recursive: true });
  }
  const safeServer = serverName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(metaDir, `${safeServer}-${kind}.json`);
}

function readMetaStore(serverName: string, kind: AddonKind): Record<string, AddonMetadata> {
  const filePath = getMetaFilePath(serverName, kind);
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeMetaStore(serverName: string, kind: AddonKind, store: Record<string, AddonMetadata>): void {
  const filePath = getMetaFilePath(serverName, kind);
  try {
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // Non-critical metadata cache write failure
  }
}

export function computeFileSha1(filePath: string): string | undefined {
  try {
    const hash = crypto.createHash('sha1');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex').toLowerCase();
  } catch {
    return undefined;
  }
}

export function saveAddonMetadata(
  serverName: string,
  kind: AddonKind,
  fileName: string,
  meta: Partial<AddonMetadata>,
  fullFilePath?: string,
): void {
  const key = normalizeAddonKey(fileName);
  const store = readMetaStore(serverName, kind);
  const sha1 = meta.sha1 || (fullFilePath ? computeFileSha1(fullFilePath) : store[key]?.sha1);
  store[key] = {
    ...store[key],
    ...meta,
    ...(sha1 ? { sha1 } : {}),
    notFound: false,
    checkedAt: Date.now(),
  };
  writeMetaStore(serverName, kind, store);
}

export function removeAddonMetadata(serverName: string, kind: AddonKind, fileName: string): void {
  const key = normalizeAddonKey(fileName);
  const store = readMetaStore(serverName, kind);
  if (key in store) {
    delete store[key];
    writeMetaStore(serverName, kind, store);
  }
}

export function listAddons(serverName: string, kind: AddonKind): AddonInfo[] {
  const dir = getAddonSubdir(serverName, kind);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const store = readMetaStore(serverName, kind);
  const files = fs.readdirSync(dir);
  const items: AddonInfo[] = [];

  for (const file of files) {
    if (file.endsWith('.jar') || file.endsWith('.jar.disabled')) {
      const fullPath = path.join(dir, file);
      let stats: fs.Stats;
      try {
        stats = fs.statSync(fullPath);
        if (!stats.isFile()) continue;
      } catch {
        continue;
      }

      const key = normalizeAddonKey(file);
      const cached = store[key];
      const displayName = cached?.name?.trim() || fallbackAddonName(file);

      items.push({
        name: displayName,
        fileName: file,
        enabled: file.endsWith('.jar'),
        size: stats.size,
        ...(cached?.description ? { description: cached.description } : {}),
        ...(cached?.author ? { author: cached.author } : {}),
        ...(cached?.iconUrl ? { iconUrl: cached.iconUrl } : {}),
        ...(cached?.version ? { version: cached.version } : {}),
        ...(cached?.source ? { source: cached.source } : {}),
        ...(cached?.projectId ? { projectId: cached.projectId } : {}),
      });
    }
  }

  return items;
}

export function toggleAddon(serverName: string, kind: AddonKind, fileName: string, enable: boolean): void {
  const dir = getAddonSubdir(serverName, kind);
  const oldPath = path.join(dir, fileName);

  let newFileName = fileName;
  if (enable && fileName.endsWith('.disabled')) {
    newFileName = fileName.replace('.disabled', '');
  } else if (!enable && !fileName.endsWith('.disabled')) {
    newFileName = fileName + '.disabled';
  }

  const newPath = path.join(dir, newFileName);

  if (fs.existsSync(oldPath)) {
    fs.renameSync(oldPath, newPath);
  } else {
    throw new Error(`${kind === 'plugin' ? 'Plugin' : 'Mod'} file not found`);
  }
}

function normalizeTitleForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function stripFilenameVersionForSearch(fileName: string): string {
  const base = fallbackAddonName(fileName);
  // Remove trailing version segments like -1.2.3, _v2.0, -mc1.21.1, +build.4
  return base
    .replace(/[-_+](?:mc)?v?\d+(?:\.\d+)*(?:[-+._a-z0-9]*)?$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

function extractIconDataUrl(zip: AdmZip, iconPath?: string): string | undefined {
  if (!iconPath) return undefined;
  const clean = iconPath.replace(/^\/+/, '');
  const entry = zip.getEntry(clean);
  if (!entry || entry.isDirectory) return undefined;
  try {
    const buf = entry.getData();
    if (!buf || buf.length === 0 || buf.length > 128 * 1024) return undefined;
    const ext = path.extname(clean).toLowerCase();
    const mime =
      ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return undefined;
  }
}

function extractSimpleYamlValue(raw: string, key: string): string | undefined {
  const match = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'mi'));
  if (!match) return undefined;
  let val = match[1].trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return val.trim() || undefined;
}

function inspectJarManifest(fullPath: string): Partial<AddonMetadata> | null {
  try {
    const zip = new AdmZip(fullPath);

    // 1. Fabric (fabric.mod.json)
    const fabricEntry = zip.getEntry('fabric.mod.json');
    if (fabricEntry) {
      try {
        const data = JSON.parse(fabricEntry.getData().toString('utf-8'));
        const authors = Array.isArray(data.authors)
          ? data.authors.map((a: any) => (typeof a === 'string' ? a : a?.name)).filter(Boolean).join(', ')
          : typeof data.authors === 'string'
            ? data.authors
            : undefined;
        return {
          name: typeof data.name === 'string' ? data.name.trim() : undefined,
          description: typeof data.description === 'string' ? data.description.trim() : undefined,
          author: authors || undefined,
          version: typeof data.version === 'string' ? data.version.trim() : undefined,
          iconUrl: extractIconDataUrl(zip, typeof data.icon === 'string' ? data.icon : undefined),
          source: 'jar',
        };
      } catch {}
    }

    // 2. Quilt (quilt.mod.json)
    const quiltEntry = zip.getEntry('quilt.mod.json');
    if (quiltEntry) {
      try {
        const data = JSON.parse(quiltEntry.getData().toString('utf-8'));
        const meta = data?.quilt_loader?.metadata;
        if (meta) {
          const contributors = meta.contributors && typeof meta.contributors === 'object'
            ? Object.keys(meta.contributors).join(', ')
            : undefined;
          return {
            name: typeof meta.name === 'string' ? meta.name.trim() : undefined,
            description: typeof meta.description === 'string' ? meta.description.trim() : undefined,
            author: contributors || undefined,
            version: typeof data?.quilt_loader?.version === 'string' ? data.quilt_loader.version : undefined,
            iconUrl: extractIconDataUrl(zip, typeof meta.icon === 'string' ? meta.icon : undefined),
            source: 'jar',
          };
        }
      } catch {}
    }

    // 3. NeoForge / Forge mods.toml
    const tomlEntry = zip.getEntry('META-INF/neoforge.mods.toml') || zip.getEntry('META-INF/mods.toml');
    if (tomlEntry) {
      const raw = tomlEntry.getData().toString('utf-8');
      const displayName = raw.match(/displayName\s*=\s*["']([^"'\n]+)["']/i)?.[1]?.trim();
      const authors = raw.match(/authors\s*=\s*["']([^"'\n]+)["']/i)?.[1]?.trim();
      const logoFile = raw.match(/logoFile\s*=\s*["']([^"'\n]+)["']/i)?.[1]?.trim();
      const multilineDesc = raw.match(/description\s*=\s*'''([\s\S]*?)'''/i)?.[1]?.trim();
      const singleDesc = raw.match(/description\s*=\s*["']([^"'\n]+)["']/i)?.[1]?.trim();
      if (displayName || multilineDesc || singleDesc) {
        return {
          name: displayName,
          description: (multilineDesc || singleDesc)?.replace(/\s+/g, ' ').trim(),
          author: authors,
          iconUrl: extractIconDataUrl(zip, logoFile),
          source: 'jar',
        };
      }
    }

    // 4. Paper / Bukkit plugin.yml
    const pluginYml = zip.getEntry('paper-plugin.yml') || zip.getEntry('plugin.yml');
    if (pluginYml) {
      const raw = pluginYml.getData().toString('utf-8');
      const name = extractSimpleYamlValue(raw, 'name');
      const description = extractSimpleYamlValue(raw, 'description');
      const version = extractSimpleYamlValue(raw, 'version');
      let author = extractSimpleYamlValue(raw, 'author');
      if (!author) {
        const authorsInline = raw.match(/^authors:\s*\[([^\]]+)\]/mi)?.[1];
        if (authorsInline) {
          author = authorsInline.replace(/["']/g, '').trim();
        }
      }
      if (name || description) {
        return {
          name,
          description,
          author,
          version,
          source: 'jar',
        };
      }
    }
  } catch {
    // Corrupted or non-standard jar
  }
  return null;
}

async function fetchModrinthByHashes(hashes: string[]): Promise<{
  versionsByHash: Record<string, any>;
  projectsById: Record<string, any>;
  authorsByTeam: Record<string, string>;
}> {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'VoidServers/1.0',
  };

  const versionsByHash: Record<string, any> = {};
  const projectsById: Record<string, any> = {};
  const authorsByTeam: Record<string, string> = {};

  if (hashes.length === 0) {
    return { versionsByHash, projectsById, authorsByTeam };
  }

  try {
    const res = await fetch('https://api.modrinth.com/v2/version_files', {
      method: 'POST',
      headers,
      body: JSON.stringify({ hashes, algorithm: 'sha1' }),
    });
    if (!res.ok) return { versionsByHash, projectsById, authorsByTeam };

    const verMap = (await res.json()) as Record<string, any>;
    Object.assign(versionsByHash, verMap);

    const projectIds = [...new Set(Object.values(verMap).map((v: any) => v?.project_id).filter(Boolean))];
    if (projectIds.length === 0) return { versionsByHash, projectsById, authorsByTeam };

    const projRes = await fetch(
      `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`,
      { headers },
    );
    if (projRes.ok) {
      const projects = (await projRes.json()) as any[];
      for (const p of projects) {
        if (p?.id) projectsById[p.id] = p;
      }

      const teamIds = [...new Set(projects.map((p: any) => p?.team).filter(Boolean))];
      if (teamIds.length > 0) {
        try {
          const teamRes = await fetch(
            `https://api.modrinth.com/v2/teams?ids=${encodeURIComponent(JSON.stringify(teamIds))}`,
            { headers },
          );
          if (teamRes.ok) {
            const teams = (await teamRes.json()) as any[][];
            for (const members of teams) {
              if (!Array.isArray(members) || members.length === 0) continue;
              const teamId = members[0]?.team_id;
              const owner = members.find((m) => String(m?.role).toLowerCase() === 'owner') || members[0];
              const username = owner?.user?.username;
              if (teamId && username) {
                authorsByTeam[teamId] = username;
              }
            }
          }
        } catch {
          // Optional team lookup failed
        }
      }
    }
  } catch {
    // Offline or API error
  }

  return { versionsByHash, projectsById, authorsByTeam };
}

async function searchExactMatchOnline(queryName: string, kind: AddonKind): Promise<Partial<AddonMetadata> | null> {
  const cleanQuery = queryName.trim();
  if (!cleanQuery || cleanQuery.length < 2) return null;
  const targetNorm = normalizeTitleForMatch(cleanQuery);
  if (!targetNorm) return null;

  const headers = { Accept: 'application/json', 'User-Agent': 'VoidServers/1.0' };

  // Check Modrinth search first
  try {
    const facets = kind === 'plugin'
      ? [['project_type:mod'], ['categories:spigot', 'categories:paper', 'categories:bukkit', 'categories:purpur']]
      : [['project_type:mod']];
    const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(cleanQuery)}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=5&index=downloads`;
    const res = await fetch(url, { headers });
    if (res.ok) {
      const data = (await res.json()) as { hits?: any[] };
      const hits = Array.isArray(data?.hits) ? data.hits : [];
      const exact = hits.find((h: any) => {
        const hitTitle = normalizeTitleForMatch(h?.title || '');
        const hitSlug = normalizeTitleForMatch(h?.slug || '');
        return hitTitle === targetNorm || hitSlug === targetNorm;
      });
      if (exact) {
        return {
          name: exact.title,
          description: exact.description,
          author: exact.author,
          iconUrl: exact.icon_url || undefined,
          projectId: exact.project_id,
          source: 'modrinth',
        };
      }
    }
  } catch {}

  // For plugins, also check PaperMC Hangar if Modrinth missed
  if (kind === 'plugin') {
    try {
      const res = await fetch(`https://hangar.papermc.io/api/v1/projects?q=${encodeURIComponent(cleanQuery)}&limit=5`, { headers });
      if (res.ok) {
        const data = (await res.json()) as { result?: any[] };
        const results = Array.isArray(data?.result) ? data.result : [];
        const exact = results.find((h: any) => {
          const hitName = normalizeTitleForMatch(h?.name || '');
          const hitSlug = normalizeTitleForMatch(h?.namespace?.slug || '');
          return hitName === targetNorm || hitSlug === targetNorm;
        });
        if (exact) {
          return {
            name: exact.name,
            description: exact.description,
            author: exact.namespace?.owner,
            iconUrl: exact.avatarUrl || undefined,
            projectId: `${exact.namespace?.owner}/${exact.namespace?.slug}`,
            source: 'hangar',
          };
        }
      }
    } catch {}
  }

  return null;
}

/**
 * Resolves metadata (icon, title, author, description) for manually uploaded or
 * uncached .jar addons via Modrinth SHA-1 lookup, jar manifest inspection, and exact-title fallback search.
 * Returns `true` if any metadata changed on disk.
 */
export async function resolveMissingAddonMetadata(serverName: string, kind: AddonKind): Promise<boolean> {
  const lockKey = `${serverName}::${kind}`;
  if (inFlightResolutions.has(lockKey)) return false;
  inFlightResolutions.add(lockKey);

  try {
    const dir = getAddonSubdir(serverName, kind);
    if (!fs.existsSync(dir)) return false;

    const store = readMetaStore(serverName, kind);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled'));

    const pending: Array<{ file: string; key: string; fullPath: string; sha1: string }> = [];
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        if (!fs.statSync(fullPath).isFile()) continue;
      } catch {
        continue;
      }

      const key = normalizeAddonKey(file);
      const cached = store[key];
      const sha1 = computeFileSha1(fullPath);
      if (!sha1) continue;

      // Skip if already checked for this exact file hash (either enriched or confirmed not found)
      if (cached && cached.sha1 === sha1 && (cached.name || cached.notFound)) {
        continue;
      }
      // If installed before hashing existed (only metadata saved without sha1), stamp sha1 cleanly and skip re-query if full meta already exists
      if (cached && !cached.sha1 && cached.name && cached.iconUrl && cached.description) {
        store[key] = { ...cached, sha1 };
        continue;
      }

      pending.push({ file, key, fullPath, sha1 });
    }

    if (pending.length === 0) {
      writeMetaStore(serverName, kind, store);
      return false;
    }

    let changed = false;
    const { versionsByHash, projectsById, authorsByTeam } = await fetchModrinthByHashes(pending.map((p) => p.sha1));

    for (const item of pending) {
      const ver = versionsByHash[item.sha1];
      const proj = ver?.project_id ? projectsById[ver.project_id] : null;

      if (proj) {
        store[item.key] = {
          name: proj.title || store[item.key]?.name,
          description: proj.description || store[item.key]?.description,
          author: (proj.team ? authorsByTeam[proj.team] : undefined) || store[item.key]?.author,
          iconUrl: proj.icon_url || store[item.key]?.iconUrl,
          version: ver?.version_number || store[item.key]?.version,
          source: 'modrinth',
          projectId: proj.id,
          sha1: item.sha1,
          notFound: false,
          checkedAt: Date.now(),
        };
        changed = true;
        continue;
      }

      // Fallback 1: inspect jar manifest (plugin.yml / fabric.mod.json / mods.toml)
      const jarMeta = inspectJarManifest(item.fullPath);
      const queryCandidate = jarMeta?.name || stripFilenameVersionForSearch(item.file);

      // Fallback 2: if missing icon or description, try exact-title search online
      let onlineMatch: Partial<AddonMetadata> | null = null;
      if (!jarMeta?.iconUrl || !jarMeta?.description) {
        onlineMatch = await searchExactMatchOnline(queryCandidate, kind);
      }

      const mergedName = onlineMatch?.name || jarMeta?.name;
      const mergedDesc = jarMeta?.description || onlineMatch?.description;
      const mergedIcon = jarMeta?.iconUrl || onlineMatch?.iconUrl;
      const mergedAuthor = jarMeta?.author || onlineMatch?.author;
      const mergedVersion = jarMeta?.version;

      if (mergedName || mergedDesc || mergedIcon || mergedAuthor) {
        store[item.key] = {
          ...(mergedName ? { name: mergedName } : {}),
          ...(mergedDesc ? { description: mergedDesc } : {}),
          ...(mergedAuthor ? { author: mergedAuthor } : {}),
          ...(mergedIcon ? { iconUrl: mergedIcon } : {}),
          ...(mergedVersion ? { version: mergedVersion } : {}),
          ...(onlineMatch?.source ? { source: onlineMatch.source } : jarMeta?.source ? { source: jarMeta.source } : {}),
          ...(onlineMatch?.projectId ? { projectId: onlineMatch.projectId } : {}),
          sha1: item.sha1,
          notFound: false,
          checkedAt: Date.now(),
        };
        changed = true;
      } else {
        // Record negative lookup for this exact SHA-1 so we don't spam APIs on every list refresh
        store[item.key] = {
          sha1: item.sha1,
          notFound: true,
          checkedAt: Date.now(),
        };
      }
    }

    writeMetaStore(serverName, kind, store);
    return changed;
  } finally {
    inFlightResolutions.delete(lockKey);
  }
}
