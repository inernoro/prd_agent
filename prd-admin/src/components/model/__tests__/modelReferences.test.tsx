// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LogicalModelPickerDialog } from '../LogicalModelPickerDialog';
import { ArenaModelPickerDialog } from '../ArenaModelPickerDialog';
import { ArenaLineupNotice } from '../ArenaLineupNotice';
import { arenaLineupProblem, arenaUnavailableSlots } from '@/lib/arenaModelReferences';
import type { ArenaGroup, ArenaSlot } from '@/services/contracts/arena';
import { createArenaSlot, getArenaModelOptions, updateArenaSlot } from '@/services';

vi.mock('@/services', () => ({ createArenaSlot: vi.fn(), getArenaModelOptions: vi.fn(), updateArenaSlot: vi.fn() }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ open, title, content, actions }: { open: boolean; title: string; content: React.ReactNode; actions: React.ReactNode }) => open ? <div role="dialog"><h2>{title}</h2>{content}{actions}</div> : null }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <span>正在读取</span>, MapSpinner: () => <span>正在核对</span> }));
const options = [{ logicalModelId: 'stable-chat', name: '官方聊天', publicId: 'chat-quality', available: true }, { logicalModelId: 'other-chat', name: '另一模型', publicId: 'chat-fixed', available: true }, { logicalModelId: 'blocked', name: '暂无线路', publicId: 'chat-blocked', available: false, reason: '无可用线路' }];
const ok = <T,>(data: T) => ({ success: true as const, data, error: null });
const slot = { id: 'keep-slot-id', displayName: '旧槽位昵称', group: 'chat', enabled: true, sortOrder: 7, platformId: 'deleted-platform', modelId: 'old-provider-model', modelReferenceStatus: 'legacy' } as ArenaSlot;
const group: ArenaGroup = { id: 'group-id', key: 'chat', name: '阵容', slots: [slot] };
let host: HTMLDivElement;
let root: Root;
const button = (label: string) => [...host.querySelectorAll('button')].find(item => item.textContent === label)!;
const checkbox = (id: string) => host.querySelector<HTMLInputElement>(`[aria-label="选择模型 ${options.find(option => option.logicalModelId === id)!.name} ${options.find(option => option.logicalModelId === id)!.publicId}"]`)!;
async function click(label: string) { await act(async () => button(label).click()); }

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(getArenaModelOptions).mockResolvedValue(ok({ items: options }));
  vi.mocked(createArenaSlot).mockResolvedValue(ok(slot));
  vi.mocked(updateArenaSlot).mockResolvedValue(ok({ ...slot, logicalModelId: 'stable-chat', modelReferenceStatus: 'available' }));
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('逻辑模型选择与引用修复真实DOM', () => {
  it('目录不自动首选，不允许选无线路模型，仅提交明确选中的逻辑身份', async () => {
    const confirm = vi.fn(); const close = vi.fn();
    await act(async () => root.render(<LogicalModelPickerDialog open loadOptions={getArenaModelOptions} onOpenChange={close} onConfirm={confirm} />));
    expect([...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].some(input => input.checked)).toBe(false);
    expect(button('确认选择').disabled).toBe(true);
    expect(checkbox('blocked').disabled).toBe(true);
    await act(async () => checkbox('stable-chat').click());
    await click('确认选择');
    expect(confirm).toHaveBeenCalledWith([options[0]]);
    expect(close).toHaveBeenCalledWith(false);
  });

  it('目录失败后保留选择，重新读取仍不换成首个选项', async () => {
    const confirm = vi.fn();
    vi.mocked(getArenaModelOptions).mockRejectedValueOnce(new Error('网络中断')).mockResolvedValueOnce(ok({ items: options }));
    await act(async () => root.render(<LogicalModelPickerDialog open single selectedModelIds={['other-chat']} loadOptions={getArenaModelOptions} onOpenChange={vi.fn()} onConfirm={confirm} />));
    expect(host.textContent).toContain('现有选择已保留');
    expect(button('确认选择').disabled).toBe(true);
    await click('重新读取');
    expect(checkbox('other-chat').checked).toBe(true);
    expect(checkbox('stable-chat').checked).toBe(false);
    await click('确认选择');
    expect(confirm).toHaveBeenCalledWith([options[1]]);
  });

  it('修复用PUT保留原槽位id，不发送旧平台或昵称覆盖', async () => {
    const saved = vi.fn();
    await act(async () => root.render(<ArenaModelPickerDialog open group={group} repairingSlot={slot} onOpenChange={vi.fn()} onSaved={saved} />));
    expect(button('保存模型引用').disabled).toBe(true);
    await act(async () => checkbox('stable-chat').click());
    await click('保存模型引用');
    expect(updateArenaSlot).toHaveBeenCalledTimes(1);
    expect(updateArenaSlot).toHaveBeenCalledWith('keep-slot-id', { logicalModelId: 'stable-chat' });
    expect(createArenaSlot).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledTimes(1);
    expect(slot).toMatchObject({ id: 'keep-slot-id', displayName: '旧槽位昵称', sortOrder: 7, platformId: 'deleted-platform' });
  });

  it('添加只追加新模型，不删除旧失效槽位，也不重新创建已加入的逻辑模型', async () => {
    const existing = { ...slot, id: 'existing-logical', logicalModelId: 'stable-chat', modelReferenceStatus: 'available' as const };
    await act(async () => root.render(<ArenaModelPickerDialog open group={{ ...group, slots: [slot, existing] }} onOpenChange={vi.fn()} onSaved={vi.fn()} />));
    await act(async () => { checkbox('stable-chat').click(); checkbox('other-chat').click(); });
    await click('确认添加');
    expect(createArenaSlot).toHaveBeenCalledTimes(1);
    expect(createArenaSlot).toHaveBeenCalledWith({ group: 'chat', logicalModelId: 'other-chat', displayName: '另一模型', enabled: true });
    expect(updateArenaSlot).not.toHaveBeenCalled();
  });

  it('匿名阵容提示失效数量并给修复入口，不泄露模型、平台或管理员原因', async () => {
    const repair = vi.fn();
    await act(async () => root.render(<ArenaLineupNotice slots={[{ ...slot, modelReferenceReason: 'secret-provider secret-model' }]} onRepair={repair} onRefresh={vi.fn()} />));
    expect(host.textContent).toContain('1 个模型引用需要修复');
    for (const secret of ['旧槽位昵称', 'old-provider-model', 'deleted-platform', 'secret-provider']) expect(host.textContent).not.toContain(secret);
    await click('修复阵容'); expect(repair).toHaveBeenCalledTimes(1);
  });
});

describe('阵容发送前的服务端权威状态', () => {
  it.each(['legacy', 'unavailable', 'unknown', undefined] as const)('状态%s不能开始且保留全部原槽位', status => {
    const slots = [{ ...slot, modelReferenceStatus: status }];
    expect(arenaUnavailableSlots(slots)).toHaveLength(1);
    expect(arenaLineupProblem(group, { ...group, slots })).toContain('修复');
    expect(slots[0].id).toBe('keep-slot-id');
  });
  it('同一逻辑身份的上游变更不影响选择，不同逻辑身份必须重新核对', () => {
    const available: ArenaGroup = { ...group, slots: [{ ...slot, logicalModelId: 'stable-chat', modelReferenceStatus: 'available' }] };
    expect(arenaLineupProblem(available, { ...available, slots: [{ ...available.slots[0], platformId: 'new-provider', modelId: 'upgraded-model' }] })).toBeNull();
    expect(arenaLineupProblem(available, { ...available, slots: [{ ...available.slots[0], logicalModelId: 'other-chat' }] })).toContain('已更新');
  });
});
