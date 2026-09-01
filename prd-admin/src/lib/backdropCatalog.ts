import auroraUrl from '@/assets/backdrops/aurora.webp';
import blindsUrl from '@/assets/backdrops/blinds.webp';
import bloomUrl from '@/assets/backdrops/bloom.webp';
import composeUrl from '@/assets/backdrops/compose.webp';
import concentricUrl from '@/assets/backdrops/concentric.webp';
import contourUrl from '@/assets/backdrops/contour.webp';
import duskUrl from '@/assets/backdrops/dusk.webp';
import fieldUrl from '@/assets/backdrops/field.webp';
import gridUrl from '@/assets/backdrops/grid.webp';
import haloUrl from '@/assets/backdrops/halo.webp';
import prismUrl from '@/assets/backdrops/prism.webp';
import raysUrl from '@/assets/backdrops/rays.webp';
import reliefUrl from '@/assets/backdrops/relief.webp';
import ridgeUrl from '@/assets/backdrops/ridge.webp';
import starfieldUrl from '@/assets/backdrops/starfield.webp';
import type { BackdropAsset } from './backdropRotation';

/**
 * 随包发的背景素材。
 *
 * ── 四批，以及一次量化的自我推翻 ──
 *
 * 前三批（光 / 形 / 设计）都在换题材，用户的评价一次比一次准：
 * 「只有这些了吗」→「稍微有点抽象」→「有效果但不多、模模糊糊、没有和页面结合起来」。
 *
 * 第三句之后没有再换题材，而是**去量**：把每张素材缩到 160px 宽逐像素统计
 * 「亮度 > 24/255 的像素占多少」。结果那十五张全部落在 **1%-14%** 之间，
 * 平均亮度 5-18（满值 255）——画面 85%-99% 是纯黑，然后我又在上面盖 62%-78% 的罩。
 * 「模模糊糊」不是错觉，是这两件事叠出来的必然。
 *
 * 根因在我自己的提示词：三批复用了同一句约束「近黑底色、亮部只占画面一小块、
 * 大量负空间」。为了「不抢文字」优化过头，产出的背景里根本没有东西。
 *
 * 第四批（等高 / 纸雕 / 构成 / 极光 / 色场 / 山脊）把约束反过来写：**整幅都要有内容**、
 * 要有中间调过渡，只把「中央偏上那一带」单独要求安静——那正好是新的三档罩最重的地方
 * （见 globals.css 的 .backdrop-scrim）。实测平均亮度 14-54、有效占比 11%-100%，
 * 比前三批高一个数量级。
 *
 * 同批删掉六张实测最空的（褶 0.9% / 弧光 1.2% / 星环 1.3% / 粼 2.6% / 余烬 4.1% / 薄雾 4.2%）。
 * **「地平」是明说的例外**：它也只有 2.6%，但它是一条贯穿整幅的透视网格——
 * 细而长的几何在「按像素数」的指标下天然吃亏，而整页取证里它读得很好。
 * 指标用来发现问题，不用来代替看。
 *
 * 素材仍走本产品自己的生图链路（`visual-agent.image.text2img::generation`，
 * 1536x1024 出图后压成 1280 宽 WebP；等高线那张细节密，压到 1152 宽以免一张吃掉大半体积）。
 *
 * 每条都带 focus：默认的 cover + center 会把主体塞到画面正中，那正是标题和输入框所在。
 * focus 把主体挪开，配合按内容分布的三档罩，背景才谈得上跟页面是一起构的图。
 */
export const BACKDROP_CATALOG: readonly BackdropAsset[] = [
  // 第四批 · 铺满画面的设计版面（实测有效占比 11%-100%）
  { id: 'contour', name: '等高', url: contourUrl, note: '铺满画面的赤陶色等高线地形', focus: '50% 50%', dim: 0.70 },
  { id: 'relief', name: '纸雕', url: reliefUrl, note: '多层裁切纸面叠压出的层次', focus: '46% 58%', dim: 0.68 },
  { id: 'compose', name: '构成', url: composeUrl, note: '瑞士国际主义的大尺度几何叠压', focus: '46% 46%', dim: 0.64 },
  { id: 'aurora', name: '极光', url: auroraUrl, note: '赤陶与靛蓝的大幅光带缠绕', focus: '32% 46%' },
  { id: 'field', name: '色场', url: fieldUrl, note: '一条硬边斜线分开的两个色域', focus: '38% 82%', dim: 0.58 },
  { id: 'ridge', name: '山脊', url: ridgeUrl, note: '层叠推远的山脊与背后的辉光', focus: '72% 34%', dim: 0.60 },
  // 第三批 · 设计：几何 / 光线 / 宇宙 / 星空
  { id: 'grid', name: '地平', url: gridUrl, note: '透视网格收拢到一线地平光', focus: '50% 100%' },
  { id: 'rays', name: '光锥', url: raysUrl, note: '顶部斜射下来的一组硬边光锥', focus: '34% 14%', dim: 0.70 },
  { id: 'starfield', name: '星野', url: starfieldUrl, note: '深空星点与一条斜贯的星云', focus: '48% 62%' },
  { id: 'concentric', name: '同心', url: concentricUrl, note: '包豪斯式同心圆弧构成', focus: '72% 40%', dim: 0.78 },
  { id: 'prism', name: '棱镜', url: prismUrl, note: '白光过棱镜分出的一道光谱', focus: '64% 58%', dim: 0.76 },
  // 第二批 · 形
  { id: 'blinds', name: '百叶', url: blindsUrl, note: '光穿过百叶窗投在暗墙上的斜光栅', focus: '62% 26%', dim: 0.66 },
  { id: 'bloom', name: '析出', url: bloomUrl, note: '一滴墨在黑水里散开的絮缕', focus: '22% 48%', dim: 0.70 },
  // 第一批 · 光
  { id: 'halo', name: '显影', url: haloUrl, note: '顶部弥散的赤陶色光晕', focus: '50% 8%' },
  { id: 'dusk', name: '门缝', url: duskUrl, note: '左上角斜切进来的一束光', focus: '28% 22%' },
];

/**
 * 中央读字区的压暗强度默认值。
 *
 * 注意它**只作用在中央偏上那一片**：四边由 .backdrop-scrim 自动退到 core-0.48，
 * 也就是 0.62 时边角只剩 0.14，画面边缘的效果按 86% 露出来。
 * 上一版这个值是铺满全屏的，那是「模模糊糊」的另一半原因。
 */
export const CATALOG_DIM = 0.62;

/** 用户自己生成的背景：深浅不可控，压重一点，宁可看不清也不能让正文掉对比度。 */
export const GENERATED_DIM = 0.80;

/**
 * 这张图该用多重的暗罩（中央读字区那一档）。
 *
 * 三档而不是两档：随包素材之间明暗差很大（「等高」中央顶带实测 47，「色场」只有 7.5），
 * 全批共用一个值必然有一头是错的——要么压不住抢标题，要么压死了等于没放图。
 * 随包素材可以在条目上单独写 dim，写了就用它，没写走批次默认值。
 */
export function dimFor(asset: BackdropAsset | null | undefined): number {
  if (!asset) return CATALOG_DIM;
  const known = BACKDROP_CATALOG.find((a) => a.id === asset.id);
  if (!known) return GENERATED_DIM;
  return known.dim ?? CATALOG_DIM;
}
