import { describe, expect, it, vi } from 'vitest';
import { restoreRevisionMutationFocus } from './SiteEditPanel';

function target(isConnected: boolean) {
  return { isConnected, focus: vi.fn() };
}

describe('版本操作焦点恢复', () => {
  it('确认完成后优先回到仍存在的触发按钮', () => {
    const primary = target(true);
    const fallback = target(true);

    restoreRevisionMutationFocus(primary, fallback, (callback) => callback());

    expect(primary.focus).toHaveBeenCalledOnce();
    expect(fallback.focus).not.toHaveBeenCalled();
  });

  it('版本卡卸载时回到可聚焦的版本记录区', () => {
    const primary = target(false);
    const fallback = target(true);

    restoreRevisionMutationFocus(primary, fallback, (callback) => callback());

    expect(primary.focus).not.toHaveBeenCalled();
    expect(fallback.focus).toHaveBeenCalledOnce();
  });
});
