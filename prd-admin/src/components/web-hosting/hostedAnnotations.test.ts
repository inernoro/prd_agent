import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isAnnotationAnchor } from './useHostedAnnotations';

const script = readFileSync(path.resolve(__dirname, '../../../../prd-api/src/PrdAgent.Infrastructure/Services/Assets/hostedAnnotations.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 40));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); });
async function setup() {
  const dom = new JSDOM('<!doctype html><iframe></iframe>', { url: 'https://app.example/', runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window.document.querySelector('iframe')!.contentWindow! as Window & typeof globalThis;
  win.document.body.innerHTML = '<main><p id="intro">交付周期：预计三天交付，请提前确认。</p><button id="submit">提交申请</button><div><img src="photo.jpg" alt="产品照片"></div><p>重复文字</p><p>重复文字</p></main>';
  Object.defineProperty(win, 'CSS', { value: { escape: (value: string) => value } });
  Object.defineProperty(win.HTMLElement.prototype, 'getBoundingClientRect', { value: () => ({ left: 10, top: 20, right: 210, bottom: 60, width: 200, height: 40 }) });
  Object.defineProperty(win.Range.prototype, 'getBoundingClientRect', { value: () => ({ left: 10, top: 20, right: 210, bottom: 60, width: 200, height: 40 }) });
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
  it('keeps a pin attached to a stable ID after copy changes and reports removal', async () => {
    const t = await setup(); t.init(); t.win.document.querySelector<HTMLElement>('#submit')!.click(); await tick();
    const anchor = t.messages.find(m => m.type === 'map-annotation-selected')!.anchor;
    t.win.document.querySelector('#submit')!.textContent = '发送申请';
    t.init([{ id: 'thread', anchor }], false); await tick();
    expect(t.layer()?.querySelector('button')?.textContent).toBe('1');
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
    expect(t.layer()?.querySelector('button')).toBeNull();

  });
  it('restores the same logical page across immutable publishing directories', async () => {
    const t = await setup();
    t.send({ type: 'map-annotation-init', siteUrl: 'https://hosting.example/web-hosting/sites/site1/.versions/revision-2/index.html?v=2', enabled: false,
      threads: [{ id: 'published', anchor: { pagePath: '/web-hosting/sites/site1/index.html', selector: '#submit', tagName: 'button', kind: 'element', elementText: '提交申请' } }] });
    await expect.poll(() => t.layer()?.querySelector('button')?.textContent).toBe('1');
    expect(t.messages.filter(m => m.type === 'map-annotation-locations').at(-1)?.missingIds).toEqual([]);
  });
  it('requires a unique semantic match for positional anchors after a content version change', async () => {
    const t = await setup();
    t.init([{ id: 'changed', anchor: { pagePath: '/site/index.html', selector: 'p:nth-of-type(2)', tagName: 'p',
      kind: 'element', elementText: '重复文字', contentVersion: 'previous-version' } }], false);
    await expect.poll(() => t.messages.filter(m => m.type === 'map-annotation-locations').at(-1)?.missingIds).toEqual(['changed']);
    expect(t.layer()?.querySelector('button')).toBeNull();
  });
  it('does not guess between duplicate replacements when a positional target disappears', async () => {
    const t = await setup();
    t.init([{ id: 'duplicate', anchor: { pagePath: '/site/index.html', selector: '#missing', tagName: 'p', kind: 'element', elementText: '重复文字' } }], false);
    await tick();
    expect(t.layer()?.querySelector('button')).toBeNull();
    await expect.poll(() => t.messages.filter(m => m.type === 'map-annotation-locations').at(-1)?.missingIds).toEqual(['duplicate']);

  });
});
