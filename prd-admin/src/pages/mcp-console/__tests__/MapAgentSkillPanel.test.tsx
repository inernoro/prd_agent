// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MapAgentSkillPanel, type MapAgentSkillState } from '../MapAgentSkillPanel';
import { copyToClipboard } from '../clipboard';

vi.mock('../clipboard', () => ({ copyToClipboard: vi.fn().mockResolvedValue(true) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const state: MapAgentSkillState = {
  manifest: {
    key: 'map-agent', version: '1.0.0', sha256: 'a'.repeat(64),
    downloadUrl: 'https://map.example.test/api/official-skills/map-agent/download',
    workBuddyDownloadUrl: 'https://map.example.test/api/official-skills/map-agent/download?client=workbuddy',
    workBuddySha256: 'b'.repeat(64),
    installerUrl: 'https://map.example.test/api/official-skills/map-agent/installer',
    supportedHosts: ['.agents/skills', '.claude/skills'], workBuddyInstall: 'download-import',
  },
  loading: false, error: null, reload: vi.fn().mockResolvedValue(undefined),
};

describe('接入台技能操作', () => {
  let element: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    element = document.createElement('div');
    document.body.append(element);
    root = createRoot(element);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    element.remove();
  });

  it('直接给下载入口；版本声明是发布版本，复制更新不冒充安装完成', async () => {
    await act(async () => root.render(<MapAgentSkillPanel state={state} endpointUrl="https://map.example.test/api/mcp" />));
    expect(element.textContent).toContain('服务发布版本 1.0.0');
    expect(element.textContent).toContain('网页无法读取本机已装版本');
    expect(element.querySelector('a')?.href).toBe(state.manifest?.downloadUrl);
    const updateButton = [...element.querySelectorAll('button')].find((button) => button.textContent === '复制更新指令');
    await act(async () => updateButton?.click());
    expect(copyToClipboard).toHaveBeenCalledWith(expect.stringContaining(' update --manifest-url '));
    expect(element.textContent).toContain('复制更新指令已复制');
    expect(element.textContent).not.toContain('安装成功');
  });

  it('切换 WorkBuddy 后下载和复制指令都指向导入流程', async () => {
    await act(async () => root.render(<MapAgentSkillPanel state={state} endpointUrl="https://map.example.test/api/mcp" />));
    const select = element.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      select.value = 'workbuddy';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(element.textContent).toContain('WorkBuddy「添加技能」中导入');
    expect(element.querySelector('a')?.href).toBe(state.manifest?.workBuddyDownloadUrl);
    const installButton = [...element.querySelectorAll('button')].find((button) => button.textContent === '复制安装指令');
    await act(async () => installButton?.click());
    expect(copyToClipboard).toHaveBeenCalledWith(expect.stringContaining('添加技能入口导入'));
    expect(vi.mocked(copyToClipboard).mock.calls[0][0]).not.toContain('~/.workbuddy');
  });

  it('读取失败显示恢复入口，不把失败当作没有技能', async () => {
    const failure = { ...state, manifest: null, error: '技能版本没读到，请重试。' };
    await act(async () => root.render(<MapAgentSkillPanel state={failure} endpointUrl="https://map.example.test/api/mcp" />));
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('技能版本没读到');
    expect(element.querySelector('a')).toBeNull();
    await act(async () => element.querySelector('button')?.click());
    expect(state.reload).toHaveBeenCalledOnce();
  });
});
