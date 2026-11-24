// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectAgentDialog } from '../ConnectAgentDialog';
import { createAgentApiKey } from '@/services';
import { copyToClipboard } from '../clipboard';
import type { MapAgentSkillState } from '../MapAgentSkillPanel';

vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ content }: { content: ReactNode }) => <div>{content}</div> }));
vi.mock('@/services', () => ({
  createAgentApiKey: vi.fn().mockResolvedValue({
    success: true, data: { apiKey: 'sk-private-test', item: { id: 'key-test' } }, error: null,
  }),
  getMcpVisibleTools: vi.fn().mockResolvedValue({ success: true, data: { toolCount: 0, tools: [], isActive: true }, error: null }),
}));
vi.mock('../clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const skillState: MapAgentSkillState = {
  manifest: {
    key: 'map-agent', version: '1.0.0', sha256: 'a'.repeat(64),
    workBuddySha256: 'b'.repeat(64), workBuddyInstall: 'download-import',
    downloadUrl: 'https://map.example.test/api/official-skills/map-agent/download',
    workBuddyDownloadUrl: 'https://map.example.test/api/official-skills/map-agent/download?client=workbuddy',
    installerUrl: 'https://map.example.test/api/official-skills/map-agent/installer',
    supportedHosts: ['.agents/skills', '.claude/skills'],
  }, loading: false, error: null, reload: vi.fn().mockResolvedValue(undefined),
};
let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
  await act(async () => root.render(<ConnectAgentDialog
    open onOpenChange={() => {}} onCreated={() => {}}
    endpointUrl="https://map.example.test/api/mcp" capabilities={[]} skillState={skillState}
  />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

function button(text: string) {
  const result = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
  expect(result, `按钮“${text}”应可见`).toBeDefined();
  return result as HTMLButtonElement;
}

it('发钥匙前即可选择 WorkBuddy，名称随客户端切换，复制内容同时带上技能', async () => {
  expect(container.querySelector('input')?.value).toBe('我的 Codex');
  expect(button('Codex').getAttribute('aria-pressed')).toBe('true');
  await act(async () => button('WorkBuddy').click());
  expect(container.querySelector('input')?.value).toBe('我的 WorkBuddy');
  await act(async () => button('生成接入配置').click());
  expect(createAgentApiKey).toHaveBeenCalledWith(expect.objectContaining({ name: '我的 WorkBuddy' }));
  expect(container.textContent).toContain('streamableHttp');
  expect(container.textContent).toContain('WorkBuddy「添加技能」中导入');
  await act(async () => button('复制完整接入提示词').click());
  const copied = vi.mocked(copyToClipboard).mock.calls[0][0];
  expect(copied).toContain('Bearer sk-private-test');
  expect(copied).toContain('?client=workbuddy');
  expect(copied).toContain('添加技能入口导入');
  expect(copied).toContain('不能以下载成功或配置保存成功代替调用成功');
});

it('用户自定义名称后切换客户端不会覆盖名称', async () => {
  const input = container.querySelector('input') as HTMLInputElement;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setValue?.call(input, '产品团队的助手');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('WorkBuddy').click());
  expect(input.value).toBe('产品团队的助手');
});
