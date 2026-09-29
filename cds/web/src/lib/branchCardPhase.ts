/*
 * 分支卡片页脚的「构建阶段条」唯一判定源（2026-09-29 卡片改版）。
 *
 * 只认后端真实状态，不从日志里猜、不编百分比：
 *   - 排队     ← branch.buildQueue 存在（构建并发闸满了）
 *   - 等镜像   ← 极速版且 ciImageStatus === 'waiting'（GitHub Actions 还在出镜像）
 *   - 构建/启动 ← 分支或任一服务处于 building（源码版在本机编译并起容器，极速版拉镜像并起容器）
 *   - 就绪探测 ← starting / restarting（容器活了，等启动信号或 HTTP/TCP 就绪探测）
 *
 * 极速版四段、源码版三段——源码版没有「等镜像」这一步，硬凑一段空格子就是在编造。
 * 部署日志归纳阶段的是 deploymentPhases.ts（输入是日志行，服务于详情抽屉），与这里
 * 输入不同、用途不同，不要合并。
 */

export type BranchCardPhaseKey = 'queued' | 'ci-waiting' | 'build' | 'start' | 'ready' | 'stopping' | 'working';

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
  return input.prebuilt === true || Boolean(input.ciImageStatus);
}

/** 极速版是否正在等 CI 出镜像。分支可能仍在用旧版本跑着（status=running）。 */
export function isWaitingForCiImage(input: Pick<BranchCardPhaseInput, 'ciImageStatus' | 'prebuilt'>): boolean {
  return input.ciImageStatus === 'waiting' && input.prebuilt !== false;
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
    return { key: 'stopping', label: '正在停止', index: 0, showStep: false, steps: [{ key: 'stopping', label: '正在停止', state: 'current' }] };
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
  if (input.status === 'starting' || input.status === 'restarting') {
    return build(steps, steps.length - 1, true);
  }
  if (input.pendingActionLabel) {
    return {
      key: 'working',
      label: input.pendingActionLabel,
      index: 0,
      showStep: false,
      steps: [{ key: 'working', label: input.pendingActionLabel, state: 'current' }],
    };
  }
  return null;
}
