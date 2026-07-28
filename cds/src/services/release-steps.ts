import type { ReleasePlan, ReleaseRunProgress, ReleaseRunStep } from '../types.js';

/**
 * 发布步骤的唯一判定源。
 *
 * 为什么单独一个模块：这套「一次发布分成哪几步」的判定此前有三份拷贝——后端
 * release-service 拼 emitLog 的 phase 字面量、ReleaseCenterPage 用日志 phase 反推步骤条、
 * BranchListPage 再抄一遍。三份各自漂移的直接后果是：ssh-script 的 ReleasePlan 里只写了
 * 4 步，执行器实际发 6 个 phase，而前端画的又是另一套六格骨架，且把本仓库的
 * `./fast.sh` / `./exec_dep.sh` 写死进了 CDS 这个通用产品——换个项目步骤条就退化成
 * 五个笼统格子。步骤判定必须只有一处，其余全从这里取。
 *
 * 连接键：**ReleaseRunStep.id === 执行器 emitLog 时用的 phase**。这个键其实一直存在于
 * 日志里，只是从没被声明，前端才只能靠正则猜。
 */

const RELEASE_SCRIPT_PATH_RE = /(?:\.\/|\/)[A-Za-z0-9._/@+-]+\.sh/g;

export function extractReleaseScriptPaths(rawCommand: string): string[] {
  const matches = rawCommand.match(RELEASE_SCRIPT_PATH_RE) || [];
  return Array.from(new Set(matches));
}

/**
 * 是否把发布命令拆成逐脚本执行。
 *
 * 刻意保持「逐字匹配」而不泛化成「任意 A && B 都拆两条 SSH」：拆开会改变执行语义——
 * 前一条 export 的环境变量不再对后一条可见、`set -e` 的作用域断开、每条命令各自吃一次
 * 完整的执行超时（总时长翻倍）。本次改造只让**标题**来自数据、不再由前端硬编码，
 * 拆分条件维持原样，避免顺手把执行语义一起改了。
 */
export function isDefaultScriptChain(rawCommand: string, scripts = extractReleaseScriptPaths(rawCommand)): boolean {
  return rawCommand.replace(/\s+/g, ' ').trim() === './fast.sh && ./exec_dep.sh'
    && scripts.length === 2
    && scripts[0] === './fast.sh'
    && scripts[1] === './exec_dep.sh';
}

export function releaseScriptPhase(script: string): string {
  return `script:${script.replace(/^\.\//, '').replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

/** 发布命令展开后的实际执行单元。id 同时是 emitLog 的 phase 与步骤表里的 step.id。 */
export interface ReleaseDeployPhase {
  id: string;
  title: string;
  command: string;
}

/**
 * 发布命令 → 实际执行单元。
 *
 * 这是本模块里唯一有「第二个消费方」的函数：runDeployCommand 按它迭代执行 SSH，
 * buildReleaseRunProgress 按它展开步骤表。两边必须同源，否则会重演老问题——
 * 执行器跑两条脚本、步骤条只画一格（或反过来画了两格却永远有一格不亮）。
 */
export function planDeployPhases(rawCommand: string, deployTitle = '执行发布命令'): ReleaseDeployPhase[] {
  const scripts = extractReleaseScriptPaths(rawCommand);
  if (isDefaultScriptChain(rawCommand, scripts)) {
    return scripts.map((script) => ({
      id: releaseScriptPhase(script),
      title: `执行 ${script}`,
      command: script,
    }));
  }
  return [{ id: 'deploy', title: deployTitle, command: rawCommand }];
}

/** 计划模板里代表「跑发布命令」的那一步；它是唯一会被展开成多步的步骤。 */
const DEPLOY_STEP_ID = 'deploy';

/**
 * 用计划模板 + 本次实际命令，生成 run 上的不可变步骤快照。
 *
 * 为什么快照进 run 而不是运行时引用 plan：理由同 executionSnapshot——plan 可以事后被改，
 * run 是审计证据；而且 existing-script 模式下「deploy 到底几步」由用户命令决定，
 * 静态模板根本描述不出来。
 */
export function buildReleaseRunProgress(plan: ReleasePlan, rawCommand: string): ReleaseRunProgress {
  const steps: ReleaseRunStep[] = [];
  for (const templateStep of plan.steps || []) {
    if (templateStep.id !== DEPLOY_STEP_ID) {
      steps.push({ id: templateStep.id, title: templateStep.title, kind: templateStep.kind, state: 'pending' });
      continue;
    }
    for (const phase of planDeployPhases(rawCommand, templateStep.title)) {
      steps.push({ id: phase.id, title: phase.title, kind: templateStep.kind, state: 'pending' });
    }
  }
  return { planId: plan.id, steps };
}

/**
 * 回滚步骤表。ReleasePlan 只描述正向发布，回滚的步骤在这里成型。
 *
 * 非自定义命令的回滚会走 runDeployCommand 重新发布历史版本，因此必须把 deploy 展开的
 * 那几步也纳进来——否则回滚跑到一半，步骤条上没有任何一格对应它正在做的事。
 */
export function buildRollbackRunProgress(
  planId: string,
  rawCommand: string,
  useCustomRollbackCommand: boolean,
): ReleaseRunProgress {
  const steps: ReleaseRunStep[] = [
    {
      id: 'rollback',
      title: useCustomRollbackCommand ? '执行回滚命令' : '准备回滚到历史版本',
      kind: 'ssh',
      state: 'pending',
    },
  ];
  if (!useCustomRollbackCommand) {
    for (const phase of planDeployPhases(rawCommand, '重新发布历史版本')) {
      steps.push({ id: phase.id, title: phase.title, kind: 'ssh', state: 'pending' });
    }
  }
  steps.push({ id: 'healthcheck', title: '验证最终入口', kind: 'healthcheck', state: 'pending' });
  steps.push({ id: 'record', title: '记录回滚结果', kind: 'record', state: 'pending' });
  return { planId, steps };
}

/**
 * 步骤推进（纯函数，返回新对象）。
 *
 * 单调不回退是硬要求：自动恢复（restorePreviousAfterFailedProbe）会二次调用
 * runDeployCommand，deploy 步骤已经 done 了还会再收到一次 running；若允许回退，
 * 步骤条会在健康检查失败之后倒着往回跳，用户完全读不懂发生了什么。
 *
 * 未登记的 stepId（auto-restore / cancel / error / reconcile 这类不属于计划的 phase）
 * 原样返回，绝不凭空造一格。
 */
export function advanceReleaseSteps(
  progress: ReleaseRunProgress,
  stepId: string,
  next: 'running' | 'done' | 'failed',
  at: string,
): ReleaseRunProgress {
  const index = progress.steps.findIndex((step) => step.id === stepId);
  if (index < 0) return progress;
  const target = progress.steps[index];
  if (target.state === 'failed') return progress;
  if (target.state === 'done' && next !== 'failed') return progress;
  const steps = progress.steps.map((step, i) => {
    if (i === index) {
      return {
        ...step,
        state: next,
        startedAt: step.startedAt || (next === 'running' ? at : step.startedAt || at),
        ...(next === 'running' ? {} : { finishedAt: at }),
      };
    }
    // 前序步骤一律收束为 done：执行器是顺序推进的，能开始第 N 步就意味着前面都过了。
    // 不补这一下，某一步没有显式 finish（例如异常路径）就会永远挂着 running 的转圈。
    if (i < index && step.state !== 'done' && step.state !== 'failed') {
      return { ...step, state: 'done' as const, finishedAt: step.finishedAt || at };
    }
    return step;
  });
  return { ...progress, steps, currentStepId: stepId };
}

/** 全部收束为成功。run 进入成功终态时调用，保证不残留转圈的步骤。 */
export function completeReleaseSteps(progress: ReleaseRunProgress, at: string): ReleaseRunProgress {
  const steps = progress.steps.map((step) => (
    step.state === 'done' || step.state === 'failed'
      ? step
      : { ...step, state: 'done' as const, finishedAt: at }
  ));
  return { ...progress, steps, currentStepId: steps[steps.length - 1]?.id || progress.currentStepId };
}

/**
 * 失败定位：把「当前正在做的那一步」标失败，后续步骤保持 pending。
 *
 * 修复前前端靠「倒着找最后一条 error 日志的 phase」猜失败步——SSH 的 stderr 会被逐行
 * 当 warn/error 写进日志，最后一条 error 常常来自上一步的噪声，失败格经常点错位置。
 */
export function failReleaseSteps(progress: ReleaseRunProgress, at: string): ReleaseRunProgress {
  const currentIndex = progress.steps.findIndex((step) => step.id === progress.currentStepId);
  const runningIndex = progress.steps.findIndex((step) => step.state === 'running');
  const pendingIndex = progress.steps.findIndex((step) => step.state === 'pending');
  const index = runningIndex >= 0
    ? runningIndex
    : currentIndex >= 0
      ? currentIndex
      : pendingIndex;
  if (index < 0) return progress;
  if (progress.steps.some((step) => step.state === 'failed')) return progress;
  const steps = progress.steps.map((step, i) => (
    i === index ? { ...step, state: 'failed' as const, finishedAt: at } : step
  ));
  return { ...progress, steps, currentStepId: steps[index].id };
}

/** 「第 N / 共 M 步」的 N（1-based）。全 pending 时返回 1，让 UI 有个确定起点。 */
export function releaseStepOrdinal(progress: ReleaseRunProgress | undefined): { index: number; total: number } {
  const steps = progress?.steps || [];
  if (steps.length === 0) return { index: 0, total: 0 };
  const active = steps.findIndex((step) => step.state === 'running' || step.state === 'failed');
  if (active >= 0) return { index: active + 1, total: steps.length };
  const doneCount = steps.filter((step) => step.state === 'done').length;
  return { index: Math.max(1, Math.min(doneCount === steps.length ? steps.length : doneCount + 1, steps.length)), total: steps.length };
}
