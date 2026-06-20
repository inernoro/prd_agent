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
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, ShieldCheck, BookOpen, AlertCircle, Eye, FileText } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { DocBrowser } from '@/components/doc-browser/DocBrowser';
import type { DocBrowserEntry, EntryPreview } from '@/components/doc-browser/DocBrowser';
import {
  getDocStoreShareView,
  listDocStoreShareEntries,
  getDocStoreShareEntryContent,
} from '@/services';
import type { DocStoreShareView, DocumentEntry } from '@/services/contracts/documentStore';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

const PAGE_BG = '#0a0a0a';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

export function LibraryShareViewPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [searchParams] = useSearchParams();
  // URL ?entry={id} 优先级最高：归档脚本/外部链接可指定一打开就高亮某篇
  const entryFromUrl = searchParams.get('entry');

  const [view, setView] = useState<DocStoreShareView | null>(null);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>(undefined);

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

  // 默认选中：URL ?entry= > 单篇分享 entryId > 最新创建的非 folder > primaryEntryId > 第一个非 folder
  // 「最新创建」放在 primaryEntryId 之前：分享场景下"刚归档的新报告"是最常见的查看目标，
  // 让分享对象一打开就看到最新内容，不用先在目录里翻。
  const initialSelectedId = useMemo<string | undefined>(() => {
    if (!view || entries.length === 0) return undefined;
    if (entryFromUrl && entries.some((e) => e.id === entryFromUrl)) return entryFromUrl;
    if (view.entryId) return view.entryId;
    const docs = entries.filter((e) => !e.isFolder);
    if (docs.length === 0) return undefined;
    const newest = docs.reduce((best, e) => {
      const t = e.createdAt ? new Date(e.createdAt).getTime() : 0;
      const bt = best.createdAt ? new Date(best.createdAt).getTime() : 0;
      return t > bt ? e : best;
    }, docs[0]);
    if (newest) return newest.id;
    if (view.store.primaryEntryId && docs.some((e) => e.id === view.store.primaryEntryId)) {
      return view.store.primaryEntryId;
    }
    return docs[0]?.id;
  }, [view, entries, entryFromUrl]);

  useEffect(() => {
    if (initialSelectedId && !selectedEntryId) setSelectedEntryId(initialSelectedId);
  }, [initialSelectedId, selectedEntryId]);

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

      {/* 阅读器：直接复用 DocBrowser。
          只读模式 = 不传任何 onXxx 写操作 callback，按钮自动隐藏。 */}
      <div className="flex-1 min-h-0 flex flex-col">
        <DocBrowser
          entries={browserEntries}
          primaryEntryId={store.primaryEntryId}
          pinnedEntryIds={store.pinnedEntryIds ?? []}
          selectedEntryId={selectedEntryId}
          onSelectEntry={setSelectedEntryId}
          loadContent={loadContent}
          sortMode="created-desc"
          inlineCommentShareToken={token ?? undefined}
        />
      </div>
    </div>
  );
}

export default LibraryShareViewPage;
