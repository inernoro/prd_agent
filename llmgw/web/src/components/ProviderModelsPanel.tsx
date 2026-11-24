import { providerCollectionContext, providerModelDetailHref } from '@/lib/entityNavigation';
// 一个上游名下的模型，以及它们登记到白名单没有。
//
// 这一块回答的是「模型属于上游」这件事在界面上长什么样：模型不是一个平级的顶层入口，
// 它是上游卖的货，展开上游就该看到。同时它还回答了另一个更要紧的问题——
// **哪些货登记了、哪些没登记**。没登记的模型躺在库里，调用方按公开名请求时找不到它，
// 而在这之前这件事只能靠在两个页面之间来回对照才能看出来。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { LogicalModelItem, ModelItem } from '@/lib/types';
import { Button, Chip } from '@/components/ui';
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
  if (rows.length === 0) return '尚未接入模型';
  const unregistered = rows.filter((x) => x.publicIds.length === 0).length;
  return unregistered === 0
    ? `${rows.length} 个 · 均已关联公开模型`
    : `${rows.length} 个 · ${unregistered} 个未关联公开模型`;
}

export function ProviderModelImportAction({ onRegister, busy }: { onRegister?: () => void; busy?: boolean }) {
  return onRegister ? <Button variant="primary" size="sm" disabled={busy} onClick={onRegister}>导入模型</Button> : null;
}

export function ProviderModelsPanel({ rows }: { rows: ProviderModelRow[] }) {
  const [params] = useSearchParams();
  const restored = providerCollectionContext(params);
  const [mainView, setMainView] = useState({ query: restored.query, filter: restored.filter, page: restored.page });
  const [publicView, setPublicView] = useState({ query: restored.publicQuery, filter: '', page: restored.publicPage });
  const [selectedId, setSelectedId] = useState<string | null>(restored.selected || null);
  const returnRef = useRef<HTMLButtonElement>(null);
  const ownedLinks = useRef(new Map<string, HTMLAnchorElement>());
  const ownedTriggers = useRef(new Map<string, HTMLButtonElement>());
  const publicLinks = useRef(new Map<string, HTMLAnchorElement>());
  const restoreDone = useRef(!restored.focus && !restored.publicFocus);
  const openedByUser = useRef(false);
  const returnOwnedId = useRef(restored.selected);
  const selected = rows.find(row => row.model.id === selectedId);
  useEffect(() => {
    if (restoreDone.current) return;
    // A return bookmark is consumed once; later typing/paging belongs to the new action.
    if (mainView.query !== restored.query || mainView.filter !== restored.filter || mainView.page !== restored.page || publicView.query !== restored.publicQuery || publicView.page !== restored.publicPage || selectedId !== (restored.selected || null)) { restoreDone.current = true; return; }
    const target = restored.selected ? publicLinks.current.get(restored.publicFocus) : ownedLinks.current.get(restored.focus);
    if (!target) return;
    restoreDone.current = true;
    target.scrollIntoView({ block: 'nearest' }); target.focus({ preventScroll: true });
  }, [rows.length, mainView, publicView, selectedId, restored.focus, restored.publicFocus]);
  useEffect(() => {
    if (selected) {
      if (openedByUser.current || !restored.publicFocus) returnRef.current?.focus({ preventScroll: true });
    } else if (returnOwnedId.current) {
      const target = ownedTriggers.current.get(returnOwnedId.current) || ownedLinks.current.get(returnOwnedId.current);
      target?.scrollIntoView({ block: 'nearest' }); target?.focus({ preventScroll: true });
    }
  }, [selected?.model.id]);
  const unregistered = useMemo(() => rows.filter((row) => row.publicIds.length === 0).length, [rows]);
  return <>
    <CollectionView initialView={mainView} onViewChange={setMainView} afterToolbar={unregistered ? <div className="lg-collection-subhead"><Chip label={`${unregistered} 个未关联`} color="var(--warn)" bg="var(--warn-bg)" /></div> : null} className={selected ? 'lg-collection-hidden' : ''} items={rows} emptyText={rows.length ? '没有匹配模型' : '尚未接入模型'} placeholder="搜索模型" searchLabel="搜索上游模型或公开标识" searchText={({ model, publicIds }) => `${model.name} ${model.modelName} ${publicIds.join(' ')}`} filters={[{ value: 'unregistered', label: '未关联公开模型', matches: (row) => row.publicIds.length === 0 }, { value: 'registered', label: '已关联公开模型', matches: (row) => row.publicIds.length > 0 }]}>
      {(pageRows) => <><table className="lg-collection-owned-table"><colgroup><col style={{width:'42%'}}/><col style={{width:'18%'}}/><col style={{width:'22%'}}/><col style={{width:'18%'}}/></colgroup><thead><tr><th>模型</th><th>管理状态</th><th>公开模型关联</th><th>操作</th></tr></thead><tbody>{pageRows.map(({ model, publicIds }) => <tr key={model.id} data-model-id={model.id} className={model.id === restored.focus ? 'lg-collection-selected-row' : undefined}>
        <td title={`${model.modelName || model.name} · ${publicIds.length ? `已登记到 ${publicIds.length} 个公开模型` : '尚未关联公开模型'}`}><Link ref={node => { if (node) ownedLinks.current.set(model.id, node); else ownedLinks.current.delete(model.id); }} to={providerModelDetailHref({ modelId: model.id, model: model.modelName || model.name, platformId: model.platformId || undefined }, 'upstream-provider', mainView)}><strong>{model.modelName || model.name}</strong></Link></td>
        <td>{model.enabled ? '已启用' : '已停用'}</td><td><span className={`lg-provider-association-state${publicIds.length ? '' : ' is-attention'}`}>{publicIds.length ? '已关联' : '未关联'}</span></td><td>{publicIds.length === 1 ? <Link className="lg-provider-public-model-link" to={providerModelDetailHref({ model: publicIds[0], platformId: model.platformId || undefined }, 'upstream-provider', { ...mainView, focus: model.id })}>查看公开模型</Link> : publicIds.length > 1 ? <button type="button" ref={node => { if (node) ownedTriggers.current.set(model.id, node); else ownedTriggers.current.delete(model.id); }} onClick={() => { openedByUser.current = true; returnOwnedId.current = model.id; setSelectedId(model.id); }} style={linkButton}>查看公开模型</button> : <Link to={providerModelDetailHref({ modelId: model.id, model: model.modelName || model.name, platformId: model.platformId || undefined }, 'upstream-provider', mainView)}>详情</Link>}</td>
      </tr>)}</tbody></table></>}
    </CollectionView>
    {selected ? <><div className="lg-collection-toolbar"><button ref={returnRef} type="button" style={linkButton} onClick={() => setSelectedId(null)}>返回已接入模型</button><span style={HINT_TEXT}>{selected.publicIds.length} 个公开模型</span></div><CollectionView key={selected.model.id} initialView={publicView} onViewChange={setPublicView} items={selected.publicIds} searchText={(id) => id} placeholder="搜索登记的公开模型">{(ids) => <>{ids.map((id) => <div className="lg-collection-code" key={id}><Link ref={node => { if (node) publicLinks.current.set(id, node); else publicLinks.current.delete(id); }} to={providerModelDetailHref({ model: id, platformId: selected.model.platformId || undefined }, 'upstream-provider', { ...mainView, focus: selected.model.id, selected: selected.model.id, publicQuery: publicView.query, publicPage: publicView.page, publicFocus: id })}>{id}</Link></div>)}</>}</CollectionView></> : null}
  </>;
}
const linkButton: React.CSSProperties = { background: 'none', border: 'none', padding: 0, color: 'var(--accent)', fontSize: 'var(--fs-secondary)', cursor: 'pointer' };
