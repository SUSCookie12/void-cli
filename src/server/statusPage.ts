import { listServers, saveServerMeta, slugifyServerName, type ServerMeta } from './manager.js';
import { getServerStatus, getOnlinePlayers, getRunningServers } from './instance.js';
import { readProperties } from './properties.js';
import { VOID_DOMAIN } from '../config/dns.js';

const API_KEY = 'AIzaSyAxkQA5tBqp_5fco6Y_8i2mhI15ECJeNh0';
const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/cookiemovie-27669/databases/(default)';
const DOC_BASE = 'projects/cookiemovie-27669/databases/(default)/documents';

async function restCommit(writes: any[]): Promise<void> {
  try {
    await fetch(`${FIRESTORE_BASE}/documents:commit?key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ writes }),
    });
  } catch {}
}

function ensureStatusId(meta: ServerMeta): string {
  if (meta.isFrozen) {
    return meta.statusId || slugifyServerName(meta.name);
  }
  if (meta.statusId && meta.statusId !== meta.subdomain) {
    return meta.statusId;
  }
  const id = slugifyServerName(meta.name);
  meta.statusId = id;
  try { saveServerMeta(meta); } catch {}
  return id;
}

export async function setServerFrozenStatus(meta: ServerMeta): Promise<void> {
  try {
    const statusId = ensureStatusId(meta);
    const frozenFields = {
      name: { stringValue: meta.name },
      online: { booleanValue: false },
      status: { stringValue: 'frozen' },
      isFrozen: { booleanValue: true },
      playerCount: { integerValue: '0' },
      maxPlayers: { integerValue: '0' },
      version: { stringValue: meta.version || '' },
      serverType: { stringValue: meta.type || '' },
      motd: { stringValue: 'Server is frozen in cold storage.' },
      ip: { stringValue: '' },
      port: { integerValue: '0' },
      showIp: { booleanValue: false },
      theme: { stringValue: meta.statusPageTheme || 'default' },
      description: { stringValue: meta.statusPageDescription || '' },
      isPublic: { booleanValue: false },
      lastUpdated: { stringValue: new Date().toISOString() },
    };

    const writes: any[] = [{
      update: {
        name: `${DOC_BASE}/server_status/${statusId}`,
        fields: frozenFields,
      },
    }];

    if (meta.previousSubdomain && meta.previousSubdomain !== statusId) {
      writes.push({
        update: {
          name: `${DOC_BASE}/server_status/${meta.previousSubdomain}`,
          fields: frozenFields,
        },
      });
    }

    await restCommit(writes);
  } catch {}
}

const stateCache = new Map<string, { signature: string; timestamp: number }>();

export async function updateAllServerStatusPages(force: boolean = false): Promise<void> {
  try {
    const servers = listServers();
    const runningNames = getRunningServers();
    const now = Date.now();

    for (const meta of servers) {
      try {
        const statusId = ensureStatusId(meta);
        if (meta.isFrozen) {
          await setServerFrozenStatus(meta);
          continue;
        }

        const status = getServerStatus(meta.name);
        const isRunning = runningNames.includes(meta.name) && (status === 'online' || status === 'starting');
        const onlinePlayers = isRunning ? getOnlinePlayers(meta.name) : [];
        const properties = await readProperties(meta.name);
        const publicIp = meta.subdomain ? `${meta.subdomain}.${VOID_DOMAIN}` : (meta.localIp || '');
        const maxPlayers = String(parseInt(properties['max-players'] || '20', 10));
        const motd = properties['motd'] || 'A Void Minecraft Server';
        const isPub = Boolean(meta.isPublic);

        const currentSignature = `${statusId}|${meta.name}|${isRunning}|${status}|${onlinePlayers.length}|${maxPlayers}|${meta.version}|${meta.type}|${motd}|${publicIp}|${meta.statusPageShowIp ?? true}|${meta.statusPageTheme || 'default'}|${meta.statusPageDescription || ''}|${isPub}`;
        const cached = stateCache.get(statusId);

        // If state hasn't changed and it's been less than 50 seconds since last heartbeat, skip write to save quota
        if (!force && cached && cached.signature === currentSignature && (now - cached.timestamp < 50000)) {
          continue;
        }

        const statusFields = {
          name: { stringValue: meta.name },
          online: { booleanValue: isRunning },
          status: { stringValue: status },
          playerCount: { integerValue: String(onlinePlayers.length) },
          maxPlayers: { integerValue: maxPlayers },
          version: { stringValue: meta.version },
          serverType: { stringValue: meta.type },
          motd: { stringValue: motd },
          ip: { stringValue: publicIp },
          port: { integerValue: String(meta.subdomain ? 25565 : (meta.port || 25565)) },
          showIp: { booleanValue: meta.statusPageShowIp ?? true },
          theme: { stringValue: meta.statusPageTheme || 'default' },
          description: { stringValue: meta.statusPageDescription || '' },
          isPublic: { booleanValue: isPub },
          lastUpdated: { stringValue: new Date().toISOString() },
        };

        const writes: any[] = [{
          update: {
            name: `${DOC_BASE}/server_status/${statusId}`,
            fields: statusFields,
          },
        }];

        if (meta.subdomain && meta.subdomain !== statusId) {
          writes.push({
            update: {
              name: `${DOC_BASE}/server_status/${meta.subdomain}`,
              fields: statusFields,
            },
          });
        }

        await restCommit(writes);
        stateCache.set(statusId, { signature: currentSignature, timestamp: now });
      } catch {
        // skip individual failures
      }
    }
  } catch {
    // daemon may not have firebase yet
  }
}

export function startStatusPageUpdater(): () => void {
  updateAllServerStatusPages(true);
  const id = setInterval(() => {
    void updateAllServerStatusPages(false);
  }, 35000);
  return () => clearInterval(id);
}
