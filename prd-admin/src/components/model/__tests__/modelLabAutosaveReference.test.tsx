// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LlmLabTab from '@/pages/lab-llm/LlmLabTab';
import { getModels, getPlatforms, getModelLabModelOptions, listModelLabExperiments, listModelLabModelSets, listModelLabGroups, updateModelLabExperiment, runModelLabStream, generateImageGen } from '@/services';
import type { ModelLabExperiment } from '@/services/contracts/modelLab';

vi.mock('@/services', () => ({ createModelLabExperiment: vi.fn(), deleteModelLabExperiment: vi.fn(), getModels: vi.fn(), getPlatforms: vi.fn(), listModelLabExperiments: vi.fn(), listModelLabModelSets: vi.fn(), runModelLabStream: vi.fn(), planImageGen: vi.fn(), generateImageGen: vi.fn(), runImageGenBatchStream: vi.fn(), updateModelLabExperiment: vi.fn(), upsertModelLabModelSet: vi.fn(), getAdminImageGenPlanPromptOverride: vi.fn(), putAdminImageGenPlanPromptOverride: vi.fn(), deleteAdminImageGenPlanPromptOverride: vi.fn(), getModelLabModelOptions: vi.fn(), deleteModelLabGroup: vi.fn(), listModelLabGroups: vi.fn(), upsertModelLabGroup: vi.fn() }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ open, title, content, actions }: { open: boolean; title: string; content: React.ReactNode; actions: React.ReactNode }) => open ? <div role="dialog"><h2>{title}</h2>{content}{actions}</div> : null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <span>正在读取</span>, MapSpinner: () => <span>正在核对</span> }));
vi.mock('@/components/ui/PrdLoader', () => ({ PrdLoader: () => <span>正在读取</span> }));
vi.mock('@/components/design/GlassCard', () => ({ GlassCard: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/design/GlassSwitch', () => ({ GlassSwitch: () => <div /> }));
vi.mock('@/components/ui/SuccessConfettiButton', () => ({ SuccessConfettiButton: () => <button type="button">开始实验</button> }));
vi.mock('@/stores/authStore', () => { const state = { user: { userId: 'autosave-test' }, token: null }; return { useAuthStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }; });

const ok = <T,>(data: T) => ({ success: true as const, data, error: null });
let host: HTMLDivElement;
let root: Root;
let persisted: ModelLabExperiment;
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
async function click(label: string) { expect(button(label), `缺少按钮${label}`).toBeTruthy(); await act(async () => button(label).click()); }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); sessionStorage.clear(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  persisted = { id: 'keep-experiment', ownerAdminId: 'admin', name: '保留实验', suite: 'intent', promptText: '', params: { temperature: 0.2, maxTokens: null, timeoutMs: 600000, maxConcurrency: 10, repeatN: 1 }, createdAt: '', updatedAt: '', selectedModels: [{ logicalModelId: 'deleted-internal-id', platformId: 'logical-model', modelId: 'same-public-id', modelName: 'same-public-id', name: '同一公开模型', modelReferenceStatus: 'unavailable' }] };
  vi.mocked(getModels).mockResolvedValue(ok([])); vi.mocked(getPlatforms).mockResolvedValue(ok([]));
  vi.mocked(listModelLabExperiments).mockImplementation(async () => ok({ items: structuredClone([persisted]), total: 1, page: 1, pageSize: 50 }));
  vi.mocked(listModelLabModelSets).mockResolvedValue(ok({ items: [] })); vi.mocked(listModelLabGroups).mockResolvedValue(ok({ items: [] }));
  vi.mocked(getModelLabModelOptions).mockResolvedValue(ok({ items: [{ logicalModelId: 'rebuilt-internal-id', publicId: 'same-public-id', name: '同一公开模型', available: true }] }));
  vi.mocked(updateModelLabExperiment).mockImplementation(async (id, update) => { persisted = { ...persisted, ...update, id, params: { ...persisted.params, ...update.params } }; return ok(structuredClone(persisted)); });
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('同PublicId重建后仅logicalModelId变化仍自动保存，重开读取修复身份且不重复保存', async () => {
  await act(async () => root.render(<LlmLabTab />));
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(updateModelLabExperiment).not.toHaveBeenCalled();
  await click('添加模型'); await click('修复引用');
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="选择模型 同一公开模型 same-public-id"]')!.click());
  await click('确认选择'); await click('加入到本次实验');
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(updateModelLabExperiment).toHaveBeenCalledTimes(1);
  expect(updateModelLabExperiment).toHaveBeenCalledWith('keep-experiment', expect.objectContaining({ selectedModels: [expect.objectContaining({ logicalModelId: 'rebuilt-internal-id', platformId: 'logical-model', modelId: 'same-public-id', modelName: 'same-public-id' })] }));
  expect(persisted.selectedModels[0].logicalModelId).toBe('rebuilt-internal-id');

  await act(async () => root.unmount()); root = createRoot(host);
  await act(async () => root.render(<LlmLabTab />));
  await click('添加模型');
  expect(host.textContent).not.toContain('模型引用需修复');
  expect(button('加入到本次实验').disabled).toBe(false);
  await click('加入到本次实验');
  await act(async () => vi.advanceTimersByTimeAsync(650));
  expect(updateModelLabExperiment).toHaveBeenCalledTimes(1);
  expect(listModelLabExperiments).toHaveBeenCalledTimes(2);
  expect(runModelLabStream).not.toHaveBeenCalled(); expect(generateImageGen).not.toHaveBeenCalled();
});
