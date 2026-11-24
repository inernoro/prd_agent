// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { ProgressiveEntries } from '../ProgressiveEntries';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it('5000 条首批只挂载 100 行，加载更多不重不漏', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const items = Array.from({ length: 5000 }, (_, id) => String(id));
  await act(async () => root.render(<ProgressiveEntries items={items} itemKey={id => id} render={id => <div data-row={id}>{id}</div>} />));
  expect(container.querySelectorAll('[data-row]')).toHaveLength(100);
  await act(async () => container.querySelector('button')!.click());
  const ids = [...container.querySelectorAll('[data-row]')].map(e => e.getAttribute('data-row'));
  expect(ids).toHaveLength(200);
  expect(new Set(ids).size).toBe(200);
  expect(ids.at(-1)).toBe('199');
  await act(async () => root.unmount());
});

it('定位第 5000 条只挂载附近 100 行，并能向前浏览', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const items = Array.from({ length: 5000 }, (_, id) => String(id));
  await act(async () => root.render(<ProgressiveEntries items={items} revealIndex={4999}
    itemKey={id => id} render={id => <div data-row={id}>{id}</div>} />));
  expect(container.querySelectorAll('[data-row]')).toHaveLength(100);
  expect(container.querySelector('[data-row="4999"]')).not.toBeNull();
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelectorAll('[data-row]')).toHaveLength(200);
  expect(container.querySelector('[data-row="4800"]')).not.toBeNull();
  await act(async () => root.unmount());
});
