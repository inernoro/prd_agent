import type { ResourceLimits } from '../types.js';

export function dockerRuntimeResourceFlags(resources?: ResourceLimits): string[] {
  if (resources?.enforceRuntime == null || resources.enforceRuntime === false) return [];
  if (resources.enforceRuntime !== true) throw new Error('resources.enforceRuntime 必须为布尔值');

  const { cpus, memoryMB } = resources;
  if (typeof cpus !== 'number' || !Number.isFinite(cpus) || cpus < 0.01 || cpus * 1e9 > Number.MAX_SAFE_INTEGER
    || typeof memoryMB !== 'number' || !Number.isSafeInteger(memoryMB) || memoryMB < 6
    || !Number.isSafeInteger(memoryMB * 1024 * 1024)) {
    throw new Error('运行时限额需要有限的 CPU 核数（至少 0.01 核）和整数内存（至少 6 MiB）');
  }

  return [`--cpus ${cpus}`, `--memory ${memoryMB}m`, `--memory-swap ${memoryMB}m`];
}
