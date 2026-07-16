/**
 * LibraryShareViewPage — 知识库 / 单篇文档「分享链接」公开展示页
 *
 * 路径：/s/lib/:token （统一分享路由，对齐 /s/wp/、/s/skill/）
 *
 * 直接复用知识库的 DocBrowser 组件（只读模式：不传任何写操作 callback，
 * UI 自动隐藏新建/上传/编辑/删除/重命名等入口）。这样：
 *   - 样式/能力与 DocumentStorePage 永远一致
 *   - 后续 DocBrowser 的优化（懒加载、TOC、搜索高亮、响应式）分享页自动获得
 *   - 不再有「分享页和知识库自己看长得不一样」的漂移
 *
 * 数据层走 main 的 token 门禁匿名端点（getDocStoreShareView / listDocStoreShareEntries /
 * getDocStoreShareEntryContent），可展示「私有库的分享」，支持两种范围：
 *   - 整库分享（entryId 为空）：文件树 + 全部文档只读浏览
 *   - 单篇分享（entryId 非空）：只展示那一篇
 */
import { useEffect, useState, useCallback, useMemo, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, ShieldCheck, BookOpen, AlertCircle, Eye, FileText, Orbit, Network } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { DocBrowser } from '@/components/doc-browser/DocBrowser';
import type { DocBrowserEntry, EntryPreview } from '@/components/doc-browser/DocBrowser';
import type { DocBrowserSortMode } from '@/components/doc-browser/docBrowserSort';
import { DocumentGalaxyView, type GalaxyLabelMode } from '@/pages/document-store/DocumentGalaxyView';
import { UniverseGraphPage } from '@/pages/document-store/UniverseGraphPage';
import {
  getDocStoreShareView,
  listDocStoreShareEntries,
  getDocStoreShareEntryContent,
  getDocStoreShareGraph,
} from '@/services';
import type { DocStoreShareView, DocumentEntry } from '@/services/contracts/documentStore';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { setWikilinkEntries } from '@/lib/wikilinkCache';
import {
  parseLibraryShareViewMode,
  resolveControlledSharedEntryId,
  resolveInitialSharedEntryId,
  resolveLibraryShareSortMode,
  resolveSharedWikilinkEntryId,
  withLibraryShareEntry,
  withLibraryShareSortMode,
  withLibraryShareViewMode,
  type LibraryShareViewMode,
} from './libraryShareViewMode';

const PAGE_BG = '#0a0a0a';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export function LibraryShareViewPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [searchParams, setSearchParams] = useSearchParams();
  // URL ?entry={id} 优先级最高：归档脚本/外部链接可指定一打开就高亮某篇
  const entryFromUrl = searchParams.get('entry');
  const viewFromUrl = searchParams.get('view');
  const sortFromUrl = searchParams.get('sort');

  const [view, setView] = useState<DocStoreShareView | null>(null);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>(undefined);
  const [galaxyLabelMode, setGalaxyLabelMode] = useState<GalaxyLabelMode>('content');

  const shareSortMode = useMemo(
    () => resolveLibraryShareSortMode(
      sortFromUrl,
      entries.some((entry) => Number.isFinite(entry.sortOrder)),
    ),
    [entries, sortFromUrl],
  );

  useEffect(() => {
    if (!token) return;
    let mounted = true;
    setLoading(true);
    setError(null);
    Promise.all([
      getDocStoreShareView(token),
      listDocStoreShareEntries(token),
    ]).then(([viewRes, entriesRes]) => {
      if (!mounted) return;
      if (viewRes.success) setView(viewRes.data);
      else setError(viewRes.error?.message ?? '分享链接不存在或已撤销');
      if (entriesRes.success) setEntries(entriesRes.data.items);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, [token]);

  // 默认选中服从阅读排序：书籍顺序先打开主文档；时间模式打开相应的最新文档。
  const initialSelectedId = useMemo<string | undefined>(() => {
    if (!view || entries.length === 0) return undefined;
    return resolveInitialSharedEntryId(entries, {
      entryFromUrl,
      sharedEntryId: view.entryId,
      primaryEntryId: view.store.primaryEntryId,
      sortMode: shareSortMode,
    });
  }, [view, entries, entryFromUrl, shareSortMode]);

  useEffect(() => {
    if (!initialSelectedId) return;
    if (entryFromUrl) {
      if (selectedEntryId !== initialSelectedId) setSelectedEntryId(initialSelectedId);
      return;
    }
    if (!selectedEntryId) setSelectedEntryId(initialSelectedId);
  }, [entryFromUrl, initialSelectedId, selectedEntryId]);

  // DocBrowser 会在自己的首次 effect 中选择默认文档，而父组件同步 URL 的 effect
  // 要到提交后才执行。直接把有效深链作为受控值传下去，避免子 effect 抢先把
  // ?entry= 覆盖成 README；浏览器前进/后退时也由 URL 在首帧取得优先级。
  const controlledSelectedEntryId = resolveControlledSharedEntryId(
    selectedEntryId,
    initialSelectedId,
    Boolean(entryFromUrl),
  );

  // 公开阅读页与后台知识库共用 MarkdownViewer，因此也必须装载当前分享范围的双链索引。
  // 这里只写入匿名端点已经返回的条目，任何未被分享的文档都无法被解析或跳转。
  useEffect(() => {
    setWikilinkEntries(entries.filter((entry) => !entry.isFolder).map((entry) => ({
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      updatedAt: entry.updatedAt,
    })));
    return () => setWikilinkEntries([]);
  }, [entries]);

  const selectSharedEntry = useCallback((entryId: string) => {
    setSelectedEntryId(entryId);
    setSearchParams((current) => withLibraryShareEntry(current, entryId));
  }, [setSearchParams]);

  // MarkdownViewer 把 [[章节标题]] 派发为全局事件。公开页只在当前分享列表内解析，
  // 命中后同步内容和 URL，保证刷新、复制链接及浏览器前进后退都可复现。
  useEffect(() => {
    const handleWikilinkClick = (event: Event) => {
      const detail = (event as CustomEvent<{ title?: string; entryId?: string }>).detail ?? {};
      const entryId = resolveSharedWikilinkEntryId(entries, detail);
      if (entryId) selectSharedEntry(entryId);
    };
    document.addEventListener('wikilink:click', handleWikilinkClick);
    return () => document.removeEventListener('wikilink:click', handleWikilinkClick);
  }, [entries, selectSharedEntry]);

  const loadContent = useCallback(async (entryId: string): Promise<EntryPreview | null> => {
    if (!token) return null;
    const res = await getDocStoreShareEntryContent(token, entryId);
    if (!res.success) return null;
    return {
      text: res.data.hasContent ? res.data.content : null,
      fileUrl: res.data.fileUrl,
      contentType: res.data.contentType,
    };
  }, [token]);

  const loadGalaxyContent = useCallback((entryId: string) => {
    return getDocStoreShareEntryContent(token ?? '', entryId);
  }, [token]);

  const listGalaxyEntries = useCallback(() => {
    return listDocStoreShareEntries(token ?? '');
  }, [token]);

  const loadShareGraph = useCallback(() => {
    return getDocStoreShareGraph(token ?? '');
  }, [token]);

  const setShareViewMode = useCallback((mode: LibraryShareViewMode) => {
    // 视图模式切换用 replace，避免每次切换都往 history 堆条目
    setSearchParams(withLibraryShareViewMode(searchParams, mode), { replace: true });
  }, [searchParams, setSearchParams]);

  const setShareSortMode = useCallback((mode: DocBrowserSortMode) => {
    setSearchParams((current) => withLibraryShareSortMode(current, mode), { replace: true });
  }, [setSearchParams]);

  // DocumentEntry 字段是 DocBrowserEntry 的超集，可直接传入
  const browserEntries = entries as unknown as DocBrowserEntry[];

  if (loading) {
    return (
      <div style={{ height: '100vh', background: PAGE_BG, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <MapSectionLoader text="正在打开分享..." />
      </div>
    );
  }

  if (error || !view) {
    return (
      <div style={{ height: '100vh', background: PAGE_BG, fontFamily: SANS, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18 }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: 'rgba(239, 68, 68, 0.15)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <AlertCircle size={30} color="rgba(239, 68, 68, 0.9)" />
        </div>
        <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 15, margin: 0 }}>
          {error ?? '分享链接不存在或已撤销'}
        </p>
        <button
          onClick={() => navigate('/library')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)',
            fontSize: 13, cursor: 'pointer',
          }}
        >
          去智识殿堂逛逛 <ArrowRight size={14} />
        </button>
      </div>
    );
  }

  const store = view.store;
  const isSingleDoc = Boolean(view.entryId);
  const activeView = parseLibraryShareViewMode(viewFromUrl, isSingleDoc);
  const title = isSingleDoc ? (view.entryTitle ?? store.name) : (view.title || store.name);
  const desc = view.description || store.description;
  const hasMeta = Boolean(desc) || (!isSingleDoc && store.documentCount > 0) || store.viewCount > 0;

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: PAGE_BG, fontFamily: SANS }}>
      {/* 顶栏：深色玻璃 */}
      <div style={{
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        background: 'rgba(17, 17, 17, 0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <ShieldCheck size={14} color="rgba(34, 197, 94, 0.8)" style={{ flexShrink: 0 }} />
          {view.createdByName && (
            <span style={{ color: 'rgba(34, 197, 94, 0.9)', fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
              {view.createdByName}
            </span>
          )}
          <span style={{
            color: '#fff', fontSize: 14, fontWeight: 500,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0,
          }}>
            {view.createdByName ? `分享给你的「${title}」` : title}
          </span>
          <span
            className="hidden sm:inline-flex"
            style={{
              alignItems: 'center', gap: 4, flexShrink: 0,
              padding: '2px 8px', borderRadius: 999,
              background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.45)',
              fontSize: 11, fontWeight: 600,
            }}
          >
            {isSingleDoc ? <><FileText size={11} /> 单篇</> : <><BookOpen size={11} /> 知识库</>}
          </span>
        </div>
        {/* 分享页右上角一键回到知识库：常驻显示（2026-06-12 用户反馈"找不到回知识库的入口"——
            旧逻辑只在登录态渲染，未登录标签页里按钮整个消失，用户以为功能没了）。
            匿名点击会被路由守卫带去登录，文案如实说明，不藏入口。 */}
        <button
          onClick={() => navigate('/document-store')}
          style={{
            marginLeft: 'auto', flexShrink: 0,
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 12px', borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.85)',
            fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
          }}
          title={isAuthenticated ? '回到我的知识库' : '登录后进入我的知识库'}
        >
          <BookOpen size={14} /> {isAuthenticated ? '返回我的知识库' : '登录进入知识库'}
        </button>
      </div>

      {/* 简介条：低饱和度 */}
      {hasMeta && (
        <div style={{
          padding: '8px 16px',
          display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
          background: 'rgba(255,255,255,0.012)',
          borderBottom: '1px solid rgba(255,255,255,0.05)',
          flexShrink: 0,
          fontSize: 12,
          color: 'rgba(255,255,255,0.4)',
        }}>
          <BookOpen size={12} style={{ flexShrink: 0 }} />
          {desc && (
            <span style={{ color: 'rgba(255,255,255,0.55)', maxWidth: 640, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {desc}
            </span>
          )}
          {!isSingleDoc && <span>{store.documentCount} 篇文档</span>}
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Eye size={12} /> {store.viewCount} 次浏览
          </span>
        </div>
      )}

      {!isSingleDoc && (
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 16px',
            background: 'rgba(255,255,255,0.018)',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          <ShareModeButton active={activeView === 'read'} icon={<BookOpen size={13} />} label="阅读" onClick={() => setShareViewMode('read')} />
          <ShareModeButton active={activeView === 'galaxy'} icon={<Orbit size={13} />} label="知识星球" onClick={() => setShareViewMode('galaxy')} />
          <ShareModeButton active={activeView === 'universe'} icon={<Network size={13} />} label="Obsidian 双链图" onClick={() => setShareViewMode('universe')} />
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        {activeView === 'read' && (
          <DocBrowser
            entries={browserEntries}
            primaryEntryId={store.primaryEntryId}
            pinnedEntryIds={store.pinnedEntryIds ?? []}
            selectedEntryId={controlledSelectedEntryId}
            onSelectEntry={selectSharedEntry}
            loadContent={loadContent}
            sortMode={shareSortMode}
            sidebarHeader={
              <ReaderSortControl value={shareSortMode} onChange={setShareSortMode} />
            }
            inlineCommentShareToken={token ?? undefined}
          />
        )}
        {activeView === 'galaxy' && (
          <DocumentGalaxyView
            storeId={store.id}
            storeName={store.name}
            listEntries={listGalaxyEntries}
            loadGraph={loadShareGraph}
            loadContent={loadGalaxyContent}
            labelMode={galaxyLabelMode}
            onBack={() => setShareViewMode('read')}
            onToggleLabelMode={() => setGalaxyLabelMode((m) => (m === 'content' ? 'structural' : 'content'))}
          />
        )}
        {activeView === 'universe' && (
          <UniverseGraphPage
            storeIdOverride={store.id}
            storeNameOverride={store.name}
            loadGraph={() => loadShareGraph()}
            loadContent={loadGalaxyContent}
            onBack={() => setShareViewMode('read')}
            onOpenGalaxy={() => setShareViewMode('galaxy')}
          />
        )}
      </div>
    </div>
  );
}

function ReaderSortControl({ value, onChange }: { value: DocBrowserSortMode; onChange: (mode: DocBrowserSortMode) => void }) {
  const options: Array<{ mode: DocBrowserSortMode; label: string }> = [
    { mode: 'default', label: '书籍顺序' },
    { mode: 'created-desc', label: '最新创建' },
    { mode: 'updated-desc', label: '最近更新' },
  ];
  return (
    <div className="flex items-center gap-1 px-1" aria-label="文章排序">
      <span className="shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>排序</span>
      {options.map((option) => {
        const active = option.mode === value;
        return (
          <button
            key={option.mode}
            type="button"
            onClick={() => onChange(option.mode)}
            aria-pressed={active}
            className="shrink-0 rounded-[6px] px-2 py-1 text-[11px] transition-colors"
            style={active
              ? { background: 'rgba(59,130,246,0.18)', color: 'rgba(147,180,255,0.98)', fontWeight: 600 }
              : { color: 'var(--text-muted)' }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function ShareModeButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 12px',
        borderRadius: 8,
        border: active ? '1px solid rgba(129,140,248,0.55)' : '1px solid rgba(255,255,255,0.10)',
        background: active ? 'rgba(129,140,248,0.18)' : 'rgba(255,255,255,0.045)',
        color: active ? 'rgba(224,231,255,0.98)' : 'rgba(255,255,255,0.62)',
        fontSize: 12,
        fontWeight: 700,
        cursor: 'pointer',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export default LibraryShareViewPage;
