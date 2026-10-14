import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWorktreeDirectoryIdentity, sameWorktreeDirectoryIdentity,
  type WorktreeDirectoryIdentity } from './worktree-path-activity.js';

export interface OwnedDirectoryRemoval {
  dir: string; allowedBase: string; identity: WorktreeDirectoryIdentity; entryOnly: boolean;
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
