import type { DesignTheme } from './design-workspace.js';

export const designHandoffPolicy = 'prototype-v1';
// A full draft can declare 80 screens, each with light and dark variants.
export const designHandoffCaseLimit = 160;
export const designHandoffChecks = [
  'text', 'value', 'attribute', 'visible', 'enabled', 'media-playing', 'audio-playing', 'fullscreen',
] as const;
export type DesignHandoffCheck = typeof designHandoffChecks[number];
export type DesignHandoffRead = 'text' | 'value' | 'attribute';
type Target = { selector: string };
export type DesignHandoffStep =
  | (Target & { action: 'click' })
  | (Target & { action: 'fill' | 'select'; value: string })
  | (Target & { action: 'attach'; name: string; value: string })
  | (Target & { action: 'remember'; check: DesignHandoffRead; attribute?: string; as: string })
  | (Target & { action: 'expect'; check: DesignHandoffCheck; attribute?: string; equals?: string | boolean; sameAs?: string });
export type DesignHandoffCase = {
  id: string; title: string; screenId: string; ruleIds: string[]; theme: DesignTheme; steps: DesignHandoffStep[];
};
export type DesignHandoffPlan = { cases: DesignHandoffCase[] };
export const designHandoffFailureCodes = ['entry', 'control', 'expectation', 'host-capability', 'runtime'] as const;
export type DesignHandoffFailureCode = typeof designHandoffFailureCodes[number];
export type DesignHandoffCaseResult = { caseId: string } & (
  | { status: 'passed'; step?: never; code?: never }
  | { status: 'failed'; step: number; code: 'entry' | 'control' | 'expectation' }
  | { status: 'unavailable'; step?: number; code: 'host-capability' | 'runtime' }
);
export type DesignHandoffCaseReceipt = DesignHandoffCaseResult & {
  title: string; screenId: string; ruleIds: string[]; theme: DesignTheme;
  owner?: 'design' | 'cds'; message?: string;
};
export type DesignHandoffReceipt = {
  status: 'passed' | 'failed' | 'unavailable'; policy: typeof designHandoffPolicy;
  id: string; binding: string; checkedAt: string; cases: DesignHandoffCaseReceipt[];
};
export type DesignHandoffState = DesignHandoffReceipt | {
  status: 'missing-plan' | 'pending' | 'running' | 'unavailable' | 'legacy'; checkedAt?: never; cases?: never;
};

export const designHandoffStatusNames: Record<DesignHandoffState['status'], string> = {
  'missing-plan': '待补交接场景',
  legacy: '沿用已定基线',
  pending: '待运行',
  running: '检查中',
  passed: '可交给实施',
  failed: '交接检查未通过',
  unavailable: '检查环境暂不可用',
};
export const designHandoffFailureMessages: Record<DesignHandoffFailureCode, string> = {
  entry: '原型未到达声明的画面。请核对入口和就绪状态。',
  control: '该步找不到唯一可操作的控件。请核对进入状态、控件编号和遮挡。',
  expectation: '操作结果与场景的预期不符。请按该步复现并修正。',
  'host-capability': 'CDS 内嵌预览不支持该动作。请使用 CDS 的大屏入口，或补充可在原型内运行的交互。',
  runtime: '隔离浏览器暂未完成此场景。请沿用本版重新检查。',
};
