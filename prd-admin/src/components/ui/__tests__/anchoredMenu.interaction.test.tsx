// @vitest-environment jsdom
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AnchoredMenu } from '../AnchoredMenu';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); container?.remove(); vi.unstubAllGlobals(); });
async function mount() {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const close = vi.fn();
  function Harness() {
    const anchor = useRef<HTMLButtonElement>(null), [open, setOpen] = useState(true);
    return <><button ref={anchor}>菜单锚点</button><button data-outside onPointerDown={event => event.stopPropagation()}>外部操作</button><iframe title="正文" />
      <div role="dialog"><button data-confirm>菜单派生确认</button><iframe data-confirm-frame title="派生确认正文" /></div>
      <AnchoredMenu open={open} anchorRef={anchor} onClose={() => { close(); setOpen(false); }}><button data-inside>菜单内操作</button></AnchoredMenu></>;
  }
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  await act(async () => root.render(<Harness />)); return close;
}
it('外部操作阻止冒泡也能关闭，菜单内部与派生确认保持打开', async () => {
  const close = await mount();
  for (const selector of ['[data-inside]', '[data-confirm]']) await act(async () => document.querySelector(selector)!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  expect(close).not.toHaveBeenCalled();
  await act(async () => document.querySelector('[data-outside]')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
  expect(close).toHaveBeenCalledOnce(); expect(document.querySelector('[data-inside]')).toBeNull();
});
it('正文iframe取得焦点后关闭菜单，并取消重复离焦定时器', async () => {
  const close = await mount();
  await act(async () => { container.querySelector<HTMLIFrameElement>('[data-confirm-frame]')!.focus(); window.dispatchEvent(new Event('blur')); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(close).not.toHaveBeenCalled();
  await act(async () => { container.querySelector('iframe')!.focus(); window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('blur')); await new Promise(resolve => setTimeout(resolve, 10)); });
  expect(close).toHaveBeenCalledOnce();
});
