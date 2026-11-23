// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DebugClaimNotificationButton } from './DebugClaimNotificationButton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ debugClaimNotice: vi.fn() }));
vi.mock('@/services/real/productClaimWebhook', () => api);
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); vi.resetAllMocks(); });
describe('生成版本号后手工调试通知', () => {
  it('不自动发送；点击后只请求对应版本一次，保留编号并提示实际发送结果', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    api.debugClaimNotice.mockResolvedValue({ success: true, data: { queued: true, sent: true, status: 'sent' } });
    await act(async () => root.render(<div>V4.26.4<DebugClaimNotificationButton kind="V" id="new-v" visible /></div>));
    expect(host.textContent).toContain('V4.26.4');
    expect(host.textContent).toContain('调试通知');
    expect(api.debugClaimNotice).not.toHaveBeenCalled();
    await act(async () => host.querySelector('button')!.click());
    expect(api.debugClaimNotice).toHaveBeenCalledTimes(1);
    expect(api.debugClaimNotice).toHaveBeenCalledWith('V', 'new-v');
    expect(host.textContent).toContain('V4.26.4');
    expect(host.textContent).toContain('通知已发送到企微群');
    await act(async () => host.querySelector('button')!.click());
    expect(api.debugClaimNotice).toHaveBeenCalledTimes(1);
  });
  it('兼容仅排队的旧响应时不显示发送成功', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    api.debugClaimNotice.mockResolvedValue({ success: true, data: { queued: true } });
    await act(async () => root.render(<DebugClaimNotificationButton kind="T" id="t" visible />));
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('结果未确认');
    expect(host.textContent).not.toContain('通知已发送到企微群');
  });
  it('发送失败显示后端原因而不显示成功', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    api.debugClaimNotice.mockResolvedValue({ success: false, error: { message: '企微拒绝通知（错误码 40031）' } });
    await act(async () => root.render(<DebugClaimNotificationButton kind="T" id="t" visible />));
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('40031');
    expect(host.textContent).not.toContain('通知已发送到企微群');
  });
  it('非调试申领不显示调试通知按钮', async () => {
    host = document.createElement('div'); root = createRoot(host);
    await act(async () => root.render(<DebugClaimNotificationButton kind="T" id="t" visible={false} />));
    expect(host.querySelector('button')).toBeNull();
    expect(api.debugClaimNotice).not.toHaveBeenCalled();
  });
});
