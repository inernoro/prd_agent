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
import { Library, Search, X, FileText, ChevronDown, ChevronRight, FolderKanban, Eye, ArrowLeft } from 'lucide-react';
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
  // 列表优先：默认看全宽列表，点文档才进该项目的全宽 DocBrowser 详情，避免多列嵌套挤压正文
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');

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

  const openDetail = (e: PmGlobalKnowledgeEntry) => {
    setSelectedProjectId(e.projectId ?? null);
    setSelectedEntryId(e.id);
    setViewMode('detail');
  };
  const backToList = () => setViewMode('list');

  // 详情态所属项目（用于详情头展示项目名/编号）
  const detailProject = useMemo(
    () => overview?.projects.find((p) => p.projectId === selectedProjectId) ?? null,
    [overview, selectedProjectId],
  );

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

  // 详情态：全宽进入该项目的知识库浏览器（DocBrowser），顶部「返回列表」
  if (viewMode === 'detail' && selectedEntryId && previewEntries.length > 0) {
    return (
      <div className="flex flex-col gap-2 h-full min-h-0">
        <div className="shrink-0 flex items-center gap-2 flex-wrap">
          <button onClick={backToList} className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-lg hover:opacity-80" style={{ color: 'var(--text-secondary)', background: 'var(--bg-card)' }}>
            <ArrowLeft size={14} /> 返回列表
          </button>
          {detailProject && (
            <>
              {detailProject.projectType && (
                <span className="w-2 h-2 rounded-full" style={{ background: PROJECT_TYPE_REGISTRY[detailProject.projectType]?.color }} />
              )}
              <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{detailProject.title}</span>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{detailProject.projectNo}</span>
            </>
          )}
          <span className="text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-1" style={{ background: 'rgba(59,130,246,0.12)', color: '#60A5FA' }}>
            <Eye size={10} />只读
          </span>
        </div>
        <div className="flex-1 min-w-0 min-h-0 rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
          <DocBrowser
            entries={previewEntries}
            selectedEntryId={selectedEntryId}
            onSelectEntry={setSelectedEntryId}
            loadContent={loadContent}
            onBackToList={backToList}
          />
        </div>
      </div>
    );
  }

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

      {/* 列表（全宽，默认展开分组）：点文档进详情。去掉右侧常驻 DocBrowser，避免多列挤压 */}
      <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', overscrollBehavior: 'contain' }}>
        <div className="sticky top-0 z-[1] px-4 py-2 border-b text-[12px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
          共 {total} 篇文档{hasFilter ? '（已筛选）' : ''} · 点击文档进入只读阅读
        </div>
        {loadingEntries ? (
          <div className="py-16"><MapSectionLoader text="正在加载文档…" /></div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-20 text-center" style={{ color: 'var(--text-muted)' }}>
            <FolderKanban size={36} style={{ opacity: 0.4 }} />
            <div className="text-[13px]">{hasFilter ? '没有匹配的文档，试试放宽筛选' : '暂无任何项目知识库文档'}</div>
          </div>
        ) : (
          <div className="p-3 flex flex-col gap-3">
            {groups.map((g) => {
              const open = !collapsed.has(g.key);
              return (
                <div key={g.key}>
                  <button onClick={() => toggleGroup(g.key)} className="w-full flex items-center gap-2 px-2 py-1.5 text-left rounded-md hover:bg-[var(--bg-base)]">
                    {open ? <ChevronDown size={15} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={15} style={{ color: 'var(--text-muted)' }} />}
                    {g.color && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: g.color }} />}
                    <span className="text-[13.5px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{g.label}</span>
                    {g.sub && <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{g.sub}</span>}
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>{g.items.length}</span>
                  </button>
                  {open && (
                    <div className="grid gap-2 mt-2 pl-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                      {g.items.map((e) => (
                        <button key={e.id} onClick={() => openDetail(e)}
                          className="text-left rounded-lg border p-3 transition-colors hover:border-[rgba(59,130,246,0.4)]"
                          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText size={14} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                            <span className="text-[13px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{e.title}</span>
                          </div>
                          {e.summary && <div className="text-[11px] mt-1.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{e.summary}</div>}
                          <div className="text-[10.5px] mt-2 flex items-center gap-2 flex-wrap" style={{ color: 'var(--text-muted)' }}>
                            {groupBy !== 'project' && e.projectTitle && <span className="truncate max-w-[140px]">{e.projectTitle}</span>}
                            {e.category && <span className="px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-card)' }}>{e.category}</span>}
                            {e.createdByName && <span>{e.createdByName}</span>}
                            <span>{relTime(e.updatedAt)}</span>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
