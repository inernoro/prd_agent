import fs from 'node:fs';
import os from 'node:os';

export interface WakeHostSample { availableMB: number; totalMB: number; loadRatio: number }

export function readWakeHostSample(): WakeHostSample {
  let availableMB = os.freemem() / 1024 / 1024;
  if (process.platform === 'linux') {
    // Linux's free memory excludes reclaimable cache; use MemAvailable.
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const value = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (!value) throw new Error('宿主可用内存读数缺失，暂缓自动唤醒');
    availableMB = Number(value[1]) / 1024;
  }
  return { availableMB, totalMB: os.totalmem() / 1024 / 1024, loadRatio: os.loadavg()[0] / Math.max(1, os.cpus().length) };
}

export function hasWakeHeadroom(sample: WakeHostSample): boolean {
  return Number.isFinite(sample.availableMB) && Number.isFinite(sample.totalMB)
    && Number.isFinite(sample.loadRatio) && sample.totalMB > 0 && sample.loadRatio >= 0
    && sample.availableMB >= Math.max(2048, sample.totalMB * 0.1) && sample.loadRatio < 1.2;
}

/** No waiting queue: contention leaves the preserved branch idle. A later real
 * navigation retries; no ghost waiter or background mass restart is created. */
export class AutoWakeAdmission {
  private holder: { branchId: string; startedAt: number } | null = null;
  constructor(private readonly sample: () => WakeHostSample = readWakeHostSample) {}

  snapshot() { return this.holder ? { ...this.holder } : null; }

  hasHeadroom(): boolean {
    try { return hasWakeHeadroom(this.sample()); } catch { return false; }
  }

  tryAcquire(branchId: string): (() => void) | null {
    if (this.holder || !this.hasHeadroom()) return null;
    const holder = { branchId, startedAt: Date.now() };
    this.holder = holder;
    return () => { if (this.holder === holder) this.holder = null; };
  }
}
