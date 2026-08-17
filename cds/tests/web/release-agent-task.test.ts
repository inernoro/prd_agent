import { describe, expect, it } from 'vitest';
import { buildReleaseAgentTask } from '../../web/src/lib/releaseAgentTask.js';
import type { ReleaseDiagnosisLogLike } from '../../web/src/lib/releaseDiagnosis.js';

/**
 * 「复制现场交给智能体」的文本判据。
 *
 * 这段文本会被原样粘给另一个 agent 去动生产发布链路，所以它撒的谎代价最大：
 * 编一个像样的失败原因，收件 agent 就会照着改一通没坏的代码。这里钉三件事——
 * 结论转述自真实日志、影响面必须由数据推出、噪音要点名不许当线索。
 *
 * 数据照抄 2026-07-29 那次真实失败（rel_3c72935be772e798）。
 */

const fmtDateTime = (value?: string): string => (value ? value.replace('T', ' ').replace('Z', '') : '');
const fmtDuration = (start?: string, end?: string): string => (start && end ? '1m55s' : '');

function gateReportJson(): string {
  return JSON.stringify({
    verdict: 'fail',
    checks: [
      { name: 'map_health', ok: true, detail: JSON.stringify({ status: 200 }) },
      { name: 'gateway_key_configured', ok: true, detail: 'keyEnv=LLMGW_GATE_KEY' },
      { name: 'gateway_route_self_test', ok: false, detail: JSON.stringify({ status: 401, keyEnv: 'LLMGW_GATE_KEY' }) },
    ],
  }, null, 2);
}

function failedLogs(): ReleaseDiagnosisLogLike[] {
  return [
    { level: 'info', message: 'Preparing worktree (detached HEAD 307301a)' },
    { level: 'warn', message: 'context canceled' },
    { level: 'warn', message: 'WARN: api image warmup skipped or timed out after 30s' },
    ...gateReportJson().split('\n').map((message) => ({ level: 'info' as const, message })),
  ];
}

const RUN = {
  releaseId: 'rel_3c72935be772e798',
  commitSha: '307301aac0de0000000000000000000000000000',
  status: 'failed',
  startedAt: '2026-07-29T16:07:00Z',
  finishedAt: '2026-07-29T16:08:55Z',
};

const TARGET = { name: '生产站点', host: 'map.example.test' };
/** 目标停在 1b751ad，本次失败的是 307301a —— 两者不同才敢说「生产未受影响」。 */
const CURRENT_COMMIT = '1b751ad0000000000000000000000000000000aa';

function build(overrides: Partial<Parameters<typeof buildReleaseAgentTask>[0]> = {}): string {
  return buildReleaseAgentTask({
    run: RUN,
    target: TARGET,
    currentCommit: CURRENT_COMMIT,
    logs: failedLogs(),
    failed: true,
    formatDateTime: fmtDateTime,
    formatDuration: fmtDuration,
    ...overrides,
  });
}

describe('发布现场交给智能体 · 文本判据', () => {
  it('结论与未通过的门禁项转述自日志，不是空话', () => {
    const text = build();
    expect(text).toContain('gateway_route_self_test');
    expect(text).toContain('3 项检查，未通过 1 项');
    expect(text).toContain('{"status":401,"keyEnv":"LLMGW_GATE_KEY"}');
  });

  it('目标停在别的版本时才说「生产未受影响」，并写出它停在哪一版', () => {
    const text = build();
    expect(text).toContain('生产未受影响');
    expect(text).toContain('1b751ad');
  });

  it('目标当前就跑着这一版时改口「待确认」，不给假的安全感', () => {
    const text = build({ currentCommit: RUN.commitSha });
    expect(text).not.toContain('生产未受影响');
    expect(text).toContain('待确认');
  });

  it('取不到目标当前版本时同样不许下「未受影响」的结论', () => {
    const text = build({ currentCommit: '' });
    expect(text).not.toContain('生产未受影响');
    expect(text).toContain('待确认');
  });

  it('噪音点名成「不是失败原因」，免得收件 agent 追着 context canceled 查一轮', () => {
    const text = build();
    expect(text).toContain('已知噪音，不是失败原因');
    expect(text).toContain('context canceled');
  });

  /**
   * 最要紧的一条：日志里啥都提不出来时，文本必须如实说「未能提取」，
   * 而不是拼一个读起来很像回事的原因。红绿闭环验过：把 headline 换成
   * 兜底文案以外的任何猜测句，这条立刻红。
   */
  it('日志提不出判据时如实说「未能提取」，不编原因', () => {
    const text = build({ logs: [{ level: 'info', message: 'Preparing worktree' }] });
    expect(text).toContain('未能从日志中提取到结构化判据');
    expect(text).not.toContain('门禁');
  });

  it('给收件 agent 的护栏在：先证实再改、别顺手改发布流程', () => {
    const text = build();
    expect(text).toContain('先证实再改');
    expect(text).toContain('不顺手改发布流程其他部分');
  });

  it('成功的运行不写成「发布失败」', () => {
    const text = build({ failed: false, run: { ...RUN, status: 'success' } });
    expect(text.split('\n')[0]).toBe('CDS 发布现场，请核对。');
  });
});
