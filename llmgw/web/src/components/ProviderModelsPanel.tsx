// 一个上游名下的模型，以及它们登记到白名单没有。
//
// 这一块回答的是「模型属于上游」这件事在界面上长什么样：模型不是一个平级的顶层入口，
// 它是上游卖的货，展开上游就该看到。同时它还回答了另一个更要紧的问题——
// **哪些货登记了、哪些没登记**。没登记的模型躺在库里，调用方按公开名请求时找不到它，
// 而在这之前这件事只能靠在两个页面之间来回对照才能看出来。
import { useEffect, useMemo, useRef, useState } from 'react';
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
  if (rows.length === 0) return '还没有模型';
  const unregistered = rows.filter((x) => x.publicIds.length === 0).length;
  return unregistered === 0
    ? `${rows.length} 个模型 · 都已登记`
    : `${rows.length} 个模型 · ${unregistered} 个没登记`;
}

export function ProviderModelsPanel({ rows, onRegister }: { rows: ProviderModelRow[]; onRegister?: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const returnRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selected = rows.find((row) => row.model.id === selectedId);
  useEffect(() => {
    if (selected) returnRef.current?.focus({ preventScroll: true });
    else if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
  }, [selected?.model.id]);
  const unregistered = useMemo(() => rows.filter((row) => row.publicIds.length === 0).length, [rows]);
  return <>
    <div className="lg-collection-toolbar"><span style={HINT_TEXT}>{rows.length} 个模型 · {unregistered} 个没登记</span>{onRegister ? <button type="button" onClick={onRegister} style={linkButton}>批量登记</button> : null}</div>
    <CollectionView className={selected ? 'lg-collection-hidden' : ''} items={rows} placeholder="搜索上游模型或公开标识" searchText={({ model, publicIds }) => `${model.name} ${model.modelName} ${publicIds.join(' ')}`} filters={[{ value: 'unregistered', label: '未登记', matches: (row) => row.publicIds.length === 0 }, { value: 'registered', label: '已登记', matches: (row) => row.publicIds.length > 0 }]}>
      {(pageRows) => <>{pageRows.map(({ model, publicIds }) => <div key={model.id} className="lg-collection-detail-card">
        <div><Link to={`/models/view?modelId=${encodeURIComponent(model.id)}&model=${encodeURIComponent(model.modelName || model.name)}&platformId=${encodeURIComponent(model.platformId || '')}`}><strong>{model.modelName || model.name}</strong></Link><span>{publicIds.length ? `已登记到 ${publicIds.length} 个公开模型` : '还没登记，调用方找不到它'}</span></div>
        {publicIds.length ? <button type="button" onClick={(event) => { triggerRef.current = event.currentTarget; setSelectedId(model.id); }} style={linkButton}>登记详情</button> : <Chip label="未登记" color="var(--warn)" bg="var(--warn-bg)" />}
      </div>)}</>}
    </CollectionView>
    {selected ? <><div className="lg-collection-toolbar"><button ref={returnRef} type="button" style={linkButton} onClick={() => setSelectedId(null)}>返回名下模型</button><span style={HINT_TEXT}>{selected.publicIds.length} 个公开模型</span></div><CollectionView key={selected.model.id} items={selected.publicIds} searchText={(id) => id} placeholder="搜索登记的公开模型">{(ids) => <>{ids.map((id) => <div className="lg-collection-code" key={id}><Link to={`/models/view?model=${encodeURIComponent(id)}`}>{id}</Link></div>)}</>}</CollectionView></> : null}
  </>;
}
const linkButton: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--accent)', fontSize: 'var(--fs-secondary)', cursor: 'pointer' };
