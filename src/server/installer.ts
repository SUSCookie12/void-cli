import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { getServerDir } from '../utils/paths.js';
import { getVanillaServerUrl } from '../api/mojang.js';
import { getLatestPaperInfo } from '../api/paper.js';
import { getLatestStableFabricInstaller, getLatestStableLoaderForGame } from '../api/fabric.js';
import { getForgeVersionForGame } from '../api/forge.js';
import { getLatestPurpurBuild } from '../api/purpur.js';
import { getNeoForgeInstallerInfo } from '../api/neoforge.js';
import { getQuiltInstallerInfo } from '../api/quilt.js';
import { getArclightDownloadInfo } from '../api/arclight.js';
import { detectJava, getRequiredJava } from '../utils/java.js';
import { downloadFile } from '../utils/download.js';
export { downloadFile };
import { saveServerMeta } from './manager.js';
import type { ServerMeta } from './manager.js';

export interface InstallProgress {
  stage: 'creating' | 'downloading' | 'configuring' | 'done' | 'error';
  progress: number; // 0–100
  message: string;
  error?: string;
}

function javaForHeadlessInstaller(javaBin: string): string {
  return javaBin;
}

/** Headless Fabric `server` CLI — runs on the daemon host, not in the desktop shell. */
function runFabricInstallerServerCli(
  serverDir: string,
  javaBin: string,
  mcVersion: string,
  loaderVersion: string,
): SpawnSyncReturns<string> {
  const java = javaForHeadlessInstaller(javaBin);
  const jto = [process.env.JAVA_TOOL_OPTIONS, '-Djava.awt.headless=true'].filter(Boolean).join(' ').trim();
  return spawnSync(
    java,
    [
      '-jar',
      'fabric-installer.jar',
      'server',
      '-mcversion',
      mcVersion,
      '-loader',
      loaderVersion,
      '-downloadMinecraft',
      '-noprofile',
    ],
    {
      cwd: serverDir,
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, JAVA_TOOL_OPTIONS: jto },
      maxBuffer: 128 * 1024 * 1024,
    },
  );
}

function runForgeInstallerServerCli(
  serverDir: string,
  javaBin: string,
): SpawnSyncReturns<string> {
  const java = javaForHeadlessInstaller(javaBin);
  const jto = [process.env.JAVA_TOOL_OPTIONS, '-Djava.awt.headless=true'].filter(Boolean).join(' ').trim();
  return spawnSync(
    java,
    [
      '-jar',
      'forge-installer.jar',
      '--installServer',
    ],
    {
      cwd: serverDir,
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, JAVA_TOOL_OPTIONS: jto },
      maxBuffer: 128 * 1024 * 1024,
    },
  );
}

function runNeoForgeInstallerServerCli(
  serverDir: string,
  javaBin: string,
): SpawnSyncReturns<string> {
  const java = javaForHeadlessInstaller(javaBin);
  const jto = [process.env.JAVA_TOOL_OPTIONS, '-Djava.awt.headless=true'].filter(Boolean).join(' ').trim();
  return spawnSync(
    java,
    [
      '-jar',
      'neoforge-installer.jar',
      '--installServer',
    ],
    {
      cwd: serverDir,
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, JAVA_TOOL_OPTIONS: jto },
      maxBuffer: 128 * 1024 * 1024,
    },
  );
}

function runQuiltInstallerServerCli(
  serverDir: string,
  javaBin: string,
  mcVersion: string,
  _loaderVersion: string,
): SpawnSyncReturns<string> {
  const java = javaForHeadlessInstaller(javaBin);
  const jto = [process.env.JAVA_TOOL_OPTIONS, '-Djava.awt.headless=true'].filter(Boolean).join(' ').trim();
  // Official Quilt CLI: java -jar quilt-installer.jar install server MINECRAFT_VERSION --download-server
  // The installer places quilt-server-launch.jar directly in cwd (serverDir).
  // Do NOT pass loaderVersion as a positional arg — the CLI does not accept it.
  return spawnSync(
    java,
    [
      '-jar',
      'quilt-installer.jar',
      'install',
      'server',
      mcVersion,
      '--install-dir=.',
      '--download-server',
    ],
    {
      cwd: serverDir,
      encoding: 'utf-8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, JAVA_TOOL_OPTIONS: jto },
      maxBuffer: 128 * 1024 * 1024,
    },
  );
}

export async function installServer(
  meta: ServerMeta,
  onProgress: (p: InstallProgress) => void
): Promise<void> {
  const serverDir = getServerDir(meta.name);

  try {
    // 1. Create directory
    onProgress({ stage: 'creating', progress: 0, message: 'Creating server directory...' });
    if (!fs.existsSync(serverDir)) fs.mkdirSync(serverDir, { recursive: true });

    onProgress({ stage: 'downloading', progress: 5, message: 'Fetching download URL...' });

    if (meta.type === 'fabric') {
      const loaderVersion = meta.fabricLoader || (await getLatestStableLoaderForGame(meta.version));
      meta.fabricLoader = loaderVersion;
      const installer = await getLatestStableFabricInstaller();
      const installerPath = path.join(serverDir, 'fabric-installer.jar');
      onProgress({ stage: 'downloading', progress: 12, message: 'Downloading Fabric installer...' });
      await downloadFile(installer.url, installerPath, pct => {
        onProgress({
          stage: 'downloading',
          progress: Math.floor(10 + pct * 0.34),
          message: `Downloading Fabric installer... ${pct}%`,
        });
      });
      onProgress({ stage: 'downloading', progress: 45, message: 'Running Fabric installer (downloads Minecraft + loader)...' });
      const req = getRequiredJava(meta.version);
      const ji = detectJava(req);
      const javaBin = ji.executablePath || 'java';
      if (!ji.found) {
        throw new Error('Java is required to install Fabric. Install a JDK or JRE and ensure `java` is on PATH.');
      }
      const run = runFabricInstallerServerCli(serverDir, javaBin, meta.version, loaderVersion);
      try {
        fs.unlinkSync(installerPath);
      } catch {
        // ignore
      }
      if (run.status !== 0 || run.error || run.signal) {
        const detail = `${run.stderr || ''}\n${run.stdout || ''}`.trim();
        const errDesc = run.error ? ` [Error: ${run.error.message}]` : '';
        const sigDesc = run.signal ? ` [Signal: ${run.signal}]` : '';
        throw new Error(
          `Fabric installer failed (exit ${run.status ?? '?'})${errDesc}${sigDesc}${detail ? `: ${detail.slice(0, 2000)}` : ''}`,
        );
      }
      const launchCandidates = ['fabric-server-launch.jar', 'fabric-server-launcher.jar'] as const;
      let launchJar: string | undefined;
      for (const j of launchCandidates) {
        if (fs.existsSync(path.join(serverDir, j))) {
          launchJar = j;
          break;
        }
      }
      if (!launchJar) {
        throw new Error('Fabric install finished but fabric-server-launch.jar was not found in the server folder');
      }
      meta.launchJar = launchJar;
    } else if (meta.type === 'forge') {
      const forgeVersion = meta.forgeVersion || (await getForgeVersionForGame(meta.version));
      meta.forgeVersion = forgeVersion;
      const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${meta.version}-${forgeVersion}/forge-${meta.version}-${forgeVersion}-installer.jar`;
      const installerPath = path.join(serverDir, 'forge-installer.jar');
      
      onProgress({ stage: 'downloading', progress: 12, message: 'Downloading Forge installer...' });
      await downloadFile(installerUrl, installerPath, pct => {
        onProgress({
          stage: 'downloading',
          progress: Math.floor(10 + pct * 0.34),
          message: `Downloading Forge installer... ${pct}%`,
        });
      });
      
      onProgress({ stage: 'downloading', progress: 45, message: 'Running Forge installer (downloads Minecraft + libraries)...' });
      const req = getRequiredJava(meta.version);
      const ji = detectJava(req);
      const javaBin = ji.executablePath || 'java';
      if (!ji.found) {
        throw new Error('Java is required to install Forge. Install a JDK or JRE and ensure `java` is on PATH.');
      }
      const run = runForgeInstallerServerCli(serverDir, javaBin);
      try {
        fs.unlinkSync(installerPath);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(path.join(serverDir, 'forge-installer.jar.log'));
      } catch {
        // ignore
      }
      if (run.status !== 0 || run.error || run.signal) {
        const detail = `${run.stderr || ''}\n${run.stdout || ''}`.trim();
        const errDesc = run.error ? ` [Error: ${run.error.message}]` : '';
        const sigDesc = run.signal ? ` [Signal: ${run.signal}]` : '';
        throw new Error(
          `Forge installer failed (exit ${run.status ?? '?'})${errDesc}${sigDesc}${detail ? `: ${detail.slice(0, 2000)}` : ''}`,
        );
      }
    } else if (meta.type === 'neoforge') {
      const info = meta.neoforgeVersion
        ? {
            fullVersion: meta.neoforgeVersion,
            installerUrl: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${meta.neoforgeVersion}/neoforge-${meta.neoforgeVersion}-installer.jar`,
          }
        : await getNeoForgeInstallerInfo(meta.version);
      meta.neoforgeVersion = info.fullVersion;
      const installerPath = path.join(serverDir, 'neoforge-installer.jar');

      onProgress({ stage: 'downloading', progress: 12, message: 'Downloading NeoForge installer...' });
      await downloadFile(info.installerUrl, installerPath, pct => {
        onProgress({
          stage: 'downloading',
          progress: Math.floor(10 + pct * 0.34),
          message: `Downloading NeoForge installer... ${pct}%`,
        });
      });

      onProgress({ stage: 'downloading', progress: 45, message: 'Running NeoForge installer (downloads Minecraft + libraries)...' });
      const req = getRequiredJava(meta.version);
      const ji = detectJava(req);
      const javaBin = ji.executablePath || 'java';
      if (!ji.found) {
        throw new Error('Java is required to install NeoForge. Install a JDK or JRE and ensure `java` is on PATH.');
      }
      const run = runNeoForgeInstallerServerCli(serverDir, javaBin);
      try {
        fs.unlinkSync(installerPath);
      } catch {
        // ignore
      }
      if (run.status !== 0 || run.error || run.signal) {
        const detail = `${run.stderr || ''}\n${run.stdout || ''}`.trim();
        const errDesc = run.error ? ` [Error: ${run.error.message}]` : '';
        const sigDesc = run.signal ? ` [Signal: ${run.signal}]` : '';
        throw new Error(
          `NeoForge installer failed (exit ${run.status ?? '?'})${errDesc}${sigDesc}${detail ? `: ${detail.slice(0, 2000)}` : ''}`,
        );
      }
    } else if (meta.type === 'quilt') {
      const { loaderVersion, installerUrl } = await getQuiltInstallerInfo(meta.version);
      meta.fabricLoader = loaderVersion;
      const installerPath = path.join(serverDir, 'quilt-installer.jar');

      onProgress({ stage: 'downloading', progress: 12, message: 'Downloading Quilt installer...' });
      await downloadFile(installerUrl, installerPath, pct => {
        onProgress({
          stage: 'downloading',
          progress: Math.floor(10 + pct * 0.34),
          message: `Downloading Quilt installer... ${pct}%`,
        });
      });

      onProgress({ stage: 'downloading', progress: 45, message: 'Running Quilt installer (downloads Minecraft + loader)...' });
      const req = getRequiredJava(meta.version);
      const ji = detectJava(req);
      const javaBin = ji.executablePath || 'java';
      if (!ji.found) {
        throw new Error('Java is required to install Quilt. Install a JDK or JRE and ensure `java` is on PATH.');
      }
      const run = runQuiltInstallerServerCli(serverDir, javaBin, meta.version, loaderVersion);
      try {
        fs.unlinkSync(installerPath);
      } catch {
        // ignore
      }
      if (run.status !== 0 || run.error || run.signal) {
        const detail = `${run.stderr || ''}\n${run.stdout || ''}`.trim();
        const errDesc = run.error ? ` [Error: ${run.error.message}]` : '';
        const sigDesc = run.signal ? ` [Signal: ${run.signal}]` : '';
        throw new Error(
          `Quilt installer failed (exit ${run.status ?? '?'})${errDesc}${sigDesc}${detail ? `: ${detail.slice(0, 2000)}` : ''}`,
        );
      }
      const launchCandidates = ['quilt-server-launch.jar', 'quilt-server-launcher.jar'] as const;
      let launchJar: string | undefined;
      // Check in serverDir itself first (expected when cwd is serverDir)
      for (const j of launchCandidates) {
        if (fs.existsSync(path.join(serverDir, j))) {
          launchJar = j;
          break;
        }
      }
      // Fallback: Quilt installer may have created a 'server/' subdirectory — move files up
      if (!launchJar) {
        const subDir = path.join(serverDir, 'server');
        for (const j of launchCandidates) {
          if (fs.existsSync(path.join(subDir, j))) {
            // Move all contents of server/ up into serverDir
            const subEntries = fs.readdirSync(subDir);
            for (const entry of subEntries) {
              const src = path.join(subDir, entry);
              const dest = path.join(serverDir, entry);
              if (!fs.existsSync(dest)) {
                fs.renameSync(src, dest);
              }
            }
            try { fs.rmdirSync(subDir); } catch { /* ignore */ }
            launchJar = j;
            break;
          }
        }
      }
      if (!launchJar) {
        // Log what files exist for debugging
        const files = fs.readdirSync(serverDir).slice(0, 20).join(', ');
        throw new Error(`Quilt install finished but quilt-server-launch.jar was not found. Files in dir: ${files}`);
      }
      meta.launchJar = launchJar;
    } else if (meta.type === 'arclight') {
      const { url, jarName } = await getArclightDownloadInfo(meta.version);
      meta.launchJar = jarName;

      onProgress({ stage: 'downloading', progress: 10, message: `Downloading Arclight ${meta.version}...` });
      await downloadFile(url, path.join(serverDir, jarName), pct => {
        onProgress({
          stage: 'downloading',
          progress: Math.floor(10 + pct * 0.82),
          message: `Downloading Arclight ${meta.version}... ${pct}%`,
        });
      });
    } else {
      let downloadUrl: string;
      if (meta.type === 'vanilla') {
        downloadUrl = await getVanillaServerUrl(meta.version);
      } else if (meta.type === 'purpur') {
        const info = await getLatestPurpurBuild(meta.version);
        meta.build = info.build;
        downloadUrl = info.url;
      } else {
        const info = await getLatestPaperInfo(meta.version);
        meta.build = info.build;
        downloadUrl = info.url;
      }
      onProgress({ stage: 'downloading', progress: 10, message: `Downloading ${meta.type} ${meta.version}...` });
      await downloadFile(downloadUrl, path.join(serverDir, 'server.jar'), pct => {
        onProgress({
          stage: 'downloading',
          progress: Math.floor(10 + pct * 0.82),
          message: `Downloading ${meta.type} ${meta.version}... ${pct}%`,
        });
      });
    }

    // 4. Configure
    onProgress({ stage: 'configuring', progress: 94, message: 'Writing configuration...' });

    // EULA — set to false by default, user must accept via UI
    fs.writeFileSync(path.join(serverDir, 'eula.txt'), '#Set by Void Server\neula=false\n');

    // Default server.properties merged with any pre-configured properties
    const defaultProps: Record<string, string> = {
      'server-port': String(meta.port),
      'online-mode': 'true',
      'max-players': '20',
      'view-distance': '10',
      'simulation-distance': '10',
      'level-name': 'world',
      'level-seed': '',
      'level-type': 'default',
      'generate-structures': 'true',
      'allow-nether': 'true',
      'hardcore': 'false',
      'motd': `\\u00A76\\u00A7l${meta.name}\\u00A7r \\u00A77| Void Server`,
      'enable-command-block': 'false',
      'spawn-protection': '16',
      'difficulty': 'normal',
      'gamemode': 'survival',
      'pvp': 'true',
    };
    if (meta.initialProperties && typeof meta.initialProperties === 'object') {
      for (const [k, v] of Object.entries(meta.initialProperties)) {
        if (v !== undefined && v !== null) {
          defaultProps[k] = String(v);
        }
      }
    }
    const propLines = Object.entries(defaultProps)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    fs.writeFileSync(path.join(serverDir, 'server.properties'), propLines + '\n');

    // Save metadata
    saveServerMeta(meta);

    onProgress({ stage: 'done', progress: 100, message: 'Installation complete!' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ stage: 'error', progress: 0, message: 'Installation failed', error: message });

    // Cleanup on failure
    try {
      if (fs.existsSync(serverDir)) fs.rmSync(serverDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }

    throw err;
  }
}

export function unwrapSingleRootFolder(serverDir: string): void {
  for (let depth = 0; depth < 2; depth++) {
    if (!fs.existsSync(serverDir)) return;
    const entries = fs.readdirSync(serverDir, { withFileTypes: true }).filter(
      e => e.name !== '__MACOSX' && e.name !== '.DS_Store'
    );
    const hasRootMarkers = entries.some(
      e =>
        (e.isFile() && (e.name.toLowerCase().endsWith('.jar') || e.name === 'server.properties' || e.name === 'eula.txt' || e.name === 'meta.json' || e.name === 'user_jvm_args.txt')) ||
        (e.isDirectory() && (e.name === 'world' || e.name === 'mods' || e.name === 'plugins' || e.name === 'libraries'))
    );
    if (hasRootMarkers) return;

    const dirs = entries.filter(e => e.isDirectory());
    const files = entries.filter(e => e.isFile());
    if (dirs.length === 1 && files.length === 0) {
      const nestedDir = path.join(serverDir, dirs[0].name);
      const nestedEntries = fs.readdirSync(nestedDir);
      for (const item of nestedEntries) {
        const src = path.join(nestedDir, item);
        const dest = path.join(serverDir, item);
        if (!fs.existsSync(dest)) {
          fs.renameSync(src, dest);
        }
      }
      try {
        fs.rmSync(nestedDir, { recursive: true, force: true });
      } catch {}
    } else {
      return;
    }
  }
}

export interface ServerDirectoryInspection {
  jars: string[];
  recommendedJar: string;
  detectedType: ServerMeta['type'];
  detectedVersion: string;
  properties: Record<string, string>;
  hasMods: boolean;
  hasPlugins: boolean;
  hasWorld: boolean;
  existingMeta: Partial<ServerMeta> | null;
}

export async function inspectServerDirectory(serverDir: string): Promise<ServerDirectoryInspection> {
  const { listServerJarsInDir } = await import('./instance.js');
  const jars = listServerJarsInDir(serverDir);

  let existingMeta: Partial<ServerMeta> | null = null;
  const metaPath = path.join(serverDir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      existingMeta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {}
  }

  const properties: Record<string, string> = {};
  const propsPath = path.join(serverDir, 'server.properties');
  if (fs.existsSync(propsPath)) {
    try {
      const raw = fs.readFileSync(propsPath, 'utf-8');
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          properties[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
        }
      }
    } catch {}
  }

  const hasMods = fs.existsSync(path.join(serverDir, 'mods'));
  const hasPlugins = fs.existsSync(path.join(serverDir, 'plugins'));
  const hasWorld = fs.existsSync(path.join(serverDir, properties['level-name'] || 'world'));

  let detectedType: ServerMeta['type'] = existingMeta?.type || 'paper';
  let detectedVersion = existingMeta?.version || '1.21.4';

  const lowerJars = jars.map(j => j.toLowerCase());
  if (!existingMeta?.type) {
    if (lowerJars.some(j => j.includes('neoforge'))) detectedType = 'neoforge';
    else if (lowerJars.some(j => j.includes('forge'))) detectedType = 'forge';
    else if (lowerJars.some(j => j.includes('fabric')) || fs.existsSync(path.join(serverDir, '.fabric'))) detectedType = 'fabric';
    else if (lowerJars.some(j => j.includes('quilt'))) detectedType = 'quilt';
    else if (lowerJars.some(j => j.includes('arclight'))) detectedType = 'arclight';
    else if (lowerJars.some(j => j.includes('purpur'))) detectedType = 'purpur';
    else if (lowerJars.some(j => j.includes('paper')) || hasPlugins) detectedType = 'paper';
    else if (hasMods) detectedType = 'fabric';
    else detectedType = 'vanilla';
  }

  if (!existingMeta?.version) {
    // Check jar names or libraries for MC version like 1.20.1, 1.21.4, 1.19.2, etc.
    let versionFound = '';
    for (const j of jars) {
      const m = j.match(/\b(1\.\d{1,2}(?:\.\d{1,2})?)\b/);
      if (m) {
        versionFound = m[1];
        break;
      }
    }
    if (!versionFound) {
      const forgeLib = path.join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge');
      if (fs.existsSync(forgeLib)) {
        const sub = fs.readdirSync(forgeLib)[0] || '';
        const m = sub.match(/^(1\.\d{1,2}(?:\.\d{1,2})?)/);
        if (m) versionFound = m[1];
      }
    }
    if (!versionFound) {
      const mcLib = path.join(serverDir, 'libraries', 'net', 'minecraft', 'server');
      if (fs.existsSync(mcLib)) {
        const sub = fs.readdirSync(mcLib)[0] || '';
        const m = sub.match(/^(1\.\d{1,2}(?:\.\d{1,2})?)/);
        if (m) versionFound = m[1];
      }
    }
    if (versionFound) detectedVersion = versionFound;
  }

  let recommendedJar = existingMeta?.launchJar || '';
  if (!recommendedJar || (!jars.includes(recommendedJar) && !recommendedJar.startsWith('@libraries'))) {
    const priority = jars.find(j => j.startsWith('@libraries')) ||
      jars.find(j => /fabric-server-launch/i.test(j)) ||
      jars.find(j => /quilt-server-launch/i.test(j)) ||
      jars.find(j => /^(paper|purpur|arclight|forge|neoforge|spigot)/i.test(j)) ||
      jars.find(j => j.toLowerCase() === 'server.jar') ||
      jars[0] ||
      'server.jar';
    recommendedJar = priority;
  }

  return {
    jars,
    recommendedJar,
    detectedType,
    detectedVersion,
    properties,
    hasMods,
    hasPlugins,
    hasWorld,
    existingMeta,
  };
}

export interface ImportServerOptions {
  name: string;
  sourceArchivePath?: string;
  sourceFolderPath?: string;
  type?: ServerMeta['type'];
  version?: string;
  ram?: string;
  port?: number;
  javaVersion?: number;
  launchJar?: string;
  downloadFreshJar?: boolean;
  initialProperties?: Record<string, string>;
}

export async function importServerFromSource(
  opts: ImportServerOptions,
  onProgress: (p: InstallProgress) => void
): Promise<ServerMeta> {
  const { getNextAvailablePort } = await import('./manager.js');
  const { extractArchive } = await import('../utils/zipper.js');
  const serverDir = getServerDir(opts.name);

  try {
    onProgress({ stage: 'creating', progress: 5, message: 'Preparing server directory...' });
    if (!fs.existsSync(serverDir)) {
      fs.mkdirSync(serverDir, { recursive: true });
    }

    if (opts.sourceArchivePath && fs.existsSync(opts.sourceArchivePath)) {
      onProgress({ stage: 'downloading', progress: 20, message: 'Extracting imported server archive...' });
      await extractArchive(opts.sourceArchivePath, serverDir);
      try {
        if (opts.sourceArchivePath.includes('void_import_')) {
          fs.unlinkSync(opts.sourceArchivePath);
        }
      } catch {}
    } else if (opts.sourceFolderPath && fs.existsSync(opts.sourceFolderPath)) {
      const resolvedSrc = path.resolve(opts.sourceFolderPath);
      const resolvedDest = path.resolve(serverDir);
      if (resolvedSrc !== resolvedDest) {
        onProgress({ stage: 'downloading', progress: 25, message: 'Copying server files from folder...' });
        fs.cpSync(resolvedSrc, resolvedDest, { recursive: true });
      }
    }

    onProgress({ stage: 'configuring', progress: 65, message: 'Inspecting server structure & JAR files...' });
    unwrapSingleRootFolder(serverDir);
    const inspection = await inspectServerDirectory(serverDir);

    const finalType: ServerMeta['type'] = opts.type || inspection.detectedType || 'paper';
    const finalVersion = opts.version || inspection.detectedVersion || '1.21.4';
    const finalRam = opts.ram || inspection.existingMeta?.ram || '4G';
    const parsedPropPort = inspection.properties['server-port'] ? parseInt(inspection.properties['server-port'], 10) : NaN;
    const finalPort = opts.port || (!isNaN(parsedPropPort) ? parsedPropPort : getNextAvailablePort());
    const finalLaunchJar = opts.launchJar || inspection.recommendedJar || 'server.jar';

    const statusId = inspection.existingMeta?.statusId || (Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10));

    const meta: ServerMeta = {
      name: opts.name,
      type: finalType,
      version: finalVersion,
      ram: finalRam,
      port: finalPort,
      launchJar: finalLaunchJar,
      javaVersion: opts.javaVersion || inspection.existingMeta?.javaVersion,
      createdAt: new Date().toISOString(),
      statusId,
    };

    // If user requested downloading a fresh server JAR or no JAR exists in the imported folder
    const needsJarDownload = opts.downloadFreshJar || (inspection.jars.length === 0 && !fs.existsSync(path.join(serverDir, 'server.jar')));
    if (needsJarDownload) {
      onProgress({ stage: 'downloading', progress: 72, message: `Downloading ${finalType} ${finalVersion} server runtime...` });
      if (finalType === 'vanilla') {
        const downloadUrl = await getVanillaServerUrl(finalVersion);
        await downloadFile(downloadUrl, path.join(serverDir, 'server.jar'), () => {});
        meta.launchJar = 'server.jar';
      } else if (finalType === 'purpur') {
        const info = await getLatestPurpurBuild(finalVersion);
        meta.build = info.build;
        await downloadFile(info.url, path.join(serverDir, 'server.jar'), () => {});
        meta.launchJar = 'server.jar';
      } else if (finalType === 'paper') {
        const info = await getLatestPaperInfo(finalVersion);
        meta.build = info.build;
        await downloadFile(info.url, path.join(serverDir, 'server.jar'), () => {});
        meta.launchJar = 'server.jar';
      } else if (finalType === 'arclight') {
        const { url, jarName } = await getArclightDownloadInfo(finalVersion);
        await downloadFile(url, path.join(serverDir, jarName), () => {});
        meta.launchJar = jarName;
      } else if (finalType === 'fabric') {
        const loaderVersion = await getLatestStableLoaderForGame(finalVersion);
        meta.fabricLoader = loaderVersion;
        const installer = await getLatestStableFabricInstaller();
        const installerPath = path.join(serverDir, 'fabric-installer.jar');
        await downloadFile(installer.url, installerPath, () => {});
        const ji = detectJava(getRequiredJava(finalVersion));
        runFabricInstallerServerCli(serverDir, ji.executablePath || 'java', finalVersion, loaderVersion);
        try { fs.unlinkSync(installerPath); } catch {}
        meta.launchJar = fs.existsSync(path.join(serverDir, 'fabric-server-launch.jar')) ? 'fabric-server-launch.jar' : 'server.jar';
      } else if (finalType === 'quilt') {
        const { loaderVersion, installerUrl } = await getQuiltInstallerInfo(finalVersion);
        meta.fabricLoader = loaderVersion;
        const installerPath = path.join(serverDir, 'quilt-installer.jar');
        await downloadFile(installerUrl, installerPath, () => {});
        const ji = detectJava(getRequiredJava(finalVersion));
        runQuiltInstallerServerCli(serverDir, ji.executablePath || 'java', finalVersion, loaderVersion);
        try { fs.unlinkSync(installerPath); } catch {}
        const launchCandidates = ['quilt-server-launch.jar', 'quilt-server-launcher.jar'] as const;
        let launchJar: string | undefined;
        for (const j of launchCandidates) {
          if (fs.existsSync(path.join(serverDir, j))) {
            launchJar = j;
            break;
          }
        }
        if (!launchJar) {
          const subDir = path.join(serverDir, 'server');
          for (const j of launchCandidates) {
            if (fs.existsSync(path.join(subDir, j))) {
              const subEntries = fs.readdirSync(subDir);
              for (const entry of subEntries) {
                const src = path.join(subDir, entry);
                const dest = path.join(serverDir, entry);
                if (!fs.existsSync(dest)) {
                  fs.renameSync(src, dest);
                }
              }
              try { fs.rmdirSync(subDir); } catch {}
              launchJar = j;
              break;
            }
          }
        }
        meta.launchJar = launchJar || 'quilt-server-launch.jar';
      } else if (finalType === 'forge') {
        const forgeVersion = await getForgeVersionForGame(finalVersion);
        meta.forgeVersion = forgeVersion;
        const installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${finalVersion}-${forgeVersion}/forge-${finalVersion}-${forgeVersion}-installer.jar`;
        const installerPath = path.join(serverDir, 'forge-installer.jar');
        await downloadFile(installerUrl, installerPath, () => {});
        const ji = detectJava(getRequiredJava(finalVersion));
        runForgeInstallerServerCli(serverDir, ji.executablePath || 'java');
        try { fs.unlinkSync(installerPath); } catch {}
        try { fs.unlinkSync(path.join(serverDir, 'forge-installer.jar.log')); } catch {}
        if (!fs.existsSync(path.join(serverDir, finalLaunchJar))) {
          meta.launchJar = '@libraries (Modern Forge)';
        }
      } else if (finalType === 'neoforge') {
        const info = await getNeoForgeInstallerInfo(finalVersion);
        meta.neoforgeVersion = info.fullVersion;
        const installerPath = path.join(serverDir, 'neoforge-installer.jar');
        await downloadFile(info.installerUrl, installerPath, () => {});
        const ji = detectJava(getRequiredJava(finalVersion));
        runNeoForgeInstallerServerCli(serverDir, ji.executablePath || 'java');
        try { fs.unlinkSync(installerPath); } catch {}
        if (!fs.existsSync(path.join(serverDir, finalLaunchJar))) {
          meta.launchJar = '@libraries (Modern NeoForge)';
        }
      }
    }

    onProgress({ stage: 'configuring', progress: 92, message: 'Writing EULA and server configuration...' });
    fs.writeFileSync(path.join(serverDir, 'eula.txt'), '#Accepted via Void Server Import\neula=true\n');

    const mergedProps: Record<string, string> = {
      'server-port': String(finalPort),
      'online-mode': 'true',
      'max-players': '20',
      'motd': `\\u00A76\\u00A7l${opts.name}\\u00A7r \\u00A77| Void Server`,
      ...inspection.properties,
      ...(opts.initialProperties || {}),
    };
    mergedProps['server-port'] = String(finalPort);

    const propLines = Object.entries(mergedProps)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    fs.writeFileSync(path.join(serverDir, 'server.properties'), propLines + '\n');

    saveServerMeta(meta);
    onProgress({ stage: 'done', progress: 100, message: 'Server imported successfully!' });
    return meta;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress({ stage: 'error', progress: 0, message: 'Import failed', error: message });
    throw err;
  }
}
