/**
 * release-commit-rail — 主干提交流水轴 + 「每个环境停在哪个提交、落后多少」的唯一判定源。
 *
 * 发布中心 v2 的骨架是环境而不是目标列表：顶部一条 main 的提交流水轴，
 * 每个环境在轴上有一个点。要画出它，需要回答三个问题：
 *   1. main 最近这几个提交分别是什么（sha / 时间 / 说明）；
 *   2. 某个环境正在跑的那一版，落在轴的哪个位置、落后主干几个提交；
 *   3. 另一个环境是不是跑着更新的一版（能不能一键提升）。
 *
 * 三条硬约束，都是踩过的坑：
 *
 * - **只读本地 ref，绝不 fetch。** 打开发布中心是纯读动作，不该按目标数放大成
 *   一串网络往返（同 release-health-snapshot.ts 顶部「打开发布中心不打生产」的取舍）。
 *   本地 `origin/main` 可能比真实远端旧，落后数会偏小——这个事实由 `refsAsOf`
 *   如实标注，而不是偷偷 fetch 一下把数字「修准」。
 *
 * - **落后 / 领先各自直算，禁止相减。** 跨环境「新了几个提交」若拿两个 behindCount
 *   相减，只在严格线性历史下成立；一旦分叉就给出一个无声的错数。所以两个方向都
 *   跑各自的 `rev-list --count`，并且允许同时非零（分叉时就是同时非零）。
 *
 * - **算不出就是 null，不是 0。** 0 的含义是「与主干齐平」，是个很强的结论；
 *   把「ref 不存在 / git 不可用」显示成齐平，比不显示更糟（no-rootless-tree）。
 *
 * 所有 sha 过 isCommitShaLike、所有 ref 过 isSafeGitRef 才准进 argv：这两个值
 * 最终是 git 的命令行参数，`-` 开头的值会被当成选项（`--upload-pack=` 可直接
 * 执行命令）。execFile 不过 shell 能挡住管道，挡不住「参数被当成选项」这一层。
 */

import { execFileSync } from 'node:child_process';
import { isCommitShaLike } from './release-commit-clock.js';
import { isSafeGitRef } from './github-webhook-dispatcher.js';

/** 单元分隔符。commit subject 里什么字符都可能有，只有它足够安全。 */
const UNIT_SEPARATOR = '\x1f';

export const DEFAULT_RAIL_NODES = 8;
export const DEFAULT_RAIL_TTL_MS = 60_000;
/**
 * 取「落后段里最早那个提交」时的跨度上限。超过它就不取了——
 * 一个落后上万提交的环境，那个时间戳对用户没有任何增量信息，
 * 却要多起一个进程去翻历史。
 */
export const MAX_BEHIND_SCAN = 20_000;

const GIT_TIMEOUT_MS = 3_000;

/** 注入点：单测传假 runner，生产走 execFileSync。约定失败时抛异常。 */
export type GitRunner = (args: readonly string[]) => string;

export const execFileGitRunner: GitRunner = (args) =>
  execFileSync('git', [...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

export interface ReleaseCommitRailNode {
  sha: string;
  shortSha: string;
  subject: string;
  committedAt: string;
}

export interface ReleaseCommitRail {
  /** 主干分支名（Project.gitDefaultBranch）。取不到时为空串 + unavailableReason。 */
  branch: string;
  /** 实际读到的本地 ref，例如 origin/main。 */
  ref: string;
  /** 从新到旧。unavailableReason 非空时恒为空数组。 */
  nodes: ReleaseCommitRailNode[];
  /** ref 顶端提交的时刻——如实暴露「本地 ref 有多旧」，不掩盖不 fetch 的代价。 */
  refsAsOf?: string;
  /** 人话原因。非空即代表整条流水轴不可用，前端隐藏它。 */
  unavailableReason?: string;
}

export interface ReleaseTargetCommitPosition {
  commitSha: string;
  /** 主干比它新几个提交。算不出是 null，不是 0。 */
  behindCount: number | null;
  /** 它比主干多几个提交（分叉 / 直接从别处发上去的版本）。算不出是 null。 */
  aheadCount: number | null;
  /** 落后段里最早那个提交的提交时刻，供「最早未上线提交距今 N 小时」。 */
  oldestUnreleasedAt?: string;
  /** 这一版是否落在流水轴展示的那几个节点上（决定轴上画不画点）。 */
  inRail: boolean;
  /** 算不出时的人话原因。 */
  reason?: string;
}

export interface ReleaseCommitRailResult {
  rail: ReleaseCommitRail;
  positions: Record<string, ReleaseTargetCommitPosition>;
}

export interface ReleaseCommitRailInput {
  projectId: string;
  /** Project.gitDefaultBranch。缺省即「项目没记过远端默认分支」。 */
  branch?: string | null;
  targets: ReadonlyArray<{ targetId: string; commitSha: string }>;
}

/** 解析 `%H\x1f%cI\x1f%s` 的多行输出。subject 里含分隔符的部分不会被截断。 */
export function parseRailLog(stdout: string): ReleaseCommitRailNode[] {
  const nodes: ReleaseCommitRailNode[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const first = line.indexOf(UNIT_SEPARATOR);
    if (first < 0) continue;
    const second = line.indexOf(UNIT_SEPARATOR, first + 1);
    if (second < 0) continue;
    const sha = line.slice(0, first).trim();
    const at = line.slice(first + 1, second).trim();
    // subject 用 slice 而不是 split：说明里出现分隔符时 split 会把尾巴切掉。
    const subject = line.slice(second + 1).trim();
    if (!isCommitShaLike(sha) || !Number.isFinite(Date.parse(at))) continue;
    nodes.push({
      sha,
      shortSha: sha.slice(0, 7),
      subject,
      committedAt: new Date(at).toISOString(),
    });
  }
  return nodes;
}

/** 解析 `rev-list --count` 输出。任何解析不出来的东西一律 null，绝不退化成 0。 */
export function parseCount(stdout: string): number | null {
  const raw = (stdout || '').trim().split('\n')[0]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** 两个 sha 是否指同一个提交（一端可能是短 sha）。 */
function sameCommit(a: string, b: string): boolean {
  if (!a || !b) return false;
  const lower = (v: string): string => v.toLowerCase();
  const [x, y] = [lower(a), lower(b)];
  return x.startsWith(y) || y.startsWith(x);
}

interface CacheEntry {
  signature: string;
  expiresAt: number;
  result: ReleaseCommitRailResult;
}

export interface ReleaseCommitRailOptions {
  /** 项目 → 本地 git 仓库根。取不到即「没有可读的本地仓库」。 */
  repoRootResolver: (projectId: string) => string | undefined;
  runner?: GitRunner;
  ttlMs?: number;
  maxNodes?: number;
  now?: () => number;
}

export class ReleaseCommitRailReader {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly options: ReleaseCommitRailOptions) {}

  private get runner(): GitRunner {
    return this.options.runner ?? execFileGitRunner;
  }

  private get ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_RAIL_TTL_MS;
  }

  private get maxNodes(): number {
    return Math.max(1, this.options.maxNodes ?? DEFAULT_RAIL_NODES);
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private run(args: readonly string[]): string | undefined {
    try {
      return this.runner(args);
    } catch {
      return undefined;
    }
  }

  /**
   * 两个 commit 之间隔了几个提交（`from..to`，即 to 比 from 多几个）。
   * 跨环境「新了几个提交」必须走这里直算，禁止拿两个 behindCount 相减。
   */
  countCommitsBetween(projectId: string, fromSha: string, toSha: string): number | null {
    if (!isCommitShaLike(fromSha) || !isCommitShaLike(toSha)) return null;
    if (sameCommit(fromSha, toSha)) return 0;
    const root = this.resolveRepoRoot(projectId);
    if (!root) return null;
    const out = this.run(['-C', root, 'rev-list', '--count', `${fromSha}..${toSha}`]);
    return out === undefined ? null : parseCount(out);
  }

  private resolveRepoRoot(projectId: string): string | undefined {
    try {
      const root = this.options.repoRootResolver(projectId);
      return root && root.trim() ? root.trim() : undefined;
    } catch {
      return undefined;
    }
  }

  read(input: ReleaseCommitRailInput): ReleaseCommitRailResult {
    const signature = [
      input.branch || '',
      ...[...input.targets]
        .map((t) => `${t.targetId}:${t.commitSha}`)
        .sort(),
    ].join('|');
    const cached = this.cache.get(input.projectId);
    if (cached && cached.signature === signature && cached.expiresAt > this.now()) {
      return cached.result;
    }
    const result = this.compute(input);
    this.cache.set(input.projectId, {
      signature,
      expiresAt: this.now() + this.ttlMs,
      result,
    });
    return result;
  }

  private compute(input: ReleaseCommitRailInput): ReleaseCommitRailResult {
    const branch = (input.branch || '').trim();
    const unavailable = (reason: string): ReleaseCommitRailResult => ({
      rail: { branch, ref: '', nodes: [], unavailableReason: reason },
      positions: positionsWithReason(input.targets, reason),
    });

    if (!branch) return unavailable('项目未记录远端默认分支，无法确定主干');
    if (!isSafeGitRef(branch)) return unavailable(`分支名 ${branch} 不在允许的 ref 白名单内`);
    const root = this.resolveRepoRoot(input.projectId);
    if (!root) return unavailable('项目未记录本地仓库路径，无法读取提交历史');

    const ref = this.resolveRef(root, branch);
    if (!ref) return unavailable(`本地仓库没有 ${branch} 的引用，可能尚未拉取过该分支`);

    const logOut = this.run([
      '-C', root, 'log',
      '--max-count', String(this.maxNodes),
      `--format=%H${UNIT_SEPARATOR}%cI${UNIT_SEPARATOR}%s`,
      ref,
    ]);
    if (logOut === undefined) return unavailable('git 不可用或读取提交历史失败');
    const nodes = parseRailLog(logOut);
    if (nodes.length === 0) return unavailable(`${ref} 上没有可读的提交`);

    const rail: ReleaseCommitRail = {
      branch,
      ref,
      nodes,
      refsAsOf: nodes[0].committedAt,
    };

    const positions: Record<string, ReleaseTargetCommitPosition> = {};
    for (const target of input.targets) {
      positions[target.targetId] = this.positionOf(root, ref, nodes, target.commitSha);
    }
    return { rail, positions };
  }

  /** 优先 origin/<branch>（真实远端状态），本地没有再退到同名本地分支。 */
  private resolveRef(root: string, branch: string): string | undefined {
    for (const candidate of [`origin/${branch}`, branch]) {
      const out = this.run(['-C', root, 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`]);
      if (out && out.trim()) return candidate;
    }
    return undefined;
  }

  private positionOf(
    root: string,
    ref: string,
    nodes: ReleaseCommitRailNode[],
    commitSha: string,
  ): ReleaseTargetCommitPosition {
    const base: ReleaseTargetCommitPosition = {
      commitSha,
      behindCount: null,
      aheadCount: null,
      inRail: false,
    };
    if (!commitSha) {
      return { ...base, reason: '该环境还没有成功发布过，无法定位提交' };
    }
    if (!isCommitShaLike(commitSha)) {
      return { ...base, reason: '发布记录里的提交号形状不合法，未做定位' };
    }

    const inRail = nodes.some((node) => sameCommit(node.sha, commitSha));
    const behindOut = this.run(['-C', root, 'rev-list', '--count', `${commitSha}..${ref}`]);
    const behindCount = behindOut === undefined ? null : parseCount(behindOut);
    const aheadOut = this.run(['-C', root, 'rev-list', '--count', `${ref}..${commitSha}`]);
    const aheadCount = aheadOut === undefined ? null : parseCount(aheadOut);

    if (behindCount === null && aheadCount === null) {
      return {
        ...base,
        inRail,
        reason: `本地仓库里没有提交 ${commitSha.slice(0, 7)}，无法与主干比较`,
      };
    }

    const oldestUnreleasedAt = behindCount && behindCount > 0 && behindCount <= MAX_BEHIND_SCAN
      ? this.oldestCommitAt(root, ref, commitSha, behindCount)
      : undefined;

    return {
      commitSha,
      behindCount,
      aheadCount,
      inRail,
      ...(oldestUnreleasedAt ? { oldestUnreleasedAt } : {}),
    };
  }

  /**
   * 落后段里**最早**那个提交的时刻。
   * 用 `--skip=N-1 --max-count=1` 而不是 `--reverse`：前者输出恒为一行，
   * 后者要把整段历史打印出来再倒序，落后上千提交时纯属浪费。
   */
  private oldestCommitAt(root: string, ref: string, commitSha: string, behindCount: number): string | undefined {
    const out = this.run([
      '-C', root, 'log',
      `--skip=${behindCount - 1}`,
      '--max-count', '1',
      '--format=%cI',
      `${commitSha}..${ref}`,
    ]);
    const iso = (out || '').trim().split('\n')[0]?.trim();
    if (!iso || !Number.isFinite(Date.parse(iso))) return undefined;
    return new Date(iso).toISOString();
  }
}

function positionsWithReason(
  targets: ReadonlyArray<{ targetId: string; commitSha: string }>,
  reason: string,
): Record<string, ReleaseTargetCommitPosition> {
  const positions: Record<string, ReleaseTargetCommitPosition> = {};
  for (const target of targets) {
    positions[target.targetId] = {
      commitSha: target.commitSha,
      behindCount: null,
      aheadCount: null,
      inRail: false,
      reason,
    };
  }
  return positions;
}
