// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProductClaimWebhookPanel } from './ProductClaimWebhookPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ getClaimWebhook: vi.fn(), getClaimNotices: vi.fn(), saveClaimWebhook: vi.fn(), retryClaimNotice: vi.fn(), debugClaimNotice: vi.fn() }));
vi.mock('@/services/real/productClaimWebhook', () => api);
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null, MapSectionLoader: () => <div>读取配置</div> }));
const config = { enabled: true, notifyInternal: true, notifyFormal: true, configured: true, maskedUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=********ab12', canEdit: true, canSend: true, identityReadyCount: 3, identityPendingCount: 1 };
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
  it('管理员可开启调试模式并保存，保存开关本身不发送通知', async () => {
    await act(async () => root.render(<ProductClaimWebhookPanel />)); await settle();
    await act(async () => host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')[1].click());
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === '保存配置')!.click());
    expect(api.saveClaimWebhook).toHaveBeenCalledWith({ enabled: true, debugMode: true, notifyInternal: true, notifyFormal: true, url: undefined });
    expect(api.debugClaimNotice).not.toHaveBeenCalled();
  });
  it('只回显脱敏地址，留空保存保留配置，展示自动身份就绪信息', async () => {
    await act(async () => root.render(<ProductClaimWebhookPanel />)); await settle();
    expect(host.querySelector('h3')?.textContent).toBe('版本申领通知');
    expect(host.querySelector('code')?.textContent).toBe(config.maskedUrl);
    expect(host.textContent).toContain('已就绪 3 人');
    expect(host.textContent).toContain('仅艾特表单所选的产品负责人');
    const password = host.querySelector<HTMLInputElement>('input[type=password]')!;
    expect(password.value).toBe('');
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === '保存配置')!.click());
    await settle();
    expect(api.saveClaimWebhook).toHaveBeenCalledWith({ enabled: true, debugMode: false, notifyInternal: true, notifyFormal: true, url: undefined });
    expect(password.value).toBe('');
    expect(host.textContent).toContain('配置已保存');
    expect(host.textContent).toContain('调试模式（申领后手工推送）');
  });
  it('预览环境禁止保存，结果不明的通知不提供重试按钮', async () => {
    api.getClaimWebhook.mockResolvedValue({ success: true, data: { ...config, canEdit: false, canSend: false } });
    api.getClaimNotices.mockResolvedValue({ success: true, data: { items: [{ kind: 'V', id: 'v', code: 'V1.2.3', notification: { status: 'unknown' } }] } });
    await act(async () => root.render(<ProductClaimWebhookPanel />)); await settle();
    expect(host.querySelector('fieldset')!.disabled).toBe(true);
    expect(host.textContent).toContain('当前部署的 Webhook 配置为只读');
    expect(host.textContent).toContain('结果待确认');
    expect(host.textContent).not.toContain('重试通知');
    expect(api.saveClaimWebhook).not.toHaveBeenCalled();
  });
  it('后台任务未获授权时说明推送状态，允许有配置权限的管理员保存', async () => {
    api.getClaimWebhook.mockResolvedValue({ success: true, data: { ...config, canSend: false, sendBlockedReason: '当前实例未配置共享后台任务授权，无法发送版本申领通知。' } });
    api.getClaimNotices.mockResolvedValue({ success: true, data: { items: [{ kind: 'T', id: 't', code: 'T1.2.3', notification: { status: 'failed' } }] } });
    await act(async () => root.render(<ProductClaimWebhookPanel />)); await settle();
    expect(host.querySelector('fieldset')!.disabled).toBe(false);
    expect(host.textContent).toContain('未配置共享后台任务授权');
    expect(host.textContent).not.toContain('重试通知');
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === '保存配置')!.click());
    expect(api.saveClaimWebhook).toHaveBeenCalledOnce();
    expect(api.retryClaimNotice).not.toHaveBeenCalled();
  });
});
