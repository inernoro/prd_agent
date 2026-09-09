import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const suffix = readFileSync(new URL('../../../../../prd-api/src/PrdAgent.Api/Resources/mdppt/anchors/cyber-terminal/suffix.html', import.meta.url), 'utf8');
const script = [...suffix.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n');

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  events = new Map<string, (event: { key?: string; target?: Element; preventDefault: () => void }) => void>();
  textContent = '';
  disabled = false;
  classes = new Set<string>();
  classList = { contains: (name: string) => this.classes.has(name), add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name) };
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  appendChild(element: Element) { this.children.push(element); return element; }
  addEventListener(name: string, callback: (event: { key?: string; target?: Element; preventDefault: () => void }) => void) { this.events.set(name, callback); }
  contains(element?: Element): boolean { return element === this || this.children.some(child => child.contains(element)); }
  click() { if (!this.disabled) this.events.get('click')?.({ target: this, preventDefault() {} }); }
}

function runtime(anchor = 'cyber-terminal', count = 4) {
  const body = new Element('BODY');
  body.setAttribute('data-mdppt-anchor', anchor);
  const slides = Array.from({ length: count }, () => new Element('SECTION'));
  slides[0]?.classList.add('is-active');
  const events = new Map<string, (event: { key: string; target?: Element; preventDefault: () => void }) => void>();
  vm.runInNewContext(script, { document: {
    body, querySelectorAll: () => slides, createElement: (tag: string) => new Element(tag.toUpperCase()),
    addEventListener: (name: string, callback: (event: { key: string; target?: Element; preventDefault: () => void }) => void) => events.set(name, callback),
  } });
  const nav = body.children.find(element => element.getAttribute('id') === 'mdppt-touch-navigation');
  const buttons = nav?.children.filter(element => element.tagName === 'BUTTON') ?? [];
  const status = nav?.children.find(element => element.tagName === 'SPAN');
  return { nav, buttons, status, events, active: () => slides.findIndex(slide => slide.classList.contains('is-active')),
    key: (key: string, target?: Element) => events.get('keydown')!({ key, target, preventDefault() {} }) };
}

describe('默认 PPT 主题触屏导航', () => {
  it('按钮驱动实际原生 go，四页均可达且首尾禁用、往返正确', () => {
    const page = runtime();
    expect(page.buttons).toHaveLength(2);
    const [previous, next] = page.buttons;
    expect(previous.textContent).toBe('上一页');
    expect(next.textContent).toBe('下一页');
    expect(previous.disabled).toBe(true);
    expect(page.status?.textContent).toBe('1 / 4');
    for (let index = 1; index < 4; index++) {
      next.click();
      expect(page.active()).toBe(index);
      expect(page.status?.textContent).toBe(`${index + 1} / 4`);
    }
    expect(next.disabled).toBe(true);
    next.click(); expect(page.active()).toBe(3);
    for (let index = 2; index >= 0; index--) { previous.click(); expect(page.active()).toBe(index); }
    expect(previous.disabled).toBe(true);
  });

  it('原生键盘切页同步按钮和页数，按钮空格交给浏览器点击而不重复翻页', () => {
    const page = runtime();
    expect(page.buttons).toHaveLength(2);
    page.key('End'); expect(page.status?.textContent).toBe('4 / 4'); expect(page.buttons[1].disabled).toBe(true);
    page.key('ArrowLeft'); expect(page.status?.textContent).toBe('3 / 4'); expect(page.buttons[1].disabled).toBe(false);
    page.key(' ', page.buttons[0]); expect(page.active()).toBe(2);
    page.buttons[0].click(); expect(page.active()).toBe(1);
    page.key('Home'); expect(page.buttons[0].disabled).toBe(true);
  });

  it.each(['', 'soft-editorial', 'ordinary-webpage'])('没有确切默认 PPT 身份 %s 时不注入控件', anchor => {
    expect(runtime(anchor).nav).toBeUndefined();
  });

  it('单页不新增无效导航，也不新增触摸、滚轮或缩放拦截', () => {
    expect(runtime('cyber-terminal', 1).nav).toBeUndefined();
    expect([...runtime().events.keys()]).toEqual(['keydown']);
    expect(script).not.toMatch(/touchstart|touchmove|touchend|wheel|pointermove/);
  });
});
