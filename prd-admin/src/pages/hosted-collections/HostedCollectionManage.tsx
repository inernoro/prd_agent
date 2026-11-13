import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Check, GripVertical, Minus, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { getHostedCollectionCandidates, saveHostedCollection } from '@/services/real/hostedCollections';
import type { HostedCollectionCandidates, HostedCollectionItem, HostedCollectionView, SaveHostedCollection } from '@/services/contracts/hostedCollections';
import './collections.css';

export function HostedCollectionManage({ data, onClose, onSaved }: { data?: HostedCollectionView; onClose: () => void; onSaved: (data: HostedCollectionView) => void }) {
  const [form, setForm] = useState<SaveHostedCollection>(() => data ? { ...data.collection, siteIds: [...data.collection.siteIds], sections: structuredClone(data.collection.sections) } : { name: '', description: '', siteIds: [], mainSiteId: '', sections: [] });
  const [pool, setPool] = useState<HostedCollectionCandidates>();
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'mine' | 'shared'>('mine');
  const [replacement, setReplacement] = useState<string>();
  const [undo, setUndo] = useState<{ id: string; at: number; main: boolean; sections: SaveHostedCollection['sections'] }>();
  const [importOpen, setImportOpen] = useState(false);
  const [dismissImport, setDismissImport] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<string>();
  const sheet = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const inFlight = useRef(false);
  useEffect(() => {
    let alive = true;
    void getHostedCollectionCandidates().then(result => { if (!alive) return; if (result.success) setPool(result.data); else setError(result.error.message); });
    const previous = document.activeElement as HTMLElement;
    sheet.current?.querySelector<HTMLInputElement>('input')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !inFlight.current) { event.preventDefault(); close.current(); }
      if (event.key !== 'Tab') return;
      const controls = [...sheet.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],select:not(:disabled)') ?? []].filter(e => e.offsetParent !== null);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { alive = false; document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  const items = new Map([...(data?.items ?? []), ...(pool?.items ?? [])].map(item => [item.id, item]));
  const members = form.siteIds.map(id => items.get(id)).filter((item): item is HostedCollectionItem => !!item);
  const patch = (value: Partial<SaveHostedCollection>) => setForm(current => ({ ...current, ...value }));
  function main(id: string) { patch({ mainSiteId: id, siteIds: [id, ...form.siteIds.filter(x => x !== id)], sections: form.sections.map(s => ({ ...s, siteIds: s.siteIds.filter(x => x !== id) })) }); }
  function remove(id: string, newMain?: string) {
    if (id === form.mainSiteId && form.siteIds.length > 1 && !newMain) { setReplacement(form.siteIds.find(x => x !== id)); return; }
    setUndo({ id, at: form.siteIds.indexOf(id), main: id === form.mainSiteId, sections: structuredClone(form.sections) });
    const ids = form.siteIds.filter(x => x !== id);
    const next = newMain ?? (id === form.mainSiteId ? ids[0] ?? '' : form.mainSiteId);
    patch({ siteIds: next ? [next, ...ids.filter(x => x !== next)] : ids, mainSiteId: next,
      sections: form.sections.map(s => ({ ...s, siteIds: s.siteIds.filter(x => x !== id && x !== next) })) });
    setReplacement(undefined);
  }
  function move(id: string, to: number) {
    if (id === form.mainSiteId || to < 1 || to >= form.siteIds.length) return;
    const ids = form.siteIds.filter(x => x !== id); ids.splice(to, 0, id); patch({ siteIds: ids });
  }
  function toggle(item: HostedCollectionItem) {
    if (form.siteIds.includes(item.id)) remove(item.id);
    else patch({ siteIds: [...form.siteIds, item.id], mainSiteId: form.mainSiteId || item.id });
  }
  async function save() {
    if (inFlight.current) return;
    if (!form.name.trim() || !form.siteIds.length) { setError(!form.name.trim() ? '请填写合集名称' : '至少选择1份文档'); return; }
    inFlight.current = true; setBusy(true); setError('');
    try { const result = await saveHostedCollection(data?.collection.id, form); if (result.success) onSaved(result.data); else setError(result.error.message); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const original = data?.collection.siteIds ?? [];
  const added = form.siteIds.filter(id => !original.includes(id)).length;
  const removed = original.filter(id => !form.siteIds.includes(id)).length;
  const orderChanged = original.filter(id => form.siteIds.includes(id)).join() !== form.siteIds.filter(id => original.includes(id)).join();
  const difference = [added ? `+${added} 添加` : '', removed ? `−${removed} 移出` : '', orderChanged ? '顺序已调整' : '', data && form.mainSiteId !== data.collection.mainSiteId ? '主文档已更换' : ''].filter(Boolean).join(' · ');
  const legacy = pool?.legacy.find(group => group.siteIds.some(id => !form.siteIds.includes(id)));
  return createPortal(<div className="hosted-collection hcol-manage hc-modal-root" style={{ position: 'fixed', inset: 0, height: '100dvh', zIndex: 100 }}><div className="hc-scrim" onClick={() => { if (!busy) onClose(); }} /><section className="hc-manage-sheet" role="dialog" aria-modal="true" aria-label={data ? '管理合集' : '新建合集'} ref={sheet} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, height: '100dvh', maxHeight: '100dvh' }}>
    <header className="hc-sheet-header"><div><strong>{data ? '管理合集' : '新建合集'}</strong><span className="mono">{data ? '修改后，新链接使用新成员；已分享链接保持原快照' : '选择成员 → 指定主文档 → 调整顺序'}</span></div><button className="ib" aria-label="关闭" disabled={busy} onClick={onClose}><X size={16} /></button></header>
    <div className="hc-manage-body" style={{ minHeight: 0 }}><div className="scroll hc-member-editor" style={{ minHeight: 0, overflowY: 'auto' }}>
      {error && <div className="hc-error" role="alert">{error}</div>}
      <div className="hc-name-fields"><label htmlFor="collection-name">合集名称</label><input id="collection-name" className="field" value={form.name} onChange={e => patch({ name: e.target.value })} placeholder="例如：2026 Q4 平台评审资料" disabled={busy} /><label htmlFor="collection-description">简要说明 <span>可选 · 显示在合集名称下方</span></label><textarea id="collection-description" className="field" value={form.description} onChange={e => patch({ description: e.target.value })} disabled={busy} /></div>
      <section><div className="hc-member-heading"><strong>成员与顺序 <span className="mono">{form.siteIds.length} 份</span></strong><span>拖动或用箭头调整 · 主文档始终置顶</span></div>
        {!members.length && <div className="hc-member-empty">还没有成员。从右侧选择你的托管文档，第一份会被设为主文档，之后可以更换。</div>}
        {replacement && <div className="hc-replace-main"><strong>移出主文档前，先选择新的主文档</strong><p>新的主文档会置顶，并作为合集的阅读起点。原文档只从本合集移出，不会被删除。</p><div className="hc-replace-options">{members.filter(item => item.id !== form.mainSiteId).map(item => <label className="radio" key={item.id}><input type="radio" name="replacement" checked={replacement === item.id} onChange={() => setReplacement(item.id)} /><span className="hc-ellipsis">{item.title}</span></label>)}</div><div className="hc-end"><button className="btn ghost" onClick={() => setReplacement(undefined)}>取消</button><button className="btn pri" onClick={() => remove(form.mainSiteId, replacement)}>更换主文档并移出</button></div></div>}
        <div className="hc-members">{members.map((item, i) => <div className={`mrow ${i === 0 ? 'pri' : ''} ${drag === item.id ? 'drag' : ''}`} key={item.id} draggable={i !== 0 && !busy} onDragStart={e => { e.dataTransfer.setData('text/plain', item.id); setDrag(item.id); }} onDragOver={e => { if (i > 0) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (drag) move(drag, i); setDrag(undefined); }} onDragEnd={() => setDrag(undefined)}><span className="grip">{i > 0 && <GripVertical size={14} />}</span><span className={`mono ${i === 0 ? 'n-p' : 'n'}`}>{i === 0 ? '主' : String(i).padStart(2, '0')}</span><span><span className={`tt ${i === 0 ? 'b' : ''}`} title={item.title}>{item.title}</span><span className="sub">{item.canEdit ? '我的文档' : `${item.author ?? '其他成员'} 的文档 · 权限由对方管理`} · 更新于 {item.updatedAt ? new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }).replace('/', '-') : '—'}{(item.memberships?.length ?? 0) > 1 && ` · 也在其他 ${item.memberships!.length - 1} 个合集`}</span></span><span className="hc-member-actions">{i === 0 ? <span className="tag t-m">主文档</span> : <button className="btn ghost setp" disabled={busy} onClick={() => main(item.id)}>设为主文档</button>}<button className="ib" aria-label={`上移${item.title}`} disabled={busy || i <= 1} onClick={() => move(item.id, i - 1)}><ArrowUp size={14} /></button><button className="ib" aria-label={`下移${item.title}`} disabled={busy || i === 0 || i === members.length - 1} onClick={() => move(item.id, i + 1)}><ArrowDown size={14} /></button><button className="ib dgr" aria-label={`从合集移出${item.title}`} disabled={busy} onClick={() => remove(item.id)}><Minus size={14} /></button></span></div>)}</div>
        {undo && <div className="hc-undo"><span>已移出「{items.get(undo.id)?.title}」。原文档及其所在的其他合集不受影响。</span><button className="btn ghost" onClick={() => { const ids = form.siteIds.filter(id => id !== undo.id); ids.splice(Math.min(undo.at, ids.length), 0, undo.id); patch({ siteIds: ids, mainSiteId: undo.main ? undo.id : form.mainSiteId || undo.id, sections: undo.sections }); setUndo(undefined); }}>撤销</button></div>}
      </section>
      <details className="hc-section-editor"><summary>划分章节</summary>{form.sections.map((section, i) => <div key={section.id}><input className="field" aria-label={`第${i + 1}个章节名称`} value={section.title} onChange={e => patch({ sections: form.sections.map(s => s.id === section.id ? { ...s, title: e.target.value } : s) })} />{members.filter(m => m.id !== form.mainSiteId).map(item => <label className="radio" key={item.id}><input type="checkbox" checked={section.siteIds.includes(item.id)} onChange={e => patch({ sections: form.sections.map(s => ({ ...s, siteIds: s.id === section.id ? e.target.checked ? [...s.siteIds.filter(id => id !== item.id), item.id] : s.siteIds.filter(id => id !== item.id) : s.siteIds.filter(id => id !== item.id) })) })} />{item.title}</label>)}</div>)}<button className="btn" onClick={() => patch({ sections: [...form.sections, { id: crypto.randomUUID(), title: '', siteIds: [] }] })}>添加章节</button></details>
    </div><aside className="hc-picker"><div className="hc-picker-head"><strong>添加文档</strong><input className="field" aria-label="查找托管文档" value={query} onChange={e => setQuery(e.target.value)} placeholder="查找你可访问的托管文档" /><div className="seg" aria-label="来源"><button aria-pressed={source === 'mine'} onClick={() => setSource('mine')}>我的托管</button><button aria-pressed={source === 'shared'} onClick={() => setSource('shared')}>与我共享</button></div></div>
      {legacy && !dismissImport && <div className="hc-legacy"><div className="hc-between"><strong>发现 {pool?.legacy.length} 个历史合集</strong><span className="tag t-l">旧版关联组</span></div><p>「{legacy.name}」· {legacy.siteIds.length} 份。导入会把它的文档加入当前列表，已有的手动关联组保持原样，不会合并。</p>{importOpen && <div>{legacy.siteIds.map(id => <div className="hc-between" key={id}><span>{items.get(id)?.title ?? '不可用文档'}</span><span className="mono">{form.siteIds.includes(id) ? '已在列表' : '将加入'}</span></div>)}</div>}<div className="hc-tools">{importOpen ? <button className="btn pri" onClick={() => { const ids = [...new Set([...form.siteIds, ...legacy.siteIds])]; patch({ siteIds: ids, mainSiteId: form.mainSiteId || legacy.mainSiteId }); setDismissImport(true); }}>确认导入 {legacy.siteIds.filter(id => !form.siteIds.includes(id)).length} 份</button> : <button className="btn" onClick={() => setImportOpen(true)}>预览内容</button>}<button className="btn ghost" onClick={() => setDismissImport(true)}>暂不导入</button></div></div>}
      <div className="scroll hc-picker-list" style={{ minHeight: 0, overflowY: 'auto' }}>{!pool && <MapSpinner size={20} />}{pool?.items.filter(item => (source === 'mine' ? item.canEdit : !item.canEdit) && (!query || item.title.includes(query))).map(item => <button className="prow" key={item.id} aria-pressed={form.siteIds.includes(item.id)} disabled={busy} onClick={() => toggle(item)}><span className={`cb ${form.siteIds.includes(item.id) ? 'on' : ''}`}><Check size={10} /></span><span><span className="tt">{item.title}</span><span className="sub">{form.siteIds.includes(item.id) ? item.id === form.mainSiteId ? '主文档 · ' : '已在列表 · ' : ''}{item.author} · {item.updatedAt ? new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }).replace('/', '-') : '—'}</span></span>{!!item.memberships?.length && <span className="mono">{item.memberships.length} 个合集</span>}</button>)}</div><div className="hc-picker-foot">加入合集不会修改文档原有权限。分享合集时可预览差异。</div></aside></div>
    <footer className="hc-sheet-footer"><div>{data && <><Link to={`/web-pages/collections/${data.collection.id}/share`}>停止分享或解散合集…</Link><span className="hc-footer-divider" /></>}<span className="mono">{difference ? `相对已保存：${difference}` : data ? '暂无修改' : form.siteIds.length ? `${form.siteIds.length} 份 · 主文档：${items.get(form.mainSiteId)?.title ?? ''}` : '至少选择 1 份文档'}</span></div><div className="hc-tools"><button className="btn ghost" disabled={busy} onClick={onClose}>取消</button><button className="btn pri" disabled={busy} onClick={() => void save()}>{busy && <MapSpinner size={13} />}{data ? '保存修改' : '创建合集'}</button></div></footer>
  </section></div>, document.body);
}
