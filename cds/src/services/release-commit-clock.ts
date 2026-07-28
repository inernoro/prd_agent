/**
 * release-commit-clock — 发布所用 commit 的提交时间台账。
 *
 * 存在的唯一理由：DORA 的「变更前置时间」= 生产可用时刻 − commit 提交时刻，
 * 而这个仓库里**没有任何地方存过 commit 时间**。BranchEntry 只有 lastPushAt
 * （推送时间不是提交时间，一次 push 可以带上一周前的 commit，拿它顶替算出来的
 * 数只会比真实前置时间小一大截），DeploymentVersion 也只有 commitSha + createdAt。
 *
 * 所以只能在发布发起那一刻去 git 里问一次并记下来：
 *   - 写在发起时而不是读取时：读发布中心是纯读动作，不该按 run 数放大成一串
 *     git 进程（同 release-health-snapshot.ts 顶部「打开发布中心不打生产」的取舍）；
 *   - 取不到就不记，指标那边如实按覆盖率打折，绝不猜、绝不拿别的时间戳顶替
 *     （no-rootless-tree：宁可少一个样本，也不给一个看着精确的假前置时间）。
 *
 * 存量 run 没有记录，所以功能刚上线时覆盖率会很低——这是事实，由
 * leadTime.sampleCount / eligibleCount 如实暴露，不做任何回填式猜测。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 注入点：单测用假 reader，生产用 gitCommitTimeReader。 */
export type CommitTimeReader = (worktreePath: string, commitSha: string) => string | undefined;

/** 台账上限。按 targetId 无关的 projectId::sha 分键，超出从最早的开始丢。 */
export const MAX_COMMIT_TIME_ENTRIES = 500;

export function releaseCommitKey(projectId: string, commitSha: string): string {
  return `${projectId}::${commitSha}`;
}

/**
 * commit sha 白名单校验。
 *
 * 不是洁癖：sha 最终会拼进 git 的 argv，一个以 `-` 开头的值会被 git 当成选项
 * （`--upload-pack=...` 这类可以直接跑命令）。execFile 不过 shell 能挡住管道，
 * 挡不住「参数被当成选项」这一层，所以必须在这里就把形状卡死。
 */
export function isCommitShaLike(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

/**
 * 真实 git 读取器。`%cI` 是 committer date 的严格 ISO-8601 形式。
 * 任何失败（worktree 已被回收 / sha 不在本地 / git 不在）都返回 undefined，
 * 让上层退化成「这次没有前置时间样本」，绝不抛给发布主链路。
 */
export const gitCommitTimeReader: CommitTimeReader = (worktreePath, commitSha) => {
  if (!worktreePath || !isCommitShaLike(commitSha)) return undefined;
  try {
    const out = execFileSync('git', ['-C', worktreePath, 'show', '-s', '--format=%cI', commitSha], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const iso = out.trim().split('\n')[0]?.trim();
    if (!iso || !Number.isFinite(Date.parse(iso))) return undefined;
    return new Date(iso).toISOString();
  } catch {
    return undefined;
  }
};

interface CommitClockFile {
  version: 1;
  savedAt: string;
  entries: Array<[string, string]>;
}

export class ReleaseCommitClock {
  private entries = new Map<string, string>();
  private loaded = false;

  constructor(
    private readonly options: {
      storePath?: string;
      maxEntries?: number;
      reader?: CommitTimeReader;
      logger?: { warn?: (m: string) => void };
    } = {},
  ) {}

  private get maxEntries(): number {
    return this.options.maxEntries ?? MAX_COMMIT_TIME_ENTRIES;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const fp = this.options.storePath;
    if (!fp) return;
    try {
      if (!fs.existsSync(fp)) return;
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as CommitClockFile;
      if (!parsed || !Array.isArray(parsed.entries)) return;
      for (const pair of parsed.entries.slice(-this.maxEntries)) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') continue;
        this.entries.set(pair[0], pair[1]);
      }
    } catch (err) {
      this.options.logger?.warn?.(`[release-commit-clock] 读取失败，从空台账开始: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    const fp = this.options.storePath;
    if (!fp) return;
    const payload: CommitClockFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      entries: [...this.entries.entries()],
    };
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const tmp = `${fp}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload));
      fs.renameSync(tmp, fp);
    } catch (err) {
      this.options.logger?.warn?.(`[release-commit-clock] 落盘失败（仅内存保留）: ${(err as Error).message}`);
    }
  }

  get(projectId: string, commitSha: string): string | undefined {
    if (!projectId || !commitSha) return undefined;
    this.ensureLoaded();
    return this.entries.get(releaseCommitKey(projectId, commitSha));
  }

  /**
   * 记一次 commit 时间。已记过的直接返回缓存值，不重复起 git 进程。
   * 整个方法对调用方是「尽力而为」：任何异常都吞掉并返回 undefined。
   */
  remember(projectId: string, commitSha: string, worktreePath: string | undefined): string | undefined {
    if (!projectId || !commitSha || !worktreePath) return undefined;
    this.ensureLoaded();
    const key = releaseCommitKey(projectId, commitSha);
    const cached = this.entries.get(key);
    if (cached) return cached;
    let iso: string | undefined;
    try {
      iso = (this.options.reader ?? gitCommitTimeReader)(worktreePath, commitSha);
    } catch {
      return undefined;
    }
    if (!iso) return undefined;
    this.entries.set(key, iso);
    // Map 保插入序，删最早插入的即是最旧的记录。
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.persist();
    return iso;
  }
}
