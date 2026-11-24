import os from 'node:os';
import { buildLoadPressure } from './build-gate.js';
import { deploymentHostAvailableMemoryMB, deploymentHostMemoryBudgetMB } from './deployment-phase-budget.js';
import { diskGuard, DISK_READING_TTL_MS } from './disk-guard.js';

export function classifySchedulerPressure(input: { loadRatio: number; saturated: boolean; availableMB: number;
  totalMB: number; diskPercent: number | null; diskFreeBytes: number | null; diskAt: string | null }, now = Date.now()): 'ample' | 'pressure' | 'unknown' {
  const { loadRatio, saturated, availableMB, totalMB, diskPercent, diskFreeBytes, diskAt } = input;
  if (![loadRatio, availableMB, totalMB].every(Number.isFinite) || totalMB <= 0 || availableMB < 0
    || loadRatio < 0 || diskPercent == null || !Number.isFinite(diskPercent) || diskFreeBytes == null || !Number.isFinite(diskFreeBytes) || !diskAt
    || !Number.isFinite(Date.parse(diskAt)) || now - Date.parse(diskAt) > DISK_READING_TTL_MS || now < Date.parse(diskAt)) return 'unknown';
  return !saturated && loadRatio < 0.7 && availableMB >= Math.max(2048, totalMB * 0.25) && diskPercent < 75 && diskFreeBytes >= 8 * 1024 ** 3 ? 'ample' : 'pressure';
}

export async function schedulerResourcePressure(): Promise<'ample' | 'pressure' | 'unknown'> {
  diskGuard.blockReasonForDeploy(); // Refresh the existing bounded multi-mount probe when stale.
  const load = buildLoadPressure(), disk = diskGuard.get();
  return classifySchedulerPressure({ loadRatio: load.ratio, saturated: load.saturated,
    availableMB: await deploymentHostAvailableMemoryMB(), totalMB: deploymentHostMemoryBudgetMB() ?? os.totalmem() / 1048576,
    diskPercent: disk.usedPercent, diskFreeBytes: diskGuard.minimumAvailableBytes(), diskAt: disk.updatedAt });
}
