import type { Model } from '@/types/admin';
import type { ModelGroupForApp } from '@/types/modelGroup';

export type VisualAgentModelOption = Model & {
  resolutionType?: ModelGroupForApp['resolutionType'];
  isDedicated?: boolean;
  isDefault?: boolean;
  isLegacy?: boolean;
  actualModelId?: string;
  subtitle?: string;
  description?: string;
  recommended?: boolean;
  poolCode?: string;
  poolName?: string;
  recentTenRequests?: number;
  recentTenSuccessRatePercent?: number | null;
  averageDurationMs?: number | null;
};

export type VisualResultModelMeta = {
  logicalModelPublicId?: string;
  modelPool?: string;
  actualModelPool?: string;
  actualModel?: string;
};

/**
 * 视觉创作的主展示只认应用选择的逻辑模型；上游模型仅作为旧任务兜底，
 * 避免 Provider / Offering 细节重新泄漏回应用模型列表。
 */
export function resolveVisualResultModelLabel(
  meta: VisualResultModelMeta | null | undefined,
  fallback = '',
): string {
  return String(
    meta?.logicalModelPublicId
      ?? meta?.modelPool
      ?? meta?.actualModelPool
      ?? meta?.actualModel
      ?? fallback,
  ).trim();
}

export function buildVisualAgentModelOptions(pools: ModelGroupForApp[]): VisualAgentModelOption[] {
  return pools.map((pool) => {
    const members = pool.models ?? [];
    const preferredMember = members.find((member) => member.healthStatus === 'Healthy')
      ?? members.find((member) => member.healthStatus === 'Degraded')
      ?? members[0];
    const logicalModel = pool.resolutionType === 'LogicalModel';
    return {
      id: `pool_${pool.id}`,
      name: pool.name,
      modelName: logicalModel ? (preferredMember?.modelId || pool.code) : pool.id,
      actualModelId: preferredMember?.modelId,
      platformId: logicalModel ? 'logical-model' : 'model-pool',
      enabled: members.some((member) => member.healthStatus === 'Healthy' || member.healthStatus === 'Degraded'),
      isMain: false,
      isImageGen: true,
      enablePromptCache: false,
      priority: pool.priority * 1000 + (preferredMember?.priority ?? 0),
      resolutionType: pool.resolutionType,
      isDedicated: pool.isDedicated,
      isDefault: pool.isDefault,
      isLegacy: pool.isLegacy,
      description: pool.description,
      poolCode: pool.code,
      poolName: pool.name,
      recentTenRequests: pool.recentTenRequests,
      recentTenSuccessRatePercent: pool.recentTenSuccessRatePercent,
      averageDurationMs: pool.averageDurationMs,
      subtitle: [
        pool.averageDurationMs == null ? null : `平均 ${(pool.averageDurationMs / 1000).toFixed(1)} 秒`,
        pool.recentTenSuccessRatePercent == null ? null : `近 ${pool.recentTenRequests ?? 0} 次成功率 ${pool.recentTenSuccessRatePercent}%`,
      ].filter(Boolean).join(' · '),
    };
  });
}
