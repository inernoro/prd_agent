import { useEffect, useState } from 'react';
import { Eye, BookOpen } from 'lucide-react';
import { resolveAvatarUrl, DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';
import { HeartLikeButton } from '@/components/effects/HeartLikeButton';
import type { SubmissionItem } from '@/services/real/submissions';

interface LiteraryCardProps {
  item: SubmissionItem;
  onLikeToggle?: (id: string, liked: boolean) => Promise<void>;
  onClick?: () => void;
}

/**
 * 文学创作卡片 — NotebookLM 风格
 * 封面图全覆盖 + 底部渐变遮罩 + 文字叠加
 * 无封面图时使用文学主题渐变作为默认背景
 */

/* 无封面图时的默认渐变背景 — 6 种文学主题配色循环使用 */
const FALLBACK_GRADIENTS = [
  'linear-gradient(135deg, #1a1a2e 0%, #16213e 40%, #0f3460 100%)',
  'linear-gradient(135deg, #2d1b69 0%, #11998e 100%)',
  'linear-gradient(135deg, #1f1c2c 0%, #928dab 100%)',
  'linear-gradient(135deg, #0f2027 0%, #203a43 40%, #2c5364 100%)',
  'linear-gradient(135deg, #1a002e 0%, #3d1f5c 50%, #5c3d7a 100%)',
  'linear-gradient(135deg, #141e30 0%, #243b55 100%)',
];

function getFallbackGradient(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  return FALLBACK_GRADIENTS[Math.abs(hash) % FALLBACK_GRADIENTS.length];
}

export function LiteraryCard({ item, onLikeToggle, onClick }: LiteraryCardProps) {
  const [liked, setLiked] = useState(item.likedByMe);
  const [likeCount, setLikeCount] = useState(item.likeCount);
  const [liking, setLiking] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => { setLiked(item.likedByMe); }, [item.likedByMe]);
  useEffect(() => { setLikeCount(item.likeCount); }, [item.likeCount]);

  const avatarUrl = resolveAvatarUrl({ avatarFileName: item.ownerAvatarFileName });
  const hasCover = !!item.coverUrl && !imgError;

  const handleLike = async () => {
    if (liking) return;
    setLiking(true);
    const newLiked = !liked;
    setLiked(newLiked);
    setLikeCount((c) => c + (newLiked ? 1 : -1));
    try {
      await onLikeToggle?.(item.id, newLiked);
    } catch {
      setLiked(!newLiked);
      setLikeCount((c) => c + (newLiked ? -1 : 1));
    } finally {
      setLiking(false);
    }
  };

  return (
    <div
      className="group cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
    >
      {/* 卡片主体 — 图片全覆盖，文字叠加在底部 */}
      <div
        className="relative w-full overflow-hidden rounded-2xl transition-all duration-300 group-hover:shadow-xl group-hover:shadow-black/30 group-hover:scale-[1.02]"
        style={{
          aspectRatio: '4/5',
          background: hasCover ? '#0a0a0f' : getFallbackGradient(item.id),
        }}
      >
        {/* 封面图 — 全覆盖 */}
        {item.coverUrl && !imgError && (
          <img
            src={item.coverUrl}
            alt={item.title}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.06]"
            style={{ opacity: imgLoaded ? 1 : 0, transition: 'opacity 0.5s ease' }}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => setImgError(true)}
          />
        )}

        {/* 无封面图时的装饰元素 — 大引号 */}
        {!hasCover && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none">
            <span
              className="text-[120px] font-serif leading-none"
              style={{ color: 'rgba(255,255,255,0.04)' }}
            >
              "
            </span>
          </div>
        )}

        {/* 底部渐变遮罩 — 保证文字可读性 */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: hasCover
              ? 'linear-gradient(180deg, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.15) 40%, rgba(0,0,0,0.75) 100%)'
              : 'linear-gradient(180deg, transparent 30%, rgba(0,0,0,0.4) 100%)',
          }}
        />

        {/* 内容层 — 全部叠在图片上方 */}
        <div className="absolute inset-0 z-10 flex flex-col justify-between p-4">
          {/* 顶部：来源 badge（类似 NotebookLM 的 source icon + name） */}
          <div className="flex items-center gap-2">
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full backdrop-blur-md"
              style={{
                background: 'rgba(0,0,0,0.35)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              <BookOpen size={12} style={{ color: 'rgba(165,180,252,0.9)' }} />
              <span className="text-[11px] font-medium" style={{ color: 'rgba(255,255,255,0.85)' }}>
                文学创作
              </span>
            </div>
          </div>

          {/* 底部：标题 + 作者信息 */}
          <div className="flex flex-col gap-2">
            {/* 标题 — 大号加粗，NotebookLM 风格 */}
            <h3
              className="text-[17px] font-bold leading-tight line-clamp-2 drop-shadow-lg"
              style={{ color: '#fff', textShadow: '0 1px 8px rgba(0,0,0,0.5)' }}
            >
              {item.title || '未命名'}
            </h3>

            {/* 作者 + 统计 */}
            <div className="flex items-center gap-2">
              <img
                src={avatarUrl}
                alt={item.ownerUserName}
                className="w-5 h-5 rounded-full shrink-0 object-cover ring-1 ring-white/20"
                onError={(e) => { (e.target as HTMLImageElement).src = DEFAULT_AVATAR_FALLBACK; }}
              />
              <span
                className="text-[11px] font-medium truncate flex-1 drop-shadow"
                style={{ color: 'rgba(255,255,255,0.8)' }}
              >
                {item.ownerUserName}
              </span>

              <div className="flex items-center gap-2 shrink-0">
                {item.viewCount > 0 && (
                  <span
                    className="flex items-center gap-0.5 text-[10px] drop-shadow"
                    style={{ color: 'rgba(255,255,255,0.6)' }}
                  >
                    <Eye size={10} />
                    {item.viewCount >= 10000
                      ? `${(item.viewCount / 10000).toFixed(1)}万`
                      : item.viewCount}
                  </span>
                )}
                <div
                  className="flex items-center gap-0.5"
                  style={{ color: liked ? '#F43F5E' : 'rgba(255,255,255,0.5)' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <HeartLikeButton
                    size={20}
                    liked={liked}
                    heartColor="#F43F5E"
                    disabled={liking}
                    onClick={handleLike}
                  />
                  {likeCount > 0 && <span className="text-[10px] drop-shadow">{likeCount}</span>}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
