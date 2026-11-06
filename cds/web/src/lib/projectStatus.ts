import { inspectionOverdue } from '../../../src/services/project-inspections';
import type { ProjectInspection } from '../../../src/services/project-inspections';
import type { UptimeTargetSummary } from './monitorCenter';
export type { ProjectInspection } from '../../../src/services/project-inspections';
export type CheckState = 'up' | 'down' | 'unknown' | 'paused' | 'overdue';
export function inspectionState(inspection: ProjectInspection, now: number): CheckState {
  if (!inspection.enabled) return 'paused';
  if (inspection.checks.some(c => c.outcome === 'fail')) return 'down';
  if (inspectionOverdue(inspection, now)) return 'overdue';
  if (!inspection.lastCompletedAt) return 'unknown';
  if (inspection.checks.some(c => c.outcome !== 'pass')) return 'unknown';
  return 'up';
}
export function frequency(seconds: number): string {
  if (seconds >= 86400 && seconds % 86400 === 0) return `每 ${seconds / 3600} 小时`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `每 ${seconds / 3600} 小时`;
  if (seconds >= 60 && seconds % 60 === 0) return `每 ${seconds / 60} 分钟`;
  return `每 ${seconds} 秒`;
}
const PURPOSE: Record<string, string> = {
  'model-catalog.selector-runtime-contract': '检查页面让人选择的模型，运行时是否真的能够调度。',
  'mongo.required-indexes': '检查关键数据库索引是否齐全，缺失会影响查询速度和稳定性。',
  'model-leaderboard.staleness': '检查模型排行榜是否按时更新，避免展示过时信息。',
  'visual-image.default-route': '检查文字生图和参考图编辑是否都有可用的模型线路。',
  'visual-image.recent-outcomes': '观察最近真实生图有没有失败；不是重新调用所有模型。',
  'visual-image.latency': '观察最近成功生图花了多久，判断用户等待是否过长。',
  'visual-image.requests': '确认最近有人实际发起生图；没有请求时不能据此判断生图好坏。',
  'api.requests': '确认后端最近收到了实际请求；有流量不等于每个功能都通过。',
  'serving.requests': '确认模型网关最近有实际调用；不能代替逐个模型实测。',
  'api.unhandled-exceptions': '观察后端近期有没有未被处理的程序异常。',
  'serving.unhandled-exceptions': '观察模型网关近期有没有未被处理的程序异常。',
  'db.roundtrip': '实测数据库来回一次需要多久，判断数据读取是否明显变慢。',
  'deployment.version-match': '核对当前运行版本和发布记录是否一致，发现未生效或被覆盖的发布。',
};
export function checkPurpose(target: UptimeTargetSummary): string {
  if (target.healthCheck?.componentId.startsWith('inspection.freshness.')) return '监督巡检有没有按时完成并回填各项结果；任务停摆或漏项逾期时告警，不会再次调用付费模型。';
  if (target.healthCheck && PURPOSE[target.healthCheck.componentId]) return PURPOSE[target.healthCheck.componentId];
  if (target.collectionMembers) return '检查业务自检数据能否采集；采集成功不等于内部每项业务都正常。';
  if (target.source === 'branch') return '检查分支预览服务是否可访问，供开发验收使用。';
  if (target.source === 'release') return '检查正式站点入口是否可访问。';
  return target.observeMode === 'passive' ? '读取最近真实业务记录，观察这项业务的运行结果。' : '按配置执行这项检查，详细判据可在检查详情中查看。';
}
export const EVENT_NAMES: Record<string, string> = { 'business-down': '业务异常', 'business-recovered': '业务恢复', 'infra-down': '基础设施异常', 'infra-recovered': '基础设施恢复', recovered: '业务恢复' };
export interface ChannelStatus { id: string; name: string; kind: string; status: string; enabled: boolean; projects: string[]; events: string[]; last?: { at: number; ok: boolean }; }
export function projectChannels(channels: ChannelStatus[] | undefined, projectId: string): ChannelStatus[] | undefined {
  return channels?.filter(c => !c.projects.length || c.projects.includes(projectId));
}

export function inspectionCheckLabel(inspection: ProjectInspection, check: ProjectInspection['checks'][number], now: number): string {
  const state = inspectionState(inspection, now);
  if (check.outcome === 'pass' && state === 'overdue') return '上次通过，结果已过期';
  if (check.outcome === 'pass' && state === 'paused') return '上次通过，计划已暂停';
  if (!inspection.lastCompletedAt) return '未确认';
  return check.outcome === 'pass' ? '实测通过' : check.outcome === 'fail' ? '实测失败' : check.outcome === 'skipped' ? '未执行' : '未确认';
}

const CHECK_TITLES: Record<string, string> = {
 'model-catalog.selector-runtime-contract': '页面可选的模型能否真正运行',
 'mongo.required-indexes': '数据库关键索引是否齐全',
 'model-leaderboard.staleness': '模型排行榜是否按时更新',
 'visual-image.default-route': '生图是否有可用线路',
 'visual-image.recent-outcomes': '最近的生图任务是否成功',
 'visual-image.latency': '生图等待是否过长',
 'visual-image.requests': '最近是否有人实际生图',
 'api.requests': '网站后端是否有真实请求',
 'serving.requests': '模型网关是否有真实调用',
 'api.unhandled-exceptions': '网站后端是否出现程序异常',
 'serving.unhandled-exceptions': '模型网关是否出现程序异常',
 'db.roundtrip': '数据库响应是否过慢',
 'deployment.version-match': '线上版本是否与发布记录一致',
};
export function checkTitle(target: UptimeTargetSummary): string {
 if (target.healthCheck && CHECK_TITLES[target.healthCheck.componentId]) return CHECK_TITLES[target.healthCheck.componentId];
 if (target.collectionMembers) return `检查数据能否采集（${frequency(target.intervalSeconds)}）`;
 return target.name;
}
