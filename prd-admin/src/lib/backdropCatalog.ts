import duskUrl from '@/assets/backdrops/dusk.webp';
import emberUrl from '@/assets/backdrops/ember.webp';
import haloUrl from '@/assets/backdrops/halo.webp';
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
 * 没有主体、亮部只有一处。作品封面正好全都不满足。所以这四张是按这个前提专门生成的
 * （走的就是本产品自己的生图链路，`visual-agent.image.text2img::generation`，
 * 1536x1024 出图后压成 1280 宽的 WebP，四张合计约 50KB）。
 *
 * 命名对应暗房的四种光：显影时的顶光、门缝漏进来的斜光、定影盘底下的余烬、
 * 药液里刚浮起来的影调。
 */
export const BACKDROP_CATALOG: readonly BackdropAsset[] = [
  { id: 'halo', name: '显影', url: haloUrl, note: '顶部弥散的赤陶色光晕' },
  { id: 'dusk', name: '门缝', url: duskUrl, note: '左上角斜切进来的一束光' },
  { id: 'ember', name: '余烬', url: emberUrl, note: '底部将熄的暖橘色辉光' },
  { id: 'veil', name: '薄雾', url: veilUrl, note: '横贯中部的一层暖灰雾气' },
];

/**
 * 压暗罩的不透明度。
 *
 * 随包这四张本来就够暗（亮部也只到中灰），所以 0.55 就足以保住 9-13px 小字的对比度，
 * 又能让那点光透出来。用户自己生成的背景则未知深浅，走 {@link GENERATED_DIM} 的保守值。
 */
export const CATALOG_DIM = 0.62;

/** 用户自己生成的背景：深浅不可控，压重一点，宁可看不清也不能让正文掉对比度。 */
export const GENERATED_DIM = 0.80;

/** 这张图该用多重的暗罩——随包的认 id，其余一律按「不可控」处理。 */
export function dimFor(asset: BackdropAsset | null | undefined): number {
  if (!asset) return CATALOG_DIM;
  return BACKDROP_CATALOG.some((a) => a.id === asset.id) ? CATALOG_DIM : GENERATED_DIM;
}
