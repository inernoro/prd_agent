/**
 * monitor-environment —— 监控「在哪个环境」的**唯一判定源**。
 *
 * 为什么要有它：用户的原话是「测试环境、正式环境下，主分支的健康状态」。
 * 也就是说他脑子里的第一维不是「这是哪个探测目标」，而是「这是哪个环境」——
 * 同一条业务在四个环境的红绿摆在一起，**对比本身就是归因**：
 * 只有预发红 = 那个环境的配置问题；四个都红 = 这次改动的问题。
 *
 * 环境枚举刻意复用 release-environment 的三档（生产 / 预发 / 其他），
 * 只多一档 `preview`（分支预览）。不另起一套的理由是：发布目标的环境已经由
 * 用户在发布中心配好了，监控再定义第二套枚举，同一个目标就会在两个页面
 * 落进不同的环境，而且不会有任何东西变红（判据分裂，形状 3）。
 */

import {
  normalizeReleaseEnvironment,
  releaseEnvironmentLabel,
  type ReleaseEnvironment,
} from './release-environment.js';

/** 发布环境三档 + 分支预览。分支预览是结构性的，不由用户在发布中心配。 */
export type MonitorEnvironment = ReleaseEnvironment | 'preview';

/** 展示顺序 = 关注度顺序：生产最前，分支预览垫底（默认不打扰项目负责人）。 */
export const MONITOR_ENVIRONMENT_ORDER: readonly MonitorEnvironment[] = [
  'production',
  'staging',
  'other',
  'preview',
];

/** 一个字的环境缩写，给业务卡上那排小格子用（横向空间只够一个字）。 */
const SHORT_LABELS: Record<MonitorEnvironment, string> = {
  production: '正',
  staging: '预',
  other: '他',
  preview: '支',
};

export function monitorEnvironmentLabel(value: MonitorEnvironment): string {
  return value === 'preview' ? '分支预览' : releaseEnvironmentLabel(value);
}

export function monitorEnvironmentShortLabel(value: MonitorEnvironment): string {
  return SHORT_LABELS[value];
}

/**
 * 归一：只认四个字面量，其余（含 undefined / 未知字符串）一律 production。
 * 与 normalizeReleaseEnvironment 完全同口径，只是多认一个 preview。
 */
export function normalizeMonitorEnvironment(value: unknown): MonitorEnvironment {
  if (value === 'preview') return 'preview';
  return normalizeReleaseEnvironment(value);
}

export interface MonitorEnvironmentInput {
  /** 探测目标来源（与 uptime-monitor 的 ProbeSource 同枚举）。分支预览来的一律是 preview。 */
  source: 'branch' | 'release' | 'custom';
  /** 自定义监控自己声明的环境 */
  declared?: unknown;
  /**
   * 服务端反查出来的「地址落在哪条分支预览上」。有值即证明它指着一条分支预览。
   * boundBranchId 也算数（Agent 自助登记的存量数据只有它）。
   */
  previewBranchId?: string | null;
  boundBranchId?: string | null;
  /** 发布目标上的环境字段（source = release 时才有意义） */
  releaseEnvironment?: unknown;
}

/**
 * 判定一个探测目标属于哪个环境。
 *
 * 顺序是**结构性证据优先于声明**：地址指着一条分支预览时，不管它自称什么，
 * 它就是分支预览。否则一条 Agent 自助登记的监控只要把 environment 填成
 * production，就能混进项目负责人的第一屏，那正是用户担心的
 * 「临时分支把自己的错误预览地址加进去」。
 */
export function resolveMonitorEnvironment(input: MonitorEnvironmentInput): MonitorEnvironment {
  if (input.source === 'branch') return 'preview';
  if (input.previewBranchId || input.boundBranchId) return 'preview';
  if (input.source === 'release') return normalizeReleaseEnvironment(input.releaseEnvironment);
  return normalizeMonitorEnvironment(input.declared);
}
