// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaEditorDialog } from '../QuotaEditorDialog';
import { updateAgentApiKey } from '@/services';
import { toast } from '@/lib/toast';
import type { McpCapabilityDto, McpClientDto } from '@/services/contracts/mcpConsole';

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
async function render(value: McpClientDto = client, open = true, capabilities: McpCapabilityDto[] = []) {
  await act(async () => root.render(<QuotaEditorDialog
    client={value} open={open} onOpenChange={onOpenChange} onSaved={onSaved} capabilities={capabilities} onRevoke={() => {}}
  />));
}
function checkbox() {
  const input = container.querySelector<HTMLInputElement>('input[aria-describedby="mcp-web-public-exposure-hint"]');
  expect(input).not.toBeNull();
  return input!;
}
async function save() {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '保存设置');
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
  it.each(['write', 'refresh'] as const)('在%s阶段取消并打开另一客户端后，旧保存不能关闭新编辑器', async (stage) => {
    let finish!: () => void;
    if (stage === 'write') {
      vi.mocked(updateAgentApiKey).mockImplementationOnce(() => new Promise((resolve) => {
        finish = () => resolve({ success: true, data: { item: null }, error: null });
      }));
    } else onSaved.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render();
    await act(async () => checkbox().click());
    await save();
    const cancel = [...container.querySelectorAll('button')].find((item) => item.textContent === '取消');
    await act(async () => cancel!.click());
    await render(client, false);
    await render({ ...client, keyId: 'another-client', name: '另一台客户端' }, true);
    expect(checkbox().checked).toBe(false);
    expect(checkbox().disabled).toBe(false);
    onOpenChange.mockClear();
    await act(async () => finish());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(checkbox().checked).toBe(false);
  });
  it('列表读回完成前保留保存中状态，避免立即重开读到旧授权', async () => {
    let finishRefresh!: () => void;
    onSaved.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
    await render();
    await act(async () => checkbox().click());
    await save();
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(checkbox().disabled).toBe(true);
    await act(async () => finishRefresh());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
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

const tasks: McpCapabilityDto = { key: 'tasks', title: '任务台', summary: '',
  readScope: 'active-tasks:use', writeScope: 'active-tasks:manage', writeNeedsApproval: false,
  availableToMe: true, writeAvailableToMe: true, granted: false, todayCalls: 0, tools: [] };

describe('授权编辑边界', () => {
  it.each(['disabled', 'expired'] as const)('%s凭证的有效权限为空时禁止覆盖存储授权', async (unusableReason) => {
    await render({ ...client, isActive: false, unusableReason, scopeMode: 'manual', scopes: [] }, true, [tasks]);
    const mode = container.querySelector<HTMLInputElement>('.mcp-scope-mode input')!;
    const access = container.querySelector<HTMLSelectElement>('[aria-label="任务台访问权限"]')!;
    expect(mode.disabled).toBe(true);
    expect(access.disabled).toBe(true);
    await act(async () => mode.click());
    await save();
    const request = vi.mocked(updateAgentApiKey).mock.calls[0][0];
    expect(request).not.toHaveProperty('scopes');
    expect(request).not.toHaveProperty('scopeMode');
    expect(container.textContent).toContain('不会覆盖原有授权');
  });
  it('任务台基础权限明确包含写入动作，不能承诺只读', async () => {
    await render({ ...client, scopeMode: 'manual', scopes: ['active-tasks:use'] }, true, [tasks]);
    const access = container.querySelector<HTMLSelectElement>('[aria-label="任务台访问权限"]')!;
    expect(access.selectedOptions[0].textContent).toBe('使用任务台');
    expect([...access.options].map(option => option.text)).toContain('管理任务台');
    expect([...access.options].map(option => option.text)).not.toContain('只读');
    expect(container.textContent).toContain('新增自己的任务、提交建议及同步债务');
  });
});


describe('派生发布权限不进入普通授权清单', () => {
  it.each(['auto', 'manual'] as const)('%s模式编辑授权时保留独立接口并排除派生scope', async (scopeMode) => {
    await render({ ...client, scopeMode, webPublicExposureAllowed: true,
      scopes: ['web-pages:write', 'web-pages:publish', 'agent.example:invoke'] }, true, [tasks]);
    if (scopeMode === 'auto') {
      await act(async () => container.querySelector<HTMLInputElement>('.mcp-scope-mode input')!.click());
    } else {
      const access = container.querySelector<HTMLSelectElement>('[aria-label="任务台访问权限"]')!;
      await act(async () => { access.value = 'read'; access.dispatchEvent(new Event('change', { bubbles: true })); });
    }
    await save();
    const request = vi.mocked(updateAgentApiKey).mock.calls[0][0];
    expect(request.scopeMode).toBe('manual');
    expect(request.scopes).toContain('web-pages:write');
    expect(request.scopes).toContain('agent.example:invoke');
    expect(request.scopes).not.toContain('web-pages:publish');
    expect(request).not.toHaveProperty('webPublicExposureAllowed');
  });
});


const web: McpCapabilityDto = { ...tasks, key: 'web', title: '网页托管', readScope: 'web-pages:read', writeScope: 'web-pages:write' };
describe('发布授权跟随当前编辑权限', () => {
  it('同次保存新增网页写权限和独立发布授权', async () => {
    await render({ ...client, scopeMode: 'manual', scopes: ['web-pages:read'] }, true, [web]);
    expect(checkbox().disabled).toBe(true);
    const access = container.querySelector<HTMLSelectElement>('[aria-label="网页托管访问权限"]')!;
    await act(async () => { access.value = 'write'; access.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(checkbox().disabled).toBe(false);
    await act(async () => checkbox().click());
    await save();
    expect(updateAgentApiKey).toHaveBeenCalledWith(expect.objectContaining({
      scopes: ['web-pages:read', 'web-pages:write'], webPublicExposureAllowed: true,
    }));
  });
  it('删除编辑中的网页写权限时取消尚未保存的发布授权', async () => {
    await render({ ...client, scopeMode: 'manual', scopes: ['web-pages:read', 'web-pages:write'] }, true, [web]);
    await act(async () => checkbox().click());
    expect(checkbox().checked).toBe(true);
    const access = container.querySelector<HTMLSelectElement>('[aria-label="网页托管访问权限"]')!;
    await act(async () => { access.value = 'read'; access.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(checkbox().checked).toBe(false);
    expect(checkbox().disabled).toBe(true);
    await save();
    expect(vi.mocked(updateAgentApiKey).mock.calls[0][0].scopes).toEqual(['web-pages:read']);
    expect(vi.mocked(updateAgentApiKey).mock.calls[0][0]).not.toHaveProperty('webPublicExposureAllowed');
  });
});
