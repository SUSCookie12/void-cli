import fs from 'node:fs';
import os from 'node:os';

let previousCpu: { idle: number; total: number } | null = null;

function sampleCpuTotals() {
  return os.cpus().reduce(
    (acc, cpu) => {
      const t = cpu.times;
      acc.idle += t.idle;
      acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
      return acc;
    },
    { idle: 0, total: 0 },
  );
}

export function getHostCpuPercent(): number {
  const now = sampleCpuTotals();
  if (!previousCpu) {
    previousCpu = now;
    return 0;
  }
  const idleDiff = now.idle - previousCpu.idle;
  const totalDiff = now.total - previousCpu.total;
  previousCpu = now;
  if (totalDiff <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100));
}

function getLinuxAvailableMem(): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const memInfo = fs.readFileSync('/proc/meminfo', 'utf-8');
    const match = memInfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (!match) return null;
    return Number.parseInt(match[1], 10) * 1024;
  } catch {
    return null;
  }
}

export function getHostMemoryStats() {
  const freeMem = os.freemem();
  return {
    freeMem,
    totalMem: os.totalmem(),
    availableMem: getLinuxAvailableMem() ?? freeMem,
  };
}
