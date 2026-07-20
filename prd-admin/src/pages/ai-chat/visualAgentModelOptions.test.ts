import { describe, expect, it } from 'vitest';
import { ModelHealthStatus, PoolStrategyType, type ModelGroupForApp } from '@/types/modelGroup';
import { buildVisualAgentModelOptions } from './visualAgentModelOptions';

function pool(models: ModelGroupForApp['models']): ModelGroupForApp {
  return {
    id: 'image-test-pool',
    name: '视觉创作测试池',
    code: 'visual-creation-image-test',
    priority: 10,
    modelType: 'generation',
    isDefaultForType: true,
    strategyType: PoolStrategyType.Sequential,
    models,
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: '2026-07-20T00:00:00Z',
    resolutionType: 'GatewayRegistryPool',
    isDedicated: true,
    isDefault: false,
    isLegacy: false,
  };
}

describe('buildVisualAgentModelOptions', () => {
  it('把网关池内的三个成员展开为可精确选择的模型', () => {
    const options = buildVisualAgentModelOptions([
      pool([
        { modelId: 'openai/gpt-image-2', platformId: 'openrouter', priority: 10, healthStatus: ModelHealthStatus.Healthy, consecutiveFailures: 0, consecutiveSuccesses: 1 },
        { modelId: 'google/gemini-3.1-flash-image', platformId: 'openrouter', priority: 20, healthStatus: ModelHealthStatus.Healthy, consecutiveFailures: 0, consecutiveSuccesses: 1 },
        { modelId: 'google/gemini-3.1-flash-lite-image', platformId: 'openrouter', priority: 30, healthStatus: ModelHealthStatus.Degraded, consecutiveFailures: 1, consecutiveSuccesses: 0 },
      ]),
    ]);

    expect(options.map((item) => item.name)).toEqual([
      'OpenAI GPT Image 2',
      'Google Nano Banana 2',
      'Google Nano Banana 2 Lite',
    ]);
    expect(options.map((item) => item.modelName)).toEqual([
      'openai/gpt-image-2',
      'google/gemini-3.1-flash-image',
      'google/gemini-3.1-flash-lite-image',
    ]);
    expect(new Set(options.map((item) => item.id))).toHaveLength(3);
    expect(options.every((item) => item.enabled && item.isDedicated)).toBe(true);
  });

  it('单成员池继续显示原有池名称', () => {
    const options = buildVisualAgentModelOptions([
      pool([
        { modelId: 'default-generation-stub', platformId: 'stub', priority: 1, healthStatus: ModelHealthStatus.Healthy, consecutiveFailures: 0, consecutiveSuccesses: 0 },
      ]),
    ]);

    expect(options[0]?.name).toBe('视觉创作测试池');
    expect(options[0]?.modelName).toBe('default-generation-stub');
  });

  it('逻辑模型只暴露稳定公开标识，不暴露 Offering 上游', () => {
    const logical = pool([
      { modelId: 'image2', platformId: 'logical-model', priority: 1, healthStatus: ModelHealthStatus.Healthy, consecutiveFailures: 0, consecutiveSuccesses: 0 },
    ]);
    logical.id = 'gw-logical-image2';
    logical.name = 'GPT Image 2';
    logical.code = 'image2';
    logical.resolutionType = 'LogicalModel';
    logical.isDedicated = false;

    const options = buildVisualAgentModelOptions([logical]);

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      name: 'GPT Image 2',
      modelName: 'image2',
      actualModelId: 'image2',
      resolutionType: 'LogicalModel',
    });
    expect(options[0]?.id).not.toContain('openrouter');
  });
});
