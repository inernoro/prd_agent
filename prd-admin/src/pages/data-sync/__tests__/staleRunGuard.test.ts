import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { shouldApplyRun } from '../staleRunGuard';

/**
 * 换 Run 之后，上一条流迟到的那一帧不许画到新地址下。
 *
 * reset() 断流与「已经在管道里的那一帧」之间有窗口，所以入口再判一次。
 */
describe('shouldApplyRun', () => {
  it('同一条 Run 的事件照收', () => {
    expect(shouldApplyRun('run-a', 'run-a')).toBe(true);
  });

  it('上一条 Run 迟到的事件丢掉', () => {
    expect(shouldApplyRun('run-a', 'run-b')).toBe(false);
  });

  it('已经离开详情页（没有当前 Run）时也丢掉', () => {
    expect(shouldApplyRun('run-a', '')).toBe(false);
  });

  /**
   * 载荷没带 runId 时**不拦**。拦了会把「服务端少发一个字段」变成「页面永远不更新」——
   * 那是比串号更难查的故障。真正的隔离靠 reset()，这里只是第二道。
   */
  it('载荷没带 runId 时不拦', () => {
    expect(shouldApplyRun(undefined, 'run-b')).toBe(true);
    expect(shouldApplyRun('', 'run-b')).toBe(true);
  });

  it('页面真的用了它，而不是在回调里另写一遍', () => {
    const source = readFileSync(new URL('../DataSyncPage.tsx', import.meta.url), 'utf8');
    expect(source).toContain("import { shouldApplyRun } from './staleRunGuard'");
    expect(source).toContain('if (!shouldApplyRun(incoming?.runId, currentRunIdRef.current)) return;');
  });

  /**
   * 断流重连补的那一枪快照也要认。
   *
   * 换 Run 时的 reset 只断得了 SSE，断不了这条已经发出去的 GET。它回来时若不认一认：
   * A 的快照会无条件盖掉 B 的 state；更糟的是紧接着那句 `sse.start()` 是**当时那次
   * 渲染的闭包**，url 里烤的是 A，一调就把 hook 拉回去流 A，B 的流从此起不来。
   */
  it('重连补的快照按发起时那条 Run 认，过期就整个丢掉', () => {
    const source = readFileSync(new URL('../DataSyncPage.tsx', import.meta.url), 'utf8');
    const effect = source.slice(source.indexOf('const scheduledFor = runId;'));
    const body = effect.slice(0, effect.indexOf('return () => window.clearTimeout(timer);'));

    // 守卫要排在**所有**副作用之前：setRun、排下一轮、start 那条流，一个都不许漏。
    const guardAt = body.indexOf('if (!shouldApplyRun(scheduledFor, currentRunIdRef.current)) return;');
    expect(guardAt).toBeGreaterThan(-1);
    for (const effectCall of ['setRun(res.data)', 'setReconnectTick', 'sse.start()']) {
      expect(body.indexOf(effectCall)).toBeGreaterThan(guardAt);
    }
  });
});
