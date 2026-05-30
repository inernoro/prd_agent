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
  color: string;
  icon: LucideIcon;
}

export const LABEL_REGISTRY: Record<string, LabelMeta> = {
  model_release: { label: '模型发布', color: '#4ade80', icon: Rocket },
  ai_general: { label: 'AI 动态', color: '#a5b4fc', icon: Sparkles },
  product: { label: '产品', color: '#22d3ee', icon: Boxes },
  product_launch: { label: '新品', color: '#22d3ee', icon: Boxes },
  tool: { label: '工具', color: '#fbbf24', icon: Wrench },
  research: { label: '研究', color: '#f472b6', icon: FlaskConical },
  paper: { label: '论文', color: '#f472b6', icon: ScrollText },
  funding: { label: '融资', color: '#34d399', icon: TrendingUp },
  business: { label: '商业', color: '#34d399', icon: TrendingUp },
  policy: { label: '政策', color: '#fb923c', icon: Landmark },
  opinion: { label: '观点', color: '#fbbf24', icon: Megaphone },
};

export const DEFAULT_LABEL: LabelMeta = { label: '资讯', color: '#94a3b8', icon: Newspaper };

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
