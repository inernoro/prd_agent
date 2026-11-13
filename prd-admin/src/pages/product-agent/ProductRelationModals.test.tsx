// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequirementRelationModal } from './ProductRelationModals';
import type { Requirement } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ listVersions: vi.fn(), listCustomers: vi.fn(), updateRequirement: vi.fn(),
  listTracedDefects: vi.fn(), listLinkableDefects: vi.fn(), traceDefect: vi.fn(), untraceDefect: vi.fn() }));
vi.mock('@/services/real/productAgent', () => api);
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => null, MapSpinner: () => null }));
let root: Root;
let host: HTMLDivElement;
const saved = vi.fn();
const closed = vi.fn();

async function renderModal(versionIds: string[]) {
  await act(async () => root.render(<RequirementRelationModal productId="p1"
    requirement={{ id: 'r1', title: '历史需求', customerIds: [], versionIds } as unknown as Requirement}
    onClose={closed} onSaved={saved} />));
}
async function clickButton(label: string) {
  const button = Array.from(document.body.querySelectorAll('button')).find(el => el.textContent?.trim() === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function toggle(label: string) {
  const row = Array.from(document.body.querySelectorAll('label')).find(el => el.textContent?.includes(label));
  expect(row).toBeDefined();
  await act(async () => row!.querySelector<HTMLInputElement>('input')!.click());
}

beforeEach(() => {
  vi.resetAllMocks();
  api.listVersions.mockResolvedValue({ success: true, data: { items: [{ id: 'v1', versionName: '可用版本' }] } });
  api.listCustomers.mockResolvedValue({ success: true, data: { items: [] } });
  api.listTracedDefects.mockResolvedValue({ success: true, data: { items: [] } });
  api.updateRequirement.mockResolvedValue({ success: true, data: {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('历史需求版本关联恢复', () => {
  it.each(['foreign-version', 'deleted-version', 'missing-version'])('显示并允许显式替换 %s', async id => {
    await renderModal([id]);
    expect(document.body.textContent).toContain('失效的版本关联');
    await clickButton('保存关联');
    expect(api.updateRequirement).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    await toggle('失效的版本关联');
    await toggle('可用版本');
    await clickButton('保存关联');
    expect(api.updateRequirement).toHaveBeenCalledWith('r1', { customerIds: [], versionIds: ['v1'] });
    expect(saved).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('没有可选版本时允许清除历史失效关联', async () => {
    api.listVersions.mockResolvedValue({ success: true, data: { items: [] } });
    await renderModal(['missing-version']);
    await toggle('失效的版本关联');
    await clickButton('保存关联');
    expect(api.updateRequirement).toHaveBeenCalledWith('r1', { customerIds: [], versionIds: [] });
  });

  it('保存被服务端拒绝时保留弹窗和选择，不报告成功', async () => {
    api.updateRequirement.mockResolvedValue({ success: false, error: { message: '版本已失效，请重新选择' } });
    await renderModal(['v1']);
    await clickButton('保存关联');
    expect(saved).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('版本已失效，请重新选择');
    expect(document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  });

  it('加载失败时不会误删旧关联，重试成功后才允许修复', async () => {
    api.listVersions.mockResolvedValueOnce({ success: false, error: { message: '暂不可用' } });
    await renderModal(['v1']);
    await clickButton('保存关联');
    expect(api.updateRequirement).not.toHaveBeenCalled();
    await clickButton('重新加载版本');
    expect(document.body.textContent).not.toContain('失效的版本关联');
    await clickButton('保存关联');
    expect(api.updateRequirement).toHaveBeenCalledWith('r1', { customerIds: [], versionIds: ['v1'] });
  });
});
