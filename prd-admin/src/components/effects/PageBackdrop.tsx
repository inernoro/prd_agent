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

/** 罩的三档由 dim 减出来，减完要夹住：负数会让罩反过来提亮，>1 则整页纯色。 */
const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

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
export function BackdropPhoto({
  src,
  dim = 0.82,
  focus,
}: {
  src?: string | null;
  /** 中央读字区的压暗强度。边缘会自动比它轻很多——见下面 scrim 三档的算法。 */
  dim?: number;
  /** 这张素材有意思的那一块该落在哪（CSS background-position）。默认居中。 */
  focus?: string;
}) {
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
        style={{ backgroundImage: 'none', opacity: 0, '--backdrop-focus': focus ?? 'center' } as React.CSSProperties}
      />
      {/*
       * 可读性罩，三档。
       *
       * 上一版是一整块 rgba(scrim, dim) 铺满全屏，于是整张图统一按 (1-dim) 透出来——
       * 亮部被压灰、暗部被提亮，全都收敛到同一档中间调。用户看完的三句话
       * 「有效果但不多」「模模糊糊」「没有和页面结合起来的感觉」是同一个根因，
       * 换几张图救不了。
       *
       * 现在按内容分布：core 只作用在中央偏上那一片（标题、副标题、输入框、预设行），
       * 往外退到 mid，四边只剩 edge。两个减量是刻意留得很大的——
       * dim=0.62 时边缘只有 0.14，也就是画面边角的效果按 86% 露出来，
       * 而不是全屏 38%。clamp 保证再怎么算都不会翻转或越界。
       */}
      <div
        className="backdrop-scrim"
        style={{
          '--scrim-core': String(clamp01(dim)),
          '--scrim-mid': String(clamp01(dim - 0.22)),
          '--scrim-edge': String(clamp01(dim - 0.48)),
        } as React.CSSProperties}
      />
    </div>
  );
}
