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
  it('不自动发送；点击后只请求对应版本一次，保留编号并提示已提交', async () => {
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    api.debugClaimNotice.mockResolvedValue({ success: true, data: { queued: true } });
    await act(async () => root.render(<div>V4.26.4<DebugClaimNotificationButton kind="V" id="new-v" visible /></div>));
    expect(host.textContent).toContain('V4.26.4');
    expect(host.textContent).toContain('调试通知');
    expect(api.debugClaimNotice).not.toHaveBeenCalled();
    await act(async () => host.querySelector('button')!.click());
    expect(api.debugClaimNotice).toHaveBeenCalledTimes(1);
    expect(api.debugClaimNotice).toHaveBeenCalledWith('V', 'new-v');
    expect(host.textContent).toContain('V4.26.4');
    expect(host.textContent).toContain('已提交推送');
    await act(async () => host.querySelector('button')!.click());
    expect(api.debugClaimNotice).toHaveBeenCalledTimes(1);
  });
  it('非调试申领不显示调试通知按钮', async () => {
    host = document.createElement('div'); root = createRoot(host);
    await act(async () => root.render(<DebugClaimNotificationButton kind="T" id="t" visible={false} />));
    expect(host.querySelector('button')).toBeNull();
    expect(api.debugClaimNotice).not.toHaveBeenCalled();
  });
});
