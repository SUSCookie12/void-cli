export interface DaemonLogEntry {
  id: number;
  timestamp: string;
  type: 'webrtc' | 'server' | 'system' | 'auth' | 'warn' | 'error';
  message: string;
}

const MAX_LOGS = 100;
let logIdCounter = 0;
const logs: DaemonLogEntry[] = [];
const subscribers = new Set<() => void>();

let lastPingTime = 0;

export function addDaemonLog(
  type: DaemonLogEntry['type'],
  rawMessage: string
): void {
  const msg = typeof rawMessage === 'string' ? rawMessage : String(rawMessage);

  // Suppress excessive raw heartbeat / ping spam
  if (
    msg.includes('"action":"ping"') ||
    msg.includes("action: 'ping'") ||
    msg.includes('Incoming Action: ping') ||
    msg.includes('Action: ping')
  ) {
    const now = Date.now();
    if (now - lastPingTime < 15000) {
      return;
    }
    lastPingTime = now;
  }

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const entry: DaemonLogEntry = {
    id: ++logIdCounter,
    timestamp,
    type,
    message: msg.replace(/\r?\n/g, ' ').trim(),
  };

  logs.push(entry);
  if (logs.length > MAX_LOGS) {
    logs.shift();
  }

  for (const sub of subscribers) {
    try {
      sub();
    } catch {}
  }
}

export function logDaemonActivity(
  typeOrMessage: DaemonLogEntry['type'] | string,
  maybeMessage?: string
): void {
  if (maybeMessage !== undefined) {
    addDaemonLog(typeOrMessage as DaemonLogEntry['type'], maybeMessage);
  } else {
    const str = String(typeOrMessage);
    let type: DaemonLogEntry['type'] = 'system';
    if (str.includes('[WebRTC') || str.includes('WebRTC')) type = 'webrtc';
    else if (str.includes('[Server') || str.includes('server')) type = 'server';
    else if (str.includes('[AUTH') || str.includes('[VOID]')) type = 'auth';
    else if (str.toLowerCase().includes('warn')) type = 'warn';
    else if (str.toLowerCase().includes('err')) type = 'error';
    addDaemonLog(type, str);
  }
}

export function subscribeDaemonLogs(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

export function getDaemonLogs(): DaemonLogEntry[] {
  return [...logs];
}

let hijacked = false;
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
};

export function setupTuiLogger(): void {
  if (hijacked) return;
  hijacked = true;

  const formatArgs = (args: any[]): string => {
    return args
      .map(a => {
        if (typeof a === 'object' && a !== null) {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(' ');
  };

  console.log = (...args: any[]) => {
    const str = formatArgs(args);
    let type: DaemonLogEntry['type'] = 'system';
    if (str.includes('[WebRTC') || str.includes('WebRTC')) type = 'webrtc';
    else if (str.includes('[Server') || str.includes('server')) type = 'server';
    else if (str.includes('[AUTH') || str.includes('[VOID]')) type = 'auth';
    addDaemonLog(type, str);
  };

  console.info = (...args: any[]) => {
    addDaemonLog('system', formatArgs(args));
  };

  console.warn = (...args: any[]) => {
    addDaemonLog('warn', formatArgs(args));
  };

  console.error = (...args: any[]) => {
    addDaemonLog('error', formatArgs(args));
  };

  console.debug = (...args: any[]) => {
    const str = formatArgs(args);
    let type: DaemonLogEntry['type'] = 'system';
    if (str.includes('[WebRTC') || str.includes('WebRTC')) type = 'webrtc';
    addDaemonLog(type, str);
  };
}

export function restoreConsoleLogger(): void {
  if (!hijacked) return;
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  console.debug = originalConsole.debug;
  hijacked = false;
}
