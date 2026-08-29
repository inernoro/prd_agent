import { Code2, FileText, FileType2, MonitorPlay, PlayCircle, Package } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { HostedSite } from '@/services/real/webPages';

/**
 * 站点「内容形态」注册表 —— 卡片缩略图层左上角那枚徽标的唯一判定源。
 *
 * 为什么要有它：网页托管里躺着的东西不只有 HTML —— ZIP 打包站、PDF 阅读站、视频播放页、
 * Markdown 渲染页，四种东西的缩略图、预览路径、能不能提问全都不一样，但旧卡片一律画成
 * 同一张灰瓦片，用户在列表里分不出哪张是视频哪张是 PDF。
 *
 * 判定只认后端真实下发的两个字段（`wrappedAssetType` + `files.length`），
 * 不猜、不靠文件名后缀二次推断（前端推断会和后端包装逻辑漂移）。
 *
 * 幻灯片形态认后端的 `isSlideDeck`：上传/替换时扫入口 HTML 的框架签名落库。
 * 注意 `SlideNavCompatVersion` 是无条件盖在所有站点上的垫片版本号，**不能**当 deck 标记
 * （不成立的证据不能当证据）；老数据没有 isSlideDeck 字段，按 false 处理，退回 HTML 站。
 */
export type SiteFormKey = 'html' | 'zip' | 'pdf' | 'video' | 'markdown' | 'deck';

export interface SiteFormConfig {
  /** 徽标文案（缩略图左上） */
  label: string;
  icon: LucideIcon;
  /** 一句话说明这个形态是什么，给空态/规格页用 */
  hint: string;
}

export const SITE_FORM_REGISTRY: Record<SiteFormKey, SiteFormConfig> = {
  html: { label: 'HTML', icon: Code2, hint: '单个网页，缩略图是站点实时渲染' },
  zip: { label: 'ZIP 站', icon: Package, hint: '打包站点，自动识别入口文件' },
  pdf: { label: 'PDF', icon: FileText, hint: 'PDF 被包装成可翻页阅读的站点' },
  video: { label: '视频', icon: PlayCircle, hint: '视频被包装成播放页，不支持提问' },
  markdown: { label: 'MD', icon: FileType2, hint: 'Markdown 渲染成网页' },
  deck: { label: '幻灯片', icon: MonitorPlay, hint: '一套幻灯片，访客可用上下键翻页' },
};

type SiteFormInput = Pick<HostedSite, 'wrappedAssetType' | 'files'> & { isSlideDeck?: boolean };

/** 判定站点形态。包装类型优先（后端权威），其次按文件数区分单页 HTML 与 ZIP 站。 */
export function resolveSiteForm(site: SiteFormInput): SiteFormKey {
  const wrapped = site.wrappedAssetType?.toLowerCase();
  if (wrapped === 'pdf') return 'pdf';
  if (wrapped === 'video') return 'video';
  if (wrapped === 'markdown') return 'markdown';
  // deck 判定在包装类型之后、文件数之前：一套 reveal.js 幻灯片既可能是单页也可能是 ZIP，
  // 但它首先是「幻灯片」——用户在列表里要一眼认出的是这个
  if (site.isSlideDeck) return 'deck';
  return (site.files?.length ?? 0) > 1 ? 'zip' : 'html';
}

/**
 * 缩略图右下角的形态角标文案；拿不到真实数值就返回 null（不渲染空角标）。
 *
 * 刻意只覆盖前端真的有数据的两种：单页 HTML 与 ZIP 站的文件数。
 * PDF 页数、视频时长后端都没下发，写「-- 页」比不写更糟。
 */
export function siteFormBadge(site: SiteFormInput): string | null {
  const form = resolveSiteForm(site);
  const count = site.files?.length ?? 0;
  if (form === 'zip') return `${count.toLocaleString()} 文件`;
  if (form === 'html') return count === 1 ? '单页' : null;
  // 设计稿的幻灯片角标是「1 / 24」页码、PDF 是「24 页」、视频是「02:14」——
  // 这三个数后端目前都没有（页数要解析 PDF、时长要探媒体），写「-- 页」比不写更糟。
  // 缺口记在 doc/debt.web-hosting.md，不在这里编。
  return null;
}

/**
 * 来源徽标 —— 缩略图层右上角。与形态徽标分居两角，两组永不混排：
 * 左上回答「这是什么」，右上回答「它从哪来」，信息层才回答「它现在怎么样」。
 */
export const SITE_SOURCE_LABELS: Record<string, string> = {
  upload: '手动上传',
  workflow: '工作流生成',
  api: 'API 生成',
  'saved-share': '保存自分享',
};

export function siteSourceLabel(sourceType: string): string {
  return SITE_SOURCE_LABELS[sourceType] ?? sourceType;
}
