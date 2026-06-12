/**
 * 行为洞察类型注册表（颜色 + 图标）。kind 文案（kindLabel）由后端下发，
 * 前端只维护视觉映射；未知 kind 走兜底，永不崩溃。
 */
import { AlertOctagon, DoorOpen, Hourglass, Repeat2, Timer, Sparkles, type LucideIcon } from 'lucide-react';

export type InsightKindMeta = {
  icon: LucideIcon;
  accent: string;
  soft: string;
};

const meta = (icon: LucideIcon, accent: string): InsightKindMeta => ({
  icon,
  accent,
  soft: `${accent}1f`,
});

export const INSIGHT_KIND_META: Record<string, InsightKindMeta> = {
  'api-error': meta(AlertOctagon, '#fb7185'),
  'slow-endpoint': meta(Timer, '#fbbf24'),
  'long-dwell': meta(Hourglass, '#38bdf8'),
  'quick-exit': meta(DoorOpen, '#a78bfa'),
  'route-oscillation': meta(Repeat2, '#2dd4bf'),
};

const FALLBACK: InsightKindMeta = meta(Sparkles, '#94a3b8');

export function getInsightKindMeta(kind: string): InsightKindMeta {
  return INSIGHT_KIND_META[kind] ?? FALLBACK;
}
