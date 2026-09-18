// 一个上游名下的模型，以及它们登记到白名单没有。
//
// 这一块回答的是「模型属于上游」这件事在界面上长什么样：模型不是一个平级的顶层入口，
// 它是上游卖的货，展开上游就该看到。同时它还回答了另一个更要紧的问题——
// **哪些货登记了、哪些没登记**。没登记的模型躺在库里，调用方按公开名请求时找不到它，
// 而在这之前这件事只能靠在两个页面之间来回对照才能看出来。
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { LogicalModelItem, ModelItem } from '@/lib/types';
import { Chip } from '@/components/ui';
import { HINT_TEXT, MONO_META } from '@/lib/typography';
import { GAP, INSET_BLOCK } from '@/lib/surface';

export type ProviderModelRow = {
  model: ModelItem;
  /** 登记到了哪些公开模型名下。空数组 = 没登记，调用方按名字请求找不到它。 */
  publicIds: string[];
};

/**
 * 算出一个上游名下每个模型的登记状态。
 *
 * 判据是「有没有线路指向这个物理模型」，不是「名字像不像」：Offering 的 targetId 指的是
 * 物理模型文档 id，按名字猜会把同名不同上游的两个模型算成一个。
 */
export function collectProviderModels(
  platformId: string,
  models: ModelItem[],
  logicalModels: LogicalModelItem[],
): ProviderModelRow[] {
  const byTarget = new Map<string, string[]>();
  for (const logical of logicalModels) {
    for (const offering of logical.offerings) {
      if (offering.targetKind !== 'model') continue;
      const list = byTarget.get(offering.targetId) ?? [];
      if (!list.includes(logical.publicId)) list.push(logical.publicId);
      byTarget.set(offering.targetId, list);
    }
  }
  return models
    .filter((x) => x.platformId === platformId)
    .map((model) => ({ model, publicIds: byTarget.get(model.id) ?? [] }))
    .sort((a, b) => {
      // 没登记的排前面：它们是这一屏唯一需要人动手的东西
      if (a.publicIds.length !== b.publicIds.length) return a.publicIds.length - b.publicIds.length;
      return (a.model.modelName || '').localeCompare(b.model.modelName || '');
    });
}

/** 一句话结论，给上游那一行用。「3 个模型」读不出该不该管，「2 个没登记」读得出。 */
export function summarizeProviderModels(rows: ProviderModelRow[]): string {
  if (rows.length === 0) return '还没有模型';
  const unregistered = rows.filter((x) => x.publicIds.length === 0).length;
  return unregistered === 0
    ? `${rows.length} 个模型 · 都已登记`
    : `${rows.length} 个模型 · ${unregistered} 个没登记`;
}

export function ProviderModelsPanel({ rows, onRegister }: {
  rows: ProviderModelRow[];
  onRegister?: () => void;
}) {
  const unregistered = useMemo(() => rows.filter((x) => x.publicIds.length === 0).length, [rows]);

  if (rows.length === 0) {
    return (
      <div style={{ ...INSET_BLOCK, display: 'flex', alignItems: 'center', gap: GAP.normal }}>
        <span style={HINT_TEXT}>这个上游名下还没有模型。从上游拉一次清单，勾中的一次登记完。</span>
        {onRegister ? <button type="button" onClick={onRegister} style={linkButton}>批量登记</button> : null}
      </div>
    );
  }

  return (
    <div style={{ ...INSET_BLOCK, display: 'flex', flexDirection: 'column', gap: GAP.normal }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: GAP.normal }}>
        <span style={{ fontSize: 'var(--fs-secondary)', fontWeight: 'var(--fw-strong)' as unknown as number }}>
          这个上游卖的模型
        </span>
        {unregistered > 0
          ? <Chip label={`${unregistered} 个没登记，调用方找不到`} color="var(--warn)" bg="var(--warn-bg)" />
          : <Chip label="都已登记" color="var(--ok)" bg="var(--ok-bg)" />}
        <span style={{ flex: 1 }} />
        {onRegister ? <button type="button" onClick={onRegister} style={linkButton}>批量登记</button> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.slice(0, 12).map(({ model, publicIds }) => (
          <div key={model.id} style={row}>
            <span style={{ ...MONO_META, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {model.modelName}
            </span>
            <span style={{ width: 260, minWidth: 0 }}>
              {publicIds.length === 0
                ? <span style={{ ...HINT_TEXT, color: 'var(--warn)' }}>还没登记，调用方找不到它</span>
                : <span style={{ ...MONO_META, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>
                    登记为 {publicIds.join('、')}
                  </span>}
            </span>
          </div>
        ))}
        {rows.length > 12
          ? <div style={{ ...HINT_TEXT, paddingTop: GAP.tight }}>
              还有 {rows.length - 12} 个，<Link className="lg-text-link" to="/models">去模型页看全部</Link>
            </div>
          : null}
      </div>
    </div>
  );
}

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: GAP.section,
  padding: '5px 0',
  borderTop: '1px solid var(--border-subtle)',
};

const linkButton: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--accent)',
  fontSize: 'var(--fs-secondary)',
  cursor: 'pointer',
};
