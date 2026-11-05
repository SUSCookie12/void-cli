#!/usr/bin/env node
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createInterface } from 'node:readline';
import { startUI } from './ui/App.js';
import { initFirebase } from './config/firebase.js';
import { enforceVoidServerVersionFromRemote } from './config/remoteVersion.js';
import { DAEMON_VERSION } from './version.js';
import { stopAllServers, setShuttingDown } from './server/instance.js';
import { setupTuiLogger } from './utils/activityLogger.js';
import { startScheduler } from './server/scheduler.js';
import { startStatusPageUpdater } from './server/statusPage.js';

if (!isMainThread) {
  // Background worker thread using streaming archiver (Zip64 support for >2GB archives)
  const runWorkerTask = async () => {
    try {
      const { task, data } = workerData || {};
      const archiverModule = await import('archiver');
      const archiver = (archiverModule as any).default || archiverModule;
      const fs = await import('node:fs');
      const path = await import('node:path');

      if (task === 'zipFolder') {
        const { sourceFolder, destZipPath } = data;
        const output = fs.createWriteStream(destZipPath);
        const archive = archiver('zip', {
          zlib: { level: 6 },
          forceZip64: true,
        });

        let totalFiles = 0;
        archive.on('progress', (prog: any) => {
          if (prog.entries.total > totalFiles) totalFiles = prog.entries.total;
          const percent = totalFiles > 0
            ? Math.min(99, Math.round((prog.entries.processed / totalFiles) * 100))
            : 50;
          parentPort?.postMessage({ status: 'progress', percent });
        });

        output.on('close', () => {
          parentPort?.postMessage({ status: 'success' });
        });

        archive.on('error', (err: any) => {
          parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
        });

        output.on('error', (err: any) => {
          parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
        });

        archive.pipe(output);
        archive.directory(sourceFolder, false);
        await archive.finalize();
      } else if (task === 'zipSelection') {
        const { rootDir, selections, destZipPath } = data;
        const output = fs.createWriteStream(destZipPath);
        const archive = archiver('zip', {
          zlib: { level: 6 },
          forceZip64: true,
        });

        let totalFiles = 0;
        archive.on('progress', (prog: any) => {
          if (prog.entries.total > totalFiles) totalFiles = prog.entries.total;
          const percent = totalFiles > 0
            ? Math.min(99, Math.round((prog.entries.processed / totalFiles) * 100))
            : 50;
          parentPort?.postMessage({ status: 'progress', percent });
        });

        output.on('close', () => {
          parentPort?.postMessage({ status: 'success' });
        });

        archive.on('error', (err: any) => {
          parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
        });

        output.on('error', (err: any) => {
          parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
        });

        archive.pipe(output);
        for (const selection of selections) {
          const fullPath = path.resolve(rootDir, selection);
          if (!fs.existsSync(fullPath)) continue;
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            archive.directory(fullPath, selection);
          } else {
            archive.file(fullPath, { name: selection });
          }
        }
        await archive.finalize();
      } else {
        parentPort?.postMessage({ status: 'error', error: `Unknown task: ${task}` });
      }
    } catch (err: any) {
      parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
    }
  };
  void runWorkerTask();
} else {
  // Main thread execution
  process.title = 'void-server';

  if (process.argv.includes('--version')) {
    console.log(DAEMON_VERSION);
    process.exit(0);
  }

  // Handle graceful shutdown
  const shutdown = async () => {
    try {
      setShuttingDown(true);
      console.log('\n[VOID] Shutting down Void Server gracefully...');
      await stopAllServers();
    } catch (err) {
      console.error('[VOID] Error during shutdown:', err);
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  async function main(): Promise<void> {
    if (process.stdin.isTTY) {
      setupTuiLogger();
    }
    await enforceVoidServerVersionFromRemote();
    initFirebase();
    startScheduler();
    startStatusPageUpdater();
    startUI();

    // Headless mode: read JSON commands from stdin
    if (!process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin });
      rl.on('line', (line: string) => {
        try {
          const msg = JSON.parse(line.trim());
          if (msg.command === 'shutdown') {
            console.log('[VOID] Shutdown command received via stdin');
            rl.close();
            void shutdown();
          }
        } catch {
          // ignore malformed JSON
        }
      });
    }
  }

  void main();
}
