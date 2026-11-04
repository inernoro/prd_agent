// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductClaimWebhookPanel } from './ProductClaimWebhookPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ getClaimWebhook: vi.fn(), getClaimNotices: vi.fn(), saveClaimWebhook: vi.fn(), retryClaimNotice: vi.fn() }));
vi.mock('@/services/real/productClaimWebhook', () => api);
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null, MapSectionLoader: () => <div>读取配置</div> }));
const config = { enabled: true, notifyInternal: true, notifyFormal: true, configured: true, maskedUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=********', canSend: true, identityReadyCount: 3, identityPendingCount: 1 };
let root: Root;
let host: HTMLDivElement;
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
beforeEach(async () => {
  vi.resetAllMocks();
  api.getClaimWebhook.mockResolvedValue({ success: true, data: { ...config } });
  api.getClaimNotices.mockResolvedValue({ success: true, data: { items: [] } });
  api.saveClaimWebhook.mockResolvedValue({ success: true, data: { saved: true } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
describe('Webhook可视化配置', () => {
  it('只回显脱敏地址，留空保存保留配置，展示自动身份就绪信息', async () => {
    await act(async () => root.render(<ProductClaimWebhookPanel />)); await settle();
    expect(host.textContent).toContain('key=********');
    expect(host.textContent).toContain('已就绪 3 人');
    expect(host.textContent).toContain('只艾特表单所选产品负责人');
    const password = host.querySelector<HTMLInputElement>('input[type=password]')!;
    expect(password.value).toBe('');
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === '保存配置')!.click());
    await settle();
    expect(api.saveClaimWebhook).toHaveBeenCalledWith({ enabled: true, notifyInternal: true, notifyFormal: true, url: undefined });
    expect(password.value).toBe('');
    expect(host.textContent).toContain('配置已保存');
  });
  it('预览环境禁止保存，结果不明的通知不提供重试按钮', async () => {
    api.getClaimWebhook.mockResolvedValue({ success: true, data: { ...config, canSend: false } });
    api.getClaimNotices.mockResolvedValue({ success: true, data: { items: [{ kind: 'V', id: 'v', code: 'V1.2.3', notification: { status: 'unknown' } }] } });
    await act(async () => root.render(<ProductClaimWebhookPanel />)); await settle();
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    expect(host.textContent).toContain('当前环境只读配置');
    expect(host.textContent).toContain('结果待确认');
    expect(host.textContent).not.toContain('重试通知');
    expect(api.saveClaimWebhook).not.toHaveBeenCalled();
  });
});
