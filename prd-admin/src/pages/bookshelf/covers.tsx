import type { ReactNode } from 'react';
import { AS_SPACE } from '@/lib/appStoreTokens';

/**
 * 通栏卷面图 —— 卷页顶部、处境卡卡顶用的那一条。
 *
 * 底部压一道渐变，让图与下面的文字接得上；没有它，照片下沿会是一条硬边，
 * 看起来像「图和文字两块东西叠在一起」。渐变终点必须是**它下面那一层的实际底色**
 * ——在卡片里是 --shelf-surface，贴在页面上是 --bg-base。写死一个，另一边就会
 * 在接缝处露出一条色差，而且只在某一屏上看得见。
 *
 * 没图就什么都不渲染（返回 null），由调用方的原有版式承接——不留占位空框。
 */
export function CoverBanner({
  src,
  height,
  radius,
  fadeTo = 'var(--shelf-surface)',
  children,
}: {
  src: string | null;
  height: number;
  /** 顶部圆角，跟着所在卡片走；通栏贴边时传 0 */
  radius: number;
  /** 渐变要融进去的那一层底色 */
  fadeTo?: string;
  /** 压在图上的内容（眉标之类），可选 */
  children?: ReactNode;
}) {
  if (!src) return null;
  return (
    <div
      style={{
        height,
        borderTopLeftRadius: radius,
        borderTopRightRadius: radius,
        backgroundImage: `url(${src})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `linear-gradient(180deg, transparent 45%, ${fadeTo} 100%)`,
        }}
      />
      {children ? (
        <div style={{ position: 'absolute', left: AS_SPACE.featuredPaddingX, bottom: 10 }}>{children}</div>
      ) : null}
    </div>
  );
}
