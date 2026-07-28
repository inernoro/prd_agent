import { describe, expect, it } from 'vitest';
import { resolveReleaseSteps, type ReleaseRunLike } from '../../web/src/lib/releaseSteps.js';

/**
 * 发布步骤条前端渲染源的回归。
 *
 * 事故值：ReleaseCenterPage 从日志 phase 反推步骤条，并把本仓库的 './fast.sh' /
 * './exec_dep.sh' 写死进了 CDS 这个通用产品——换个项目就退化成五个笼统格子；失败步靠
 * 「倒着找最后一条 error 日志的 phase」猜，而 SSH 的 stderr 逐行进日志，那条 error
 * 常来自上一步噪声，失败格经常点错位置。现在一律读后端 run.progress。
 */

function run(overrides: Partial<ReleaseRunLike>): ReleaseRunLike {
  return { status: 'running', logs: [], ...overrides };
}

describe('resolveReleaseSteps 直读后端步骤快照', () => {
  it('步骤、当前序号与标题全部来自 run.progress', () => {
    const view = resolveReleaseSteps(run({
      status: 'running',
      progress: {
        planId: 'p1:ssh-script',
        currentStepId: 'deploy',
        steps: [
          { id: 'connect', title: '连接目标', state: 'done' },
          { id: 'prepare', title: '进入站点目录', state: 'done' },
          { id: 'deploy', title: '执行项目发布命令', state: 'running' },
          { id: 'healthcheck', title: '验证最终入口', state: 'pending' },
        ],
      },
    }));

    expect(view.total).toBe(4);
    expect(view.currentIndex).toBe(3);
    expect(view.currentLabel).toBe('执行项目发布命令');
    expect(view.degraded).toBe(false);
    expect(view.steps.map((step) => step.label)).toEqual([
      '连接目标', '进入站点目录', '执行项目发布命令', '验证最终入口',
    ]);
  });

  it('失败步以快照为准，不再从最后一条 error 日志倒推', () => {
    const view = resolveReleaseSteps(run({
      status: 'failed',
      // 事故构造：最后一条 error 日志属于 healthcheck（上一阶段的噪声），
      // 但结构化快照说失败在 deploy。旧口径会把失败格点到 healthcheck 上。
      logs: [
        { level: 'error', phase: 'deploy' },
        { level: 'error', phase: 'healthcheck' },
      ],
      progress: {
        planId: 'p1:ssh-script',
        currentStepId: 'deploy',
        steps: [
          { id: 'connect', title: '连接目标', state: 'done' },
          { id: 'deploy', title: '执行项目发布命令', state: 'failed' },
          { id: 'healthcheck', title: '验证最终入口', state: 'pending' },
        ],
      },
    }));

    expect(view.currentIndex).toBe(2);
    expect(view.steps[1].state).toBe('failed');
    expect(view.steps[2].state).toBe('pending');
  });

  it('步骤数量随后端展开而变，前端不再假定固定六格', () => {
    const view = resolveReleaseSteps(run({
      progress: {
        steps: [
          { id: 'connect', title: '连接目标', state: 'done' },
          { id: 'script:a.sh', title: '执行 ./a.sh', state: 'done' },
          { id: 'script:b.sh', title: '执行 ./b.sh', state: 'running' },
        ],
      },
    }));

    expect(view.total).toBe(3);
    expect(view.currentLabel).toBe('执行 ./b.sh');
  });
});

describe('存量 run 优雅退化', () => {
  it('没有 progress 时按日志 phase 给通用骨架，不白屏也不报错', () => {
    const view = resolveReleaseSteps(run({
      status: 'running',
      logs: [{ phase: 'connect' }, { phase: 'prepare' }, { phase: 'script:fast.sh' }],
    }));

    expect(view.degraded).toBe(true);
    expect(view.total).toBe(5);
    expect(view.steps[2]).toMatchObject({ id: 'deploy', state: 'running' });
    expect(view.currentLabel).toBe('执行发布命令');
  });

  it('退化骨架里不出现任何仓库脚本名（硬编码不许借兜底路径复活）', () => {
    const view = resolveReleaseSteps(run({
      status: 'failed',
      logs: [{ phase: 'connect' }, { phase: 'script:exec_dep.sh', level: 'error' }],
    }));

    const labels = view.steps.map((step) => step.label).join('|');
    expect(labels).not.toMatch(/\.sh/);
    // 失败仍要落在一格上，不能整条都是 pending 让用户以为还在跑。
    expect(view.steps.some((step) => step.state === 'failed')).toBe(true);
  });

  it('run 为空时返回空视图，调用方无需自己判空', () => {
    expect(resolveReleaseSteps(null)).toEqual({
      steps: [], currentIndex: 0, total: 0, currentLabel: '', degraded: false,
    });
  });
});
