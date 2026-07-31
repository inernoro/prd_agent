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

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
) => string | ReleaseCommitMetaRead | undefined;

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
export const gitCommitMetaReader: CommitTimeReader = (worktreePath, commitSha) => {
  if (!worktreePath || !isCommitShaLike(commitSha)) return undefined;
  try {
    const out = execFileSync(
      'git',
      ['-C', worktreePath, 'show', '-s', `--format=%cI${UNIT_SEPARATOR}%s${UNIT_SEPARATOR}%an`, commitSha],
      {
        encoding: 'utf8',
        timeout: 3_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const line = out.split('\n')[0] ?? '';
    const [at, subject, author] = line.split(UNIT_SEPARATOR);
    return normalizeMetaRead({ at: (at || '').trim(), subject, author });
  } catch {
    return undefined;
  }
};

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
        if (!Array.isArray(pair) || typeof pair[0] !== 'string') continue;
        // v1 条目是裸 ISO 字符串，v2 是对象——normalizeMetaRead 同时收两种。
        const meta = normalizeMetaRead(pair[1] as string | ReleaseCommitMetaRead | undefined);
        if (!meta) continue;
        this.entries.set(pair[0], meta);
      }
    } catch (err) {
      this.options.logger?.warn?.(`[release-commit-clock] 读取失败，从空台账开始: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    const fp = this.options.storePath;
    if (!fp) return;
    const payload: CommitClockFile = {
      version: 2,
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

  /** 只要提交时刻（DORA 的原始用途）。形状保持 v1 的 ISO 字符串，调用方不用改。 */
  get(projectId: string, commitSha: string): string | undefined {
    return this.getMeta(projectId, commitSha)?.at;
  }

  /** 完整元信息。取不到就是 undefined —— 前端据此退化成只显示 short sha。 */
  getMeta(projectId: string, commitSha: string): ReleaseCommitMetaRead | undefined {
    if (!projectId || !commitSha) return undefined;
    this.ensureLoaded();
    return this.entries.get(releaseCommitKey(projectId, commitSha));
  }

  /**
   * 记一次 commit 元信息。已记过的直接返回缓存值，不重复起 git 进程。
   * 整个方法对调用方是「尽力而为」：任何异常都吞掉并返回 undefined。
   *
   * 可以传多个候选 worktree：分支 worktree 被回收之后，项目主 clone 里通常
   * 仍然有这个 commit。逐个试到第一个成功为止，全失败才放弃 —— 绝不猜。
   */
  remember(projectId: string, commitSha: string, ...worktreePaths: Array<string | undefined>): string | undefined {
    if (!projectId || !commitSha) return undefined;
    this.ensureLoaded();
    const key = releaseCommitKey(projectId, commitSha);
    const cached = this.entries.get(key);
    if (cached) return cached.at;
    let meta: ReleaseCommitMetaRead | undefined;
    const seen = new Set<string>();
    for (const worktreePath of worktreePaths) {
      if (!worktreePath || seen.has(worktreePath)) continue;
      seen.add(worktreePath);
      try {
        meta = normalizeMetaRead((this.options.reader ?? gitCommitMetaReader)(worktreePath, commitSha));
      } catch {
        meta = undefined;
      }
      if (meta) break;
    }
    if (!meta) return undefined;
    this.entries.set(key, meta);
    // Map 保插入序，删最早插入的即是最旧的记录。
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.persist();
    return meta.at;
  }
}
