// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AskConfigDrawer from './AskConfigDrawer';
import { getSiteAskConfig, updateSiteAskConfig } from '@/services/real/webPages';
vi.mock('@/services/real/webPages', () => ({ getSiteAskConfig: vi.fn(), updateSiteAskConfig: vi.fn(), regenerateSiteAskQuestions: vi.fn() }));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSectionLoader: () => <div>读取中</div>, MapSpinner: () => <span /> }));
const config = { siteId: 'site', siteEnabled: null, maxQuestions: 12, maxQuestionLength: 60, enabled: true, allowAnonymous: true, welcome: '欢迎', dailyLimit: 10, suggestedQuestions: ['旧问题'], questionsSource: 'auto' as const };
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  vi.mocked(getSiteAskConfig).mockResolvedValue({ success: true, data: config, error: null });
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const save = () => Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '保存提问设置')!;

describe('嵌入式提问设置', () => {
  it('读取失败不允许用默认值覆盖原配置', async () => {
    vi.mocked(getSiteAskConfig).mockRejectedValue(new Error('网络中断'));
    await act(async () => root.render(<AskConfigDrawer siteId="site" siteTitle="网页" embedded onClose={vi.fn()} />));
    expect(save().disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('读取配置失败');
    expect(updateSiteAskConfig).not.toHaveBeenCalled();
  });
  it('未改过的启用覆盖值与自动题库不回写，保存后保留窗口', async () => {
    const onClose = vi.fn();
    vi.mocked(updateSiteAskConfig).mockResolvedValue({ success: true, data: config, error: null });
    await act(async () => root.render(<AskConfigDrawer siteId="site" siteTitle="网页" embedded onClose={onClose} />));
    await act(async () => save().click());
    expect(updateSiteAskConfig).toHaveBeenCalledWith('site', { welcome: '欢迎', allowAnonymous: true, dailyLimit: 10 });
    expect(container.querySelector('[role="status"]')?.textContent).toBe('提问设置已保存');
    expect(onClose).not.toHaveBeenCalled();
  });
  it('保存异常后保留输入并解除忙碌状态以便重试', async () => {
    const busy = vi.fn();
    vi.mocked(updateSiteAskConfig).mockRejectedValue(new Error('网络中断'));
    await act(async () => root.render(<AskConfigDrawer siteId="site" siteTitle="网页" embedded onClose={vi.fn()} onBusyChange={busy} />));
    await act(async () => save().click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('网络中断');
    expect(save().disabled).toBe(false);
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('textarea')?.value).toBe('欢迎');
  });
});
