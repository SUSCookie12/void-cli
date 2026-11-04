import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { getServerDir } from '../utils/paths.js';
import { getPidCpuMemory } from '../utils/pidStats.js';
import type { ServerMeta } from './manager.js';
import { analyzeLogs, getLatestCrashReport, type CrashAnalysis } from './crashAnalyzer.js';

export function listServerJarsInDir(cwd: string): string[] {
  if (!fs.existsSync(cwd)) return [];
  const jars: string[] = [];
  try {
    const neoforgeLib = path.join(cwd, 'libraries', 'net', 'neoforged', 'neoforge');
    if (fs.existsSync(neoforgeLib)) {
      jars.push('@libraries (Modern NeoForge)');
    }
    const forgeLib = path.join(cwd, 'libraries', 'net', 'minecraftforge', 'forge');
    if (fs.existsSync(forgeLib)) {
      jars.push('@libraries (Modern Forge)');
    }
    const files = fs.readdirSync(cwd, { withFileTypes: true });
    for (const f of files) {
      if (f.isFile() && f.name.toLowerCase().endsWith('.jar') && !f.name.toLowerCase().includes('installer')) {
        jars.push(f.name);
      }
    }
  } catch {}
  return jars;
}

export function resolveServerJarName(meta: ServerMeta, cwd: string): string {
  if (meta.launchJar && !meta.launchJar.startsWith('@libraries')) {
    if (fs.existsSync(path.join(cwd, meta.launchJar))) {
      return meta.launchJar;
    }
  }
  if (meta.type === 'forge' || meta.type === 'neoforge') {
    if (fs.existsSync(cwd)) {
      const files = fs.readdirSync(cwd);
      const prefix = meta.type === 'forge' ? 'forge' : 'neoforge';
      const legacyJar = files.find(
        f => f.startsWith(prefix) && f.endsWith('.jar') && !f.includes('installer')
      );
      if (legacyJar) return legacyJar;
    }
    return 'server.jar';
  }

  if (meta.type === 'fabric') {
    const ordered = [meta.launchJar, 'fabric-server-launch.jar', 'fabric-server-launcher.jar', 'server.jar'].filter(
      (x): x is string => Boolean(x),
    );
    const seen = new Set<string>();
    for (const name of ordered) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (fs.existsSync(path.join(cwd, name))) return name;
    }
    return meta.launchJar || 'fabric-server-launch.jar';
  }

  if (meta.type === 'quilt') {
    const ordered = [meta.launchJar, 'quilt-server-launch.jar', 'quilt-server-launcher.jar', 'server.jar'].filter(
      (x): x is string => Boolean(x),
    );
    const seen = new Set<string>();
    for (const name of ordered) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (fs.existsSync(path.join(cwd, name))) return name;
    }
    return meta.launchJar || 'quilt-server-launch.jar';
  }

  if (!fs.existsSync(path.join(cwd, 'server.jar')) && fs.existsSync(cwd)) {
    const candidateJars = fs.readdirSync(cwd).filter(f => f.toLowerCase().endsWith('.jar') && !f.toLowerCase().includes('installer'));
    const preferred = candidateJars.find(f => /^(arclight|paper|purpur|spigot|fabric|quilt|forge|neoforge|minecraft_server|server)/i.test(f));
    if (preferred) return preferred;
    if (candidateJars.length > 0) return candidateJars[0];
  }

  if (meta.type === 'arclight') {
    if (meta.launchJar && fs.existsSync(path.join(cwd, meta.launchJar))) return meta.launchJar;
    if (fs.existsSync(cwd)) {
      const files = fs.readdirSync(cwd);
      const arclightJar = files.find(f => f.startsWith('arclight') && f.endsWith('.jar'));
      if (arclightJar) return arclightJar;
    }
    return 'server.jar';
  }

  return 'server.jar';
}

export type LogLevel = 'info' | 'warn' | 'error' | 'system' | 'join' | 'leave' | 'command';

export interface LogLine {
  text: string;
  level: LogLevel;
  timestamp: Date;
}

export type ServerStatus = 'offline' | 'starting' | 'online' | 'stopping';

interface ServerInstance {
  process: ChildProcess;
  meta: ServerMeta;
  logs: LogLine[];
  startTime: Date;
  status: ServerStatus;
  restartPending?: boolean;
  onlinePlayers: Set<string>;
}

export function isEulaAccepted(name: string): boolean {
  const eulaPath = path.join(getServerDir(name), 'eula.txt');
  try {
    const content = fs.readFileSync(eulaPath, 'utf-8');
    return /eula=true/i.test(content);
  } catch {
    return false;
  }
}

// Module-level singleton store
const instances = new Map<string, ServerInstance>();
const serverListeners = new Map<string, Set<(log: LogLine) => void>>();
let isShuttingDown = false;

export const setShuttingDown = (val: boolean) => { isShuttingDown = val; };

type StatusListener = (status: ServerStatus) => void;
const statusListeners = new Map<string, Set<StatusListener>>();

export function subscribeToStatus(name: string, listener: StatusListener) {
  if (!statusListeners.has(name)) statusListeners.set(name, new Set());
  statusListeners.get(name)!.add(listener);
  return () => {
    statusListeners.get(name)?.delete(listener);
  };
}

function notifyStatus(name: string, status: ServerStatus) {
  statusListeners.get(name)?.forEach(l => l(status));
  globalStatusListeners.forEach(l => l(name, status));
}

type GlobalStatusListener = (name: string, status: ServerStatus) => void;
const globalStatusListeners = new Set<GlobalStatusListener>();

export function subscribeToAllStatus(listener: GlobalStatusListener) {
  globalStatusListeners.add(listener);
  return () => globalStatusListeners.delete(listener);
}

export function resolveJvmFlags(meta: ServerMeta): string[] {
  const preset = meta.jvmPreset || 'aikar';

  if (preset === 'aikar') {
    return [
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:+AlwaysPreTouch',
      '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5',
      '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90',
      '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32',
      '-XX:+PerfDisableSharedMem',
      '-XX:MaxTenuringThreshold=1',
    ];
  }

  if (preset === 'shenandoah') {
    return [
      '-XX:+UseShenandoahGC',
      '-XX:ShenandoahGCMode=iu',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+AlwaysPreTouch',
      '-XX:+DisableExplicitGC',
    ];
  }

  if (preset === 'zgc') {
    return [
      '-XX:+UseZGC',
      '-XX:+ZGenerational',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+AlwaysPreTouch',
      '-XX:+DisableExplicitGC',
    ];
  }

  if (preset === 'low_ram') {
    return [
      '-XX:+UseSerialGC',
      '-XX:MinHeapFreeRatio=5',
      '-XX:MaxHeapFreeRatio=10',
    ];
  }

  if (preset === 'custom' && meta.customJvmArgs) {
    return meta.customJvmArgs.split(/\s+/).filter(Boolean);
  }

  // Default Standard GC flags
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
  ];
}

type CrashListener = (name: string, analysis: CrashAnalysis) => void;
const crashListeners = new Set<CrashListener>();

export function subscribeToCrash(listener: CrashListener) {
  crashListeners.add(listener);
  return () => crashListeners.delete(listener);
}

export function notifyCrash(name: string, analysis: CrashAnalysis) {
  crashListeners.forEach(l => l(name, analysis));
}

export function getServerLogsText(name: string): string {
  const inst = instances.get(name);
  if (inst && inst.logs.length > 0) {
    return inst.logs.map(l => l.text).join('\n');
  }
  try {
    const logPath = path.join(getServerDir(name), 'logs', 'latest.log');
    if (fs.existsSync(logPath)) return fs.readFileSync(logPath, 'utf-8');
  } catch {}
  return '';
}

export function getLatestCrash(name: string): CrashAnalysis {
  const logsText = getServerLogsText(name);
  const crashFile = getLatestCrashReport(name);
  return analyzeLogs(logsText, crashFile?.content);
}

function parseLevel(line: string): LogLevel {
  if (line.includes('joined the game')) return 'join';
  if (line.includes('left the game')) return 'leave';
  if (line.includes('issued server command:')) return 'command';
  
  if (/\/WARN|WARN\]/.test(line)) return 'warn';
  if (/\/ERROR|ERROR\]|Exception|Caused by/.test(line)) return 'error';
  if (/\/INFO|INFO\]/.test(line)) return 'info';
  return 'info';
}

export async function startServer(meta: ServerMeta, onLog?: (log: LogLine) => void): Promise<void> {
  if (instances.has(meta.name)) return; // Already running
  
  const joinRegex = /: (.*) joined the game/;
  const leaveRegex = /: (.*) left the game/;

  const instance: ServerInstance = {
    process: null as unknown as ChildProcess,
    meta,
    logs: [],
    startTime: new Date(),
    status: 'starting',
    onlinePlayers: new Set()
  };

  const addLog = (text: string, forceLevel?: LogLevel) => {
    const trimmed = text.trimEnd();
    if (!trimmed) return;
    
    const joinMatch = trimmed.match(joinRegex);
    if (joinMatch) instance.onlinePlayers.add(joinMatch[1]);
    const leaveMatch = trimmed.match(leaveRegex);
    if (leaveMatch) instance.onlinePlayers.delete(leaveMatch[1]);

    const log: LogLine = {
      text: trimmed,
      level: forceLevel ?? parseLevel(trimmed),
      timestamp: new Date(),
    };
    if (instance.logs.length >= 500) instance.logs.shift();
    instance.logs.push(log);
    
    const listeners = serverListeners.get(meta.name);
    if (listeners) {
      listeners.forEach(l => l(log));
    }
  };

  if (onLog) {
    if (!serverListeners.has(meta.name)) serverListeners.set(meta.name, new Set());
    serverListeners.get(meta.name)!.add(onLog);
  }

  instances.set(meta.name, instance);
  notifyStatus(meta.name, 'starting');
  addLog(`[VOID] Start requested by user...`, 'system');
  console.log(`[DEBUG] Handling start_server for ${meta.name} (version: ${meta.version})`);

  try {
    const { getRequiredJava, detectJava, installJava } = await import('../utils/java.js');
    console.log(`[DEBUG] Java utilities imported`);
    
    let javaExecutable = 'java';
    if (meta.customJavaPath && fs.existsSync(meta.customJavaPath)) {
      javaExecutable = meta.customJavaPath;
      addLog(`[VOID] Using custom Java binary: ${javaExecutable}`, 'system');
    } else {
      const targetJavaVersion = meta.javaVersion || getRequiredJava(meta.version);
      console.log(`[DEBUG] Target Java: ${targetJavaVersion}`);
      addLog(`[VOID] Checking Java requirements (needs Java ${targetJavaVersion})...`, 'system');
      
      let javaInfo = detectJava(targetJavaVersion);
      javaExecutable = javaInfo.executablePath || 'java';

      if (!javaInfo.isCompatible) {
        addLog(`[VOID] Java ${targetJavaVersion} is required. Auto-downloading...`, 'system');
        javaExecutable = await installJava(targetJavaVersion, (msg: string) => {
          addLog(`[VOID] ${msg}`, 'system');
        });
      } else {
        addLog(`[VOID] Found Java ${javaInfo.versionString} at ${javaExecutable}`, 'system');
      }
    }

    const serverDir = getServerDir(meta.name);
    const jvmFlags = resolveJvmFlags(meta);
    addLog(`[VOID] JVM Preset: ${meta.jvmPreset || 'aikar'} (${jvmFlags.length} flags)`, 'system');
    
    let spawnArgs: string[] = [];
    const isForge = meta.type === 'forge' || meta.type === 'neoforge';
    const hasCustomJarOverride = Boolean(meta.launchJar && !meta.launchJar.startsWith('@libraries') && fs.existsSync(path.join(serverDir, meta.launchJar)));
    const hasForgeLib = fs.existsSync(path.join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge')) || fs.existsSync(path.join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge'));
    const isModernForge = (isForge || Boolean(meta.launchJar?.startsWith('@libraries'))) && !hasCustomJarOverride && (fs.existsSync(path.join(serverDir, 'user_jvm_args.txt')) || hasForgeLib);

    if (isModernForge) {
      const forgePath = meta.type === 'neoforge'
        ? ['net', 'neoforged', 'neoforge']
        : ['net', 'minecraftforge', 'forge'];
      const forgeLibDir = path.join(serverDir, 'libraries', ...forgePath);
      let argsFileRelativePath = '';
      
      if (fs.existsSync(forgeLibDir)) {
        const subdirs = fs.readdirSync(forgeLibDir);
        const versionDirName = subdirs.find(d => fs.statSync(path.join(forgeLibDir, d)).isDirectory());
        if (versionDirName) {
          const argsFileName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
          const absoluteArgsPath = path.join(forgeLibDir, versionDirName, argsFileName);
          if (fs.existsSync(absoluteArgsPath)) {
            argsFileRelativePath = path.relative(serverDir, absoluteArgsPath);
          }
        }
      }
      
      if (!argsFileRelativePath) {
        throw new Error(`Modern ${meta.type === 'neoforge' ? 'NeoForge' : 'Forge'} installed but could not find win_args.txt / unix_args.txt in libraries/${forgePath.join('/')}/`);
      }
      
      spawnArgs = [
        `-Xmx${meta.ram}`,
        `-Xms512M`,
        ...jvmFlags,
        ...(fs.existsSync(path.join(serverDir, 'user_jvm_args.txt')) ? ['@user_jvm_args.txt'] : []),
        `@${argsFileRelativePath}`,
        'nogui'
      ];
    } else {
      const jarName = resolveServerJarName(meta, serverDir);
      spawnArgs = [
        `-Xmx${meta.ram}`,
        `-Xms512M`,
        ...jvmFlags,
        '-jar',
        jarName,
        'nogui',
      ];
    }

    const proc = spawn(
      javaExecutable,
      spawnArgs,
      { cwd: serverDir, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    instance.process = proc;

    proc.stdout?.setEncoding('utf-8');
    proc.stdout?.on('data', (data: string) => {
      for (const line of data.split('\n')) {
        addLog(line);
        // Robust detection for Vanilla, Paper, and Forge
        if (instance.status === 'starting' && (/Done \([\d.]+s\)!/.test(line) || line.includes(']: Done ('))) {
          instance.status = 'online';
          notifyStatus(meta.name, 'online');
          addLog(`[VOID] Server is now ONLINE`, 'system');
        }
      }
    });

    proc.stderr?.setEncoding('utf-8');
    proc.stderr?.on('data', (data: string) => {
      for (const line of data.split('\n')) addLog(line);
    });

    proc.on('error', err => {
      addLog(`[VOID] Failed to start java process: ${err.message}`, 'system');
      instances.delete(meta.name);
    });

    proc.on('exit', code => {
      addLog(`[VOID] Server process exited (code ${code ?? 'unknown'})`, 'system');
      const isRestarting = instance.restartPending;

      const logHistory = instance.logs.map(l => l.text).join('\n');
      const latestCrash = getLatestCrashReport(meta.name);
      const analysis = analyzeLogs(logHistory, latestCrash?.content);
      if (analysis.detected) {
        addLog(`[CRASH DETECTED] ${analysis.title}: ${analysis.summary}`, 'error');
        if (analysis.solution) {
          addLog(`[RECOMMENDATION] ${analysis.solution}`, 'warn');
        }
        notifyCrash(meta.name, analysis);
      }

      instances.delete(meta.name);
      notifyStatus(meta.name, 'offline');
      
      if (isRestarting && !isShuttingDown) {
        addLog(`[VOID] Auto-restarting server...`, 'system');
        // Small delay to ensure any file locks are released
        setTimeout(() => startServer(meta), 1000);
      }
    });
  } catch (err: any) {
    addLog(`[VOID] Failed to initialize server: ${err.message}`, 'error');
    instances.delete(meta.name);
  }
}

export function stopServer(name: string): void {
  const inst = instances.get(name);
  if (!inst) return;
  inst.status = 'stopping';
  notifyStatus(name, 'stopping');
  inst.logs.push({ text: `[VOID] Shutdown requested by user...`, level: 'system', timestamp: new Date() });
  sendCommand(name, 'stop');
}

export function restartServer(name: string): void {
  const inst = instances.get(name);
  if (!inst) return;
  inst.restartPending = true;
  inst.logs.push({ text: `[VOID] Reboot requested by user...`, level: 'system', timestamp: new Date() });
  stopServer(name);
}

export function killServer(name: string): void {
  const inst = instances.get(name);
  if (!inst) return;
  inst.logs.push({ text: `[VOID] Force Kill requested by user!`, level: 'error', timestamp: new Date() });
  if (inst.process) inst.process.kill('SIGKILL');
  instances.delete(name);
  notifyStatus(name, 'offline');
}

export function sendCommand(name: string, command: string): boolean {
  const inst = instances.get(name);
  if (!inst || !inst.process || !inst.process.stdin) return false;
  inst.process.stdin.write(`${command}\n`);
  return true;
}

export function sendCommandWithResponse(
  name: string,
  command: string,
  responsePattern: RegExp,
  timeoutMs = 5000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const inst = instances.get(name);
    if (!inst || !inst.process || !inst.process.stdin) {
      reject(new Error('Server not running'));
      return;
    }

    const unsub = subscribeToLogs(name, (log) => {
      const match = log.text.match(responsePattern);
      if (match) {
        unsub();
        resolve(log.text);
      }
    });

    inst.process.stdin.write(`${command}\n`);

    setTimeout(() => {
      unsub();
      reject(new Error('Command response timeout'));
    }, timeoutMs);
  });
}

export function isRunning(name: string): boolean {
  return instances.has(name);
}

export function getServerStatus(name: string): ServerStatus {
  return instances.get(name)?.status || 'offline';
}

export function getServerLogs(name: string): LogLine[] {
  return instances.get(name)?.logs ?? [];
}

export function subscribeToLogs(
  name: string,
  listener: (log: LogLine) => void
): () => void {
  if (!serverListeners.has(name)) {
    serverListeners.set(name, new Set());
  }
  serverListeners.get(name)!.add(listener);
  return () => {
    const listeners = serverListeners.get(name);
    if (listeners) {
      listeners.delete(listener);
    }
  };
}

export interface ServerStats {
  memory: number; // in bytes
  cpu: number; // percentage
  status: ServerStatus;
  startedAt: string | null; // ISO string of when the server was started
}

export async function getServerStats(name: string): Promise<ServerStats | null> {
  const inst = instances.get(name);
  if (!inst || !inst.process || inst.process.exitCode !== null || !inst.process.pid) return null;
  const row = await getPidCpuMemory(inst.process.pid);
  if (!row) return null;
  return {
    memory: row.memory,
    cpu: row.cpu,
    status: inst.status,
    startedAt: inst.startTime ? inst.startTime.toISOString() : null,
  };
}

export function getRunningServers(): string[] {
  return Array.from(instances.keys());
}

export function getOnlinePlayers(name: string): string[] {
  return Array.from(instances.get(name)?.onlinePlayers || []);
}

export function waitForServerStop(name: string, timeoutMs = 15000): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!instances.has(name)) { resolve(); return; }
    const check = setInterval(() => {
      if (!instances.has(name)) {
        clearInterval(check);
        resolve();
      }
    }, 300);
    setTimeout(() => {
      if (instances.has(name)) {
        killServer(name);
        clearInterval(check);
        resolve();
      }
    }, timeoutMs);
  });
}

export async function stopAllServers(): Promise<void> {
  const running = Array.from(instances.keys());
  if (running.length === 0) return;

  const stops = running.map(name => {
    return new Promise<void>((resolve) => {
      stopServer(name);
      const check = setInterval(() => {
        if (!instances.has(name)) {
          clearInterval(check);
          resolve();
        }
      }, 300);

      // Safety timeout
      setTimeout(() => {
        if (instances.has(name)) {
          killServer(name);
          clearInterval(check);
          resolve();
        }
      }, 15000);
    });
  });

  await Promise.all(stops);
}
