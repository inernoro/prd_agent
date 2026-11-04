// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReleaseBackupActions } from './ReleaseBackupActions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ exportReleaseBackup: vi.fn(), restoreReleaseBackup: vi.fn() }));
vi.mock('@/services/real/productAgent', () => api);
vi.mock('@/components/ui/Dialog', () => ({ Dialog: ({ content, actions }: { content: ReactNode; actions: ReactNode }) => <div>{content}{actions}</div> }));

let host: HTMLDivElement;
let root: Root;
const refreshed = vi.fn(async () => {});
const backup = { format: 'map-formal-version-backup-v1', recordCount: 2, exportedAt: '2026-11-04', payload: 'encrypted' };
const preview = { total: 2, toRestore: 1, existing: 1, conflicts: 0, restored: 0 };
const button = (text: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === text)!;

async function openWith(file: unknown) {
  await act(async () => root.render(<ReleaseBackupActions onRestored={refreshed} />));
  await act(async () => button('恢复 V 完整备份').click());
  const field = host.querySelector('input[type=file]')!;
  Object.defineProperty(field, 'files', { value: [{ text: async () => JSON.stringify(file) }] });
  await act(async () => field.dispatchEvent(new Event('change', { bubbles: true })));
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  api.restoreReleaseBackup.mockImplementation(async (_file: unknown, dryRun: boolean) => ({
    success: true, data: dryRun ? preview : { ...preview, restored: 1 },
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('正式版本完整备份恢复', () => {
  it('选择文件仅请求预览，确认后恢复并刷新', async () => {
    await openWith(backup);
    expect(api.restoreReleaseBackup.mock.calls).toEqual([[backup, true]]);
    expect(host.textContent).toContain('备份 2 条 · 待恢复 1 条');
    await act(async () => button('确认恢复').click());
    expect(api.restoreReleaseBackup.mock.calls).toEqual([[backup, true], [backup, false]]);
    expect(refreshed).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('已恢复 1 条，保留已有记录 1 条');
  });

  it('检测到冲突时禁用写入', async () => {
    api.restoreReleaseBackup.mockResolvedValue({ success: true, data: { ...preview, conflicts: 1 } });
    await openWith(backup);
    expect(button('确认恢复').disabled).toBe(true);
    expect(api.restoreReleaseBackup.mock.calls).toEqual([[backup, true]]);
  });

  it('普通表格不进入完整备份接口', async () => {
    await openWith({ rows: [] });
    expect(api.restoreReleaseBackup).not.toHaveBeenCalled();
    expect(button('确认恢复').disabled).toBe(true);
  });
});
