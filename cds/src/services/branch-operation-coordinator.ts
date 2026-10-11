import { randomUUID } from 'node:crypto';
import type { PendingDeployJournal } from './pending-deploy-journal.js';
import type { PendingDeployDispatchResult } from './pending-deploy-dispatch.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

export type BranchOperationKind =
  | 'deploy'
  | 'deploy-profile'
  | 'database-init'
  | 'restart'
  | 'force-rebuild'
  | 'stop'
  | 'reset'
  | 'delete'
  | 'cleanup-damaged'
  | 'cleanup-stopped'
  | 'cleanup-orphans'
  | 'factory-reset'
  | 'scheduler-cooling'
  | 'auto-lifecycle-redeploy'
  | 'auto-restart'
  | 'janitor-remove'
  | 'candidate-reconcile'
  | 'acceptance-release'
  | 'acceptance-create';

export type BranchOperationTrigger = 'manual' | 'webhook' | 'auto-lifecycle' | 'scheduler' | 'janitor' | 'system';

export interface BranchOperationRequest {
  branchId: string;
  projectId?: string | null;
  profileId?: string | null;
  kind: BranchOperationKind;
  trigger: BranchOperationTrigger;
  actor?: string | null;
  requestId?: string | null;
  commitSha?: string | null;
  /**
   * 不可变部署版本重部署时携带（body.versionId）。带版本的 manual deploy
   * **不参与**合并去重：pending 重放只送 commitSha，会丢失版本捕获的
   * profiles/config（Codex P2「Preserve requested versions in merged deploys」），
   * 维持撞车 409 的旧行为。
   */
  versionId?: string | null;
  /**
   * 请求携带一次性选项时为 true（?force=1 绕过项目暂停 / ?ignoreRequired=1
   * 跳过必填 env 检查 / body.targetExecutorId 显式指定执行器）。pending 重放
   * 只送 commitSha，这些选项会丢失——强制部署会在重放时被暂停闸门拦下、
   * env 豁免失效、执行器指定被自动选择覆盖，用户却已被告知「已排队」。
   * 故带一次性选项的 manual deploy 不参与合并去重，维持撞车 409
   * （Codex P2「Reject manual deploy merges with one-shot options」）。
   */
  hasOneShotOptions?: boolean;
  /**
   * commitSha 是不是请求自己钉住的（webhook 的 head sha / 显式 `--commit`），
   * 而不是拿分支上缓存的 `githubCommitSha` 兜底来的。
   *
   * 没钉住的部署最终落地的是「执行到 pull 那一刻的分支 HEAD」，不是这个缓存值：
   * 远端已经前进到 B 而缓存还停在 A 时，拿 A 去判「同一个 commit」会把一次
   * 「要部署 B」的请求并进「正在部署 A」，B 就此不再被部署，调用方还收到「已受理」。
   * 所以并入要求两边都钉住了提交（Codex PR #1516 六轮 P1）。
   */
  commitPinned?: boolean;
  /**
   * 本次部署将要落地的有效配置指纹（有效 profiles + 合并后的 env）。
   * 只用于「同 commit 并入在途部署」的判定：同一个 commit 也可能因为中间改了
   * 项目/分支环境变量或构建配置而要落不同的东西，仅比 commitSha 会把这次真实的
   * 配置变更悄悄吞掉——既不生效也不排队（Codex PR #1516 四轮 P1）。
   */
  configHash?: string | null;
  /** SHA-neutral effective configuration frozen for queued replay admission. */
  pendingConfigHash?: string | null;
  source?: string | null;
  reason?: string | null;
  continueWith?: 'deploy' | 'deploy-profile' | null;
  /** Internal reconciliation is scoped to a terminal unresolved journal, never a new deployment. */
  reconcileRunId?: string;
  /** Internal whole-branch release; ownership authorization belongs to its caller. */
  acceptanceRunId?: string;
  /** Only a current internal pending dispatch can redeem this one-use token. */
  pendingOperationId?: string;
  pendingGeneration?: number;
}

export interface BranchOperationLease {
  operationId: string;
  branchId: string;
  generation: number;
  request: BranchOperationRequest;
  startedAt: string;
  /** Aborted when this operation is explicitly cancelled or superseded. */
  signal?: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(step?: string): void;
}

export interface BranchOperationDecision {
  /**
   * `joined`（2026-09-08 宿主过载复盘）：来的部署与在途部署是**同一个 commit**，
   * 直接并入在途操作——不新开、不排 pending、更不取代。此前 cdscli「push 后立刻
   * 手动 deploy」会让 manual deploy 压掉 2 秒前 webhook 刚起的同 sha 部署，同一
   * 批容器被拆两遍（线上一条分支 90 分钟里连着来了 10 次）。
   */
  status: 'started' | 'merged' | 'joined' | 'rejected';
  operationId: string;
  generation: number;
  reason?: string;
  activeOperationId?: string;
  activeKind?: BranchOperationKind;
  pendingCommitSha?: string | null;
  lease?: BranchOperationLease;
  /** A merged acceptance must not be sent before this durable write acknowledges. */
  persistence?: Promise<void>;
}

export interface ActiveOperation {
  operationId: string;
  branchId: string;
  generation: number;
  request: BranchOperationRequest;
  startedAt: string;
  cancelled: boolean;
  cancelReason?: string;
}

interface ReservedContinuation {
  operationId: string;
  branchId: string;
  generation: number;
  request: BranchOperationRequest;
  reservedAt: string;
  expiresAt: number;
  continueWith: 'deploy' | 'deploy-profile';
}

export interface PendingWebhookDeploy {
  operationId: string;
  branchId: string;
  generation: number;
  request: BranchOperationRequest;
  mergedCount: number;
  updatedAt: string;
}

export class BranchOperationSupersededError extends Error {
  constructor(
    readonly operationId: string,
    readonly branchId: string,
    step?: string,
  ) {
    super(`Branch operation ${operationId} for ${branchId} is no longer current${step ? ` at ${step}` : ''}`);
    this.name = 'BranchOperationSupersededError';
  }
}

const TERMINAL_KINDS = new Set<BranchOperationKind>([
  'delete',
  'reset',
  'cleanup-orphans',
  'factory-reset',
  'janitor-remove',
]);

function priorityOf(req: BranchOperationRequest): number {
  if (req.trigger === 'manual' && TERMINAL_KINDS.has(req.kind)) return 100;
  if (req.trigger === 'manual' && req.kind === 'stop') return 95;
  if (req.trigger === 'webhook' && req.kind === 'delete') return 90;
  if (req.trigger === 'webhook' && req.kind === 'stop') return 70;
  if (req.trigger === 'manual' && (req.kind === 'force-rebuild' || req.kind === 'deploy' || req.kind === 'deploy-profile' || req.kind === 'restart')) return 80;
  if (req.kind === 'cleanup-damaged') return 45;
  if (req.trigger === 'webhook' && (req.kind === 'deploy' || req.kind === 'deploy-profile')) return 50;
  if (req.trigger === 'auto-lifecycle') return 40;
  if (req.kind === 'auto-restart') return 35;
  if (req.trigger === 'scheduler') return 30;
  if (req.trigger === 'janitor') return 25;
  return 10;
}

function isWebhookDeploy(req: BranchOperationRequest): boolean {
  return req.trigger === 'webhook' && (req.kind === 'deploy' || req.kind === 'deploy-profile');
}

/**
 * 两个 commitSha 指的是不是同一个提交。
 *
 * 判据是「都是 40 位全长 SHA 且完全相等」，短 SHA 一律判不同。
 *
 * 六轮 review 先要求把短 SHA 归一（`--commit abc1234` 和 webhook 的 40 位全长
 * 本可能是同一提交，直判不等会让手动部署顶掉在途 webhook 重建同一份代码），
 * 七轮又指出前缀匹配自身有歧义：两个提交共享同一个 7 位前缀时，这里会把请求
 * 并进「碰巧前缀相同」的那次部署并回报已受理——那等于部署了不是你要的代码，
 * 与不带 commit 时把 B 并进 A 是同一类静默事故。
 *
 * 两轮之间来回的是同一个自由文本解析器，按 AGENTS.md §5.5 的熔断纪律不再加
 * 语义，改回**有限、无歧义**的判据：只认全长相等。代价是短 SHA 的手动部署不
 * 参与并入（少省一次重复拆装，结果仍正确）；要吃到并入收益就传完整 40 位
 * ——webhook 天然是全长。这条边界记在 `doc/debt.cds.performance.md`。
 */
export function sameCommitIdentity(a?: string | null, b?: string | null): boolean {
  const x = (a || '').trim().toLowerCase();
  const y = (b || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(x) || !/^[0-9a-f]{40}$/.test(y)) return false;
  return x === y;
}

/**
 * 「同一个 commit 的整分支部署已经在跑」判定（2026-09-08）。
 * 只认同项目/分支/服务范围，双方实际钉住同一完整提交及配置，在途未被取消。
 * 带版本 / 一次性选项的 manual deploy 语义不同（重放会丢配置），不并入。
 */
function isSameCommitDeployInFlight(incoming: BranchOperationRequest, active: ActiveOperation): boolean {
  if (active.cancelled) return false;
  if (incoming.kind !== active.request.kind || (incoming.kind !== 'deploy' && incoming.kind !== 'deploy-profile')) return false;
  if ((incoming.projectId || null) !== (active.request.projectId || null)) return false;
  if ((incoming.profileId || null) !== (active.request.profileId || null)) return false;
  // 两边都得是「钉住了提交」的请求。没钉住的落地的是届时的分支 HEAD，
  // 手里这个缓存 SHA 说明不了它要部署什么（见 commitPinned 注释）。
  if (!incoming.commitPinned || !active.request.commitPinned) return false;
  if (!sameCommitIdentity(incoming.commitSha, active.request.commitSha)) return false;
  // 在途那次也必须是「普通整分支部署」：带版本 / 一次性选项的部署落的是捕获配置或
  // 强制豁免，与 webhook 要的「当前配置」不是同一件事，并入会让后者悄悄丢失
  // （Codex PR #1516 二轮 P2）。这种情况维持原语义：webhook 合并为 pending 排到其后重放。
  if (active.request.versionId || active.request.hasOneShotOptions || incoming.versionId || incoming.hasOneShotOptions) return false;
  // 同一个 commit 未必落同一份配置：两次部署之间改了项目/分支 env 或构建配置，
  // 有效配置指纹就会变。并入等于用旧配置代替新请求，且不留 pending 重放——
  // 用户改的东西既不生效也不排队。故要求两边指纹都在且相等；缺指纹一律不并入，
  // 回落既有语义（合并为 pending，在其后重放）（Codex 四轮 P1）。
  if (!incoming.configHash || !active.request.configHash) return false;
  if (incoming.configHash !== active.request.configHash) return false;
  if (incoming.trigger === 'webhook') return true;
  return isMergeableManualDeploy(incoming);
}

/**
 * manual 整分支 deploy 也可合并（2026-07-16 队列堵死复盘）：此前 manual deploy
 * 撞上同优先级的在途 manual deploy 只会 409，agent 排队焦虑 → 反复重试 →
 * 同分支部署叠加、每次重试往全局构建队列塞一整层服务（重试风暴正反馈）。
 * 现在与 webhook 同样合并为「当前部署完成后自动执行的最新待部署请求」
 * （last-writer-wins）。整分支保持既有语义；单服务仅在明确完整目标与配置时合并，restart维持拒绝。
 * 带 versionId 的版本重部署不合并（pending 重放会丢版本捕获配置，Codex P2）。
 * 带一次性选项（force/ignoreRequired/targetExecutorId）的请求同理不合并
 * （pending 重放只送 commitSha，选项丢失后重放可能直接失败，Codex P2）。
 * 注意：仅在 incoming **不能**压过（supersede）在途操作时才走合并——优先级
 * 比较在 begin() 里先于本判定执行，manual 压 webhook 的既有语义不变。
 */
function isMergeableManualDeploy(req: BranchOperationRequest): boolean {
  return req.trigger === 'manual' && !req.versionId && !req.hasOneShotOptions && (req.kind === 'deploy'
    || (req.kind === 'deploy-profile' && !!req.profileId && !!req.configHash && req.commitPinned === true && sameCommitIdentity(req.commitSha, req.commitSha)));
}

/**
 * manual deploy 只允许合并在**部署类**在途操作后面（Codex P2「Restrict manual
 * deploy merges to deploy blockers」）：若在途的是 stop/reset/delete 等终止类
 * 操作，合并的 pending 会在 complete() 后立刻派发——运维刚停下的分支被自动
 * 重启，抵消停止意图。此时维持 409 旧行为，让调用方自己决定停后是否再部署。
 */
export const MAX_PENDING_DEPLOY_SCOPES_PER_BRANCH = 64;
export const MAX_PENDING_DEPLOY_SCOPES = 512;

const MANUAL_MERGE_BEHIND_KINDS = new Set<BranchOperationKind>([
  'deploy',
  'deploy-profile',
  'force-rebuild',
  'restart',
  'auto-restart',
  'auto-lifecycle-redeploy',
  'database-init',
]);

function nowIso(): string {
  return new Date().toISOString();
}

export class BranchOperationCoordinator {
  private readonly cancellation = new Map<string, AbortController>();
  private readonly active = new Map<string, ActiveOperation>();
  private readonly pendingWebhookDeploys = new Map<string, PendingWebhookDeploy>();
  private readonly reservedContinuations = new Map<string, ReservedContinuation>();
  private generations = new Map<string, number>();
  private readonly pendingDispatches = new Map<string, { pending: PendingWebhookDeploy; phase: 'claiming' | 'ready' | 'sent' | 'accepted' }>();
  // Revocation removes route ownership, not the executor's outstanding awaits.
  private readonly unsettled = new Map<string, { lease: BranchOperationLease; branchId: string }>();

  constructor(private readonly events?: ServerEventLogSink | null,
    private readonly admitStart?: (request: BranchOperationRequest) => string | null,
    private readonly journal?: PendingDeployJournal,
    private readonly admitRequest?: (request: BranchOperationRequest) => string | null) {}

  begin(request: BranchOperationRequest): BranchOperationDecision {
    request = { ...request };
    const branchId = request.branchId;
    // Persisted ownership must be checked before join/merge, token redemption or priority cancellation.
    if (this.admitRequest) {
      let reason: string | null;
      try { reason = this.admitRequest(request); } catch { reason = 'branch_operation_admission_unavailable'; }
      if (reason) return this.pendingRejection(request, reason);
    }
    // Release cannot overtake an executor or an already accepted deployment. Revocation
    // alone does not settle outstanding awaits, so active-map ownership is insufficient.
    const executions = [...this.unsettled.values()].filter(execution => execution.branchId === branchId);
    if (request.kind === 'acceptance-release' || request.kind === 'acceptance-create') {
      const prefix = request.kind === 'acceptance-create' ? 'acceptance_creation' : 'acceptance_release';
      const source = request.kind === 'acceptance-create' ? 'acceptance-resource-create' : 'acceptance-resource-release';
      const valid = (request.trigger === 'system' || request.trigger === 'manual')
        && request.source === source && request.profileId == null
        && typeof request.projectId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(request.projectId)
        && typeof branchId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(branchId)
        && typeof request.acceptanceRunId === 'string' && /^ar_[a-f0-9]{32}$/.test(request.acceptanceRunId)
        && typeof request.commitSha === 'string' && /^[a-f0-9]{40}$/.test(request.commitSha);
      if (!valid) return this.pendingRejection(request, prefix + '_scope');
      if (executions.length) return this.pendingRejection(request, prefix + '_unsettled');
      const journal = this.journal?.snapshot();
      const pending = [...this.pendingWebhookDeploys.values(), ...[...this.pendingDispatches.values()].map(item => item.pending),
        ...(journal?.queued || []), ...(journal?.claims.map(claim => claim.pending) || [])];
      const reserved = [...this.reservedContinuations.values()].some(item => item.branchId === branchId && item.expiresAt >= Date.now());
      if (pending.some(item => item.branchId === branchId) || reserved) return this.pendingRejection(request, prefix + '_busy');
    } else if (executions.some(execution => ['acceptance-release', 'acceptance-create'].includes(execution.lease.request.kind))) {
      return this.pendingRejection(request, executions.some(execution => execution.lease.request.kind === 'acceptance-create')
        ? 'acceptance_creation_unsettled' : 'acceptance_release_unsettled');
    }
    const pendingToken = request.pendingOperationId != null || request.pendingGeneration != null;
    if (pendingToken) {
      const dispatch = this.pendingDispatches.get(this.pendingKey(request));
      const original = dispatch?.pending;
      const unpinnedWhole = original?.request.kind === 'deploy' && original.request.trigger === 'manual' && original.request.commitPinned !== true;
      const matches = original && dispatch.phase === 'sent' && original.operationId === request.pendingOperationId
        && original.generation === request.pendingGeneration && original.request.trigger === request.trigger
        && original.request.kind === request.kind
        && (!original.request.pendingConfigHash || original.request.pendingConfigHash === request.pendingConfigHash)
        && (original.request.commitPinned !== true || request.commitPinned === true)
        && (unpinnedWhole || !original.request.configHash || original.request.configHash === request.configHash)
        && (unpinnedWhole ? request.commitPinned !== true : (original.request.commitSha || null) === (request.commitSha || null));
      if (!matches) return this.pendingRejection(request, 'pending_dispatch_stale');
      dispatch.phase = 'accepted';
    }
    const durableBlock = this.journal?.blockReason(request);
    if (durableBlock) return this.pendingRejection(request, durableBlock);
    if (request.kind === 'candidate-reconcile') {
      const valid = request.trigger === 'system' && request.source === 'candidate-reconciler' && !request.profileId &&
        typeof request.reconcileRunId === 'string' && /^dr_[a-zA-Z0-9_.-]+$/.test(request.reconcileRunId);
      const busy = [...this.unsettled.values()].some(execution => execution.branchId === branchId);
      if (!valid || busy) {
        const operationId = this.createOperationId(); const generation = this.currentGeneration(branchId);
        const reason = valid ? 'candidate_executor_unsettled: original branch executor has not completed' : 'candidate_reconciliation_scope: internal whole-run scope required';
        this.record('branch.operation.rejected', request, operationId, generation, 'warn', { reason });
        return { status: 'rejected', operationId, generation, reason };
      }
    }
    const active = this.findBlockingActive(request);
    if (!active) {
      const rejection = this.admissionRejection(request);
      if (rejection) return rejection;
      const reserved = this.getUsableReservedContinuation(branchId, request);
      if (reserved) return this.beginAgainstReservedContinuation(request, reserved);
      return this.start(request);
    }

    if (isSameCommitDeployInFlight(request, active)) {
      this.record('branch.operation.joined', request, active.operationId, active.generation, 'info', {
        activeOperationId: active.operationId,
        activeKind: active.request.kind,
        activeTrigger: active.request.trigger,
        commitSha: request.commitSha || null,
      });
      return {
        status: 'joined',
        operationId: active.operationId,
        generation: active.generation,
        activeOperationId: active.operationId,
        activeKind: active.request.kind,
        pendingCommitSha: null,
        reason: 'same commit already deploying; joined the in-flight operation',
      };
    }

    if (isWebhookDeploy(request)) {
      return this.mergePending(request, active);
    }

    const incomingPriority = priorityOf(request);
    const activePriority = priorityOf(active.request);
    if (incomingPriority > activePriority) {
      // Admission must precede revocation: a rejected replacement leaves the current lease intact.
      const rejection = this.admissionRejection(request);
      if (rejection) return rejection;
      for (const item of this.findBlockingActives(request)) {
        item.cancelled = true;
        item.cancelReason = `superseded by ${request.kind}`;
        this.cancellation.get(item.operationId)?.abort(item.cancelReason);
        this.cancellation.delete(item.operationId);
        this.record('branch.operation.cancelled', item.request, item.operationId, item.generation, 'warn', {
          reason: item.cancelReason,
          supersededBy: request.kind,
          supersededByTrigger: request.trigger,
        });
      }
      if (TERMINAL_KINDS.has(request.kind) || request.kind === 'stop') {
        this.cancelPendingWebhookDeploy(branchId, `superseded by ${request.kind}`);
        this.cancelReservedContinuations(request, `superseded by ${request.kind}`);
      }
      return this.start(request);
    }

    // manual 整分支 deploy 压不过在途操作时不再 409，而是与 webhook 同通道
    // 合并为最新待部署请求（治重试风暴：agent 重试不再叠加新部署/新排队）。
    // 仅限部署类在途操作（stop/reset/delete 在途时维持 409，见
    // MANUAL_MERGE_BEHIND_KINDS 注释）。
    if (isMergeableManualDeploy(request) && MANUAL_MERGE_BEHIND_KINDS.has(active.request.kind)) {
      return this.mergePending(request, active);
    }

    this.record('branch.operation.rejected', request, this.createOperationId(), this.currentGeneration(branchId), 'warn', {
      activeOperationId: active.operationId,
      activeKind: active.request.kind,
      activeTrigger: active.request.trigger,
      reason: 'branch operation already running',
    });
    return {
      status: 'rejected',
      operationId: active.operationId,
      generation: active.generation,
      activeOperationId: active.operationId,
      activeKind: active.request.kind,
      reason: 'branch operation already running',
    };
  }

  complete(lease: BranchOperationLease, status: 'completed' | 'failed' | 'cancelled', error?: string): PendingWebhookDeploy | null {
    const execution = this.unsettled.get(lease.operationId);
    if (!execution || execution.lease !== lease) return null;
    this.unsettled.delete(lease.operationId);
    const activeEntry = this.findActiveEntryByOperation(lease.operationId);
    const active = activeEntry?.active;
    if (activeEntry && active?.operationId === lease.operationId && active.generation === lease.generation && active.branchId === execution.branchId) {
      this.active.delete(activeEntry.key);
    }
    if (status !== 'completed') this.cancellation.get(lease.operationId)?.abort(error || status);
    this.cancellation.delete(lease.operationId);
    this.record(`branch.operation.${status}`, lease.request, lease.operationId, lease.generation, status === 'failed' ? 'error' : status === 'cancelled' ? 'warn' : 'info', {
      error: error || null,
      cancelled: active?.cancelled || false,
      cancelReason: active?.cancelReason || null,
    });
    if (
      status === 'completed'
      && lease.request.kind === 'force-rebuild'
      && (lease.request.continueWith === 'deploy' || lease.request.continueWith === 'deploy-profile')
    ) {
      this.reserveContinuation(lease, lease.request.continueWith);
      return null;
    }
    for (const [key, pending] of this.pendingWebhookDeploys) {
      if (pending.branchId !== lease.branchId || this.findBlockingActive(pending.request)) continue;
      if (this.getUsableReservedContinuation(pending.branchId, pending.request)) continue;
      // Expiry may cancel this scope while checking reservations.
      if (!this.pendingWebhookDeploys.has(key)) continue;
      this.pendingWebhookDeploys.delete(key);
      this.pendingDispatches.set(key, { pending, phase: 'claiming' });
      return pending;
    }
    return null;
  }

  cancelBranch(branchId: string, reason: string): void {
    const activeEntries = [...this.active.entries()].filter(([, active]) => active.branchId === branchId);
    for (const [key, active] of activeEntries) {
      active.cancelled = true;
      active.cancelReason = reason;
      this.cancellation.get(active.operationId)?.abort(reason);
      this.cancellation.delete(active.operationId);
      this.record('branch.operation.cancelled', active.request, active.operationId, active.generation, 'warn', { reason });
      this.active.delete(key);
    }
    this.cancelPendingWebhookDeploy(branchId, reason);
    this.cancelReservedContinuations({ branchId, kind: 'stop', trigger: 'system' }, reason);
  }

  interruptAll(reason: string, source: string): void {
    for (const active of this.active.values()) {
      this.record('branch.operation.interrupted', active.request, active.operationId, active.generation, 'warn', {
        reason,
        source,
        startedAt: active.startedAt,
        cancelled: active.cancelled,
        cancelReason: active.cancelReason || null,
      });
    }
    for (const pending of this.pendingWebhookDeploys.values()) {
      this.record('branch.operation.interrupted', pending.request, pending.operationId, pending.generation, 'warn', {
        reason,
        source,
        pending: true,
        mergedCount: pending.mergedCount,
        updatedAt: pending.updatedAt,
      });
    }
    for (const reserved of this.reservedContinuations.values()) {
      this.record('branch.operation.interrupted', reserved.request, reserved.operationId, reserved.generation, 'warn', {
        reason,
        source,
        reserved: true,
        reservedAt: reserved.reservedAt,
        continueWith: reserved.continueWith,
      });
    }
  }

  isCurrent(branchId: string, operationId: string, generation: number): boolean {
    const active = [...this.active.values()].find((item) => item.branchId === branchId && item.operationId === operationId);
    return Boolean(active && active.operationId === operationId && active.generation === generation && !active.cancelled);
  }

  getActive(branchId: string, profileId?: string | null): ActiveOperation | undefined {
    if (profileId) {
      return this.active.get(this.profileKey(branchId, profileId));
    }
    return [...this.active.values()].find((active) => active.branchId === branchId);
  }

  getActiveOperations(branchId?: string): ActiveOperation[] {
    const active = [...this.active.values()];
    return branchId ? active.filter((item) => item.branchId === branchId) : active;
  }

  getPendingWebhookDeploy(branchId: string): PendingWebhookDeploy | undefined {
    return [...this.pendingWebhookDeploys.values()].find(pending => pending.branchId === branchId)
      || this.journal?.queued().find(pending => pending.branchId === branchId);
  }

  getPendingDeploymentStatus(projectId: string, branchId: string) {
    return this.journal?.getStatus(projectId, branchId) || {
      availability: 'not-configured' as const, recoveryRequired: false,
      total: 0, truncated: false, entries: [],
    };
  }

  async claimPending(pending: PendingWebhookDeploy): Promise<boolean> {
    const key = this.pendingKey(pending.request); const dispatch = this.pendingDispatches.get(key);
    if (!dispatch || dispatch.pending !== pending || dispatch.phase !== 'claiming') return false;
    const claimed = this.journal ? await this.journal.claim(pending) : true;
    if (!claimed || this.pendingDispatches.get(key) !== dispatch) return false;
    dispatch.phase = 'ready'; return true;
  }

  markPendingSent(pending: PendingWebhookDeploy): boolean {
    const dispatch = this.pendingDispatches.get(this.pendingKey(pending.request));
    if (!dispatch || dispatch.pending !== pending || dispatch.phase !== 'ready') return false;
    dispatch.phase = 'sent'; return true;
  }

  async settlePending(pending: PendingWebhookDeploy, result: PendingDeployDispatchResult): Promise<void> {
    await this.journal?.settle(pending, result);
    const key = this.pendingKey(pending.request);
    if (this.pendingDispatches.get(key)?.pending === pending) this.pendingDispatches.delete(key);
  }

  async discardPending(pending: PendingWebhookDeploy): Promise<void> {
    const key = this.pendingKey(pending.request);
    const dispatch = this.pendingDispatches.get(key);
    if (!dispatch || dispatch.pending !== pending || dispatch.phase === 'sent' || dispatch.phase === 'accepted') return;
    await this.journal?.cancel(pending);
    if (this.pendingDispatches.get(key) === dispatch) this.pendingDispatches.delete(key);
  }

  private pendingRejection(request: BranchOperationRequest, reason: string): BranchOperationDecision {
    const operationId = this.createOperationId(); const generation = this.currentGeneration(request.branchId);
    this.record('branch.operation.rejected', request, operationId, generation, 'warn', { reason });
    return { status: 'rejected', operationId, generation, reason };
  }

  clearForTest(): void {
    for (const controller of this.cancellation.values()) controller.abort('test cleanup');
    this.cancellation.clear();
    this.active.clear();
    this.pendingWebhookDeploys.clear();
    this.pendingDispatches.clear();
    this.reservedContinuations.clear();
    this.generations.clear();
    this.unsettled.clear();
  }

  private admissionRejection(request: BranchOperationRequest): BranchOperationDecision | null {
    let reason: string | null = null;
    try { reason = this.admitStart?.(request) || null; } catch { reason = 'branch_operation_admission_unavailable'; }
    if (!reason) return null;
    const operationId = this.createOperationId(); const generation = this.currentGeneration(request.branchId);
    this.record('branch.operation.rejected', request, operationId, generation, 'warn', { reason });
    return { status: 'rejected', operationId, generation, reason };
  }

  private start(request: BranchOperationRequest, existing?: { operationId: string; generation?: number; continuedFrom?: BranchOperationRequest }): BranchOperationDecision {
    const branchId = request.branchId;
    // A newer writer invalidates late replay tokens before any external action.
    for (const [pendingKey, dispatch] of this.pendingDispatches) {
      if (!this.operationsConflict(request, dispatch.pending.request)
          || (request.pendingOperationId === dispatch.pending.operationId && request.pendingGeneration === dispatch.pending.generation)) continue;
      this.pendingDispatches.delete(pendingKey);
      void this.journal?.cancel(dispatch.pending, dispatch.phase === 'sent' || dispatch.phase === 'accepted').catch(() => {});
    }
    const key = this.operationKey(request);
    const generation = existing?.generation ?? this.nextGeneration(branchId);
    const operationId = existing?.operationId ?? this.createOperationId();
    const active: ActiveOperation = {
      operationId,
      branchId,
      generation,
      request,
      startedAt: nowIso(),
      cancelled: false,
    };
    this.active.set(key, active);
    const cancellation = new AbortController();
    this.cancellation.set(operationId, cancellation);
    const lease: BranchOperationLease = {
      operationId,
      branchId,
      generation,
      request,
      startedAt: active.startedAt,
      signal: cancellation.signal,
      isCurrent: () => this.isCurrent(branchId, operationId, generation),
      assertCurrent: (step?: string) => {
        if (!this.isCurrent(branchId, operationId, generation)) {
          throw new BranchOperationSupersededError(operationId, branchId, step);
        }
      },
    };
    this.unsettled.set(operationId, { lease, branchId });
    this.record('branch.operation.started', request, operationId, generation, 'info', {
      continuedFromKind: existing?.continuedFrom?.kind || null,
      continuedFromSource: existing?.continuedFrom?.source || null,
    });
    return { status: 'started', operationId, generation, lease };
  }

  private beginAgainstReservedContinuation(
    request: BranchOperationRequest,
    reserved: ReservedContinuation,
  ): BranchOperationDecision {
    if (isWebhookDeploy(request)) {
      return this.mergePending(request, reserved, true);
    }

    if (this.requestMatchesContinuation(request, reserved)) {
      this.reservedContinuations.delete(this.pendingKey(reserved.request));
      const generation = this.nextGeneration(request.branchId);
      this.record('branch.operation.continued', request, reserved.operationId, generation, 'info', {
        reservedAt: reserved.reservedAt,
        continueWith: reserved.continueWith,
        previousGeneration: reserved.generation,
      });
      return this.start(request, {
        operationId: reserved.operationId,
        generation,
        continuedFrom: reserved.request,
      });
    }

    const incomingPriority = priorityOf(request);
    const reservedPriority = priorityOf(reserved.request);
    if (incomingPriority > reservedPriority || TERMINAL_KINDS.has(request.kind) || request.kind === 'stop') {
      this.cancelReservedContinuations(request, `reserved continuation superseded by ${request.kind}`);
      if (TERMINAL_KINDS.has(request.kind) || request.kind === 'stop') {
        this.cancelPendingWebhookDeploy(request.branchId, `reserved continuation superseded by ${request.kind}`);
      }
      return this.start(request);
    }

    // manual 整分支 deploy 撞上保留的续约时同样合并为 pending，不再 409：
    // 已合并的 pending 会在其他 profile 操作 complete() 后被内部重放，若此刻
    // 分支上还挂着未消费的 force-rebuild 续约，重放走到这里被拒绝 = 静默丢弃
    // 「已排队」的承诺（Codex P2「Preserve pending deploys while a continuation
    // is reserved」）。必须放在 requestMatchesContinuation 之后——force-rebuild
    // 自己的 deploy 续约仍优先接续执行，不能被合并吞掉。
    if (isMergeableManualDeploy(request)) {
      return this.mergePending(request, reserved, true);
    }

    this.record('branch.operation.rejected', request, this.createOperationId(), this.currentGeneration(request.branchId), 'warn', {
      activeOperationId: reserved.operationId,
      activeKind: reserved.request.kind,
      reservedContinuation: true,
      reason: 'branch is waiting for force-rebuild deploy continuation',
    });
    return {
      status: 'rejected',
      operationId: reserved.operationId,
      generation: reserved.generation,
      activeOperationId: reserved.operationId,
      activeKind: reserved.request.kind,
      reason: 'branch is waiting for force-rebuild deploy continuation',
    };
  }

  private requestMatchesContinuation(request: BranchOperationRequest, reserved: ReservedContinuation): boolean {
    if (request.branchId !== reserved.branchId || (request.projectId || null) !== (reserved.request.projectId || null)) return false;
    if (request.trigger !== reserved.request.trigger) return false;
    if (reserved.continueWith === 'deploy' && request.kind === 'deploy') return true;
    return reserved.continueWith === 'deploy-profile'
      && request.kind === 'deploy-profile'
      && request.profileId === reserved.request.profileId;
  }

  private reserveContinuation(lease: BranchOperationLease, continueWith: 'deploy' | 'deploy-profile'): void {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    this.reservedContinuations.set(this.pendingKey(lease.request), {
      operationId: lease.operationId,
      branchId: lease.branchId,
      generation: lease.generation,
      request: lease.request,
      reservedAt: nowIso(),
      expiresAt,
      continueWith,
    });
    this.record('branch.operation.queued', lease.request, lease.operationId, lease.generation, 'info', {
      reason: 'force-rebuild cleanup finished; waiting for deploy continuation',
      continueWith,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  private pendingKey(request: BranchOperationRequest): string {
    return JSON.stringify([request.projectId || null, request.branchId, request.profileId || null]);
  }

  private mergePending(request: BranchOperationRequest, blocker: ActiveOperation | ReservedContinuation,
    reservedContinuation = false): BranchOperationDecision {
    const key = this.pendingKey(request);
    const existing = this.pendingWebhookDeploys.get(key);
    const branchCount = [...this.pendingWebhookDeploys.values()].filter(pending => pending.branchId === request.branchId).length;
    // Replacement uses the existing slot, including when the queue is at capacity.
    if (!existing && (branchCount >= MAX_PENDING_DEPLOY_SCOPES_PER_BRANCH || this.pendingWebhookDeploys.size >= MAX_PENDING_DEPLOY_SCOPES)) {
      const operationId = this.createOperationId(); const generation = this.currentGeneration(request.branchId);
      const reason = 'branch_pending_capacity';
      this.record('branch.operation.rejected', request, operationId, generation, 'warn', { reason, activeOperationId: blocker.operationId });
      return { status: 'rejected', operationId, generation, reason, activeOperationId: blocker.operationId, activeKind: blocker.request.kind };
    }
    // Never accept an intent that the replay path cannot represent.
    if (request.versionId || request.hasOneShotOptions) {
      this.record('branch.operation.rejected', request, blocker.operationId, blocker.generation, 'warn', {
        reason: 'pending_options_not_replayable', activeOperationId: blocker.operationId,
      });
      return { status: 'rejected', operationId: blocker.operationId, generation: blocker.generation,
        activeOperationId: blocker.operationId, activeKind: blocker.request.kind, reason: 'pending_options_not_replayable' };
    }
    const generation = this.nextGeneration(request.branchId);
    const operationId = existing?.operationId || this.createOperationId();
    const mergedCount = (existing?.mergedCount || 0) + 1;
    const { pendingOperationId: _token, pendingGeneration: _generation, ...originalRequest } = request;
    const pending = { operationId, branchId: request.branchId, generation,
      request: originalRequest, mergedCount, updatedAt: nowIso() };
    this.pendingWebhookDeploys.set(key, pending);
    const persistence = this.journal?.upsert(pending);
    // Even embedded callers which do not expose a response must observe failed writes.
    void persistence?.catch(() => {
      if (this.pendingWebhookDeploys.get(key) === pending) {
        if (existing) this.pendingWebhookDeploys.set(key, existing); else this.pendingWebhookDeploys.delete(key);
      }
    });
    this.record('branch.operation.merged', request, operationId, generation, 'info', {
      activeOperationId: blocker.operationId, activeKind: blocker.request.kind, mergedCount,
      commitSha: request.commitSha || null,
      ...(reservedContinuation ? { reservedContinuation: true } : {}),
      ...(request.trigger === 'manual' ? { manualMerge: true } : {}),
    });
    return { status: 'merged', operationId, generation, ...(persistence ? { persistence } : {}), activeOperationId: blocker.operationId,
      activeKind: blocker.request.kind, pendingCommitSha: request.commitSha || null,
      reason: `${request.trigger} deploy merged into latest pending operation${reservedContinuation ? ' while force-rebuild waits for its deploy continuation' : ''}` };
  }

  private cancelPendingWebhookDeploy(branchId: string, reason: string, scope?: BranchOperationRequest): void {
    for (const [key, dispatch] of this.pendingDispatches) {
      if (dispatch.pending.branchId !== branchId || (scope && !this.operationsConflict(scope, dispatch.pending.request))) continue;
      this.pendingDispatches.delete(key);
      void this.journal?.cancel(dispatch.pending, dispatch.phase === 'sent' || dispatch.phase === 'accepted').catch(() => {});
    }
    for (const [key, pending] of this.pendingWebhookDeploys) {
      if (pending.branchId !== branchId || (scope && !this.operationsConflict(scope, pending.request))) continue;
      this.pendingWebhookDeploys.delete(key);
      void this.journal?.cancel(pending).catch(() => {});
      this.record('branch.operation.cancelled', pending.request, pending.operationId, pending.generation, 'warn', {
        reason, pending: true, mergedCount: pending.mergedCount, updatedAt: pending.updatedAt,
      });
    }
  }

  private cancelReservedContinuations(request: BranchOperationRequest, reason: string): void {
    for (const [key, reserved] of this.reservedContinuations) {
      if (!this.operationsConflict(request, reserved.request)) continue;
      this.reservedContinuations.delete(key);
      this.record('branch.operation.cancelled', reserved.request, reserved.operationId, reserved.generation, 'warn', { reason, reserved: true });
    }
  }

  private getUsableReservedContinuation(branchId: string, request?: BranchOperationRequest): ReservedContinuation | null {
    const candidates: ReservedContinuation[] = [];
    for (const [key, reserved] of this.reservedContinuations) {
      if (reserved.branchId !== branchId) continue;
      if (Date.now() > reserved.expiresAt) {
        this.reservedContinuations.delete(key);
        this.record('branch.operation.cancelled', reserved.request, reserved.operationId, reserved.generation, 'warn', {
          reason: 'reserved continuation expired', reserved: true,
        });
        this.cancelPendingWebhookDeploy(branchId, 'reserved continuation expired before manual deploy continuation arrived', reserved.request);
      } else if (!request || this.operationsConflict(request, reserved.request)) candidates.push(reserved);
    }
    return (request ? candidates.find(reserved => this.requestMatchesContinuation(request, reserved)) : undefined) || candidates[0] || null;
  }

  private nextGeneration(branchId: string): number {
    const next = (this.generations.get(branchId) || 0) + 1;
    this.generations.set(branchId, next);
    return next;
  }

  private currentGeneration(branchId: string): number {
    return this.generations.get(branchId) || 0;
  }

  private findActiveEntryByOperation(operationId: string): { key: string; active: ActiveOperation } | null {
    for (const [key, active] of this.active.entries()) {
      if (active.operationId === operationId) return { key, active };
    }
    return null;
  }

  private findBlockingActive(request: BranchOperationRequest): ActiveOperation | undefined {
    return this.findBlockingActives(request)[0];
  }

  private findBlockingActives(request: BranchOperationRequest): ActiveOperation[] {
    return [...this.active.values()].filter((active) => this.operationsConflict(request, active.request));
  }

  private operationsConflict(a: BranchOperationRequest, b: BranchOperationRequest): boolean {
    if (a.branchId !== b.branchId) return false;
    if (this.isBranchWide(a) || this.isBranchWide(b)) return true;
    return (a.profileId || null) === (b.profileId || null);
  }

  private operationKey(request: BranchOperationRequest): string {
    return this.isBranchWide(request)
      ? this.branchKey(request.branchId)
      : this.profileKey(request.branchId, request.profileId || '');
  }

  private branchKey(branchId: string): string {
    return `${branchId}::*`;
  }

  private profileKey(branchId: string, profileId: string): string {
    return `${branchId}::${profileId}`;
  }

  private isBranchWide(request: BranchOperationRequest): boolean {
    if (!request.profileId) return true;
    return !(
      request.kind === 'deploy-profile' ||
      request.kind === 'force-rebuild' ||
      request.kind === 'auto-restart'
    );
  }

  private createOperationId(): string {
    return `op_${randomUUID().slice(0, 12)}`;
  }

  private record(
    action: string,
    request: BranchOperationRequest,
    operationId: string,
    generation: number,
    severity: 'info' | 'warn' | 'error',
    details: Record<string, unknown> = {},
  ): void {
    this.events?.record({
      category: 'system',
      severity,
      source: 'branch-operation-coordinator',
      action,
      message: `${action}: ${request.branchId} ${request.kind}`,
      projectId: request.projectId || null,
      branchId: request.branchId,
      profileId: request.profileId || null,
      requestId: request.requestId || null,
      operationId,
      operationKind: request.kind,
      operationTrigger: request.trigger,
      operationActor: request.actor || null,
      operationSource: request.source || null,
      commitSha: request.commitSha || null,
      details: {
        operationId,
        generation,
        kind: request.kind,
        trigger: request.trigger,
        actor: request.actor || null,
        commitSha: request.commitSha || null,
        source: request.source || null,
        reason: request.reason || null,
        priority: priorityOf(request),
        ...details,
      },
    });
  }
}
