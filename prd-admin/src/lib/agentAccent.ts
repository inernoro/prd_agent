import * as LucideIcons from 'lucide-react';
import { Bot, type LucideIcon } from 'lucide-react';

/**
 * Agent 主题色 + 图标解析 —— 移动端各页共用的 SSOT。
 *
 * 之前 MobileHomePage 内联了一份 AGENT_ACCENT / accentFor / iconFor，
 * 移动端「发现」等页要复用同一套配色与图标解析，抽到这里统一维护，
 * 避免「首页一套色、发现页另一套色」的漂移（frontend-architecture SSOT）。
 *
 * 配色取米多墨系八色带（陶土/焦糖/琥珀/橄榄/松绿/黛青/钢青/钢蓝），
 * 与桌面 lib/tileAccent 同一支笔；紫、靛、品红不在色带内。
 */
export const AGENT_ACCENT: Record<string, { from: string; to: string }> = {
  'prd-agent':        { from: '#37708A', to: '#6BA3B8' }, // iOS Blue → Teal
  'visual-agent':     { from: '#C8623A', to: '#E0956B' }, // iOS Purple → Pink
  'visual-storyboard':{ from: '#B0522E', to: '#D98F6B' }, // Pink → Purple
  'literary-agent':   { from: '#3F7A5E', to: '#68A385' }, // iOS Green → Teal
  'defect-agent':     { from: '#A8703C', to: '#D2A25E' }, // iOS Orange → Red
  'video-agent':      { from: '#C05B3C', to: '#D9A05E' }, // iOS Pink → Purple
  'report-agent':     { from: '#3B5F8A', to: '#6B8DB8' }, // iOS Indigo → Blue
  'review-agent':     { from: '#A8842F', to: '#D9B85C' }, // iOS Yellow → Orange
  'pr-review':        { from: '#3B5F8A', to: '#6BA9A2' }, // iOS Indigo → Teal
  'shortcuts-agent':  { from: '#A8842F', to: '#D9B85C' }, // iOS Yellow → Orange
  'transcript-agent': { from: '#37708A', to: '#6BA3B8' }, // Pink → Purple
  'workflow-agent':   { from: '#3B7A75', to: '#6BA9A2' }, // Green → Teal
  'arena':            { from: '#A8842F', to: '#D9A05E' }, // Orange → Yellow
  'document-store':   { from: '#6F7A3C', to: '#9BA85E' }, // Orange → 浅橙(知识库,recent-work 后端会返回该 key)
};

export const DEFAULT_ACCENT = { from: '#3B5F8A', to: '#6B8DB8' };

/** 按 agentKey 取主题色，未登记的回落默认蓝→靛 */
export function accentFor(agentKey?: string): { from: string; to: string } {
  if (!agentKey) return DEFAULT_ACCENT;
  return AGENT_ACCENT[agentKey] ?? DEFAULT_ACCENT;
}

/** 按 Lucide 图标名解析组件，未知名回落 Bot */
export function iconFor(iconName?: string): LucideIcon {
  if (!iconName) return Bot;
  const icons = LucideIcons as unknown as Record<string, LucideIcon>;
  return icons[iconName] ?? Bot;
}
