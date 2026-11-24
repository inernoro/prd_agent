// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AskDock from './AskDock';
import AskPanel from './AskPanel';
import ShareAssistantLauncher from '../ShareAssistantLauncher';
const state = vi.hoisted(() => ({ ask: vi.fn(), refresh: vi.fn(), cancel: vi.fn() }));
vi.mock('./useAskStream', () => ({ useAskStream: () => ({ messages: [], isBusy: false, status: 'idle',
  phaseMessage: '', elapsedSeconds: 0, model: null, gateError: null, ask: state.ask, cancel: state.cancel }) }));
vi.mock('./useAskQuota', () => ({ useAskQuota: () => ({ quota: null, refresh: state.refresh }) }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.clear(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const source = { mode: 'site' as const, siteId: 'site' };
function inputValue(input: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto = input.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  act(() => { Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
function enter(input: HTMLElement, init: KeyboardEventInit = {}) {
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })));
}
describe('真实提问入口的拼音与侧栏调宽', () => {
  it.each(['bar', 'chat', 'panel'])('%s 拼音选字不发送，Shift+Enter 不发送，独立 Enter 才发送', async (mode) => {
    const common = { source, title: '网页', openingQuestions: [], allowAnonymous: true, isMobile: false };
    await act(async () => root.render(mode === 'panel' ? <AskPanel {...common} onClose={() => {}} />
      : mode === 'chat' ? <ShareAssistantLauncher><AskDock {...common} safeBottom={0} /></ShareAssistantLauncher>
      : <AskDock {...common} safeBottom={0} />));
    if (mode !== 'panel') {
      act(() => (mode === 'chat' ? document.querySelector<HTMLButtonElement>('.share-assistant-trigger')! : container.querySelector<HTMLButtonElement>('button[aria-label="向我提问"]')!).click());
      if (mode === 'chat') {
        inputValue(container.querySelector('input')!, '进入对话');
        enter(container.querySelector('input')!); state.ask.mockClear();
      }
    }
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(mode === 'bar' ? 'input' : 'textarea')!;
    inputValue(input, 'fengxian');
    act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    enter(input); enter(input, { isComposing: true }); enter(input, { keyCode: 229 });
    expect(state.ask).not.toHaveBeenCalled();
    inputValue(input, '风险如何判断');
    act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    enter(input); // Safari 的 compositionend/keydown 顺序
    expect(state.ask).not.toHaveBeenCalled();
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 100);
    enter(input, { shiftKey: true });
    expect(state.ask).not.toHaveBeenCalled();
    enter(input);
    expect(state.ask).toHaveBeenCalledTimes(1);
    expect(state.ask).toHaveBeenCalledWith('风险如何判断');
    vi.restoreAllMocks();
  });

  it('侧栏键盘调宽、双击复位，折叠再开保留宽度，手机不出现拖动柄', async () => {
    const common = { source, title: '网页', openingQuestions: [], allowAnonymous: true, safeBottom: 0 };
    const render = (isMobile = false) => act(() => root.render(<ShareAssistantLauncher><AskDock {...common} isMobile={isMobile} /></ShareAssistantLauncher>));
    await render();
    act(() => document.querySelector<HTMLButtonElement>('.share-assistant-trigger')!.click());
    inputValue(container.querySelector('input')!, '进入对话');
    enter(container.querySelector('input')!);
    const handle = () => container.querySelector<HTMLElement>('[role="separator"]')!;
    const dock = () => container.querySelector<HTMLElement>('.ask-dock')!;
    expect(dock().style.width).toBe('480px');
    act(() => handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    expect(dock().style.width).toBe('512px');
    act(() => handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(dock().style.width).toBe('480px');
    act(() => handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })));
    act(() => container.querySelector<HTMLButtonElement>('button[title="折成竖条"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('button[title="展开"]')!.click());
    expect(dock().style.width).toBe('512px');
    expect(sessionStorage.getItem('web-page-ask-width')).toBe('512');
    await render(true);
    expect(handle()).toBeNull();
    expect(Number.parseInt(dock().style.width)).toBe(window.innerWidth);
  });
});
