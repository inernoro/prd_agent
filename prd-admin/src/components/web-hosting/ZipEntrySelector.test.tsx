// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getZipEntryFile, ZipEntrySelector, type ZipEntryChoice } from './ZipEntrySelector';
import { readZipEntryOptions } from './zipEntryOptions';

vi.mock('./zipEntryOptions', () => ({ readZipEntryOptions: vi.fn() }));
const file = new File(['zip'], 'scan.zip');
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function selectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

it('普通上传默认系统查找，只有手动选择才列出文件', async () => {
  const update = vi.fn();
  function Selector() {
    const [choice, setChoice] = useState<ZipEntryChoice>({ mode: 'auto' });
    return <ZipEntrySelector file={file} choice={choice} onChange={next => {
      setChoice(next);
      update(getZipEntryFile(next));
    }} />;
  }
  vi.mocked(readZipEntryOptions).mockResolvedValue([
    { name: '扫描/report.md', path: 'report.md' },
    { name: '扫描/data/manifest.json', path: 'data/manifest.json' },
  ]);
  await act(async () => root.render(<Selector />));
  const mode = container.querySelector('select')!;
  expect(mode.value).toBe('auto');
  expect([...mode.options].map(option => option.text)).toEqual(['系统查找', '文件目录', '手动选择']);
  expect(container.querySelectorAll('select')).toHaveLength(1);
  expect(readZipEntryOptions).not.toHaveBeenCalled();

  await selectValue(mode, 'manual');
  const list = container.querySelector('[role="group"]');
  const rows = [...list!.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
  expect(rows.map(row => row.labels?.[0]?.textContent)).toEqual(['report.md', 'data/manifest.json']);
  expect(rows.some(row => row.checked)).toBe(false);
  await act(async () => rows[1].click());
  expect(rows[1].checked).toBe(true);
  expect(update).toHaveBeenLastCalledWith('扫描/data/manifest.json');

  await selectValue(mode, 'directory');
  expect(container.querySelector('[role="group"]')).toBeNull();
  expect(update).toHaveBeenLastCalledWith('');
});
