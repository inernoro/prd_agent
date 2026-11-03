// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaEditorDialog } from '../QuotaEditorDialog';
import { updateAgentApiKey } from '@/services';
import { toast } from '@/lib/toast';
import type { McpClientDto } from '@/services/contracts/mcpConsole';

vi.mock('@/components/ui/Dialog', () => ({
  Dialog: ({ open, content }: { open: boolean; content: ReactNode }) => open ? <div>{content}</div> : null,
}));
vi.mock('@/services', () => ({
  getLiteraryAgentAllModels: vi.fn().mockResolvedValue({
    success: true, data: { text2img: { pools: [] }, img2img: { pools: [] } },
  }),
  updateAgentApiKey: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const client: McpClientDto = {
  keyId: 'client-auto', name: '我的 Codex', keyPrefix: 'sk-ak-test',
  scopes: ['web-pages:write'], scopeMode: 'auto', missingCapabilities: [],
  isActive: true, todayCalls: 0, dailyImageQuota: 50, dailyWriteQuota: 200,
  rateLimitPerMin: 60, todayImages: 0, todayWrites: 0,
};
let container: HTMLDivElement;
let root: Root;
const onOpenChange = vi.fn();
const onSaved = vi.fn();
async function render(value: McpClientDto = client, open = true) {
  await act(async () => root.render(<QuotaEditorDialog
    client={value} open={open} onOpenChange={onOpenChange} onSaved={onSaved}
  />));
}
function checkbox() {
  const input = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(input).not.toBeNull();
  return input!;
}
async function save() {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '保存');
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.clearAllMocks();
  vi.mocked(updateAgentApiKey).mockResolvedValue({ success: true, data: { item: null }, error: null });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('客户端独立公开发布授权', () => {
  it('自动模式和存量缺省字段均保持关闭，普通设置保存不提交授权字段', async () => {
    await render();
    expect(checkbox().checked).toBe(false);
    expect(checkbox().disabled).toBe(false);
    expect(container.textContent).toContain('默认关闭，自动授权不会开启');
    expect(container.textContent).toContain('已有分享链接请在网页托管中撤销');
    await save();
    expect(updateAgentApiKey).toHaveBeenCalledOnce();
    expect(vi.mocked(updateAgentApiKey).mock.calls[0][0]).not.toHaveProperty('webPublicExposureAllowed');
  });
  it('主动勾选并保存才提交 true，同时保留配额和模型设置', async () => {
    await render();
    await act(async () => checkbox().click());
    expect(updateAgentApiKey).not.toHaveBeenCalled();
    await save();
    expect(updateAgentApiKey).toHaveBeenCalledWith(expect.objectContaining({
      id: 'client-auto', webPublicExposureAllowed: true,
      mcpDailyImageQuota: 50, mcpDailyWriteQuota: 200, mcpRateLimitPerMin: 60,
    }));
    expect(vi.mocked(updateAgentApiKey).mock.calls[0][0]).not.toHaveProperty('mcpLiteraryImageModelMode');
    expect(toast.success).toHaveBeenCalledWith('客户端设置已更新');
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it('取消发布授权不受未改动的失效模型配置阻挡', async () => {
    await render({ ...client, webPublicExposureAllowed: true,
      mcpLiteraryImageModelMode: 'fixed', mcpLiteraryImageModelPublicId: 'retired-model' });
    await act(async () => checkbox().click());
    await save();
    const input = vi.mocked(updateAgentApiKey).mock.calls[0][0];
    expect(input.webPublicExposureAllowed).toBe(false);
    expect(input).not.toHaveProperty('mcpLiteraryImageModelMode');
    expect(input).not.toHaveProperty('mcpLiteraryImageModelPublicId');
    expect(toast.success).toHaveBeenCalled();
  });
  it('没有有效网页写权限时禁止开启授权', async () => {
    await render({ ...client, scopes: ['web-pages:read'], webPublicExposureAllowed: false });
    expect(checkbox().disabled).toBe(true);
    expect(container.textContent).toContain('需先授予网页托管写入权限');
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(false);
    await save();
    expect(vi.mocked(updateAgentApiKey).mock.calls[0][0]).not.toHaveProperty('webPublicExposureAllowed');
  });
  it('网页写权限的大小写遵循服务端 scope 匹配约定', async () => {
    await render({ ...client, scopes: ['WEB-PAGES:WRITE'] });
    expect(checkbox().disabled).toBe(false);
    await act(async () => checkbox().click());
    await save();
    expect(updateAgentApiKey).toHaveBeenCalledWith(expect.objectContaining({ webPublicExposureAllowed: true }));
  });
  it('写权限被回收后仍允许取消已有公开授权', async () => {
    await render({ ...client, scopes: [], webPublicExposureAllowed: true });
    expect(checkbox().checked).toBe(true);
    expect(checkbox().disabled).toBe(false);
    await act(async () => checkbox().click());
    await save();
    expect(updateAgentApiKey).toHaveBeenCalledWith(expect.objectContaining({ webPublicExposureAllowed: false }));
  });
  it('保留已授权状态时不重新提交授权字段', async () => {
    await render({ ...client, webPublicExposureAllowed: true });
    expect(checkbox().checked).toBe(true);
    await save();
    expect(vi.mocked(updateAgentApiKey).mock.calls[0][0]).not.toHaveProperty('webPublicExposureAllowed');
  });
  it('取消后重开恢复服务端状态，不残留未保存勾选', async () => {
    await render();
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(true);
    const cancel = [...container.querySelectorAll('button')].find((item) => item.textContent === '取消');
    await act(async () => cancel!.click());
    await render(client, false); await render(client, true);
    expect(checkbox().checked).toBe(false);
    expect(updateAgentApiKey).not.toHaveBeenCalled();
  });
  it('服务端拒绝授权时保留设置，不宣称成功', async () => {
    vi.mocked(updateAgentApiKey).mockResolvedValue({
      success: false, data: null, error: { code: 'PERMISSION_DENIED', message: '请使用用户登录态修改公开授权' },
    });
    await render();
    await act(async () => checkbox().click());
    await save();
    expect(checkbox().checked).toBe(true);
    expect(toast.error).toHaveBeenCalledWith('保存失败', '请使用用户登录态修改公开授权');
    expect(onSaved).not.toHaveBeenCalled(); expect(onOpenChange).not.toHaveBeenCalled();
  });
});
