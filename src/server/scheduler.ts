import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getServersDir, getServerDir, getLocalBackupsDir } from '../utils/paths.js';
import { listServers, getServerMeta } from './manager.js';
import { startServer, stopServer, restartServer, sendCommand, isRunning, getServerStatus, isEulaAccepted } from './instance.js';
import { loadBackupConfig } from '../auth/session.js';
import { compressFolder } from '../utils/zipper.js';
import { broadcastToWebRtc } from '../network/webrtc.js';

export interface ScheduleNode {
  id: string;
  name: string;
  enabled: boolean;
  repeat: boolean;
  scheduleType: 'interval' | 'cron' | 'time';
  intervalMinutes: number;
  cronExpr: string;
  hour: number;
  minute: number;
  second: number;
  action: 'command' | 'start' | 'stop' | 'restart' | 'backup';
  command?: string;
  backupTarget?: 'local' | 'cloud';
  stopBeforeBackup: boolean;
  startAfterBackup: boolean;
  lastRun: string | null;
  nextRun: string | null;
  createdAt: string;
}

export interface ScheduleLog {
  id: string;
  scheduleId: string;
  scheduleName: string;
  action: 'command' | 'start' | 'stop' | 'restart' | 'backup';
  status: 'success' | 'failed' | 'running';
  message: string;
  details?: string;
  triggeredAt: string;
  completedAt: string | null;
}

function parseField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      let start = min, end = max;
      if (range !== '*') {
        if (range.includes('-')) { const [s, e] = range.split('-').map(Number); start = s; end = e; }
        else { start = parseInt(range, 10); }
      }
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      const val = parseInt(part, 10);
      if (!isNaN(val)) values.add(val);
    }
  }
  return values;
}

function getNextCronOccurrence(cronExpr: string, fromDate = new Date()): Date {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Invalid cron expression');
  const [minField, hourField, domField, monthField, dowField] = fields;
  const minutes = parseField(minField, 0, 59);
  const hours = parseField(hourField, 0, 23);
  const doms = parseField(domField, 1, 31);
  const months = parseField(monthField, 1, 12);
  const dows = parseField(dowField, 0, 6);
  let checkDate = new Date(fromDate.getTime());
  checkDate.setSeconds(0, 0);
  checkDate.setMinutes(checkDate.getMinutes() + 1);
  const maxSearchTime = fromDate.getTime() + 5 * 365 * 24 * 60 * 60 * 1000;
  while (checkDate.getTime() < maxSearchTime) {
    const currentMonth = checkDate.getMonth() + 1;
    if (!months.has(currentMonth)) { checkDate.setMonth(checkDate.getMonth() + 1); checkDate.setDate(1); checkDate.setHours(0, 0, 0, 0); continue; }
    const currentDom = checkDate.getDate();
    if (!doms.has(currentDom)) { checkDate.setDate(checkDate.getDate() + 1); checkDate.setHours(0, 0, 0, 0); continue; }
    const currentDow = checkDate.getDay();
    if (!dows.has(currentDow)) { checkDate.setDate(checkDate.getDate() + 1); checkDate.setHours(0, 0, 0, 0); continue; }
    const currentHour = checkDate.getHours();
    if (!hours.has(currentHour)) { checkDate.setHours(checkDate.getHours() + 1); checkDate.setMinutes(0, 0, 0); continue; }
    const currentMin = checkDate.getMinutes();
    if (!minutes.has(currentMin)) { checkDate.setMinutes(checkDate.getMinutes() + 1); continue; }
    return checkDate;
  }
  throw new Error('No cron occurrence within 5 years');
}

function computeNextRunTime(node: ScheduleNode, baseDate = new Date()): Date {
  const now = baseDate.getTime();
  if (node.scheduleType === 'interval') return new Date(now + node.intervalMinutes * 60 * 1000);
  if (node.scheduleType === 'time') {
    const d = new Date(now);
    d.setHours(node.hour, node.minute, node.second, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d;
  }
  if (node.scheduleType === 'cron') {
    try { return getNextCronOccurrence(node.cronExpr, baseDate); }
    catch { return new Date(now + 60000); }
  }
  return new Date(now + 60000);
}

function getSchedulesDir(): string {
  const dir = path.join(getServersDir(), '.schedules');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLog(serverName: string, log: ScheduleLog) {
  const logPath = path.join(getSchedulesDir(), `${serverName}_logs.json`);
  let logs: ScheduleLog[] = [];
  if (fs.existsSync(logPath)) {
    try { logs = JSON.parse(fs.readFileSync(logPath, 'utf-8')); }
    catch { logs = []; }
  }
  logs.unshift(log);
  if (logs.length > 200) logs = logs.slice(0, 200);
  fs.writeFileSync(logPath, JSON.stringify(logs, null, 2));
  broadcastToWebRtc({ action: 'schedule_logs', server: serverName, logs });
}
 
function saveSchedules(serverName: string, schedules: ScheduleNode[]) {
  const filePath = path.join(getSchedulesDir(), `${serverName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(schedules, null, 2));
  broadcastToWebRtc({ action: 'schedule_list', server: serverName, schedules });
}

async function runScheduleAction(
  serverName: string,
  schedule: ScheduleNode,
  logId: string,
  triggeredAt: Date,
) {
  const meta = getServerMeta(serverName);
  if (!meta) {
    writeLog(serverName, { id: logId, scheduleId: schedule.id, scheduleName: schedule.name, action: schedule.action, status: 'failed', message: `Server metadata not found for "${serverName}"`, triggeredAt: triggeredAt.toISOString(), completedAt: new Date().toISOString() });
    return;
  }
  try {
    switch (schedule.action) {
      case 'command': {
        if (!schedule.command) throw new Error('Command string is empty');
        const success = sendCommand(serverName, schedule.command);
        if (!success) throw new Error('Server console not accessible');
        writeLog(serverName, { id: logId, scheduleId: schedule.id, scheduleName: schedule.name, action: schedule.action, status: 'success', message: `Executed command: ${schedule.command}`, triggeredAt: triggeredAt.toISOString(), completedAt: new Date().toISOString() });
        break;
      }
      case 'start': {
        if (!isEulaAccepted(serverName)) throw new Error('Minecraft EULA not accepted — cannot start server via scheduler');
        await startServer(meta);
        writeLog(serverName, { id: logId, scheduleId: schedule.id, scheduleName: schedule.name, action: schedule.action, status: 'success', message: 'Server start requested', triggeredAt: triggeredAt.toISOString(), completedAt: new Date().toISOString() });
        break;
      }
      case 'stop': {
        stopServer(serverName);
        writeLog(serverName, { id: logId, scheduleId: schedule.id, scheduleName: schedule.name, action: schedule.action, status: 'success', message: 'Server stop requested', triggeredAt: triggeredAt.toISOString(), completedAt: new Date().toISOString() });
        break;
      }
      case 'restart': {
        restartServer(serverName);
        writeLog(serverName, { id: logId, scheduleId: schedule.id, scheduleName: schedule.name, action: schedule.action, status: 'success', message: 'Server restart requested', triggeredAt: triggeredAt.toISOString(), completedAt: new Date().toISOString() });
        break;
      }
      case 'backup': {
        const target = schedule.backupTarget || 'local';
        const stopBefore = schedule.stopBeforeBackup;
        const startAfter = schedule.startAfterBackup;
        let wasRunningBefore = isRunning(serverName);
        if (stopBefore && wasRunningBefore) {
          stopServer(serverName);
          for (let i = 0; i < 30; i++) {
            if (getServerStatus(serverName) === 'offline') break;
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
        let zipFilename = '';
        if (target === 'local') {
          const backupsDir = getLocalBackupsDir(serverName);
          zipFilename = `backup_scheduled_${Date.now()}.zip`;
          const destPath = path.join(backupsDir, zipFilename);
          await compressFolder(getServerDir(serverName), destPath);
          writeLog(serverName, { id: logId, scheduleId: schedule.id, scheduleName: schedule.name, action: schedule.action, status: 'success', message: `Created local backup: ${zipFilename}`, triggeredAt: triggeredAt.toISOString(), completedAt: new Date().toISOString() });
        } else {
          const { backupServerUrl, backupToken } = loadBackupConfig();
          if (!backupServerUrl || !backupToken) throw new Error('Cloud backup not configured on this host');
          zipFilename = `backup_cloud_scheduled_${Date.now()}.zip`;
          const tempPath = path.join(os.tmpdir(), zipFilename);
          await compressFolder(getServerDir(serverName), tempPath);
          const fileBuffer = fs.readFileSync(tempPath);
          const uploadRes = await fetch(`${backupServerUrl}/api/backup/upload`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${backupToken}`, 'x-node-id': '', 'x-server-id': serverName, 'x-filename': zipFilename, 'Content-Length': fileBuffer.length.toString() },
            body: fileBuffer,
          });
          fs.unlinkSync(tempPath);
          if (!uploadRes.ok) { const t = await uploadRes.text().catch(() => uploadRes.statusText); throw new Error(`Cloud upload failed: ${t}`); }
          writeLog(serverName, { id: logId, scheduleId: schedule.id, scheduleName: schedule.name, action: schedule.action, status: 'success', message: `Created cloud backup: ${zipFilename}`, triggeredAt: triggeredAt.toISOString(), completedAt: new Date().toISOString() });
        }
        if (startAfter && (wasRunningBefore || startAfter)) {
          if (!isEulaAccepted(serverName)) throw new Error('Minecraft EULA not accepted — cannot restart after backup via scheduler');
          await startServer(meta);
        }
        break;
      }
    }
  } catch (err: any) {
    writeLog(serverName, { id: logId, scheduleId: schedule.id, scheduleName: schedule.name, action: schedule.action, status: 'failed', message: `Action failed: ${err.message}`, details: err.stack, triggeredAt: triggeredAt.toISOString(), completedAt: new Date().toISOString() });
  }
}

export function startScheduler(): () => void {
  console.log('[void_server/scheduler] Background scheduler is active.');
  const intervalId = setInterval(async () => {
    const servers = listServers();
    for (const server of servers) {
      const filePath = path.join(getSchedulesDir(), `${server.name}.json`);
      if (!fs.existsSync(filePath)) continue;
      let schedules: ScheduleNode[] = [];
      try { schedules = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
      catch { continue; }
      let modified = false;
      for (const schedule of schedules) {
        if (!schedule.enabled) continue;
        const now = new Date();
        if (!schedule.nextRun) {
          schedule.nextRun = computeNextRunTime(schedule, now).toISOString();
          modified = true;
          continue;
        }
        const nextRunDate = new Date(schedule.nextRun);
        if (nextRunDate.getTime() <= now.getTime()) {
          const logId = Math.random().toString(36).substring(2, 10);
          const triggeredAt = now;
          schedule.lastRun = triggeredAt.toISOString();
          if (schedule.repeat) {
            schedule.nextRun = computeNextRunTime(schedule, now).toISOString();
          } else {
            schedule.enabled = false;
            schedule.nextRun = null;
          }
          modified = true;
          void runScheduleAction(server.name, schedule, logId, triggeredAt);
        }
      }
      if (modified) saveSchedules(server.name, schedules);
    }
  }, 5000);
  return () => {
    console.log('[void_server/scheduler] Stopping background scheduler.');
    clearInterval(intervalId);
  };
}
