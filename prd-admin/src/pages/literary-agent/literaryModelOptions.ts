import { isModelAvailableForRequest } from '@/lib/modelAvailability';
import type { LiteraryAgentModelPool } from '@/services/contracts/literaryAgentConfig';

export type LiteraryModelOption = {
  poolId: string;
  id: string;
  name: string;
  modelName: string;
  actualModelId: string;
  platformId: string;
  actualPlatformId: string;
  enabled: boolean;
  isDedicated: boolean;
  isDefault: boolean;
  isAutoResolved?: boolean;
};

const INTERNAL_ROUTE_ID = /^(?:default-|pool[_-]|logical[_-])/i;

function officialModelId(pool: LiteraryAgentModelPool): string | null {
  const first = pool.models?.[0];
  if (!first) return null;

  const actual = first.actualModelId?.trim();
  if (actual) return actual;

  const fallback = first.modelId?.trim();
  if (!fallback || INTERNAL_ROUTE_ID.test(fallback)) return null;
  return fallback;
}

/**
 * 业务选择器只展示实际上游型号。pool.code/default-* 是路由契约，不是模型名称。
 */
export function buildLiteraryModelOptions(pools: LiteraryAgentModelPool[]): LiteraryModelOption[] {
  const poolsWithMembers = pools.filter((pool) => pool.models && pool.models.length > 0);
  const availabilityRank = new Map(poolsWithMembers.map((pool) => [
    pool.id, pool.models.some((model) => model.healthStatus === 'Healthy') ? 0
      : pool.models.some((model) => model.healthStatus === 'Degraded') ? 1 : 2,
  ]));
  const bestActualModels = new Map<string, LiteraryModelOption>();

  const candidates = poolsWithMembers
    .map((pool): LiteraryModelOption | null => {
      const first = pool.models[0]!;
      const displayModelId = officialModelId(pool);
      if (!displayModelId) return null;

      return {
        poolId: pool.id,
        id: `pool_${pool.id}`,
        name: displayModelId,
        // 运行时仍提交逻辑 PublicId；它不能泄漏到用户展示层。
        modelName: pool.code || first.modelId,
        actualModelId: displayModelId,
        platformId: first.platformId,
        actualPlatformId: first.actualPlatformId || first.platformId,
        enabled: pool.models.some(isModelAvailableForRequest),
        isDedicated: pool.isDedicated,
        isDefault: pool.isDefault,
      };
    })
    .filter((model): model is LiteraryModelOption => model !== null && model.enabled);
  for (const model of candidates) {
    const identity = `${model.actualPlatformId}:${model.actualModelId}`;
    const previous = bestActualModels.get(identity);
    const rank = availabilityRank.get(model.poolId)!;
    const previousRank = previous && availabilityRank.get(previous.poolId)!;
    if (!previous || rank < previousRank! || (rank === previousRank && model.poolId < previous.poolId)) {
      bestActualModels.set(identity, model);
    }
  }
  return [...bestActualModels.values()];
}

/**
 * 用户显式选择优先；无偏好时使用网关目录标记的默认模型。
 * 目录排序只影响展示，不能偷换默认语义。
 */
export function selectLiteraryModelOption(
  options: LiteraryModelOption[],
  selectedId?: string | null,
): LiteraryModelOption | null {
  const selected = selectedId ? options.find((model) => model.id === selectedId) : null;
  return selected ?? options.find((model) => model.isDefault) ?? options[0] ?? null;
}
