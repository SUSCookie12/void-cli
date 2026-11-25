import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
// @ts-ignore
import archiver from 'archiver';
import extract from 'extract-zip';

// Helper to determine the path to the currently running entry script or bundle
const getCurrentFilePath = (): string => {
  if (typeof __filename !== 'undefined') {
    return __filename;
  }
  return path.resolve(process.argv[1]);
};

export function getFolderTotalBytes(folderPath: string): number {
  let total = 0;
  if (!fs.existsSync(folderPath)) return 0;
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'backups') continue;
      const fullPath = path.join(folderPath, entry.name);
      if (entry.isDirectory()) {
        total += getFolderTotalBytes(fullPath);
      } else if (entry.isFile()) {
        try {
          total += fs.statSync(fullPath).size;
        } catch {}
      }
    }
  } catch {}
  return total;
}

export function getSelectionTotalBytes(rootDir: string, selections: string[]): number {
  let total = 0;
  for (const sel of selections) {
    const full = path.resolve(rootDir, sel);
    if (!fs.existsSync(full)) continue;
    try {
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        total += getFolderTotalBytes(full);
      } else if (stat.isFile()) {
        total += stat.size;
      }
    } catch {}
  }
  return total;
}

// Standalone JS worker code to be run in development via eval: true.
// Uses streaming archiver with Zip64 to handle archives of any size (>2GB, >4GB) without Buffer limits.
const devWorkerCode = `
(async () => {
  const { parentPort, workerData } = require('worker_threads');
  const fs = require('fs');
  const path = require('path');

  try {
    const archiverModule = await import('archiver');
    const createZipArchive = (opts) => {
      if (typeof archiverModule.ZipArchive === 'function') return new archiverModule.ZipArchive(opts);
      const fn = archiverModule.default || archiverModule;
      if (typeof fn === 'function') return fn('zip', opts);
      throw new Error('Archiver ZipArchive constructor not found');
    };

    const { task, data } = workerData || {};
    if (task === 'zipFolder') {
      const { sourceFolder, destZipPath, totalBytes = 0 } = data;
      const output = fs.createWriteStream(destZipPath);
      const archive = createZipArchive({
        zlib: { level: 1 },
        forceZip64: true,
      });

      let lastPercent = -1;
      archive.on('progress', (prog) => {
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

      archive.on('error', (err) => {
        parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
      });

      output.on('error', (err) => {
        parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
      });

      archive.pipe(output);
      archive.directory(sourceFolder, false, (data) => (data.name === 'backups' || data.name.startsWith('backups/') || data.name.startsWith('backups\\\\')) ? false : data);
      await archive.finalize();
    } else if (task === 'zipSelection') {
      const { rootDir, selections, destZipPath, totalBytes = 0 } = data;
      const output = fs.createWriteStream(destZipPath);
      const archive = createZipArchive({
        zlib: { level: 1 },
        forceZip64: true,
      });

      let lastPercent = -1;
      archive.on('progress', (prog) => {
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

      archive.on('error', (err) => {
        parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
      });

      output.on('error', (err) => {
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
      parentPort?.postMessage({ status: 'error', error: 'Unknown task: ' + task });
    }
  } catch (err) {
    parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
  }
})();
`;

export function compressFolder(
  sourceFolder: string,
  destZipPath: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
  excludedDir?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const workerPath = getCurrentFilePath();
      const isDev = workerPath.endsWith('.ts') || workerPath.endsWith('.tsx');
      const totalBytes = getFolderTotalBytes(sourceFolder, excludedDir);
      
      const workerData = {
        task: 'zipFolder',
        data: { sourceFolder, destZipPath, totalBytes, excludedDir }
      };

      const worker = isDev
        ? new Worker(devWorkerCode, { eval: true, workerData })
        : new Worker(workerPath, { workerData });

      worker.on('message', (msg) => {
        if (msg.status === 'progress') {
          if (onProgress) onProgress(msg.percent);
        } else if (msg.status === 'success') {
          if (onProgress) onProgress(100);
          resolve();
        } else {
          reject(new Error(msg.error || 'Zipping failed in background worker'));
        }
      });

      worker.on('error', (err) => {
        reject(err);
      });
      
      worker.on('exit', (code) => {
        if (code !== 0 && !signal?.aborted) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });

      if (signal) {
        signal.addEventListener('abort', () => {
          worker.terminate();
          if (fs.existsSync(destZipPath)) {
            try { fs.unlinkSync(destZipPath); } catch {}
          }
          reject(new Error('Backup aborted'));
        });
      }
    } catch (err) {
      reject(err);
    }
  });
}

export async function extractArchive(archivePath: string, destFolder: string): Promise<void> {
  const ext = path.extname(archivePath).toLowerCase();
  
  if (ext === '.zip') {
    await extract(archivePath, { dir: path.resolve(destFolder) });
  } else if (ext === '.gz' || ext === '.tgz' || ext === '.tar') {
    tar.x({
      file: archivePath,
      cwd: destFolder,
      sync: true
    });
  } else {
    throw new Error('Unsupported archive format: ' + ext);
  }
}

export function createZipFromSelection(
  rootDir: string,
  selections: string[],
  destZipPath: string,
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const workerPath = getCurrentFilePath();
      const isDev = workerPath.endsWith('.ts') || workerPath.endsWith('.tsx');
      
      const totalBytes = getSelectionTotalBytes(rootDir, selections);
      const workerData = {
        task: 'zipSelection',
        data: { rootDir, selections, destZipPath, totalBytes }
      };

      const worker = isDev
        ? new Worker(devWorkerCode, { eval: true, workerData })
        : new Worker(workerPath, { workerData });

      worker.on('message', (msg) => {
        if (msg.status === 'progress') {
          if (onProgress) onProgress(msg.percent);
        } else if (msg.status === 'success') {
          if (onProgress) onProgress(100);
          resolve();
        } else {
          reject(new Error(msg.error || 'Zipping failed in background worker'));
        }
      });

      worker.on('error', (err) => {
        reject(err);
      });
      
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}
