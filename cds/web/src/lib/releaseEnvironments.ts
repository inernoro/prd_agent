/**
 * 左栏「环境列表」的组装（纯函数，可单测）。
 *
 * 环境分组与排序的判据在后端（release-environment.ts），前端**不再写第二份**：
 * 这里只做 join —— 把后端给的 `environments[].targetIds` 和 `rows` 对起来。
 *
 * 老后端不下发 environments 时的退化路径刻意**不按 environment 字段自行分组**：
 * 那正好是把归一判据抄第二份（缺省算什么、未知值算什么），两处一漂移，
 * 同一个目标会在不同页面落进不同的组，而且不会有任何东西变红。
 * 退化成「一个不分组的列表」信息量更少，但绝不会给出一个错的分组。
 */

export interface EnvironmentGroupLike {
  environment: string;
  label: string;
  targetIds: string[];
  canonicalTargetId?: string;
  disabledCount: number;
}

export interface EnvironmentRowLike {
  target: {
    id: string;
    name: string;
    isEnabled: boolean;
  };
}

export interface EnvironmentEntry<Row extends EnvironmentRowLike> {
  targetId: string;
  row: Row;
  isCanonical: boolean;
}

export interface EnvironmentSection<Row extends EnvironmentRowLike> {
  environment: string;
  label: string;
  /** 启用中的目标，按后端给定顺序（canonical 优先）。 */
  entries: Array<EnvironmentEntry<Row>>;
  /** 已停用的目标，沉到折叠区。 */
  disabledEntries: Array<EnvironmentEntry<Row>>;
  canonicalTargetId?: string;
  /** true = 后端没下发分组，这是不分组的退化列表。 */
  degraded?: boolean;
}

const DEGRADED_SECTION_LABEL = '发布目标';

export function buildEnvironmentSections<Row extends EnvironmentRowLike>(
  groups: ReadonlyArray<EnvironmentGroupLike> | undefined,
  rows: ReadonlyArray<Row>,
): Array<EnvironmentSection<Row>> {
  const byId = new Map(rows.map((row) => [row.target.id, row]));

  if (!groups || groups.length === 0) {
    if (rows.length === 0) return [];
    return [{
      environment: 'unknown',
      label: DEGRADED_SECTION_LABEL,
      entries: rows.filter((row) => row.target.isEnabled).map((row) => ({
        targetId: row.target.id,
        row,
        isCanonical: false,
      })),
      disabledEntries: rows.filter((row) => !row.target.isEnabled).map((row) => ({
        targetId: row.target.id,
        row,
        isCanonical: false,
      })),
      degraded: true,
    }];
  }

  const sections: Array<EnvironmentSection<Row>> = [];
  const claimed = new Set<string>();
  for (const group of groups) {
    const entries: Array<EnvironmentEntry<Row>> = [];
    const disabledEntries: Array<EnvironmentEntry<Row>> = [];
    for (const targetId of group.targetIds) {
      const row = byId.get(targetId);
      // 分组里点名了、rows 里却没有：跳过而不是渲染一个点不动的死条目。
      if (!row) continue;
      claimed.add(targetId);
      const entry: EnvironmentEntry<Row> = {
        targetId,
        row,
        isCanonical: group.canonicalTargetId === targetId,
      };
      if (row.target.isEnabled) entries.push(entry);
      else disabledEntries.push(entry);
    }
    if (entries.length === 0 && disabledEntries.length === 0) continue;
    sections.push({
      environment: group.environment,
      label: group.label,
      entries,
      disabledEntries,
      ...(group.canonicalTargetId ? { canonicalTargetId: group.canonicalTargetId } : {}),
    });
  }

  // 分组里漏掉的目标必须仍然可见（宁可多一个「未分组」段，也不让一个目标凭空消失）。
  const orphans = rows.filter((row) => !claimed.has(row.target.id));
  if (orphans.length > 0) {
    sections.push({
      environment: 'unknown',
      label: '未分组',
      entries: orphans.filter((row) => row.target.isEnabled).map((row) => ({ targetId: row.target.id, row, isCanonical: false })),
      disabledEntries: orphans.filter((row) => !row.target.isEnabled).map((row) => ({ targetId: row.target.id, row, isCanonical: false })),
      degraded: true,
    });
  }

  return sections;
}

/** 所有段落里第一个启用中的目标；一个都没有时退到第一个停用的。 */
export function firstSelectableTargetId<Row extends EnvironmentRowLike>(
  sections: ReadonlyArray<EnvironmentSection<Row>>,
): string {
  for (const section of sections) {
    if (section.entries.length > 0) return section.entries[0].targetId;
  }
  for (const section of sections) {
    if (section.disabledEntries.length > 0) return section.disabledEntries[0].targetId;
  }
  return '';
}

/**
 * 选中态收敛：用户选过的还在就保留，否则回到第一个可选的。
 * 刷新后「选中的环境自己跳走」是最招人烦的一类闪烁。
 */
export function resolveSelectedTargetId<Row extends EnvironmentRowLike>(
  sections: ReadonlyArray<EnvironmentSection<Row>>,
  requested: string,
): string {
  if (requested) {
    const exists = sections.some((section) => (
      section.entries.some((entry) => entry.targetId === requested)
      || section.disabledEntries.some((entry) => entry.targetId === requested)
    ));
    if (exists) return requested;
  }
  return firstSelectableTargetId(sections);
}
