import { createReleaseGitRunner, type ReleaseGitRunner } from './release-git-reader.js';
import type { IShellExecutor } from '../types.js';

export interface ReleaseComparison {
  mainSha: string;
  productionSha: string;
  baseSha?: string;
  comparedAt: string;
  productionFileCount?: number;
  mainFileCount?: number;
  overlapCount?: number;
  files: Array<{ path: string; side: 'production' | 'main' | 'both' }>;
  truncated?: boolean;
  reason?: string;
  /** 文件重叠不能冒充实际预合并冲突。 */
  conflictStatus: 'not-checked';
}
const SHA = /^[a-f0-9]{40}$/i;
export class ReleaseComparisonReader {
  private cache = new Map<string, { at: number; result: ReleaseComparison }>();
  private run: ReleaseGitRunner;
  constructor(private root: (projectId: string) => string | undefined, shell?: IShellExecutor, runner?: ReleaseGitRunner) {
    this.run = runner || createReleaseGitRunner(shell);
  }
  async read(projectId: string, mainSha: string, productionSha: string): Promise<ReleaseComparison> {
    const key = JSON.stringify([projectId, mainSha, productionSha]);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.result;
    const result: ReleaseComparison = { mainSha, productionSha, comparedAt: new Date().toISOString(), files: [], conflictStatus: 'not-checked' };
    const root = this.root(projectId);
    if (!root || !SHA.test(mainSha) || !SHA.test(productionSha)) return { ...result, reason: '缺少完整版本或本地仓库，无法比较' };
    try {
      const base = (await this.run(['-C', root, 'merge-base', mainSha, productionSha])).trim();
      if (!SHA.test(base)) throw new Error('missing base');
      const production = paths(await this.run(['-C', root, 'diff', '--name-only', '-z', '--no-renames', base, productionSha, '--']));
      const main = paths(await this.run(['-C', root, 'diff', '--name-only', '-z', '--no-renames', base, mainSha, '--']));
      const union = new Set([...production, ...main]);
      result.baseSha = base;
      result.productionFileCount = production.size;
      result.mainFileCount = main.size;
      result.overlapCount = [...production].filter(p => main.has(p)).length;
      result.truncated = union.size > 200;
      const priority = (path: string): number => production.has(path) ? main.has(path) ? 0 : 1 : 2;
      result.files = [...union].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b)).slice(0, 200)
        .map(path => ({ path, side: production.has(path) ? main.has(path) ? 'both' : 'production' : 'main' }));
    } catch {
      result.reason = '本地 Git 比较未完成，请刷新仓库后重试；未判定为无差异';
    }
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {at: Date.now(), result});
    return result;
  }
}
function paths(output: string): Set<string> {
  if (output && !output.endsWith('\0')) throw new Error('incomplete paths');
  return new Set(output.split('\0').filter(Boolean));
}
