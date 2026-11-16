// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentTrashButton } from '../DocumentTrashButton';
import { listDocumentTrash, restoreDocumentTrash, resumeDocumentTrash } from '@/services/real/documentStore';
vi.mock('@/services/real/documentStore', () => ({ listDocumentTrash: vi.fn(), restoreDocumentTrash: vi.fn(), resumeDocumentTrash: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn() } }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => <span>等待</span> }));

let root: Root;
let container: HTMLDivElement;
const item = { kind: 'entry' as const, id: 'entry', title: '误删的文档', storeId: 'store', storeName: '团队资料', deletedAt: '2026-11-12T00:00:00Z', deletedBy: 'member', expiresAt: '2026-12-12T00:00:00Z', canRestore: true, pending: false };
const restored = vi.fn();
async function click(text: string) {
  const button = [...document.querySelectorAll('button')].find(x => x.textContent?.trim() === text);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.mocked(listDocumentTrash).mockResolvedValue({ success: true, error: null, data: { items: [item], retentionDays: 30 } });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('知识库回收站', () => {
  it('从可见入口找到误删内容，恢复后刷新列表并通知知识库', async () => {
    vi.mocked(restoreDocumentTrash).mockResolvedValue({ success: true, error: null, data: {} });
    await act(async () => root.render(<DocumentTrashButton storeId="store" onRestored={restored} />));
    await click('回收站');
    expect(document.body.textContent).toContain('误删的文档');
    expect(document.body.textContent).toContain('30 天');
    expect(listDocumentTrash).toHaveBeenCalledWith('store');
    vi.mocked(listDocumentTrash).mockResolvedValue({ success: true, error: null, data: { items: [], retentionDays: 30 } });
    await click('恢复');
    expect(restoreDocumentTrash).toHaveBeenCalledWith(item);
    expect(restored).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('暂无可恢复内容');
  });
  it('权限失效的恢复显示服务器错误，不报告恢复成功', async () => {
    vi.mocked(restoreDocumentTrash).mockResolvedValue({ success: false, data: null, error: { code: 'NOT_FOUND', message: '知识库不存在' } });
    await act(async () => root.render(<DocumentTrashButton onRestored={restored} />));
    await click('回收站'); await click('恢复');
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('知识库不存在');
    expect(restored).not.toHaveBeenCalled();
  });
  it('过期内容禁用恢复，仍显示明确的期限信息', async () => {
    vi.mocked(listDocumentTrash).mockResolvedValue({ success: true, error: null, data: { items: [{ ...item, canRestore: false }], retentionDays: 30 } });
    await act(async () => root.render(<DocumentTrashButton onRestored={restored} />));
    await click('回收站');
    expect(document.body.textContent).toContain('已超过恢复期限');
    expect([...document.querySelectorAll('button')].find(x => x.textContent?.trim() === '恢复')?.disabled).toBe(true);
  });
  it('中断的删除能从回收站继续执行，再恢复', async () => {
    vi.mocked(listDocumentTrash).mockResolvedValue({ success: true, error: null, data: { items: [{ ...item, pending: true, canRestore: false }], retentionDays: 30 } });
    vi.mocked(resumeDocumentTrash).mockResolvedValue({ success: true, error: null, data: {} });
    await act(async () => root.render(<DocumentTrashButton onRestored={restored} />));
    await click('回收站');
    vi.mocked(listDocumentTrash).mockResolvedValue({ success: true, error: null, data: { items: [item], retentionDays: 30 } });
    await click('继续回收');
    expect(resumeDocumentTrash).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll('button')].find(x => x.textContent?.trim() === '恢复')?.disabled).toBe(false);
  });

});
