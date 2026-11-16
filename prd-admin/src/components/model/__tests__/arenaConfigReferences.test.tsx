// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ArenaConfigTab from '@/pages/lab-arena/ArenaConfigTab';
import { createArenaSlot, deleteArenaSlot, getArenaModelOptions, getPlatforms, listArenaGroups, updateArenaSlot } from '@/services';
import type { ArenaGroup } from '@/services/contracts/arena';

vi.mock('@/services', () => ({ getArenaModelOptions: vi.fn(), getPlatforms: vi.fn(), listArenaGroups: vi.fn(), createArenaSlot: vi.fn(), updateArenaSlot: vi.fn(), deleteArenaSlot: vi.fn(), createArenaGroup: vi.fn(), updateArenaGroup: vi.fn(), deleteArenaGroup: vi.fn(), toggleArenaSlot: vi.fn() }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ open, title, content, actions }: { open: boolean; title: string; content: React.ReactNode; actions: React.ReactNode }) => open ? <div role="dialog"><h2>{title}</h2>{content}{actions}</div> : null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <span>正在读取</span>, MapSpinner: () => <span>正在核对</span> }));
vi.mock('@/components/ui/PrdLoader', () => ({ PrdLoader: () => <span>正在读取</span> }));
const ok = <T,>(data: T) => ({ success: true as const, data, error: null });
let host: HTMLDivElement;
let root: Root;
let group: ArenaGroup;
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;

beforeEach(() => {
  vi.clearAllMocks(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  group = { id: 'keep-group', key: 'chat', name: '文字对战', slots: [{ id: 'keep-slot', group: 'chat', platformId: 'removed-provider', modelId: 'old-model', displayName: '保留昵称', sortOrder: 8, enabled: true, modelReferenceStatus: 'legacy', modelReferenceReason: '旧平台不存在' }] };
  vi.mocked(listArenaGroups).mockImplementation(async () => ok({ items: structuredClone([group]) }));
  vi.mocked(getPlatforms).mockResolvedValue(ok([]));
  vi.mocked(getArenaModelOptions).mockResolvedValue(ok({ items: [{ logicalModelId: 'logical-new', publicId: 'official-chat', name: '官方聊天', available: true }] }));
  vi.mocked(updateArenaSlot).mockImplementation(async () => { group.slots[0] = { ...group.slots[0], logicalModelId: 'logical-new', platformId: 'logical-model', modelId: 'official-chat', modelReferenceStatus: 'available' }; return ok(group.slots[0]); });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

it('实际管理页展示失效、明确选择并原位修复，重新读取后保留名称/槽位/排序', async () => {
  await act(async () => root.render(<ArenaConfigTab />));
  expect(host.textContent).toContain('旧平台不存在');
  expect(host.textContent).toContain('已启用');
  await act(async () => button('修复模型引用').click());
  expect(button('保存模型引用').disabled).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>('[aria-label="选择模型 官方聊天 official-chat"]')!.click());
  await act(async () => button('保存模型引用').click());
  expect(updateArenaSlot).toHaveBeenCalledWith('keep-slot', { logicalModelId: 'logical-new' });
  expect(deleteArenaSlot).not.toHaveBeenCalled(); expect(createArenaSlot).not.toHaveBeenCalled();
  expect(group.slots[0]).toMatchObject({ id: 'keep-slot', displayName: '保留昵称', sortOrder: 8, group: 'chat' });
  expect(host.textContent).toContain('official-chat'); expect(host.textContent).toContain('保留昵称');
  expect(host.textContent).not.toContain('旧平台不存在');
  expect(listArenaGroups).toHaveBeenCalledTimes(2);
});
