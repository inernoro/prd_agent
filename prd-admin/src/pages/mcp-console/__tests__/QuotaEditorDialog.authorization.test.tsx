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
function saveButton() {
  const button = [...container.querySelectorAll('button')].find((item) => ['保存设置', '保存中…'].includes(item.textContent ?? ''));
  expect(button).toBeDefined();
  return button!;
}
async function save() {
  await act(async () => saveButton().click());
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.clearAllMocks();
  vi.mocked(updateAgentApiKey).mockResolvedValue({ success: true, data: { item: null }, error: null });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('保存与读回', () => {
  it.each(['write', 'refresh'] as const)('在%s阶段取消并打开另一客户端后，旧保存不能关闭新编辑器', async (stage) => {
    let finish!: () => void;
    if (stage === 'write') {
      vi.mocked(updateAgentApiKey).mockImplementationOnce(() => new Promise((resolve) => {
        finish = () => resolve({ success: true, data: { item: null }, error: null });
      }));
    } else onSaved.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render();
    await save();
    const cancel = [...container.querySelectorAll('button')].find((item) => item.textContent === '取消');
    await act(async () => cancel!.click());
    await render(client, false);
    await render({ ...client, keyId: 'another-client', name: '另一台客户端' }, true);
    expect(saveButton().disabled).toBe(false);
    onOpenChange.mockClear();
    await act(async () => finish());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('列表读回完成前保留保存中状态，避免立即重开读到旧授权', async () => {
    let finishRefresh!: () => void;
    onSaved.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRefresh = resolve; }));
    await render();
    await save();
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);
    await act(async () => finishRefresh());
    expect(onOpenChange).toHaveBeenCalledWith(false);
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
    expect(container.textContent).toContain('新增自己的任务及提交建议');
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
    expect(request).not.toHaveProperty('scopes');
    expect(request.mcpCapabilityAccess).toEqual(scopeMode === 'auto' ? {} : { tasks: 'read' });
    expect(request).not.toHaveProperty('webPublicExposureAllowed');
  });
});


const web: McpCapabilityDto = { ...tasks, key: 'web', title: '网页托管', readScope: null, writeScope: 'web-pages:write' };

describe('网页托管使用一个授权', () => {
  it.each(['write', 'none'] as const)('保存网页托管授权 %s', async (level) => {
    const scopes = level === 'write' ? [] : ['web-pages:write'];
    await render({ ...client, scopeMode: 'manual', scopes }, true, [web]);
    const access = container.querySelector<HTMLSelectElement>('[aria-label="网页托管访问权限"]')!;
    expect([...access.options].map(option => option.text)).toEqual(['未开放', '完整权限']);
    await act(async () => { access.value = level; access.dispatchEvent(new Event('change', { bubbles: true })); });
    await save();
    const request = vi.mocked(updateAgentApiKey).mock.calls[0][0];
    expect(request.mcpCapabilityAccess).toEqual({ web: level });
    expect(request).not.toHaveProperty('webPublicExposureAllowed');
  });
});

describe('有效权限不覆盖存储配置', () => {
  it('账号权限被收回时只提交实际编辑的能力', async () => {
    const unavailable = { ...tasks, key: 'visual', title: '视觉创作', readScope: null,
      writeScope: 'visual-agent:use', availableToMe: false, writeAvailableToMe: false };
    await render({ ...client, scopeMode: 'manual', scopes: ['active-tasks:use'] }, true, [unavailable, tasks]);
    const visual = container.querySelector<HTMLSelectElement>('[aria-label="视觉创作访问权限"]')!;
    expect(visual.disabled).toBe(true);
    const access = container.querySelector<HTMLSelectElement>('[aria-label="任务台访问权限"]')!;
    await act(async () => { access.value = 'none'; access.dispatchEvent(new Event('change', { bubbles: true })); });
    await save();
    const request = vi.mocked(updateAgentApiKey).mock.calls[0][0];
    expect(request).not.toHaveProperty('scopes');
    expect(request.mcpCapabilityAccess).toEqual({ tasks: 'none' });
  });
});
