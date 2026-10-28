// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseEditAction } from './ReleaseEditAction';
import type { ProductRelease } from '@/pages/product-agent/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ updateRelease: vi.fn() }));
vi.mock('@/services/real/productAgent', () => api);
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ title, content, actions }: { title: ReactNode; content: ReactNode; actions: ReactNode }) => <div role="dialog"><h3>{title}</h3>{content}{actions}</div> }));
vi.mock('@/components/UserSearchSelect', () => ({ UserSearchSelect: ({ value, onChange, placeholder }: { value: string; onChange: (id: string) => void; placeholder: string }) => <input placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} /> }));
const release: ProductRelease = { id: 'v', productId: 'app', initiationId: 't', tCode: 'T1.2.3', vCode: 'V1.2.4', planName: '当前V方案', ownerId: 'me', teamMemberIds: ['me'], requirementIds: [], projectType: 'standard', versionType: 'minor', isTemporaryOptimization: false, isGlobalOpen: true, openBrandScope: '全域开放', status: 'released', createdBy: 'me', sourceType: 'system', createdAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T01:00:00Z', plannedTrainingMinutes: 30, remark: '原备注' };
let host: HTMLDivElement; let root: Root;
const saved = vi.fn(); const navigate = vi.fn();
const button = (label: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
async function change(label: string, value: string) {
  const control = [...host.querySelectorAll('label')].find((item) => item.textContent?.startsWith(label))!.querySelector('input,textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(control, value);
    control.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function mount(value = release) { await act(async () => root.render(<div onClick={navigate}><ReleaseEditAction release={value} userNames={new Map([['me', '申请人']])} onSaved={saved} /></div>)); }
beforeEach(() => { vi.clearAllMocks(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); api.updateRelease.mockResolvedValue({ success: true, data: { ...release, remark: '新备注' } }); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('正式版本资料编辑', () => {
  it('立即回填当前V资料，取消不保存、不触发行跳转', async () => {
    await mount(); await click('编辑');
    expect(host.querySelector('[role=dialog] h3')?.textContent).toBe('编辑正式版本资料');
    expect(host.querySelector<HTMLInputElement>('label input')?.value).toBe('当前V方案');
    expect(button('保存修改').disabled).toBe(true); expect(navigate).not.toHaveBeenCalled();
    await click('取消'); expect(api.updateRelease).not.toHaveBeenCalled(); expect(host.querySelector('[role=dialog]')).toBeNull();
  });
  it('只发送变更资料和原版本凭证，保存成功关闭并刷新，不传T号或应用编号字段', async () => {
    await mount(); await click('编辑'); await change('备注', ' 新备注 '); await click('保存修改');
    expect(api.updateRelease).toHaveBeenCalledWith('v', { expectedUpdatedAt: release.updatedAt, remark: '新备注' });
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({ id: 'v', remark: '新备注' }));
    expect(host.querySelector('[role=dialog]')).toBeNull(); expect(navigate).not.toHaveBeenCalled();
  });
  it('保存失败保留修改内容及后台原因', async () => {
    api.updateRelease.mockResolvedValue({ success: false, error: { message: '记录已更新，请刷新后重新编辑' } });
    await mount(); await click('编辑'); await change('备注', '我的修改'); await click('保存修改');
    expect(host.querySelector('[role=alert]')?.textContent).toContain('记录已更新');
    expect([...host.querySelectorAll('textarea')].some((item) => item.value === '我的修改')).toBe(true);
    expect(saved).not.toHaveBeenCalled();
  });
  it('空方案名称或负培训时长均不能保存', async () => {
    await mount(); await click('编辑'); await change('产品立项方案名称', '  '); await click('保存修改');
    expect(host.textContent).toContain('方案名称不能为空'); expect(api.updateRelease).not.toHaveBeenCalled();
    await change('产品立项方案名称', release.planName); await change('预计培训时长', '-1'); await click('保存修改');
    expect(host.textContent).toContain('非负整数分钟'); expect(api.updateRelease).not.toHaveBeenCalled();
  });
  it('重复点击只提交一次，等待期间禁止取消', async () => {
    let finish!: (value: unknown) => void;
    api.updateRelease.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await mount(); await click('编辑'); await change('备注', '新的更正');
    await act(async () => { button('保存修改').click(); button('保存修改').click(); });
    expect(api.updateRelease).toHaveBeenCalledOnce(); expect(button('取消').disabled).toBe(true);
    await act(async () => finish({ success: true, data: release })); expect(saved).toHaveBeenCalledOnce();
  });
  it('打开后固定原记录凭证，列表更新不能悄悄覆盖并发修改', async () => {
    await mount(); await click('编辑'); await change('备注', '正在输入');
    await mount({ ...release, updatedAt: '2026-10-28T02:00:00Z', planName: '他人已修改' });
    await click('保存修改');
    expect(api.updateRelease).toHaveBeenCalledWith('v', { expectedUpdatedAt: release.updatedAt, remark: '正在输入' });
  });
});
