import type { ImageryStyleKey } from './styles';

/**
 * 一个图位 —— 页面上某个「这里该有一张图」的位置。
 *
 * 图位可以是空的：取不到图，消费方必须能照常渲染（回落到自己的兜底）。
 * 这条是硬约定，不然一个还没配图的新模块会白屏。
 */
export interface ImagerySlot {
  /** 稳定 id，模块内唯一；管理端 URL 与守卫都认它 */
  id: string;
  /**
   * 后端 slot 字符串，全系统唯一，也是这张图在库里的主键。
   *
   * **一旦生成过就不能再改**：改了等于把已生成的那张图丢掉，管理员得重新生成一遍。
   */
  slot: string;
  /** 管理端展示名 */
  label: string;
  /** 这张图出现在哪一屏的什么位置（管理员据此判断配得对不对） */
  where: string;
  /** 生图尺寸（宽x高） */
  size: string;
  /** 画面描述 —— 提示词的第二层，拍法前缀之后的那半段 */
  subject: string;
}

/**
 * 模块的可达性 —— 决定这一组图走哪个读取通道，**不是**装饰字段。
 *
 * - `public`：未登录也要看到（对外首页）。走匿名端点，后端只放行 `landing.` 前缀，
 *   所以这类模块的 slot **必须**以 `landing.` 开头（守卫会查）。公网无鉴权面不该
 *   吐出整张表，那等于白送一份资源清单。
 * - `internal`：登录后才看得到。走登录端点，slot 前缀不受限。
 */
export type ImageryReach = 'public' | 'internal';

/** 一个模块声明的全部图位 */
export interface ImageryModule {
  /** 模块 id，管理端分组用 */
  id: string;
  label: string;
  /** 这个模块的页面路由，管理端显示出来让人知道去哪看 */
  route: string;
  reach: ImageryReach;
  /** 这一组默认用哪一档拍法 */
  defaultStyle: ImageryStyleKey;
  /** 一句话说清这一组图是干嘛的 */
  hint: string;
  slots: ImagerySlot[];
}
