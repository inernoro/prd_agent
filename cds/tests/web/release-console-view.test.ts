import { describe, expect, it } from 'vitest';
import { detectStall, resolveStepDetails, STALL_THRESHOLD_MS } from '../../web/src/lib/releaseConsoleView.js';

/**
 * 发布控制台两个展示判据的用例。
 *
 * 卡住判定是用户那句抱怨的直接答复——「点击之后就卡住没后续了，到底是否成功，
 * 我们不清楚」。它错报的代价是把慢步骤说成卡住，漏报的代价是抱怨原样复现，
 * 所以边界（恰好等于阈值、时间戳解析不出来、终态）都要钉住。
 */

const PLAN = {
  id: 'plan_ssh',
  steps: [
    { id: 'connect', title: '连接服务器', command: 'ssh -o BatchMode=yes root@h true' },
    { id: 'deploy', title: '执行发布命令', command: './exec_dep.sh --prod' },
    { id: 'record', title: '标记完成' },
  ],
};

function run(overrides: Record<string, unknown> = {}): Parameters<typeof resolveStepDetails>[0] {
  return {
    progress: {
      planId: 'plan_ssh',
      steps: [
        { id: 'connect', title: '连接服务器', state: 'done', startedAt: '2026-07-29T16:07:00Z', finishedAt: '2026-07-29T16:07:04Z' },
        { id: 'deploy', title: '执行发布命令', state: 'failed', startedAt: '2026-07-29T16:07:04Z', finishedAt: '2026-07-29T16:08:35Z' },
        { id: 'record', title: '标记完成', state: 'pending' },
      ],
      ...overrides,
    },
  } as Parameters<typeof resolveStepDetails>[0];
}

describe('步骤详情 · 命令与耗时', () => {
  it('按 step.id 把计划里的命令挂到本次运行的步骤上', () => {
    const details = resolveStepDetails(run(), [PLAN]);
    expect(details.get('connect')?.command).toBe('ssh -o BatchMode=yes root@h true');
    expect(details.get('deploy')?.command).toBe('./exec_dep.sh --prod');
  });

  it('耗时来自真实起止时间；没跑完的步骤不给耗时（UI 显示短横）', () => {
    const details = resolveStepDetails(run(), [PLAN]);
    expect(details.get('connect')?.durationMs).toBe(4000);
    expect(details.get('deploy')?.durationMs).toBe(91_000);
    expect(details.get('record')?.durationMs).toBeUndefined();
  });

  /**
   * 最要紧的一条：planId 对不上就不能拿另一份计划的命令顶上。
   * 界面上写着「这一步跑的是 X」而实际跑的是 Y，比不显示命令危险得多。
   */
  it('planId 对不上时一条命令都不给，不拿同类型的别的计划顶替', () => {
    const details = resolveStepDetails(run({ planId: 'plan_other' }), [PLAN]);
    expect(details.get('connect')?.command).toBe('');
    expect(details.get('deploy')?.command).toBe('');
    // 耗时与计划无关，照常给
    expect(details.get('connect')?.durationMs).toBe(4000);
  });

  it('计划里没有的步骤 id 不会凭空拿到命令', () => {
    const details = resolveStepDetails(run(), [{ id: 'plan_ssh', steps: [{ id: '别的步骤', command: 'rm -rf /' }] }]);
    expect(details.get('connect')?.command).toBe('');
    expect([...details.values()].some((d) => d.command.includes('rm -rf'))).toBe(false);
  });

  it('没有 progress 的历史 run 返回空表，不报错', () => {
    expect(resolveStepDetails({}, [PLAN]).size).toBe(0);
    expect(resolveStepDetails(null, [PLAN]).size).toBe(0);
  });
});

describe('卡住判定 · 久无输出', () => {
  const START = Date.parse('2026-07-29T16:07:00Z');

  it('还在跑且超过阈值没有新输出 → 判卡住，并给出静默了多久', () => {
    const v = detectStall({
      running: true,
      lastLogAt: '2026-07-29T16:07:00Z',
      nowMs: START + 60_000,
    });
    expect(v.stalled).toBe(true);
    expect(v.silentMs).toBe(60_000);
  });

  it('刚有输出不算卡住', () => {
    expect(detectStall({ running: true, lastLogAt: '2026-07-29T16:07:00Z', nowMs: START + 5_000 }).stalled).toBe(false);
  });

  it('恰好等于阈值就算卡住（边界包含，免得在 44.9 秒上反复横跳）', () => {
    expect(detectStall({ running: true, lastLogAt: '2026-07-29T16:07:00Z', nowMs: START + STALL_THRESHOLD_MS }).stalled).toBe(true);
  });

  it('一条日志都还没有时用发布开始时间当基准——「一条都没吐」正是最该报的那种卡住', () => {
    const v = detectStall({ running: true, startedAt: '2026-07-29T16:07:00Z', nowMs: START + 90_000 });
    expect(v.stalled).toBe(true);
    expect(v.silentMs).toBe(90_000);
  });

  it('已经跑完的发布永远不判卡住', () => {
    expect(detectStall({ running: false, lastLogAt: '2026-07-29T16:07:00Z', nowMs: START + 999_000 }).stalled).toBe(false);
  });

  /** 时间戳解析不出来时宁可不提示，也不给一个凭空算出来的秒数。 */
  it('时间戳无法解析时不报卡住', () => {
    expect(detectStall({ running: true, lastLogAt: '不是时间', nowMs: START + 999_000 }).stalled).toBe(false);
    expect(detectStall({ running: true, nowMs: START + 999_000 }).stalled).toBe(false);
  });

  it('时钟回拨不会算出负的静默时长', () => {
    expect(detectStall({ running: true, lastLogAt: '2026-07-29T16:07:00Z', nowMs: START - 10_000 }).silentMs).toBe(0);
  });
});
