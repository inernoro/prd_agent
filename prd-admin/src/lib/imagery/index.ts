/**
 * 系统配图注册表 —— 全站由模型生成的图片，图位都登记在这里。
 *
 * ## 为什么要有这一层
 *
 * 在它之前有两份注册表各管一摊：`homepageAssetSlots` 管人工上传的素材（卡片背景、
 * Agent 封面、演示视频），`landingPreviewSlots` 管模型生成的图、而且**只服务对外首页**。
 * 于是第三个模块想要配图时只有两条路：把图写死在组件里，或者再抄一份
 * landingPreviewSlots —— 后者就是「同一个判据分裂成多份然后各自漂移」的标准开局。
 *
 * 所以这里只做一件事：**让模块只声明「我有几个图位、默认提示词是什么」**，
 * 生成、改稿、重生成、存储全部由配图中心承担。接一个新模块 = 加一个声明文件，
 * 不用碰设置页。
 *
 * ## 提示词是三层
 *
 *   拍法前缀（`styles.ts`，整组共用） + 画面描述（模块声明里的 subject） → 完整提示词
 *
 * 管理员改过之后，他那一版存在后端 `HomepageAsset.prompt` 里，下次打开回填的是
 * 他自己那版；换拍法时只替换前缀那一段，保住他改过的画面描述。
 *
 * ## 后端是既有的
 *
 * `ImageGenRun`（出图）+ `HomepageAsset`（slot 存储 + prompt 字段）+ `adopt-image-run`
 * （产物挂槽）三样今天都在跑，这一层没有新增任何后端契约。
 */
import { BOOKSHELF_IMAGERY } from './bookshelf';

import { HOME_IMAGERY } from './home';
import { imageryStyle } from './styles';
import type { ImageryModule, ImagerySlot } from './types';

export type { ImageryModule, ImagerySlot, ImageryReach } from './types';
export type { ImageryStyle, ImageryStyleKey } from './styles';
export { IMAGERY_STYLES, DEFAULT_IMAGERY_STYLE, imageryStyle } from './styles';
export { BOOKSHELF_IMAGERY, bookshelfVolumeSlot } from './bookshelf';
export { HOME_IMAGERY } from './home';

/**
 * 全部模块。**缺图最多的排前面**不在这里做——那是管理端的展示顺序，
 * 这里保持声明顺序稳定，免得守卫和测试跟着数据变。
 */
export const SYSTEM_IMAGERY_MODULES: ImageryModule[] = [
  HOME_IMAGERY,
  BOOKSHELF_IMAGERY,
];

export function imageryModuleById(id: string): ImageryModule | undefined {
  return SYSTEM_IMAGERY_MODULES.find((m) => m.id === id);
}

/** 摊平成一串，每条带上它属于哪个模块（管理端统计与守卫都要用） */
export function allImagerySlots(): { module: ImageryModule; slot: ImagerySlot }[] {
  return SYSTEM_IMAGERY_MODULES.flatMap((module) => module.slots.map((slot) => ({ module, slot })));
}

/** 按后端 slot 字符串反查 */
export function imageryEntryBySlot(slotKey: string): { module: ImageryModule; slot: ImagerySlot } | undefined {
  return allImagerySlots().find((e) => e.slot.slot === slotKey);
}

/**
 * 组合出这一图位的完整提示词（拍法前缀 + 画面描述）。
 *
 * 管理端弹窗里给用户看的是**组合后的完整一段**，不是两个框——他要改画面时常常也想
 * 顺手压一下风格（「这次别要雾」），拆成两个框反而挡路。
 */
export function buildImageryPrompt(slot: ImagerySlot, styleKey?: string | null): string {
  return `${imageryStyle(styleKey).prefix}\n\n${slot.subject}`;
}

/**
 * 把一段**已经存过的**提示词换到当前拍法上：前缀替成新拍法的，画面描述原样留着。
 *
 * 为什么要这个：图位一旦生成过，库里存的就是「上一次那个拍法的前缀 + 画面描述」。
 * 重新生成时如果直接拿它去跑，换拍法这件事就不会发生——用户切了拍法、点了
 * 「整组重生成」、七次生图的钱花掉了，出来还是老样子，而按钮旁边写着的是
 * 「整套换一遍」。
 *
 * 反过来也不能一律重建：画面描述可能被人手工调过（「这次别要雾」），
 * 重建会把他的修改一起冲掉。所以只换前缀那一段。
 *
 * 认不出结构（没有空行分隔）时退回重建——那说明它已不是我们生成的格式，
 * 猜不出哪里是前缀哪里是描述，宁可给一个干净的当前拍法版本。
 */
export function applyImageryStyleToPrompt(
  stored: string | null | undefined,
  slot: ImagerySlot,
  styleKey?: string | null,
): string {
  const text = (stored ?? '').trim();
  if (!text) return buildImageryPrompt(slot, styleKey);
  const split = text.indexOf('\n\n');
  if (split < 0) return buildImageryPrompt(slot, styleKey);
  const body = text.slice(split + 2).trim();
  if (!body) return buildImageryPrompt(slot, styleKey);
  return `${imageryStyle(styleKey).prefix}\n\n${body}`;
}
