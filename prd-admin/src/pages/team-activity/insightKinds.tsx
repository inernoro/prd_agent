/**
 * 行为洞察类型注册表（颜色 + 图标）。kind 文案（kindLabel）由后端下发，
 * 前端只维护视觉映射；未知 kind 走兜底，永不崩溃。
 */
import { AlertOctagon, DoorOpen, Hourglass, Repeat2, Timer, Sparkles, type LucideIcon } from 'lucide-react';

export type InsightKindMeta = {
  icon: LucideIcon;
  accent: string;
  soft: string;
  text: string;
};

const meta = (icon: LucideIcon, accent: string, text: string): InsightKindMeta => ({
  icon,
  accent,
  soft: `${accent}1f`,
  text,
});

export const INSIGHT_KIND_META: Record<string, InsightKindMeta> = {
  'api-error': meta(AlertOctagon, '#fb7185', 'var(--semantic-danger-text)'),
  'slow-endpoint': meta(Timer, '#fbbf24', 'var(--semantic-warning-text)'),
  'long-dwell': meta(Hourglass, '#38bdf8', 'var(--semantic-info-text)'),
  'quick-exit': meta(DoorOpen, '#a78bfa', 'var(--semantic-purple-text)'),
  'route-oscillation': meta(Repeat2, '#2dd4bf', 'var(--semantic-cyan-text)'),
};

const FALLBACK: InsightKindMeta = meta(Sparkles, '#94a3b8', 'var(--semantic-neutral-text)');

export function getInsightKindMeta(kind: string): InsightKindMeta {
  return INSIGHT_KIND_META[kind] ?? FALLBACK;
}
