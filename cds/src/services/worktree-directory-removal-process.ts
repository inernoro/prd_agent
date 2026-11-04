import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readWorktreeDirectoryIdentity, sameWorktreeDirectoryIdentity,
  type WorktreeDirectoryIdentity } from './worktree-path-activity.js';

export interface OwnedDirectoryRemoval {
  dir: string; allowedBase: string; identity: WorktreeDirectoryIdentity; entryOnly: boolean;
  sourceOnly?: boolean;
}

/** 只运行在归属操作进程；没有State、Docker或回退到Master的删除路径。 */
export async function removeOwnedDirectory(input: OwnedDirectoryRemoval): Promise<'removed' | 'held'> {
  if (!input || typeof input.dir !== 'string' || typeof input.allowedBase !== 'string'
    || !path.isAbsolute(input.dir) || !path.isAbsolute(input.allowedBase)
    || !input.identity?.entry || typeof input.entryOnly !== 'boolean') return 'held';
  const base = await fs.promises.realpath(input.allowedBase).catch(() => null);
  const identity = await readWorktreeDirectoryIdentity(input.dir, !input.entryOnly);
  if (!base || !identity || identity.entryPath !== input.identity.entryPath
    || !identity.entryPath.startsWith(`${base}${path.sep}`)
    || !sameWorktreeDirectoryIdentity(input.identity, identity, input.entryOnly)) return 'held';
  if (input.sourceOnly) {
    const relative = path.relative(path.resolve(input.allowedBase), path.resolve(input.dir));
    const segments = relative.split(path.sep);
    if (segments.length !== 4 || segments[0] === '..' || segments[1] !== '.deployment-sources'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segments[3])
      || identity.entryPath !== path.join(base, relative)) return 'held';
    // Mount absence is insufficient: offline MySQL/object-store data must survive too.
    for (const name of ['.cds-data', '.cds-run-data']) {
      try { await fs.promises.lstat(path.join(input.dir, name)); return 'held'; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'held'; }
    }
    try {
      const git = async (...args: string[]) => (await promisify(execFile)('git', ['-C', input.dir, ...args],
        { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim();
      if (await fs.promises.realpath(await git('rev-parse', '--show-toplevel')) !== identity.entryPath) return 'held';
      // Includes ignored content: unknown caches or data are held, never force-cleaned.
      if (await git('status', '--porcelain', '--untracked-files=normal', '--ignored=matching')) return 'held';
      const common = await fs.promises.realpath(path.resolve(input.dir, await git('rev-parse', '--git-common-dir')));
      const finalIdentity = await readWorktreeDirectoryIdentity(input.dir);
      if (!finalIdentity || !sameWorktreeDirectoryIdentity(identity, finalIdentity)) return 'held';
      await promisify(execFile)('git', ['--git-dir', common, 'worktree', 'remove', input.dir],
        { timeout: 30_000, maxBuffer: 64 * 1024 });
      return 'removed'; // Git unregisters metadata as well; no --force or recursive rm fallback.
    } catch { return 'held'; }
  }
  fs.rmSync(input.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return 'removed';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > 16 * 1024) throw new Error('Directory removal input budget exceeded');
      chunks.push(buffer);
    }
    const status = await removeOwnedDirectory(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    process.stdout.write(JSON.stringify({ status }));
  } catch { process.stderr.write('Owned directory removal failed'); process.exitCode = 1; }
}
