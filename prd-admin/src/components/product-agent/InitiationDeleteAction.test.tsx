// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InitiationDeleteAction, ReleaseDeleteAction } from './InitiationDeleteAction';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const remove = vi.hoisted(() => vi.fn());
const removeRelease = vi.hoisted(() => vi.fn());
vi.mock('@/services/real/productAgent', () => ({ deleteInitiation: remove, deleteRelease: removeRelease }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ content, actions }: { content: ReactNode; actions: ReactNode }) => <div role="dialog">{content}{actions}</div> }));
const host = document.createElement('div');
let root = createRoot(host);
afterEach(async () => { await act(async () => root.unmount()); host.replaceChildren(); root = createRoot(host); vi.clearAllMocks(); });
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === text)?.click()); }

async function fillReason(value = '重复申领需要作废') {
  await act(async () => {
    const input = host.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('T/V版本作废与理由', () => {
  it.each(['T', 'V'])('%s号必须填写超过5个字符，取消不作废，点击不触发行导航', async (prefix) => {
    const changed = vi.fn();
    const navigate = vi.fn();
    const Action = prefix === 'T' ? InitiationDeleteAction : ReleaseDeleteAction;
    const request = prefix === 'T' ? remove : removeRelease;
    request.mockResolvedValue({ success: true, data: { deleted: true } });
    await act(async () => root.render(<div onClick={navigate}><Action id="record" code={`${prefix}1.2.3`} canDelete onDeleted={changed} /></div>));
    await click('作废');
    expect(navigate).not.toHaveBeenCalled();
    const confirm = () => [...host.querySelectorAll('button')].find((button) => button.textContent === '确认作废')!;
    for (const text of ['', '      ', '一二三四五', '  一二三四五  ']) {
      await fillReason(text);
      expect(confirm().disabled).toBe(true);
      await click('确认作废');
      expect(request).not.toHaveBeenCalled();
    }
    await fillReason('  一二三四五六  ');
    expect(confirm().disabled).toBe(false);
    await click('确认作废');
    expect(request).toHaveBeenCalledWith('record', '一二三四五六');
    expect(changed).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('正式版本复用相同确认并调用对应接口，未授权记录隐藏入口', async () => {
    const changed = vi.fn();
    removeRelease.mockResolvedValue({ success: true, data: { deleted: true } });
    await act(async () => root.render(<ReleaseDeleteAction id="v-old" code="V1.2.2" canDelete={false} onDeleted={changed} />));
    expect(host.querySelector('button')).toBeNull();
    await act(async () => root.render(<ReleaseDeleteAction id="v-latest" code="V1.2.3" canDelete onDeleted={changed} />));
    await click('作废');
    expect(removeRelease).not.toHaveBeenCalled();
    expect(host.textContent).toContain('原T资料保留');
    expect(host.textContent).toContain('按所属应用仍保留的最新有效版本发号');
    expect(host.textContent).not.toContain('编号不会回收');
    await fillReason(); await click('确认作废');
    expect(removeRelease).toHaveBeenCalledTimes(1);
    expect(removeRelease).toHaveBeenCalledWith('v-latest', '重复申领需要作废');
    expect(changed).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
  });
  it.each([false, undefined])('服务端未授予删除资格时不显示入口（%s）', async (canDelete) => {
    await act(async () => root.render(<InitiationDeleteAction id="old" code="T1.2.3" canDelete={canDelete} onDeleted={vi.fn()} />));
    expect(host.querySelector('button')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
  });
  it('打开不删除，后续记录的服务端拒绝留在弹窗且不刷新列表', async () => {
    const changed = vi.fn();
    remove.mockResolvedValue({ success: false, error: { code: 'INITIATION_NOT_LATEST', message: '全局已有后续 T 号，不能删除。' } });
    await act(async () => root.render(<InitiationDeleteAction id="old" code="T1.2.3" canDelete onDeleted={changed} />));
    await click('作废');
    expect(remove).not.toHaveBeenCalled();
    await fillReason(); await click('确认作废');
    expect(host.textContent).toContain('已有后续 T 号');
    expect(host.querySelector('[role=dialog]')).not.toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });
  it('服务端成功后才关闭并刷新，取消不发送删除请求', async () => {
    const changed = vi.fn();
    remove.mockResolvedValue({ success: true, data: { deleted: true } });
    await act(async () => root.render(<InitiationDeleteAction id="latest" code="T1.2.4" canDelete onDeleted={changed} />));
    await click('作废'); await click('取消');
    expect(remove).not.toHaveBeenCalled();
    await click('作废'); await fillReason(); await click('确认作废');
    expect(remove).toHaveBeenCalledWith('latest', '重复申领需要作废');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role=dialog]')).toBeNull();
  });
});
