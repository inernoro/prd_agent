/**
 * 验收结论徽章注册表（design.acceptance.kb.md §5.A）
 *
 * 验收报告条目的 verdict 存在 entry.metadata.verdict（pass/conditional/fail），
 * 由 create-visual-test-to-kb 技能归档时写入。本注册表把 verdict 映射为列表里的
 * 状态徽章配置，避免在组件里硬编码 switch（遵守 frontend-architecture.md 注册表模式）。
 *
 * 颜色走 DocBrowser 既有的 rgba 内联风格（与 NEW / 已分享 徽章一致）。
 */

/** 与后端 AcceptanceTemplateRegistry.AcceptanceReportV2 约定一致 */
export const ACCEPTANCE_TEMPLATE_KEY = 'acceptance-report-v2';

export type AcceptanceVerdict = 'pass' | 'conditional' | 'fail';

export interface VerdictBadgeConfig {
  /** 徽章文案 */
  label: string;
  background: string;
  color: string;
  border: string;
}

export const ACCEPTANCE_VERDICT_REGISTRY: Record<AcceptanceVerdict, VerdictBadgeConfig> = {
  pass: {
    label: '通过',
    background: 'rgba(34,197,94,0.14)',
    color: 'rgba(74,222,128,0.95)',
    border: '1px solid rgba(34,197,94,0.3)',
  },
  conditional: {
    label: '有条件',
    background: 'rgba(234,179,8,0.14)',
    color: 'rgba(234,179,8,0.95)',
    border: '1px solid rgba(234,179,8,0.32)',
  },
  fail: {
    label: '不通过',
    background: 'rgba(239,68,68,0.14)',
    color: 'rgba(248,113,113,0.95)',
    border: '1px solid rgba(239,68,68,0.32)',
  },
};

/** 取 verdict 对应徽章配置；未知/缺失返回 null（优雅降级，不渲染） */
export function getVerdictConfig(verdict?: string | null): VerdictBadgeConfig | null {
  if (!verdict) return null;
  const key = verdict.trim().toLowerCase() as AcceptanceVerdict;
  return ACCEPTANCE_VERDICT_REGISTRY[key] ?? null;
}
