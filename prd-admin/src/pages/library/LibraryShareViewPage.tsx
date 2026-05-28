/**
 * LibraryShareViewPage — 知识库 / 单篇文档「分享链接」公开展示页
 *
 * 路径：/s/lib/:token （统一分享路由，对齐 /s/wp/、/s/skill/）
 *
 * 与 LibraryStoreDetailPage 同源（复用 LibraryDocReader + claymorphism 外壳），
 * 区别在于数据走 token 门禁的匿名端点，可展示「私有库的分享」，且支持两种范围：
 *   - 整库分享（entryId 为空）：文件树 + 全部文档只读浏览
 *   - 单篇分享（entryId 非空）：只展示那一篇
 * 全屏渲染，不依赖登录。
 */
import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { BookOpen, Eye, Library, FileText, AlertCircle } from 'lucide-react';
import { LibraryDocReader } from './LibraryDocReader';
import type { LibraryDocReaderPreview } from './LibraryDocReader';
import {
  getDocStoreShareView,
  listDocStoreShareEntries,
  getDocStoreShareEntryContent,
} from '@/services';
import type { DocStoreShareView, DocumentEntry } from '@/services/contracts/documentStore';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

function useFredokaFonts() {
  useEffect(() => {
    const id = 'library-claymorphism-fonts';
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(link);
  }, []);
}

const BG = {
  background: '#FEF3C7',
  fontFamily: "'Nunito', system-ui, sans-serif",
  color: '#1E1B4B',
} as const;

export function LibraryShareViewPage() {
  const { token } = useParams<{ token: string }>();
  useFredokaFonts();

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

  const loadContent = useCallback(async (entryId: string): Promise<LibraryDocReaderPreview | null> => {
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
      <div className="min-h-screen flex items-center justify-center" style={BG}>
        <MapSectionLoader text="正在打开分享..." />
      </div>
    );
  }

  if (error || !view) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-5 px-6 text-center" style={BG}>
        <div
          className="w-20 h-20 rounded-3xl flex items-center justify-center"
          style={{ background: '#FEF3C7', border: '4px solid #1E1B4B', boxShadow: '6px 6px 0 #1E1B4B' }}
        >
          <AlertCircle size={32} style={{ color: '#DC2626' }} strokeWidth={2.5} />
        </div>
        <p className="text-[16px] font-semibold" style={{ color: '#64748B' }}>
          {error ?? '分享链接不存在或已撤销'}
        </p>
      </div>
    );
  }

  const isSingleDoc = Boolean(view.entryId);
  const headerTitle = isSingleDoc ? (view.entryTitle ?? view.store.name) : view.store.name;

  return (
    <div className="min-h-screen w-full overflow-y-auto" style={BG}>
      {/* 顶部悬浮 Navbar */}
      <nav className="z-50 px-4 md:px-6" style={{ position: 'fixed', top: 24, left: 0, right: 0 }}>
        <div
          className="max-w-6xl mx-auto rounded-[28px] px-5 md:px-6 py-3 flex items-center gap-4"
          style={{ background: '#FFFFFF', border: '4px solid #1E1B4B', boxShadow: '0 6px 0 #1E1B4B' }}
        >
          <div
            className="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{ background: '#FECACA', border: '3px solid #1E1B4B', boxShadow: '0 3px 0 #1E1B4B' }}
          >
            <BookOpen size={20} style={{ color: '#DC2626' }} strokeWidth={2.8} />
          </div>
          <span
            className="text-[18px] md:text-[20px] font-black hidden sm:inline"
            style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
          >
            知识库 · 分享
          </span>
          <span
            className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-bold flex-shrink-0"
            style={{ background: '#FEF3C7', border: '2px solid #D97706', color: '#78350F' }}
            title="本页是点对点分享，不是殿堂；只有持此链接者可看"
          >
            私有分享 · 仅持链接者可看
          </span>
          <div
            className="flex-1 text-center text-[13px] md:text-[14px] font-bold truncate hidden md:block"
            style={{ color: '#64748B' }}
          >
            分享 · <span style={{ color: '#1E1B4B' }}>{headerTitle}</span>
          </div>
        </div>
      </nav>

      {/* Hero 头部 */}
      <section className="relative pt-32 pb-8 px-6">
        <div className="max-w-6xl mx-auto">
          <div
            className="p-8 rounded-[32px] relative"
            style={{ background: '#FFFFFF', border: '4px solid #1E1B4B', boxShadow: '8px 8px 0 #1E1B4B' }}
          >
            <div className="flex flex-col md:flex-row items-start gap-6">
              <div
                className="w-24 h-24 rounded-3xl flex items-center justify-center flex-shrink-0"
                style={{ background: '#FEF3C7', border: '4px solid #F59E0B', boxShadow: '0 5px 0 #D97706' }}
              >
                {isSingleDoc
                  ? <FileText size={42} style={{ color: '#D97706' }} strokeWidth={2.5} />
                  : <Library size={42} style={{ color: '#D97706' }} strokeWidth={2.5} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span
                    className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-bold"
                    style={{ background: '#D1FAE5', border: '2.5px solid #10B981', boxShadow: '0 2px 0 #059669', color: '#064E3B' }}
                  >
                    {isSingleDoc ? 'SHARED DOCUMENT' : 'SHARED LIBRARY'}
                  </span>
                  {!isSingleDoc && (
                    <span className="text-[12px] font-bold" style={{ color: '#64748B' }}>
                      · {view.store.documentCount} 篇文档
                    </span>
                  )}
                </div>
                <h1
                  className="text-[32px] md:text-[44px] font-bold leading-tight mb-3"
                  style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
                >
                  {headerTitle}
                </h1>
                {view.description && (
                  <p className="text-[15px] mb-5 max-w-3xl font-medium" style={{ color: '#475569', lineHeight: 1.6 }}>
                    {view.description}
                  </p>
                )}
                <div className="flex items-center gap-4 flex-wrap text-[12px] font-semibold" style={{ color: '#64748B' }}>
                  {view.createdByName && (
                    <span className="flex items-center gap-2">
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold"
                        style={{ background: '#FCE7F3', border: '2px solid #EC4899', color: '#831843' }}
                      >
                        {view.createdByName.charAt(0)}
                      </div>
                      <span style={{ color: '#1E1B4B' }}>{view.createdByName}</span>
                    </span>
                  )}
                  <span className="flex items-center gap-1.5">
                    <Eye size={13} strokeWidth={2.8} /> {view.store.viewCount} 次浏览
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 文档阅读器 */}
      <section className="relative px-6 pb-16">
        <div className="max-w-6xl mx-auto" style={{ height: 'calc(100vh - 320px)', minHeight: 560 }}>
          <LibraryDocReader
            entries={entries}
            primaryEntryId={view.entryId ?? view.store.primaryEntryId}
            pinnedEntryIds={view.store.pinnedEntryIds ?? []}
            loadContent={loadContent}
          />
        </div>
      </section>
    </div>
  );
}

export default LibraryShareViewPage;
