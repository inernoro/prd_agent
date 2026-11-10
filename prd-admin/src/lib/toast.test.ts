import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast, useToastStore } from './toast';

describe('失败通知去重', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('同一错误同时只保留一条，消失后允许再次提示', () => {
    for (let i = 0; i < 3; i++) toast.error('润色未完成', '请联系管理员');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    toast.error('润色未完成', '请联系管理员');
    expect(useToastStore.getState().toasts).toHaveLength(1);
  });

  it('不同错误和需要独立操作的通知不合并', () => {
    toast.error('润色未完成');
    toast.error('提交未完成');
    toast.action('润色未完成', { type: 'error', action: { label: '查看', onClick: vi.fn() } });
    expect(useToastStore.getState().toasts).toHaveLength(3);
  });

  it('去重返回同一通知身份，恢复时只撤销本次失败反馈', () => {
    toast.info('其他任务仍在处理');
    const first = toast.error('提交结果待确认');
    const replay = toast.error('提交结果待确认');
    expect(first).toEqual(expect.any(String));
    expect(replay).toBe(first);
    toast.dismiss(first);
    expect(useToastStore.getState().toasts.map((item) => item.title)).toEqual(['其他任务仍在处理']);
  });
});
