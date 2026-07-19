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
};

const IMAGE_MODEL_LABELS: Record<string, string> = {
  'openai/gpt-image-2': 'OpenAI GPT Image 2',
  'google/gemini-3.1-flash-image': 'Google Nano Banana 2',
  'google/gemini-3.1-flash-lite-image': 'Google Nano Banana 2 Lite',
};

function modelLabel(modelId: string): string {
  return IMAGE_MODEL_LABELS[modelId.trim().toLowerCase()] ?? modelId;
}

export function buildVisualAgentModelOptions(pools: ModelGroupForApp[]): VisualAgentModelOption[] {
  return pools.flatMap((pool) => {
    const members = pool.models ?? [];
    return members.map((member) => ({
      id: `pool_${pool.id}::${member.platformId}::${member.modelId}`,
      name: members.length === 1 ? pool.name : modelLabel(member.modelId),
      modelName: member.modelId,
      actualModelId: member.modelId,
      platformId: member.platformId,
      enabled: member.healthStatus === 'Healthy' || member.healthStatus === 'Degraded',
      isMain: false,
      isImageGen: true,
      enablePromptCache: false,
      priority: pool.priority * 1000 + member.priority,
      resolutionType: pool.resolutionType,
      isDedicated: pool.isDedicated,
      isDefault: pool.isDefault,
      isLegacy: pool.isLegacy,
      description: pool.description,
      poolCode: pool.code,
      poolName: pool.name,
    }));
  });
}
