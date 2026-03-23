import { useEffect, useState } from 'react';
import { BookOpen, Eye } from 'lucide-react';
import { resolveAvatarUrl, DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';
import { HeartLikeButton } from '@/components/effects/HeartLikeButton';
import type { SubmissionItem } from '@/services/real/submissions';

interface LiteraryCardProps {
  item: SubmissionItem;
  onLikeToggle?: (id: string, liked: boolean) => Promise<void>;
  onClick?: () => void;
}

/**
 * 文学创作专属卡片 — 以文字内容为核心的展示风格
 * 固定 4:3 宽高比，半透明玻璃背景 + 大标题 + 正文摘要
 */
export function LiteraryCard({ item, onLikeToggle, onClick }: LiteraryCardProps) {
  const [liked, setLiked] = useState(item.likedByMe);
  const [likeCount, setLikeCount] = useState(item.likeCount);
  const [liking, setLiking] = useState(false);

  useEffect(() => { setLiked(item.likedByMe); }, [item.likedByMe]);
  useEffect(() => { setLikeCount(item.likeCount); }, [item.likeCount]);

  const avatarUrl = resolveAvatarUrl({ avatarFileName: item.ownerAvatarFileName });

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

  // 用 prompt 字段作为摘要（后端已截取前 200 字）
  const excerpt = item.prompt || '';

  return (
    <div
      className="group cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
    >
      {/* 卡片主体 — 固定宽高比，玻璃质感 */}
      <div
        className="relative w-full overflow-hidden rounded-2xl transition-all duration-300 group-hover:shadow-lg group-hover:shadow-indigo-500/10"
        style={{
          aspectRatio: '4/3',
          background: 'linear-gradient(145deg, rgba(99,102,241,0.08) 0%, rgba(168,85,247,0.05) 50%, rgba(30,30,40,0.9) 100%)',
          border: '1px solid rgba(99,102,241,0.12)',
        }}
      >
        {/* 背景封面图（如有），低透明度作氛围 */}
        {item.coverUrl && (
          <img
            src={item.coverUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-[1.05]"
            style={{ opacity: 0.12, filter: 'blur(8px)' }}
            loading="lazy"
          />
        )}

        {/* 内容层 */}
        <div className="relative z-10 flex flex-col h-full p-3.5">
          {/* 类型标签 */}
          <div className="flex items-center gap-1.5 mb-2">
            <BookOpen size={11} style={{ color: 'rgba(165,180,252,0.7)' }} />
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
              style={{
                color: 'rgba(165,180,252,0.8)',
                background: 'rgba(99,102,241,0.12)',
                border: '1px solid rgba(99,102,241,0.15)',
              }}
            >
              文学创作
            </span>
          </div>

          {/* 标题 */}
          <h3
            className="text-[14px] font-semibold leading-snug line-clamp-2 mb-1.5"
            style={{ color: 'rgba(255,255,255,0.92)' }}
          >
            {item.title || '未命名'}
          </h3>

          {/* 摘要 */}
          {excerpt && (
            <p
              className="text-[11px] leading-relaxed line-clamp-3 flex-1 min-h-0"
              style={{ color: 'rgba(255,255,255,0.45)' }}
            >
              {excerpt}
            </p>
          )}
          {!excerpt && <div className="flex-1" />}

          {/* 底部分隔线 */}
          <div
            className="mt-auto pt-2"
            style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            {/* 作者信息 + 互动 */}
            <div className="flex items-center gap-2">
              <img
                src={avatarUrl}
                alt={item.ownerUserName}
                className="w-5 h-5 rounded-full shrink-0 object-cover ring-1 ring-white/10"
                onError={(e) => {
                  (e.target as HTMLImageElement).src = DEFAULT_AVATAR_FALLBACK;
                }}
              />
              <span
                className="text-[11px] font-medium truncate flex-1"
                style={{ color: 'rgba(255,255,255,0.55)' }}
              >
                {item.ownerUserName}
              </span>

              <div className="flex items-center gap-2 shrink-0">
                {item.viewCount > 0 && (
                  <span
                    className="flex items-center gap-0.5 text-[10px]"
                    style={{ color: 'rgba(255,255,255,0.35)' }}
                  >
                    <Eye size={10} />
                    {item.viewCount >= 10000
                      ? `${(item.viewCount / 10000).toFixed(1)}万`
                      : item.viewCount}
                  </span>
                )}
                <div
                  className="flex items-center gap-0.5"
                  style={{ color: liked ? '#F43F5E' : 'rgba(255,255,255,0.25)' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <HeartLikeButton
                    size={20}
                    liked={liked}
                    heartColor="#F43F5E"
                    disabled={liking}
                    onClick={handleLike}
                  />
                  {likeCount > 0 && <span className="text-[10px]">{likeCount}</span>}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
