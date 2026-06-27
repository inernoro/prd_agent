/**
 * 构建历史元数据的纯函数 SSOT（2026-06-27）。
 *
 * 两类逻辑各占一头：
 *   1. 写入侧（后端）：把 OperationLog 创建时能拿到的上下文（trigger / deploy
 *      mode / commit）归一化成稳定枚举，给 branches.ts 的两个 opLog 创建处共用。
 *   2. 展示侧（前端复用同一阈值）：给「正在跑但卡住」的部署封顶耗时，避免卡片
 *      永远显示一个越长越离谱的数字（如 772m）。
 *
 * 抽成纯函数是为了能脱开 Docker/CDS 在 vitest 里直接断言（CLAUDE.md §8.1）。
 */

import type { BranchEntry, BuildProfile, OperationLog } from '../types.js';

/** OperationLog.triggerSource 的取值（与 types.ts 的 additive block 对齐）。 */
export type BuildTriggerSource = NonNullable<OperationLog['triggerSource']>;

/**
 * 把 deploy 请求的上下文归类成构建触发来源。
 *
 * 入参刻意只用「能在 deploy-start 时确定」的信号，不依赖外部 header 之外的写法：
 *   - rawTrigger：triggerFromRequest(req) 的结果（manual / webhook / scheduler / ...）
 *   - retryCount：branch.deployDispatchRetryCount —— reconciler 自动重试时 >0
 *
 * 判定顺序（前者命中即返回）：
 *   1. webhook 触发 + 已重试过（retryCount>0）→ 'retry'（reconciler 自愈重投）
 *   2. webhook 触发 → 'webhook'
 *   3. scheduler 触发 → 'cooldown-rewarm'（warm pool 把降温分支重新唤醒）
 *   4. manual → 'manual'
 *   5. 其余系统侧（auto-lifecycle / janitor / system）→ 'system'
 */
export function classifyTriggerSource(
  rawTrigger: string | null | undefined,
  retryCount: number | undefined,
): BuildTriggerSource {
  const retried = typeof retryCount === 'number' && retryCount > 0;
  if (rawTrigger === 'webhook') return retried ? 'retry' : 'webhook';
  if (rawTrigger === 'scheduler') return 'cooldown-rewarm';
  if (rawTrigger === 'manual' || rawTrigger == null || rawTrigger === '') return 'manual';
  // auto-lifecycle / janitor / system 等其余系统侧自调
  return 'system';
}

/**
 * 解析「本次部署实际使用的部署模式」。
 * 取参与本次部署的 profiles 里第一个非空 activeDeployMode；都为空则返回空串
 * （= 源码/默认模式）。已解析后的 effective profile（resolveEffectiveProfile 产物）
 * 直接读 activeDeployMode 即可。
 */
export function deriveDeployMode(profiles: Array<Pick<BuildProfile, 'activeDeployMode'>>): string {
  for (const p of profiles) {
    const mode = (p.activeDeployMode || '').trim();
    if (mode) return mode;
  }
  return '';
}

/** 从分支取 commit 完整 SHA + 短哈希（webhook 锚定的 githubCommitSha 优先）。 */
export function deriveCommitMeta(
  branch: Pick<BranchEntry, 'githubCommitSha'>,
  explicitSha?: string | null,
): { commitSha?: string; shortCommit?: string } {
  const full = (explicitSha || branch.githubCommitSha || '').trim();
  if (!full) return {};
  return { commitSha: full, shortCommit: full.slice(0, 7) };
}

/**
 * 从 WorktreeService.pull() 的返回里取出**纯 SHA**。
 *
 * 病根（Codex P2）：pull() 的 `head` 来自 `git log --oneline -1`，形如
 * `abc1234 commit message`（短 SHA + 空格 + 标题），**不是**裸 SHA。branches.ts 旧实现
 * 用 `/^[0-9a-f]{7,40}$/.test(pullResult.head)` 当门：带标题的 head 永远不匹配 → 「pull 后
 * 用真实 HEAD 刷新 githubCommitSha + 构建历史版本列」整段被跳过 → 源码部署拉到更新提交后，
 * 历史「版本」列仍停在 pull 前旧 SHA，给 reviewer 指错版本。
 *
 * 正确取值：优先 `after`（pull() 由 `git rev-parse --short HEAD` 得到的裸短 SHA），
 * 拿不到再退而解析 `head` 的第一个 token。返回裸 SHA 或 ''（无法解析）。纯函数，可单测。
 */
export function parsePulledSha(pullResult: { head?: string; after?: string } | null | undefined): string {
  if (!pullResult) return '';
  const after = (pullResult.after || '').trim();
  if (/^[0-9a-f]{7,40}$/i.test(after)) return after;
  const headToken = (pullResult.head || '').trim().split(/\s+/)[0] || '';
  return /^[0-9a-f]{7,40}$/i.test(headToken) ? headToken : '';
}

/**
 * 两个 SHA 是否指向不同 commit。短 SHA（7 位）与全 SHA（40 位）互为前缀 ⇒ 视为同一 commit，
 * 不算变化（避免把存量的 40 位 githubCommitSha 截断成 7 位短哈希）。任一为空 ⇒ 不算变化。
 */
export function commitShaDiffers(a: string | null | undefined, b: string | null | undefined): boolean {
  const lo = (a || '').trim().toLowerCase();
  const ro = (b || '').trim().toLowerCase();
  if (!lo || !ro) return false;
  return !(lo.startsWith(ro) || ro.startsWith(lo));
}

/**
 * 「疑似卡住」判定阈值（毫秒）。一个仍在进行中的部署，已耗时超过这个值还没就绪，
 * 视为卡死/超时，前端不再显示一个不断增长的真实数字，而是封顶 + 打「疑似卡住」徽章。
 *
 * 60 分钟兜底：任何正常 CDS 构建（含拉取 + 镜像构建 + 启动 + 就绪探测）都远低于此。
 * 历史「772m / 12.8h」幽灵正是「卡住的 deploy 耗时无上界一直涨」。
 */
export const STUCK_DEPLOY_THRESHOLD_MS = 60 * 60 * 1000;

export interface DeployDurationDisplay {
  /** 实际经过的毫秒数（封顶前），仅用于诊断 / tooltip。 */
  elapsedMs: number;
  /** 是否判定为卡住（仍在进行中且超过阈值）。 */
  stuck: boolean;
  /** UI 应显示的封顶毫秒数：卡住时封到阈值，否则等于 elapsedMs。 */
  cappedMs: number;
}

/**
 * 计算部署耗时的展示值 + 是否卡住。纯函数，前端 HistoryRow / ActiveDeployment 复用。
 *
 * @param startedAt   本轮部署开始时刻（ms epoch）
 * @param finishedAt  本轮部署结束时刻（ms epoch）；进行中为 undefined
 * @param now         当前时刻（ms epoch）
 * @param thresholdMs 卡死阈值，默认 STUCK_DEPLOY_THRESHOLD_MS
 *
 * 规则：
 *   - 已结束（finishedAt 有值）：永远显示真实耗时，绝不判卡住（历史就该如实展示）。
 *   - 进行中（finishedAt 缺）：elapsed = now - startedAt；超阈值 → stuck，cappedMs 封到阈值。
 */
export function computeDeployDurationDisplay(
  startedAt: number,
  finishedAt: number | undefined,
  now: number,
  thresholdMs: number = STUCK_DEPLOY_THRESHOLD_MS,
): DeployDurationDisplay {
  const end = finishedAt ?? now;
  const elapsedMs = Math.max(0, end - startedAt);
  // 已结束的部署照实显示，不封顶（哪怕历史上真跑了 70 分钟也是事实）。
  if (finishedAt !== undefined) {
    return { elapsedMs, stuck: false, cappedMs: elapsedMs };
  }
  const stuck = elapsedMs > thresholdMs;
  return { elapsedMs, stuck, cappedMs: stuck ? thresholdMs : elapsedMs };
}
