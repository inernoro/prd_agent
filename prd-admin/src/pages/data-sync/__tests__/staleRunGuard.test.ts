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
});
