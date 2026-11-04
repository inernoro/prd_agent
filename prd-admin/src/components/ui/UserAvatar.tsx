import { DEFAULT_AVATAR_FALLBACK, resolveLegacyAvatarUrl } from '@/lib/avatar';

/**
 * 统一用户头像组件
 *
 * 当前 CDN 加载失败时先读取受信旧存储的同名真实头像，再使用内联兜底。
 * 用法：<UserAvatar src={resolveAvatarUrl(...)} className="w-8 h-8 rounded-full" />
 */
export function UserAvatar({
  src,
  alt = '',
  className,
  style,
  title,
}: {
  src: string;
  alt?: string;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}) {
  return (
    <img
      key={src}
      src={src || DEFAULT_AVATAR_FALLBACK}
      alt={alt}
      title={title}
      className={className}
      style={style}
      onError={(e) => {
        const el = e.currentTarget;
        if (el.getAttribute('data-legacy-applied') !== '1') {
          const legacy = resolveLegacyAvatarUrl(el.src);
          if (legacy) {
            el.setAttribute('data-legacy-applied', '1');
            el.src = legacy;
            return;
          }
        }
        if (el.getAttribute('data-fallback-applied') === '1') return;
        el.setAttribute('data-fallback-applied', '1');
        el.src = DEFAULT_AVATAR_FALLBACK;
      }}
    />
  );
}
