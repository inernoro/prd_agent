import arcUrl from '@/assets/backdrops/arc.webp';
import blindsUrl from '@/assets/backdrops/blinds.webp';
import bloomUrl from '@/assets/backdrops/bloom.webp';
import concentricUrl from '@/assets/backdrops/concentric.webp';
import duskUrl from '@/assets/backdrops/dusk.webp';
import eclipseUrl from '@/assets/backdrops/eclipse.webp';
import emberUrl from '@/assets/backdrops/ember.webp';
import foldUrl from '@/assets/backdrops/fold.webp';
import gridUrl from '@/assets/backdrops/grid.webp';
import haloUrl from '@/assets/backdrops/halo.webp';
import prismUrl from '@/assets/backdrops/prism.webp';
import raysUrl from '@/assets/backdrops/rays.webp';
import rippleUrl from '@/assets/backdrops/ripple.webp';
import starfieldUrl from '@/assets/backdrops/starfield.webp';
import veilUrl from '@/assets/backdrops/veil.webp';
import type { BackdropAsset } from './backdropRotation';

/**
 * 随包发的背景素材。
 *
 * 为什么不是「你自己项目的封面图」——第一版就是那么做的，取证之后推翻了：
 * 真实素材池里绝大多数封面是**白底产品图**（一颗水蜜桃、一只猫），压到 0.82 的暗罩底下
 * 整页从近黑变成一片平灰，暗房的黑没了，而那张图本身也糊成一团认不出来。
 * 两头不讨好。见 hero-cover-0.82.png 那次取证。
 *
 * 背景图是有前提的：它必须**本来就为「当背景」而画**——近黑、大量负空间、
 * 中间区域留得够暗，好让白色标题压上去仍然清晰。作品封面正好全都不满足。
 * 所以这些都是按这个前提专门生成的（走的就是本产品自己的生图链路，
 * `visual-agent.image.text2img::generation`，1536x1024 出图后压成 1280 宽的 WebP）。
 *
 * ── 三批，三次纠偏 ──
 *
 * 1. **光**（显影 / 门缝 / 余烬 / 薄雾）：一团柔光换四个位置。
 *    用户看完问「只有这些了吗」——问得对，四张其实是同一个想法的四次挪位，谁也没有形。
 * 2. **形**（百叶 / 粼 / 析出 / 弧光 / 褶）：补上形——光栅、水面、絮缕、硬边、织物。
 *    用户看完说「稍微有点抽象」——也对：有形了，但仍是**摄影式的氛围**，不是设计。
 * 3. **设计**（星环 / 星野 / 同心 / 地平 / 棱镜 / 光锥）：按用户点名的四个方向做——
 *    几何、光线、宇宙、星空。判据从「有没有一件说得出名字的东西」升级为
 *    **「这张图像不像一张有人构过图的海报」**：有构造、有边缘、有取舍，而不是一团氛围。
 *
 * 排序是**新的在前**：用户问的就是「有没有更有特色的」，三列面板一屏先看到设计批。
 */
export const BACKDROP_CATALOG: readonly BackdropAsset[] = [
  // 第三批 · 设计：几何 / 光线 / 宇宙 / 星空
  { id: 'eclipse', name: '星环', url: eclipseUrl, note: '行星暗面边缘的一圈细高光' },
  { id: 'grid', name: '地平', url: gridUrl, note: '透视网格收拢到一线地平光' },
  { id: 'rays', name: '光锥', url: raysUrl, note: '顶部斜射下来的一组硬边光锥', dim: 0.70 },
  { id: 'starfield', name: '星野', url: starfieldUrl, note: '深空星点与一条斜贯的星云' },
  { id: 'concentric', name: '同心', url: concentricUrl, note: '包豪斯式同心圆弧构成', dim: 0.78 },
  // 0.78 而不是 0.80：随包素材必须严格轻于「用户生成」那一档，否则「随包的我们看过、
  // 所以可以压得轻些」这条前提就不成立了。写 0.80 时守卫直接判红，是它该做的事。
  { id: 'prism', name: '棱镜', url: prismUrl, note: '白光过棱镜分出的一道光谱', dim: 0.76 },
  // 第二批 · 形
  { id: 'blinds', name: '百叶', url: blindsUrl, note: '光穿过百叶窗投在暗墙上的斜光栅', dim: 0.66 },
  { id: 'ripple', name: '粼', url: rippleUrl, note: '一道光落在暗水面上被涟漪打碎', dim: 0.68 },
  { id: 'bloom', name: '析出', url: bloomUrl, note: '一滴墨在黑水里散开的絮缕', dim: 0.70 },
  { id: 'arc', name: '弧光', url: arcUrl, note: '一线硬边高光扫过画面' },
  { id: 'fold', name: '褶', url: foldUrl, note: '暗色织物褶皱脊线上的一道擦光' },
  // 第一批 · 光
  { id: 'halo', name: '显影', url: haloUrl, note: '顶部弥散的赤陶色光晕' },
  { id: 'dusk', name: '门缝', url: duskUrl, note: '左上角斜切进来的一束光' },
  { id: 'ember', name: '余烬', url: emberUrl, note: '底部将熄的暖橘色辉光' },
  { id: 'veil', name: '薄雾', url: veilUrl, note: '横贯中部的一层暖灰雾气' },
];

/**
 * 压暗罩的不透明度默认值。
 *
 * 随包素材大多本来就够暗（亮部也只到中灰），0.62 足以保住 9-13px 小字的对比度，
 * 又能让那点光透出来。用户自己生成的背景则未知深浅，走 {@link GENERATED_DIM} 的保守值。
 */
export const CATALOG_DIM = 0.62;

/** 用户自己生成的背景：深浅不可控，压重一点，宁可看不清也不能让正文掉对比度。 */
export const GENERATED_DIM = 0.80;

/**
 * 这张图该用多重的暗罩。
 *
 * 三档而不是两档：随包素材之间本身就有明暗差（「同心」那组圆弧的亮度是「褶」的好几倍），
 * 全批共用一个值必然有一头是错的——要么圆弧压不住抢标题，要么褶压死了什么都看不见。
 * 所以随包素材可以在条目上单独写 dim，写了就用它，没写走批次默认值。
 */
export function dimFor(asset: BackdropAsset | null | undefined): number {
  if (!asset) return CATALOG_DIM;
  const known = BACKDROP_CATALOG.find((a) => a.id === asset.id);
  if (!known) return GENERATED_DIM;
  return known.dim ?? CATALOG_DIM;
}
