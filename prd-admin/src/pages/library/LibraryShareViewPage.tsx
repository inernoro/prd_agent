/**
 * LibraryShareViewPage — 知识库 / 单篇文档「分享链接」公开展示页
 *
 * 路径：/s/lib/:token （统一分享路由，对齐 /s/wp/、/s/skill/）
 *
 * 数据层走 main 的 token 门禁匿名端点（getDocStoreShareView / listDocStoreShareEntries /
 * getDocStoreShareEntryContent），可展示「私有库的分享」，支持两种范围：
 *   - 整库分享（entryId 为空）：文件树 + 全部文档只读浏览
 *   - 单篇分享（entryId 非空）：只展示那一篇
 *
 * 呈现采用极简深色风（对齐网页托管分享页 ShareViewPage 的观感）：
 *   #0a0a0a 深色壳 + 玻璃顶栏（作者 + 标题）+ 低饱和简介条 + 深色阅读器。
 * 全屏渲染，不依赖登录。
 */
import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowRight, ShieldCheck, BookOpen, AlertCircle, Eye, FileText } from 'lucide-react';
import { LibraryShareReader } from './LibraryShareReader';
import type { LibraryShareReaderPreview } from './LibraryShareReader';
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

  const [view, setView] = useState<DocStoreShareView | null>(null);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const loadContent = useCallback(async (entryId: string): Promise<LibraryShareReaderPreview | null> => {
    if (!token) return null;
    const res = await getDocStoreShareEntryContent(token, entryId);
    if (!res.success) return null;
    return {
      text: res.data.hasContent ? res.data.content : null,
      fileUrl: res.data.fileUrl,
      contentType: res.data.contentType,
    };
  }, [token]);

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
      {/* 顶栏：深色玻璃（借鉴网页托管 ShareViewPage） */}
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
      </div>

      {/* 简介条：低饱和度，不抢阅读 */}
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

      {/* 阅读器填满剩余高度（深色） */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <LibraryShareReader
          entries={entries}
          primaryEntryId={view.entryId ?? store.primaryEntryId}
          pinnedEntryIds={store.pinnedEntryIds ?? []}
          loadContent={loadContent}
        />
      </div>
    </div>
  );
}

export default LibraryShareViewPage;
