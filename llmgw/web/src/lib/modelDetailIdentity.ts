import type { LogicalModelItem, ModelItem, ModelOfferingItem, PlatformItem } from './types';

export function providerForDetail(items: readonly PlatformItem[], id: string, name: string) {
  return items.find((item) => id ? item.id === id : item.name === name) ?? null;
}
export function logicalForDetail(items: readonly LogicalModelItem[], logicalId: string, physicalId: string, name: string) {
  if (physicalId) return null;
  if (logicalId) return items.find((item) => item.id === logicalId) ?? null;
  return items.find((item) => item.publicId === name) ?? items.find((item) => item.name === name) ?? null;
}
export function physicalForDetail(items: readonly ModelItem[], id: string, platformId: string, name: string) {
  return items.filter((item) => (id ? item.id === id : item.id === name || item.modelName === name || item.name === name) && (!platformId || item.platformId === platformId));
}
export function traceRouteStatus(route: ModelOfferingItem) {
  return route.skipReason || (route.healthStatus === 1 ? `降级 · 连续失败 ${route.consecutiveFailures} 次` : '健康');
}

/** 配置开关与参与状态分开表达，不用绿色开关掩盖服务端跳过原因。 */
export function offeringParticipationStatus(route: ModelOfferingItem): { label: string; tone: 'good' | 'warning'; detail: string } {
  if (!route.enabled) return { label: '线路停用', tone: 'warning', detail: route.skipReason || '线路开关已关闭' };
  if (route.skipReason) return { label: '不可参与', tone: 'warning', detail: route.skipReason };
  if (route.healthStatus === 1) return { label: '降级', tone: 'warning', detail: traceRouteStatus(route) };
  return { label: '线路启用', tone: 'good', detail: traceRouteStatus(route) };
}
