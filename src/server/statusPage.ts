import { listServers, saveServerMeta, type ServerMeta } from './manager.js';
import { getServerStatus, getOnlinePlayers, getRunningServers } from './instance.js';
import { readProperties } from './properties.js';

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
  if (meta.statusId) return meta.statusId;
  const id = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
  meta.statusId = id;
  try { saveServerMeta(meta); } catch { }
  return id;
}

export async function updateAllServerStatusPages(): Promise<void> {
  try {
    const servers = listServers();
    const runningNames = getRunningServers();

    for (const meta of servers) {
      try {
        const statusId = ensureStatusId(meta);
        const status = getServerStatus(meta.name);
        const isRunning = runningNames.includes(meta.name) && (status === 'online' || status === 'starting');
        const onlinePlayers = isRunning ? getOnlinePlayers(meta.name) : [];
        const properties = await readProperties(meta.name);

        await restCommit([{
          update: {
            name: `${DOC_BASE}/server_status/${statusId}`,
            fields: {
              name: { stringValue: meta.name },
              online: { booleanValue: isRunning },
              status: { stringValue: status },
              playerCount: { integerValue: String(onlinePlayers.length) },
              maxPlayers: { integerValue: String(parseInt(properties['max-players'] || '20', 10)) },
              version: { stringValue: meta.version },
              serverType: { stringValue: meta.type },
              motd: { stringValue: properties['motd'] || 'A Void Minecraft Server' },
              ip: { stringValue: meta.localIp || '' },
              port: { integerValue: String(meta.port || 25565) },
              showIp: { booleanValue: meta.statusPageShowIp ?? false },
              theme: { stringValue: meta.statusPageTheme || 'default' },
              description: { stringValue: meta.statusPageDescription || '' },
              lastUpdated: { stringValue: new Date().toISOString() },
            },
          },
        }]);
      } catch {
        // skip individual failures
      }
    }
  } catch {
    // daemon may not have firebase yet
  }
}

export function startStatusPageUpdater(): () => void {
  updateAllServerStatusPages();
  const id = setInterval(updateAllServerStatusPages, 10000);
  return () => clearInterval(id);
}
