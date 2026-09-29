/*
 * 分支卡片页脚的「构建阶段条」唯一判定源（2026-09-29 卡片改版）。
 *
 * 只认后端真实状态，不从日志里猜、不编百分比：
 *   - 排队     ← branch.buildQueue 存在（构建并发闸满了）
 *   - 等镜像   ← 极速版且 ciImageStatus === 'waiting'（GitHub Actions 还在出镜像）
 *   - 构建/启动 ← 分支或任一服务处于 building（源码版在本机编译并起容器，极速版拉镜像并起容器）
 *   - 就绪探测 ← 分支 starting，或分支 running 而某个服务 starting（单服务部署）
 *   - 正在重启 ← restarting 且没有服务在构建（一键重启 / 冷却唤醒：原地重启容器，没有构建）
 *
 * 极速版四段、源码版三段——源码版没有「等镜像」这一步，硬凑一段空格子就是在编造。
 * 部署日志归纳阶段的是 deploymentPhases.ts（输入是日志行，服务于详情抽屉），与这里
 * 输入不同、用途不同，不要合并。
 */

export type BranchCardPhaseKey = 'queued' | 'ci-waiting' | 'build' | 'start' | 'ready' | 'stopping' | 'restarting' | 'working';

export interface BranchCardPhaseStep {
  key: BranchCardPhaseKey;
  label: string;
  state: 'done' | 'current' | 'todo';
}

export interface BranchCardPhase {
  /** 机读阶段，挂在卡片根的 data-deploy-phase 上给验收工具读。 */
  key: BranchCardPhaseKey;
  /** 页脚左侧的阶段文案。 */
  label: string;
  steps: BranchCardPhaseStep[];
  /** 当前段下标（0 起）。 */
  index: number;
  /** 是否显示「第 i/n 步」。排队与停止不显示：那不是部署推进的一步。 */
  showStep: boolean;
}

export interface BranchCardPhaseInput {
  status: string;
  services?: Record<string, { status: string }>;
  buildQueue?: unknown;
  ciImageStatus?: string;
  /** deployRuntime.prebuilt。缺省（SSE 推来的原始分支没有它）按 ciImageStatus 是否存在推断。 */
  prebuilt?: boolean;
  /**
   * deployRuntime.prebuiltProfileIds：走极速版的 profile。给了就按「这次正在部署的服务」判步骤——
   * 一条分支可以极速版与源码版混着，只重部署一个源码服务时 prebuilt 仍为 true，
   * 按它会把本机编译说成「启动容器」（Codex P2，PR #1646）。没给（SSE 原始分支）退回 prebuilt。
   */
  prebuiltProfileIds?: string[];
  /**
   * 这次部署前几拍已经参与过的服务（卡片自己记的并集）。服务各自结束：源码服务先回 running、
   * 极速版服务还在就绪探测时，只看此刻在动的服务会把源码部署中途翻成极速版步骤（Codex P2，PR #1646）。
   */
  participants?: string[];
  /**
   * deployRuntime.activeProfiles：这条分支一共有几个服务。整分支部署刚开始、还没有服务翻到 building 时
   * （分支先翻 building），用它判断是不是「全部走极速版」，不按「任一」判（Codex P2，PR #1646）。
   */
  activeProfileCount?: number;
  /**
   * 前端已发起、服务端状态还没跟上的操作（点了部署，SSE 还没把 status 推成 building）。
   * 给了就在状态判不出阶段时显示单段「处理中」，而不是假装在某一段。
   */
  pendingActionLabel?: string;
}

const EXPRESS_STEPS: Array<{ key: BranchCardPhaseKey; label: string }> = [
  { key: 'queued', label: '排队' },
  { key: 'ci-waiting', label: '等待 CI 镜像' },
  { key: 'start', label: '启动容器' },
  { key: 'ready', label: '就绪探测' },
];

const SOURCE_STEPS: Array<{ key: BranchCardPhaseKey; label: string }> = [
  { key: 'queued', label: '排队' },
  { key: 'build', label: '构建并启动' },
  { key: 'ready', label: '就绪探测' },
];

function isExpress(input: BranchCardPhaseInput): boolean {
  if (input.prebuilt === false) return false;
  const participants = Array.from(new Set([...(input.participants || []), ...deployingServiceIds(input.services)]));
  if (input.prebuiltProfileIds) {
    const prebuiltIds = new Set(input.prebuiltProfileIds);
    // 依次认：这次已参与 / 正在动的服务 → 排队里登记的服务 → 这条分支的全部服务。
    if (participants.length > 0) return participants.every((id) => prebuiltIds.has(id));
    const queued = (input.buildQueue as { serviceIds?: unknown } | undefined)?.serviceIds;
    if (Array.isArray(queued) && queued.length > 0) return queued.every((id) => prebuiltIds.has(String(id)));
    if (typeof input.activeProfileCount === 'number' && input.activeProfileCount > 0) {
      return prebuiltIds.size >= input.activeProfileCount;
    }
  }
  return input.prebuilt === true || Boolean(input.ciImageStatus);
}

/** 极速版是否正在等 CI 出镜像。分支可能仍在用旧版本跑着（status=running）。 */
export function isWaitingForCiImage(input: Pick<BranchCardPhaseInput, 'ciImageStatus' | 'prebuilt'>): boolean {
  return input.ciImageStatus === 'waiting' && input.prebuilt !== false;
}

/** 没有已知阶段序列的动作（停止 / 重启 / 前端占位）：单段，不编造步数。 */
function single(key: BranchCardPhaseKey, label: string): BranchCardPhase {
  return { key, label, index: 0, showStep: false, steps: [{ key, label, state: 'current' }] };
}

function build(steps: Array<{ key: BranchCardPhaseKey; label: string }>, index: number, showStep: boolean): BranchCardPhase {
  const current = steps[index];
  return {
    key: current.key,
    label: current.label,
    index,
    showStep,
    steps: steps.map((step, i) => ({ ...step, state: i < index ? 'done' : i === index ? 'current' : 'todo' })),
  };
}

/**
 * 卡片此刻处于部署的哪一段；不在部署（运行中、已停止、出错）返回 null。
 * 判定顺序即优先级：排队 > 等镜像 > 构建 > 就绪。
 */
export function branchCardPhase(input: BranchCardPhaseInput): BranchCardPhase | null {
  if (input.status === 'stopping') {
    return single('stopping', '正在停止');
  }
  const express = isExpress(input);
  const steps = express ? EXPRESS_STEPS : SOURCE_STEPS;
  const services = Object.values(input.services || {});
  if (input.buildQueue && input.status !== 'error') {
    return build(steps, 0, false);
  }
  if (isWaitingForCiImage(input) && input.status !== 'error') {
    return build(EXPRESS_STEPS, 1, true);
  }
  if (input.status === 'building' || services.some((svc) => svc.status === 'building')) {
    return build(steps, express ? 2 : 1, true);
  }
  // 单服务部署（单个 profile 部署 / webhook 只重建一个服务）时分支保持 running，只有那个服务
  // 走 building → starting；就绪探测这一段只看分支级 starting 会漏掉，卡片会在探测结束前报成功。
  // 原地重启是 restarting，不走这里（Codex P2，PR #1646）。
  if (input.status === 'starting' || (input.status === 'running' && services.some((svc) => svc.status === 'starting'))) {
    return build(steps, steps.length - 1, true);
  }
  if (input.status === 'restarting') {
    return single('restarting', '正在重启');
  }
  if (input.pendingActionLabel) {
    return single('working', input.pendingActionLabel);
  }
  return null;
}

/**
 * 这一段是不是一次真实部署的组成部分。只有部署阶段才计入耗时预计、才会在结束时
 * 播「部署成功 / 构建失败」收尾——停止、原地重启、前端操作占位都不是部署，
 * 拿部署中位值去比它们、或在它们结束时报「部署成功」都是在说谎（Codex P2，PR #1646）。
 */
export function isDeployPhase(phase: Pick<BranchCardPhase, 'key'>): boolean {
  return DEPLOY_PHASE_KEYS.has(phase.key);
}

const DEPLOY_PHASE_KEYS: ReadonlySet<BranchCardPhaseKey> = new Set(['queued', 'ci-waiting', 'build', 'start', 'ready']);

/**
 * 部署真的动手了没有（在构建、起容器或做就绪探测）。排队与等 CI 镜像只是在等，
 * 在这两段里结束的——CI 失败、排队被取消——没有产出任何新版本，不许报「部署成功」
 * （Codex P1，PR #1646）。
 */
export function isDeployStartedPhase(phase: Pick<BranchCardPhase, 'key'>): boolean {
  return phase.key === 'build' || phase.key === 'start' || phase.key === 'ready';
}

/** 此刻正在部署的服务（building / starting）。收尾要按「这次参与部署的服务」判成败。 */
export function deployingServiceIds(services?: Record<string, { status: string }>): string[] {
  return Object.entries(services || {})
    .filter(([, svc]) => svc.status === 'building' || svc.status === 'starting')
    .map(([id]) => id);
}

export interface DeployOutcome {
  kind: 'done' | 'failed';
  /** 参与这次部署、最后落在 error 的服务。 */
  failedServiceIds: string[];
}

/**
 * 一次部署结束时的成败。不能只看分支聚合状态：单服务部署失败时，别的服务还健康，
 * 分支仍是 running——只看它就会把失败报成「部署成功」（Codex P1，PR #1646）。
 * 分支既不是 running 也不是 error（比如被停掉）、或部署根本没动手（只在排队 / 等镜像里结束）
 * 时返回 null，不播收尾。
 */
export function deployOutcome(input: {
  status: string;
  services?: Record<string, { status: string }>;
  participants: string[];
  /** 这次是否真的进入过构建 / 起容器 / 就绪探测。只在等待里结束的不算部署。 */
  started: boolean;
}): DeployOutcome | null {
  const failedServiceIds = input.participants.filter((id) => input.services?.[id]?.status === 'error');
  if (!input.started) return input.status === 'error' ? { kind: 'failed', failedServiceIds } : null;
  if (input.status === 'error' || failedServiceIds.length > 0) return { kind: 'failed', failedServiceIds };
  if (input.status === 'running') return { kind: 'done', failedServiceIds: [] };
  return null;
}
