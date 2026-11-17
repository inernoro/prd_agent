// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppealHistoryDrawer as ProductHistory } from '../review/components/AppealHistoryDrawer';
import { AppealHistoryDrawer as ReviewHistory } from '../../review-agent/components/AppealHistoryDrawer';
import { AppealSubmitDialog as ProductSubmit } from '../review/components/AppealSubmitDialog';
import { AppealSubmitDialog as ReviewSubmit } from '../../review-agent/components/AppealSubmitDialog';
import type { ReviewSubmission } from '@/services/real/productReviewApi';

const api = vi.hoisted(() => ({ listAppeals: vi.fn(), createAppeal: vi.fn(), approveAppeal: vi.fn(), rejectAppeal: vi.fn(), uploadAppealImage: vi.fn() }));
vi.mock('@/services/real/productReview', () => api);
vi.mock('@/services/real/reviewAgent', () => api);
vi.mock('@/components/ui/MobileDrawer', () => ({ MobileDrawer: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ content }: { content: ReactNode }) => <div>{content}</div> }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const dirty = '<p><strong>完整保留业务申诉理由十个字以上</strong><img src="/missing" onerror="window.__xssSentinel=1"><a href="jav&#9;ascript:window.__xssSentinel=1">证据</a><svg onload="window.__xssSentinel=1"></svg></p>';

for (const [label, History, Submit] of [['product', ProductHistory, ProductSubmit], ['review', ReviewHistory, ReviewSubmit]] as const) {
  describe(label, () => {
    it('sanitizes legacy history while preserving business text and permissions', async () => {
      api.listAppeals.mockResolvedValue({ success: true, data: { items: [{ id: 'legacy', reasonHtml: dirty, status: 'Pending', submitterName: '测试提交人', createdAt: '2026-11-17T00:00:00Z' }] } });
      await act(async () => root.render(<History open onClose={() => {}} submissionId="isolated" canResolve={false} />));
      expect(host.querySelector('strong')?.textContent).toContain('完整保留');
      expect(host.querySelector('.appeal-content')?.querySelector('[onerror],svg,a[href]')).toBeNull();
      expect(host.textContent).toContain('测试提交人');
      expect(host.textContent).not.toContain('驳回');
    });

    it('cleans rich paste and save, preserves draft after failure, then retries successfully', async () => {
      api.createAppeal.mockResolvedValueOnce({ success: false, error: { message: '保存失败请重试' } }).mockResolvedValueOnce({ success: true });
      const onSuccess = vi.fn(); const onClose = vi.fn();
      const submission = { id: 'isolated', title: '隔离申诉', completedAt: new Date().toISOString() } as ReviewSubmission;
      await act(async () => root.render(<Submit submission={submission} onSuccess={onSuccess} onClose={onClose} />));
      const editor = host.querySelector('[contenteditable]') as HTMLDivElement;
      const insert = vi.fn((_command: string, _ui: boolean, html: string) => { editor.innerHTML = html; return true; });
      Object.defineProperty(document, 'execCommand', { configurable: true, value: insert });
      const paste = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(paste, 'clipboardData', { value: { items: [], getData: () => dirty } });
      await act(async () => editor.dispatchEvent(paste));
      expect(paste.defaultPrevented).toBe(true);
      expect(editor.querySelector('[onerror],svg,a[href]')).toBeNull();
      // API bypass / edited DOM must still be sanitized at save time.
      editor.innerHTML = dirty;
      await act(async () => editor.dispatchEvent(new Event('input', { bubbles: true })));
      const submit = [...host.querySelectorAll('button')].find(b => b.textContent === '提交申诉')!;
      await act(async () => submit.click());
      expect(host.textContent).toContain('保存失败请重试');
      expect(editor.textContent).toContain('完整保留');
      expect(submit.disabled).toBe(false);
      expect(onClose).not.toHaveBeenCalled();
      const sent = api.createAppeal.mock.calls[0][1];
      expect(sent.reasonHtml).toContain('<strong>');
      expect(sent.reasonHtml).not.toMatch(/onerror|javascript|<svg/);
      await act(async () => submit.click());
      expect(api.createAppeal).toHaveBeenCalledTimes(2);
      expect(onSuccess).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
    });
  });
}
