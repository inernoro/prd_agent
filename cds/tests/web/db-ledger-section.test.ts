/**
 * 数据台账前端（收敛 3）：血缘树渲染、丢弃确认的门禁表达、三处接线守卫。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbLedgerTree, DropConfirm, dbLedgerHeadline, type DbLedgerEntry, type DbLedgerView } from '../../web/src/components/branch/DbLedgerSection.js';

const CDS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const T = '2026-09-03T08:00:00.000Z';

function entry(o: Partial<DbLedgerEntry> & { dbName: string }): DbLedgerEntry {
  return { id: `id-${o.dbName}`, projectId: 'p', kind: 'per-branch', engine: 'mysql', infraContainer: 'cds-infra-mysql', sourceDb: 'shop', origin: 'cds', status: 'active', createdAt: T, updatedAt: T, backups: [], ...o };
}
function view(entries: DbLedgerEntry[]): DbLedgerView {
  const groups = new Map<string | null, DbLedgerEntry[]>();
  for (const e of entries) { const k = e.sourceDb ?? null; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(e); }
  const c = (f: (e: DbLedgerEntry) => boolean) => entries.filter(f).length;
  return {
    projectId: 'p', generatedAt: T, entries, tree: [...groups.entries()].map(([sourceDb, children]) => ({ sourceDb, children })),
    summary: { total: entries.length, active: c((e) => e.status === 'active'), orphaned: c((e) => e.status === 'orphaned'), dropped: c((e) => e.status === 'dropped'), unknown: c((e) => e.kind === 'unknown'), withVerifiedBackup: c((e) => e.backups.some((b) => b.verifiedAt)), withoutBackup: c((e) => e.backups.length === 0) },
  };
}

describe('台账血缘树', () => {
  it('第一屏一句判断带数字；源库做根；孤儿、来源未知、备份状态各自可辨', () => {
    const v = view([
      entry({ dbName: 'shop_feat_x', branch: 'feat/x', profileId: 'api' }),
      entry({ dbName: 'shop_old', status: 'orphaned', orphanedAt: T, branch: 'old', backups: [{ id: 'b', file: '/b', bytes: 2048, sha256: 's', createdAt: T }] }),
      entry({ dbName: 'shop_rs_ab_r1', kind: 'isolated', backups: [{ id: 'b2', file: '/b2', bytes: 5 * 1024 * 1024, sha256: 's', createdAt: T, verifiedAt: T }] }),
      entry({ dbName: 'legacy_2024', kind: 'unknown', sourceDb: undefined, origin: 'scan', note: '扫描 mysql 补录：来源未知' }),
    ]);
    const html = renderToStaticMarkup(createElement(DbLedgerTree, { view: v }));
    expect(dbLedgerHeadline(v)).toBe('4 个派生库，1 个有演练验证过的备份（1 个孤儿库（分支已删、数据还在），1 个来源未知）；2 个没有任何备份，现在丢弃会拒绝。');
    expect(html).toContain('data-db-ledger-root="shop"');
    expect(html).toContain('源库 <span class="font-mono text-foreground">shop</span> 派生出 3 个库');
    expect(html).toContain('来源未知（扫描补录');
    expect(html).toContain('data-db-ledger-status="orphaned"');
    expect(html).toContain('孤儿（分支已删）');
    expect(html).toContain('从没演练还原过，不算备份');
    expect(html).toContain('已演练验证');
    expect(html).toContain('没有备份');
    expect(html).toContain('扫描补录');
  });

  it('已丢弃的条目不再给动作按钮，但留有丢弃时间与是否强制', () => {
    const v = view([entry({ dbName: 'gone', status: 'dropped', droppedAt: T, droppedBy: 'admin', droppedForced: true })]);
    const html = renderToStaticMarkup(createElement(DbLedgerTree, { view: v, onDrop: () => {}, onBackup: () => {} }));
    expect(html).toContain('已丢弃');
    expect(html).toContain('（强制，未备份）');
    expect(html).not.toContain('>备份<');
  });

  it('丢弃确认：没有验证过的备份必须复述库名，按钮默认禁用；有验证备份一键丢弃', () => {
    const noBackup = renderToStaticMarkup(createElement(DropConfirm, { entry: entry({ dbName: 'shop_old', status: 'orphaned' }), pending: false, onCancel: () => {}, onConfirm: () => {} }));
    expect(noBackup).toContain('这个库没有任何备份');
    expect(noBackup).toContain('复述库名');
    expect(noBackup).toMatch(/不备份直接删<\/button>/);
    expect(noBackup).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?不备份直接删/);
    const verified = renderToStaticMarkup(createElement(DropConfirm, { entry: entry({ dbName: 'shop_old', status: 'orphaned', backups: [{ id: 'b', file: '/b', bytes: 1, sha256: 's', createdAt: T, verifiedAt: T }] }), pending: false, onCancel: () => {}, onConfirm: () => {} }));
    expect(verified).toContain('有演练验证过的备份');
    expect(verified).not.toContain('复述库名');
  });

  it('颜色一律走 token', () => {
    for (const f of ['web/src/components/branch/DbLedgerSection.tsx', 'web/src/components/branch/BranchDbKeepList.tsx']) {
      const source = fs.readFileSync(path.join(CDS_ROOT, f), 'utf8');
      expect(source, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, f).not.toMatch(/\brgba?\(/);
    }
  });
});

describe('接线守卫：台账进项目页签，删分支对话框先展示会留下什么', () => {
  const read = (f: string): string => fs.readFileSync(path.join(CDS_ROOT, f), 'utf8');
  it('项目设置数据库隔离页签挂了 DbLedgerSection', () => {
    const s = read('web/src/pages/project-settings/DbIsolationTab.tsx');
    expect(s).toContain("from '@/components/branch/DbLedgerSection'");
    expect(s).toContain('<DbLedgerSection projectId={projectId}');
  });
  it('分支抽屉删除确认里挂了 BranchDbKeepList，且删除请求把 dbs 去向带给后端', () => {
    const s = read('web/src/components/BranchDetailDrawer.tsx');
    expect(s).toContain("from '@/components/branch/BranchDbKeepList'");
    expect(s).toContain('<BranchDbKeepList branchId={branch.id}');
    expect(s).toContain("onRunAction('delete', '删除分支', { dbs: dbChoices })");
    expect(s).toContain('body: { dbs: extra.dbs.map');
  });
  it('后端删分支路径改用台账结算（默认保留），级联 drop 只对勾选丢弃的跑', () => {
    const s = read('src/routes/branches.ts');
    expect(s).toContain('settleBranchDbsOnDelete(stateService, entry, dbChoices');
    expect(s).toContain('.filter((s) => dropSnapshotIds.has(s.id))');
  });
});
