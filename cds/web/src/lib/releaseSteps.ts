/**
 * 发布步骤条的唯一渲染源（前端侧）。
 *
 * 修复前：ReleaseCenterPage 与 BranchListPage 各写一份「把日志 phase 收成 Set 再倒着
 * 找最后一条 error 反推失败步」的推断逻辑，并且把本仓库的 `./fast.sh` / `./exec_dep.sh`
 * 写死进了 CDS 这个通用产品——换成任何别的项目，步骤条立刻退化成几个笼统格子，
 * 且失败格经常点错位置（SSH 的 stderr 逐行进日志，最后一条 error 常来自上一步噪声）。
 *
 * 现在步骤由后端 run.progress 直接给出，这里只做展示映射。
 */

export type ReleaseStepState = 'pending' | 'running' | 'done' | 'failed';

export interface ReleaseRunStepLike {
  id: string;
  title: string;
  state: ReleaseStepState;
}

export interface ReleaseRunProgressLike {
  planId?: string;
  steps?: ReleaseRunStepLike[];
  currentStepId?: string;
}

export interface ReleaseRunLogLike {
  level?: string;
  phase?: string;
}

export interface ReleaseRunLike {
  status: string;
  logs?: ReleaseRunLogLike[];
  progress?: ReleaseRunProgressLike;
}

export interface ReleaseStepView {
  id: string;
  label: string;
  state: ReleaseStepState;
}

export interface ReleaseStepsView {
  steps: ReleaseStepView[];
  /** 1-based；无步骤时为 0。 */
  currentIndex: number;
  total: number;
  currentLabel: string;
  /** true 代表退化骨架（存量 run 没有 progress），UI 可据此弱化「第 N/M 步」的确定性表述。 */
  degraded: boolean;
}

const TERMINAL_STATUS = ['success', 'failed', 'rollback_success', 'rollback_failed'];

function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUS.includes(status);
}

export function resolveReleaseSteps(run: ReleaseRunLike | null | undefined): ReleaseStepsView {
  if (!run) return { steps: [], currentIndex: 0, total: 0, currentLabel: '', degraded: false };
  const structured = run.progress?.steps || [];
  const steps: ReleaseStepView[] = structured.length > 0
    ? structured.map((step) => ({ id: step.id, label: step.title, state: step.state }))
    : legacySteps(run);
  const degraded = structured.length === 0;
  const activeIndex = steps.findIndex((step) => step.state === 'running' || step.state === 'failed');
  const doneCount = steps.filter((step) => step.state === 'done').length;
  const currentIndex = steps.length === 0
    ? 0
    : activeIndex >= 0
      ? activeIndex + 1
      : Math.max(1, Math.min(doneCount === steps.length ? steps.length : doneCount + 1, steps.length));
  return {
    steps,
    currentIndex,
    total: steps.length,
    currentLabel: steps[currentIndex - 1]?.label || '',
    degraded,
  };
}

/**
 * 存量 run（阶段二之前入库、没有 progress）的兜底骨架。
 *
 * 刻意只用**通用**步骤名：历史记录仍然可读，但本仓库的脚本名不会借兜底路径复活到
 * 这个通用产品里。粒度弱于新 run 是有意的取舍——旧日志本来也只有 phase 可依。
 */
function legacySteps(run: ReleaseRunLike): ReleaseStepView[] {
  const phases = new Set((run.logs || []).map((log) => log.phase).filter(Boolean) as string[]);
  const seenDeploy = [...phases].some((phase) => phase === 'deploy' || phase.startsWith('script:'));
  const seenHealth = phases.has('healthcheck');
  const failed = run.status.includes('failed');
  const success = run.status === 'success' || run.status === 'rollback_success';
  const skeleton: ReleaseStepView[] = [
    { id: 'connect', label: '连接服务器', state: phases.has('connect') ? 'done' : 'pending' },
    {
      id: 'prepare',
      label: '进入站点目录',
      state: phases.has('prepare') || seenDeploy || seenHealth || success ? 'done' : 'pending',
    },
    {
      id: 'deploy',
      label: '执行发布命令',
      state: seenHealth || success ? 'done' : seenDeploy ? 'running' : 'pending',
    },
    {
      id: 'healthcheck',
      label: '检查上线地址',
      state: seenHealth ? (failed ? 'failed' : 'done') : 'pending',
    },
    { id: 'record', label: '标记完成', state: success ? 'done' : 'pending' },
  ];
  if (failed) {
    if (!skeleton.some((step) => step.state === 'failed')) {
      const next = skeleton.find((step) => step.state === 'running' || step.state === 'pending');
      if (next) next.state = 'failed';
      else {
        const lastDone = [...skeleton].reverse().find((step) => step.state === 'done');
        if (lastDone) lastDone.state = 'failed';
      }
    }
  } else if (!isTerminalStatus(run.status)) {
    const next = skeleton.find((step) => step.state === 'running' || step.state === 'pending');
    if (next) next.state = 'running';
  }
  return skeleton;
}
