import { afterEach, describe, expect, it, vi } from 'vitest';
import { createViewportUiSync } from './viewportUiSync';

afterEach(() => vi.useRealTimers());

describe('画布缩放与进度层最终状态同步', () => {
  it('连续缩放结束后补齐最后一次状态，不依赖下一个手势', () => {
    vi.useFakeTimers();
    let zoom = 0.5;
    const sync = vi.fn(() => zoom);
    const scheduler = createViewportUiSync(sync);
    scheduler.schedule();
    vi.advanceTimersByTime(20);
    zoom = 0.72;
    scheduler.schedule();
    vi.advanceTimersByTime(20);
    zoom = 1;
    scheduler.schedule();
    expect(sync).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(40);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveLastReturnedWith(1);
  });

  it('强制同步取消延迟任务，卸载也清理待同步状态', () => {
    vi.useFakeTimers();
    const sync = vi.fn();
    const scheduler = createViewportUiSync(sync);
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule(true);
    vi.advanceTimersByTime(100);
    expect(sync).toHaveBeenCalledTimes(2);
    scheduler.schedule();
    scheduler.schedule();
    scheduler.cancel();
    vi.advanceTimersByTime(100);
    expect(sync).toHaveBeenCalledTimes(3);
  });
});
