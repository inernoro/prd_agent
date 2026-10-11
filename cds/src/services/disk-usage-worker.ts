import type { IShellExecutor } from '../types.js';
import type { DiskUsageReading } from './disk-guard.js';
import { ShellExecutor } from './shell-executor.js';
export const DISK_USAGE_TIMEOUT_MS = 3_000;
const fallback = new ShellExecutor({ maxConcurrent: 1, maxQueued: 32 });
const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const PROBE = `// disk-usage-worker
const fs = require('node:fs');
const paths = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(paths) || paths.length > 2) throw new Error('invalid disk targets');
process.stdout.write(JSON.stringify(paths.map(target => {
  try {
    const stat = fs.statfsSync(target);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize), freeBytes = Number(stat.bavail) * Number(stat.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(freeBytes) || freeBytes < 0 || freeBytes > totalBytes) return null;
    return { totalBytes, freeBytes };
  } catch { return null; }
})));`;

/** Isolated statfs; the bounded executor owns both queue and execution deadline. */
export async function readDiskUsage(
  targets: readonly string[], shell: IShellExecutor = fallback, signal?: AbortSignal,
): Promise<Array<DiskUsageReading | null>> {
  const paths = [...targets];
  if (paths.length > 2 || paths.some(p => typeof p !== 'string' || !p || p.length > 4096)) {
    throw new Error('invalid disk targets');
  }
  if (!paths.length) return [];
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  if (combined.aborted) return paths.map(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort!: () => void;
  const cancelled = new Promise<null>(resolve => {
    onAbort = () => resolve(null);
    combined.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => controller.abort(), DISK_USAGE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => shell.exec([process.execPath, '-e', PROBE].map(quote).join(' '), {
        timeout: DISK_USAGE_TIMEOUT_MS, signal: combined, stdin: JSON.stringify(paths),
        priority: 'diagnostic', schedulingGroup: 'disk-usage',
      })), cancelled,
    ]);
    if (!result || combined.aborted || result.exitCode !== 0 || result.stdout.length > 4096) return paths.map(() => null);
    const readings = JSON.parse(result.stdout);
    if (!Array.isArray(readings) || readings.length !== paths.length) return paths.map(() => null);
    return readings.map(value => value && Number.isFinite(value.totalBytes) && value.totalBytes > 0
      && Number.isFinite(value.freeBytes) && value.freeBytes >= 0 && value.freeBytes <= value.totalBytes
      ? { totalBytes: value.totalBytes, freeBytes: value.freeBytes } : null);
  } catch { return paths.map(() => null); }
  finally { clearTimeout(timer); combined.removeEventListener('abort', onAbort); }
}
