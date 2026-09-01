import { useEffect, useRef } from 'react';

/**
 * 潜像场：视觉创作首页的背景层。
 *
 * 为什么不是星空：旧版首页贴了一张星空插画 + 粒子漩涡，和这个产品做的事没有任何关系——
 * 它可以出现在任何一个产品的首页上。这一层换成**和生图同源的材质**：45 度织纹的周期
 * 与生图等待卡完全一致（6/13px，见 tokens.css 的 --gen-wait-surface），
 * 于是「等待出图」和「首页」是同一种东西，而不是两套无关的装饰。
 *
 * 三层，全部极低对比：
 *   1. 织纹  —— 静止，给平面一点颗粒；
 *   2. 核辉光 —— 14 秒一次的呼吸，给这张空页一个重心；
 *   3. 斜掠光 —— 26 秒一个来回，整页唯一「在走」的东西。
 *
 * 动效只有两条，都是 transform/opacity 的合成属性，且都在 prefers-reduced-motion 下停掉。
 */
export function LatentField({ className }: { className?: string }) {
  return (
    <div
      className={`latent-field${className ? ` ${className}` : ''}`}
      aria-hidden
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      <div className="latent-field__weave" />
      <div className="latent-field__core" />
      <div className="latent-field__sweep" />
    </div>
  );
}

/**
 * 背景照片层：从轮换集里取当前这张，压到很暗只当氛围。
 *
 * `src` 为空时整层不渲染——没有图时页面仍然成立（潜像场自己就够了），
 * 这条是刻意的：轮换素材拉不到、或用户关掉背景，首页不能变成一块纯色。
 */
export function BackdropPhoto({ src, dim = 0.82 }: { src?: string | null; dim?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const loaded = useRef(false);

  // 图片解码完再淡入。直接挂 background-image 的话，大图会「啪」地一下出现，
  // 在一个主打克制的页面上那一下非常显眼。
  useEffect(() => {
    const el = ref.current;
    if (!el || !src) return;
    loaded.current = false;
    el.style.opacity = '0';
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (!ref.current) return;
      ref.current.style.backgroundImage = `url(${JSON.stringify(src)})`;
      ref.current.style.opacity = '1';
      loaded.current = true;
    };
    img.src = src;
    return () => {
      img.onload = null;
    };
  }, [src]);

  if (!src) return null;
  return (
    <div aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      <div
        ref={ref}
        className="backdrop-photo"
        style={{ backgroundImage: 'none', opacity: 0 }}
      />
      {/* 压暗罩：背景照片再好看，也不能让 9-13px 的小字掉对比度。
          这一层的不透明度是前景可读性的唯一保障，不许为了「图好看」调低。 */}
      <div style={{ position: 'absolute', inset: 0, background: `rgba(var(--backdrop-scrim), ${dim})` }} />
    </div>
  );
}
