/**
 * 全局知识库（管理层洞察，仅 pm-agent.dashboard）。
 *
 * 给老板/管理层一个「掌控全局」的只读视角：聚合所有项目的知识库（哪怕未被加为
 * 成员/干系人），左侧多维筛选 + 默认展开的分组列表，右侧复用 DocBrowser 只读预览
 * 正文（含 P0 修好的 createPortal 全屏）。纯洞察，不提供编辑/删除等操作。
 *
 * 数据：GET /api/pm/knowledge/overview（项目分组 + 筛选枚举 + 统计）
 *      GET /api/pm/knowledge/entries（分页 + 多维筛选）
 *      GET /api/pm/knowledge/entries/:id/content（只读正文）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Library, Search, X, FileText, ChevronDown, ChevronRight, FolderKanban, Eye } from 'lucide-react';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { getPmKnowledgeOverview, listPmKnowledgeEntries, getPmKnowledgeEntryContent } from '@/services';
import type {
  PmGlobalKnowledgeOverview, PmGlobalKnowledgeEntry, PmGlobalKnowledgeFilter, PmProjectType, PmProjectLifecycle,
} from '@/services/contracts/pmAgent';
import { DocBrowser, type DocBrowserEntry, type EntryPreview } from '@/components/doc-browser/DocBrowser';
import { PROJECT_TYPE_REGISTRY, LIFECYCLE_REGISTRY } from './pmConstants';
import { relTime } from './materialUtils';

type GroupBy = 'project' | 'category' | 'type';

const NO_CAT = '__none__';

const inputCls = 'rounded-lg px-2.5 py-1.5 text-[12px] outline-none border';
const inputStyle = { background: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' } as const;

/** PmGlobalKnowledgeEntry → DocBrowserEntry（null → undefined） */
function toDocEntry(e: PmGlobalKnowledgeEntry): DocBrowserEntry {
  return {
    id: e.id,
    title: e.title,
    parentId: e.parentId ?? undefined,
    isFolder: e.isFolder,
    sourceType: e.sourceType,
    contentType: e.contentType,
    fileSize: e.fileSize,
    tags: e.tags,
    category: e.category ?? undefined,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    updatedByName: e.updatedByName ?? undefined,
    summary: e.summary ?? undefined,
    lastChangedAt: e.lastChangedAt ?? undefined,
    metadata: e.metadata,
  };
}

export function GlobalKnowledgeView() {
  const [overview, setOverview] = useState<PmGlobalKnowledgeOverview | null>(null);
  const [entries, setEntries] = useState<PmGlobalKnowledgeEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [loadingEntries, setLoadingEntries] = useState(true);

  const [groupBy, setGroupBy] = useState<GroupBy>('project');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // 筛选维度
  const [projectType, setProjectType] = useState<PmProjectType | ''>('');
  const [lifecycle, setLifecycle] = useState<PmProjectLifecycle | ''>('');
  const [category, setCategory] = useState('');
  const [contentType, setContentType] = useState('');
  const [createdBy, setCreatedBy] = useState('');
  const [keyword, setKeyword] = useState('');

  // 选中文档（右侧只读预览）；预览只在选中项所属项目内导航
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // 总览（项目分组 + 筛选枚举）
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoadingOverview(true);
      const res = await getPmKnowledgeOverview();
      if (!alive) return;
      if (res.success) setOverview(res.data);
      else toast.error('加载失败', res.error?.message || '');
      setLoadingOverview(false);
    })();
    return () => { alive = false; };
  }, []);

  // 条目（多维筛选 + 关键词防抖）
  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(async () => {
      setLoadingEntries(true);
      const filter: PmGlobalKnowledgeFilter = { pageSize: 500 };
      if (projectType) filter.projectType = projectType;
      if (lifecycle) filter.lifecycle = lifecycle;
      if (category) filter.category = category;
      if (contentType) filter.contentType = contentType;
      if (createdBy) filter.createdBy = createdBy;
      if (keyword.trim()) filter.keyword = keyword.trim();
      const res = await listPmKnowledgeEntries(filter);
      if (!alive) return;
      if (res.success) { setEntries(res.data.items); setTotal(res.data.total); }
      else toast.error('加载失败', res.error?.message || '');
      setLoadingEntries(false);
    }, keyword ? 300 : 0);
    return () => { alive = false; window.clearTimeout(t); };
  }, [projectType, lifecycle, category, contentType, createdBy, keyword]);

  const loadContent = useCallback(async (entryId: string): Promise<EntryPreview | null> => {
    const res = await getPmKnowledgeEntryContent(entryId);
    if (!res.success) return null;
    return { text: res.data.hasContent ? res.data.content : null, fileUrl: res.data.fileUrl, contentType: res.data.contentType };
  }, []);

  // 分组（默认全展开）
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; color?: string; sub?: string; items: PmGlobalKnowledgeEntry[] }>();
    const pushTo = (key: string, label: string, color: string | undefined, sub: string | undefined, e: PmGlobalKnowledgeEntry) => {
      let g = map.get(key);
      if (!g) { g = { key, label, color, sub, items: [] }; map.set(key, g); }
      g.items.push(e);
    };
    for (const e of entries) {
      if (groupBy === 'project') {
        const t = e.projectType ? PROJECT_TYPE_REGISTRY[e.projectType] : undefined;
        pushTo(e.projectId ?? '__none__', e.projectTitle || '未归属项目', t?.color, e.projectNo ?? undefined, e);
      } else if (groupBy === 'category') {
        const c = e.category || '';
        pushTo(c || NO_CAT, c || '未分类', undefined, undefined, e);
      } else {
        const t = e.projectType ? PROJECT_TYPE_REGISTRY[e.projectType] : undefined;
        pushTo(e.projectType ?? '__none__', t?.label || '未分类型', t?.color, undefined, e);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.items.length - a.items.length);
  }, [entries, groupBy]);

  // 右侧预览：仅展示选中项所属项目内（已筛选）的文档，作为项目内导航
  const previewEntries = useMemo(() => {
    if (!selectedProjectId) return [];
    return entries.filter((e) => e.projectId === selectedProjectId).map(toDocEntry);
  }, [entries, selectedProjectId]);

  const onPick = (e: PmGlobalKnowledgeEntry) => {
    setSelectedProjectId(e.projectId ?? null);
    setSelectedEntryId(e.id);
  };

  const toggleGroup = (key: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const resetFilters = () => {
    setProjectType(''); setLifecycle(''); setCategory(''); setContentType(''); setCreatedBy(''); setKeyword('');
  };
  const hasFilter = !!(projectType || lifecycle || category || contentType || createdBy || keyword);

  if (loadingOverview) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在汇总全局知识库…" /></div>;

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      {/* 头部 + 全局统计 */}
      <div className="shrink-0 flex items-center gap-2 flex-wrap">
        <Library size={20} style={{ color: '#3B82F6' }} />
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h2 className="text-[17px] font-semibold" style={{ color: 'var(--text-primary)' }}>全局知识库</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1" style={{ background: 'rgba(59,130,246,0.12)', color: '#60A5FA' }}>
              <Eye size={10} />全局洞察 · 只读
            </span>
          </div>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            汇总全部项目知识库（不论是否为成员/干系人），仅供掌控全局，不改动项目内知识库
          </span>
        </div>
        <div className="ml-auto flex items-center gap-4 text-[12px]" style={{ color: 'var(--text-muted)' }}>
          <span>{overview?.totalProjects ?? 0} 个项目库</span>
          <span>{overview?.totalDocs ?? 0} 篇文档</span>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="shrink-0 flex items-center gap-2 flex-wrap rounded-xl border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <div className="relative">
          <Search size={13} style={{ color: 'var(--text-muted)', position: 'absolute', left: 8, top: 8 }} />
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="搜索标题 / 摘要"
            className={`${inputCls} pl-7`} style={{ ...inputStyle, width: 200 }} />
        </div>
        <select value={projectType} onChange={(e) => setProjectType(e.target.value as PmProjectType | '')} className={inputCls} style={inputStyle}>
          <option value="">全部类型</option>
          {(Object.keys(PROJECT_TYPE_REGISTRY) as PmProjectType[]).map((k) => <option key={k} value={k}>{PROJECT_TYPE_REGISTRY[k].label}</option>)}
        </select>
        <select value={lifecycle} onChange={(e) => setLifecycle(e.target.value as PmProjectLifecycle | '')} className={inputCls} style={inputStyle}>
          <option value="">全部阶段</option>
          {(Object.keys(LIFECYCLE_REGISTRY) as PmProjectLifecycle[]).map((k) => <option key={k} value={k}>{LIFECYCLE_REGISTRY[k].label}</option>)}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls} style={inputStyle}>
          <option value="">全部分类</option>
          {(overview?.facets.categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={contentType} onChange={(e) => setContentType(e.target.value)} className={inputCls} style={inputStyle}>
          <option value="">全部格式</option>
          {(overview?.facets.contentTypes ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={createdBy} onChange={(e) => setCreatedBy(e.target.value)} className={inputCls} style={inputStyle}>
          <option value="">全部创建人</option>
          {(overview?.facets.creators ?? []).map((u) => <option key={u.userId} value={u.userId}>{u.name || u.userId}（{u.count}）</option>)}
        </select>
        {hasFilter && (
          <button onClick={resetFilters} className="inline-flex items-center gap-1 text-[12px] px-2 py-1.5 rounded-lg" style={{ color: 'var(--text-muted)' }}>
            <X size={12} />清空
          </button>
        )}
        {/* 分组维度 */}
        <div className="ml-auto flex items-center gap-1 rounded-lg p-0.5" style={{ background: 'var(--bg-base)' }}>
          {([
            { k: 'project' as const, label: '按项目' },
            { k: 'category' as const, label: '按分类' },
            { k: 'type' as const, label: '按类型' },
          ]).map((g) => (
            <button key={g.k} onClick={() => setGroupBy(g.k)}
              className="px-2.5 py-1 rounded-md text-[11px] transition-colors"
              style={{ background: groupBy === g.k ? 'var(--bg-card)' : 'transparent', color: groupBy === g.k ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {/* 主体：左侧分组列表 + 右侧只读预览 */}
      <div className="flex-1 min-h-0 flex gap-3">
        {/* 左：分组列表（默认展开） */}
        <div className="w-[380px] shrink-0 min-h-0 flex flex-col rounded-xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          <div className="shrink-0 px-3 py-2 border-b text-[12px]" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
            共 {total} 篇文档{hasFilter ? '（已筛选）' : ''}
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-1.5" style={{ overscrollBehavior: 'contain' }}>
            {loadingEntries ? (
              <MapSectionLoader text="正在加载文档…" />
            ) : groups.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 py-12 text-center" style={{ color: 'var(--text-muted)' }}>
                <FolderKanban size={32} style={{ opacity: 0.4 }} />
                <div className="text-[13px]">{hasFilter ? '没有匹配的文档，试试放宽筛选' : '暂无任何项目知识库文档'}</div>
              </div>
            ) : (
              groups.map((g) => {
                const open = !collapsed.has(g.key);
                return (
                  <div key={g.key} className="rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
                    <button onClick={() => toggleGroup(g.key)} className="w-full flex items-center gap-2 px-2.5 py-2 text-left">
                      {open ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
                      {g.color && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: g.color }} />}
                      <span className="text-[12.5px] font-medium truncate flex-1 min-w-0" style={{ color: 'var(--text-primary)' }}>{g.label}</span>
                      {g.sub && <span className="text-[10px] shrink-0" style={{ color: 'var(--text-muted)' }}>{g.sub}</span>}
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0" style={{ background: 'var(--bg-card)', color: 'var(--text-muted)' }}>{g.items.length}</span>
                    </button>
                    {open && (
                      <div className="flex flex-col pb-1">
                        {g.items.map((e) => {
                          const on = selectedEntryId === e.id;
                          return (
                            <button key={e.id} onClick={() => onPick(e)}
                              className="flex items-start gap-2 px-2.5 py-1.5 mx-1 rounded-md text-left transition-colors"
                              style={{ background: on ? 'rgba(59,130,246,0.14)' : 'transparent' }}>
                              <FileText size={13} className="mt-0.5 shrink-0" style={{ color: on ? '#60A5FA' : 'var(--text-muted)' }} />
                              <div className="min-w-0 flex-1">
                                <div className="text-[12.5px] truncate" style={{ color: on ? '#93C5FD' : 'var(--text-primary)' }}>{e.title}</div>
                                <div className="text-[10px] flex items-center gap-2 truncate" style={{ color: 'var(--text-muted)' }}>
                                  {groupBy !== 'project' && e.projectTitle && <span className="truncate">{e.projectTitle}</span>}
                                  {e.category && <span>{e.category}</span>}
                                  {e.createdByName && <span>{e.createdByName}</span>}
                                  <span>{relTime(e.updatedAt)}</span>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 右：只读预览（复用 DocBrowser，含 createPortal 全屏） */}
        <div className="flex-1 min-w-0 min-h-0 rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          {selectedEntryId && previewEntries.length > 0 ? (
            <DocBrowser
              entries={previewEntries}
              selectedEntryId={selectedEntryId}
              onSelectEntry={setSelectedEntryId}
              loadContent={loadContent}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2 text-center" style={{ color: 'var(--text-muted)' }}>
              <Library size={36} style={{ opacity: 0.3 }} />
              <div className="text-[13px]">从左侧选择一篇文档查看正文</div>
              <div className="text-[11px]" style={{ color: 'rgba(255,255,255,0.25)' }}>支持全屏阅读（右上角「全屏」按钮，ESC 退出）</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
