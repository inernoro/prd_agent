// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WritingMobileToc } from '../WritingMobileToc';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); });
describe('手机阅读目录', () => {
  it('折叠时保留去重且属于本篇的已读计数，展开后可跳转并自动收起', async () => {
    const onGo = vi.fn(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<WritingMobileToc sections={[{ id: 's1', title: '功能说明' }, { id: 's2', title: '验收标准' }]} visited={['top', 's1', 's1', 'other']} onGo={onGo} />));
    const toggle = container.querySelector<HTMLButtonElement>('button')!;
    expect(toggle.textContent).toContain('本文目录 · 已读 1 / 2 节');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('[data-section-link]')).toHaveLength(0);
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const links = container.querySelectorAll<HTMLButtonElement>('[data-section-link]');
    expect(links).toHaveLength(2); expect(links[0].textContent).toContain('已读'); expect(links[1].textContent).not.toContain('已读');
    onGo.mockImplementation(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    await act(async () => links[1].click()); expect(onGo).toHaveBeenCalledWith('s2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
  it('零节不产生空菜单', async () => {
    container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<WritingMobileToc sections={[]} visited={[]} onGo={vi.fn()} />));
    expect(container.querySelector('button')).toBeNull();
  });
  it('正文尚未就绪时可展开了解标题，但不能跳向尚未加载的正文', async () => {
    const onGo = vi.fn(); container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<WritingMobileToc sections={[{ id: 's1', title: '功能说明' }]} visited={[]} onGo={onGo} disabled />));
    await act(async () => container.querySelector('button')!.click());
    const link = container.querySelector<HTMLButtonElement>('[data-section-link]')!;
    expect(link.disabled).toBe(true); expect(link.getAttribute('aria-disabled')).toBe('true');
    await act(async () => link.click()); expect(onGo).not.toHaveBeenCalled();
  });
});
