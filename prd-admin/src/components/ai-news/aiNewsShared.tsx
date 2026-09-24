import {
  Rocket,
  Sparkles,
  Wrench,
  FlaskConical,
  ScrollText,
  TrendingUp,
  Landmark,
  Megaphone,
  Boxes,
  Newspaper,
  Flame,
  Bot,
  Cpu,
  Workflow,
  Code2,
  type LucideIcon,
} from 'lucide-react';
import type { AiNewsItem } from '@/services/real/aiNews';

/**
 * AI 资讯共享逻辑（ai_label 注册表 + 时间工具 + 精选阈值）。
 *
 * SSOT：首页「更新中心」卡片 teaser 与更新中心页「AI 大事」时间线共用这一份，
 * 禁止在组件内重复硬编码（遵守注册表模式 + SSOT 规则）。
 */

// ── ai_label → 中文 / 颜色 / 图标 注册表 ──
export interface LabelMeta {
  label: string;
  /** 随主题变化的分类色（CSS 变量），页面正文、标签、图标一律用它 */
  color: string;
  /**
   * 固定的亮色档：只给「永远压在深色底上」的位置用（首页挂件底部的黑色渐变条）。
   * 那里无论白天黑夜都是深底，跟主题走反而会变成深字压深底。
   */
  onDark: string;
  icon: LucideIcon;
}

type NewsHue =
  | 'indigo-soft' | 'green' | 'rose' | 'cyan' | 'amber' | 'indigo' | 'gold'
  | 'emerald' | 'sky' | 'purple' | 'pink' | 'orange' | 'slate';

/**
 * 分类色走 tokens.css 的 --news-label-*：暗色是原来的 400 档亮色，
 * 浅色压到 700/800 档。原先直接写 hex，浅色下亮琥珀 / 亮青字落在暖纸底上几乎读不出。
 */
function newsColor(hue: NewsHue): string {
  return `var(--news-label-${hue})`;
}

/**
 * 分类色的淡底 / 描边：原来是 `${hex}24` 这种拼透明度后缀，换成 CSS 变量后拼不了，
 * 统一改用 color-mix，两种主题下都按同一比例取淡。
 */
export function newsTint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

export const LABEL_REGISTRY: Record<string, LabelMeta> = {
  // ── 上游 ai-news-radar 实际使用的 11 种 ai_label（全部映射，治标：上游分类本身可能不准）──
  ai_general: { label: 'AI 动态', color: newsColor('indigo-soft'), onDark: '#a5b4fc', icon: Sparkles },
  model_release: { label: '模型发布', color: newsColor('green'), onDark: '#4ade80', icon: Rocket },
  curated_hotlist: { label: '热榜', color: newsColor('rose'), onDark: '#fb7185', icon: Flame },
  ai_product_update: { label: '产品更新', color: newsColor('cyan'), onDark: '#22d3ee', icon: Boxes },
  developer_tool: { label: '开发工具', color: newsColor('amber'), onDark: '#fbbf24', icon: Wrench },
  agent_workflow: { label: '智能体', color: newsColor('indigo'), onDark: '#818cf8', icon: Workflow },
  robotics: { label: '机器人', color: newsColor('gold'), onDark: '#f59e0b', icon: Bot },
  industry_business: { label: '行业商业', color: newsColor('emerald'), onDark: '#34d399', icon: TrendingUp },
  infra_compute: { label: '算力基建', color: newsColor('sky'), onDark: '#38bdf8', icon: Cpu },
  ai_tech: { label: '技术', color: newsColor('purple'), onDark: '#c084fc', icon: Code2 },
  research_paper: { label: '研究论文', color: newsColor('pink'), onDark: '#f472b6', icon: ScrollText },
  // ── 兼容历史 / 其它来源可能出现的别名（不在上游主表，出现时也有正确中文名）──
  product: { label: '产品', color: newsColor('cyan'), onDark: '#22d3ee', icon: Boxes },
  product_launch: { label: '新品', color: newsColor('cyan'), onDark: '#22d3ee', icon: Boxes },
  tool: { label: '工具', color: newsColor('amber'), onDark: '#fbbf24', icon: Wrench },
  research: { label: '研究', color: newsColor('pink'), onDark: '#f472b6', icon: FlaskConical },
  paper: { label: '论文', color: newsColor('pink'), onDark: '#f472b6', icon: ScrollText },
  funding: { label: '融资', color: newsColor('emerald'), onDark: '#34d399', icon: TrendingUp },
  business: { label: '商业', color: newsColor('emerald'), onDark: '#34d399', icon: TrendingUp },
  policy: { label: '政策', color: newsColor('orange'), onDark: '#fb923c', icon: Landmark },
  opinion: { label: '观点', color: newsColor('amber'), onDark: '#fbbf24', icon: Megaphone },
};

export const DEFAULT_LABEL: LabelMeta = { label: '资讯', color: newsColor('slate'), onDark: '#94a3b8', icon: Newspaper };

export function labelMeta(key: string): LabelMeta {
  return LABEL_REGISTRY[key] ?? DEFAULT_LABEL;
}

// ── 时间工具 ──

export function parseTime(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

export function itemTime(it: AiNewsItem): number | null {
  return parseTime(it.publishedAt) ?? parseTime(it.firstSeenAt);
}

export function relTime(ms: number | null, now: number): string {
  if (ms == null) return '';
  const diff = Math.max(0, now - ms);
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

/** 时间轴标签：当天/昨天显示 HH:MM，更早显示 MM-DD（配合分组标题消歧）。 */
export function clockLabel(ms: number | null, b: Bucket): string {
  if (ms == null) return '--:--';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (b === 'earlier') return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type Bucket = 'now' | 'today' | 'yesterday' | 'earlier' | 'unknown';

export function bucketOf(ms: number | null, now: number): Bucket {
  if (ms == null) return 'unknown';
  const diff = now - ms;
  if (diff < 3600_000) return 'now';
  const d0 = new Date(now);
  const di = new Date(ms);
  const sameDay =
    d0.getFullYear() === di.getFullYear() && d0.getMonth() === di.getMonth() && d0.getDate() === di.getDate();
  if (sameDay) return 'today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const isYesterday =
    y.getFullYear() === di.getFullYear() && y.getMonth() === di.getMonth() && y.getDate() === di.getDate();
  if (isYesterday) return 'yesterday';
  return 'earlier';
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  now: '刚刚 · 1 小时内',
  today: '今天',
  yesterday: '昨天',
  earlier: '更早',
  unknown: '近期',
};

/** 精选阈值：源站多数条目 ~0.65，0.7 用于挑出更高信号项（0.78~0.92）。 */
export const FEATURED_THRESHOLD = 0.7;

/** 按可用时间倒序排序（已在后端排过，前端兜底确保稳定）。 */
export function sortByRecency(items: AiNewsItem[]): AiNewsItem[] {
  return [...items].sort(
    (a, b) => (itemTime(b) ?? 0) - (itemTime(a) ?? 0),
  );
}

/** 首页挂件底部黑色渐变条上的标题色：那块底恒为深色，不能跟主题走 --text-primary（浅色下是深字） */
export const NEWS_ON_DARK_TEXT = '#f7f7fb';
