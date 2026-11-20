// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QuickZipUploadOptions } from './ZipEntrySelector';
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

it('快捷上传默认系统查找，只有手动选择才列出文件并要求选择首页', async () => {
  const upload = vi.fn();
  vi.mocked(readZipEntryOptions).mockResolvedValue([
    { name: '扫描/report.md', path: 'report.md', selectable: true },
    { name: '扫描/manifest.json', path: 'manifest.json', selectable: false },
  ]);
  await act(async () => root.render(<QuickZipUploadOptions file={file} onUpload={upload} onCancel={vi.fn()} />));
  const mode = container.querySelector('select')!;
  expect(mode.value).toBe('auto');
  expect([...mode.options].map(option => option.text)).toEqual(['系统查找', '文件目录', '手动选择']);
  expect(container.querySelectorAll('select')).toHaveLength(1);
  expect(readZipEntryOptions).not.toHaveBeenCalled();

  await selectValue(mode, 'manual');
  const list = container.querySelector('[role="group"]');
  expect(list?.querySelector('[aria-label="其他文件"]')?.textContent).toContain('manifest.json');
  const submit = [...container.querySelectorAll('button')].find(button => button.textContent === '开始上传')!;
  expect(submit.disabled).toBe(true);
  await act(async () => list?.querySelector<HTMLInputElement>('input[type="radio"]')?.click());
  expect(submit.disabled).toBe(false);
  await act(async () => submit.click());
  expect(upload).toHaveBeenCalledWith('扫描/report.md');

  await selectValue(mode, 'directory');
  expect(container.querySelector('[role="group"]')).toBeNull();
  await act(async () => submit.click());
  expect(upload).toHaveBeenLastCalledWith('');
});
