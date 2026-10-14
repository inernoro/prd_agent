import { describe, expect, it } from 'vitest';
import { readDismissedReceipts, writeDismissedReceipt, receiptBelongsOnPage, receiptProjectId } from '../../web/src/lib/onboarding-receipts';

function sessionStore() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('新人回执跨页面与项目身份', () => {
  it('收起后新的组件读取同一会话仍收起，不改变另一条回执', () => {
    const session = sessionStore();
    expect(readDismissedReceipts(session)).toEqual([]);
    writeDismissedReceipt('receipt-1', session);
    expect(readDismissedReceipts(session)).toEqual(['receipt-1']);
    expect(readDismissedReceipts(session)).not.toContain('receipt-2');
    writeDismissedReceipt('receipt-1', session);
    expect(readDismissedReceipts(session)).toEqual(['receipt-1']);
  });
  it('存储损坏或不可用不会阻断授权页面，并且记录数量有界', () => {
    expect(readDismissedReceipts({ getItem: () => '{broken' })).toEqual([]);
    const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(writeDismissedReceipt('new', denied)).toEqual(['new']);
    const session = sessionStore();
    for (let i = 0; i < 70; i++) writeDismissedReceipt(String(i), session);
    expect(readDismissedReceipts(session)).toHaveLength(50);
  });
  it('完成回执不浮在其他项目上，但信息中心仍可查看，创建中仍连续提示', () => {
    const completed = { id: 'r', createdProject: { id: 'receipt-project', name: '授权专项' } };
    expect(receiptBelongsOnPage(completed, 'recovery-project', 'floating')).toBe(false);
    expect(receiptBelongsOnPage(completed, 'receipt-project', 'floating')).toBe(true);
    expect(receiptBelongsOnPage(completed, '', 'floating')).toBe(true);
    expect(receiptBelongsOnPage(completed, 'recovery-project', 'inline')).toBe(true);
    expect(receiptBelongsOnPage({ id: 'creating' }, 'recovery-project', 'floating')).toBe(true);
  });
  it.each([
    ['/branches/receipt-project', '', 'receipt-project'],
    ['/settings/receipt-project', '', 'receipt-project'],
    ['/agent-requests/receipt-project', '', 'receipt-project'],
    ['/reports', '?project=receipt-project', 'receipt-project'],
    ['/branch-panel/main', '?projectId=receipt-project', 'receipt-project'],
    ['/project-list', '', ''],
    ['/branches/%E0%A4%A', '', ''],
  ])('页面 %s 沿真实项目上下文核对回执', (pathname, search, expected) => {
    expect(receiptProjectId({ pathname, search })).toBe(expected);
  });
});
