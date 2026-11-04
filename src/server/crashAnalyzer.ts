import fs from 'node:fs';
import path from 'node:path';
import { getServerDir } from '../utils/paths.js';

export interface CrashAnalysis {
  detected: boolean;
  category: 'none' | 'oom' | 'mod_dependency' | 'java_version' | 'port_conflict' | 'world_corruption' | 'eula' | 'generic';
  title: string;
  summary: string;
  solution: string;
  file?: string;
  timestamp?: string;
}

export function sanitizeLog(content: string): string {
  let sanitized = content;

  // Redact public/private IPv4 addresses (leaving local loopback/bind clean)
  sanitized = sanitized.replace(/\b(?!(?:127\.0\.0\.1|0\.0\.0\.0)\b)(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b/g, '[REDACTED_IP]');

  // Redact Windows user paths (e.g. C:\Users\Username\... -> C:\Users\[USER]\...)
  sanitized = sanitized.replace(/([a-zA-Z]:[\\/]Users[\\/])[^\\/\s:;]+/gi, '$1[REDACTED_USER]');

  // Redact Linux/Mac home paths (/home/username/... -> /home/[USER]/...)
  sanitized = sanitized.replace(/(\/(?:home|Users)\/)[^/\s:;]+/gi, '$1[REDACTED_USER]');

  // Redact potential player session tokens or credentials
  sanitized = sanitized.replace(/(session[_\-\s]?id|token|secret)[=:\s]+[a-zA-Z0-9_\-\.]{16,}/gi, '$1=[REDACTED_TOKEN]');

  return sanitized;
}

export async function uploadToMclogs(rawContent: string): Promise<{ success: boolean; url?: string; id?: string; error?: string }> {
  try {
    const sanitized = sanitizeLog(rawContent);
    // Limit to 10MB safe payload size
    const payload = sanitized.slice(-1000000);

    const formData = new URLSearchParams();
    formData.append('content', payload);

    const response = await fetch('https://api.mclo.gs/1/log', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      return { success: false, error: `mclo.gs returned status ${response.status}` };
    }

    const data = await response.json() as { success: boolean; id?: string; url?: string; error?: string };
    if (data.success && data.url) {
      return { success: true, url: data.url, id: data.id };
    }
    return { success: false, error: data.error || 'Failed to generate log link' };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

export function analyzeLogs(logText: string, latestCrashReport?: string): CrashAnalysis {
  const combined = `${latestCrashReport ? latestCrashReport + '\n' : ''}${logText}`;

  // 1. Out of Memory (OOM)
  if (/java\.lang\.OutOfMemoryError/i.test(combined) || /GC overhead limit exceeded/i.test(combined)) {
    return {
      detected: true,
      category: 'oom',
      title: 'Out of Memory (Java Heap Exhausted)',
      summary: 'The server ran out of allocated memory (RAM) and was terminated by the JVM.',
      solution: 'Increase allocated RAM in server settings (e.g. +1GB or +2GB) or decrease simulation-distance in server.properties.',
    };
  }

  // 2. Mod Dependency Missing (Fabric / Quilt / Forge / NeoForge)
  const fabricDepMatch = combined.match(/Mod '([^']+)'(?: \([^)]+\))? requires (?:version [^\s]+ of )?'([^']+)'/i)
    || combined.match(/requires mod '([^']+)'/i)
    || combined.match(/requires ([a-zA-Z0-9_\-]+), which is missing!/i);

  if (fabricDepMatch) {
    const missing = fabricDepMatch[2] || fabricDepMatch[1];
    return {
      detected: true,
      category: 'mod_dependency',
      title: 'Missing Mod Dependency',
      summary: `A mod requires dependency '${missing}' which is not installed in the mods folder.`,
      solution: `Download and add '${missing}' (or compatible version) to your server mods directory.`,
    };
  }

  const forgeDepMatch = combined.match(/Mod file ([^\s]+) needs ([^\s]+) which is missing/i)
    || combined.match(/Missing or incompatible dependencies: (.*)/i);
  if (forgeDepMatch) {
    const missing = forgeDepMatch[2] || forgeDepMatch[1];
    return {
      detected: true,
      category: 'mod_dependency',
      title: 'Missing Forge/NeoForge Dependency',
      summary: `Forge/NeoForge detected missing dependencies: ${missing}`,
      solution: `Download and install the required library/mod (${missing}) to your mods directory.`,
    };
  }

  // 3. Incompatible Java Runtime Version
  const javaClassMatch = combined.match(/has been compiled by a more recent version of the Java Runtime \(class file version (\d+)\)/i);
  if (javaClassMatch) {
    const classVer = parseInt(javaClassMatch[1], 10);
    let neededJava = 'newer';
    if (classVer >= 65) neededJava = 'Java 21';
    else if (classVer >= 61) neededJava = 'Java 17';
    else if (classVer >= 55) neededJava = 'Java 11';
    else if (classVer >= 52) neededJava = 'Java 8';

    return {
      detected: true,
      category: 'java_version',
      title: 'Incompatible Java Runtime Version',
      summary: `A mod or server jar requires ${neededJava} (class file version ${classVer}), but the current Java runtime is older.`,
      solution: `Switch the server to ${neededJava} in the Java & Startup settings tab.`,
    };
  }

  // 4. Port Conflict
  if (/FAILED TO BIND TO PORT!/i.test(combined) || /java\.net\.BindException: Address already in use/i.test(combined)) {
    const portMatch = combined.match(/(?:port|bind to port!?\s*:?)\s*(\d{4,5})/i);
    const port = portMatch ? portMatch[1] : 'the configured port';
    return {
      detected: true,
      category: 'port_conflict',
      title: 'Port Already in Use',
      summary: `Cannot bind to port ${port}. Another application or running Minecraft server is already using this port.`,
      solution: `Change server-port in server.properties or close the conflicting application.`,
    };
  }

  // 5. Corrupted World Chunk
  const chunkMatch = combined.match(/Corrupt chunk at \[(-?\d+),\s*(-?\d+)\]/i)
    || combined.match(/ChunkStorageException/i)
    || combined.match(/Failed to read chunk \[(-?\d+),\s*(-?\d+)\]/i);

  if (chunkMatch) {
    const coords = chunkMatch[1] && chunkMatch[2] ? `[${chunkMatch[1]}, ${chunkMatch[2]}]` : 'an unknown coordinate';
    return {
      detected: true,
      category: 'world_corruption',
      title: 'Corrupted World Chunk Detected',
      summary: `Minecraft encountered a corrupted or unreadable region chunk at ${coords}.`,
      solution: `Use the Worlds & Region Manager tab to trim or reset the affected region file, or restore from a backup.`,
    };
  }

  // 6. EULA Not Accepted
  if (/You need to agree to the EULA in order to run the server/i.test(combined)) {
    return {
      detected: true,
      category: 'eula',
      title: 'Minecraft EULA Not Accepted',
      summary: 'Minecraft requires accepting the Mojang End User License Agreement before starting.',
      solution: 'Click the Accept EULA button in the dashboard or set eula=true in eula.txt.',
    };
  }

  return {
    detected: false,
    category: 'none',
    title: 'No Issues Detected',
    summary: 'No active crashes or critical errors detected in recent logs.',
    solution: '',
  };
}

export function getLatestCrashReport(serverName: string): { content?: string; filename?: string; timestamp?: string } | null {
  try {
    const crashDir = path.join(getServerDir(serverName), 'crash-reports');
    if (!fs.existsSync(crashDir)) return null;

    const files = fs.readdirSync(crashDir)
      .filter(f => f.startsWith('crash-') && f.endsWith('.txt'))
      .map(f => ({
        name: f,
        time: fs.statSync(path.join(crashDir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time);

    if (files.length === 0) return null;

    const latest = files[0];
    const fullPath = path.join(crashDir, latest.name);
    const content = fs.readFileSync(fullPath, 'utf-8');

    return {
      content,
      filename: latest.name,
      timestamp: new Date(latest.time).toISOString(),
    };
  } catch {
    return null;
  }
}
