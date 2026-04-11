import { spawn, type ChildProcess } from 'node:child_process';
import { getServerDir } from '../utils/paths.js';
import { getPidCpuMemory } from '../utils/pidStats.js';
import type { ServerMeta } from './manager.js';

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
    const requiredVersion = getRequiredJava(meta.version);
    console.log(`[DEBUG] Required Java: ${requiredVersion}`);
    addLog(`[VOID] Checking Java requirements (needs Java ${requiredVersion})...`, 'system');
    
    let javaInfo = detectJava(requiredVersion);
    let javaExecutable = javaInfo.executablePath || 'java';

    if (!javaInfo.isCompatible) {
      addLog(`[VOID] Java ${requiredVersion} is required. Auto-downloading...`, 'system');
      javaExecutable = await installJava(requiredVersion, (msg: string) => {
        addLog(`[VOID] ${msg}`, 'system');
      });
    } else {
      addLog(`[VOID] Found Java ${javaInfo.versionString} at ${javaExecutable}`, 'system');
    }

    const serverDir = getServerDir(meta.name);

    const proc = spawn(
      javaExecutable,
      [
        `-Xmx${meta.ram}`,
        `-Xms512M`,
        '-XX:+UseG1GC',
        '-XX:+ParallelRefProcEnabled',
        '-XX:MaxGCPauseMillis=200',
        '-jar',
        'server.jar',
        'nogui',
      ],
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
  };
}

export function getRunningServers(): string[] {
  return Array.from(instances.keys());
}

export function getOnlinePlayers(name: string): string[] {
  return Array.from(instances.get(name)?.onlinePlayers || []);
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
