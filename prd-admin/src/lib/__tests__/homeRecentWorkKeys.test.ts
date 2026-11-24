import { describe, expect, it } from 'vitest';
import type { RecentWorkItemDto } from '@/services/contracts/homeRecentWork';
import { withRecentWorkReactKeys } from '@/lib/homeRecentWorkKeys';

function work(overrides: Partial<RecentWorkItemDto> = {}): RecentWorkItemDto {
  return {
    agentKey: 'document-store',
    route: '/document-store',
    title: '产品资料',
    lastActiveAt: '2026-09-05T08:00:00Z',
    ...overrides,
  };
}

describe('withRecentWorkReactKeys', () => {
  it('相同智能体和路径的不同工作仍生成不同且稳定的 key', () => {
    const items = [
      work(),
      work({ title: '设计资料', lastActiveAt: '2026-09-05T08:01:00Z' }),
    ];

    const first = withRecentWorkReactKeys(items).map((entry) => entry.reactKey);
    const second = withRecentWorkReactKeys(items).map((entry) => entry.reactKey);

    expect(new Set(first).size).toBe(items.length);
    expect(second).toEqual(first);
  });

  it('业务字段完全重复时使用出现次序兜底，避免 React duplicate key', () => {
    const item = work();
    const keys = withRecentWorkReactKeys([item, item, item]).map((entry) => entry.reactKey);

    expect(new Set(keys).size).toBe(3);
    expect(keys[1]).toBe(`${keys[0]}#1`);
    expect(keys[2]).toBe(`${keys[0]}#2`);
  });
});
