import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import archiver from 'archiver';
import extract from 'extract-zip';

// Helper to determine the path to the currently running entry script or bundle
const getCurrentFilePath = (): string => {
  if (typeof __filename !== 'undefined') {
    return __filename;
  }
  return path.resolve(process.argv[1]);
};

// Standalone JS worker code to be run in development via eval: true.
// Uses streaming archiver with Zip64 to handle archives of any size (>2GB, >4GB) without Buffer limits.
const devWorkerCode = `
(async () => {
  const { parentPort, workerData } = await import('worker_threads');
  const archiver = (await import('archiver')).default || (await import('archiver'));
  const fs = await import('fs');
  const path = await import('path');

  try {
    const { task, data } = workerData || {};
    if (task === 'zipFolder') {
      const { sourceFolder, destZipPath } = data;
      const output = fs.createWriteStream(destZipPath);
      const archive = archiver('zip', {
        zlib: { level: 6 },
        forceZip64: true,
      });

      let totalFiles = 0;
      archive.on('progress', (prog) => {
        if (prog.entries.total > totalFiles) totalFiles = prog.entries.total;
        const percent = totalFiles > 0
          ? Math.min(99, Math.round((prog.entries.processed / totalFiles) * 100))
          : 50;
        parentPort?.postMessage({ status: 'progress', percent });
      });

      output.on('close', () => {
        parentPort?.postMessage({ status: 'success' });
      });

      archive.on('error', (err) => {
        parentPort?.postMessage({ status: 'error', error: err.message || String(err) });
      });

      output.on('error', (err) => {
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
      archive.on('progress', (prog) => {
        if (prog.entries.total > totalFiles) totalFiles = prog.entries.total;
        const percent = totalFiles > 0
          ? Math.min(99, Math.round((prog.entries.processed / totalFiles) * 100))
          : 50;
        parentPort?.postMessage({ status: 'progress', percent });
      });

      output.on('close', () => {
        parentPort?.postMessage({ status: 'success' });
      });

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
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const workerPath = getCurrentFilePath();
      const isDev = workerPath.endsWith('.ts') || workerPath.endsWith('.tsx');
      
      const workerData = {
        task: 'zipFolder',
        data: { sourceFolder, destZipPath }
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
      
      const workerData = {
        task: 'zipSelection',
        data: { rootDir, selections, destZipPath }
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
