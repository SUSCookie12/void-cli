import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import pidusage from 'pidusage';

const execFileAsync = promisify(execFile);

function sanitizePid(pid: number): number | null {
  const n = Math.floor(Number(pid));
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Windows 11+ often removes `wmic`; `pidusage` still spawns it and can crash the process.
 * Use PowerShell against the target PID instead.
 */
async function getWindowsPidStats(pid: number): Promise<{ memory: number; cpu: number } | null> {
  const safe = sanitizePid(pid);
  if (!safe) return null;

  const script = [
    '$ErrorActionPreference = "Stop"',
    `$targetPid = ${safe}`,
    '$p = Get-Process -Id $targetPid',
    '$sw = [Diagnostics.Stopwatch]::StartNew()',
    '$t1 = $p.TotalProcessorTime.TotalMilliseconds',
    'Start-Sleep -Milliseconds 180',
    '$p.Refresh()',
    '$t2 = $p.TotalProcessorTime.TotalMilliseconds',
    '$sw.Stop()',
    '$m = $p.WorkingSet64',
    '$cores = [int][Environment]::ProcessorCount',
    'if ($cores -lt 1) { $cores = 1 }',
    '$elapsed = $sw.Elapsed.TotalSeconds',
    '$cpuPct = 0',
    'if ($elapsed -gt 0) {',
    '  $cpuPct = [Math]::Min(100, (($t2 - $t1) / 1000.0) / $elapsed / $cores * 100.0)',
    '}',
    '[Console]::Out.WriteLine(($m.ToString()) + "," + ($cpuPct.ToString([System.Globalization.CultureInfo]::InvariantCulture)))',
  ].join('; ');

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024 }
    );
    const line = stdout.trim().split(/\r?\n/).pop() ?? '';
    const [memStr, cpuStr] = line.split(',');
    const memory = parseInt(memStr ?? '', 10);
    const cpu = parseFloat(cpuStr ?? '0');
    if (Number.isNaN(memory)) return null;
    return { memory, cpu: Number.isFinite(cpu) ? cpu : 0 };
  } catch {
    return null;
  }
}

/**
 * CPU % (approx) and RSS for a process. On Windows avoids `wmic` (removed on newer OS builds).
 */
export async function getPidCpuMemory(pid: number): Promise<{ memory: number; cpu: number } | null> {
  if (process.platform === 'win32') {
    return getWindowsPidStats(pid);
  }
  try {
    const stats = await pidusage(pid);
    const coreCount = os.cpus().length || 1;
    return {
      memory: stats.memory,
      cpu: stats.cpu / coreCount,
    };
  } catch {
    return null;
  }
}
