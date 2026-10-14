import type { ModelItem, ModelOfferingItem, PlatformItem } from './types';

/** 按物理模型真实 platformId 汇总。缺失目标与 Exchange 按目标身份保留，不用同名猜绑定。 */
export function groupModelProviders(offerings: readonly ModelOfferingItem[], models: readonly ModelItem[], platforms: readonly PlatformItem[]) {
  const modelById = new Map(models.map((item) => [item.id, item]));
  const platformById = new Map(platforms.map((item) => [item.id, item]));
  const groups = new Map<string, { id: string; platformId?: string; name: string; targetKind: 'model' | 'exchange'; offerings: ModelOfferingItem[] }>();
  for (const offering of offerings) {
    const model = offering.targetKind === 'model' ? modelById.get(offering.targetId) : undefined;
    const platformId = model?.platformId || undefined;
    const platform = platformId ? platformById.get(platformId) : undefined;
    const id = platformId ? `platform:${platformId}` : `${offering.targetKind}:${offering.targetId}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, platformId, name: platform?.name || offering.providerName || offering.targetName || offering.targetId, targetKind: offering.targetKind, offerings: [] };
      groups.set(id, group);
    }
    group.offerings.push(offering);
  }
  return [...groups.values()];
}
