// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginEntryArrival, finishEntryArrival } from './entryArrival';
afterEach(() => { finishEntryArrival(); vi.useRealTimers(); });
describe('片头与应用导航的衔接', () => {
  it('开始后标记入场，完成后恢复；重复开始替换旧截止时间', () => {
    vi.useFakeTimers(); beginEntryArrival();
    expect(document.documentElement.hasAttribute('data-entry-arriving')).toBe(true);
    vi.advanceTimersByTime(5000); beginEntryArrival(); vi.advanceTimersByTime(5001);
    expect(document.documentElement.hasAttribute('data-entry-arriving')).toBe(true);
    finishEntryArrival();
    expect(document.documentElement.hasAttribute('data-entry-arriving')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('场景未完成或失败时十秒兜底，避免遮住导航', () => {
    vi.useFakeTimers(); beginEntryArrival(); vi.advanceTimersByTime(10000);
    expect(document.documentElement.hasAttribute('data-entry-arriving')).toBe(false);
  });
});
