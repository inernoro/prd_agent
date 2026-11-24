import type { IShellExecutor } from '../types.js';
import { createReleaseGitRunner } from './release-git-reader.js';

/** 只读项目仓库的唯一commit身份；不fetch、不checkout、不借用缓存CI目标或HEAD。 */
export async function resolveArtifactCommitIdentity(
  shell: IShellExecutor, repoRoot: string, requested: string, assertCurrent: () => void,
): Promise<string> {
  assertCurrent();
  if (!/^[0-9a-f]{7,40}$/i.test(requested)) throw new Error('目标提交格式无效');
  const short = requested.toLowerCase();
  if (short.length === 40) return short;
  const read = createReleaseGitRunner(shell, assertCurrent);
  const full = (await read(['-C', repoRoot, 'rev-parse', '--verify', `${short}^{commit}`])).trim().toLowerCase();
  assertCurrent();
  if (!/^[0-9a-f]{40}$/.test(full) || !full.startsWith(short)) throw new Error('无法确认短提交对应的唯一完整身份');
  return full;
}
