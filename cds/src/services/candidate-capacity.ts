import type { IShellExecutor } from '../types.js';
import type { StateService } from './state.js';

/** Existing planning unit (512MiB/container, 1GiB host reserve), applied to actual Daemon occupancy. */
export async function admitCandidateCapacity(state: StateService, shell: IShellExecutor,
  options: { assertCurrent(): void; signal?: AbortSignal }): Promise<{ occupied: number; max: number }> {
  const fence = () => { options.assertCurrent(); options.signal?.throwIfAborted(); };
  const command = async (text: string) => {
    fence(); const result = await shell.exec(text, { priority: 'delivery', timeout: 10_000, signal: options.signal }); fence();
    if (result.exitCode !== 0) throw new Error('candidate_capacity_unknown: Daemon snapshot failed');
    return result.stdout;
  };
  const resourceOutput = await command("docker info --format '{{json .}}'");
  let memory: number;
  try {
    const info = JSON.parse(resourceOutput);
    if (!Number.isSafeInteger(info.MemTotal) || info.MemTotal <= 0 || !Number.isSafeInteger(info.NCPU) || info.NCPU <= 0) {
      throw new Error('invalid resources');
    }
    memory = info.MemTotal;
  } catch (error) {
    fence();
    if (error instanceof Error && error.message.startsWith('candidate_capacity_unknown')) throw error;
    throw new Error('candidate_capacity_unknown: complete Daemon resources required');
  }
  const output = await command("docker ps --no-trunc --format '{{json .}}'");
  const names = new Set<string>(); const ids = new Set<string>();
  try {
    for (const line of output.trim() ? output.trim().split('\n') : []) {
      const row = JSON.parse(line);
      if (!/^[a-f0-9]{64}$/.test(row.ID || '') || typeof row.Names !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(row.Names) || ids.has(row.ID) || names.has(row.Names)) throw new Error('invalid container');
      ids.add(row.ID); names.add(row.Names);
    }
    // Status/error and absent Daemon create outcomes cannot erase a pending reservation.
    for (const run of state.getDeploymentRuns()) {
      if (!run.candidate || run.candidate.phase === 'released') continue;
      for (const service of [...Object.values(run.candidate.serving), ...Object.values(run.candidate.services)]) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(service.containerName)) throw new Error('invalid reservation');
        names.add(service.containerName);
      }
    }
  } catch { throw new Error('candidate_capacity_unknown: complete actual identities and reservations required'); }
  fence();
  const max = Math.max(0, Math.floor((memory - 1024 ** 3) / (512 * 1024 ** 2)));
  if (names.size > max) throw new Error(`candidate_capacity_exhausted: ${names.size}/${max} runtime and reserved containers`);
  return { occupied: names.size, max };
}
