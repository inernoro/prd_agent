/**
 * 周报海报模板前端元数据(UI 展示用,与后端 PosterTemplateRegistry 对齐)。
 * 首屏不等后端接口就能渲染选择器;后端接口返回后再做 override。
 */
import type { WeeklyPosterTemplateKey, WeeklyPosterTemplateMeta } from '@/services';

export const POSTER_TEMPLATES_SEED: WeeklyPosterTemplateMeta[] = [
  {
    key: 'release',
    label: '发布',
    description: '庆祝新版本上线,介绍亮点功能,期待感',
    emoji: '🚀',
    defaultPages: 5,
    accentPalette: ['#7c3aed', '#00f0ff', '#f43f5e', '#f59e0b', '#10b981'],
  },
  {
    key: 'hotfix',
    label: '修复',
    description: '本周修复了哪些问题,让用户安心',
    emoji: '🛠',
    defaultPages: 4,
    accentPalette: ['#0ea5e9', '#64748b', '#22c55e', '#8b5cf6'],
  },
  {
    key: 'promo',
    label: '宣传',
    description: '主推新功能,邀请用户来试用',
    emoji: '✨',
    defaultPages: 5,
    accentPalette: ['#ec4899', '#a855f7', '#facc15', '#06b6d4', '#f43f5e'],
  },
  {
    key: 'sale',
    label: '促销',
    description: '强 CTA 导向,限时福利',
    emoji: '🎁',
    defaultPages: 4,
    accentPalette: ['#ef4444', '#f97316', '#f59e0b', '#8b5cf6'],
  },
];

export function findTemplate(
  list: WeeklyPosterTemplateMeta[],
  key: WeeklyPosterTemplateKey,
): WeeklyPosterTemplateMeta {
  return list.find((t) => t.key === key) ?? list[0];
}

export const PRESENTATION_MODES = [
  { key: 'static' as const, label: '静态轮播', description: '主页弹窗 4-5 页左右翻页', enabled: true },
  { key: 'fullscreen' as const, label: '全屏影片', description: 'Remotion 渲染 MP4 · 敬请期待', enabled: false },
  { key: 'interactive' as const, label: '交互网页', description: '发到网页托管 · 敬请期待', enabled: false },
];

export const SOURCE_TYPES = [
  {
    key: 'changelog-current-week' as const,
    label: '本周 changelog',
    description: '读取 changelogs/ 的本周碎片(推荐)',
  },
  {
    key: 'github-commits' as const,
    label: 'GitHub 最近提交',
    description: '最近 30 条 commit(跨周,覆盖面最广)',
  },
  {
    key: 'knowledge-base' as const,
    label: '知识库文档',
    description: '从文档空间选一篇文章作为海报脚本',
  },
  {
    key: 'freeform' as const,
    label: '自定义 markdown',
    description: '粘贴任何文本(发布公告 / 活动说明)',
  },
];
