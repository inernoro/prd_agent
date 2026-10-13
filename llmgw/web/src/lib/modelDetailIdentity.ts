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
