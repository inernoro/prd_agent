/**
 * Codex review（PR #1532）第六轮的前端一条：我上一轮自己引入的回归。
 *
 * 上一轮为了「台账空也要渲染流水线」加了个 pipelineHasSomething，
 * 而它在流水线**加载中 / 加载失败**时同样为假，于是那张干净的空卡片会把
 * 「正在汇总」和「汇总失败 + 重试」一起吞掉：一次持续失败的聚合看起来就像
 * 本来就没有数据，连重试按钮都够不着。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(__dirname, '../..', 'web/src/pages/ReportsPage.tsx'), 'utf8');
const block = page.slice(page.indexOf('const pipelineSettledEmpty'), page.indexOf('return (\n    <div className="flex flex-col gap-6 pb-8">'));

describe('让位给空状态的条件：必须是「成功地报了零」', () => {
  it('判据落在 status === ok 且 changes === 0 上，不是「不满足有东西」', () => {
    // 写成 !pipelineHasSomething 的话，loading 与 error 都会顺带满足它。
    expect(block, '判据没要求流水线已经成功返回').toMatch(/pipelineState\.status === 'ok'/);
    expect(block, '判据没要求它真的报了零').toMatch(/total\.changes === 0/);
    expect(block, '又退回了「不满足有东西」的反向判据').not.toMatch(/!pipelineHasSomething/);
  });

  it('非首页作用域不受这条限制：那里本来就不渲染流水线', () => {
    expect(block).toMatch(/!isGlobalScope/);
  });

  it('加载与失败两块仍然在流水线分支里，带重试按钮', () => {
    const globalBranch = page.slice(page.indexOf('{isGlobalScope ? ('), page.indexOf('<section id="reports-ledger"'));
    expect(globalBranch).toContain('正在汇总验收流水线');
    expect(globalBranch).toContain('流水线汇总加载失败');
    expect(globalBranch).toMatch(/onClick=\{onRetryOverview\}/);
  });
});
