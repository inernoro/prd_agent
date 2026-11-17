import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IShellExecutor } from '../types.js';
import type { ReleaseConflictCheck } from '../domain/release-governance.js';
import { shellQuoteArg } from './secure-database-cli.js';
import type { StateService } from './state.js';

export function resolveReleaseProjectRepository(state: Pick<StateService, 'getProject' | 'getProjectRepoRoot'>, projectId: string, fallbackRoot: string): string | undefined {
  const project = state.getProject(projectId);
  if (!project || (project.gitRepoUrl && !project.repoPath)) return undefined;
  return state.getProjectRepoRoot(projectId, fallbackRoot);
}

export const FULL_SHA = /^[a-f0-9]{40}$/i;
export interface GovernanceGitResult { stdout: string; exitCode: number | null }
export type GovernanceGitRunner = (args: string[], cwd: string, isolated?: boolean) => Promise<GovernanceGitResult>;

/** Bounded, non-urgent execution. Merge output is written only into a disposable bare repository. */
export function governanceGitRunner(shell?: IShellExecutor): GovernanceGitRunner {
  return async (args, cwd, isolated = false) => {
    if (!shell?.execBackgroundObservation) throw new Error('Git 核验执行器不可用');
    let stdout = '', bytes = 0;
    const prefix = 'GIT_TERMINAL_PROMPT=0 GIT_NO_LAZY_FETCH=1 ' + (isolated ? 'GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null ' : '');
    const result = await shell.execBackgroundObservation(prefix + ['git', ...args].map(shellQuoteArg).join(' '), {
      cwd, timeout: 30_000, captureOutput: false,
      onData: (chunk, channel) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) throw new Error('Git 核验结果超过容量限制');
        if (channel !== 'stderr') stdout += chunk;
      },
    });
    return { stdout, exitCode: result.exitCode };
  };
}

export class ReleaseGovernanceGit {
  private active = 0;
  constructor(private readonly root: (projectId: string) => string | undefined,
    private readonly defaultBranch: (projectId: string) => string,
    private readonly run: GovernanceGitRunner) {}

  async resolveCommit(projectId: string, revision: string): Promise<string> {
    const root = this.root(projectId);
    if (!root || !/^[a-f0-9]{7,40}$/i.test(revision)) throw new Error('固定版本不是有效提交，请重新固定分支版本');
    const result = await this.run(['-C', root, 'rev-parse', '--verify', `${revision}^{commit}`], root);
    const sha = result.stdout.trim().toLowerCase();
    if (result.exitCode !== 0 || !FULL_SHA.test(sha)) throw new Error('固定版本无法唯一核实，请同步分支后重新固定版本');
    return sha;
  }

  async includes(projectId: string, ancestor: string, descendant: string): Promise<boolean> {
    const root = this.root(projectId);
    if (!root || !FULL_SHA.test(ancestor) || !FULL_SHA.test(descendant)) throw new Error('缺少完整 Git 版本');
    const result = await this.run(['-C', root, 'merge-base', '--is-ancestor', ancestor, descendant], root);
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error('Git 包含关系未核实');
    return result.exitCode === 0;
  }

  async includesPr(projectId: string, sourceSha: string, number: number, headSha: string): Promise<boolean> {
    const root = this.root(projectId);
    if (!root || !Number.isSafeInteger(number) || number < 1 || !FULL_SHA.test(sourceSha) || !FULL_SHA.test(headSha)) throw new Error('PR 版本依据不完整');
    const reference = `refs/cds/release-pr/${number}`;
    const fetched = await this.run(['-C',root,'fetch','--no-tags','origin',`+refs/pull/${number}/head:${reference}`],root);
    const observed = await this.run(['-C',root,'rev-parse','--verify',`${reference}^{commit}`],root);
    if (fetched.exitCode !== 0 || observed.exitCode !== 0 || observed.stdout.trim() !== headSha) throw new Error('PR 已变化或源码未取齐，请刷新后重试');
    return this.includes(projectId,sourceSha,headSha);
  }

  async inspect(projectId: string, candidateSha: string, basisSha?: string): Promise<ReleaseConflictCheck> {
    const result: ReleaseConflictCheck = { projectId, candidateSha, mainSha: '', checkedAt: new Date().toISOString(),
      status: 'unknown', conflicts: [], changedPaths: [], includesBaseline: false };
    let temporary: string | undefined;
    if (this.active >= 2) return { ...result, reason: 'Git 核验正在处理其他请求，请稍后重试' };
    this.active++;
    try {
      const root = this.root(projectId), branch = this.defaultBranch(projectId);
      if (!root || !FULL_SHA.test(candidateSha) || basisSha && !FULL_SHA.test(basisSha)
        || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(branch) || branch.includes('..') || branch.endsWith('/')) throw new Error();
      const checked = async (args: string[], cwd = root, isolated = false) => {
        const value = await this.run(args, cwd, isolated);
        if (value.exitCode !== 0) throw new Error();
        return value.stdout;
      };
      // Explicit user/preflight operation, never a side effect of reading the release center.
      await checked(['-C', root, 'fetch', '--no-tags', 'origin', `+${branch}:refs/remotes/origin/${branch}`]);
      result.mainSha = (await checked(['-C', root, 'rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`])).trim();
      if (!FULL_SHA.test(result.mainSha)) throw new Error();
      await checked(['-C', root, 'cat-file', '-e', `${candidateSha}^{commit}`]);
      const basis = basisSha || result.mainSha;
      result.includesBaseline = await this.includes(projectId, basis, candidateSha);
      const net = await checked(['-C', root, 'diff', '--name-only', '-z', '--no-renames', basis, candidateSha, '--']);
      const common = (await checked(['-C', root, 'rev-parse', '--git-common-dir'])).trim();
      const objects = await fs.realpath(path.resolve(root, common, 'objects'));
      temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-release-merge-'));
      await checked(['init', '--bare', '--quiet', temporary], temporary, true);
      await fs.writeFile(path.join(temporary, 'objects/info/alternates'), objects + '\n');
      // 普通提交仍累计已撤回的修改；双父合并只计手工解决的差异，避免把已在线上的基线重复算作调试修改。
      // remerge 会生成临时对象，必须与冲突核验共用隔离仓库，不能写原对象库或使用项目合并驱动配置。
      const range = `${basis}..${candidateSha}`;
      const history = await checked(['-C', temporary, 'log', '--format=', '--name-only', '-z', '--no-renames',
        '--diff-merges=remerge', range, '--'], temporary, true);
      // Git 仅能重算双父合并；多父合并沿用原先逐父累计的保守检查，不能静默漏过其历史修改。
      const octopus = await checked(['-C', temporary, 'log', '--format=', '--name-only', '-z', '--no-renames',
        '--min-parents=3', '--diff-merges=separate', range, '--'], temporary, true);
      if ([net, history, octopus].some(value => value && !value.endsWith('\0'))) throw new Error();
      result.changedPaths = [...new Set([net, history, octopus].flatMap(value => value.split('\0')).filter(Boolean))].sort();
      if (result.changedPaths.length > 10_000) throw new Error();
      const merged = await this.run(['-C', temporary, '-c', 'core.hooksPath=/dev/null', 'merge-tree', '--write-tree',
        '--name-only', '--no-messages', '-z', result.mainSha, candidateSha], temporary, true);
      if (merged.exitCode !== 0 && merged.exitCode !== 1 || !merged.stdout.endsWith('\0')) throw new Error();
      const [tree, ...files] = merged.stdout.split('\0');
      if (!FULL_SHA.test(tree)) throw new Error();
      result.conflicts = [...new Set(files.filter(Boolean))];
      if (merged.exitCode === 1 && !result.conflicts.length) throw new Error();
      result.status = merged.exitCode === 0 ? 'clean' : 'conflicts';
    } catch {
      result.status = 'unknown'; result.reason = '主干更新或隔离合并未完成，请刷新核验后重试；未判定为无冲突';
    } finally {
      try { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); }
      finally { this.active--; }
    }
    return result;
  }
}
