import { memo, useState } from 'react';

interface AvatarWithFallbackProps {
  avatarUrl?: string | null;
  displayName?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export const AvatarWithFallback = memo(function AvatarWithFallback({
  avatarUrl,
  displayName = '?',
  size = 'md',
  className = ''
}: AvatarWithFallbackProps) {
  const [imgError, setImgError] = useState(false);
  
  const sizeClass = size === 'sm' ? 'w-9 h-9' : size === 'lg' ? 'w-16 h-16' : 'w-9 h-9';
  
  return (
    <div
      className={`${sizeClass} rounded-full border border-black/10 dark:border-white/15 shadow-sm overflow-hidden ${className}`}
      title={displayName || '?'}
    >
      {avatarUrl && !imgError ? (
        <img
          src={avatarUrl}
          alt={displayName || ''}
          className="w-full h-full object-cover"
          onError={(e) => {
            console.error('[AvatarWithFallback] 头像加载失败:', {
              displayName,
              avatarUrl,
              error: e.type
            });
            setImgError(true);
          }}
          draggable={false}
        />
      ) : (
        <div className="w-full h-full" />
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  // 自定义比较函数：只有这些字段变化时才重新渲染
  return (
    prevProps.avatarUrl === nextProps.avatarUrl &&
    prevProps.displayName === nextProps.displayName &&
    prevProps.size === nextProps.size &&
    prevProps.className === nextProps.className
  );
});
