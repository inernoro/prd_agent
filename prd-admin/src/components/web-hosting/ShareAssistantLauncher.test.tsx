// @vitest-environment jsdom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ShareAssistantLauncher from './ShareAssistantLauncher';
import ShareSiteEditDock from './ShareSiteEditDock';
import AskDock from './ask/AskDock';
import { getSite, type HostedSite } from '@/services/real/webPages';
const stream = vi.hoisted(() => ({ mounts: 0, unmounts: 0, ask: vi.fn(), cancel: vi.fn(), clearGateError: vi.fn(), refresh: vi.fn() }));
vi.mock('./ask/useAskStream', () => ({ useAskStream: () => {
  const [messages] = useState(() => [{ id: 'u1', role: 'user', content: '原问题' }, { id: 'a1', role: 'assistant', content: '原回答' }]);
  useEffect(() => { stream.mounts++; return () => { stream.unmounts++; }; }, []);
  return { messages, status: 'idle', phaseMessage: '', elapsedSeconds: 0, model: '', gateError: null,
    clearGateError: stream.clearGateError, isBusy: false, ask: stream.ask, cancel: stream.cancel };
} }));
vi.mock('./ask/useAskQuota', () => ({ useAskQuota: () => ({ quota: null, refresh: stream.refresh }) }));
vi.mock('./ask/AskThread', () => ({ default: () => <div>原回答</div> }));
vi.mock('./SiteEditPanel', () => ({ default: () => <div>修改面板</div> }));
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ open, content, onOpenChange }: { open: boolean; content: React.ReactNode; onOpenChange: (open: boolean) => void }) => open ? <div role="dialog">{content}<button onClick={() => onOpenChange(false)}>关闭修改</button></div> : null }));
vi.mock('@/services/real/webPages', () => ({ getSite: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
const source = { mode: 'share' as const, token: 'test', siteId: 'site' };
const published = vi.fn();
function App({ edit = true, ask = true, hidden = false }: { edit?: boolean; ask?: boolean; hidden?: boolean }) {
  return <ShareAssistantLauncher hidden={hidden}>
    {ask && <AskDock source={source} title="网页" openingQuestions={[]} allowAnonymous isMobile={false} safeBottom={0} hidden={hidden} />}
    {edit && <ShareSiteEditDock siteId="site" onPublished={published} hidden={hidden} />}
  </ShareAssistantLauncher>;
}
const trigger = () => document.querySelector<HTMLButtonElement>('.share-assistant-trigger')!;
const launcher = () => document.querySelector<HTMLElement>('.share-assistant')!;
const menuAction = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find((el) => el.textContent?.includes(text))!;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks(); stream.mounts = 0; stream.unmounts = 0;
  vi.mocked(getSite).mockResolvedValue({ success: true, data: { id: 'site', title: '网页' } as HostedSite, error: null });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('统一网页助手入口', () => {
  it('默认只有圆钮，两项操作展开后可点外部或 Escape 收起', async () => {
    await act(async () => root.render(<App />));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe('网页助手');
    expect(document.querySelector<HTMLElement>('.ask-dock')!.style.display).toBe('none');
    expect(document.querySelector('button[aria-label="帮我修改"]')).toBeNull();
    act(() => trigger().click());
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    act(() => menuAction('向我提问').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
    act(() => trigger().click());
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    act(() => trigger().click());
    act(() => window.dispatchEvent(new Event('blur')));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it('提问打开时圆钮让位，折叠及隐藏恢复不销毁会话', async () => {
    await act(async () => root.render(<App />));
    act(() => trigger().click());
    act(() => menuAction('向我提问').click());
    expect(launcher().style.display).toBe('none');
    expect(document.querySelector<HTMLElement>('.ask-dock')!.getAttribute('role')).toBe('dialog');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(launcher().style.display).toBe('flex');
    expect(document.querySelector('.share-assistant-badge')?.textContent).toBe('1');
    await act(async () => root.render(<App hidden />));
    expect(launcher().style.display).toBe('none');
    await act(async () => root.render(<App />));
    expect(launcher().style.display).toBe('flex');
    expect(stream.mounts).toBe(1); expect(stream.unmounts).toBe(0);
    expect(document.querySelector('.share-assistant-badge')?.textContent).toBe('1');
  });
  it('打开修改后提问快捷键让位，关闭修改恢复入口', async () => {
    await act(async () => root.render(<App />));
    act(() => trigger().click());
    await act(async () => menuAction('帮我修改').click());
    expect(launcher().style.display).toBe('none');
    expect(document.body.textContent).toContain('修改面板');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true })));
    expect(document.querySelector<HTMLElement>('.ask-dock')!.style.display).toBe('none');
    act(() => Array.from(document.querySelectorAll('button')).find((el) => el.textContent === '关闭修改')!.click());
    expect(launcher().style.display).toBe('flex');
    expect(getSite).toHaveBeenCalledTimes(1);
  });
  it('修改加载失败可重试，等待时关闭后不会迟到重开面板', async () => {
    let finish!: (value: Awaited<ReturnType<typeof getSite>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof getSite>>>((resolve) => { finish = resolve; });
    vi.mocked(getSite).mockRejectedValueOnce(new Error('网络中断')).mockReturnValueOnce(pending);
    await act(async () => root.render(<App />));
    act(() => trigger().click());
    expect(menuAction('帮我修改').disabled).toBe(false);
    act(() => menuAction('帮我修改').click());
    expect(launcher().style.display).toBe('none');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true })));
    expect(document.querySelector<HTMLElement>('.ask-dock')!.style.display).toBe('none');
    act(() => Array.from(document.querySelectorAll('button')).find((el) => el.textContent === '关闭修改')!.click());
    await act(async () => finish({ success: true, data: { id: 'site', title: '网页' } as HostedSite, error: null }));
    expect(document.body.textContent).not.toContain('修改面板');
    act(() => trigger().click());
    await act(async () => menuAction('帮我修改').click());
    expect(document.body.textContent).toContain('修改面板');
    expect(getSite).toHaveBeenCalledTimes(2);
  });
  it('只有提问时直接打开；两项都不可用时不显示空入口', async () => {
    await act(async () => root.render(<App edit={false} />));
    expect(trigger().getAttribute('aria-label')).toBe('向我提问');
    act(() => trigger().click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(launcher().style.display).toBe('none');
    await act(async () => root.render(<App edit={false} ask={false} />));
    expect(launcher().style.display).toBe('none');
  });
});
