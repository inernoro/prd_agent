/**
 * LibraryStoreDetailPage — 公开知识库详情页（claymorphism 风格）
 *
 * 路径：/library/:storeId
 * 复用 DocBrowser 只读模式 + 顶部 claymorphism 互动按钮（点赞/收藏/分享）
 */
import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Heart,
  Star,
  Share2,
  Eye,
  BookOpen,
  Library,
} from 'lucide-react';
import { LibraryDocReader } from './LibraryDocReader';
import type { LibraryDocReaderPreview } from './LibraryDocReader';
import { ClayButton } from './ClayButton';
import {
  getPublicDocumentStore,
  listPublicStoreEntries,
  getPublicEntryContent,
  likeDocumentStore,
  unlikeDocumentStore,
  favoriteDocumentStore,
  unfavoriteDocumentStore,
} from '@/services';
import type { PublicStoreDetail, DocumentEntry } from '@/services/contracts/documentStore';
import { useAuthStore } from '@/stores/authStore';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';

/** 注入 Fredoka + Nunito 字体 */
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

export function LibraryStoreDetailPage() {
  const { storeId } = useParams<{ storeId: string }>();
  const navigate = useNavigate();
  const isLoggedIn = useAuthStore((s) => Boolean(s.token));
  useFredokaFonts();

  const [store, setStore] = useState<PublicStoreDetail | null>(null);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [interacting, setInteracting] = useState(false);

  useEffect(() => {
    if (!storeId) return;
    let mounted = true;
    setLoading(true);
    Promise.all([
      getPublicDocumentStore(storeId),
      listPublicStoreEntries(storeId),
    ]).then(([storeRes, entriesRes]) => {
      if (!mounted) return;
      if (storeRes.success) setStore(storeRes.data);
      if (entriesRes.success) setEntries(entriesRes.data.items);
      setLoading(false);
    });
    return () => { mounted = false; };
  }, [storeId]);

  const loadContent = useCallback(async (entryId: string): Promise<LibraryDocReaderPreview | null> => {
    const res = await getPublicEntryContent(entryId);
    if (!res.success) return null;
    return {
      text: res.data.hasContent ? res.data.content : null,
      fileUrl: res.data.fileUrl,
      contentType: res.data.contentType,
    };
  }, []);

  const handleLike = useCallback(async () => {
    if (!isLoggedIn) {
      toast.warning('请先登录', '登录后可以为作者点赞');
      return;
    }
    if (!store) return;
    setInteracting(true);
    const res = store.likedByMe
      ? await unlikeDocumentStore(store.id)
      : await likeDocumentStore(store.id);
    if (res.success) {
      setStore(prev => prev ? { ...prev, likedByMe: res.data.liked, likeCount: res.data.likeCount } : prev);
    }
    setInteracting(false);
  }, [store, isLoggedIn]);

  const handleFavorite = useCallback(async () => {
    if (!isLoggedIn) {
      toast.warning('请先登录', '登录后可以收藏知识库');
      return;
    }
    if (!store) return;
    setInteracting(true);
    const res = store.favoritedByMe
      ? await unfavoriteDocumentStore(store.id)
      : await favoriteDocumentStore(store.id);
    if (res.success) {
      setStore(prev => prev ? { ...prev, favoritedByMe: res.data.favorited, favoriteCount: res.data.favoriteCount } : prev);
    }
    setInteracting(false);
  }, [store, isLoggedIn]);

  const handleShare = useCallback(() => {
    if (!store) return;
    const url = `${window.location.origin}/library/${store.id}`;
    navigator.clipboard.writeText(url).then(() => {
      toast.success('链接已复制', '快去分享给朋友吧');
    });
  }, [store]);

  const bg = {
    // 纯奶油色背景（与 landing page 一致，无 gradient）
    background: '#FEF3C7',
    fontFamily: "'Nunito', system-ui, sans-serif",
    color: '#1E1B4B',
  } as const;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={bg}>
        <MapSectionLoader text="正在打开藏书阁..." />
      </div>
    );
  }

  if (!store) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-5" style={bg}>
        <div
          className="w-20 h-20 rounded-3xl flex items-center justify-center"
          style={{
            background: '#FEF3C7',
            border: '4px solid #1E1B4B',
            boxShadow: '6px 6px 0 #1E1B4B',
          }}
        >
          <BookOpen size={32} style={{ color: '#F59E0B' }} strokeWidth={2.5} />
        </div>
        <p className="text-[16px] font-semibold" style={{ color: '#64748B' }}>
          这间藏书阁尚未对外开放
        </p>
        <ClayButton size="md" variant="primary" onClick={() => navigate('/library')}>
          返回殿堂
        </ClayButton>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full overflow-y-auto" style={bg}>
      {/* 顶部悬浮 Navbar — 与 landing page 一致 */}
      <DetailNavbar
        storeName={store.name}
        onBack={() => navigate('/library')}
      />

      {/* Hero 头部 */}
      <section className="relative pt-32 pb-8 px-6">
        <div className="max-w-6xl mx-auto">
          <div
            className="p-8 rounded-[32px] relative"
            style={{
              background: '#FFFFFF',
              border: '4px solid #1E1B4B',
              boxShadow: '8px 8px 0 #1E1B4B',
            }}
          >
            <div className="flex flex-col md:flex-row items-start gap-6">
              {/* 大图标 */}
              <div
                className="w-24 h-24 rounded-3xl flex items-center justify-center flex-shrink-0"
                style={{
                  background: '#FEF3C7',
                  border: '4px solid #F59E0B',
                  boxShadow: '0 5px 0 #D97706',
                }}
              >
                <Library size={42} style={{ color: '#D97706' }} strokeWidth={2.5} />
              </div>

              {/* 文字 */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  <span
                    className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-bold"
                    style={{
                      background: '#D1FAE5',
                      border: '2.5px solid #10B981',
                      boxShadow: '0 2px 0 #059669',
                      color: '#064E3B',
                    }}
                  >
                    KNOWLEDGE BASE
                  </span>
                  <span
                    className="text-[12px] font-bold"
                    style={{ color: '#64748B' }}
                  >
                    · {store.documentCount} 篇文档
                  </span>
                </div>
                <h1
                  className="text-[36px] md:text-[48px] font-bold leading-tight mb-3"
                  style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
                >
                  {store.name}
                </h1>
                {store.description && (
                  <p className="text-[15px] mb-5 max-w-3xl font-medium" style={{ color: '#475569', lineHeight: 1.6 }}>
                    {store.description}
                  </p>
                )}
                {/* 作者 + 元数据 */}
                <div className="flex items-center gap-4 flex-wrap text-[12px] font-semibold" style={{ color: '#64748B' }}>
                  <span className="flex items-center gap-2">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-[12px] font-bold"
                      style={{
                        background: '#FCE7F3',
                        border: '2px solid #EC4899',
                        color: '#831843',
                      }}
                    >
                      {store.ownerName.charAt(0)}
                    </div>
                    <span style={{ color: '#1E1B4B' }}>{store.ownerName}</span>
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Eye size={13} strokeWidth={2.8} /> {store.viewCount} 次浏览
                  </span>
                  <span>{new Date(store.updatedAt).toLocaleDateString()} 更新</span>
                </div>
              </div>

              {/* 互动按钮组 */}
              <div className="flex items-center gap-3 flex-wrap flex-shrink-0">
                <InteractionButton
                  active={store.likedByMe}
                  count={store.likeCount}
                  icon={Heart}
                  activeColor="#EC4899"
                  activeShadow="#DB2777"
                  onClick={handleLike}
                  disabled={interacting}
                />
                <InteractionButton
                  active={store.favoritedByMe}
                  count={store.favoriteCount}
                  icon={Star}
                  activeColor="#F59E0B"
                  activeShadow="#D97706"
                  onClick={handleFavorite}
                  disabled={interacting}
                />
                <button
                  onClick={handleShare}
                  className="rounded-2xl flex items-center justify-center transition-all hover:-translate-y-0.5 cursor-pointer"
                  style={{
                    padding: '12px 24px',
                    fontSize: 14,
                    fontWeight: 900,
                    gap: 8,
                    background: '#A855F7',
                    border: '3px solid #1E1B4B',
                    boxShadow: '0 4px 0 #1E1B4B',
                    color: '#FFFFFF',
                    fontFamily: "'Nunito', sans-serif",
                    lineHeight: 1,
                  }}
                >
                  <Share2 size={15} strokeWidth={2.8} />
                  分享
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 文档阅读器 — 专属 claymorphism LibraryDocReader */}
      <section className="relative px-6 pb-16">
        <div className="max-w-6xl mx-auto" style={{ height: 'calc(100vh - 320px)', minHeight: 560 }}>
          <LibraryDocReader
            entries={entries}
            primaryEntryId={store.primaryEntryId}
            pinnedEntryIds={store.pinnedEntryIds ?? []}
            loadContent={loadContent}
          />
        </div>
      </section>
    </div>
  );
}

// ── 顶部悬浮 Navbar（详情页版本） ──
function DetailNavbar({
  storeName,
  onBack,
}: {
  storeName: string;
  onBack: () => void;
}) {
  return (
    <nav
      className="z-50 px-4 md:px-6"
      style={{
        position: 'fixed',
        top: 24,
        left: 0,
        right: 0,
      }}
    >
      <div
        className="max-w-6xl mx-auto rounded-[28px] px-5 md:px-6 py-3 flex items-center justify-between gap-4"
        style={{
          background: '#FFFFFF',
          border: '4px solid #1E1B4B',
          boxShadow: '0 6px 0 #1E1B4B',
        }}
      >
        <button
          onClick={onBack}
          className="flex items-center gap-3 cursor-pointer hover:-translate-y-0.5 transition-transform"
        >
          <div
            className="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0"
            style={{
              background: '#FECACA',
              border: '3px solid #1E1B4B',
              boxShadow: '0 3px 0 #1E1B4B',
            }}
          >
            <BookOpen size={20} style={{ color: '#DC2626' }} strokeWidth={2.8} />
          </div>
          <span
            className="text-[18px] md:text-[20px] font-black hidden sm:inline"
            style={{ fontFamily: "'Fredoka', sans-serif", color: '#1E1B4B' }}
          >
            智识殿堂
          </span>
        </button>

        <div
          className="flex-1 text-center text-[13px] md:text-[14px] font-bold truncate hidden md:block"
          style={{ color: '#64748B' }}
        >
          正在阅读 · <span style={{ color: '#1E1B4B' }}>{storeName}</span>
        </div>

        <ClayButton size="md" variant="secondary" onClick={onBack}>
          <ArrowLeft size={14} strokeWidth={3} />
          返回殿堂
        </ClayButton>
      </div>
    </nav>
  );
}

function InteractionButton({
  active,
  count,
  icon: Icon,
  activeColor,
  activeShadow,
  onClick,
  disabled,
}: {
  active: boolean;
  count: number;
  icon: typeof Heart;
  activeColor: string;
  activeShadow: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="h-12 px-5 rounded-2xl flex items-center gap-2 cursor-pointer transition-all active:translate-y-1 text-[13px] font-bold disabled:opacity-70"
      style={{
        background: active ? activeColor : '#FFFFFF',
        border: `3px solid ${active ? activeShadow : '#1E1B4B'}`,
        boxShadow: `0 4px 0 ${active ? activeShadow : '#1E1B4B'}`,
        color: active ? '#FFFFFF' : '#1E1B4B',
      }}
    >
      {disabled ? (
        <MapSpinner size={14} color={active ? '#FFFFFF' : '#1E1B4B'} />
      ) : (
        <Icon size={15} strokeWidth={2.8} fill={active ? '#FFFFFF' : 'none'} />
      )}
      {count}
    </button>
  );
}
