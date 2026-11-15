import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import React, { act, useState } from 'react';

test('维护浮层按实高上下择位，鼠标与Esc退出保留草稿且不泄漏监听', async () => {
  const dom = new JSDOM('<div id="root"></div><input id="outside" />');
  const names = ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent'];
  const previous = Object.fromEntries(names.map(n => [n, globalThis[n]]));
  for (const n of names) globalThis[n] = dom.window[n];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] } });
  let root;
  const tracked = new Map();
  for (const [target, types] of [[dom.window, ['resize', 'scroll']], [dom.window.document, ['pointerdown', 'keydown']]]) {
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, fn, options) => { if (types.includes(type)) { if (!tracked.has(type)) tracked.set(type, new Set()); tracked.get(type).add(fn); } add(type, fn, options); };
    target.removeEventListener = (type, fn, options) => { if (types.includes(type)) tracked.get(type)?.delete(fn); remove(type, fn, options); };
  }
  const listenerCount = () => [...tracked.values()].reduce((n, set) => n + set.size, 0);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const open = async name => act(async () => { document.getElementById(name).open = true; await tick(); });
  try {
    const { useToolbarPopover } = await server.ssrLoadModule('/src/lib/toolbarPopover.ts');
    function Control({ name }) {
      const popover = useToolbarPopover(); const [draft, setDraft] = useState('original');
      return React.createElement('details', { id: name, ref: popover.ref, onToggle: popover.onToggle, 'data-toolbar-popover': true },
        React.createElement('summary', {}, name), React.createElement('div', { 'data-toolbar-panel': true },
          React.createElement('button', { onClick: () => popover.close() }, 'close'),
          React.createElement('input', { value: draft, onInput: e => setDraft(e.currentTarget.value) })));
    }
    root = createRoot(document.getElementById('root'));
    await act(async () => root.render(React.createElement(React.Fragment, {}, React.createElement(Control, { name: 'global' }), React.createElement(Control, { name: 'bulk' }))));
    const rect = (x, y, width, height) => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height });
    Object.defineProperty(dom.window, 'innerHeight', { value: 900, writable: true });
    Object.defineProperty(dom.window, 'innerWidth', { value: 1440, writable: true });
    for (const d of document.querySelectorAll('details')) {
      d.querySelector('summary').getBoundingClientRect = () => rect(200, 550, 140, 36);
      const p = d.querySelector('[data-toolbar-panel]');
      p.getBoundingClientRect = () => rect(parseFloat(p.style.left) || 0, parseFloat(p.style.top) || 0, parseFloat(p.style.width) || 640, Math.min(275, parseFloat(p.style.maxHeight) || Infinity));
      Object.defineProperties(p, { scrollHeight: { get: () => 273 }, offsetHeight: { get: () => p.getBoundingClientRect().height }, clientHeight: { get: () => p.getBoundingClientRect().height - 2 } });
    }
    assert.equal(listenerCount(), 0);
    await open('global'); assert.equal(listenerCount(), 4);
    const global = document.getElementById('global'), panel = global.querySelector('[data-toolbar-panel]'), summary = global.querySelector('summary');
    assert.equal(parseFloat(panel.style.top), 594, '实高可放下时紧接summary下方，不猜360');
    await act(async () => { dom.window.innerHeight = 600; dom.window.dispatchEvent(new dom.window.Event('resize')); });
    assert.ok(parseFloat(panel.style.top) + panel.getBoundingClientRect().height < 550, '下方不足时放上方并保留触发器');
    await act(async () => { dom.window.innerWidth = 390; dom.window.dispatchEvent(new dom.window.Event('resize')); });
    assert.equal(parseFloat(panel.style.left), 16); assert.equal(parseFloat(panel.style.width), 358);
    await act(async () => global.querySelector('button').click()); assert.equal(global.open, false); assert.equal(document.activeElement, summary); assert.equal(listenerCount(), 0);
    await open('global');
    const input = global.querySelector('input');
    await act(async () => { input.value = 'custom draft'; input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    const outside = document.getElementById('outside');
    await act(async () => { outside.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })); outside.focus(); });
    assert.equal(global.open, false); assert.equal(document.activeElement, outside, '外点关闭不抢新焦点');
    await open('global'); assert.equal(global.querySelector('input').value, 'custom draft');
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.innerHTML = '<button>dialog cancel</button>'; document.body.append(dialog);
    await act(async () => { dialog.querySelector('button').focus(); dialog.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true })); dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(global.open, true, '现有确认Dialog优先，不关闭背景浮层或抢焦点'); dialog.remove();
    await act(async () => summary.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(global.open, false); assert.equal(document.activeElement, summary);
    await open('global'); await open('bulk'); await act(async () => { await tick(); });
    assert.equal(global.open, false); assert.equal(document.getElementById('bulk').open, true); assert.equal(listenerCount(), 4, '两方互斥，只保留当前面板监听');
    await act(async () => root.unmount()); root = null; assert.equal(listenerCount(), 0, '卸载必须清理全局监听');
  } finally {
    if (root) await act(async () => root.unmount()); await server.close(); dom.window.close();
    for (const n of names) globalThis[n] = previous[n]; delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
