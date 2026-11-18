// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AnnotationBubble } from './AnnotationBubble';
import type { HostedAnnotations } from './useHostedAnnotations';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = async () => {};
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup(width = 900) {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width < 820 ? 240 : 292);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return width < 820 && this.classList.contains('is-active') ? 165 : 120;
  });
  HTMLElement.prototype.setPointerCapture = vi.fn(); HTMLElement.prototype.releasePointerCapture = vi.fn();
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  const annotations = { enabled: false, draftAnchor: null, displayMode: 'bubble', activeId: 'two',
    threads: ['one', 'two'].map(id => ({ id, anchor: {}, authorName: '小林', content: `意见-${id}` })),
    previews: ['one', 'two'].map(id => ({ id, rect: { left: 200, top: 300, width: 300, height: 40 }, obstacles: [] })),
    allPreviewsHidden: false, hideAllPreviews: vi.fn(), showAllPreviews: vi.fn(), dismissPreview: vi.fn(), openThread: vi.fn(), setActiveId: vi.fn() } as unknown as HostedAnnotations;
  const render = async () => act(async () => root.render(<AnnotationBubble annotations={annotations} />));
  await render(); cleanup = async () => { await act(async () => root.unmount()); container.remove(); };
  return { annotations, render, container };
}

it('同时显示每条气泡，编号与选中一致，单条关闭不影响另一条', async () => {
  const { container, annotations } = await setup();
  const cards = container.querySelectorAll<HTMLElement>('[data-bubble-id]');
  expect(cards).toHaveLength(2); expect(cards[1].classList.contains('is-active')).toBe(true);
  expect(cards[0].textContent).toContain('意见-one'); expect(cards[1].textContent).toContain('意见-two');
  expect(Number.parseFloat(cards[1].style.top) - Number.parseFloat(cards[0].style.top)).toBeGreaterThanOrEqual(128);
  expect(cards[0].querySelector('.annotation-chat-actions')).toBeNull();
  expect(container.querySelectorAll('.annotation-bubble-connectors path')).toHaveLength(1);
  await act(async () => cards[0].querySelector<HTMLButtonElement>('.annotation-chat-select')!.click());
  expect(annotations.setActiveId).toHaveBeenCalledWith('one');
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="收起批注气泡 2"]')!.click());
  expect(annotations.dismissPreview).toHaveBeenCalledWith('two');
});

it('旧历史网页只发送单条预览时仍可读，新协议明确空集合时不复活旧气泡', async () => {
  const { container, annotations, render } = await setup();
  annotations.preview = annotations.previews![0]; annotations.previews = null; await render();
  expect(container.querySelectorAll('[data-bubble-id]')).toHaveLength(1);
  expect(container.textContent).toContain('意见-one');
  annotations.previews = []; await render();
  expect(container.querySelector('[data-bubble-id]')).toBeNull();
});

it('所有锚点暂时离开视口时保留页边容器，避免宽度反复变化让气泡闪烁', async () => {
  const { container, annotations, render } = await setup();
  const canvas = container.querySelector('.annotation-bubble-canvas');
  annotations.previews = []; await render();
  expect(container.querySelector('[data-bubble-id]')).toBeNull();
  expect(container.querySelector('.annotation-bubble-canvas')).toBe(canvas);
});

it('边缘拖动有限位，滚动暂时离屏再回来保留位置，正文按钮保持可点', async () => {
  const { container, annotations, render } = await setup();
  let card = container.querySelector<HTMLElement>('[data-bubble-id="one"]')!;
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ left: 200, top: 166, right: 492, bottom: 286, width: 292, height: 120 } as DOMRect);
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 }); return event;
  };
  await act(async () => { card.dispatchEvent(pointer('pointerdown', 201, 220)); card.dispatchEvent(pointer('pointermove', 5000, 5000)); card.dispatchEvent(pointer('pointerup', 5000, 5000)); });
  expect(Number.parseFloat(card.style.left)).toBe(600); expect(Number.parseFloat(card.style.top)).toBe(572);
  const previews = annotations.previews; annotations.previews = []; await render(); annotations.previews = previews; await render();
  card = container.querySelector<HTMLElement>('[data-bubble-id="one"]')!;
  expect(Number.parseFloat(card.style.left)).toBe(600); expect(Number.parseFloat(card.style.top)).toBe(572);
  annotations.activeId = 'one'; await render();
  await act(async () => card.querySelector<HTMLButtonElement>('.annotation-chat-open')!.click());
  expect(annotations.openThread).toHaveBeenCalledWith('one');
  await act(async () => card.querySelector('[aria-label="移动批注气泡 1"]')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' })));
  expect(Number.parseFloat(card.style.left)).toBe(584);
});

it('连续几何更新保持同一气泡节点，自动位置和拖动偏移都随标注移动', async () => {
  const { container, annotations, render } = await setup();
  const first = container.querySelector<HTMLElement>('[data-bubble-id="one"]')!, before = Number.parseFloat(first.style.top);
  annotations.previews = annotations.previews!.map(item => ({ ...item, rect: { ...item.rect, top: item.rect.top - 30 } }));
  await render();
  expect(container.querySelector('[data-bubble-id="one"]')).toBe(first); expect(Number.parseFloat(first.style.top)).toBe(before - 30);
  await act(async () => first.querySelector('[aria-label="移动批注气泡 1"]')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })));
  const moved = Number.parseFloat(first.style.top);
  annotations.previews = annotations.previews!.map(item => ({ ...item, rect: { ...item.rect, top: item.rect.top - 20 } })); await render();
  expect(Number.parseFloat(first.style.top)).toBe(moved - 20);
});
it('气泡提供全显全隐图标，超长内容只渲染短摘要', async () => {
  const { container, annotations, render } = await setup();
  annotations.threads = annotations.threads.map(thread => ({ ...thread, content: '长内容'.repeat(100000) })); await render();
  expect(container.querySelector('[data-bubble-id="one"] p')!.textContent!.length).toBeLessThanOrEqual(281);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="隐藏全部气泡"]')!.click()); expect(annotations.hideAllPreviews).toHaveBeenCalledOnce();
  annotations.allPreviewsHidden = true; await render();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="显示全部气泡"]')!.click()); expect(annotations.showAllPreviews).toHaveBeenCalledOnce();
});

it('窄屏展开或收起一条时，保留其他气泡的位置', async () => {
  const { container, annotations, render } = await setup(390);
  annotations.previews = annotations.previews!.map(item => ({
    ...item, rect: { left: 22, top: 90, width: 170, height: 40 },
  }));
  annotations.activeId = 'one'; await render();
  const other = container.querySelector<HTMLElement>('[data-bubble-id="two"]')!;
  const before = [other.style.left, other.style.top];
  annotations.activeId = null; await render();
  expect([other.style.left, other.style.top]).toEqual(before);
  annotations.activeId = 'one'; await render();
  expect([other.style.left, other.style.top]).toEqual(before);
});

it('双栏页边批注贴向正文且能用讨论业务桥直接回复与解决', async () => {
  const { container, annotations, render } = await setup(1440);
  annotations.dualColumn = true;
  annotations.column = { right: 918, paper: 'rgb(255, 255, 255)' };
  const reply = vi.fn().mockResolvedValueOnce('发送失败，草稿已保留。').mockResolvedValueOnce(null);
  const resolve = vi.fn().mockResolvedValue(null);
  annotations.discussionActions = { canReply: true, canResolve: () => true, reply, resolve, getReplies: () => [] };
  await render();
  const selected = container.querySelector<HTMLElement>('[data-bubble-id="two"]')!;
  expect(selected.style.left).toBe('958px');
  await act(async () => selected.querySelector<HTMLButtonElement>('.annotation-chat-reply-trigger')!.click());
  const textarea = selected.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '直接回复本条批注');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => selected.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(selected.querySelector('[role="alert"]')!.textContent).toContain('草稿已保留');
  expect(textarea.value).toBe('直接回复本条批注');
  await act(async () => selected.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
  expect(reply.mock.calls[1]).toEqual(reply.mock.calls[0]);
  await act(async () => [...selected.querySelectorAll('button')].find(button => button.textContent === '解决')!.click());
  expect(resolve).toHaveBeenCalledWith('two');
});
