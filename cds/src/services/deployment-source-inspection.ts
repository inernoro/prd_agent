import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readWorktreeDirectoryIdentity, sameWorktreeDirectoryIdentity,
  WorktreeClaimHeldError, type WorktreeDirectoryIdentity } from './worktree-path-activity.js';

export const SOURCE_HOLD_REASONS = ['persistent-data', 'modified-or-unknown-files', 'git-query-failed',
  'identity-changed', 'size-query-failed'] as const;
export type SourceHoldReason = typeof SOURCE_HOLD_REASONS[number];
export class SourceInspectionHeldError extends WorktreeClaimHeldError {
  constructor(readonly reason: SourceHoldReason) { super('部署源码受保护，未执行回收。'); }
}
export function sourceHoldReason(value: unknown): SourceHoldReason | undefined {
  return SOURCE_HOLD_REASONS.find(reason => reason === value);
}

/** Read-only proof shared by preview and the existing owned removal worker. */
export async function inspectDeploymentSource(dir: string, identity: WorktreeDirectoryIdentity,
  estimateSize = false, signal?: AbortSignal): Promise<{ reason?: SourceHoldReason; allocatedBytes?: number; common?: string }> {
  for (const name of ['.cds-data', '.cds-run-data']) {
    try { await fs.lstat(path.join(dir, name)); return { reason: 'persistent-data' }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { reason: 'git-query-failed' }; }
  }
  try {
    const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', dir, ...args],
      { timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
        signal,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
    if (await fs.realpath((await git('rev-parse', '--show-toplevel')).trim()) !== identity.entryPath)
      return { reason: 'identity-changed' };
    if ((await git('status', '--porcelain', '--untracked-files=normal', '--ignored=matching')).trim())
      return { reason: 'modified-or-unknown-files' };
    const common = await fs.realpath(path.resolve(dir, (await git('rev-parse', '--git-common-dir')).trim()));
    let allocatedBytes: number | undefined;
    if (estimateSize) {
      const tracked = (await git('ls-files', '-z')).split('\0').filter(Boolean);
      if (tracked.length > 100_000) return { reason: 'size-query-failed' };
      const seen = new Set<string>(); allocatedBytes = 0;
      try {
        for (const file of tracked) {
          if (signal?.aborted) return { reason: 'size-query-failed' };
          if (path.isAbsolute(file) || file.split('/').includes('..')) return { reason: 'size-query-failed' };
          // lstat never follows tracked links. Git-clean trees cannot contain unknown payloads.
          const stat = await fs.lstat(path.join(dir, file));
          const key = `${stat.dev}:${stat.ino}`;
          if (!seen.has(key)) { seen.add(key); allocatedBytes += stat.blocks * 512; }
        }
      } catch { return { reason: 'size-query-failed' }; }
    }
    const current = await readWorktreeDirectoryIdentity(dir);
    if (!current || !sameWorktreeDirectoryIdentity(identity, current)) return { reason: 'identity-changed' };
    return { common, ...(allocatedBytes === undefined ? {} : { allocatedBytes }) };
  } catch { return { reason: 'git-query-failed' }; }
}
