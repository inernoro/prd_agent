import { describe, expect, it } from 'vitest';
import type { LiteraryAgentModelPool } from '@/services/contracts/literaryAgentConfig';
import { buildLiteraryModelOptions } from './literaryModelOptions';

function pool(overrides: Partial<LiteraryAgentModelPool> = {}): LiteraryAgentModelPool {
  return {
    id: 'default-generation-pool',
    name: '图片生成默认池',
    code: 'default-generation',
    priority: 1,
    modelType: 'generation',
    isDefaultForType: true,
    models: [{
      modelId: 'default-generation',
      actualModelId: 'gemini-3-pro-image-preview',
      platformId: 'logical-model',
      actualPlatformId: 'google',
      priority: 1,
      healthStatus: 'Healthy',
    }],
    resolutionType: 'DefaultPool',
    isDedicated: false,
    isDefault: true,
    isLegacy: false,
    ...overrides,
  };
}

describe('buildLiteraryModelOptions', () => {
  it('默认池只展示实际上游型号，不把内部路由 ID 当模型名', () => {
    const [option] = buildLiteraryModelOptions([pool()]);

    expect(option.name).toBe('gemini-3-pro-image-preview');
    expect(option.actualModelId).toBe('gemini-3-pro-image-preview');
    expect(option.modelName).toBe('default-generation');
  });

  it('缺少实际型号时不向用户暴露 default-* 内部标识', () => {
    const options = buildLiteraryModelOptions([pool({
      models: [{
        modelId: 'default-chat-curated',
        platformId: 'logical-model',
        priority: 1,
        healthStatus: 'Healthy',
      }],
    })]);

    expect(options).toEqual([]);
  });

  it('多个逻辑入口指向同一物理模型时只保留一个官方型号', () => {
    const duplicate = pool({ id: 'duplicate', code: 'gemini-image-alias' });
    expect(buildLiteraryModelOptions([pool(), duplicate])).toHaveLength(1);
  });
});

