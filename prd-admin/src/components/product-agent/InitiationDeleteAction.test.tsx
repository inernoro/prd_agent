// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InitiationDeleteAction, ReleaseDeleteAction } from './InitiationDeleteAction';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ t: vi.fn(), v: vi.fn(), void: vi.fn() }));
vi.mock('@/services/real/productAgent', () => ({ deleteInitiation: api.t, deleteRelease: api.v, voidProductVersion: api.void }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ title, content, actions }: { title: ReactNode; content: ReactNode; actions: ReactNode }) => <div role="dialog"><h3>{title}</h3>{content}{actions}</div> }));
const host = document.createElement('div'); let root = createRoot(host);
afterEach(async () => { await act(async () => root.unmount()); host.replaceChildren(); root = createRoot(host); vi.clearAllMocks(); });
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === text)?.click()); }
async function fill(value = '项目方案调整作废') { await act(async () => {
  const input = host.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}); }
const button = (text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === text);
describe('作废与删除是独立动作', () => {
  it.each(['T', 'V'])('%s历史记录始终有作废，只有服务端授予资格才显示删除', async (kind) => {
    const Action = kind === 'T' ? InitiationDeleteAction : ReleaseDeleteAction;
    await act(async () => root.render(<Action id="old" code={`${kind}1.2.3`} canDelete={false} onDeleted={vi.fn()} />));
    expect(button('作废')).toBeDefined(); expect(button('删除')).toBeUndefined();
    await act(async () => root.render(<Action id="new" code={`${kind}1.2.4`} canDelete onDeleted={vi.fn()} />));
    expect(button('作废')).toBeDefined(); expect(button('删除')).toBeDefined();
  });
  it.each(['T', 'V'])('%s作废只调用独立接口，5字不通过、6字可提交且不触发行导航', async (kind) => {
    const Action = kind === 'T' ? InitiationDeleteAction : ReleaseDeleteAction; const changed = vi.fn(); const navigate = vi.fn();
    api.void.mockResolvedValue({ success: true, data: { voided: true } });
    await act(async () => root.render(<div onClick={navigate}><Action id="old" code={`${kind}1.2.3`} canDelete={false} onDeleted={changed} /></div>));
    await click('作废'); expect(navigate).not.toHaveBeenCalled(); expect(host.textContent).toContain('保留记录、编号和理由');
    for (const reason of ['', '      ', '一二三四五', '  一二三四五  ']) {
      await fill(reason); expect(button('确认作废')!.disabled).toBe(true); await click('确认作废'); expect(api.void).not.toHaveBeenCalled();
    }
    await fill('  一二三四五六  '); expect(button('确认作废')!.disabled).toBe(false); await click('确认作废');
    expect(api.void).toHaveBeenCalledWith(kind, 'old', '一二三四五六');
    expect(api.t).not.toHaveBeenCalled(); expect(api.v).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledOnce(); expect(navigate).not.toHaveBeenCalled();
  });
  it.each(['T', 'V'])('%s删除保留确认和理由，只调用物理删除接口', async (kind) => {
    const Action = kind === 'T' ? InitiationDeleteAction : ReleaseDeleteAction; const remove = kind === 'T' ? api.t : api.v;
    remove.mockResolvedValue({ success: true, data: { deleted: true } }); const changed = vi.fn();
    await act(async () => root.render(<Action id="latest" code={`${kind}1.2.4`} canDelete onDeleted={changed} />));
    await click('删除'); expect(host.textContent).toContain('该应用最新'); expect(remove).not.toHaveBeenCalled();
    await fill(); await click('确认删除'); expect(remove).toHaveBeenCalledWith('latest', '项目方案调整作废');
    expect(api.void).not.toHaveBeenCalled(); expect(changed).toHaveBeenCalledOnce(); expect(host.querySelector('[role=dialog]')).toBeNull();
  });
  it('服务端拒绝保留理由与弹窗，取消不提交', async () => {
    api.void.mockResolvedValue({ success: false, error: { message: '仅申请人或管理人员可作废' } }); const changed = vi.fn();
    await act(async () => root.render(<InitiationDeleteAction id="old" code="T1.2.3" onDeleted={changed} />));
    await click('作废'); await click('取消'); expect(api.void).not.toHaveBeenCalled();
    await click('作废'); await fill(); await click('确认作废');
    expect(host.querySelector('textarea')?.value).toBe('项目方案调整作废'); expect(host.textContent).toContain('仅申请人或管理人员'); expect(changed).not.toHaveBeenCalled();
  });
  it('已作废保留理由提示并禁用重复操作，最新记录仍可删除', async () => {
    await act(async () => root.render(<ReleaseDeleteAction id="v" code="V1.2.3" status="voided" voidReason="方案已经取消作废" canDelete onDeleted={vi.fn()} />));
    expect(button('已作废')!.disabled).toBe(true); expect(button('已作废')!.title).toBe('方案已经取消作废'); expect(button('删除')).toBeDefined();
  });
});
