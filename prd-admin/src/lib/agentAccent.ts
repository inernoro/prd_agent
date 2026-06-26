import * as LucideIcons from 'lucide-react';
import { Bot, type LucideIcon } from 'lucide-react';

/**
 * Agent 主题色 + 图标解析 —— 移动端各页共用的 SSOT。
 *
 * 之前 MobileHomePage 内联了一份 AGENT_ACCENT / accentFor / iconFor，
 * 移动端「发现」等页要复用同一套配色与图标解析，抽到这里统一维护，
 * 避免「首页一套色、发现页另一套色」的漂移（frontend-architecture SSOT）。
 *
 * 配色取 iOS System Colors 级（暗色不刺眼），与 appStoreTokens 同源。
 */
export const AGENT_ACCENT: Record<string, { from: string; to: string }> = {
  'prd-agent':        { from: '#0A84FF', to: '#64D2FF' }, // iOS Blue → Teal
  'visual-agent':     { from: '#BF5AF2', to: '#FF375F' }, // iOS Purple → Pink
  'visual-storyboard':{ from: '#FF375F', to: '#BF5AF2' }, // Pink → Purple
  'literary-agent':   { from: '#30D158', to: '#64D2FF' }, // iOS Green → Teal
  'defect-agent':     { from: '#FF9F0A', to: '#FF453A' }, // iOS Orange → Red
  'video-agent':      { from: '#FF375F', to: '#BF5AF2' }, // iOS Pink → Purple
  'report-agent':     { from: '#5E5CE6', to: '#0A84FF' }, // iOS Indigo → Blue
  'review-agent':     { from: '#FFD60A', to: '#FF9F0A' }, // iOS Yellow → Orange
  'pr-review':        { from: '#5E5CE6', to: '#64D2FF' }, // iOS Indigo → Teal
  'shortcuts-agent':  { from: '#FFD60A', to: '#FF9F0A' }, // iOS Yellow → Orange
  'transcript-agent': { from: '#FF375F', to: '#BF5AF2' }, // Pink → Purple
  'workflow-agent':   { from: '#30D158', to: '#64D2FF' }, // Green → Teal
  'arena':            { from: '#FF9F0A', to: '#FFD60A' }, // Orange → Yellow
};

export const DEFAULT_ACCENT = { from: '#0A84FF', to: '#5E5CE6' };

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
