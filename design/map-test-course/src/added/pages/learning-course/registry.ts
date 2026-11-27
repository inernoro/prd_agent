import { BookOpenText, Bug, Eye, FileText, FlaskConical, Network, PlayCircle, type LucideIcon } from 'lucide-react';
import type { FindingSeverity, LessonMediaKind, PracticeSkill } from './types';

/* 课程页的类型映射统一放在这里（注册表模式），组件里不写 switch。 */

export const MEDIA_REGISTRY: Record<LessonMediaKind, { label: string; icon: LucideIcon; unit: (n: number) => string }> = {
  video: { label: '视频', icon: PlayCircle, unit: n => formatClock(n) },
  pdf: { label: 'PDF 教材', icon: FileText, unit: n => `${n} 页` },
  article: { label: '图文', icon: BookOpenText, unit: n => `${n} 分钟` },
};

export const MEDIA_ORDER: LessonMediaKind[] = ['video', 'pdf', 'article'];

export const SKILL_REGISTRY: Record<PracticeSkill, { label: string; icon: LucideIcon; verb: string }> = {
  review: { label: '代码评审', icon: Bug, verb: '评审' },
  visual: { label: '视觉验收', icon: Eye, verb: '对照' },
  unit: { label: '单元测试', icon: FlaskConical, verb: '生成测试' },
  integration: { label: '联合测试', icon: Network, verb: '串链路' },
};

/* 严重级只用语义色 token，深浅主题各自成立 */
export const SEVERITY_REGISTRY: Record<FindingSeverity, { label: string; color: string }> = {
  P0: { label: 'P0 阻断', color: 'var(--accent-fg-error)' },
  P1: { label: 'P1 严重', color: 'var(--accent-fg-warning)' },
  P2: { label: 'P2 建议', color: 'var(--accent-fg-info)' },
};

export const PRACTICE_STEPS = [
  { key: 'brief', label: '读任务' },
  { key: 'review', label: 'Agent 检查' },
  { key: 'triage', label: '判断与修复' },
  { key: 'retest', label: '复测' },
  { key: 'deliver', label: '交付' },
] as const;

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.max(1, Math.round(sec))} 秒`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
}

/* 逐条判断的说法随练习类型变化，判定口径相同：采纳 = 应用修复 / 保留；驳回必须写理由 */
export const DECISION_REGISTRY: Record<PracticeSkill, { accept: string; reject: string; quickReasons: string[]; runLabel: string }> = {
  review: { accept: '采纳修复', reject: '驳回', runLabel: '评审', quickReasons: ['前提不成立：函数没有共享状态', '属于风格偏好，不影响结果', '不在本次范围，已登记后续'] },
  visual: { accept: '判为缺陷', reject: '在容差内', runLabel: '对照', quickReasons: ['偏差在 1px 容差内', '与设计稿一致', '不在本次改动范围'] },
  unit: { accept: '保留这条测试', reject: '删掉这条', runLabel: '生成测试', quickReasons: ['依赖当前时间，结果不稳定', '与已有测试重复', '断言的是实现细节'] },
  integration: { accept: '保留这条测试', reject: '删掉这条', runLabel: '串链路', quickReasons: ['打的是本地桩，不是真实部署', '与已有测试重复', '断言的是实现细节'] },
};
