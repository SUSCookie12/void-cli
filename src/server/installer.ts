import fs from 'node:fs';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { getServerDir } from '../utils/paths.js';
import { getVanillaServerUrl } from '../api/mojang.js';
import { getLatestPaperInfo } from '../api/paper.js';
import { saveServerMeta } from './manager.js';
import type { ServerMeta } from './manager.js';

export interface InstallProgress {
  stage: 'creating' | 'downloading' | 'configuring' | 'done' | 'error';
  progress: number; // 0–100
  message: string;
  error?: string;
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

    // 2. Resolve download URL
    onProgress({ stage: 'downloading', progress: 5, message: 'Fetching download URL...' });
    let downloadUrl: string;

    if (meta.type === 'vanilla') {
      downloadUrl = await getVanillaServerUrl(meta.version);
    } else {
      const info = await getLatestPaperInfo(meta.version);
      meta.build = info.build;
      downloadUrl = info.url;
    }

    // 3. Download JAR with progress
    onProgress({ stage: 'downloading', progress: 10, message: `Downloading ${meta.type} ${meta.version}...` });
    await downloadFile(downloadUrl, path.join(serverDir, 'server.jar'), pct => {
      onProgress({
        stage: 'downloading',
        progress: Math.floor(10 + pct * 0.82),
        message: `Downloading ${meta.type} ${meta.version}... ${pct}%`,
      });
    });

    // 4. Configure
    onProgress({ stage: 'configuring', progress: 94, message: 'Writing configuration...' });

    // EULA acceptance
    fs.writeFileSync(path.join(serverDir, 'eula.txt'), '#Auto-accepted by Void Server\neula=true\n');

    // Default server.properties
    const props = [
      `server-port=${meta.port}`,
      'online-mode=true',
      'max-players=20',
      'view-distance=10',
      'simulation-distance=10',
      'level-name=world',
      `motd=\\u00A76\\u00A7l${meta.name}\\u00A7r \\u00A77| Void Server`,
      'enable-command-block=false',
      'spawn-protection=16',
      'difficulty=normal',
      'gamemode=survival',
      'pvp=true',
    ].join('\n');
    fs.writeFileSync(path.join(serverDir, 'server.properties'), props);

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

async function downloadFile(
  url: string,
  dest: string,
  onProgress: (pct: number) => void
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const contentLength = res.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength) : 0;
  let downloaded = 0;

  const fileStream = createWriteStream(dest);
  const reader = res.body!.getReader();

  return new Promise((resolve, reject) => {
    fileStream.on('error', reject);

    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            fileStream.end(() => resolve());
            break;
          }
          downloaded += value.length;
          if (total > 0) onProgress(Math.floor((downloaded / total) * 100));
          await new Promise<void>((ok, fail) => {
            fileStream.write(value, err => (err ? fail(err) : ok()));
          });
        }
      } catch (err) {
        fileStream.destroy();
        reject(err);
      }
    };

    pump();
  });
}
