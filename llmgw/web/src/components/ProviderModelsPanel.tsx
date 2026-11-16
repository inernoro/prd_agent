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
import { HINT_TEXT } from '@/lib/typography';
import { CollectionView } from '@/components/CollectionView';

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
  if (rows.length === 0) return '接入模型';
  const unregistered = rows.filter((x) => x.publicIds.length === 0).length;
  return unregistered === 0
    ? `${rows.length} 个模型 · 已接入`
    : `${rows.length} 个模型 · ${unregistered} 个待接入`;
}

export function ProviderModelsPanel({ rows, onRegister }: { rows: ProviderModelRow[]; onRegister?: () => void }) {
  const unregistered = useMemo(() => rows.filter((row) => row.publicIds.length === 0).length, [rows]);
  return <>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={HINT_TEXT}>接入后自动建立公开模型线路；MAP 按调用方权限使用。同一公开模型可有多个上游。</span>
      {onRegister ? <button type="button" onClick={onRegister} style={linkButton}>接入更多模型</button> : null}
    </div>
    <CollectionView afterToolbar={<div className="lg-collection-subhead"><Chip label={unregistered ? `${unregistered} 个待接入` : '全部已接入'} color={unregistered ? 'var(--warn)' : 'var(--ok)'} bg={unregistered ? 'var(--warn-bg)' : 'var(--ok-bg)'} /></div>} items={rows} placeholder="搜索模型或公开标识" searchText={({ model, publicIds }) => `${model.name} ${model.modelName} ${publicIds.join(' ')}`} filters={[{ value: 'unregistered', label: '待接入', matches: (row) => row.publicIds.length === 0 }, { value: 'registered', label: '已接入', matches: (row) => row.publicIds.length > 0 }]} emptyText={rows.length ? '没有匹配结果' : '尚未接入模型，点击“接入更多模型”选择需要的模型。'}>
      {(pageRows) => <table className="lg-collection-owned-table"><colgroup><col style={{width:'45%'}}/><col style={{width:'55%'}}/></colgroup><thead><tr><th>上游模型</th><th>公开模型 / 接入状态</th></tr></thead><tbody>{pageRows.map(({ model, publicIds }) => <tr key={model.id}>
        <td><Link to={`/models/view?modelId=${encodeURIComponent(model.id)}&model=${encodeURIComponent(model.modelName || model.name)}&platformId=${encodeURIComponent(model.platformId || '')}`}><strong>{model.modelName || model.name}</strong></Link></td>
        <td>{publicIds.length ? <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{publicIds.map(id => <Link key={id} to={`/models/view?model=${encodeURIComponent(id)}`}>{id}</Link>)}</div> : <span style={{ ...HINT_TEXT, color: 'var(--warn)' }} title="尚未接入公开模型，调用方暂时不可用">待接入{onRegister ? <button type="button" onClick={onRegister} style={{ ...linkButton, marginLeft: 8 }}>选择接入</button> : null}</span>}</td>
      </tr>)}</tbody></table>}
    </CollectionView>
  </>;
}
const linkButton: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--accent)', fontSize: 'var(--fs-secondary)', cursor: 'pointer' };
