import { useEffect, useRef } from 'react';

/**
 * 视觉创作首页的背景层。两个组件，加起来三个 DOM 元素。
 *
 * 这里曾经先后住过两套程序生成的美术层——「潜像场」（织纹 + 核辉光 + 斜掠光）与
 * 「印相台」（墨块 + 灰阶梯尺 + 色标条 + 网点 + 套准十字），后者近 180 行 SVG。
 * 两套都删了，判据是量出来的（把每一层单独关掉再比像素差，1440x940 纯底）：
 *
 *   墨块 49/255 · 色标条 40 · 套准十字 38 · 尺边线 16 · 梯尺 13 · 网点 5 · 纸颗粒 4
 *
 * 峰值看着还行的三件里，色标条在 y=902、套准十字在四角，实际都被项目卡和顶栏压住；
 * 剩下真能被看见的只有墨块——也就是两团柔光，正是当初说要替掉的那个东西。
 * 而唯一在整屏尺度上产生可感纹理的是纸颗粒：单像素差只有 4/255，却覆盖 81%
 * 且是 16px 规则重复，缩放显示下摩尔纹，读出来就是一块斜条纹布。
 *
 * 一句话：**有意画的全看不见，看得见的全是无意的。**
 *
 * 所以不再画程序纹理。氛围交给真背景图，深度交给一层非重复的渐晕。
 * 这不是「这次调淡一点」，是承认背景这个位置容不下器物级细节——
 * 它要么淡到看不见，要么就在抢内容，中间没有窗口。
 */

/**
 * 渐晕。整页唯一的程序背景元素：一层、单向、不重复、不动。
 *
 * 它同时服务两个主题，也是浅色主题下唯一的背景（浅色不放照片，见 globals.css）。
 * 几何在 CSS 里（.page-vignette），这里只负责挂载。
 */
export function PageVignette() {
  return <div className="page-vignette" aria-hidden />;
}

/**
 * 背景照片层：从轮换集里取当前这张，压到很暗只当氛围。
 *
 * `src` 为空时整层不渲染——没有图时页面仍然成立（渐晕自己就够了），
 * 这条是刻意的：轮换素材拉不到、或用户关掉背景，首页不能变成一块纯色。
 */
export function BackdropPhoto({ src, dim = 0.82 }: { src?: string | null; dim?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);

  // 图片解码完再淡入。直接挂 background-image 的话，大图会「啪」地一下出现，
  // 在一个主打克制的页面上那一下非常显眼。
  useEffect(() => {
    const el = ref.current;
    if (!el || !src) return;
    el.style.opacity = '0';
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (!ref.current) return;
      ref.current.style.backgroundImage = `url(${JSON.stringify(src)})`;
      ref.current.style.opacity = '1';
    };
    img.src = src;
    return () => {
      img.onload = null;
    };
  }, [src]);

  if (!src) return null;
  return (
    // backdrop-photo-layer：浅色主题下由 CSS 整层隐藏——近黑素材在浅底上无论怎么压
    // 都只会糊成一片灰，见 globals.css 里那条规则的注释。
    <div className="backdrop-photo-layer" aria-hidden style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
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
