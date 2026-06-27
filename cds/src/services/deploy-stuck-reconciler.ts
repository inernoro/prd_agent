/**
 * deploy-stuck-reconciler — 部署/生命周期状态机的「通用看门狗」纯函数 SSOT。
 *
 * 病根（2026-06-27 fleet audit 39 个分支暴露）：CDS 的部署生命周期状态机
 * **没有**通用的卡死收敛器。只有 `ciImageStatus='waiting'` 有看门狗
 * （index.ts startCiWaitWatchdog），其余非终结态可以静默卡死永不收敛：
 *
 *  - TYPE 2「状态从未终结」：cd-s-mobile-homepage 的 branch.status='starting'
 *    卡 9.6 小时，而 lastReadyAt(23:01) 已晚于 lastDeployStartedAt(22:18)，
 *    随后又被自动降温（lastStoppedAt 落戳 + lastStopReason="自动降温"）——
 *    status 字段停在一个与生命周期时间戳**自相矛盾**的非终结值，UI 据此
 *    渲染出无限「99.99% / 部署耗时 772m」。又如 cursor-file-convert 空闲
 *    （已降温）但 per-service status 卡在 'stopping' 永不终结成 'stopped'。
 *
 *  - TYPE 1「极速版镜像落后 HEAD」：kind-newton / product-agent-migration
 *    的 ciImageStatus='ready' 但 ciTargetSha !== githubCommitSha —— CI 为
 *    真 HEAD 编了镜像却没被认领/部署，于是静默跑着旧镜像，无任何告警。
 *
 * 本模块对两类卡死给出**纯函数**收敛器，镜像 deploy-dispatch-reconciler
 * 的形状（输入 branches + now + options，输出 result 数组），所有 I/O
 * （git diff / 写日志 / 发事件）经回调注入，核心可脱离仓库单测。
 *
 * 设计取舍：
 *  - TYPE 2 优先走**时间戳证据**路径（ready 已晚于 start ⇒ 状态过期），
 *    只有完全拿不到证据时才用**保守硬超时**兜底（默认 ~45min = 3× 就绪
 *    超时），永不误杀一个「确实很久但健康」的构建。
 *  - TYPE 1 **只告警不自动部署**（自动重部署在这里不安全，可能踩到正在
 *    进行的部署 / 认领竞态）——把静默失败变成响亮失败，让人/CI 介入。
 */

import type { BranchEntry, BuildProfile, OperationLog } from '../types.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import { createHash } from 'node:crypto';
import { branchUsesPrebuiltMode } from './deploy-runtime.js';

/** 非终结的分支/服务状态。卡在这些值且与时间戳矛盾 ⇒ 需收敛。 */
const NON_TERMINAL_STATES = new Set(['starting', 'building', 'stopping', 'restarting']);

/**
 * 保守硬超时（毫秒）。非终结态持续超过此阈值且**无任何时间戳证据**可推断
 * 真实终态时，作为最后手段收敛为 error/stopped。故意取得很大（默认 45min =
 * 3× 就绪超时 300s），绝不误杀健康但耗时长的构建。可经 options 覆盖。
 */
export const STUCK_NON_TERMINAL_HARD_TIMEOUT_MS = 45 * 60_000;

export type StuckReconcileKind =
  | 'branch-status-finalized' // TYPE 2：分支级非终结态收敛
  | 'service-status-finalized' // TYPE 2：服务级非终结态收敛
  | 'express-head-divergence'; // TYPE 1：极速版镜像落后 HEAD 告警

export interface DeployStuckReconcileResult {
  branchId: string;
  projectId?: string;
  kind: StuckReconcileKind;
  /** 服务级收敛时指向具体 profileId；分支级 / 告警类为 undefined。 */
  profileId?: string;
  previousStatus?: string;
  nextStatus?: string;
  /** 触发收敛/告警的判定路径：'timestamp-evidence' | 'hard-timeout' | 'alarm'。 */
  via: 'timestamp-evidence' | 'hard-timeout' | 'alarm';
  ageMin?: number;
  reason: string;
}

export interface ReconcileStuckDeployOptions {
  now?: Date;
  source?: string;
  /** 非终结态硬超时（毫秒），缺省 STUCK_NON_TERMINAL_HARD_TIMEOUT_MS。 */
  hardTimeoutMs?: number;
  serverEventLogStore?: ServerEventLogSink | null;
  /** 取该分支当前生效的 build profiles（用于 branchUsesPrebuiltMode 判定）。 */
  getBuildProfiles?: (branch: BranchEntry) => BuildProfile[];
  /**
   * 判定 ciTargetSha..githubCommitSha 这段 divergent commit 是否含**运行时**
   * 改动（非纯文档）。生产环境接到 worktree 里的 `git diff` → analyzeChangeImpact；
   * 单测里 mock。返回 true ⇒ 有未部署的代码改动 ⇒ 告警；false ⇒ 纯文档 ⇒ 不告警。
   * 不提供时跳过 TYPE 1 告警（保守：无证据不喊）。
   */
  diffRuntimePaths?: (branch: BranchEntry) => boolean;
  /** 收敛/告警时追加一条分支 op-log（注入以保持纯函数可测）。 */
  appendLog?: (branchId: string, log: OperationLog) => void;
  /** 收敛/告警后发 branch.updated 事件让 UI 刷新（注入以保持纯函数可测）。 */
  emitBranchUpdated?: (branch: BranchEntry) => void;
  /**
   * 该分支当前是否有**在途操作**（部署/重启/降温…由 BranchOperationCoordinator 持租约）。
   * 返回 true ⇒ 看门狗本轮**完全跳过**该分支：操作拥有该分支，正常的长任务（>45min 的
   * 编译/迁移/冷启）不应被硬超时误判为 error，状态由操作完成时自行落终态（Bugbot Medium
   * 「Long deploys falsely timed out」）。不提供时退化为旧行为（无操作感知）。
   */
  hasActiveOperation?: (branch: BranchEntry) => boolean;
  /**
   * 是否允许**硬超时**收敛（45min 兜底把卡死非终结态强制成 error）。默认 true。
   * 仅当本节点能可靠判活（master：本地/远端代理部署都持 BranchOperationCoordinator 租约，
   * hasActiveOperation 准）时才安全。executor 节点的 /exec/deploy **不持**该租约，hasActiveOperation
   * 永远 false，硬超时会把合法的 >45min 远端构建误判 error（Bugbot High「Executor deploys lack
   * lease skip」）。故 index.ts 在 executor 模式传 false：executor 只做时间戳证据收敛 + 告警，
   * 不做硬超时（证据路径自身要求 lastReadyAt 已晚于本轮 start，绝不会误杀在建构建）。
   */
  allowHardTimeout?: boolean;
  /**
   * 是否按「当前在册 build profile」过滤掉僵尸服务再做分支聚合。默认 true。
   * 仅当本节点的 getBuildProfiles 是该分支服务的**权威**注册表时才安全。executor 节点的
   * /exec/deploy 用的是 master 请求里传来的 profilesData、并不写进 executor 本地 profile 注册表，
   * executor 本地 getBuildProfiles 可能为空/陈旧 → 会把真实 executor 服务全当僵尸过滤掉，把在跑的
   * 远端分支误判 idle / 清服务错误（Codex P2「Do not filter executor services with local profiles」）。
   * 故 index.ts 在 executor 模式传 false：executor 不做僵尸过滤，认所有已部署服务为真。
   */
  filterZombieProfiles?: boolean;
}

function parseTime(value?: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createTraceId(branchId: string, anchor: string, source: string): string {
  const digest = createHash('sha1')
    .update(`${branchId}\0${anchor}\0${source}`)
    .digest('hex')
    .slice(0, 12);
  return `op_stuck_${digest}`;
}

function recordEvent(
  store: ServerEventLogSink | null | undefined,
  branch: BranchEntry,
  source: string,
  action: string,
  message: string,
  details: Record<string, unknown>,
): void {
  if (!store) return;
  const operationId = createTraceId(branch.id, action, source);
  const requestId = `stuck_${operationId.slice('op_stuck_'.length)}`;
  store.record({
    category: 'system',
    severity: 'warn',
    source,
    action,
    message,
    projectId: branch.projectId,
    branchId: branch.id,
    requestId,
    operationId,
    details: {
      operationId,
      requestId,
      actor: 'system:deploy-stuck-reconciler',
      trigger: 'system',
      ...details,
    },
  });
}

/**
 * TYPE 2 分支级：判断卡死的非终结 branch.status 应收敛到什么终态，并给出判定路径。
 * 返回 null 表示「未卡死 / 仍在合理进行中」，不应触碰。
 */
function decideBranchFinalization(
  branch: BranchEntry,
  nowMs: number,
  hardTimeoutMs: number,
  allowHardTimeout: boolean,
): { nextStatus: BranchEntry['status']; via: 'timestamp-evidence' | 'hard-timeout'; ageMin: number; reason: string } | null {
  const status = branch.status;
  if (!NON_TERMINAL_STATES.has(status)) return null;

  const readyMs = parseTime(branch.lastReadyAt);
  const startMs = parseTime(branch.lastDeployStartedAt);
  const stoppedMs = parseTime(branch.lastStoppedAt);

  // 证据路径 A：starting/building/restarting 但 lastReadyAt >= lastDeployStartedAt，
  // 说明它**确实**起来过 —— status 是陈旧的。再看是否随后被停（lastStoppedAt 更新）：
  // 停了 ⇒ idle；没停 ⇒ running。
  // 守卫（Bugbot review）：必须有**本轮** lastDeployStartedAt 锚点（startMs > 0）才能
  // 用 lastReadyAt 作证据。否则 startMs 缺省被当 0，任意陈旧的 lastReadyAt 都满足
  // readyMs >= 0，会把一个真正在 starting 的新部署用上一轮的就绪戳误收敛。无锚点时
  // 落到下方硬超时兜底，不走证据路径。
  if ((status === 'starting' || status === 'building' || status === 'restarting') && startMs > 0 && readyMs >= startMs) {
    if (stoppedMs >= readyMs) {
      return {
        nextStatus: 'idle',
        via: 'timestamp-evidence',
        ageMin: startMs > 0 ? Math.floor((nowMs - startMs) / 60_000) : 0,
        reason: `状态机看门狗：${status} 已就绪（lastReadyAt 晚于 lastDeployStartedAt）后又被停止（lastStoppedAt），状态陈旧，收敛为 idle`,
      };
    }
    return {
      nextStatus: 'running',
      via: 'timestamp-evidence',
      ageMin: startMs > 0 ? Math.floor((nowMs - startMs) / 60_000) : 0,
      reason: `状态机看门狗：${status} 实际已就绪（lastReadyAt 晚于 lastDeployStartedAt），状态陈旧，收敛为 running`,
    };
  }

  // 证据路径 B：stopping 但 lastStoppedAt 已落戳且晚于本轮停止触发的起点，
  // 说明停止已完成 —— 收敛为 idle（分支级无 'stopped' 终态，停妥即 idle）。
  if (status === 'stopping' && stoppedMs > 0) {
    const triggerMs = Math.max(startMs, readyMs);
    // 守卫（Bugbot review）：必须有停止触发的锚点（triggerMs > 0）才能判停止已完成。
    // 否则 triggerMs=0 时任意陈旧 lastStoppedAt 都满足，会把仍在进行的停止误判为已停。
    if (triggerMs > 0 && stoppedMs >= triggerMs) {
      return {
        nextStatus: 'idle',
        via: 'timestamp-evidence',
        ageMin: Math.floor((nowMs - stoppedMs) / 60_000),
        reason: `状态机看门狗：stopping 已完成（lastStoppedAt 已落戳），状态陈旧，收敛为 idle`,
      };
    }
  }

  // 硬超时兜底（最后手段）：拿不到时间戳证据时，仅当非终结态持续超过保守阈值才收敛。
  // 锚点**只**用本轮启动戳 lastDeployStartedAt（startMs）。不再退回 lastReadyAt（上一轮的
  // 完成戳，会让刚开始的新部署被当成"已持续很久"误超时）或 createdAt（老分支创建很久，会把
  // 任何新非终结态立刻误判超时）。无本轮启动锚点 ⇒ 无法证明卡了多久 ⇒ 不触碰（Bugbot review 延伸）。
  //
  // **stopping 排除在硬超时之外**（Bugbot High / Codex P2）：lastDeployStartedAt 是部署起点、
  // 不是停止起点，且停止流程不刷新该戳。一个运行已久的分支刚发起正常停止，下一拍就会被用
  // 部署起点误判超时、把仍在进行的停止标成 idle（Docker/远端 executor 可能还在停）。我们没有
  // "停止起点"时间戳，故 stopping 只走证据路径（lastStoppedAt）；无证据则不触碰，绝不谎报已停。
  if (allowHardTimeout && startMs > 0 && status !== 'stopping') {
    const ageMs = nowMs - startMs;
    if (ageMs >= hardTimeoutMs) {
      const ageMin = Math.floor(ageMs / 60_000);
      return {
        nextStatus: 'error',
        via: 'hard-timeout',
        ageMin,
        reason: `状态机看门狗：${status} 超过 ${Math.floor(hardTimeoutMs / 60_000)} 分钟未终结（已持续 ${ageMin} 分钟），已收敛为 error`,
      };
    }
  }

  return null;
}

/**
 * 从 service.status 重算分支聚合 status + errorMessage（纯函数，镜像 index.ts
 * reconcileBranchStatusFromServices 的聚合口径，但**不**带 lastReadyAt 副作用 /
 * 不清运行中服务的残留错误——看门狗只负责把「服务已被收敛成 error」如实上浮到分支级）。
 * 仅在服务级收敛真的改了某个 service.status 后调用，避免在「分支有服务」的场景下
 * 让分支级 errorMessage 与服务真实状态脱节（Codex P2：service 收敛成 error 但
 * branch.status 仍 running、branch.errorMessage 仍空，分支卡片/自动化漏掉看门狗失败）。
 * 返回是否改了分支聚合（status 或 errorMessage 任一变化）。
 */
function recomputeBranchAggregateFromServices(
  branch: BranchEntry,
  activeProfileIds?: ReadonlySet<string>,
): { previousStatus: string; nextStatus: string; changed: boolean } {
  const previousStatus = branch.status;
  const previousError = branch.errorMessage;
  // 只认**当前 build profile 仍在册**的服务（Codex P2「Filter aggregate status to active profiles」）：
  // 删/改名 profile 后 branch.services 可能残留僵尸服务条目，若它卡在 error，无脑聚合会把一次成功
  // 重部署的 running 分支下一拍又翻回 error。无 profile 信息（activeProfileIds 缺省）时退回扫全部。
  const liveEntries = Object.entries(branch.services || {})
    .filter(([profileId]) => !activeProfileIds || activeProfileIds.has(profileId));
  const statuses = liveEntries.map(([, svc]) => svc.status);
  const anyServiceError = statuses.some((s) => s === 'error');
  // 分支级 error（**非来自服务**：webhook 派发失败 / 极速版镜像门 / ciImageError 等）绝不能被
  // 服务聚合清掉（Bugbot Medium「Watchdog clears branch error state」）。判据：分支当前是 error
  // 且没有任何服务处于 error ⇒ 这是分支级失败，服务全 stopped 也不与它矛盾，原样保留、不动 status/
  // errorMessage（清分支级 error 是部署/操作的职责，不是看门狗的）。
  if (previousStatus === 'error' && !anyServiceError) {
    return { previousStatus, nextStatus: previousStatus, changed: false };
  }
  let next: BranchEntry['status'];
  if (anyServiceError) next = 'error';
  else if (statuses.some((s) => s === 'building')) next = 'building';
  else if (statuses.some((s) => s === 'starting' || s === 'restarting')) next = 'starting';
  else if (statuses.some((s) => s === 'running')) next = 'running';
  // 'stopping' 是**进行中**的非终结态：必须保留，绝不能塌成 idle（否则把仍在停止的分支谎报已停，
  // 与服务级「stopping 无证据不触碰」自相矛盾）。仅当无任何 running/in-progress 服务时才看 stopping。
  else if (statuses.some((s) => s === 'stopping')) next = 'stopping';
  else next = 'idle'; // 全部 stopped/idle ⇒ 分支 idle（治 Bugbot「服务全停但 branch 仍 running」）
  branch.status = next;
  const failedReasons = liveEntries
    .filter(([, svc]) => svc.status === 'error')
    .map(([id, svc]) => `${id}: ${svc.errorMessage || '启动失败'}`);
  branch.errorMessage = failedReasons.length ? failedReasons.join('\n') : undefined;
  return { previousStatus, nextStatus: next, changed: previousStatus !== next || previousError !== branch.errorMessage };
}

export function reconcileStuckDeployStates(
  branches: BranchEntry[],
  options: ReconcileStuckDeployOptions = {},
): DeployStuckReconcileResult[] {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const source = options.source ?? 'deploy-stuck-reconciler';
  const hardTimeoutMs = options.hardTimeoutMs ?? STUCK_NON_TERMINAL_HARD_TIMEOUT_MS;
  const allowHardTimeout = options.allowHardTimeout ?? true;
  const results: DeployStuckReconcileResult[] = [];

  for (const branch of branches) {
    let mutated = false;

    // Bugbot Medium「Long deploys falsely timed out」：分支上有在途操作（部署/重启/降温…）时，
    // 看门狗**整条跳过**——那个操作拥有该分支，>45min 的合法长任务不该被硬超时误杀成 error，
    // 终态交给操作完成时落。与 index.ts:1401 的「recovery skips operation lease」判活同源。
    if (options.hasActiveOperation?.(branch)) continue;

    // 当前 build profile 仍在册的 profileId 集合（用于聚合时排除僵尸服务条目）。无 getBuildProfiles
    // 时为 undefined ⇒ 聚合退回扫全部服务（保持旧行为）。
    const profilesForBranch = options.getBuildProfiles?.(branch);
    // 空数组视为「拿不到 profile 信息」= 不过滤（undefined），绝不能当成「没有任何在册 profile」
    // 把所有服务都排除掉——否则聚合会无视全部 running 服务、把分支误判 idle（Bugbot Medium
    // 「Empty profiles drop all services」）。executor 模式（filterZombieProfiles=false）本地 profile
    // 注册表不权威，一律不过滤（Codex P2）。只有非空 profile 列表 + 允许过滤才做僵尸服务过滤。
    const activeProfileIds = (options.filterZombieProfiles ?? true) && profilesForBranch && profilesForBranch.length > 0
      ? new Set(profilesForBranch.map((p) => p.id))
      : undefined;

    // 分支是否有**存活**的 per-service 跟踪（按 activeProfileIds 过滤掉僵尸服务）。有存活服务 ⇒
    // 分支聚合状态以服务真实状态为准；**无存活服务**（只剩已删/改名 profile 的僵尸条目）⇒ 退回
    // 分支级时间戳证据/硬超时收敛——否则一个「在创建任何当前 profile 服务前就崩掉」的部署会被
    // 聚合把僵尸过滤光后误判成 idle、藏掉 error（Codex P2「Use live services before skipping branch
    // timeout」）。activeProfileIds 缺省（不过滤）时退回「有无任何服务」。
    const liveServiceIds = Object.keys(branch.services || {})
      .filter((id) => !activeProfileIds || activeProfileIds.has(id));
    const hasServices = liveServiceIds.length > 0;

    // ── TYPE 2 分支级：卡死非终结 branch.status 收敛（仅无 per-service 跟踪时作兜底）──
    // Bugbot Medium「Branch running with stopped services」：分支级时间戳证据**不看服务状态**，
    // 会在「服务已全 stopped 但分支 stop 元数据没落戳」时把 branch 误留在 running。故有服务时
    // 一律跳过本时间戳分支决策，改由下方「服务级收敛 + 聚合重算」从服务真相推导分支状态。
    const branchDecision = hasServices ? null : decideBranchFinalization(branch, nowMs, hardTimeoutMs, allowHardTimeout);
    if (branchDecision) {
      const previousStatus = branch.status;
      branch.status = branchDecision.nextStatus;
      if (branchDecision.nextStatus === 'error' && !branch.errorMessage) {
        branch.errorMessage = branchDecision.reason;
      }
      mutated = true;
      results.push({
        branchId: branch.id,
        projectId: branch.projectId,
        kind: 'branch-status-finalized',
        previousStatus,
        nextStatus: branchDecision.nextStatus,
        via: branchDecision.via,
        ageMin: branchDecision.ageMin,
        reason: branchDecision.reason,
      });
      // 注意（Bugbot review）：状态机收敛**不**写 type:'build' 的 OperationLog。
      // OperationLog.status 只有 running/completed/error，前端把 'completed' 的 build 日志
      // 渲染成「绿色成功部署」，看门狗的状态清理会被误显成一次成功部署，污染部署历史
      // （而本 PR 的目标恰是让部署历史更准）。收敛只记到 server-event-log（系统日志）做审计，
      // 与服务级收敛保持一致（服务级本就只 recordEvent、不 appendLog）。
      recordEvent(options.serverEventLogStore, branch, source, 'branch.stuck-state.finalized', branchDecision.reason, {
        previousStatus,
        nextStatus: branchDecision.nextStatus,
        via: branchDecision.via,
        ageMin: branchDecision.ageMin,
        lastDeployStartedAt: branch.lastDeployStartedAt || null,
        lastReadyAt: branch.lastReadyAt || null,
        lastStoppedAt: branch.lastStoppedAt || null,
      });
    }

    // ── TYPE 2 服务级：卡死非终结 service.status 收敛 ──
    // 分支级 lastReadyAt 只在「单服务」时能无歧义地代表「该服务已就绪」。多服务时 deploy-finalize
    // 可能在**首个**服务 running 时就盖了 branch.lastReadyAt，此刻其余服务可能仍在真实 starting，
    // 用 branch.lastReadyAt 作每服务就绪证据会过早把仍在起的服务翻成 running（Bugbot Medium
    // 「Branch ready stamp per service」）。故「starting→running」证据路径仅单服务时启用；多服务
    // 的卡死服务交给硬超时（master）或保持现状（真正起来的服务其 status 本就是 running）。
    const singleService = liveServiceIds.length === 1;
    const liveServiceIdSet = new Set(liveServiceIds);
    for (const [profileId, svc] of Object.entries(branch.services || {})) {
      if (!svc || !NON_TERMINAL_STATES.has(svc.status)) continue;
      // 僵尸服务（已删/改名 profile 的残留条目）不参与服务级收敛：否则单服务证据路径会把一个
      // 卡在 starting 的僵尸条目按 branch.lastReadyAt 误翻成 running/stopped，在 UI 与快照里留下
      // 误导性的 per-service 状态（聚合虽已忽略它算分支状态，但条目本身被改脏）（Bugbot Medium
      // 「Zombie services mis-reconciled as running」）。activeProfileIds 缺省（不过滤）时不跳过。
      if (!liveServiceIdSet.has(profileId)) continue;
      const previousStatus = svc.status;
      const readyMs = parseTime(branch.lastReadyAt);
      const startMs = parseTime(branch.lastDeployStartedAt);
      const stoppedMs = parseTime(branch.lastStoppedAt);

      let nextStatus: typeof svc.status | null = null;
      let via: 'timestamp-evidence' | 'hard-timeout' | null = null;
      let reason = '';
      let ageMin = 0;

      // stopping + lastStoppedAt 落戳且晚于停止触发 ⇒ 终结为 stopped。
      if (svc.status === 'stopping' && stoppedMs > 0 && Math.max(startMs, readyMs) > 0 && stoppedMs >= Math.max(startMs, readyMs)) {
        nextStatus = 'stopped';
        via = 'timestamp-evidence';
        ageMin = Math.floor((nowMs - stoppedMs) / 60_000);
        reason = `状态机看门狗：服务 ${profileId} stopping 已完成（lastStoppedAt 已落戳），收敛为 stopped`;
      } else if (
        singleService
        && (svc.status === 'starting' || svc.status === 'building' || svc.status === 'restarting')
        && startMs > 0 && readyMs >= startMs
      ) {
        // 起来过 ⇒ running（除非随后被停，则 stopped）。仅单服务：branch.lastReadyAt 无歧义指向它。
        const stopped = stoppedMs >= readyMs;
        nextStatus = stopped ? 'stopped' : 'running';
        via = 'timestamp-evidence';
        ageMin = startMs > 0 ? Math.floor((nowMs - startMs) / 60_000) : 0;
        reason = `状态机看门狗：服务 ${profileId} ${previousStatus} 实际已就绪，状态陈旧，收敛为 ${nextStatus}`;
      } else {
        // 硬超时兜底：锚点只用本轮启动戳；**stopping 排除**（无停止起点锚点，避免把仍在
        // 进行的正常停止误判超时标成 stopped —— Bugbot High / Codex P2，同分支级）。
        // stopping 只走上面的证据路径（lastStoppedAt）；无证据则不触碰。
        // allowHardTimeout=false（executor 节点无法判活）时禁用硬超时，只走证据路径（Bugbot High）。
        if (allowHardTimeout && svc.status !== 'stopping' && startMs > 0 && nowMs - startMs >= hardTimeoutMs) {
          nextStatus = 'error';
          via = 'hard-timeout';
          ageMin = Math.floor((nowMs - startMs) / 60_000);
          reason = `状态机看门狗：服务 ${profileId} ${previousStatus} 超过 ${Math.floor(hardTimeoutMs / 60_000)} 分钟未终结（已持续 ${ageMin} 分钟），已收敛为 error`;
        }
      }

      if (!nextStatus || !via) continue;
      svc.status = nextStatus;
      if (nextStatus === 'error' && !svc.errorMessage) svc.errorMessage = reason;
      mutated = true;
      results.push({
        branchId: branch.id,
        projectId: branch.projectId,
        kind: 'service-status-finalized',
        profileId,
        previousStatus,
        nextStatus,
        via,
        ageMin,
        reason,
      });
      recordEvent(options.serverEventLogStore, branch, source, 'branch.stuck-state.service-finalized', reason, {
        profileId,
        previousStatus,
        nextStatus,
        via,
        ageMin,
      });
    }

    // 有 per-service 跟踪 ⇒ 分支聚合 status/errorMessage 永远以服务真实状态为准重算。
    // 覆盖两类病：①服务级刚收敛成 error 但 branch 仍 running（Codex P2）；②服务早已全 stopped
    // 但分支 stop 元数据没落戳、branch 卡在 running（Bugbot Medium「Branch running with stopped
    // services」）。重算无变化时是纯读 no-op，不产生 result/事件。
    if (hasServices) {
      const agg = recomputeBranchAggregateFromServices(branch, activeProfileIds);
      if (agg.changed) {
        mutated = true; // 即便本轮没动任何 service（服务早已全 stopped），聚合改了 branch 也要发事件
        results.push({
          branchId: branch.id,
          projectId: branch.projectId,
          kind: 'branch-status-finalized',
          previousStatus: agg.previousStatus,
          nextStatus: agg.nextStatus,
          via: 'timestamp-evidence', // 由服务真实状态推导（per-service 即时间戳证据的聚合）
          reason: `状态机看门狗：按服务真实状态重算分支聚合 ${agg.previousStatus} → ${agg.nextStatus}`,
        });
        recordEvent(
          options.serverEventLogStore,
          branch,
          source,
          'branch.stuck-state.aggregate-recomputed',
          `服务级收敛后重算分支聚合：${agg.previousStatus} → ${agg.nextStatus}`,
          { previousStatus: agg.previousStatus, nextStatus: agg.nextStatus },
        );
      }
    }

    // ── TYPE 1：极速版镜像落后 HEAD 告警（只告警，不自动部署） ──
    const profiles = options.getBuildProfiles?.(branch);
    const isPrebuilt = profiles ? branchUsesPrebuiltMode(profiles, branch) : false;
    if (
      isPrebuilt
      && branch.ciImageStatus === 'ready'
      && branch.ciTargetSha
      && branch.githubCommitSha
      && branch.ciTargetSha !== branch.githubCommitSha
      && options.diffRuntimePaths
    ) {
      const hasRuntimeDiff = options.diffRuntimePaths(branch);
      if (hasRuntimeDiff) {
        const targetShort = branch.ciTargetSha.slice(0, 7);
        const headShort = branch.githubCommitSha.slice(0, 7);
        const reason = `极速版镜像落后 HEAD：sha-${targetShort} 已部署，但 HEAD ${headShort} 含未部署的代码改动（CI 认领可能漏处理）`;
        // 幂等：同一 target..head 组合不重复落同样的 ciImageError。
        if (branch.ciImageError !== reason) {
          branch.ciImageError = reason;
          mutated = true;
          results.push({
            branchId: branch.id,
            projectId: branch.projectId,
            kind: 'express-head-divergence',
            via: 'alarm',
            reason,
          });
          options.appendLog?.(branch.id, {
            type: 'build',
            startedAt: branch.lastPushAt || now.toISOString(),
            finishedAt: now.toISOString(),
            status: 'error',
            events: [{
              step: 'express-head-divergence',
              status: 'warning',
              title: '极速版镜像落后 HEAD',
              log: reason,
              detail: {
                ciTargetSha: branch.ciTargetSha,
                githubCommitSha: branch.githubCommitSha,
                source,
              },
              timestamp: now.toISOString(),
            }],
          });
          recordEvent(options.serverEventLogStore, branch, source, 'branch.express-image.head-divergence', reason, {
            ciTargetSha: branch.ciTargetSha,
            githubCommitSha: branch.githubCommitSha,
          });
        }
      }
    }

    if (mutated) options.emitBranchUpdated?.(branch);
  }

  return results;
}
