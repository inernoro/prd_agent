import { useCallback, useEffect, useMemo, useState } from 'react';
import { Search, Sparkles, Download, Trash2, Eye, FileText, Cpu, Share2, Globe, Palette, Pencil, Check, X, CheckSquare, Square as SquareIcon } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner, MapSectionLoader } from '@/components/ui/VideoLoader';
import { listPmBriefings, getPmBriefing, deletePmBriefing, listBriefingStyles, renamePmBriefing } from '@/services';
import type { PmBriefing, PmBriefingStyle } from '@/services/contracts/pmAgent';
import { toast } from '@/lib/toast';
import { BriefingGenerateModal, BriefingViewModal, downloadHtml, fmtDateTime } from './PmBriefingSection';

interface Props {
  projectId: string;
  canManage: boolean;
}

/** 超过该条数时按月分组展示 */
const GROUP_THRESHOLD = 10;

function monthKey(s: string) {
  const d = new Date(s);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

/**
 * 简报管理页（资料 → 简报）—— 简报多时的管理主场：
 * 搜索 / 风格筛选 / 行内重命名 / 批量删除 / 按月分组；行点击复用预览弹窗（全屏/切风格/分享/托管/下载）。
 */
export function BriefingManagePanel({ projectId, canManage }: Props) {
  const [items, setItems] = useState<PmBriefing[]>([]);
  const [loading, setLoading] = useState(true);
  const [styles, setStyles] = useState<PmBriefingStyle[]>([]);
  const [search, setSearch] = useState('');
  const [styleFilter, setStyleFilter] = useState('');
  const [genOpen, setGenOpen] = useState(false);
  const [viewing, setViewing] = useState<PmBriefing | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // 行内重命名
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  // 批量选择
  const [batchMode, setBatchMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);

  const load = useCallback(async () => {
    const res = await listPmBriefings(projectId);
    if (res.success) setItems(res.data.items);
    setLoading(false);
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { listBriefingStyles().then((res) => { if (res.success) setStyles(res.data.items); }); }, []);

  const styleLabel = (key?: string) => styles.find((s) => s.key === key)?.label;

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return items.filter((b) =>
      (!kw || b.title.toLowerCase().includes(kw) || (b.createdByName ?? '').toLowerCase().includes(kw))
      && (!styleFilter || (b.style || 'classic') === styleFilter));
  }, [items, search, styleFilter]);

  // 超过阈值按生成月份分组（列表本身已按时间倒序）
  const groups = useMemo(() => {
    if (filtered.length <= GROUP_THRESHOLD) return [{ label: '', rows: filtered }];
    const map = new Map<string, PmBriefing[]>();
    for (const b of filtered) {
      const k = monthKey(b.createdAt);
      (map.get(k) ?? map.set(k, []).get(k)!).push(b);
    }
    return Array.from(map.entries()).map(([label, rows]) => ({ label, rows }));
  }, [filtered]);

  const openView = async (id: string) => {
    if (batchMode) { toggleSelect(id); return; }
    setBusyId(id);
    const res = await getPmBriefing(id);
    setBusyId(null);
    if (res.success) setViewing(res.data);
    else toast.error('加载失败', res.error?.message || '');
  };

  const download = async (b: PmBriefing) => {
    setBusyId(b.id);
    const res = await getPmBriefing(b.id);
    setBusyId(null);
    if (res.success && res.data.html) downloadHtml(res.data.title, res.data.html);
    else toast.error('下载失败', res.error?.message || '');
  };

  const remove = async (b: PmBriefing) => {
    if (!window.confirm(`确定删除简报「${b.title}」？`)) return;
    setBusyId(b.id);
    const res = await deletePmBriefing(b.id);
    setBusyId(null);
    if (res.success) { toast.success('已删除', ''); load(); }
    else toast.error('删除失败', res.error?.message || '');
  };

  const startRename = (b: PmBriefing) => { setRenamingId(b.id); setRenameDraft(b.title); };
  const saveRename = async () => {
    if (!renamingId) return;
    const title = renameDraft.trim();
    if (!title) { toast.error('标题不能为空', ''); return; }
    setRenameSaving(true);
    const res = await renamePmBriefing(renamingId, title);
    setRenameSaving(false);
    if (res.success) {
      setItems((prev) => prev.map((x) => (x.id === renamingId ? { ...x, title: res.data.title } : x)));
      setRenamingId(null);
      toast.success('已重命名', '');
    } else toast.error('重命名失败', res.error?.message || '');
  };

  const toggleSelect = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allSelected = filtered.length > 0 && filtered.every((b) => selected.has(b.id));
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(filtered.map((b) => b.id)));
  const exitBatch = () => { setBatchMode(false); setSelected(new Set()); };

  const batchDelete = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`确定删除选中的 ${selected.size} 份简报？删除后不可恢复。`)) return;
    setBatchDeleting(true);
    let ok = 0; let fail = 0;
    for (const id of selected) {
      const res = await deletePmBriefing(id);
      if (res.success) ok++; else fail++;
    }
    setBatchDeleting(false);
    exitBatch();
    if (fail > 0) toast.error(`删除完成：成功 ${ok}，失败 ${fail}`, '失败项可能无权限或已被删除');
    else toast.success(`已删除 ${ok} 份简报`, '');
    load();
  };

  const renderRow = (b: PmBriefing) => {
    const checked = selected.has(b.id);
    return (
      <div key={b.id} className="group flex items-center gap-3 py-2.5 px-3 rounded-md hover:bg-[var(--bg-base)] cursor-pointer border-b"
        style={{ borderColor: 'var(--border-subtle)' }} onClick={() => openView(b.id)}>
        {batchMode ? (
          checked
            ? <CheckSquare size={15} className="shrink-0" style={{ color: '#2563EB' }} />
            : <SquareIcon size={15} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
        ) : (
          <FileText size={14} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
        )}
        <div className="flex-1 min-w-0">
          {renamingId === b.id ? (
            <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <input autoFocus value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveRename(); if (e.key === 'Escape') setRenamingId(null); }}
                className="text-[12.5px] rounded px-2 py-1 outline-none border flex-1" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-strong)', color: 'var(--text-primary)', maxWidth: 420 }} />
              <button onClick={saveRename} disabled={renameSaving} title="保存" style={{ color: '#10B981' }}>{renameSaving ? <MapSpinner size={13} /> : <Check size={14} />}</button>
              <button onClick={() => setRenamingId(null)} title="取消" style={{ color: 'var(--text-muted)' }}><X size={14} /></button>
            </div>
          ) : (
            <div className="text-[12.5px] truncate" style={{ color: 'var(--text-primary)' }}>{b.title}</div>
          )}
          <div className="text-[10.5px] flex items-center gap-2 flex-wrap mt-0.5" style={{ color: 'var(--text-muted)' }}>
            <span>{fmtDateTime(b.createdAt)}</span>
            {b.createdByName && <span>{b.createdByName}</span>}
            {styleLabel(b.style) && <span className="inline-flex items-center gap-1"><Palette size={9} />{styleLabel(b.style)}</span>}
            {b.model && <span className="inline-flex items-center gap-1 font-mono"><Cpu size={9} />{b.model}</span>}
            {b.shared && <span className="inline-flex items-center gap-1" style={{ color: '#10B981' }}><Share2 size={9} />分享中</span>}
            {b.hostedSiteUrl && (
              <a href={b.hostedSiteUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 hover:underline" style={{ color: '#2563EB' }}><Globe size={9} />已托管</a>
            )}
          </div>
        </div>
        {!batchMode && (
          <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
            {busyId === b.id ? <MapSpinner size={13} /> : (
              <>
                <button onClick={() => openView(b.id)} className="p-1 rounded" title="预览" style={{ color: 'var(--text-muted)' }}><Eye size={13} /></button>
                {canManage && <button onClick={() => startRename(b)} className="p-1 rounded" title="重命名" style={{ color: 'var(--text-muted)' }}><Pencil size={13} /></button>}
                <button onClick={() => download(b)} className="p-1 rounded" title="下载 HTML" style={{ color: 'var(--text-muted)' }}><Download size={13} /></button>
                {canManage && <button onClick={() => remove(b)} className="p-1 rounded" title="删除" style={{ color: 'var(--text-muted)' }}><Trash2 size={13} /></button>}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  if (loading) return <MapSectionLoader text="正在加载简报…" />;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-3">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <div className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)' }}>
          <Search size={13} style={{ color: 'var(--text-muted)' }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索标题 / 创建人"
            className="text-[12px] outline-none bg-transparent" style={{ color: 'var(--text-primary)', width: 180 }} />
        </div>
        <select value={styleFilter} onChange={(e) => setStyleFilter(e.target.value)} title="按风格筛选"
          className="text-[12px] rounded-md px-2 py-1.5 outline-none border" style={{ background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}>
          <option value="">全部风格</option>
          {styles.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>共 {filtered.length} 份</span>
        <div className="ml-auto flex items-center gap-1.5">
          {canManage && items.length > 0 && !batchMode && (
            <Button variant="ghost" size="sm" onClick={() => setBatchMode(true)}><CheckSquare size={13} />批量管理</Button>
          )}
          {batchMode && (
            <>
              <Button variant="ghost" size="sm" onClick={toggleSelectAll}>{allSelected ? '取消全选' : '全选'}</Button>
              <Button variant="secondary" size="sm" disabled={selected.size === 0 || batchDeleting} onClick={batchDelete}>
                {batchDeleting ? <MapSpinner size={13} /> : <Trash2 size={13} />}删除所选 ({selected.size})
              </Button>
              <Button variant="ghost" size="sm" onClick={exitBatch}><X size={13} />退出批量</Button>
            </>
          )}
          {canManage && !batchMode && (
            <Button variant="primary" size="sm" onClick={() => setGenOpen(true)}><Sparkles size={13} />生成简报</Button>
          )}
        </div>
      </div>

      {/* 列表 */}
      {items.length === 0 ? (
        <div className="text-[12px] text-center py-12 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
          {canManage ? '还没有简报。点「生成简报」，AI 会基于目标 / 里程碑 / 任务 / 风险实时数据生成对外汇报页。' : '还没有简报。'}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-[12px] text-center py-12 rounded-lg border border-dashed" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
          没有匹配「{search || styleLabel(styleFilter) || ''}」的简报，试试调整搜索或筛选条件。
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', overscrollBehavior: 'contain' }}>
          {groups.map((g) => (
            <div key={g.label || 'all'}>
              {g.label && (
                <div className="text-[11px] font-semibold px-3 py-2 sticky top-0" style={{ color: 'var(--text-muted)', background: 'var(--bg-card)' }}>{g.label}</div>
              )}
              {g.rows.map(renderRow)}
            </div>
          ))}
        </div>
      )}

      {genOpen && (
        <BriefingGenerateModal projectId={projectId} styles={styles}
          onClose={() => setGenOpen(false)}
          onDone={(b) => { setGenOpen(false); setViewing(b); load(); }} />
      )}
      {viewing && <BriefingViewModal briefing={viewing} styles={styles} canManage={canManage} onChanged={load} onClose={() => setViewing(null)} />}
    </div>
  );
}
