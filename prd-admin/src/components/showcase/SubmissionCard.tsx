import { useEffect, useState } from 'react';
import { Eye, ImageOff } from 'lucide-react';
import { resolveAvatarUrl, DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';
import { HeartLikeButton } from '@/components/effects/HeartLikeButton';
import type { SubmissionItem } from '@/services/real/submissions';

interface SubmissionCardProps {
  item: SubmissionItem;
  onLikeToggle?: (id: string, liked: boolean) => Promise<void>;
  onClick?: () => void;
}

export function SubmissionCard({ item, onLikeToggle, onClick }: SubmissionCardProps) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [liked, setLiked] = useState(item.likedByMe);
  const [likeCount, setLikeCount] = useState(item.likeCount);
  const [liking, setLiking] = useState(false);

  useEffect(() => { setLiked(item.likedByMe); }, [item.likedByMe]);
  useEffect(() => { setLikeCount(item.likeCount); }, [item.likeCount]);

  const avatarUrl = resolveAvatarUrl({ avatarFileName: item.ownerAvatarFileName });

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
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
      style={{  }}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } }}
    >
      {/* Image container — rounded, no card border */}
      <div className="relative w-full overflow-hidden rounded-2xl transition-all duration-300 group-hover:shadow-lg group-hover:shadow-black/20">
        {!imgLoaded && !imgError && (
          <div
            className="w-full animate-pulse rounded-2xl"
            style={{
              aspectRatio: item.coverWidth && item.coverHeight
                ? `${item.coverWidth}/${item.coverHeight}`
                : '3/4',
              background: 'rgba(255,255,255,0.04)',
              minHeight: 160,
            }}
          />
        )}
        {imgError && (
          <div
            className="w-full flex items-center justify-center rounded-2xl"
            style={{
              aspectRatio: '3/4',
              background: 'rgba(255,255,255,0.03)',
              minHeight: 160,
            }}
          >
            <ImageOff size={28} style={{ color: 'var(--text-muted, rgba(255,255,255,0.12))' }} />
          </div>
        )}
        {item.coverUrl && !imgError && (
          <img
            src={item.coverUrl}
            alt={item.title}
            className="w-full block rounded-2xl transition-transform duration-500 group-hover:scale-[1.03]"
            style={{
              opacity: imgLoaded ? 1 : 0,
              transition: 'opacity 0.4s ease',
              position: imgLoaded ? 'relative' : 'absolute',
              top: 0,
              left: 0,
            }}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={() => {
              setImgError(true);
              setImgLoaded(true);
            }}
          />
        )}

        {/* Hover gradient overlay */}
        <div
          className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
          style={{
            background: 'linear-gradient(180deg, transparent 40%, rgba(0,0,0,0.5) 100%)',
          }}
        />
      </div>

      {/* Info below image — more organic, like Lovart */}
      <div className="flex items-center gap-2 mt-2.5 mb-1 px-0.5">
        <img
          src={avatarUrl}
          alt={item.ownerUserName}
          className="w-7 h-7 rounded-full shrink-0 object-cover ring-1 ring-white/10"
          onError={(e) => {
            (e.target as HTMLImageElement).src = DEFAULT_AVATAR_FALLBACK;
          }}
        />
        <span
          className="text-[13px] font-medium truncate flex-1"
          style={{ color: 'var(--text-secondary, rgba(255,255,255,0.7))' }}
        >
          {item.ownerUserName}
        </span>

        {/* Stats: view count + like */}
        <div className="flex items-center gap-2.5 shrink-0">
          {item.viewCount > 0 && (
            <span
              className="flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full"
              style={{
                color: 'rgba(255,255,255,0.65)',
                background: 'rgba(255,255,255,0.08)',
              }}
            >
              <Eye size={11} />
              {item.viewCount >= 10000
                ? `${(item.viewCount / 10000).toFixed(1)}万`
                : item.viewCount}
            </span>
          )}
          <div
            className="flex items-center gap-0.5"
            style={{ color: liked ? '#F43F5E' : 'var(--text-muted, rgba(255,255,255,0.3))' }}
            onClick={handleLike}
          >
            <HeartLikeButton
              size={24}
              liked={liked}
              heartColor="#F43F5E"
              disabled={liking}
            />
            {likeCount > 0 && <span className="text-[11px]">{likeCount}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
