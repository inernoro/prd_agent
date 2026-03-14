import { DEFAULT_AVATAR_FALLBACK } from '@/lib/avatar';

/**
 * 统一用户头像组件
 *
 * 自动处理加载失败：CDN 图片 → 内联 SVG 兜底（永不显示破碎图标）。
 * 用法：<UserAvatar src={resolveAvatarUrl(...)} className="w-8 h-8 rounded-full" />
 */
export function UserAvatar({
  src,
  alt = '',
  className,
  style,
}: {
  src: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <img
      src={src || DEFAULT_AVATAR_FALLBACK}
      alt={alt}
      className={className}
      style={style}
      onError={(e) => {
        const el = e.currentTarget;
        if (el.getAttribute('data-fallback-applied') === '1') return;
        el.setAttribute('data-fallback-applied', '1');
        el.src = DEFAULT_AVATAR_FALLBACK;
      }}
    />
  );
}
