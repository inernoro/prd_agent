// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntryWindow } from '../EntryWindow';

describe('大目录分批显示', () => {
  let element: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    element = document.createElement('div'); document.body.append(element);
    root = createRoot(element);
  });
  afterEach(() => { act(() => root.unmount()); element.remove(); vi.unstubAllGlobals(); });
  const render = (items: string[], focusIds = new Set<string>()) => act(() => root.render(
    <EntryWindow items={items} entryId={id => id} focusIds={focusIds} scope="目录">
      {id => <span key={id} data-row={id}>{id}</span>}
    </EntryWindow>,
  ));
  it('5000 条分 25 页，所有页合计无遗漏无重复且每页至多 200 行', () => {
    render(Array.from({ length: 5000 }, (_, i) => String(i)));
    const visited: string[] = [];
    for (let page = 0; page < 25; page++) {
      const rows = element.querySelectorAll('[data-row]');
      expect(rows.length).toBe(200);
      visited.push(...[...rows].map(row => row.getAttribute('data-row')!));
      if (page < 24) act(() => element.querySelector<HTMLButtonElement>('[aria-label="目录下一页条目"]')!.click());
    }
    expect(new Set(visited).size).toBe(5000);
    expect(element.querySelector<HTMLButtonElement>('[aria-label="目录下一页条目"]')!.disabled).toBe(true);
  });
  it('搜索打开末页文档后能自动定位所在页', () => {
    const items = Array.from({ length: 5000 }, (_, i) => String(i));
    render(items);
    render(items, new Set(['4999']));
    expect(element.querySelector('[data-row="4999"]')).not.toBeNull();
    expect(element.querySelector('[data-row="0"]')).toBeNull();
  });
  it('200 条小空间保持一次显示', () => {
    render(Array.from({ length: 200 }, (_, i) => String(i)));
    expect(element.querySelectorAll('[data-row]').length).toBe(200);
    expect(element.querySelector('button')).toBeNull();
  });
});
