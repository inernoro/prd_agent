// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CustomerModule } from '../CustomerModule';

const api = vi.hoisted(() => ({ listCustomers: vi.fn(), listCustomerFollowUps: vi.fn(), createCustomerFollowUp: vi.fn(), error: vi.fn() }));
vi.mock('@/services/real/productAgent', () => api);
vi.mock('@/lib/toast', () => ({ toast: { error: api.error } }));
vi.mock('../MarketingConsultPanel', () => ({ MarketingConsultModule: () => null }));
vi.mock('../DynamicForm', () => ({
  useEffectiveTemplate: () => ({ template: null, fields: [] }),
  FormFieldsRenderer: () => null,
  RichTextField: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <textarea value={value} onChange={e => onChange(e.target.value)} />,
}));

it('reads legacy follow-ups safely, retains edited draft on failure and saves sanitized retry', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const dirty = '<p><strong>客户跟进正文</strong><img src="/missing" onerror="window.__xssSentinel=1"><svg onload="window.__xssSentinel=1"></svg><a href="javascript:window.__xssSentinel=1">链接</a></p>';
  api.listCustomers.mockResolvedValue({ success: true, data: { items: [{ id: 'customer-isolated', name: '隔离客户', tags: [] }] } });
  api.listCustomerFollowUps.mockResolvedValue({ success: true, data: { items: [{ id: 'legacy', content: dirty, createdAt: '2026-11-17T00:00:00Z' }] } });
  api.createCustomerFollowUp.mockResolvedValueOnce({ success: false, error: { message: '临时失败' } }).mockResolvedValueOnce({ success: true });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<CustomerModule isAdmin={false} />));
    await act(async () => (host.querySelector('tbody tr') as HTMLElement).click());
    await act(async () => button('动态跟进').click());
    const display = host.querySelector('.prose-sm')!;
    expect(display.querySelector('strong')?.textContent).toBe('客户跟进正文');
    expect(display.querySelector('[onerror],svg,a[href]')).toBeNull();
    const editor = host.querySelector('textarea')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => { setValue.call(editor, dirty); editor.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('添加跟进').click());
    expect(api.error).toHaveBeenCalledWith('保存失败', '临时失败');
    expect(editor.value).toBe(dirty);
    expect(button('添加跟进').disabled).toBe(false);
    expect(api.createCustomerFollowUp.mock.calls[0][1].content).not.toMatch(/onerror|javascript|<svg/);
    await act(async () => button('添加跟进').click());
    expect(editor.value).toBe('');
    expect(api.createCustomerFollowUp).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
