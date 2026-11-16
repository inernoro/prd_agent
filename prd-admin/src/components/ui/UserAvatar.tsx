import { useEffect, useRef } from 'react';
import { DEFAULT_AVATAR_FALLBACK, resolveLegacyAvatarUrl } from '@/lib/avatar';
import { useAuthStore } from '@/stores/authStore';

function applyLegacyAvatar(image: HTMLImageElement, url: string) {
  image.setAttribute('data-legacy-applied', '1');
  image.setAttribute('data-legacy-url', url);
  image.removeAttribute('data-fallback-applied');
  image.src = url;
}

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
  const imageRef = useRef<HTMLImageElement>(null);
  const cdnBaseUrl = useAuthStore((state) => state.cdnBaseUrl);
  const legacyCdnBaseUrl = useAuthStore((state) => state.legacyCdnBaseUrl);

  useEffect(() => {
    const image = imageRef.current;
    // 持久登录可先渲染头像，再取得本次 authz 的旧源元数据。
    // 只恢复已经进入占位的图片，不重拉仍在加载或已显示的当前源。
    if (image?.getAttribute('data-fallback-applied') !== '1') return;
    const legacy = resolveLegacyAvatarUrl(src);
    if (!legacy || image.getAttribute('data-legacy-url') === legacy) return;
    applyLegacyAvatar(image, legacy);
  }, [src, cdnBaseUrl, legacyCdnBaseUrl]);

  return (
    <img
      key={src}
      ref={imageRef}
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
            applyLegacyAvatar(el, legacy);
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
