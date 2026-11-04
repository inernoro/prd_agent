// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AskConfigDrawer from './AskConfigDrawer';
import { getSiteAskConfig, updateSiteAskConfig, regenerateSiteAskQuestions } from '@/services/real/webPages';
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

const regenerate = () => Array.from(container.querySelectorAll('button')).find((el) => el.textContent === '重新生成')!;
const enabledSwitch = () => container.querySelector<HTMLButtonElement>('[aria-label="开放提问"]')!;
async function openQuestions() {
  await act(async () => Array.from(container.querySelectorAll('summary')).find((el) => el.textContent?.includes('开场问题'))!.click());
}

describe('开场问题生成使用已保存的启用状态', () => {
  it('关闭及开启待保存时不请求生成，保存失败继续拦截，保存成功后才允许生成', async () => {
    vi.mocked(getSiteAskConfig).mockResolvedValue({ success: true, data: { ...config, enabled: false, siteEnabled: false }, error: null });
    await act(async () => root.render(<AskConfigDrawer siteId="site" siteTitle="网页" embedded onClose={vi.fn()} />));
    await openQuestions();
    expect(regenerate().disabled).toBe(true);
    await act(async () => enabledSwitch().click());
    expect(enabledSwitch().getAttribute('aria-checked')).toBe('true');
    expect(regenerate().disabled).toBe(true);
    expect(container.textContent).toContain('请先保存提问设置');
    await act(async () => regenerate().click());
    expect(regenerateSiteAskQuestions).not.toHaveBeenCalled();
    vi.mocked(updateSiteAskConfig).mockRejectedValueOnce(new Error('保存失败'));
    await act(async () => save().click());
    expect(regenerate().disabled).toBe(true);
    vi.mocked(updateSiteAskConfig).mockResolvedValue({ success: true, data: config, error: null });
    await act(async () => save().click());
    expect(updateSiteAskConfig).toHaveBeenLastCalledWith('site', expect.objectContaining({ enabled: true }));
    expect(regenerate().disabled).toBe(false);
    vi.mocked(regenerateSiteAskQuestions).mockResolvedValue({ success: true, data: { siteId: 'site', generated: true, suggestedQuestions: ['新的开场问题'], questionsSource: 'auto' }, error: null });
    await act(async () => regenerate().click());
    expect(container.textContent).toContain('新的开场问题');
    await act(async () => save().click());
    expect(updateSiteAskConfig).toHaveBeenLastCalledWith('site', { welcome: '欢迎', allowAnonymous: true, dailyLimit: 10 });
  });

  it('沿用个人默认且已经开启时可直接生成，不强制写入站点覆盖', async () => {
    vi.mocked(regenerateSiteAskQuestions).mockResolvedValue({ success: true, data: { siteId: 'site', generated: true, suggestedQuestions: ['生成的问题'], questionsSource: 'auto' }, error: null });
    await act(async () => root.render(<AskConfigDrawer siteId="site" siteTitle="网页" embedded onClose={vi.fn()} />));
    await openQuestions();
    expect(regenerate().disabled).toBe(false);
    await act(async () => regenerate().click());
    expect(regenerateSiteAskQuestions).toHaveBeenCalledWith('site');
    expect(updateSiteAskConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain('生成的问题');
  });

  it('切换开关后清除旧生成提示，不让旧结论描述新草稿状态', async () => {
    vi.mocked(regenerateSiteAskQuestions).mockResolvedValue({ success: true, data: { siteId: 'site', generated: false, outcome: 'Skipped', suggestedQuestions: [], message: '配置已变化，请重新打开设置' }, error: null });
    await act(async () => root.render(<AskConfigDrawer siteId="site" siteTitle="网页" embedded onClose={vi.fn()} />));
    await openQuestions();
    await act(async () => regenerate().click());
    expect(container.textContent).toContain('配置已变化');
    await act(async () => enabledSwitch().click());
    expect(container.textContent).not.toContain('配置已变化');
    expect(regenerate().disabled).toBe(true);
  });

  it('生成忙碌或失败时保留未保存的手写题，随后保存仍提交草稿', async () => {
    vi.mocked(regenerateSiteAskQuestions).mockResolvedValue({ success: true, data: { siteId: 'site', generated: false, outcome: 'Busy', suggestedQuestions: ['旧问题'], questionsSource: 'auto', message: '已经有一次生成在跑' }, error: null });
    vi.mocked(updateSiteAskConfig).mockResolvedValue({ success: true, data: config, error: null });
    await act(async () => root.render(<AskConfigDrawer siteId="site" siteTitle="网页" embedded onClose={vi.fn()} />));
    await openQuestions();
    const input = container.querySelector<HTMLInputElement>('[placeholder="添加一个开场问题…"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '尚未保存的问题');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="添加"]')!.click());
    await act(async () => regenerate().click());
    expect(container.textContent).toContain('尚未保存的问题');
    expect(container.textContent).toContain('你自己写的');
    await act(async () => save().click());
    expect(updateSiteAskConfig).toHaveBeenLastCalledWith('site', expect.objectContaining({ suggestedQuestions: ['旧问题', '尚未保存的问题'] }));
  });
});
