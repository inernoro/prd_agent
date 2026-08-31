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
      ?? meta?.actualModel
      ?? fallback,
  ).trim();
}

/**
 * 只能被具体动作调用、不该出现在「选择模型」里的能力。
 *
 * 与后端 `GatewayCapabilityIds.IsOperationOnly` 同一份语义（token 两种写法都认：
 * Capabilities 数组是 snake_case，PublicId 是 kebab-case）。
 * 后端已经过滤过一遍，这里是第二道闸——旧后端配新前端时，
 * 「图片分层」不能因为服务端没升级就重新漏进模型列表。
 */
const OPERATION_ONLY_TOKENS = new Set([
  'image_layering',
  'image-layering',
]);

/**
 * 这条池子是「用户可以挑来生图的模型」吗？
 *
 * 判据同时看 code（逻辑模型 PublicId）与 capabilities，两个信号任一命中即判为动作能力：
 * 不同来源填的字段不一样，只认一个就会漏。
 */
export function isOperationOnlyPool(pool: Pick<ModelGroupForApp, 'code' | 'capabilities'>): boolean {
  const code = String(pool.code ?? '').trim().toLowerCase();
  if (code && OPERATION_ONLY_TOKENS.has(code)) return true;
  return (pool.capabilities ?? []).some(
    (capability) => OPERATION_ONLY_TOKENS.has(String(capability ?? '').trim().toLowerCase()),
  );
}

export function buildVisualAgentModelOptions(pools: ModelGroupForApp[]): VisualAgentModelOption[] {
  return pools.filter((pool) => pool.resolutionType === 'LogicalModel' && !isOperationOnlyPool(pool)).flatMap((pool) => {
    const members = pool.models ?? [];
    const preferredMember = members.find((member) => member.healthStatus === 'Healthy')
      ?? members.find((member) => member.healthStatus === 'Degraded')
      ?? members[0];
    return {
      id: `pool_${pool.id}`,
      name: pool.name,
      modelName: pool.code,
      actualModelId: pool.code,
      platformId: 'logical-model',
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
