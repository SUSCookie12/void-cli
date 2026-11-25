#!/usr/bin/env node
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
// @ts-ignore
import * as archiverModule from 'archiver';
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
      const createZipArchive = (opts: any) => {
        const mod = archiverModule as any;
        if (typeof mod?.ZipArchive === 'function') return new mod.ZipArchive(opts);
        const fn = mod?.default || mod;
        if (typeof fn === 'function') return fn('zip', opts);
        throw new Error('Archiver ZipArchive constructor not found');
      };

      if (task === 'zipFolder') {
        const { sourceFolder, destZipPath, totalBytes = 0 } = data;
        const output = fs.createWriteStream(destZipPath);
        const archive = createZipArchive({
          zlib: { level: 1 },
          forceZip64: true,
        });

        let lastPercent = -1;
        archive.on('progress', (prog: any) => {
          let percent = 0;
          if (totalBytes > 0 && typeof prog?.fs?.processedBytes === 'number') {
            percent = Math.min(99, Math.max(1, Math.round((prog.fs.processedBytes / totalBytes) * 100)));
          } else if (prog?.entries?.total > 0 && prog?.entries?.processed > 0) {
            percent = Math.min(99, Math.max(1, Math.round((prog.entries.processed / prog.entries.total) * 100)));
          } else {
            percent = 5;
          }
          if (percent !== lastPercent) {
            lastPercent = percent;
            parentPort?.postMessage({ status: 'progress', percent });
          }
        });

        let finished = false;
        const markSuccess = () => {
          if (!finished) {
            finished = true;
            parentPort?.postMessage({ status: 'success' });
          }
        };

        output.on('close', markSuccess);
        output.on('finish', markSuccess);

        archive.on('error', (err: any) => {
          parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
        });

        output.on('error', (err: any) => {
          parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
        });

        archive.pipe(output);
        archive.directory(sourceFolder, false, (data: any) => (data.name === 'backups' || data.name.startsWith('backups/') || data.name.startsWith('backups\\\\')) ? false : data);
        await archive.finalize();
      } else if (task === 'zipSelection') {
        const { rootDir, selections, destZipPath, totalBytes = 0 } = data;
        const output = fs.createWriteStream(destZipPath);
        const archive = createZipArchive({
          zlib: { level: 1 },
          forceZip64: true,
        });

        let lastPercent = -1;
        archive.on('progress', (prog: any) => {
          let percent = 0;
          if (totalBytes > 0 && typeof prog?.fs?.processedBytes === 'number') {
            percent = Math.min(99, Math.max(1, Math.round((prog.fs.processedBytes / totalBytes) * 100)));
          } else if (prog?.entries?.total > 0 && prog?.entries?.processed > 0) {
            percent = Math.min(99, Math.max(1, Math.round((prog.entries.processed / prog.entries.total) * 100)));
          } else {
            percent = 5;
          }
          if (percent !== lastPercent) {
            lastPercent = percent;
            parentPort?.postMessage({ status: 'progress', percent });
          }
        });

        let finished = false;
        const markSuccess = () => {
          if (!finished) {
            finished = true;
            parentPort?.postMessage({ status: 'success' });
          }
        };

        output.on('close', markSuccess);
        output.on('finish', markSuccess);

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
