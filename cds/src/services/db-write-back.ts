/**
 * 回写（数据库隔离收敛 5，2026-09-04）：把派生库（分支独立库 / 隔离库）整库写回它的源库。
 *
 * 分支独立库与隔离库共用同一套门禁、冲突清单与替换脚本——「回写」就是设计文档第十节的
 * 「替换」：目标库先自动备份且备份演练验证过；替换前把两边逐表行数与冲突清单摆给用户确认
 *（复述目标库名）；替换后逐表校验；回写前快照进台账，可一键回退。
 *
 * 冲突策略：整库替换 = 派生库赢。冲突清单列出「主库在克隆之后被写过、回写会覆盖」的表：
 * 有克隆时基线（收敛 4 记的克隆校验里的源库行数）就按基线判；没有基线（隔离库、旧条目）
 * 按主库与派生库的当前差异列，并标明 baselineKind=none 让用户知道这是保守估计。
 *
 * 增量回写（binlog / oplog / 逻辑复制）属复制集波 5，本模块不做。
 */
import type { DbLedgerEntry, DbWriteBackConflict } from '../types.js';

export interface WriteBackPreview {
  targetDb: string;
  derivedDb: string;
  baselineKind: 'clone-time' | 'none';
  conflicts: DbWriteBackConflict[];
  /** 两边逐表行数并排 */
  tables: Array<{ table: string; parent?: number; derived?: number }>;
  headline: string;
}

export function writeBackConflicts(
  parentNow: Record<string, number>,
  derived: Record<string, number>,
  baseline?: Record<string, number>,
): { conflicts: DbWriteBackConflict[]; baselineKind: 'clone-time' | 'none' } {
  const conflicts: DbWriteBackConflict[] = [];
  const names = Object.keys(parentNow).sort();
  if (baseline) {
    for (const table of names) {
      const now = parentNow[table];
      const base = baseline[table];
      if (base === undefined) { conflicts.push({ table, parentNow: now, reason: 'parent-only' }); continue; }
      if (base !== now) conflicts.push({ table, baseline: base, parentNow: now, derived: derived[table], reason: 'parent-changed' });
    }
    return { conflicts, baselineKind: 'clone-time' };
  }
  for (const table of names) {
    const now = parentNow[table];
    const d = derived[table];
    if (d === undefined) { conflicts.push({ table, parentNow: now, reason: 'parent-only' }); continue; }
    if (d !== now) conflicts.push({ table, parentNow: now, derived: d, reason: 'differs' });
  }
  return { conflicts, baselineKind: 'none' };
}

export function assertWriteBackAllowed(entry: Pick<DbLedgerEntry, 'kind' | 'status' | 'engine' | 'sourceDb' | 'dbName' | 'dedicatedContainer' | 'origin'>): { ok: true; targetDb: string } | { ok: false; reason: string } {
  if (entry.status === 'dropped') return { ok: false, reason: `${entry.dbName} 已丢弃，没有内容可回写` };
  if (entry.kind === 'unknown' || !entry.sourceDb) return { ok: false, reason: `${entry.dbName} 来源未知（没有源库），不知道该写回谁` };
  if (entry.engine === 'mongo') return { ok: false, reason: 'mongo 的回写走复制集波 5 的 oplog 通道，整库替换暂不支持' };
  if (entry.dedicatedContainer) return { ok: false, reason: '专用实例上的隔离库回写要跨实例导入，暂不支持' };
  if (entry.sourceDb === entry.dbName) return { ok: false, reason: '派生库名等于源库，拒绝回写' };
  return { ok: true, targetDb: entry.sourceDb };
}

export function writeBackHeadline(p: Pick<WriteBackPreview, 'targetDb' | 'derivedDb' | 'conflicts' | 'baselineKind'>): string {
  const lead = `把 ${p.derivedDb} 整库写回 ${p.targetDb}：先自动备份 ${p.targetDb} 并演练验证，再用派生库内容替换`;
  if (p.conflicts.length === 0) {
    return p.baselineKind === 'clone-time'
      ? `${lead}；${p.targetDb} 在克隆之后没有被写过，没有会被覆盖的改动。`
      : `${lead}；两边逐表行数一致，没有基线可比，请自行确认 ${p.targetDb} 近期没有写入。`;
  }
  const overwritten = p.conflicts.map((c) => c.table).join('、');
  return p.baselineKind === 'clone-time'
    ? `${lead}；${p.targetDb} 在克隆之后改过 ${p.conflicts.length} 张表（${overwritten}），这些改动会被覆盖——回写前快照可回退。`
    : `${lead}；${p.conflicts.length} 张表两边行数不同（${overwritten}），没有克隆基线，按当前差异列出——回写前快照可回退。`;
}

export function buildWriteBackPreview(
  entry: Pick<DbLedgerEntry, 'dbName' | 'clone'>,
  targetDb: string,
  parentNow: Record<string, number>,
  derived: Record<string, number>,
): WriteBackPreview {
  // 基线 = 克隆物在克隆完成那一刻的行数（校验表的 target 列）：它就是主库在克隆时间点的样子。
  // 不能用 source 列——那是克隆完成后才量的主库，可能已经含了克隆之后的写入。
  const baseline = entry.clone?.verification
    ? Object.fromEntries(entry.clone.verification.tables.map((t) => [t.table, t.target]))
    : undefined;
  const { conflicts, baselineKind } = writeBackConflicts(parentNow, derived, baseline);
  const names = [...new Set([...Object.keys(parentNow), ...Object.keys(derived)])].sort();
  const tables = names.map((table) => ({ table, parent: parentNow[table], derived: derived[table] }));
  const preview = { targetDb, derivedDb: entry.dbName, baselineKind, conflicts, tables };
  return { ...preview, headline: writeBackHeadline(preview) };
}
