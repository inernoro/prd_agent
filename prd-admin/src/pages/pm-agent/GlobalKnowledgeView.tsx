/**
 * 全局知识库（管理层洞察，仅 pm-agent.dashboard）。
 *
 * 给老板/管理层一个「掌控全局」的视角：聚合所有项目的知识库（哪怕未被加为
 * 成员/干系人）。列表优先——顶部多维筛选 + 全宽表格行 + 分页；点某文档进入
 * 该项目的全宽 DocBrowser 阅读（不提供编辑/删除等写操作）。
 *
 * 数据：GET /api/pm/knowledge/overview（项目分组 + 筛选枚举 + 统计）
 *      GET /api/pm/knowledge/entries（分页 + 多维筛选）
 *      GET /api/pm/knowledge/entries/:id/content（只读正文）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Library, Search, X, FileText, FolderKanban, ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { getPmKnowledgeOverview, listPmKnowledgeEntries, getPmKnowledgeEntryContent } from '@/services';
import type {
  PmGlobalKnowledgeOverview, PmGlobalKnowledgeEntry, PmGlobalKnowledgeFilter, PmProjectType, PmProjectLifecycle,
} from '@/services/contracts/pmAgent';
import { DocBrowser, type DocBrowserEntry, type EntryPreview } from '@/components/doc-browser/DocBrowser';
import { PROJECT_TYPE_REGISTRY, LIFECYCLE_REGISTRY } from './pmConstants';
import { relTime } from './materialUtils';

const PAGE_SIZE = 50;

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
  const [page, setPage] = useState(1);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [loadingEntries, setLoadingEntries] = useState(true);

  // 筛选维度
  const [projectId, setProjectId] = useState('');
  const [projectType, setProjectType] = useState<PmProjectType | ''>('');
  const [lifecycle, setLifecycle] = useState<PmProjectLifecycle | ''>('');
  const [category, setCategory] = useState('');
  const [contentType, setContentType] = useState('');
  const [createdBy, setCreatedBy] = useState('');
  const [keyword, setKeyword] = useState('');

  // 选中文档（详情阅读）；详情仅在选中项所属项目内导航
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'detail'>('list');

  // 总览（项目列表 + 筛选枚举）
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

  // 筛选变更 → 回到第 1 页
  useEffect(() => {
    setPage(1);
  }, [projectId, projectType, lifecycle, category, contentType, createdBy, keyword]);

  // 条目（多维筛选 + 分页 + 关键词防抖）
  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(async () => {
      setLoadingEntries(true);
      const filter: PmGlobalKnowledgeFilter = { page, pageSize: PAGE_SIZE };
      if (projectId) filter.projectId = projectId;
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
  }, [projectId, projectType, lifecycle, category, contentType, createdBy, keyword, page]);

  const loadContent = useCallback(async (entryId: string): Promise<EntryPreview | null> => {
    const res = await getPmKnowledgeEntryContent(entryId);
    if (!res.success) return null;
    return { text: res.data.hasContent ? res.data.content : null, fileUrl: res.data.fileUrl, contentType: res.data.contentType };
  }, []);

  // 详情态：仅展示选中项所属项目内（当前页）的文档，作为项目内导航
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

  const detailProject = useMemo(
    () => overview?.projects.find((p) => p.projectId === selectedProjectId) ?? null,
    [overview, selectedProjectId],
  );

  const resetFilters = () => {
    setProjectId(''); setProjectType(''); setLifecycle(''); setCategory(''); setContentType(''); setCreatedBy(''); setKeyword('');
  };
  const hasFilter = !!(projectId || projectType || lifecycle || category || contentType || createdBy || keyword);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (loadingOverview) return <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在汇总全局知识库…" /></div>;

  // 详情态：全宽进入该项目的知识库浏览器（DocBrowser），顶部「返回列表」。
  // wrapper 必须是 flex 容器，DocBrowser 根的 flex-1 才能撑满（否则塌成内容高=截断）。
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
        </div>
        <div className="flex-1 min-w-0 min-h-0 flex flex-col rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
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
          <h2 className="text-[17px] font-semibold" style={{ color: 'var(--text-primary)' }}>全局知识库</h2>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>汇总全部项目知识库</span>
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
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={inputCls} style={inputStyle}>
          <option value="">全部项目</option>
          {(overview?.projects ?? []).map((p) => <option key={p.projectId} value={p.projectId}>{p.title}</option>)}
        </select>
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
      </div>

      {/* 文档列表（扁平表格行 + 分页）：点行进详情 */}
      <div className="flex-1 min-h-0 flex flex-col rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="shrink-0 px-4 py-2 border-b text-[12px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)', color: 'var(--text-muted)' }}>
          共 {total} 篇文档{hasFilter ? '（已筛选）' : ''}
        </div>
        {loadingEntries ? (
          <div className="flex-1 min-h-0 flex items-center justify-center"><MapSectionLoader text="正在加载文档…" /></div>
        ) : entries.length === 0 ? (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-center" style={{ color: 'var(--text-muted)' }}>
            <FolderKanban size={36} style={{ opacity: 0.4 }} />
            <div className="text-[13px]">{hasFilter ? '没有匹配的文档，试试放宽筛选' : '暂无任何项目知识库文档'}</div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto" style={{ overscrollBehavior: 'contain' }}>
            <table className="w-full text-[12px]" style={{ borderCollapse: 'collapse' }}>
              <thead className="sticky top-0 z-10" style={{ background: 'var(--bg-base)' }}>
                <tr style={{ color: 'var(--text-secondary)' }}>
                  <th className="text-left font-semibold px-3 py-2">文档标题</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">所属项目</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">分类</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">创建人</th>
                  <th className="text-left font-semibold px-3 py-2 whitespace-nowrap">更新时间</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} onClick={() => openDetail(e)}
                    className="border-t cursor-pointer transition-colors hover:bg-[var(--bg-base)]"
                    style={{ borderColor: 'var(--border-subtle)' }}>
                    <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText size={13} className="shrink-0" style={{ color: 'var(--text-muted)' }} />
                        <span className="truncate max-w-[420px]">{e.title}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                      {e.projectType && <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: PROJECT_TYPE_REGISTRY[e.projectType]?.color }} />}
                      {e.projectTitle || '—'}{e.projectNo ? <span style={{ color: 'var(--text-muted)' }}> · {e.projectNo}</span> : null}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{e.category || '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>{e.createdByName || '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums" style={{ color: 'var(--text-muted)' }}>{relTime(e.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="shrink-0 flex items-center justify-end gap-2 px-3 py-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>第 {page} / {totalPages} 页</span>
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}><ChevronLeft size={14} />上一页</Button>
          <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>下一页<ChevronRight size={14} /></Button>
        </div>
      </div>
    </div>
  );
}
