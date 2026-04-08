/**
 * LibraryStoreDetailPage — 公开知识库详情页
 *
 * 路径：/library/:storeId
 * 复用 DocBrowser 展示文件树 + 内容预览，但隐藏所有写操作（编辑、删除、移动、新建）。
 * 顶部增加：作者信息 + 点赞 / 收藏 / 分享 按钮。
 */
import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Heart, Star, Share2, Eye, BookOpen, Library, Loader2 } from 'lucide-react';
import { DocBrowser } from '@/components/doc-browser/DocBrowser';
import type { EntryPreview } from '@/components/doc-browser/DocBrowser';
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
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';

export function LibraryStoreDetailPage() {
  const { storeId } = useParams<{ storeId: string }>();
  const navigate = useNavigate();
  const isLoggedIn = useAuthStore((s) => Boolean(s.token));

  const [store, setStore] = useState<PublicStoreDetail | null>(null);
  const [entries, setEntries] = useState<DocumentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEntryId, setSelectedEntryId] = useState<string | undefined>(undefined);
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

  const loadContent = useCallback(async (entryId: string): Promise<EntryPreview | null> => {
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

  if (loading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{
          background: 'linear-gradient(180deg, #0a0a14 0%, #0f0f1a 100%)',
        }}
      >
        <MapSectionLoader text="正在打开藏书阁..." />
      </div>
    );
  }

  if (!store) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center gap-4"
        style={{ background: 'linear-gradient(180deg, #0a0a14 0%, #0f0f1a 100%)' }}
      >
        <BookOpen size={48} style={{ color: 'rgba(255,255,255,0.2)' }} />
        <p className="text-[14px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
          这间藏书阁尚未对外开放
        </p>
        <button
          onClick={() => navigate('/library')}
          className="px-5 py-2.5 rounded-full text-[13px] font-semibold cursor-pointer"
          style={{
            background: 'rgba(168,85,247,0.15)',
            border: '1px solid rgba(168,85,247,0.3)',
            color: 'rgba(255,255,255,0.9)',
          }}
        >
          返回殿堂
        </button>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen w-full overflow-y-auto"
      style={{
        background:
          'radial-gradient(ellipse at 20% 0%, rgba(168,85,247,0.08) 0%, transparent 50%),' +
          'radial-gradient(ellipse at 80% 30%, rgba(59,130,246,0.06) 0%, transparent 50%),' +
          'linear-gradient(180deg, #0a0a14 0%, #0f0f1a 100%)',
      }}
    >
      {/* 返回按钮 */}
      <button
        onClick={() => navigate('/library')}
        className="fixed top-6 left-6 z-50 w-10 h-10 rounded-full flex items-center justify-center cursor-pointer transition-all hover:scale-110 backdrop-blur-xl"
        style={{
          background: 'rgba(255,255,255,0.06)',
          border: '1px solid rgba(255,255,255,0.1)',
          color: 'rgba(255,255,255,0.9)',
        }}
        title="返回殿堂"
      >
        <ArrowLeft size={18} />
      </button>

      {/* Hero 头部 */}
      <section className="relative pt-24 pb-10 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row items-start gap-8">
            {/* 大图标 */}
            <div className="w-24 h-24 rounded-[28px] flex items-center justify-center flex-shrink-0"
              style={{
                background: 'linear-gradient(135deg, rgba(168,85,247,0.2), rgba(59,130,246,0.2))',
                border: '1px solid rgba(168,85,247,0.3)',
                boxShadow: '0 12px 32px rgba(168,85,247,0.2)',
              }}>
              <Library size={36} style={{ color: 'rgba(168,85,247,0.95)' }} />
            </div>

            {/* 文字信息 */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[11px] font-semibold tracking-wider px-2 py-0.5 rounded-full"
                  style={{
                    background: 'rgba(168,85,247,0.15)',
                    border: '1px solid rgba(168,85,247,0.3)',
                    color: 'rgba(216,180,254,0.9)',
                  }}>
                  KNOWLEDGE BASE
                </span>
                <span className="text-[11px]" style={{ color: 'rgba(255,255,255,0.4)' }}>
                  · {store.documentCount} 篇文档
                </span>
              </div>
              <h1 className="text-[36px] md:text-[44px] font-black leading-tight mb-3"
                style={{ color: 'rgba(255,255,255,0.95)' }}>
                {store.name}
              </h1>
              {store.description && (
                <p className="text-[15px] mb-5 max-w-3xl" style={{ color: 'rgba(255,255,255,0.6)' }}>
                  {store.description}
                </p>
              )}
              {/* 作者 + 统计 */}
              <div className="flex items-center gap-4 flex-wrap text-[12px]" style={{ color: 'rgba(255,255,255,0.5)' }}>
                <span className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold"
                    style={{ background: 'rgba(168,85,247,0.2)', color: 'rgba(216,180,254,0.95)' }}>
                    {store.ownerName.charAt(0)}
                  </div>
                  {store.ownerName}
                </span>
                <span className="flex items-center gap-1.5">
                  <Eye size={12} />
                  {store.viewCount} 次浏览
                </span>
                <span>
                  {new Date(store.updatedAt).toLocaleDateString()} 更新
                </span>
              </div>
            </div>

            {/* 互动按钮 */}
            <div className="flex items-center gap-2 flex-shrink-0">
              <InteractionButton
                active={store.likedByMe}
                count={store.likeCount}
                icon={Heart}
                activeColor="rgba(244,63,94,0.95)"
                label="点赞"
                onClick={handleLike}
                disabled={interacting}
              />
              <InteractionButton
                active={store.favoritedByMe}
                count={store.favoriteCount}
                icon={Star}
                activeColor="rgba(234,179,8,0.95)"
                label="收藏"
                onClick={handleFavorite}
                disabled={interacting}
              />
              <button
                onClick={handleShare}
                className="h-10 px-4 rounded-full flex items-center gap-2 cursor-pointer transition-all hover:scale-105 text-[12px] font-semibold"
                style={{
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'rgba(255,255,255,0.9)',
                  backdropFilter: 'blur(20px)',
                }}
              >
                <Share2 size={14} />
                分享
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* 文档浏览器 */}
      <section className="relative px-6 pb-16">
        <div className="max-w-6xl mx-auto h-[calc(100vh-280px)] min-h-[500px]">
          <DocBrowser
            entries={entries}
            primaryEntryId={store.primaryEntryId}
            pinnedEntryIds={store.pinnedEntryIds ?? []}
            selectedEntryId={selectedEntryId}
            onSelectEntry={setSelectedEntryId}
            loadContent={loadContent}
            // 公开页只读，不传任何写操作回调
            loading={false}
          />
        </div>
      </section>
    </div>
  );
}

function InteractionButton({
  active,
  count,
  icon: Icon,
  activeColor,
  onClick,
  disabled,
}: {
  active: boolean;
  count: number;
  icon: typeof Heart;
  activeColor: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="h-10 px-4 rounded-full flex items-center gap-2 cursor-pointer transition-all hover:scale-105 text-[12px] font-semibold"
      style={{
        background: active
          ? `${activeColor.replace('0.95', '0.15')}`
          : 'rgba(255,255,255,0.06)',
        border: active
          ? `1px solid ${activeColor.replace('0.95', '0.4')}`
          : '1px solid rgba(255,255,255,0.12)',
        color: active ? activeColor : 'rgba(255,255,255,0.9)',
        backdropFilter: 'blur(20px)',
      }}
    >
      {disabled ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} fill={active ? activeColor : 'none'} />}
      {count}
    </button>
  );
}
