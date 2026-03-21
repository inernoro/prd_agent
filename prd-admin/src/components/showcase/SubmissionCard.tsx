import { useState } from 'react';
import { Heart } from 'lucide-react';
import { resolveAvatarUrl, DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';
import type { SubmissionItem } from '@/services/real/submissions';

interface SubmissionCardProps {
  item: SubmissionItem;
  onLikeToggle?: (id: string, liked: boolean) => void;
}

export function SubmissionCard({ item, onLikeToggle }: SubmissionCardProps) {
  const [imgLoaded, setImgLoaded] = useState(false);
  const [liked, setLiked] = useState(item.likedByMe);
  const [likeCount, setLikeCount] = useState(item.likeCount);
  const [liking, setLiking] = useState(false);

  const avatarUrl = resolveAvatarUrl({ avatarFileName: item.ownerAvatarFileName });

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (liking) return;
    setLiking(true);
    const newLiked = !liked;
    setLiked(newLiked);
    setLikeCount((c) => c + (newLiked ? 1 : -1));
    try {
      onLikeToggle?.(item.id, newLiked);
    } finally {
      setLiking(false);
    }
  };

  return (
    <div
      className="group relative rounded-xl overflow-hidden transition-all duration-300 hover:-translate-y-1"
      style={{
        background: 'var(--bg-elevated, rgba(255,255,255,0.03))',
        border: '1px solid rgba(255,255,255,0.06)',
        breakInside: 'avoid',
      }}
    >
      {/* Cover image */}
      <div className="relative w-full overflow-hidden">
        {!imgLoaded && (
          <div
            className="w-full animate-pulse"
            style={{
              aspectRatio: item.coverWidth && item.coverHeight
                ? `${item.coverWidth}/${item.coverHeight}`
                : '1/1',
              background: 'rgba(255,255,255,0.04)',
              minHeight: 120,
            }}
          />
        )}
        <img
          src={item.coverUrl}
          alt={item.title}
          className="w-full block transition-transform duration-500 group-hover:scale-105"
          style={{
            display: imgLoaded ? 'block' : 'none',
          }}
          loading="lazy"
          onLoad={() => setImgLoaded(true)}
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
            setImgLoaded(true);
          }}
        />

        {/* Hover overlay */}
        <div
          className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
          style={{
            background: 'linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.6) 100%)',
          }}
        />

        {/* Hover border glow */}
        <div
          className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
          style={{ boxShadow: 'inset 0 0 0 1px rgba(99,102,241,0.3)' }}
        />
      </div>

      {/* Footer: avatar + username on left, heart + count on right */}
      <div className="flex items-center justify-between px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <img
            src={avatarUrl}
            alt={item.ownerUserName}
            className="w-6 h-6 rounded-full shrink-0 object-cover"
            onError={(e) => {
              (e.target as HTMLImageElement).src = DEFAULT_AVATAR_FALLBACK;
            }}
          />
          <span
            className="text-xs truncate"
            style={{ color: 'var(--text-muted, rgba(255,255,255,0.5))' }}
          >
            {item.ownerUserName}
          </span>
        </div>

        <button
          type="button"
          onClick={handleLike}
          className="flex items-center gap-1 shrink-0 transition-colors duration-150"
          style={{ color: liked ? '#F43F5E' : 'var(--text-muted, rgba(255,255,255,0.35))' }}
          disabled={liking}
        >
          <Heart
            size={14}
            fill={liked ? '#F43F5E' : 'none'}
            className="transition-transform duration-200 hover:scale-110"
          />
          <span className="text-xs">{likeCount > 0 ? likeCount : ''}</span>
        </button>
      </div>
    </div>
  );
}
