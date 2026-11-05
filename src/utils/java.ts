import { execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { getVoidDir } from './paths.js';
import { downloadFile } from './download.js';
import * as tar from 'tar';
import AdmZip from 'adm-zip';

export interface JavaInfo {
  found: boolean;
  version?: number;
  versionString?: string;
  isCompatible: boolean;
  executablePath?: string;
}

export function detectJava(versionRequired: number = 17): JavaInfo {
  // Check our locally installed Java first
  const installedPath = getLocalJavaPath(versionRequired);
  if (installedPath && fs.existsSync(installedPath)) {
    return {
      found: true,
      version: versionRequired,
      versionString: String(versionRequired),
      isCompatible: true,
      executablePath: installedPath,
    };
  }

  // Check system Java
  try {
    const output = execSync('java -version 2>&1', { encoding: 'utf-8', timeout: 5000 });
    const match = output.match(/version "([^"]+)"/);
    if (!match) return { found: true, isCompatible: false, executablePath: 'java' };

    const versionString = match[1];
    let majorVersion: number;

    if (versionString.startsWith('1.')) {
      majorVersion = parseInt(versionString.split('.')[1]);
    } else {
      majorVersion = parseInt(versionString.split('.')[0]);
    }

    // Old Minecraft (needs Java 8) won't run on Java 12+ — class file version too new.
    // Servers needing Java 17+ tolerate any newer version.
    const maxSafe = versionRequired <= 11 ? 11 : Infinity;
    const isCompatible = majorVersion >= versionRequired && majorVersion <= maxSafe;

    return {
      found: true,
      version: majorVersion,
      versionString,
      isCompatible,
      executablePath: 'java',
    };
  } catch {
    return { found: false, isCompatible: false };
  }
}

export function getRequiredJava(mcVersion: string): number {
  if (mcVersion.startsWith('1.')) {
    const minorStr = mcVersion.split('.')[1];
    const minor = minorStr ? parseInt(minorStr, 10) : 0;
    if (minor >= 25) return 25; // Hypothetical 1.25+
    if (minor >= 21) return 21; // 1.21+ requires Java 21
    if (minor >= 20) return 21; // 1.20.5+ requires Java 21
    if (minor >= 17) return 17;
    return 8;
  }
  
  // Handle new major versioning (e.g. 26.1.2)
  const majorMatch = mcVersion.match(/^(\d+)\./);
  if (majorMatch) {
    const major = parseInt(majorMatch[1], 10);
    if (major >= 25) return 25;
    if (major >= 21) return 21;
  }
  
  // Check for snapshot format (e.g. 24w14a, 25w01a, 26w...)
  const snapshotMatch = mcVersion.match(/^(\d{2})w/);
  if (snapshotMatch) {
    const year = parseInt(snapshotMatch[1], 10);
    if (year >= 25) return 25;
    if (year >= 24) return 21;
    if (year >= 21) return 17;
  }
  
  // Fallback for unknown versions
  return 21;
}

export function getLocalJavaPath(version: number): string | null {
  const javaDir = path.join(getVoidDir(), 'java', String(version));
  if (!fs.existsSync(javaDir)) return null;
  
  if (os.platform() === 'win32') {
    return path.join(javaDir, 'bin', 'java.exe');
  }
  return path.join(javaDir, 'bin', 'java');
}

export async function installJava(version: number, onProgress: (msg: string) => void): Promise<string> {
  const javaDir = path.join(getVoidDir(), 'java', String(version));
  if (fs.existsSync(javaDir)) {
    fs.rmSync(javaDir, { recursive: true, force: true });
  }
  fs.mkdirSync(javaDir, { recursive: true });

  const platformMap: Record<string, string> = {
    win32: 'windows',
    darwin: 'mac',
    linux: 'linux',
  };
  const archMap: Record<string, string> = {
    x64: 'x64',
    arm64: 'aarch64',
  };

  const adoptOs = platformMap[os.platform()];
  const adoptArch = archMap[os.arch()];

  if (!adoptOs || !adoptArch) {
    throw new Error(`Unsupported OS or Architecture for auto-download: ${os.platform()} ${os.arch()}`);
  }

  const extension = adoptOs === 'windows' ? 'zip' : 'tar.gz';
  const url = `https://api.adoptium.net/v3/binary/latest/${version}/ga/${adoptOs}/${adoptArch}/jre/hotspot/normal/eclipse`;

  onProgress(`Downloading Java ${version} (${adoptOs}/${adoptArch})...`);

  const tempFile = path.join(getVoidDir(), 'java', `temp_jre_${version}.${extension}`);
  await downloadFile(url, tempFile, pct => {
    onProgress(`Downloading Java ${version}... ${pct}%`);
  });

  onProgress(`Extracting Java ${version}...`);

  if (extension === 'zip') {
    const zip = new AdmZip(tempFile);
    zip.extractAllTo(javaDir, true);
  } else {
    await tar.x({
      file: tempFile,
      cwd: javaDir,
    });
  }

  // The extraction creates a subfolder (e.g., jdk-17.0.8.1+1-jre). Let's move its contents up.
  const files = fs.readdirSync(javaDir);
  const innerDir = files.find(f => fs.statSync(path.join(javaDir, f)).isDirectory());
  if (innerDir && files.length === 1) {
    const innerPath = path.join(javaDir, innerDir);
    const innerFiles = fs.readdirSync(innerPath);
    for (const f of innerFiles) {
      fs.renameSync(path.join(innerPath, f), path.join(javaDir, f));
    }
    fs.rmdirSync(innerPath);
  }

  fs.rmSync(tempFile, { force: true });
  
  if (os.platform() !== 'win32') {
    const javaBin = path.join(javaDir, 'bin', 'java');
    if (fs.existsSync(javaBin)) fs.chmodSync(javaBin, '755');
  }

  onProgress(`Java ${version} installed successfully.`);
  return getLocalJavaPath(version)!;
}
