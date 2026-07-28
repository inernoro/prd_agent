import { describe, expect, it } from 'vitest';
import {
  advanceReleaseSteps,
  buildReleaseRunProgress,
  buildRollbackRunProgress,
  completeReleaseSteps,
  failReleaseSteps,
  planDeployPhases,
  releaseScriptPhase,
  releaseStepOrdinal,
} from '../../src/services/release-steps.js';
import type { ReleasePlan } from '../../src/types.js';

/**
 * 后端一等公民步骤模型的纯函数回归。
 *
 * 事故值：ssh-script 的 ReleasePlan 只写了 connect/deploy/healthcheck/record 四步，
 * 执行器实际发 connect/prepare/plan/deploy/healthcheck/record 六个 phase，而前端画的
 * 又是第三套六格骨架，里面写死了本仓库的 './fast.sh' / './exec_dep.sh'。三份判定各自
 * 漂移，plan.steps 因此端到端零消费。本套件把「步骤只有一个判定源」钉成回归。
 */

function plan(steps: ReleasePlan['steps']): ReleasePlan {
  return {
    id: 'p1:ssh-script',
    projectId: 'p1',
    name: '项目现有脚本发布',
    template: 'ssh-script',
    targetType: 'ssh',
    steps,
    failureStrategy: 'stop',
    rollbackStrategy: 'command',
    createdAt: '2026-07-28T00:00:00.000Z',
  };
}

const DEFAULT_STEPS: ReleasePlan['steps'] = [
  { id: 'connect', title: '连接目标', kind: 'ssh' },
  { id: 'prepare', title: '进入站点目录', kind: 'ssh' },
  { id: 'plan', title: '核对执行脚本哈希', kind: 'record' },
  { id: 'deploy', title: '执行项目发布命令', kind: 'ssh' },
  { id: 'healthcheck', title: '验证最终入口', kind: 'healthcheck' },
  { id: 'record', title: '记录版本与脚本哈希', kind: 'record' },
];

const AT = '2026-07-28T01:00:00.000Z';

describe('planDeployPhases 是执行与步骤表的同一个判定源', () => {
  it('逐字命中的两段式脚本链展开成两步，id 就是各自的日志 phase', () => {
    const phases = planDeployPhases('./fast.sh && ./exec_dep.sh');

    expect(phases.map((phase) => phase.id)).toEqual([
      releaseScriptPhase('./fast.sh'),
      releaseScriptPhase('./exec_dep.sh'),
    ]);
    // 命令按脚本逐条下发，与 runDeployCommand 的迭代对象是同一个数组。
    expect(phases.map((phase) => phase.command)).toEqual(['./fast.sh', './exec_dep.sh']);
    expect(phases.map((phase) => phase.title)).toEqual(['执行 ./fast.sh', '执行 ./exec_dep.sh']);
  });

  it('任何其他命令都是单步，且标题来自计划模板不是脚本名', () => {
    expect(planDeployPhases('./deploy.sh --prod', '执行项目发布命令')).toEqual([
      { id: 'deploy', title: '执行项目发布命令', command: './deploy.sh --prod' },
    ]);
    // 拆分条件保持逐字匹配：泛化成「任意 A && B 拆两条 SSH」会改执行语义
    // （env export 断链、set -e 作用域断开、执行超时翻倍）。
    expect(planDeployPhases('CDS_ENV=prod ./fast.sh && ./exec_dep.sh')).toHaveLength(1);
    expect(planDeployPhases('./fast.sh && ./exec_dep.sh && ./notify.sh')).toHaveLength(1);
  });
});

describe('buildReleaseRunProgress', () => {
  it('把计划模板展开成本次运行的步骤快照，deploy 随实际命令拆成多步', () => {
    const progress = buildReleaseRunProgress(plan(DEFAULT_STEPS), './fast.sh && ./exec_dep.sh');

    expect(progress.planId).toBe('p1:ssh-script');
    expect(progress.steps.map((step) => step.id)).toEqual([
      'connect',
      'prepare',
      'plan',
      releaseScriptPhase('./fast.sh'),
      releaseScriptPhase('./exec_dep.sh'),
      'healthcheck',
      'record',
    ]);
    expect(progress.steps.every((step) => step.state === 'pending')).toBe(true);
  });

  it('单条发布命令时 deploy 保持一步，共 6 步', () => {
    const progress = buildReleaseRunProgress(plan(DEFAULT_STEPS), './deploy.sh');

    expect(progress.steps).toHaveLength(6);
    expect(progress.steps[3]).toMatchObject({ id: 'deploy', title: '执行项目发布命令', state: 'pending' });
  });

  it('步骤全部来自计划模板，不凭空添加', () => {
    const progress = buildReleaseRunProgress(
      plan([{ id: 'connect', title: '连接目标', kind: 'ssh' }]),
      './deploy.sh',
    );

    expect(progress.steps.map((step) => step.id)).toEqual(['connect']);
  });
});

describe('buildRollbackRunProgress', () => {
  it('自定义回滚命令是三步', () => {
    const progress = buildRollbackRunProgress('p1:ssh-script', './rollback.sh', true);

    expect(progress.steps.map((step) => step.id)).toEqual(['rollback', 'healthcheck', 'record']);
  });

  it('重新发布历史版本的回滚要把 deploy 展开的那几步也纳进来', () => {
    // 否则回滚跑到一半，步骤条上没有任何一格对应它正在做的事。
    const progress = buildRollbackRunProgress('p1:ssh-script', './fast.sh && ./exec_dep.sh', false);

    expect(progress.steps.map((step) => step.id)).toEqual([
      'rollback',
      releaseScriptPhase('./fast.sh'),
      releaseScriptPhase('./exec_dep.sh'),
      'healthcheck',
      'record',
    ]);
  });
});

describe('advanceReleaseSteps 单调不回退', () => {
  it('开始某一步时把前序未收束的步骤一并收成 done', () => {
    let progress = buildReleaseRunProgress(plan(DEFAULT_STEPS), './deploy.sh');
    progress = advanceReleaseSteps(progress, 'connect', 'running', AT);
    progress = advanceReleaseSteps(progress, 'healthcheck', 'running', AT);

    expect(progress.currentStepId).toBe('healthcheck');
    expect(progress.steps.slice(0, 4).every((step) => step.state === 'done')).toBe(true);
    expect(progress.steps.find((step) => step.id === 'record')?.state).toBe('pending');
  });

  it('已 done 的步骤不会被自动恢复的二次 deploy 打回 running', () => {
    // 事故场景：健康检查失败 → restorePreviousAfterFailedProbe 再跑一次 runDeployCommand。
    // 允许回退的话步骤条会倒着往回跳，用户完全读不懂发生了什么。
    let progress = buildReleaseRunProgress(plan(DEFAULT_STEPS), './deploy.sh');
    progress = advanceReleaseSteps(progress, 'deploy', 'running', AT);
    progress = advanceReleaseSteps(progress, 'deploy', 'done', AT);
    progress = advanceReleaseSteps(progress, 'healthcheck', 'running', AT);
    const after = advanceReleaseSteps(progress, 'deploy', 'running', AT);

    expect(after.steps.find((step) => step.id === 'deploy')?.state).toBe('done');
    expect(after.steps.find((step) => step.id === 'healthcheck')?.state).toBe('running');
  });

  it('未登记的 phase 原样返回，不会凭空造一格', () => {
    const progress = buildReleaseRunProgress(plan(DEFAULT_STEPS), './deploy.sh');

    // auto-restore / cancel / error / reconcile 都是不属于计划的 phase。
    expect(advanceReleaseSteps(progress, 'auto-restore', 'running', AT)).toBe(progress);
    expect(advanceReleaseSteps(progress, 'cancel', 'failed', AT)).toBe(progress);
  });
});

describe('终态收束', () => {
  it('成功时全部收成 done，不残留转圈的步骤', () => {
    let progress = buildReleaseRunProgress(plan(DEFAULT_STEPS), './deploy.sh');
    progress = advanceReleaseSteps(progress, 'record', 'running', AT);
    progress = completeReleaseSteps(progress, AT);

    expect(progress.steps.every((step) => step.state === 'done')).toBe(true);
  });

  it('失败只标当前那一步，后续保持 pending', () => {
    let progress = buildReleaseRunProgress(plan(DEFAULT_STEPS), './deploy.sh');
    progress = advanceReleaseSteps(progress, 'deploy', 'running', AT);
    progress = failReleaseSteps(progress, AT);

    expect(progress.steps.find((step) => step.id === 'deploy')?.state).toBe('failed');
    expect(progress.steps.find((step) => step.id === 'healthcheck')?.state).toBe('pending');
    expect(progress.steps.find((step) => step.id === 'record')?.state).toBe('pending');
    expect(progress.steps.filter((step) => step.state === 'failed')).toHaveLength(1);
  });

  it('已定位过失败步的快照不会被二次收束改写', () => {
    let progress = buildReleaseRunProgress(plan(DEFAULT_STEPS), './deploy.sh');
    progress = advanceReleaseSteps(progress, 'connect', 'running', AT);
    progress = failReleaseSteps(progress, AT);
    const again = failReleaseSteps(progress, AT);

    expect(again).toBe(progress);
  });
});

describe('releaseStepOrdinal 给出「第 N / 共 M 步」', () => {
  it('运行中取正在跑的那一步', () => {
    let progress = buildReleaseRunProgress(plan(DEFAULT_STEPS), './fast.sh && ./exec_dep.sh');
    progress = advanceReleaseSteps(progress, releaseScriptPhase('./exec_dep.sh'), 'running', AT);

    expect(releaseStepOrdinal(progress)).toEqual({ index: 5, total: 7 });
  });

  it('全部完成时是最后一步；无步骤时是 0', () => {
    const progress = completeReleaseSteps(buildReleaseRunProgress(plan(DEFAULT_STEPS), './deploy.sh'), AT);

    expect(releaseStepOrdinal(progress)).toEqual({ index: 6, total: 6 });
    expect(releaseStepOrdinal(undefined)).toEqual({ index: 0, total: 0 });
  });
});
