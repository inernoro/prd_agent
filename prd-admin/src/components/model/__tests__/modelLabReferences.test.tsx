// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelPickerDialog } from '@/pages/lab-llm/components/ModelPickerDialog';
import { deleteModelLabGroup, getModelLabModelOptions, listModelLabGroups, upsertModelLabGroup } from '@/services';
import type { ModelLabSelectedModel } from '@/services/contracts/modelLab';

vi.mock('@/services', () => ({ deleteModelLabGroup: vi.fn(), getModelLabModelOptions: vi.fn(), listModelLabGroups: vi.fn(), upsertModelLabGroup: vi.fn() }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ open, title, content, actions }: { open: boolean; title: string; content: React.ReactNode; actions: React.ReactNode }) => open ? <div role="dialog"><h2>{title}</h2>{content}{actions}</div> : null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <span>正在读取</span>, MapSpinner: () => <span>正在核对</span> }));
const ok = <T,>(data: T) => ({ success: true as const, data, error: null });
const legacy: ModelLabSelectedModel = { platformId: 'deleted-provider', modelId: 'old-model', modelName: 'old-model', name: '原模型', modelReferenceStatus: 'legacy', modelReferenceReason: '旧平台不存在' };
const image = { logicalModelId: 'logical-image', publicId: 'image-quality', name: '绘图模型', available: true };
let host: HTMLDivElement;
let root: Root;
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
async function click(label: string) { await act(async () => button(label).click()); }
async function pick() { await act(async () => host.querySelector<HTMLInputElement>('[aria-label="选择模型 绘图模型 image-quality"]')!.click()); await click('确认选择'); }

beforeEach(() => {
  vi.clearAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(getModelLabModelOptions).mockResolvedValue(ok({ items: [image] }));
  vi.mocked(listModelLabGroups).mockResolvedValue(ok({ items: [] }));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('实验室持久模型引用', () => {
  it('旧引用保留并阻止加入实验，用户明确修复后才提交逻辑身份', async () => {
    const confirm = vi.fn();
    await act(async () => root.render(<ModelPickerDialog open purpose="image" selectedModels={[legacy]} onOpenChange={vi.fn()} onConfirm={confirm} />));
    expect(getModelLabModelOptions).toHaveBeenCalledWith('image');
    expect(host.textContent).toContain('old-model');
    expect(host.textContent).toContain('模型引用需修复');
    expect(button('加入到本次实验').disabled).toBe(true);
    await click('修复引用'); await pick();
    await click('加入到本次实验');
    expect(confirm).toHaveBeenCalledWith([expect.objectContaining({ logicalModelId: 'logical-image', modelId: 'image-quality', platformId: 'logical-model' })]);
    expect(deleteModelLabGroup).not.toHaveBeenCalled();
  });

  it('分组原位保存保留分组id，不删除重建，也不把重命名当迁移', async () => {
    vi.mocked(listModelLabGroups).mockResolvedValue(ok({ items: [{ id: 'keep-group', ownerAdminId: 'admin', name: '旧组', models: [legacy], createdAt: '', updatedAt: '' }] }));
    vi.mocked(upsertModelLabGroup).mockResolvedValue(ok({ id: 'keep-group', ownerAdminId: 'admin', name: '旧组', models: [], createdAt: '', updatedAt: '' }));
    await act(async () => root.render(<ModelPickerDialog open selectedModels={[]} onOpenChange={vi.fn()} onConfirm={vi.fn()} />));
    await click('按现有分组添加');
    await act(async () => [...host.querySelectorAll('button')].find(item => item.textContent?.includes('旧组') && !item.textContent?.includes('删除'))!.click());
    await click('修复引用'); await pick(); await click('保存');
    expect(upsertModelLabGroup).toHaveBeenCalledWith({ id: 'keep-group', name: '旧组', models: [expect.objectContaining({ logicalModelId: 'logical-image', modelId: 'image-quality' })] });
    expect(deleteModelLabGroup).not.toHaveBeenCalled();
  });

  it('同一选择在不同用途重新核对，不把直接生图授权当成批量授权', async () => {
    const selected: ModelLabSelectedModel[] = [{ ...legacy, logicalModelId: 'logical-image', platformId: 'logical-model', modelId: 'image-quality', modelName: 'image-quality', modelReferenceStatus: 'available' }];
    vi.mocked(getModelLabModelOptions).mockImplementation(async purpose => ok({ items: purpose === 'image' ? [image] : [] }));
    const render = async (purpose: 'image' | 'image-batch') => act(async () => root.render(<ModelPickerDialog open purpose={purpose} selectedModels={selected} onOpenChange={vi.fn()} onConfirm={vi.fn()} />));
    await render('image'); expect(button('加入到本次实验').disabled).toBe(false);
    await render('image-batch'); expect(button('加入到本次实验').disabled).toBe(true);
    expect(host.textContent).toContain('image-quality');
    expect(getModelLabModelOptions).toHaveBeenCalledWith('image-batch');
  });
});
