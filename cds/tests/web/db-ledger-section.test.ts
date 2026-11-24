/**
 * 数据台账前端（收敛 3）：血缘树渲染、丢弃确认的门禁表达、三处接线守卫。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbLedgerTree, DropConfirm, WriteBackConfirm, dbLedgerHeadline, type DbLedgerEntry, type DbLedgerView } from '../../web/src/components/branch/DbLedgerSection.js';

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
    expect(dbLedgerHeadline(v)).toBe('4 个派生库，1 个有演练验证过的备份（1 个孤儿库（分支已删或回切主库、数据还在），1 个来源未知）；2 个没有任何备份，现在丢弃会拒绝。');
    expect(html).toContain('data-db-ledger-root="shop"');
    expect(html).toContain('源库 <span class="font-mono text-foreground">shop</span> 派生出 3 个库');
    expect(html).toContain('来源未知（扫描补录');
    expect(html).toContain('data-db-ledger-status="orphaned"');
    expect(html).toContain('孤儿（分支已删或回切主库）');
    expect(html).toContain('从没演练还原过，不算备份');
    expect(html).toContain('已演练验证');
    expect(html).toContain('没有备份');
    expect(html).toContain('扫描补录');
  });

  it('时间点克隆（收敛 4）：克隆过的条目写明来源、时间点与逐表校验；不一致时逐表列出源 / 目标行数', () => {
    const ok = entry({ dbName: 'shop_feat_a', branchId: 'b-a', branch: 'feat/a', profileId: 'api', initMode: 'clone', clone: { sourceDb: 'shop', clonedAt: T, verification: { ok: true, measuredAt: T, tables: [{ table: 'users', source: 3, target: 3 }, { table: 'orders', source: 10, target: 10 }], mismatched: [], sourceOnly: [], targetOnly: [] } } });
    const bad = entry({ dbName: 'shop_feat_b', branchId: 'b-b', branch: 'feat/b', profileId: 'api', initMode: 'clone', clone: { sourceDb: 'shop', clonedAt: T, verification: { ok: false, measuredAt: T, tables: [{ table: 'users', source: 3, target: 3 }, { table: 'orders', source: 11, target: 10 }], mismatched: ['orders'], sourceOnly: [], targetOnly: [] } } });
    const html = renderToStaticMarkup(createElement(DbLedgerTree, { view: view([ok, bad]), onClone: () => {} }));
    expect(html).toContain('data-db-ledger-clone="ok"');
    expect(html).toContain('逐表校验 2 张表行数一致');
    expect(html).toContain('data-db-ledger-clone="mismatch"');
    expect(html).toContain('orders（源 11 / 目标 10）');
    expect(html).not.toContain('现在克隆');
  });

  it('选了时间点克隆但还没克隆的分支独立库：标「首次部署前从源库克隆」并给「现在克隆」按钮；空库方式不给', () => {
    const pending = entry({ dbName: 'shop_feat_c', branchId: 'b-c', branch: 'feat/c', profileId: 'api', initMode: 'clone' });
    const empty = entry({ dbName: 'shop_feat_d', branchId: 'b-d', branch: 'feat/d', profileId: 'api', initMode: 'empty' });
    const html = renderToStaticMarkup(createElement(DbLedgerTree, { view: view([pending, empty]), onClone: () => {} }));
    expect(html).toContain('data-db-ledger-clone="pending"');
    expect(html).toContain('首次部署前从');
    expect(html).toContain('库已在实例上则跳过');
    expect((html.match(/现在克隆/g) ?? []).length).toBe(1);
  });

  it('回写（收敛 5）：可回写的派生库给「回写到 源库」；回写过的条目写明时间、覆盖了几张表、可回退到什么时候，并给「回退」', () => {
    const fresh = entry({ dbName: 'shop_feat_a', branchId: 'b-a', branch: 'feat/a', profileId: 'api' });
    const written = entry({ dbName: 'shop_feat_b', branchId: 'b-b', branch: 'feat/b', profileId: 'api', writeBacks: [{
      id: 'wb1', targetDb: 'shop', at: T, snapshot: { id: 'b', file: '/b', bytes: 2048, sha256: 's', createdAt: T, objects: 2, verifiedAt: T },
      conflicts: [{ table: 'orders', baseline: 57, parentNow: 58, derived: 57, reason: 'parent-changed' }], baselineKind: 'clone-time',
      verification: { ok: true, measuredAt: T, tables: [{ table: 'orders', source: 57, target: 57 }], mismatched: [], sourceOnly: [], targetOnly: [] },
    }] });
    const unknown = entry({ dbName: 'legacy', kind: 'unknown', sourceDb: undefined, origin: 'scan' });
    const html = renderToStaticMarkup(createElement(DbLedgerTree, { view: view([fresh, written, unknown]), onWriteBack: () => {}, onRollback: () => {} }));
    // 两个可回写条目各一个按钮；「已回写到」那句不是按钮
    expect((html.match(/回写到 <span class="font-mono">shop<\/span><\/button>/g) ?? []).length).toBe(2);
    expect(html).toContain('data-db-ledger-writeback="wb1"');
    expect(html).toContain('已回写到');
    expect(html).toContain('覆盖了 1 张主库改过的表');
    expect(html).toContain('可回退到');
    expect((html.match(/ 回退<\/button>/g) ?? []).length).toBe(1);
    expect(html).not.toContain('回写到 <span class="font-mono">legacy');
  });

  it('回写确认：先看两边逐表行数与冲突清单，复述目标库名才能按下「回写」', () => {
    const preview = { targetDb: 'shop', derivedDb: 'shop_feat_a', baselineKind: 'clone-time' as const, headline: 'x', conflicts: [{ table: 'orders', baseline: 57, parentNow: 58, derived: 57, reason: 'parent-changed' as const }], tables: [{ table: 'orders', parent: 58, derived: 57 }, { table: 'users', parent: 3, derived: 3 }] };
    const html = renderToStaticMarkup(createElement(WriteBackConfirm, { entry: entry({ dbName: 'shop_feat_a' }), preview, pending: false, onCancel: () => {}, onConfirm: () => {} }));
    expect(html).toContain('data-db-ledger-writeback-confirm="shop_feat_a"');
    expect(html).toContain('orders');
    expect(html).toContain('58');
    expect(html).toContain('主库在克隆之后改过');
    expect(html).toContain('先自动备份');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?回写到 shop/);
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
    // 保存档位 / 初始化方式后台账必须重算（2026-09-04 验收发现：只在挂载时加载一次，保存后「还没克隆」标不出来）
    expect(s).toContain('reloadToken={ledgerReload}');
    expect(s).toContain('setLedgerReload((n) => n + 1)');
  });
  it('分支抽屉删除确认里挂了 BranchDbKeepList，且删除请求把 dbs 去向带给后端', () => {
    const s = read('web/src/components/BranchDetailDrawer.tsx');
    expect(s).toContain("from '@/components/branch/BranchDbKeepList'");
    expect(s).toContain('<BranchDbKeepList branchId={branch.id}');
    expect(s).toContain("onRunAction('delete', '删除分支', { dbs: dbChoices })");
    expect(s).toContain('body: { dbs: extra.dbs.map');
  });
  it('台账「现在克隆」打的是分支的 db-init 端点（与部署前钩子同一条路径）', () => {
    const s = read('web/src/components/branch/DbLedgerSection.tsx');
    expect(s).toContain('/db-init/');
    expect(s).toContain("method: 'POST'");
  });
  it('后端删分支路径改用台账结算（默认保留），级联 drop 只对勾选丢弃的跑', () => {
    const s = read('src/routes/branches.ts');
    expect(s).toContain('settleBranchDbsOnDelete(stateService, entry, dbChoices');
    expect(s).toContain('.filter((s) => dropSnapshotIds.has(s.id))');
  });
});
