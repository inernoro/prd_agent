import { randomUUID } from 'node:crypto';
import type { ServerEventLogSink } from './server-event-log-store.js';
import type { DeploymentInputSnapshot } from './deployment-input.js';

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
  | 'janitor-remove';

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
  source?: string | null;
  reason?: string | null;
  continueWith?: 'deploy' | 'deploy-profile' | null;
  /** 内部派发的原操作身份；重放必须消费协调器发出的同范围、同目标凭据。 */
  pendingReplay?: { operationId: string; generation: number } | null;
}

export interface BranchOperationLease {
  operationId: string;
  branchId: string;
  generation: number;
  request: BranchOperationRequest;
  startedAt: string;
  admissionGeneration?: number;
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
  joinedPending?: boolean;
  cancelledPending?: boolean;
  lease?: BranchOperationLease;
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

/** 内部重放保留原请求的部署范围，服务请求不能扩大成整分支部署。 */
export function pendingDeployRoute(pending: PendingWebhookDeploy): string {
  const branch = `/api/branches/${encodeURIComponent(pending.branchId)}/deploy`;
  return pending.request.kind === 'deploy-profile' && pending.request.profileId
    ? `${branch}/${encodeURIComponent(pending.request.profileId)}`
    : branch;
}

export function pendingDeployBody(pending: PendingWebhookDeploy): Record<string, unknown> {
  return {
    commitSha: pending.request.commitPinned ? pending.request.commitSha || undefined : undefined,
    pendingReplay: { operationId: pending.operationId, generation: pending.generation },
  };
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
 * 「同范围、同完整提交和配置的部署已经在跑」判定（2026-09-08）。
 * 整分支与单服务分别比较，同项目同范围、双方固定完整提交且配置一致、在途未被取消。
 * 带版本 / 一次性选项的 manual deploy 语义不同（重放会丢配置），不并入。
 */
function isSameCommitDeployInFlight(incoming: BranchOperationRequest, active: ActiveOperation): boolean {
  if (active.cancelled) return false;
  if (!['deploy', 'deploy-profile'].includes(incoming.kind) || incoming.kind !== active.request.kind) return false;
  if ((incoming.profileId || null) !== (active.request.profileId || null)
    || (incoming.projectId || null) !== (active.request.projectId || null)) return false;
  // 两边都得是「钉住了提交」的请求。没钉住的落地的是届时的分支 HEAD，
  // 手里这个缓存 SHA 说明不了它要部署什么（见 commitPinned 注释）。
  if (!incoming.commitPinned || !active.request.commitPinned) return false;
  if (!sameCommitIdentity(incoming.commitSha, active.request.commitSha)) return false;
  // 在途那次也必须是「普通整分支部署」：带版本 / 一次性选项的部署落的是捕获配置或
  // 强制豁免，与 webhook 要的「当前配置」不是同一件事，并入会让后者悄悄丢失
  // （Codex PR #1516 二轮 P2）。这种情况维持原语义：webhook 合并为 pending 排到其后重放。
  if (active.request.versionId || active.request.hasOneShotOptions) return false;
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
 * （last-writer-wins）。整分支与单服务各自按范围保存，restart 不参与部署合并。
 * 带 versionId 的版本重部署不合并（pending 重放会丢版本捕获配置，Codex P2）。
 * 带一次性选项（force/ignoreRequired/targetExecutorId）的请求同理不合并
 * （pending 重放只送 commitSha，选项丢失后重放可能直接失败，Codex P2）。
 * 注意：仅在 incoming **不能**压过（supersede）在途操作时才走合并——优先级
 * 比较在 begin() 里先于本判定执行，manual 压 webhook 的既有语义不变。
 */
function isMergeableManualDeploy(req: BranchOperationRequest): boolean {
  return req.trigger === 'manual' && (req.kind === 'deploy' || req.kind === 'deploy-profile') && !req.versionId && !req.hasOneShotOptions;
}

/**
 * manual deploy 只允许合并在**部署类**在途操作后面（Codex P2「Restrict manual
 * deploy merges to deploy blockers」）：若在途的是 stop/reset/delete 等终止类
 * 操作，合并的 pending 会在 complete() 后立刻派发——运维刚停下的分支被自动
 * 重启，抵消停止意图。此时维持 409 旧行为，让调用方自己决定停后是否再部署。
 */
const MANUAL_MERGE_BEHIND_KINDS = new Set<BranchOperationKind>([
  'deploy',
  'deploy-profile',
  'force-rebuild',
  'restart',
  'auto-restart',
  'auto-lifecycle-redeploy',
  'database-init',
]);

function replayIdentity(input: BranchOperationRequest['pendingReplay']): NonNullable<BranchOperationRequest['pendingReplay']> | null {
  if (!input || typeof input !== 'object' || typeof input.operationId !== 'string'
    || input.operationId.length === 0 || input.operationId.length > 64
    || !Number.isSafeInteger(input.generation) || input.generation <= 0) return null;
  return { operationId: input.operationId, generation: input.generation };
}

function nowIso(): string {
  return new Date().toISOString();
}

export class BranchOperationCoordinator {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly pendingWebhookDeploys = new Map<string, PendingWebhookDeploy>();
  private readonly reservedContinuations = new Map<string, ReservedContinuation>();
  private readonly pendingReplayClaims = new Map<string, { pending: PendingWebhookDeploy; expiresAt: number }>();
  private readonly deploymentInputs = new Map<string, DeploymentInputSnapshot>();
  private generations = new Map<string, number>();

  private readonly operationEndListeners = new Set<(operationId: string, generation: number, status: 'cancelled' | 'failed' | 'interrupted') => void>();

  constructor(private readonly events?: ServerEventLogSink | null) {}

  /** 首次受理保留私有输入；并入请求不能改写原目标，代次结束立即释放。 */
  rememberDeploymentInput(operationId: string, generation: number, input: DeploymentInputSnapshot): void {
    const key = this.replayKey({ operationId, generation });
    if (!this.deploymentInputs.has(key)) this.deploymentInputs.set(key, structuredClone(input));
  }

  /** 只对有效领取、同项目/分支/服务及原目标返回输入；begin 仍须再次消费凭据。 */
  getDeploymentInputForReplay(request: BranchOperationRequest): DeploymentInputSnapshot | undefined {
    this.prunePendingReplayClaims();
    const identity = replayIdentity(request.pendingReplay);
    if (!identity) return undefined;
    const key = this.replayKey(identity);
    const pending = this.pendingReplayClaims.get(key)?.pending;
    if (!pending || this.operationKey(pending.request) !== this.operationKey(request)
      || pending.request.kind !== request.kind
      || Boolean(pending.request.commitPinned) !== Boolean(request.commitPinned)
      || (pending.request.commitPinned && pending.request.commitSha?.toLowerCase() !== request.commitSha?.toLowerCase())
      || (pending.request.versionId || null) !== (request.versionId || null) || request.hasOneShotOptions) return undefined;
    const input = this.deploymentInputs.get(key);
    return input ? structuredClone(input) : undefined;
  }

  seedGeneration(branchId: string, generation: number): void {
    if (Number.isSafeInteger(generation) && generation > this.currentGeneration(branchId)) this.generations.set(branchId, generation);
  }

  /** 启动期恢复已落盘、尚未执行的意图，原操作与代次保持不变。 */
  restorePendingDeployment(pending: PendingWebhookDeploy, input: DeploymentInputSnapshot): void {
    if (this.hasWaitingOperation(pending.operationId, pending.generation)) return;
    this.seedGeneration(pending.branchId, pending.generation);
    const restored = { ...pending, request: { ...pending.request, pendingReplay: null } };
    this.supersedeCoveredWaiting(restored.request);
    this.pendingWebhookDeploys.set(this.operationKey(restored.request), restored);
    this.rememberDeploymentInput(restored.operationId, restored.generation, input);
    this.record('branch.operation.restored', restored.request, restored.operationId, restored.generation, 'info', { pending: true, recoveredAt: nowIso() });
  }

  onOperationEnded(listener: (operationId: string, generation: number, status: 'cancelled' | 'failed' | 'interrupted') => void): () => void {
    this.operationEndListeners.add(listener);
    return () => this.operationEndListeners.delete(listener);
  }

  hasWaitingOperation(operationId: string, generation: number): boolean {
    this.prunePendingReplayClaims();
    return [...this.pendingWebhookDeploys.values()].some((pending) => pending.operationId === operationId && pending.generation === generation)
      || this.pendingReplayClaims.has(this.replayKey({ operationId, generation }));
  }

  abandonAdmission(operationId: string, generation: number): void {
    for (const [key, pending] of this.pendingWebhookDeploys) {
      if (pending.operationId !== operationId || pending.generation !== generation) continue;
      this.pendingWebhookDeploys.delete(key);
      this.record('branch.operation.failed', pending.request, operationId, generation, 'error', { reason: 'admission persistence failed', pending: true });
    }
  }


  begin(request: BranchOperationRequest): BranchOperationDecision {
    this.prunePendingReplayClaims();
    let replay: PendingWebhookDeploy | undefined;
    if (request.pendingReplay) {
      const identity = replayIdentity(request.pendingReplay);
      const key = identity ? this.replayKey(identity) : '';
      replay = identity ? this.pendingReplayClaims.get(key)?.pending : undefined;
      if (!replay || this.operationKey(replay.request) !== this.operationKey(request)
        || replay.request.kind !== request.kind
        || Boolean(replay.request.commitPinned) !== Boolean(request.commitPinned)
        || (replay.request.commitPinned && replay.request.commitSha?.toLowerCase() !== request.commitSha?.toLowerCase())
        || (replay.request.configHash && replay.request.configHash !== request.configHash)
        || (replay.request.versionId || null) !== (request.versionId || null)
        || request.hasOneShotOptions) {
        this.record('branch.operation.rejected', request, identity?.operationId || this.createOperationId(),
          identity?.generation || this.currentGeneration(request.branchId), 'warn', {
            reason: 'pending replay identity expired, superseded or mismatched', pendingReplay: true,
          });
        return {
          status: 'rejected', operationId: identity?.operationId || '',
          generation: identity?.generation || 0,
          reason: '待部署请求已更新、过期或不再匹配，请查看最新部署结果',
        };
      }
      this.pendingReplayClaims.delete(key);
      // 来源取自此前真实受理的请求，重放不能靠 HTTP 字段改成更高优先级或改写施动者。
      request = { ...replay.request, pendingReplay: identity };
    }
    const branchId = request.branchId;
    const active = this.findBlockingActive(request);
    const reserved = !active ? this.getUsableReservedContinuation(branchId, request) : undefined;
    // 已受理的重建续接先完成；其后排队的整分支意图不能反过来阻断续接。
    if (reserved && this.requestMatchesContinuation(request, reserved)) return this.beginAgainstReservedContinuation(request, reserved, replay);
    const queued = this.pendingWebhookDeploys.get(this.operationKey(request));
    if (!replay && queued && (!active || isWebhookDeploy(request) || MANUAL_MERGE_BEHIND_KINDS.has(active.request.kind))
      && isSameCommitDeployInFlight(request, { ...queued, startedAt: queued.updatedAt, cancelled: false })) {
      const cancelledPending = this.supersedeCoveredWaiting(request, queued);
      this.record('branch.operation.joined', request, queued.operationId, queued.generation, 'info', {
        activeOperationId: active?.operationId || null, pending: true, commitSha: request.commitSha || null,
      });
      return { status: 'joined', operationId: queued.operationId, generation: queued.generation,
        activeOperationId: active?.operationId, activeKind: active?.request.kind, joinedPending: true, cancelledPending,
        pendingCommitSha: queued.request.commitSha || null, reason: 'same target already queued' };
    }
    // 服务的较新意图必须等待较早整分支意图，包含已领取、尚未到达的重放。
    const waiting = this.findWaitingBarrier(request, replay?.generation ?? Infinity, !replay);
    if (waiting && (request.kind === 'deploy' || request.kind === 'deploy-profile')) {
      if ((isWebhookDeploy(request) || isMergeableManualDeploy(request))
        && (!active || MANUAL_MERGE_BEHIND_KINDS.has(active.request.kind))) {
        return this.mergePending(request, waiting.operationId, waiting.request.kind, 'waiting for earlier overlapping deployment', {
          waitingForGeneration: waiting.generation,
        }, replay);
      }
      this.record('branch.operation.rejected', request, waiting.operationId, waiting.generation, 'warn', {
        reason: 'earlier overlapping deployment has not finished', activeOperationId: waiting.operationId, activeKind: waiting.request.kind,
      });
      return { status: 'rejected', operationId: waiting.operationId, generation: waiting.generation,
        activeOperationId: waiting.operationId, activeKind: waiting.request.kind,
        reason: '更早的重叠范围部署尚未结束，请等待后重试' };
    }
    if (!active) {
      if (reserved) return this.beginAgainstReservedContinuation(request, reserved, replay);
      return this.start(request, replay ? { operationId: replay.operationId, generation: replay.generation } : undefined);
    }

    if (isSameCommitDeployInFlight(request, active)) {
      // 最新请求回到当前目标时，旧的同范围待办不能在其完成后再次覆盖它。
      const cancelledPending = !replay && this.supersedeCoveredWaiting(request);
      this.record('branch.operation.joined', request, active.operationId, active.generation, 'info', {
        activeOperationId: active.operationId,
        activeKind: active.request.kind,
        activeTrigger: active.request.trigger,
        commitSha: request.commitSha || null,
      });
      return {
        status: 'joined',
        cancelledPending,
        operationId: active.operationId,
        generation: active.generation,
        activeOperationId: active.operationId,
        activeKind: active.request.kind,
        pendingCommitSha: null,
        reason: 'same commit already deploying; joined the in-flight operation',
      };
    }

    if (isWebhookDeploy(request)) {
      return this.mergePending(request, active.operationId, active.request.kind, 'webhook deploy merged into latest pending operation', {}, replay);
    }

    const incomingPriority = priorityOf(request);
    const activePriority = priorityOf(active.request);
    if (incomingPriority > activePriority) {
      for (const item of this.findBlockingActives(request)) {
        item.cancelled = true;
        item.cancelReason = `superseded by ${request.kind}`;
        this.record('branch.operation.cancelled', item.request, item.operationId, item.generation, 'warn', {
          reason: item.cancelReason,
          supersededBy: request.kind,
          supersededByTrigger: request.trigger,
        });
      }
      if (TERMINAL_KINDS.has(request.kind) || request.kind === 'stop') {
        this.cancelPendingWebhookDeploy(branchId, `superseded by ${request.kind}`, {}, request);
        this.cancelReservedContinuations(request, `superseded by ${request.kind}`);
      } else {
        // 新部署取代在途操作时，同一部署范围的旧待办也被取代；否则 C 完成后
        // 会重放此前排队的 B。不同服务的请求不因这次替换而被丢弃。
        const pending = this.pendingWebhookDeploys.get(this.operationKey(request));
        if (pending && (request.kind === 'deploy' || request.kind === 'deploy-profile') && pending.request.kind === request.kind
          && (request.profileId || null) === (pending.request.profileId || null)
          && (request.projectId || null) === (pending.request.projectId || null)) {
          this.cancelPendingWebhookDeploy(branchId, 'superseded by newer deploy request', {
            supersededByCommitSha: request.commitSha || null,
            supersededByTrigger: request.trigger,
            supersededByRequestId: request.requestId || null,
          }, request, true);
        }
      }
      return this.start(request);
    }

    // manual 整分支 deploy 压不过在途操作时不再 409，而是与 webhook 同通道
    // 合并为最新待部署请求（治重试风暴：agent 重试不再叠加新部署/新排队）。
    // 仅限部署类在途操作（stop/reset/delete 在途时维持 409，见
    // MANUAL_MERGE_BEHIND_KINDS 注释）。
    if (isMergeableManualDeploy(request) && MANUAL_MERGE_BEHIND_KINDS.has(active.request.kind)) {
      return this.mergePending(request, active.operationId, active.request.kind, 'manual deploy merged into latest pending operation', { manualMerge: true }, replay);
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
    return this.finishAndDrain(lease, status, error, 1)[0] || null;
  }

  /** 生产派发器一次领取全部互不冲突的服务待办，避免最后一个操作结束后遗留无人派发的请求。 */
  completeAll(lease: BranchOperationLease, status: 'completed' | 'failed' | 'cancelled', error?: string): PendingWebhookDeploy[] {
    return this.finishAndDrain(lease, status, error, Infinity);
  }

  private finishAndDrain(lease: BranchOperationLease, status: 'completed' | 'failed' | 'cancelled', error: string | undefined, limit: number): PendingWebhookDeploy[] {
    const activeEntry = this.findActiveEntryByOperation(lease.operationId);
    const active = activeEntry?.active;
    const sameGeneration = active?.generation === lease.generation;
    const wasCurrent = Boolean(active && sameGeneration && !active.cancelled);
    // force-rebuild 续接会复用 operationId，迟到收尾必须同时匹配代次。
    if (activeEntry && sameGeneration) {
      this.active.delete(activeEntry.key);
    }
    this.record(`branch.operation.${status}`, lease.request, lease.operationId, lease.generation, status === 'failed' ? 'error' : status === 'cancelled' ? 'warn' : 'info', {
      error: error || null,
      cancelled: active?.cancelled || false,
      cancelReason: active?.cancelReason || null,
      staleCompletion: !wasCurrent,
    });
    if (
      status === 'completed'
      && wasCurrent
      && lease.request.kind === 'force-rebuild'
      && (lease.request.continueWith === 'deploy' || lease.request.continueWith === 'deploy-profile')
    ) {
      this.reserveContinuation(lease, lease.request.continueWith);
      // 独立服务仍可派发；与本续约冲突的范围继续等待。
    }
    return this.drainReady(lease.branchId, lease.request.projectId, limit);
  }

  /** 领取可执行意图；用于完成、派发失败及定时对账，领取后仍由凭据保护。 */
  drainReady(branchId?: string, projectId?: string | null, limit = Infinity): PendingWebhookDeploy[] {
    this.prunePendingReplayClaims();
    const ready: PendingWebhookDeploy[] = [];
    const ordered = [...this.pendingWebhookDeploys.entries()].sort((a, b) => a[1].generation - b[1].generation);
    for (const [key, pending] of ordered) {
      if (branchId && pending.branchId !== branchId) continue;
      if (projectId && pending.request.projectId && projectId !== pending.request.projectId) continue;
      if (this.findBlockingActive(pending.request) || this.getUsableReservedContinuation(pending.branchId, pending.request)) continue;
      // 查询续约时可能清理过期范围及其待办，已取消的请求不能被本轮继续派发。
      if (this.pendingWebhookDeploys.get(key) !== pending) continue;
      if (this.findWaitingBarrier(pending.request, pending.generation)) continue;
      if (ready.some(item => this.operationsConflict(item.request, pending.request))) continue;
      this.pendingWebhookDeploys.delete(key);
      this.pendingReplayClaims.set(this.replayKey(pending), { pending, expiresAt: Date.now() + 5 * 60_000 });
      ready.push(pending);
      if (ready.length >= limit) break;
    }
    return ready;
  }

  cancelBranch(branchId: string, reason: string): void {
    for (const [key, claim] of this.pendingReplayClaims) {
      if (claim.pending.branchId !== branchId) continue;
      this.cancelPendingReplayClaim(key, reason);
    }
    const activeEntries = [...this.active.entries()].filter(([, active]) => active.branchId === branchId);
    for (const [key, active] of activeEntries) {
      active.cancelled = true;
      active.cancelReason = reason;
      this.record('branch.operation.cancelled', active.request, active.operationId, active.generation, 'warn', { reason });
      this.active.delete(key);
    }
    this.cancelPendingWebhookDeploy(branchId, reason);
    for (const [key, reserved] of this.reservedContinuations) {
      if (reserved.branchId !== branchId) continue;
      this.reservedContinuations.delete(key);
      this.record('branch.operation.cancelled', reserved.request, reserved.operationId, reserved.generation, 'warn', { reason, reserved: true });
    }
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
    for (const { pending } of this.pendingReplayClaims.values()) {
      this.record('branch.operation.interrupted', pending.request, pending.operationId, pending.generation, 'warn', {
        reason, source, pending: true, pendingReplay: true, updatedAt: pending.updatedAt,
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
      return [...this.active.values()].find(item => item.branchId === branchId && item.request.profileId === profileId);
    }
    return [...this.active.values()].find((active) => active.branchId === branchId);
  }

  getActiveOperations(branchId?: string): ActiveOperation[] {
    const active = [...this.active.values()];
    return branchId ? active.filter((item) => item.branchId === branchId) : active;
  }

  getPendingWebhookDeploy(branchId: string, profileId?: string | null): PendingWebhookDeploy | undefined {
    return [...this.pendingWebhookDeploys.values()].find(item => item.branchId === branchId
      && (!profileId || item.request.profileId === profileId));
  }

  clearForTest(): void {
    this.active.clear();
    this.pendingWebhookDeploys.clear();
    this.reservedContinuations.clear();
    this.pendingReplayClaims.clear();
    this.deploymentInputs.clear();
    this.generations.clear();
  }

  private start(request: BranchOperationRequest, existing?: { operationId: string; generation?: number; admissionGeneration?: number; continuedFrom?: BranchOperationRequest }): BranchOperationDecision {
    if (!request.pendingReplay && !existing?.continuedFrom) {
      if (TERMINAL_KINDS.has(request.kind) || request.kind === 'stop') {
        this.cancelPendingWebhookDeploy(request.branchId, `superseded by ${request.kind}`, {}, request);
        this.cancelReservedContinuations(request, `superseded by ${request.kind}`);
      }
      this.supersedeCoveredWaiting(request);
      this.invalidatePendingReplayClaims(request, `superseded by ${request.kind}`);
    }
    const branchId = request.branchId;
    const key = this.operationKey(request);
    const generation = existing?.generation ?? this.nextGeneration(branchId);
    const admissionGeneration = existing?.admissionGeneration ?? generation;
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
    const lease: BranchOperationLease = {
      operationId,
      branchId,
      generation,
      request,
      startedAt: active.startedAt,
      admissionGeneration,
      isCurrent: () => this.isCurrent(branchId, operationId, generation),
      assertCurrent: (step?: string) => {
        if (!this.isCurrent(branchId, operationId, generation)) {
          throw new BranchOperationSupersededError(operationId, branchId, step);
        }
      },
    };
    this.record('branch.operation.started', request, operationId, generation, 'info', {
      continuedFromKind: existing?.continuedFrom?.kind || null,
      continuedFromSource: existing?.continuedFrom?.source || null,
    });
    return { status: 'started', operationId, generation, lease };
  }

  private mergePending(request: BranchOperationRequest, blockerId: string, blockerKind: BranchOperationKind,
    reason: string, details: Record<string, unknown> = {}, replay?: PendingWebhookDeploy): BranchOperationDecision {
    const key = this.operationKey(request);
    const existing = this.pendingWebhookDeploys.get(key);
    if (replay) {
      this.pendingWebhookDeploys.set(key, { ...replay, request, updatedAt: nowIso() });
      this.record('branch.operation.merged', request, replay.operationId, replay.generation, 'info', {
        activeOperationId: blockerId, activeKind: blockerKind, requeuedReplay: true, ...details,
      });
      return { status: 'merged', operationId: replay.operationId, generation: replay.generation,
        activeOperationId: blockerId, activeKind: blockerKind, pendingCommitSha: request.commitSha || null, reason };
    }
    if (existing && isSameCommitDeployInFlight(request, { ...existing, startedAt: existing.updatedAt, cancelled: false })) {
      const cancelledPending = this.supersedeCoveredWaiting(request, existing);
      this.record('branch.operation.joined', request, existing.operationId, existing.generation, 'info', {
        activeOperationId: blockerId, activeKind: blockerKind, pending: true, ...details,
      });
      return { status: 'joined', operationId: existing.operationId, generation: existing.generation,
        activeOperationId: blockerId, activeKind: blockerKind, joinedPending: true, cancelledPending,
        pendingCommitSha: existing.request.commitSha || null, reason: 'same target already queued' };
    }
    this.supersedeCoveredWaiting(request, existing);
    this.invalidatePendingReplayClaims(request, 'superseded by newer pending request');
    if (existing) this.record('branch.operation.cancelled', existing.request, existing.operationId, existing.generation, 'warn', {
      reason: 'superseded by newer pending target', pending: true, supersededByCommitSha: request.commitSha || null,
    });
    const generation = this.nextGeneration(request.branchId);
    const operationId = existing?.operationId || this.createOperationId();
    this.pendingWebhookDeploys.set(key, { operationId, branchId: request.branchId, generation, request,
      mergedCount: (existing?.mergedCount || 0) + 1, updatedAt: nowIso() });
    this.record('branch.operation.merged', request, operationId, generation, 'info', {
      activeOperationId: blockerId, activeKind: blockerKind, mergedCount: (existing?.mergedCount || 0) + 1,
      commitSha: request.commitSha || null, ...details,
    });
    return { status: 'merged', operationId, generation, activeOperationId: blockerId, activeKind: blockerKind,
      pendingCommitSha: request.commitSha || null, reason };
  }

  private beginAgainstReservedContinuation(
    request: BranchOperationRequest,
    reserved: ReservedContinuation,
    replay?: PendingWebhookDeploy,
  ): BranchOperationDecision {
    if (isWebhookDeploy(request)) {
      return this.mergePending(request, reserved.operationId, reserved.request.kind,
        'webhook deploy merged while force-rebuild waits for its deploy continuation', { reservedContinuation: true }, replay);
    }

    if (this.requestMatchesContinuation(request, reserved)) {
      this.reservedContinuations.delete(this.operationKey(reserved.request));
      const generation = this.nextGeneration(request.branchId);
      this.record('branch.operation.continued', request, reserved.operationId, generation, 'info', {
        reservedAt: reserved.reservedAt,
        continueWith: reserved.continueWith,
        previousGeneration: reserved.generation,
      });
      return this.start(request, {
        operationId: reserved.operationId,
        generation,
        admissionGeneration: reserved.generation,
        continuedFrom: reserved.request,
      });
    }

    const incomingPriority = priorityOf(request);
    const reservedPriority = priorityOf(reserved.request);
    if (incomingPriority > reservedPriority || TERMINAL_KINDS.has(request.kind) || request.kind === 'stop') {
      this.cancelReservedContinuations(request, `reserved continuation superseded by ${request.kind}`);
      if (TERMINAL_KINDS.has(request.kind) || request.kind === 'stop') {
        this.cancelPendingWebhookDeploy(request.branchId, `reserved continuation superseded by ${request.kind}`, {}, request);
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
      return this.mergePending(request, reserved.operationId, reserved.request.kind,
        'manual deploy merged while force-rebuild waits for its deploy continuation', { reservedContinuation: true, manualMerge: true }, replay);
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
    if (request.pendingReplay) return false;
    if (request.trigger !== reserved.request.trigger) return false;
    if (reserved.continueWith === 'deploy' && request.kind === 'deploy') return true;
    return reserved.continueWith === 'deploy-profile'
      && request.kind === 'deploy-profile'
      && request.profileId === reserved.request.profileId;
  }

  private reserveContinuation(lease: BranchOperationLease, continueWith: 'deploy' | 'deploy-profile'): void {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    this.reservedContinuations.set(this.operationKey(lease.request), {
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

  private cancelPendingWebhookDeploy(branchId: string, reason: string, details: Record<string, unknown> = {}, request?: BranchOperationRequest, exactScope = false): void {
    for (const [key, pending] of this.pendingWebhookDeploys) {
      if (pending.branchId !== branchId) continue;
      if (request && (exactScope ? key !== this.operationKey(request) : !this.operationsConflict(request, pending.request))) continue;
      this.pendingWebhookDeploys.delete(key);
      this.record('branch.operation.cancelled', pending.request, pending.operationId, pending.generation, 'warn', {
        reason, pending: true, mergedCount: pending.mergedCount, updatedAt: pending.updatedAt, ...details,
      });
    }
  }

  private getUsableReservedContinuation(branchId: string, request?: BranchOperationRequest): ReservedContinuation | null {
    for (const [key, reserved] of this.reservedContinuations) {
      if (reserved.branchId !== branchId || (request && !this.operationsConflict(request, reserved.request))) continue;
      if (Date.now() <= reserved.expiresAt) return reserved;
      this.reservedContinuations.delete(key);
      this.record('branch.operation.cancelled', reserved.request, reserved.operationId, reserved.generation, 'warn', {
        reason: 'reserved continuation expired', reserved: true,
      });
      this.cancelPendingWebhookDeploy(branchId, 'reserved continuation expired before manual deploy continuation arrived', {}, reserved.request);
    }
    return null;
  }

  private cancelReservedContinuations(request: BranchOperationRequest, reason: string): void {
    for (const [key, reserved] of this.reservedContinuations) {
      if (!this.operationsConflict(request, reserved.request)) continue;
      this.reservedContinuations.delete(key);
      this.record('branch.operation.cancelled', reserved.request, reserved.operationId, reserved.generation, 'warn', { reason, reserved: true });
    }
  }

  /** HTTP 派发失败或分支消失后释放凭据，迟到回调不能释放另一个代次。 */
  releasePendingReplay(pending: PendingWebhookDeploy, reason: string): PendingWebhookDeploy[] {
    this.cancelPendingReplayClaim(this.replayKey(pending), reason);
    return this.drainReady(pending.branchId, pending.request.projectId);
  }

  private replayKey(identity: { operationId: string; generation: number }): string {
    return JSON.stringify([identity.operationId, identity.generation]);
  }

  private invalidatePendingReplayClaims(request: BranchOperationRequest, reason: string): void {
    const terminal = TERMINAL_KINDS.has(request.kind) || request.kind === 'stop';
    for (const [key, claim] of this.pendingReplayClaims) {
      if (terminal ? this.operationsConflict(request, claim.pending.request)
        : this.operationKey(request) === this.operationKey(claim.pending.request)) {
        this.cancelPendingReplayClaim(key, reason);
      }
    }
  }

  private prunePendingReplayClaims(): void {
    for (const [key, claim] of this.pendingReplayClaims) {
      if (Date.now() > claim.expiresAt) this.cancelPendingReplayClaim(key, 'pending replay expired before dispatch');
    }
  }

  private cancelPendingReplayClaim(key: string, reason: string): void {
    const claim = this.pendingReplayClaims.get(key);
    if (!claim) return;
    this.pendingReplayClaims.delete(key);
    const { pending } = claim;
    this.record('branch.operation.cancelled', pending.request, pending.operationId, pending.generation, 'warn', {
      reason, pending: true, pendingReplay: true,
    });
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

  private coversDeploymentScope(incoming: BranchOperationRequest, older: BranchOperationRequest): boolean {
    if (!['deploy', 'deploy-profile'].includes(incoming.kind) || !['deploy', 'deploy-profile'].includes(older.kind)) return false;
    return this.operationsConflict(incoming, older)
      && (this.isBranchWide(incoming) || this.operationKey(incoming) === this.operationKey(older));
  }

  private supersedeCoveredWaiting(request: BranchOperationRequest, keep?: PendingWebhookDeploy): boolean {
    let cancelled = false;
    const isKept = (pending: PendingWebhookDeploy) => pending.operationId === keep?.operationId && pending.generation === keep?.generation;
    for (const [key, pending] of this.pendingWebhookDeploys) {
      if (isKept(pending) || !this.coversDeploymentScope(request, pending.request)) continue;
      this.pendingWebhookDeploys.delete(key); cancelled = true;
      this.record('branch.operation.cancelled', pending.request, pending.operationId, pending.generation, 'warn', {
        reason: 'superseded by newer covering deployment', pending: true, supersededByCommitSha: request.commitSha || null,
        supersededByTrigger: request.trigger, supersededByRequestId: request.requestId || null,
      });
    }
    for (const [key, claim] of this.pendingReplayClaims) {
      if (isKept(claim.pending) || !this.coversDeploymentScope(request, claim.pending.request)) continue;
      this.cancelPendingReplayClaim(key, 'superseded by newer covering deployment'); cancelled = true;
    }
    return cancelled;
  }

  private findWaitingBarrier(request: BranchOperationRequest, beforeGeneration = Infinity, ignoreCovered = false): PendingWebhookDeploy | undefined {
    return [...this.pendingWebhookDeploys.values(), ...[...this.pendingReplayClaims.values()].map((claim) => claim.pending)]
      .filter((pending) => pending.generation < beforeGeneration && this.operationsConflict(request, pending.request)
        && !(ignoreCovered && this.coversDeploymentScope(request, pending.request)))
      .sort((a, b) => a.generation - b.generation)[0];
  }

  private findBlockingActives(request: BranchOperationRequest): ActiveOperation[] {
    return [...this.active.values()].filter((active) => this.operationsConflict(request, active.request));
  }

  private operationsConflict(a: BranchOperationRequest, b: BranchOperationRequest): boolean {
    if (a.branchId !== b.branchId) return false;
    if (a.projectId && b.projectId && a.projectId !== b.projectId) return false;
    if (this.isBranchWide(a) || this.isBranchWide(b)) return true;
    return (a.profileId || null) === (b.profileId || null);
  }

  private operationKey(request: BranchOperationRequest): string {
    // JSON 元组避免分隔符碰撞；null 表示整分支范围。
    return JSON.stringify([request.projectId || null, request.branchId, this.isBranchWide(request) ? null : request.profileId]);
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
    if (['branch.operation.completed', 'branch.operation.cancelled', 'branch.operation.failed', 'branch.operation.interrupted'].includes(action)) {
      this.deploymentInputs.delete(this.replayKey({ operationId, generation }));
    }
    const terminal = action === 'branch.operation.cancelled' ? 'cancelled'
      : action === 'branch.operation.failed' ? 'failed'
      : action === 'branch.operation.interrupted' ? 'interrupted' : undefined;
    if (terminal) for (const listener of this.operationEndListeners) {
      try { listener(operationId, generation, terminal); }
      catch (err) { console.error('[branch-operation] run lifecycle observer failed', (err as Error).name); }
    }
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
        replayOf: replayIdentity(request.pendingReplay),
        ...details,
      },
    });
  }
}
