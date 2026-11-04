// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyWithFeedback } from '@/lib/clipboard';
import AskThread from './AskThread';
import type { AskMessage } from './askTypes';

vi.mock('@/lib/clipboard', () => ({ copyWithFeedback: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
const onPick = vi.fn();
const answer = '风险评分包含三个维度。[^1]\n\n[^1]: 风险分、置信度、业务价值。';
const messages: AskMessage[] = [
  { id: 'u1', role: 'user', content: '风险评分由哪些维度组成？' },
  { id: 'a1', role: 'assistant', content: answer, streaming: false },
];
const questions = ['风险评分由哪些维度组成?', '怎么分层处理风险？', '怎么分层处理风险?', '规则如何降级？', '有哪些例外？', '谁负责审核？'];
const props: ComponentProps<typeof AskThread> = {
  messages, title: '风控规则', openingQuestions: questions, onPick,
  refusal: null, onLogin: vi.fn(), onRetry: vi.fn(), isBusy: false,
  phaseMessage: '', elapsedSeconds: 0, onCancel: vi.fn(),
};
const footer = () => container.querySelector<HTMLElement>('[aria-label="回答操作与后续问题"]');
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const render = (overrides: Partial<ComponentProps<typeof AskThread>> = {}) => act(() => root.render(<AskThread {...props} {...overrides} />));
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(copyWithFeedback).mockResolvedValue(true);
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

describe('回答完成后的操作与本页续问', () => {
  it('最新成功回答显示完成状态和三条未问过的本页问题，点击发送真实问题', () => {
    render();
    expect(footer()?.textContent).toContain('回答完成');
    const picks = container.querySelectorAll<HTMLButtonElement>('.ask-answer-followup');
    expect([...picks].map((pick) => pick.textContent)).toEqual(['怎么分层处理风险？', '规则如何降级？', '有哪些例外？']);
    act(() => picks[1].click());
    expect(onPick).toHaveBeenCalledWith('规则如何降级？');
    act(() => button('再问一次').click());
    expect(onPick).toHaveBeenLastCalledWith(messages[0].content);
  });

  it('复制保留答案与原文脚注，复制失败不显示成功状态', async () => {
    render();
    await act(async () => button('复制回答').click());
    expect(copyWithFeedback).toHaveBeenCalledWith(answer, expect.objectContaining({ successMessage: '已复制回答及引用' }));
    expect(button('已复制回答')).not.toBeNull();
    vi.mocked(copyWithFeedback).mockResolvedValue(false);
    await act(async () => button('已复制回答').click());
    expect(button('复制回答')).not.toBeNull();
    expect(container.querySelector('[aria-label="已复制回答"]')).toBeNull();
  });

  it.each([
    { messages: [] },
    { messages: [messages[0]] },
    { messages: [messages[0], { ...messages[1], content: '' }] },
    { messages: [messages[0], { ...messages[1], streaming: true }], isBusy: true },
    { messages: [messages[0], { ...messages[1], error: '已停止回答' }] },
    { messages: [messages[0], { ...messages[1], error: '回答被中断' }] },
  ])('未完成、停止和错误状态不冒充回答完成：%j', (overrides) => {
    render(overrides);
    expect(footer()).toBeNull();
  });

  it('无题库或本条分享未选问题时只显示操作，不编造推荐；问完一轮只保留最新完成区', () => {
    render({ openingQuestions: [] });
    expect(footer()).not.toBeNull();
    expect(container.querySelector('.ask-answer-next')).toBeNull();
    render({ openingQuestions: ['风险评分由哪些维度组成?'] });
    expect(container.querySelector('.ask-answer-next')).toBeNull();
    render({ messages: [...messages, { id: 'u2', role: 'user', content: '规则如何降级？' }, { id: 'a2', role: 'assistant', content: '新回答' }] });
    expect(container.querySelectorAll('.ask-answer-footer')).toHaveLength(1);
    expect(container.querySelector('.ask-answer-next')?.textContent).not.toContain('规则如何降级？');
    act(() => button('再问一次').click());
    expect(onPick).toHaveBeenLastCalledWith('规则如何降级？');
  });

  it('登录或额度门禁出现时禁止续问和再问，仍可复制已有答案', async () => {
    render({ refusal: 'need-login' });
    expect(button('再问一次').disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLButtonElement>('.ask-answer-followup')].every((pick) => pick.disabled)).toBe(true);
    expect(button('复制回答').disabled).toBe(false);
    await act(async () => button('复制回答').click());
    expect(copyWithFeedback).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('尚未提问时题库更新不把欢迎语滚出视野', () => {
    render({ messages: [] });
    const scroll = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(scroll, { scrollHeight: { value: 600, configurable: true }, clientHeight: { value: 200, configurable: true } });
    scroll.scrollTop = 0;
    render({ messages: [], openingQuestions: [...questions] });
    expect(scroll.scrollTop).toBe(0);
  });

  it('完成区增高时继续跟随底部，用户上翻历史时不抢滚动位置', () => {
    render();
    const scroll = container.firstElementChild as HTMLDivElement;
    Object.defineProperties(scroll, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 500, configurable: true } });
    scroll.scrollTop = 500;
    act(() => scroll.dispatchEvent(new Event('scroll')));
    Object.defineProperty(scroll, 'scrollHeight', { value: 1250, configurable: true });
    render({ messages: [...messages] });
    expect(scroll.scrollTop).toBe(1250);
    scroll.scrollTop = 100;
    act(() => scroll.dispatchEvent(new Event('scroll')));
    Object.defineProperty(scroll, 'scrollHeight', { value: 1500, configurable: true });
    render({ messages: [...messages] });
    expect(scroll.scrollTop).toBe(100);
  });
});
