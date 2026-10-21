// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InitiationDeleteAction } from './InitiationDeleteAction';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const remove = vi.hoisted(() => vi.fn());
vi.mock('@/services/real/productAgent', () => ({ deleteInitiation: remove }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ content, actions }: { content: ReactNode; actions: ReactNode }) => <div role="dialog">{content}{actions}</div> }));
const host = document.createElement('div');
let root = createRoot(host);
afterEach(async () => { await act(async () => root.unmount()); host.replaceChildren(); root = createRoot(host); vi.clearAllMocks(); });
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === text)?.click()); }

describe('内部版本删除确认', () => {
  it('打开不删除，后续记录的服务端拒绝留在弹窗且不刷新列表', async () => {
    const changed = vi.fn();
    remove.mockResolvedValue({ success: false, error: { code: 'INITIATION_NOT_LATEST', message: '同一应用已有后续 T 号，不能删除。' } });
    await act(async () => root.render(<InitiationDeleteAction id="old" code="T1.2.3" onDeleted={changed} />));
    await click('删除');
    expect(remove).not.toHaveBeenCalled();
    await click('确认删除');
    expect(host.textContent).toContain('已有后续 T 号');
    expect(host.querySelector('[role=dialog]')).not.toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });
  it('服务端成功后才关闭并刷新，取消不发送删除请求', async () => {
    const changed = vi.fn();
    remove.mockResolvedValue({ success: true, data: { deleted: true } });
    await act(async () => root.render(<InitiationDeleteAction id="latest" code="T1.2.4" onDeleted={changed} />));
    await click('删除'); await click('取消');
    expect(remove).not.toHaveBeenCalled();
    await click('删除'); await click('确认删除');
    expect(remove).toHaveBeenCalledWith('latest');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role=dialog]')).toBeNull();
  });
});
