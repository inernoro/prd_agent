// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionDebugClearButton } from './VersionDebugClearButton';
import type { VersionDebugClearKind } from '@/services/real/productAgent';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ previewVersionDebugClear: vi.fn(), clearVersionDebugRecords: vi.fn() }));
vi.mock('@/services/real/productAgent', () => api);
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ content, actions }: { content: ReactNode; actions: ReactNode }) => <div role="dialog">{content}{actions}</div> }));
let host: HTMLDivElement;
let root: Root;
const changed = vi.fn(async () => {});
async function click(text: string) { await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === text)?.click()); }
async function input(text: string) {
  await act(async () => {
    const field = host.querySelector<HTMLInputElement>('input')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function mount(kind: VersionDebugClearKind = 'internal') {
  await act(async () => root.render(<VersionDebugClearButton kind={kind} onChanged={changed} />));
}
beforeEach(() => {
  vi.clearAllMocks(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  api.previewVersionDebugClear.mockImplementation(async (kind: VersionDebugClearKind) => ({ success: true, data: {
    kind, kindLabel: kind === 'internal' ? '内部版本（T）' : '正式版本（V）', recordCount: 3, preservedLegacyCount: 2,
    confirmPhrase: kind === 'internal' ? '清空T记录' : '清空V记录', token: `token-${kind}`,
  } }));
  api.clearVersionDebugRecords.mockResolvedValue({ success: true, data: { kind: 'internal', clearedCount: 3, skippedCount: 0, backupId: 'backup' } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('版本页临时调试清空', () => {
  it('挂载不请求，打开仅预览，取消不清理', async () => {
    await mount();
    expect(api.previewVersionDebugClear).not.toHaveBeenCalled();
    await click('调试清空T记录');
    expect(api.previewVersionDebugClear).toHaveBeenCalledWith('internal');
    expect(host.textContent).toContain('不受当前产品、人员或状态筛选影响');
    expect(host.textContent).toContain('后续按所属应用剩余有效记录发号');
    expect(api.clearVersionDebugRecords).not.toHaveBeenCalled();
    await click('取消');
    expect(api.clearVersionDebugRecords).not.toHaveBeenCalled();
    expect(host.querySelector('[role=dialog]')).toBeNull();
  });
  it.each(['internal', 'formal'] as const)('只发送当前%s类型和已预览token，成功后展示备份并刷新', async (kind) => {
    await mount(kind);
    const code = kind === 'internal' ? 'T' : 'V';
    await click(`调试清空${code}记录`);
    await input('错误确认语'); await click(`确认清空${code}记录`);
    expect(api.clearVersionDebugRecords).not.toHaveBeenCalled();
    await input(`清空${code}记录`); await click(`确认清空${code}记录`);
    expect(api.clearVersionDebugRecords).toHaveBeenCalledTimes(1);
    expect(api.clearVersionDebugRecords).toHaveBeenCalledWith({ kind, confirmPhrase: `清空${code}记录`, token: `token-${kind}` });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('备份编号：backup');
    expect(host.textContent).toContain('已清理 3 条');
  });
  it('过期预览的拒绝留在弹窗，不误报成功或刷新', async () => {
    api.clearVersionDebugRecords.mockResolvedValue({ success: false, error: { message: '版本记录已变化，未执行本次清理。' } });
    await mount(); await click('调试清空T记录'); await input('清空T记录'); await click('确认清空T记录');
    expect(host.querySelector('[role=alert]')?.textContent).toContain('未执行本次清理');
    expect(changed).not.toHaveBeenCalled();
    expect(host.querySelector('[role=dialog]')).not.toBeNull();
  });
  it('读取范围失败时不可确认清空', async () => {
    api.previewVersionDebugClear.mockResolvedValue({ success: false, error: { message: '无权访问' } });
    await mount(); await click('调试清空T记录');
    expect(host.querySelector('[role=alert]')?.textContent).toBe('无权访问');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === '确认清空T记录')?.disabled).toBe(true);
  });
  it('无记录时不允许提交', async () => {
    api.previewVersionDebugClear.mockResolvedValue({ success: true, data: { kind: 'internal', kindLabel: '内部版本（T）', recordCount: 0, preservedLegacyCount: 0, confirmPhrase: '清空T记录', token: 'empty' } });
    await mount(); await click('调试清空T记录'); await input('清空T记录'); await click('确认清空T记录');
    expect(api.clearVersionDebugRecords).not.toHaveBeenCalled();
  });
  it('连续点击确认只发一次清理请求', async () => {
    let resolve: (value: unknown) => void = () => {};
    api.clearVersionDebugRecords.mockReturnValue(new Promise((done) => { resolve = done; }));
    await mount(); await click('调试清空T记录'); await input('清空T记录');
    await act(async () => {
      const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '确认清空T记录')!;
      button.click(); button.click();
    });
    expect(api.clearVersionDebugRecords).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ success: true, data: { kind: 'internal', clearedCount: 3, skippedCount: 0, backupId: 'backup' } }));
  });
});
