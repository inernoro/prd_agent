import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/design/Button';
import { Dialog } from '@/components/ui/Dialog';
import {
  FileText,
  Filter,
  Plus,
  Pencil,
  Trash2,
  Database,
  BookOpen,
} from 'lucide-react';
import {
  listDocumentStoresWithPreview,
  listDocumentEntries,
  getDocumentContent,
  listChangelogReportSources,
  createChangelogReportSource,
  updateChangelogReportSource,
  deleteChangelogReportSource,
} from '@/services';
import type { DocumentStore, DocumentEntry } from '@/services/contracts/documentStore';
import type {
  ChangelogReportSource,
  ChangelogReportSourceUpsert,
} from '@/services/real/changelog';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';

/** 取条目对应的"最后修改时间"（优先 git commit time） */
function getEntryTime(e: DocumentEntry): string {
  return (
    e.metadata?.github_last_commit_at
    || e.lastChangedAt
    || e.updatedAt
    || e.createdAt
    || ''
  );
}

function getThisWeekStart(): number {
  const now = new Date();
  const day = now.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}

function isThisWeek(timeStr: string, weekStart: number): boolean {
  if (!timeStr) return false;
  const t = Date.parse(timeStr);
  if (Number.isNaN(t)) return false;
  return t >= weekStart;
}

/** sessionStorage 里记住"上次选的 source id"，改善体验（不存业务数据） */
const ACTIVE_SOURCE_KEY = 'weekly-reports-active-source';

export function WeeklyReportsTab() {
  const [sources, setSources] = useState<ChangelogReportSource[] | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stores, setStores] = useState<DocumentStore[]>([]);
  const [loadingStores, setLoadingStores] = useState(false);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [loadingEntries, setLoadingEntries] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  // 编辑弹窗
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<ChangelogReportSource | null>(null);

  // 首次加载：拉所有周报来源 + 所有知识库
  useEffect(() => {
    let alive = true;
    setLoadingSources(true);
    listChangelogReportSources()
      .then(res => {
        if (!alive) return;
        if (res.success) {
          setSources(res.data);
          const saved = sessionStorage.getItem(ACTIVE_SOURCE_KEY);
          const savedHit = saved && res.data.find(s => s.id === saved);
          setActiveId(savedHit ? savedHit.id : (res.data[0]?.id ?? null));
        } else {
          setSources([]);
          toast.error('加载周报来源失败', res.error?.message);
        }
      })
      .finally(() => { if (alive) setLoadingSources(false); });

    setLoadingStores(true);
    listDocumentStoresWithPreview(1, 200)
      .then(res => {
        if (!alive) return;
        if (res.success) setStores(res.data.items);
      })
      .finally(() => { if (alive) setLoadingStores(false); });

    return () => { alive = false; };
  }, []);

  const activeSource = useMemo(
    () => sources?.find(s => s.id === activeId) ?? null,
    [sources, activeId],
  );

  // 跟随 activeSource 变化：加载条目
  useEffect(() => {
    if (!activeSource) { setEntries([]); return; }
    let alive = true;
    setLoadingEntries(true);
    listDocumentEntries(activeSource.storeId, 1, 500)
      .then(res => {
        if (!alive) return;
        if (res.success) setEntries(res.data.items);
        else toast.error('加载条目失败', res.error?.message);
      })
      .finally(() => { if (alive) setLoadingEntries(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSource?.id, activeSource?.storeId]);

  const filtered = useMemo(() => {
    if (!activeSource) return [];
    const q = (activeSource.prefix || '').trim().toLowerCase();
    const pool = entries.filter(e => !e.isFolder);
    const matched = q
      ? pool.filter(e => e.title.toLowerCase().includes(q))
      : pool;
    return [...matched].sort((a, b) => getEntryTime(b).localeCompare(getEntryTime(a)));
  }, [activeSource, entries]);

  const weekStart = useMemo(() => getThisWeekStart(), []);

  useEffect(() => {
    if (filtered.length === 0) { setSelectedId(null); return; }
    setSelectedId(prev => {
      if (prev && filtered.some(e => e.id === prev)) return prev;
      return filtered[0].id;
    });
  }, [filtered]);

  useEffect(() => {
    if (!selectedId) { setContent(null); return; }
    let alive = true;
    setLoadingContent(true);
    getDocumentContent(selectedId)
      .then(res => {
        if (!alive) return;
        if (res.success) {
          setContent(res.data.hasContent && res.data.content
            ? res.data.content
            : '（此文件暂无可直接渲染的文本内容）');
        } else {
          setContent(`加载失败：${res.error?.message || '未知错误'}`);
        }
      })
      .finally(() => { if (alive) setLoadingContent(false); });
    return () => { alive = false; };
  }, [selectedId]);

  const handleSelectSource = (id: string) => {
    setActiveId(id);
    setSelectedId(null);
    sessionStorage.setItem(ACTIVE_SOURCE_KEY, id);
  };

  const handleOpenCreate = () => {
    setEditorTarget(null);
    setEditorOpen(true);
  };

  const handleOpenEdit = (src: ChangelogReportSource) => {
    setEditorTarget(src);
    setEditorOpen(true);
  };

  const handleDelete = async (src: ChangelogReportSource) => {
    if (!window.confirm(`确定删除周报来源「${src.name}」？此操作不会影响知识库数据。`)) return;
    const res = await deleteChangelogReportSource(src.id);
    if (!res.success) {
      toast.error('删除失败', res.error?.message);
      return;
    }
    toast.success('已删除');
    setSources(prev => {
      const next = (prev ?? []).filter(s => s.id !== src.id);
      if (activeId === src.id) {
        setActiveId(next[0]?.id ?? null);
        sessionStorage.removeItem(ACTIVE_SOURCE_KEY);
      }
      return next;
    });
  };

  const handleSaved = (saved: ChangelogReportSource, isNew: boolean) => {
    setSources(prev => {
      const base = prev ?? [];
      if (isNew) return [...base, saved];
      return base.map(s => (s.id === saved.id ? saved : s));
    });
    if (isNew) {
      setActiveId(saved.id);
      sessionStorage.setItem(ACTIVE_SOURCE_KEY, saved.id);
    }
    setEditorOpen(false);
  };

  // ── 空状态：没有任何来源 ──
  if (!loadingSources && sources && sources.length === 0) {
    return (
      <>
        <EmptyState onCreate={handleOpenCreate} />
        <SourceEditorDialog
          open={editorOpen}
          target={editorTarget}
          stores={stores}
          storesLoading={loadingStores}
          onClose={() => setEditorOpen(false)}
          onSaved={handleSaved}
        />
      </>
    );
  }

  // ── 加载中 ──
  if (loadingSources || !sources) {
    return (
      <div className="py-16">
        <MapSectionLoader text="正在加载周报来源…" />
      </div>
    );
  }

  const currentStore = stores.find(s => s.id === activeSource?.storeId);

  return (
    <div
      className="flex flex-col flex-1 min-h-0"
      style={{ minHeight: '560px' }}
    >
      {/* ── 周报来源 chip 栏 ── */}
      <SourceChipBar
        sources={sources}
        activeId={activeId}
        onSelect={handleSelectSource}
        onCreate={handleOpenCreate}
        onEdit={handleOpenEdit}
        onDelete={handleDelete}
      />

      {/* ── 当前来源信息条 ── */}
      {activeSource && (
        <div
          className="flex items-center justify-between flex-wrap gap-2 px-4 py-2 mb-3 rounded-xl"
          style={{
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <div className="flex items-center gap-2.5 flex-wrap min-w-0">
            <span
              className="px-2 py-[3px] rounded-md text-[10.5px] font-bold font-mono tracking-wider flex-shrink-0"
              style={{
                background: 'rgba(168, 85, 247, 0.12)',
                border: '1px solid rgba(168, 85, 247, 0.28)',
                color: '#d8b4fe',
              }}
            >● LIVE</span>
            <span className="text-[12px] font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
              <BookOpen size={11} className="inline mr-1 -mt-0.5 opacity-60" />
              {currentStore?.name || '（知识库已失效）'}
            </span>
            {activeSource.prefix && (
              <span
                className="text-[11px] flex items-center gap-1 px-1.5 py-0.5 rounded-md"
                style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--text-muted)' }}
              >
                <Filter size={10} />
                {activeSource.prefix}
              </span>
            )}
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              共 {filtered.length} 篇
            </span>
          </div>
          {activeSource.description && (
            <span
              className="text-[11px] truncate max-w-[50%]"
              style={{ color: 'var(--text-muted)' }}
              title={activeSource.description}
            >
              {activeSource.description}
            </span>
          )}
        </div>
      )}

      {/* ── 主体：左右独立滚动 ── */}
      <div
        className="flex gap-3 rounded-2xl"
        style={{
          flex: 1,
          minHeight: 0,
          background: 'rgba(0,0,0,0.22)',
          border: '1px solid rgba(255,255,255,0.06)',
          padding: '12px',
          overflow: 'hidden',
        }}
      >
        {/* 左：文件列表 */}
        <aside
          className="flex flex-col rounded-xl"
          style={{
            width: '300px',
            flexShrink: 0,
            minHeight: 0,
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.04)',
            overflow: 'hidden',
          }}
        >
          <div
            className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wider flex items-center justify-between"
            style={{
              color: 'var(--text-muted)',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              flexShrink: 0,
            }}
          >
            <span>周报列表 · 按最近提交</span>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
            }}
          >
            {loadingEntries ? (
              <div className="py-10"><MapSectionLoader text="正在加载…" /></div>
            ) : filtered.length === 0 ? (
              <div className="p-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {entries.length === 0
                  ? '该知识库暂无文件'
                  : activeSource?.prefix
                    ? `没有匹配「${activeSource.prefix}」的文件`
                    : '暂无文件'}
              </div>
            ) : (
              <ul className="py-1">
                {filtered.map(e => {
                  const active = selectedId === e.id;
                  const time = getEntryTime(e);
                  const date = time.slice(0, 10);
                  const isGit = !!e.metadata?.github_last_commit_at;
                  const fresh = isThisWeek(time, weekStart);
                  return (
                    <li key={e.id}>
                      <button
                        onClick={() => setSelectedId(e.id)}
                        className="w-full text-left px-3 py-2 transition-colors"
                        style={{
                          background: active ? 'rgba(168,85,247,0.12)' : 'transparent',
                          color: active ? '#e9d5ff' : 'var(--text-secondary)',
                          borderLeft: `2px solid ${active ? 'rgba(168,85,247,0.6)' : 'transparent'}`,
                          cursor: 'pointer',
                        }}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <FileText size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
                          <span className="text-[12px] truncate flex-1">{e.title}</span>
                          {fresh && (
                            <span
                              className="text-[9px] font-bold tracking-wider px-1.5 py-[1px] rounded"
                              style={{
                                background: 'rgba(34, 197, 94, 0.18)',
                                color: '#86efac',
                                border: '1px solid rgba(34, 197, 94, 0.35)',
                                flexShrink: 0,
                                lineHeight: '1.3',
                              }}
                              title="本周有新提交"
                            >
                              NEW
                            </span>
                          )}
                        </div>
                        {date && (
                          <div
                            className="text-[10px] mt-0.5 flex items-center gap-1"
                            style={{ paddingLeft: 20, color: 'var(--text-muted)' }}
                            title={isGit ? '最近 git 提交时间' : '同步入库时间'}
                          >
                            <span>{date}</span>
                            {isGit ? (
                              <span style={{ opacity: 0.5 }}>· git</span>
                            ) : (
                              <span style={{ opacity: 0.4 }}>· 同步</span>
                            )}
                          </div>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* 右：内容 */}
        <section
          className="flex flex-col rounded-xl"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            background: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.04)',
            overflow: 'hidden',
          }}
        >
          <div
            className="px-4 py-2.5 text-[13px] font-semibold truncate"
            style={{
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              color: 'var(--text-primary)',
              flexShrink: 0,
            }}
          >
            {filtered.find(e => e.id === selectedId)?.title || '（未选中文件）'}
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              padding: '20px 28px',
            }}
          >
            {loadingContent ? (
              <div className="py-10"><MapSectionLoader text="加载内容中…" /></div>
            ) : content == null ? (
              <div className="text-center text-[12px] py-10" style={{ color: 'var(--text-muted)' }}>
                左侧点击一篇周报查看内容
              </div>
            ) : (
              <MarkdownContent content={content} />
            )}
          </div>
        </section>
      </div>

      <SourceEditorDialog
        open={editorOpen}
        target={editorTarget}
        stores={stores}
        storesLoading={loadingStores}
        onClose={() => setEditorOpen(false)}
        onSaved={handleSaved}
      />
    </div>
  );
}

// ── 顶部：周报来源 chip 栏（tab 风 + 内联编辑删除） ──
function SourceChipBar({
  sources,
  activeId,
  onSelect,
  onCreate,
  onEdit,
  onDelete,
}: {
  sources: ChangelogReportSource[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onEdit: (src: ChangelogReportSource) => void;
  onDelete: (src: ChangelogReportSource) => void;
}) {
  return (
    <div
      className="flex items-center gap-1.5 mb-3 p-1.5 rounded-xl flex-wrap"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {sources.map(src => {
        const active = src.id === activeId;
        return (
          <div
            key={src.id}
            className="group relative flex items-center rounded-lg transition-all"
            style={{
              background: active ? 'rgba(168,85,247,0.14)' : 'rgba(255,255,255,0.02)',
              border: `1px solid ${active ? 'rgba(168,85,247,0.38)' : 'rgba(255,255,255,0.06)'}`,
            }}
          >
            <button
              type="button"
              onClick={() => onSelect(src.id)}
              className="px-3 py-1.5 text-[12.5px] font-medium transition-colors"
              style={{
                color: active ? '#e9d5ff' : 'var(--text-secondary)',
                cursor: 'pointer',
              }}
              title={src.description || src.name}
            >
              <FileText size={12} className="inline mr-1.5 -mt-0.5 opacity-70" />
              {src.name}
            </button>
            <div
              className="flex items-center pr-1 gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onEdit(src); }}
                className="p-1 rounded hover:bg-white/10"
                title="编辑"
                style={{ color: 'var(--text-muted)' }}
              >
                <Pencil size={11} />
              </button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onDelete(src); }}
                className="p-1 rounded hover:bg-red-500/20"
                title="删除"
                style={{ color: 'var(--text-muted)' }}
              >
                <Trash2 size={11} />
              </button>
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onCreate}
        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all"
        style={{
          background: 'rgba(168,85,247,0.08)',
          border: '1px dashed rgba(168,85,247,0.4)',
          color: '#d8b4fe',
          cursor: 'pointer',
        }}
        title="添加周报来源"
      >
        <Plus size={12} /> 添加来源
      </button>
    </div>
  );
}

// ── 空状态（零来源） ──
function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5"
        style={{
          background: 'rgba(168,85,247,0.10)',
          border: '1px solid rgba(168,85,247,0.25)',
          color: '#d8b4fe',
        }}
      >
        <Database size={28} />
      </div>
      <h3 className="text-lg font-semibold text-white mb-2">还没有周报来源</h3>
      <p className="text-[13px] max-w-md text-center mb-6" style={{ color: 'var(--text-muted)' }}>
        周报来源 = 一个知识库 + 一个文件名关键词。<br />
        配置后所有人都能看到。支持随时添加 / 编辑 / 删除。
      </p>
      <Button
        variant="primary"
        onClick={onCreate}
        className="h-10 px-5 rounded-xl text-[13px] font-semibold flex items-center gap-2"
        style={{
          background: 'linear-gradient(135deg, #a855f7 0%, #7e22ce 100%)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 6px 20px rgba(168,85,247,0.25)',
        }}
      >
        <Plus size={14} /> 创建第一个周报来源
      </Button>
    </div>
  );
}

// ── 创建/编辑弹窗 ──
function SourceEditorDialog({
  open,
  target,
  stores,
  storesLoading,
  onClose,
  onSaved,
}: {
  open: boolean;
  target: ChangelogReportSource | null;
  stores: DocumentStore[];
  storesLoading: boolean;
  onClose: () => void;
  onSaved: (saved: ChangelogReportSource, isNew: boolean) => void;
}) {
  const [name, setName] = useState('');
  const [storeId, setStoreId] = useState('');
  const [prefix, setPrefix] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(target?.name ?? '');
      setStoreId(target?.storeId ?? '');
      setPrefix(target?.prefix ?? '');
      setDescription(target?.description ?? '');
      setSaving(false);
    }
  }, [open, target]);

  const handleSave = async () => {
    if (!name.trim()) { toast.error('名称不能为空'); return; }
    if (!storeId) { toast.error('请选择知识库'); return; }
    const body: ChangelogReportSourceUpsert = {
      name: name.trim(),
      storeId,
      prefix: prefix.trim(),
      description: description.trim() || null,
    };
    setSaving(true);
    const res = target
      ? await updateChangelogReportSource(target.id, body)
      : await createChangelogReportSource(body);
    setSaving(false);
    if (!res.success) {
      toast.error('保存失败', res.error?.message);
      return;
    }
    toast.success(target ? '已更新' : '已创建');
    onSaved(res.data, !target);
  };

  const isEdit = !!target;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => { if (!v) onClose(); }}
      title={isEdit ? '编辑周报来源' : '新建周报来源'}
      description="一个来源 = 一个知识库 + 一个文件名关键词；全员共享。"
      maxWidth={520}
      content={(
        <div className="flex flex-col gap-4 py-2">
          <Field label="名称 *">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={60}
              placeholder="例如 MAP 周报 / 运营周报"
              className="w-full h-10 px-3 rounded-lg outline-none text-[13px]"
              style={{
                background: 'rgba(0,0,0,0.25)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--text-primary)',
              }}
            />
          </Field>
          <Field label="知识库 *">
            <select
              value={storeId}
              onChange={e => setStoreId(e.target.value)}
              disabled={storesLoading}
              className="w-full h-10 px-3 rounded-lg outline-none text-[13px]"
              style={{
                background: 'rgba(0,0,0,0.25)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--text-primary)',
              }}
            >
              <option value="">{storesLoading ? '加载中…' : '— 请选择 —'}</option>
              {stores.map(s => (
                <option key={s.id} value={s.id}>{s.name}（{s.documentCount} 项）</option>
              ))}
            </select>
          </Field>
          <Field label="文件名关键词（留空则显示该知识库全部文件）">
            <input
              value={prefix}
              onChange={e => setPrefix(e.target.value)}
              maxLength={120}
              placeholder='例如 week / 周报 / report.2026-W'
              className="w-full h-10 px-3 rounded-lg outline-none text-[13px] font-mono"
              style={{
                background: 'rgba(0,0,0,0.25)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--text-primary)',
              }}
            />
            <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-muted)' }}>
              子串匹配，不区分大小写。过滤仅影响展示，不改动知识库数据。
            </p>
          </Field>
          <Field label="描述（可选）">
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={300}
              rows={2}
              placeholder="一句话介绍这个周报来源的用途"
              className="w-full px-3 py-2 rounded-lg outline-none text-[13px] resize-none"
              style={{
                background: 'rgba(0,0,0,0.25)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--text-primary)',
              }}
            />
          </Field>
          <div className="flex gap-2.5 pt-1">
            <Button
              variant="ghost"
              onClick={onClose}
              className="flex-1 h-10 rounded-lg text-[13px]"
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={saving}
              className="flex-1 h-10 rounded-lg text-[13px] font-semibold flex items-center justify-center gap-2"
              style={{
                background: 'linear-gradient(135deg, #a855f7 0%, #7e22ce 100%)',
                border: '1px solid rgba(255,255,255,0.1)',
                boxShadow: '0 4px 12px rgba(168,85,247,0.3)',
              }}
            >
              {saving ? <MapSpinner size={14} /> : null}
              {isEdit ? '保存' : '创建'}
            </Button>
          </div>
        </div>
      )}
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}
