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
  const seenActualModels = new Set<string>();

  return pools
    .filter((pool) => pool.models && pool.models.length > 0)
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
        enabled: pool.models.some((model) => model.healthStatus === 'Healthy' || model.healthStatus === 'Degraded'),
        isDedicated: pool.isDedicated,
        isDefault: pool.isDefault,
      };
    })
    .filter((model): model is LiteraryModelOption => model !== null && model.enabled)
    .filter((model) => {
      const identity = `${model.actualPlatformId}:${model.actualModelId}`;
      if (seenActualModels.has(identity)) return false;
      seenActualModels.add(identity);
      return true;
    });
}

