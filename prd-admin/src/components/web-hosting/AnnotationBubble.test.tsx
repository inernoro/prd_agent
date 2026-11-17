// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AnnotationBubble } from './AnnotationBubble';
import type { HostedAnnotations } from './useHostedAnnotations';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let cleanup = async () => {};
afterEach(async () => { await cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup() {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(292);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
  HTMLElement.prototype.setPointerCapture = vi.fn(); HTMLElement.prototype.releasePointerCapture = vi.fn();
  const container = document.createElement('div'); document.body.appendChild(container); const root = createRoot(container);
  const annotations = { enabled: false, draftAnchor: null, displayMode: 'bubble', activeId: 'two',
    threads: ['one', 'two'].map(id => ({ id, anchor: {}, authorName: '小林', content: `意见-${id}` })),
    previews: ['one', 'two'].map(id => ({ id, rect: { left: 200, top: 300, width: 300, height: 40 }, obstacles: [] })),
    allPreviewsHidden: false, hideAllPreviews: vi.fn(), showAllPreviews: vi.fn(), dismissPreview: vi.fn(), openThread: vi.fn() } as unknown as HostedAnnotations;
  const render = async () => act(async () => root.render(<AnnotationBubble annotations={annotations} />));
  await render(); cleanup = async () => { await act(async () => root.unmount()); container.remove(); };
  return { annotations, render, container };
}

it('同时显示每条气泡，编号与选中一致，单条关闭不影响另一条', async () => {
  const { container, annotations } = await setup();
  const cards = container.querySelectorAll<HTMLElement>('[data-bubble-id]');
  expect(cards).toHaveLength(2); expect(cards[1].classList.contains('is-active')).toBe(true);
  expect(cards[0].textContent).toContain('意见-one'); expect(cards[1].textContent).toContain('意见-two');
  expect([cards[0].style.left, cards[0].style.top]).not.toEqual([cards[1].style.left, cards[1].style.top]);
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
