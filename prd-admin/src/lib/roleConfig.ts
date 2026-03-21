import type { LucideIcon } from 'lucide-react';
import {
  Crown,
  Code,
  FlaskConical,
  Briefcase,
  Calculator,
  Cpu,
  TestTube2,
  PenTool,
  Handshake,
  Headset,
  TrendingUp,
  UserCog,
} from 'lucide-react';
import type { UserRole } from '@/types/admin';

export type RoleMeta = {
  /** 中文标签 */
  label: string;
  /** lucide-react 图标组件 */
  icon: LucideIcon;
  /** 主色调（用于文字、图标） */
  color: string;
  /** 背景色（带透明度） */
  bg: string;
  /** 边框色（带透明度） */
  border: string;
};

/**
 * 所有角色的元数据注册表
 * 颜色和图标统一在此维护，各页面引用此处
 */
export const ROLE_META: Record<UserRole, RoleMeta> = {
  ADMIN:      { label: '管理员',   icon: Crown,        color: 'rgba(251,191,36,0.95)',  bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.25)' },
  PM:         { label: '产品',     icon: Briefcase,    color: 'rgba(59,130,246,0.95)',  bg: 'rgba(59,130,246,0.12)',  border: 'rgba(59,130,246,0.25)' },
  DEV:        { label: '开发',     icon: Code,         color: 'rgba(34,197,94,0.95)',   bg: 'rgba(34,197,94,0.12)',   border: 'rgba(34,197,94,0.25)' },
  QA:         { label: '测试',     icon: FlaskConical, color: 'rgba(168,85,247,0.95)',  bg: 'rgba(168,85,247,0.12)',  border: 'rgba(168,85,247,0.25)' },
  HR:         { label: '行政',     icon: UserCog,      color: 'rgba(236,72,153,0.95)',  bg: 'rgba(236,72,153,0.10)',  border: 'rgba(236,72,153,0.25)' },
  FINANCE:    { label: '财务',     icon: Calculator,   color: 'rgba(245,158,11,0.95)',  bg: 'rgba(245,158,11,0.10)',  border: 'rgba(245,158,11,0.25)' },
  RD:         { label: '研发',     icon: Cpu,          color: 'rgba(6,182,212,0.95)',   bg: 'rgba(6,182,212,0.10)',   border: 'rgba(6,182,212,0.25)' },
  TEST:       { label: '测试',     icon: TestTube2,    color: 'rgba(139,92,246,0.95)',  bg: 'rgba(139,92,246,0.10)',  border: 'rgba(139,92,246,0.25)' },
  COPYWRITER: { label: '文案',     icon: PenTool,      color: 'rgba(244,63,94,0.95)',   bg: 'rgba(244,63,94,0.10)',   border: 'rgba(244,63,94,0.25)' },
  CSM:        { label: '客成经理', icon: Handshake,    color: 'rgba(16,185,129,0.95)',  bg: 'rgba(16,185,129,0.10)',  border: 'rgba(16,185,129,0.25)' },
  SUPPORT:    { label: '客服',     icon: Headset,      color: 'rgba(99,102,241,0.95)',  bg: 'rgba(99,102,241,0.10)',  border: 'rgba(99,102,241,0.25)' },
  SALES:      { label: '销售',     icon: TrendingUp,   color: 'rgba(249,115,22,0.95)',  bg: 'rgba(249,115,22,0.10)',  border: 'rgba(249,115,22,0.25)' },
};

/** 所有角色 key 的有序数组（用于下拉选择器等） */
export const ALL_ROLES: UserRole[] = Object.keys(ROLE_META) as UserRole[];

/** 兼容旧的 ROLE_COLORS 格式（bg/border/text） */
export const ROLE_COLORS: Record<string, { bg: string; border: string; text: string }> = Object.fromEntries(
  Object.entries(ROLE_META).map(([key, m]) => [key, { bg: m.bg, border: m.border, text: m.color }])
);

/** 获取角色元数据（未知角色返回默认值） */
export function getRoleMeta(role: string): RoleMeta {
  return ROLE_META[role as UserRole] ?? ROLE_META.DEV;
}
