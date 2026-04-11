import AdmZip from 'adm-zip';
import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';

export function compressFolder(sourceFolder: string, destZipPath: string): void {
  const zip = new AdmZip();
  zip.addLocalFolder(sourceFolder);
  zip.writeZip(destZipPath);
}

export function extractArchive(archivePath: string, destFolder: string): void {
  const ext = path.extname(archivePath).toLowerCase();
  
  if (ext === '.zip') {
    const zip = new AdmZip(archivePath);
    zip.extractAllTo(destFolder, true);
  } else if (ext === '.gz' || ext === '.tgz' || ext === '.tar') {
    tar.x({
      file: archivePath,
      cwd: destFolder,
      sync: true
    });
  } else {
    throw new Error('Unsupported archive format');
  }
}

export function createZipFromSelection(rootDir: string, selections: string[], destZipPath: string): void {
  const zip = new AdmZip();
  for (const selection of selections) {
    const fullPath = path.resolve(rootDir, selection);
    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      zip.addLocalFolder(fullPath, selection);
    } else {
      zip.addLocalFile(fullPath);
    }
  }
  zip.writeZip(destZipPath);
}
