// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { VersionWorkflowImportDialog } from './VersionWorkflowImportDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ parse: vi.fn(), save: vi.fn() }));
vi.mock('./versionWorkflowImportParse', () => ({ parseVersionWorkflowImportFile: mocks.parse }));
vi.mock('@/services/real/productAgent', () => ({ importOverviewVersionWorkflow: mocks.save, importVersionWorkflow: mocks.save }));
let root: Root;
let host: HTMLDivElement;
const changed = vi.fn(async () => {});
beforeEach(() => {
  vi.clearAllMocks(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  mocks.parse.mockResolvedValue([{ appName: '应用甲', code: 'T1.2.3', planName: '方案', sourceRow: 2 }]);
  mocks.save.mockResolvedValue({ success: true, data: { created: 0, updated: 1, skipped: 0, errors: [] } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mountAndChooseFile() {
  await act(async () => root.render(<VersionWorkflowImportDialog kind="initiation" products={[{ id: 'a', name: '应用甲', productNo: 'P1' }]} onClose={() => {}} onImported={changed} />));
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    Object.defineProperty(input, 'files', { value: [new File(['test'], 'versions.csv')], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
it('仅更新没有新增也显示成功并刷新原列表，不显示快照', async () => {
  await mountAndChooseFile();
  await act(async () => [...document.querySelectorAll('button')].find(x => x.textContent?.includes('确认导入'))?.click());
  expect(document.body.textContent).toContain('新增 0 条，更新 1 条，跳过 0 条');
  expect(document.body.textContent).not.toContain('留存快照');
  expect(changed).toHaveBeenCalledTimes(1);
});
it('无版本号不能作为新增草稿导入', async () => {
  mocks.parse.mockResolvedValue([{ appName: '应用甲', code: '', planName: '无号', sourceRow: 2 }]);
  await mountAndChooseFile();
  const button = [...document.querySelectorAll('button')].find(x => x.textContent?.includes('确认导入'))!;
  expect(button.disabled).toBe(true);
  expect(document.body.textContent).toContain('无版本号将跳过');
  expect(mocks.save).not.toHaveBeenCalled();
});
