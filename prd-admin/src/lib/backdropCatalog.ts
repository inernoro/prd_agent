import arcUrl from '@/assets/backdrops/arc.webp';
import blindsUrl from '@/assets/backdrops/blinds.webp';
import bloomUrl from '@/assets/backdrops/bloom.webp';
import duskUrl from '@/assets/backdrops/dusk.webp';
import emberUrl from '@/assets/backdrops/ember.webp';
import foldUrl from '@/assets/backdrops/fold.webp';
import haloUrl from '@/assets/backdrops/halo.webp';
import rippleUrl from '@/assets/backdrops/ripple.webp';
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
 * 没有主体、亮部只有一处。作品封面正好全都不满足。所以这几张是按这个前提专门生成的
 * （走的就是本产品自己的生图链路，`visual-agent.image.text2img::generation`，
 * 1536x1024 出图后压成 1280 宽的 WebP，九张合计约 115KB）。
 *
 * ── 两批，两种取向 ──
 *
 * 第一批四张（显影 / 门缝 / 余烬 / 薄雾）是**光**：一团柔光换四个位置。
 * 用户看完问「只有这些了吗？是否有更有特色的」——问得对：四张其实是同一个想法的四次挪位，
 * 谁也没有「形」。
 *
 * 第二批五张（百叶 / 粼 / 析出 / 弧光 / 褶）补的就是形：光栅、水面、絮缕、硬边、织物。
 * 判据不是「更亮更花」——那会抢内容——而是**这张图有没有一件说得出名字的东西**。
 * 柔光说不出，百叶窗的光栅说得出。
 */
export const BACKDROP_CATALOG: readonly BackdropAsset[] = [
  // 第一批：光的位置
  { id: 'halo', name: '显影', url: haloUrl, note: '顶部弥散的赤陶色光晕' },
  { id: 'dusk', name: '门缝', url: duskUrl, note: '左上角斜切进来的一束光' },
  { id: 'ember', name: '余烬', url: emberUrl, note: '底部将熄的暖橘色辉光' },
  { id: 'veil', name: '薄雾', url: veilUrl, note: '横贯中部的一层暖灰雾气' },
  // 第二批：光的形。dim 只在这张图明显比同批亮时才单独写。
  { id: 'blinds', name: '百叶', url: blindsUrl, note: '光穿过百叶窗投在暗墙上的斜光栅', dim: 0.66 },
  { id: 'ripple', name: '粼', url: rippleUrl, note: '一道光落在暗水面上被涟漪打碎', dim: 0.68 },
  { id: 'bloom', name: '析出', url: bloomUrl, note: '一滴墨在黑水里散开的絮缕', dim: 0.70 },
  { id: 'arc', name: '弧光', url: arcUrl, note: '一线硬边高光扫过画面' },
  { id: 'fold', name: '褶', url: foldUrl, note: '暗色织物褶皱脊线上的一道擦光' },
];

/**
 * 压暗罩的不透明度。
 *
 * 随包这几张本来就够暗（亮部也只到中灰），所以 0.62 就足以保住 9-13px 小字的对比度，
 * 又能让那点光透出来。用户自己生成的背景则未知深浅，走 {@link GENERATED_DIM} 的保守值。
 */
export const CATALOG_DIM = 0.62;

/** 用户自己生成的背景：深浅不可控，压重一点，宁可看不清也不能让正文掉对比度。 */
export const GENERATED_DIM = 0.80;

/**
 * 这张图该用多重的暗罩。
 *
 * 三档而不是两档：随包素材之间本身就有明暗差（「析出」那团墨的亮度是「褶」的好几倍），
 * 全批共用一个值必然有一头是错的——要么墨那张压不住抢标题，要么褶那张压死了什么都看不见。
 * 所以随包素材可以在条目上单独写 dim，写了就用它，没写走批次默认值。
 */
export function dimFor(asset: BackdropAsset | null | undefined): number {
  if (!asset) return CATALOG_DIM;
  const known = BACKDROP_CATALOG.find((a) => a.id === asset.id);
  if (!known) return GENERATED_DIM;
  return known.dim ?? CATALOG_DIM;
}
