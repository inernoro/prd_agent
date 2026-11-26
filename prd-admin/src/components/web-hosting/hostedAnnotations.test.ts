import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isAnnotationAnchor } from './useHostedAnnotations';

const script = readFileSync(path.resolve(__dirname, '../../../../prd-api/src/PrdAgent.Infrastructure/Services/Assets/hostedAnnotations.js'), 'utf8');
type PreviewGeometryMessage = { items: { id: string; rect: { top: number } }[] };
const previewMessages = (messages: Record<string, unknown>[]) => messages.filter(message => message.type === 'map-annotation-previews') as unknown as PreviewGeometryMessage[];
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });
async function setup() {
  const dom = new JSDOM('<!doctype html><iframe></iframe>', { url: 'https://app.example/', runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window.document.querySelector('iframe')!.contentWindow! as Window & typeof globalThis;
  win.document.body.innerHTML = '<main><p id="intro">交付周期：预计三天交付，请提前确认。</p><button id="submit">提交申请</button><div><img src="photo.jpg" alt="产品照片"></div><p>重复文字</p><p>重复文字</p></main>';
  Object.defineProperty(win, 'CSS', { value: { escape: (value: string) => value } });
  Object.defineProperty(win.HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 10, top: 20, right: 210, bottom: 60, width: 200, height: 40 }) });
  Object.defineProperty(win.Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ left: 10, top: 20, right: 210, bottom: 60, width: 200, height: 40 }) });
  Object.defineProperty(win.Range.prototype, 'getClientRects', { value: () => [{ left: 10, top: 20, right: 210, bottom: 60, width: 200, height: 40 }] });
  const messages: Record<string, unknown>[] = [];
  dom.window.addEventListener('message', event => messages.push(event.data));
  win.eval(script);
  cleanups.push(() => { win.dispatchEvent(new win.Event('pagehide')); dom.window.close(); });
  const send = (data: Record<string, unknown>, source: MessageEventSource | null = dom.window as unknown as Window) => win.dispatchEvent(new win.MessageEvent('message', { source, data: { nonce: 'test', siteId: 'site1', ...data } }));
  const init = (threads: unknown[] = [], enabled = true) => send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', enabled, threads });
  return { dom, win, messages, send, init, layer: () => win.document.querySelector('[data-map-annotation-layer]')?.shadowRoot };
}

describe('hosted page annotation runtime', () => {
  it('定位正文引用时只聚焦经校验的原始链接', async () => {
    const t = await setup();
    t.win.document.querySelector('main')!.insertAdjacentHTML('beforeend',
      '<a href="/web-pages?openSite=target">阅读依据</a><a href="/help">帮助</a>');
    const link = t.win.document.querySelector('a')!;
    const scroll = vi.fn();
    link.scrollIntoView = scroll;
    t.init();
    t.send({ type: 'map-annotation-focus-body-reference', linkIndex: 0, label: '帮助' });
    expect(scroll).not.toHaveBeenCalled();
    t.send({ type: 'map-annotation-focus-body-reference', linkIndex: 0, label: '阅读依据' });
    expect(t.win.document.activeElement).toBe(link);
    expect(scroll).toHaveBeenCalledOnce();
  });
  it('双栏以原文段序分组，只弱化隐藏后的底色，保留逐条编号', async () => {
    const t = await setup();
    const paragraph = t.win.document.getElementById('intro')!;
    vi.spyOn(paragraph, 'getBoundingClientRect').mockReturnValue({
      left: 72, top: 20, right: 272, bottom: 60, width: 200, height: 40,
    } as DOMRect);
    const anchor = { pagePath: '/site/index.html', selector: '#intro', tagName: 'p', kind: 'text',
      text: '预计三天', elementText: '交付周期：预计三天交付，请提前确认。' };
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', dualColumn: true, displayMode: 'bubble',
      threads: [{ id: 'one', anchor }, { id: 'resolved', anchor, isResolved: true }, { id: 'two', anchor }] });
    await expect.poll(() => t.messages.find(message => message.type === 'map-annotation-paragraphs')).toMatchObject({
      items: [{ id: 'one', paragraph: 1 }, { id: 'resolved', paragraph: 1 }, { id: 'two', paragraph: 1 }],
    });
    expect(t.layer()!.querySelector('.pnum')).toBeNull();
    expect([...t.layer()!.querySelectorAll('.pin:not([hidden])')].map(pin => pin.textContent)).toEqual(['1', '3']);
    const firstPin = t.layer()!.querySelector<HTMLElement>('.pin:not([hidden])')!;
    const highlight = t.layer()!.querySelector<HTMLElement>('.highlight:not([hidden])')!;
    const verticalOffset = (element: HTMLElement) => Number(/,(-?[\d.]+)px\)$/.exec(element.style.transform)?.[1]);
    expect(verticalOffset(firstPin)).toBeLessThan(verticalOffset(highlight));
    t.send({ type: 'map-annotation-previews-hide' });
    await expect.poll(() => t.layer()!.querySelectorAll('.highlight.dim:not([hidden])').length).toBe(1);
    (t.layer()!.querySelector('[aria-label="打开批注 3"]') as HTMLButtonElement).click();
    await expect.poll(() => t.layer()!.querySelectorAll('.highlight.active:not(.dim)').length).toBe(1);
    expect(t.layer()!.querySelectorAll('.highlight.dim:not([hidden])')).toHaveLength(0);
  });
  it('仅提示同段选字，接收选区操作后以蓝色待批注标记保留原文', async () => {
    const t = await setup();
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', dualColumn: true, suggestSelection: true });
    const paragraph = t.win.document.getElementById('intro')!, range = t.win.document.createRange();
    range.setStart(paragraph.firstChild!, 5); range.setEnd(paragraph.firstChild!, 9);
    t.win.getSelection()!.addRange(range);
    t.win.document.dispatchEvent(new t.win.Event('selectionchange'));
    await expect.poll(() => t.messages.find(message => message.type === 'map-annotation-selection')).toMatchObject({
      anchor: { kind: 'text', selector: '#intro', text: '预计三天' },
    });
    const selection = t.messages.find(message => message.type === 'map-annotation-selection')!;
    t.send({ type: 'map-annotation-accept-selection', anchor: selection.anchor });
    await expect.poll(() => t.layer()!.querySelector('.pending-mark')).toBeTruthy();
    expect(paragraph.textContent).toBe('交付周期：预计三天交付，请提前确认。');
  });
  it('只发送靠近视口顶端的横幅颜色，滚离后清空，不再查询 DOM', async () => {
    const t = await setup();
    const hero = t.win.document.createElement('header');
    hero.style.backgroundImage = 'linear-gradient(rgb(18, 59, 74), rgb(201, 119, 43))';
    t.win.document.body.prepend(hero);
    vi.spyOn(hero, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 1024, bottom: 124, width: 1024, height: 124 } as DOMRect);
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', dualColumn: true });
    const lastTint = () => t.messages.filter(message => message.type === 'map-annotation-header-tints').at(-1);
    await expect.poll(lastTint).toMatchObject({ colors: [[18, 59, 74], [201, 119, 43]] });
    const scan = vi.spyOn(t.win.document, 'querySelectorAll');
    Object.defineProperty(t.win, 'scrollY', { configurable: true, value: 300 });
    t.win.dispatchEvent(new t.win.Event('scroll'));
    await expect.poll(lastTint).toMatchObject({ colors: null });
    expect(scan).not.toHaveBeenCalled();
  });
  it('双栏聚焦位置时保留托管正文内部滚动容器的原生定位', async () => {
    const t = await setup();
    const intro = t.win.document.querySelector('#intro')!;
    const container = intro.parentElement!;
    container.style.overflowY = 'auto';
    Object.defineProperty(container, 'scrollHeight', { value: 900 });
    Object.defineProperty(container, 'clientHeight', { value: 300 });
    const scrollIntoView = vi.fn();
    Object.defineProperty(intro, 'scrollIntoView', { value: scrollIntoView });
    const anchor = { pagePath: '/site/index.html', selector: '#intro', tagName: 'p', kind: 'element',
      elementText: '交付周期：预计三天交付，请提前确认。' };
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', dualColumn: true,
      displayMode: 'bubble', threads: [{ id: 'one', anchor }] });
    t.send({ type: 'map-annotation-focus', id: 'one' });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });
  it('连续滚动按帧发布跟随几何，不清空气泡或扫描全文', async () => {
    const t = await setup();
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', enabled: false, displayMode: 'bubble',
      threads: [{ id: 'scroll-note', anchor: { pagePath: '/site/index.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' } }] });
    await expect.poll(() => t.messages.find(message => message.type === 'map-annotation-previews')).toMatchObject({ items: [{ id: 'scroll-note' }] });
    const original = previewMessages(t.messages).at(-1)!.items[0].rect.top;
    t.messages.length = 0;
    const scan = vi.spyOn(t.win.document, 'querySelectorAll');
    for (let i = 1; i <= 5; i++) {
      Object.defineProperty(t.win, 'scrollY', { configurable: true, value: i * 2 });
      t.win.dispatchEvent(new t.win.Event('scroll')); await tick();
    }
    const updates = previewMessages(t.messages);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every(message => message.items.length === 1)).toBe(true);
    expect(updates.at(-1)!.items[0].rect.top).toBe(original - 10);
    expect(scan).not.toHaveBeenCalled(); scan.mockRestore();
  });
  it('全隐保留编号，点击编号重新显示单条，全部显示可恢复所有气泡', async () => {
    const t = await setup();
    const anchor = { pagePath: '/site/index.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' };
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', displayMode: 'bubble', threads: [{ id: 'one', anchor }, { id: 'two', anchor }] });
    await expect.poll(() => previewMessages(t.messages).at(-1)?.items.length).toBe(2);
    t.send({ type: 'map-annotation-previews-hide' }); await tick();
    expect(previewMessages(t.messages).at(-1)!.items).toEqual([]);
    expect(t.layer()!.querySelectorAll('.pin:not([hidden])')).toHaveLength(2);
    (t.layer()!.querySelectorAll('.pin')[1] as HTMLButtonElement).click(); await tick();
    expect(previewMessages(t.messages).at(-1)!.items.map(item => item.id)).toEqual(['two']);
    t.send({ type: 'map-annotation-previews-show' }); await tick();
    expect(previewMessages(t.messages).at(-1)!.items).toHaveLength(2);
  });
  it('新文档握手重放宿主的单条收起集合，编号与全显可重新打开', async () => {
    const t = await setup(), anchor = { pagePath: '/site/index.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' };
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', displayMode: 'bubble', dismissedPreviewIds: ['one'], revealedPreviewIds: ['one'], threads: [{ id: 'one', anchor }, { id: 'two', anchor }] });
    await expect.poll(() => previewMessages(t.messages).at(-1)?.items.map(item => item.id)).toEqual(['two']);
    expect(t.layer()!.querySelectorAll('.pin:not([hidden])')).toHaveLength(2);
    (t.layer()!.querySelectorAll('.pin')[0] as HTMLButtonElement).click();
    await expect.poll(() => previewMessages(t.messages).at(-1)?.items).toHaveLength(2);
    t.send({ type: 'map-annotation-preview-dismiss', id: 'one' });
    await expect.poll(() => previewMessages(t.messages).at(-1)?.items.map(item => item.id)).toEqual(['two']);
    t.send({ type: 'map-annotation-previews-show' });
    await expect.poll(() => previewMessages(t.messages).at(-1)?.items).toHaveLength(2);
  });
  it('展开全部可见气泡且点击相邻编号同步选中，不被悬停抢回', async () => {
    const t = await setup();
    const anchor = { pagePath: '/site/index.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' };
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', enabled: false,
      threads: [{ id: 'one', anchor }, { id: 'two', anchor, isResolved: true }], displayMode: 'bubble' });
    await tick();
    expect(t.layer()?.querySelectorAll('.pin')).toHaveLength(2);
    await expect.poll(() => t.messages.find(message => message.type === 'map-annotation-previews')).toMatchObject({ items: [{ id: 'one' }, { id: 'two' }] });
    const pins = t.layer()!.querySelectorAll<HTMLButtonElement>('.pin');
    pins[1].click(); await tick();
    expect(pins[1].classList.contains('active')).toBe(true);
    expect(t.messages.some(message => message.type === 'map-annotation-preview' && message.id === 'two')).toBe(true);
    pins[0].dispatchEvent(new t.win.Event('pointerenter')); await tick();
    expect(pins[1].classList.contains('active')).toBe(true);
    pins[0].click(); await tick();
    expect(pins[0].classList.contains('active')).toBe(true);
    expect(t.messages.filter(message => message.type === 'map-annotation-preview').at(-1)?.id).toBe('one');
  });
  it('编号圆点始终在后插入的高亮边框上方，点击仍能打开对应批注', async () => {
    const t = await setup();
    t.init([{ id: 'above-outline', anchor: { pagePath: '/site/index.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' } }], false);
    await expect.poll(() => t.layer()?.querySelector('.outline[data-mark]')).toBeTruthy();
    const layer = t.layer()!, pin = layer.querySelector<HTMLButtonElement>('.pin')!, box = layer.querySelector<HTMLElement>('.outline[data-mark]')!;
    // jsdom 不计算 shadowRoot 样式；用同一份运行时样式在普通根中验证层级。
    const style = t.win.document.createElement('style'); style.textContent = layer.querySelector('style')!.textContent;
    t.win.document.head.appendChild(style);
    const samplePin = pin.cloneNode() as HTMLElement, sampleBox = box.cloneNode() as HTMLElement;
    t.win.document.body.append(samplePin, sampleBox);
    expect(Number(t.win.getComputedStyle(samplePin).zIndex)).toBeGreaterThan(Number(t.win.getComputedStyle(sampleBox).zIndex));
    pin.click(); await tick();
    expect(t.messages.some(message => message.type === 'map-annotation-activate' && message.id === 'above-outline')).toBe(true);
  });
  it('previews a chat bubble using geometry only, dismisses it and keeps standard numbered markers', async () => {
    const t = await setup();
    const threads = [{ id: 'chat', anchor: { pagePath: '/site/index.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' } }];
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', enabled: false, threads, displayMode: 'bubble' });
    await tick();
    await expect.poll(() => t.messages.find(message => message.type === 'map-annotation-preview')).toMatchObject({ id: 'chat', rect: { left: 10, top: 20, width: 200, height: 40 } });
    expect(t.messages.find(message => message.type === 'map-annotation-preview')).not.toHaveProperty('content');
    t.send({ type: 'map-annotation-preview-dismiss' });
    await expect.poll(() => previewMessages(t.messages).at(-1)).toMatchObject({ items: [] });
    expect(t.messages.some(message => message.type === 'map-annotation-preview-hide')).toBe(true);
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', enabled: false, threads, displayMode: 'standard' });
    await tick();
    expect(t.layer()?.querySelector<HTMLButtonElement>('.pin')?.hidden).toBe(false);
  });
  it('switches between bubbles, standard highlights and hidden marks without losing threads or rebuilding pins', async () => {
    const t = await setup();
    const threads = [{ id: 'display', anchor: { pagePath: '/site/index.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' } }];
    const show = (displayMode: string) => t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html?v=1', enabled: false, threads, displayMode });
    show('bubble'); await tick();
    const pin = t.layer()!.querySelector<HTMLButtonElement>('.pin')!;
    expect(pin.hidden).toBe(false);
    show('standard'); await tick();
    expect(pin.hidden).toBe(false);
    expect(t.layer()!.querySelector('.outline[data-mark]')).toBeTruthy();
    show('hidden'); await tick();
    expect(t.win.document.querySelector<HTMLElement>('[data-map-annotation-layer]')!.style.display).toBe('none');
    show('bubble'); await tick();
    expect(t.layer()!.querySelector('.pin')).toBe(pin);
    expect(pin.hidden).toBe(false);
    expect(t.win.document.querySelector<HTMLElement>('[data-map-annotation-layer]')!.style.display).toBe('block');
  });
  it('binds the clicked element without triggering its original action', async () => {
    const t = await setup(); t.init();
    let clicked = false;
    t.win.document.querySelector('#submit')!.addEventListener('click', () => { clicked = true; });
    t.win.document.querySelector<HTMLElement>('#submit')!.click();
    await tick();
    const anchor = t.messages.find(m => m.type === 'map-annotation-selected')?.anchor;
    expect(clicked).toBe(false);
    expect(isAnnotationAnchor(anchor)).toBe(true);
    expect(anchor).toMatchObject({ selector: '#submit', tagName: 'button', pagePath: '/site/index.html', kind: 'element', text: '提交申请' });
    expect(t.messages.some(m => m.type === 'map-annotation-ready')).toBe(true);

  });
  it('reuses marker nodes and cached elements through document and nested scrolling', async () => {
    const t = await setup();
    t.init([{ id: 'smooth', anchor: { pagePath: '/site/index.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' } }], false);
    await expect.poll(() => t.layer()?.querySelector('.pin:not([hidden])')).toBeTruthy();
    const layer = t.layer()!;
    const pin = layer.querySelector('.pin'), box = layer.querySelector('.outline[data-mark]');
    const lookup = vi.spyOn(t.win.document, 'querySelector');
    for (let i = 0; i < 20; i++) t.win.dispatchEvent(new t.win.Event('scroll'));
    await tick();
    expect(layer.querySelector('.pin')).toBe(pin);
    expect(layer.querySelector('.outline[data-mark]')).toBe(box);
    expect(lookup).not.toHaveBeenCalled();
    t.win.document.querySelector('main')!.dispatchEvent(new t.win.Event('scroll', { bubbles: false }));
    lookup.mockClear(); await tick();
    expect(layer.querySelector('.pin')).toBe(pin);
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockRestore();
  });
  it.each(['fixed', 'sticky'])('tracks a descendant of a %s ancestor during document scrolling', async (position) => {
    const t = await setup();
    const ancestor = t.win.document.querySelector<HTMLElement>('main')!;
    ancestor.style.position = position;
    let scroll = 0;
    const rect = vi.spyOn(t.win.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = this.hasAttribute('data-map-annotation-layer') ? -scroll : 20;
      return { left: 10, top, right: 210, bottom: top + 40, width: 200, height: 40, x: 10, y: top, toJSON: () => ({}) };
    });
    t.init([{ id: 'viewport', anchor: { pagePath: '/site/index.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' } }], false);
    await tick();
    const pin = t.layer()!.querySelector<HTMLElement>('.pin')!;
    const initial = pin.style.transform;
    const lookup = vi.spyOn(t.win.document, 'querySelector');
    scroll = 120;
    t.win.dispatchEvent(new t.win.Event('scroll'));
    await tick();
    expect(initial).toMatch(/,8px\)$/);
    expect(pin.style.transform).toMatch(/,128px\)$/);
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockRestore(); rect.mockRestore();
  });
  it('keeps a pin attached to a stable ID after copy changes and reports removal', async () => {
    const t = await setup(); t.init(); t.win.document.querySelector<HTMLElement>('#submit')!.click(); await tick();
    const anchor = t.messages.find(m => m.type === 'map-annotation-selected')!.anchor;
    t.win.document.querySelector('#submit')!.textContent = '发送申请';
    t.init([{ id: 'thread', anchor }], false); await tick();
    expect(t.layer()?.querySelector('.pin')?.textContent).toBe('1');
    t.win.document.querySelector('#submit')!.remove(); await tick();
    await expect.poll(() => t.messages.filter(m => m.type === 'map-annotation-locations').at(-1)?.missingIds).toEqual(['thread']);

  });
  it('captures exact text plus context and renders a range highlight', async () => {
    const t = await setup(); t.init();
    const el = t.win.document.querySelector('#intro')!, range = t.win.document.createRange();
    range.setStart(el.firstChild!, 5); range.setEnd(el.firstChild!, 11);
    t.win.getSelection()!.addRange(range);
    el.dispatchEvent(new t.win.MouseEvent('click', { bubbles: true, cancelable: true })); await tick();
    const anchor = t.messages.find(m => m.type === 'map-annotation-selected')?.anchor;
    expect(anchor).toMatchObject({ kind: 'text', text: '预计三天交付', prefix: '交付周期：', suffix: '，请提前确认。' });
    t.init([{ id: 'quote', anchor }], false); await tick();
    expect(t.layer()?.querySelector('.highlight')).toBeTruthy();

  });
  it('rejects initialization from a different frame and ignores threads on another page', async () => {
    const t = await setup();
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/site/index.html', enabled: true }, t.win);
    expect(t.layer()).toBeUndefined();
    t.init([{ id: 'foreign', anchor: { pagePath: '/other.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' } }], false); await tick();
    expect(t.layer()?.querySelector('.pin:not([hidden])')).toBeNull();

  });
  it('restores the same logical page across immutable publishing directories', async () => {
    const t = await setup();
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/web-hosting/sites/site1/.versions/revision-2/index.html?v=2', enabled: false,
      threads: [{ id: 'published', anchor: { pagePath: '/web-hosting/sites/site1/index.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' } }] });
    await expect.poll(() => t.layer()?.querySelector('.pin')?.textContent).toBe('1');
    await expect.poll(() => t.messages.filter(m => m.type === 'map-annotation-locations').at(-1)?.missingIds).toEqual([]);
  });
  it('requires a unique semantic match for positional anchors after a content version change', async () => {
    const t = await setup();
    t.init([{ id: 'changed', anchor: { pagePath: '/site/index.html', selector: 'p:nth-of-type(2)', tagName: 'p',
      kind: 'element', elementText: '重复文字', contentVersion: 'previous-version' } }], false);
    await expect.poll(() => t.messages.filter(m => m.type === 'map-annotation-locations').at(-1)?.missingIds).toEqual(['changed']);
    expect(t.layer()?.querySelector('.pin:not([hidden])')).toBeNull();
  });
  it('does not guess between duplicate replacements when a positional target disappears', async () => {
    const t = await setup();
    t.init([{ id: 'duplicate', anchor: { pagePath: '/site/index.html', selector: '#missing', tagName: 'p', kind: 'element', elementText: '重复文字' } }], false);
    await tick();
    expect(t.layer()?.querySelector('.pin:not([hidden])')).toBeNull();
    await expect.poll(() => t.messages.filter(m => m.type === 'map-annotation-locations').at(-1)?.missingIds).toEqual(['duplicate']);

  });
});
