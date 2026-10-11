/**
 * release-commit-clock — 发布所用 commit 的元信息台账（提交时间 + 说明 + 作者）。
 *
 * 时间是它诞生的理由，说明与作者是**顺带**的：同一次 `git show` 把 format 从
 * `%cI` 扩成 `%cI %s %an` 不多起一个进程，代价为零，却让发布时间线能显示
 * 「这次发的是哪个改动」而不是一串 sha。取不到就不给，前端退化成只显示 short sha。
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

import { commitClockFileIO, type CommitClockFileIO } from './release-commit-file.js';
import type { IShellExecutor } from '../types.js';
import { RELEASE_GIT_TIMEOUT_MS, shellGitRunner, workerGitRunner, type GitRunner } from './release-git-reader.js';

/**
 * 一条 commit 的元信息。`at` 是台账存在的原始理由（DORA 变更前置时间），
 * subject / author 是同一次 `git show` 顺手带回来的——扩 format 不多起一个进程，
 * 代价为零，却让发布时间线能显示「这次发的是哪个改动」而不是一串 sha。
 */
export interface ReleaseCommitMetaRead {
  at: string;
  subject?: string;
  author?: string;
}

/**
 * 注入点：单测用假 reader，生产用 gitCommitMetaReader。
 *
 * 刻意同时接受「裸 ISO 字符串」与「元信息对象」两种返回：v1 时代的 reader
 * （含既有单测里的假 reader）只给时间，升级后它们的语义仍然成立——
 * 只是没有 subject。宽进而不是逼所有调用方一起改，是为了让「只有时间」
 * 这个退化态天然合法，而不是被当成错误吞掉。
 */
export type CommitTimeReader = (
  worktreePath: string,
  commitSha: string,
  signal?: AbortSignal,
) => string | ReleaseCommitMetaRead | undefined | Promise<string | ReleaseCommitMetaRead | undefined>;

/** 台账上限。按 targetId 无关的 projectId::sha 分键，超出从最早的开始丢。 */
export const MAX_COMMIT_TIME_ENTRIES = 500;

/**
 * commit 说明的截断长度。取 `%s`（首行）已经排除了正文，但首行本身也可能是
 * 一句几百字的流水账；台账要落盘、要随 center 响应下发，必须有上界。
 */
export const MAX_COMMIT_SUBJECT_LENGTH = 200;

/** 单元分隔符。用 \x1f 而不是空格/竖线：commit subject 里什么字符都可能有。 */
const UNIT_SEPARATOR = '\x1f';

function truncateSubject(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_COMMIT_SUBJECT_LENGTH ? trimmed.slice(0, MAX_COMMIT_SUBJECT_LENGTH) : trimmed;
}

/** reader 的两种返回形状归一到一处，避免 remember / 加载器各判一遍。 */
function normalizeMetaRead(raw: string | ReleaseCommitMetaRead | undefined): ReleaseCommitMetaRead | undefined {
  if (!raw) return undefined;
  const at = typeof raw === 'string' ? raw : raw.at;
  if (!at || !Number.isFinite(Date.parse(at))) return undefined;
  const iso = new Date(at).toISOString();
  if (typeof raw === 'string') return { at: iso };
  const subject = typeof raw.subject === 'string' && raw.subject.trim() ? truncateSubject(raw.subject) : undefined;
  const author = typeof raw.author === 'string' && raw.author.trim() ? raw.author.trim() : undefined;
  return {
    at: iso,
    ...(subject ? { subject } : {}),
    ...(author ? { author } : {}),
  };
}

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
 * 真实 git 读取器。`%cI` 是 committer date 的严格 ISO-8601 形式；
 * `%s` 是 commit 说明首行，`%an` 是作者名——同一次 `git show` 一起带回来，
 * 不多起一个进程。
 *
 * 任何失败（worktree 已被回收 / sha 不在本地 / git 不在）都返回 undefined，
 * 让上层退化成「这次没有前置时间样本」，绝不抛给发布主链路。
 */
function commitMetaReader(runner: GitRunner): CommitTimeReader {
  return async (worktreePath, commitSha, signal = AbortSignal.timeout(RELEASE_GIT_TIMEOUT_MS)) => {
    if (!worktreePath || !isCommitShaLike(commitSha) || signal.aborted) return undefined;
    try {
      const out = await runner(['-C', worktreePath, 'show', '-s',
        `--format=%cI${UNIT_SEPARATOR}%s${UNIT_SEPARATOR}%an`, commitSha], signal);
      if (signal.aborted) return undefined;
      const [at, subject, author] = (out.split('\n')[0] ?? '').split(UNIT_SEPARATOR);
      return normalizeMetaRead({ at: (at || '').trim(), subject, author });
    } catch { return undefined; }
  };
}
export const gitCommitMetaReader: CommitTimeReader = commitMetaReader(workerGitRunner);
export const shellCommitMetaReader = (shell: IShellExecutor): CommitTimeReader =>
  commitMetaReader(shellGitRunner(shell, 'release-meta'));

/** Deadline also applies to injected readers that do not honour the signal. */
function readMeta(reader: CommitTimeReader, root: string, sha: string, signal: AbortSignal): Promise<ReleaseCommitMetaRead | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise(resolve => {
    let settled = false;
    const finish = (raw?: string | ReleaseCommitMetaRead) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', onAbort);
      try { resolve(signal.aborted ? undefined : normalizeMetaRead(raw)); }
      catch { resolve(undefined); }
    };
    const onAbort = () => finish();
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => signal.aborted ? undefined : reader(root, sha, signal)).then(finish, () => finish());
  });
}

/**
 * 落盘格式。v1 的条目是裸 ISO 字符串，v2 升级成元信息对象。
 *
 * 加载器必须同时认这两种形状：线上那份台账里已经攒了一批 v1 条目，
 * 它们是 DORA 变更前置时间**仅有**的样本源。不兼容 = 升级当天样本清零，
 * 而指标只会显示「样本不足」—— 静默退化，没有任何东西会变红。
 */
interface CommitClockFile {
  version: 1 | 2;
  savedAt: string;
  entries: Array<[string, string | ReleaseCommitMetaRead]>;
}

export class ReleaseCommitClock {
  private entries = new Map<string, ReleaseCommitMetaRead>();
  private loaded = false;
  private loading?: Promise<void>;
  private canPersist = false;
  private readonly fileIO?: CommitClockFileIO;
  private writing = false;
  private nextWrite?: { serialized: string; done: Array<() => void> };
  private pending = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly options: {
      storePath?: string;
      maxEntries?: number;
      reader?: CommitTimeReader;
      fileIO?: CommitClockFileIO;
      timeoutMs?: number;
      logger?: { warn?: (m: string) => void };
    } = {},
  ) {
    this.options = { ...options };
    this.fileIO = options.fileIO ?? (options.storePath ? commitClockFileIO(options.storePath, this.maxEntries) : undefined);
    this.loaded = !this.fileIO;
  }

  private get maxEntries(): number {
    return this.options.maxEntries ?? MAX_COMMIT_TIME_ENTRIES;
  }

  /** Call once before synchronous cache reads; concurrent callers share the same load. */
  ready(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => { this.loaded = true; });
    return this.loading;
  }

  private warn(message: string): void {
    try { this.options.logger?.warn?.(message); } catch { /* Statistics never block delivery. */ }
  }

  private async load(): Promise<void> {
    try {
      const parsed = await this.fileIO!.load() as CommitClockFile | null;
      if (parsed !== null && (!parsed || !Array.isArray(parsed.entries))) throw new Error('invalid commit clock file');
      for (const pair of (parsed?.entries ?? []).slice(-this.maxEntries)) {
        if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
        const meta = normalizeMetaRead(pair[1] as string | ReleaseCommitMetaRead | undefined);
        if (meta) this.entries.set(pair[0], meta);
      }
      this.canPersist = true;
    } catch {
      this.warn('[release-commit-clock] 读取失败，仅内存保留，原文件不覆盖');
    }
  }

  private persist(): Promise<void> {
    if (!this.fileIO || !this.canPersist) return Promise.resolve();
    const payload: CommitClockFile = { version: 2, savedAt: new Date().toISOString(), entries: [...this.entries.entries()] };
    const serialized = JSON.stringify(payload);
    return new Promise(resolve => {
      if (this.nextWrite) { this.nextWrite.serialized = serialized; this.nextWrite.done.push(resolve); }
      else this.nextWrite = { serialized, done: [resolve] };
      this.drainWrites();
    });
  }

  private drainWrites(): void {
    if (this.writing || !this.nextWrite) return;
    this.writing = true;
    void (async () => {
      try {
        while (this.nextWrite) {
          const snapshot = this.nextWrite; this.nextWrite = undefined;
          try { await this.fileIO!.save(snapshot.serialized); }
          catch { this.warn('[release-commit-clock] 落盘失败，仅内存保留'); }
          finally { for (const done of snapshot.done) done(); }
        }
      } finally { this.writing = false; }
    })();
  }

  /** 只要提交时刻（DORA 的原始用途）。形状保持 v1 的 ISO 字符串，调用方不用改。 */
  get(projectId: string, commitSha: string): string | undefined {
    return this.getMeta(projectId, commitSha)?.at;
  }

  /** Cache-only: call ready() before cold reads; missing metadata remains undefined. */
  getMeta(projectId: string, commitSha: string): ReleaseCommitMetaRead | undefined {
    if (!projectId || !commitSha) return undefined;
    return this.entries.get(releaseCommitKey(projectId, commitSha));
  }

  /**
   * 记一次 commit 元信息。已记过的直接返回缓存值，不重复起 git 进程。
   * 整个方法对调用方是「尽力而为」：任何异常都吞掉并返回 undefined。
   *
   * 可以传多个候选 worktree：分支 worktree 被回收之后，项目主 clone 里通常
   * 仍然有这个 commit。逐个试到第一个成功为止，全失败才放弃 —— 绝不猜。
   */
  async remember(projectId: string, commitSha: string, ...worktreePaths: Array<string | undefined>): Promise<string | undefined> {
    if (!projectId || !isCommitShaLike(commitSha)) return undefined;
    const key = releaseCommitKey(projectId, commitSha);
    const cached = this.entries.get(key);
    if (cached) return cached.at;
    const roots = [...new Set(worktreePaths.filter((root): root is string => !!root))];
    if (!roots.length) return undefined;
    const pendingKey = JSON.stringify([key, roots]);
    const pending = this.pending.get(pendingKey);
    if (pending) return pending;
    if (this.pending.size >= 32) return undefined;
    const signal = AbortSignal.timeout(this.options.timeoutMs ?? RELEASE_GIT_TIMEOUT_MS);
    const task = (async () => {
      if (!this.loaded) await this.ready();
      const loaded = this.entries.get(key);
      return loaded ? loaded.at : this.rememberAtRoots(key, commitSha, roots, signal);
    })().finally(() => this.pending.delete(pendingKey));
    this.pending.set(pendingKey, task);
    return task;
  }

  private async rememberAtRoots(key: string, commitSha: string, roots: string[], signal: AbortSignal): Promise<string | undefined> {
    let meta: ReleaseCommitMetaRead | undefined;
    for (const worktreePath of roots) {
      if (signal.aborted) break;
      try {
        meta = await readMeta(this.options.reader ?? gitCommitMetaReader, worktreePath, commitSha, signal);
      } catch {
        meta = undefined;
      }
      if (meta) break;
    }
    if (!meta || signal.aborted) return undefined;
    this.entries.set(key, meta);
    // Map 保插入序，删最早插入的即是最旧的记录。
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    await this.persist();
    return meta.at;
  }
}
