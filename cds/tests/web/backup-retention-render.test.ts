import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateService } from '../../src/services/state.js';
import { recordReclaimExecution, resumedReclaimExecution } from '../../src/services/reclaim-execution-journal.js';
import { BackupRetentionPanel } from '../../web/src/pages/cds-settings/components/BackupRetentionPanel';

const restored = vi.hoisted(() => ({ inject: false, value: null as any }));
vi.mock('react', async load => {
  const actual = await load<typeof import('react')>();
  return { ...actual, useState: (initial: any) => {
    const current = actual.useState(initial);
    if (restored.inject) { restored.inject = false; return [restored.value, current[1]]; }
    return current;
  } };
});
const roots: string[] = [];
afterEach(() => { restored.inject = false; for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function render(report: any) {
  restored.value = report; restored.inject = true;
  return renderToStaticMarkup(createElement(BackupRetentionPanel));
}
describe('备份任务重启后的有界报告', () => {
  it('从真实状态文件恢复压缩摘要后仍显示数量，并保留重新预览入口', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-summary-restart-')); roots.push(root);
    const file = path.join(root, 'state.json'); const state = new StateService(file, root); state.load();
    const report = { scanStatus: 'partial', maxAgeDays: 15, counts: { candidates: 40, removed: 8, held: 32, failed: 0, pending: 4, policyConflicts: 2 },
      directories: Array.from({ length: 2 }, (_, directory) => ({ directory: '/backups/' + directory,
        held: Array.from({ length: 20 }, (_, index) => ({ path: `/backups/${directory}/${index}.gz`, reason: 'policy-conflict-no-fresh-recovery-point', lineageAttestation: 'x'.repeat(2000) })) })) };
    recordReclaimExecution(state.resourceRetirementJournal('owned', 'backups'), { id: 'a'.repeat(32), status: 'completed', report }); await state.flush();
    const restarted = new StateService(file, root); restarted.load();
    const execution = resumedReclaimExecution(restarted.resourceRetirementJournal('owned', 'backups'));
    expect(execution.report.detailsAvailableInFreshPreview).toBe(true); expect(execution.report.directories).toBeUndefined();
    const html = render(execution.report);
    expect(html).toContain('已回收 8'); expect(html).toContain('保留 32'); expect(html).toContain('待处理 4');
    expect(html).toContain('上次任务仅保留摘要'); expect(html).toContain('重新预览'); expect(html).toContain('预览全局备份回收');
  });
  it('新预览仍呈现具体保护对象与未知实际空间，而不显示零占用', () => {
    const html = render({ scanStatus: 'partial', maxAgeDays: 15, counts: { held: 1 }, directories: [{ directory: '/backups',
      held: [{ path: '/backups/protected.gz', reason: 'file-still-open' }], filesystems: [{ path: '/backups', netAvailableBytesDelta: null }] }] });
    expect(html).toContain('/backups/protected.gz'); expect(html).toContain('文件仍被进程打开'); expect(html).toContain('实际净变化 未知 字节');
  });
});
