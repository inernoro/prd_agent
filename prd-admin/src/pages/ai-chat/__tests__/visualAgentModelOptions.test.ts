import { describe, expect, it } from 'vitest';

import { buildVisualAgentModelOptions, isOperationOnlyPool } from '../visualAgentModelOptions';
import type { ModelGroupForApp } from '@/types/modelGroup';

function pool(overrides: Partial<ModelGroupForApp>): ModelGroupForApp {
  return {
    id: 'pool-1',
    name: '模型池',
    code: 'gpt-image-2',
    priority: 10,
    modelType: 'generation',
    isDefaultForType: false,
    strategyType: 0,
    models: [
      {
        modelId: 'openai/gpt-image-2',
        platformId: 'openai',
        priority: 1,
        healthStatus: 'Healthy',
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
      },
    ],
    createdAt: '',
    updatedAt: '',
    resolutionType: 'LogicalModel',
    isDedicated: false,
    isDefault: false,
    isLegacy: false,
    ...overrides,
  } as ModelGroupForApp;
}

describe('生图模型选择器只放用户能挑来生图的模型', () => {
  it('把「图片分层」这类动作能力挡在选择器之外', () => {
    // 2026-08-07 用户实测：分层被发布成 generation 类型的逻辑模型，
    // 于是混进「选择模型」列表，选中后底部 chip 变成「图片分层」，
    // 旁边还挂着对它毫无意义的 1K·1:1。它只能被快捷栏的动作点名调用。
    const layering = pool({ id: 'layer', name: '图片分层', code: 'image-layering', capabilities: ['image_generation', 'image_layering'] });
    expect(isOperationOnlyPool(layering)).toBe(true);
    expect(buildVisualAgentModelOptions([layering])).toHaveLength(0);
  });

  it('两种写法的能力 token 都认出来', () => {
    // Capabilities 数组是 snake_case，逻辑模型 PublicId 是 kebab-case；
    // 只认一种，换条数据来路就漏。
    expect(isOperationOnlyPool({ code: 'other', capabilities: ['image_layering'] })).toBe(true);
    expect(isOperationOnlyPool({ code: 'image-layering', capabilities: [] })).toBe(true);
    expect(isOperationOnlyPool({ code: 'IMAGE-LAYERING', capabilities: undefined })).toBe(true);
  });

  it('正常生图模型照常出现在选择器里', () => {
    const generation = pool({ capabilities: ['image_generation'] });
    expect(isOperationOnlyPool(generation)).toBe(false);
    expect(buildVisualAgentModelOptions([generation]).map((item) => item.modelName))
      .toEqual(['openai/gpt-image-2']);
  });

  it('旧后端不下发 capabilities 时不误伤正常模型', () => {
    // capabilities 是新加的字段；老部署返回不带它，此时只能靠 code 判断，
    // 不能因为「没有能力标签」就把正常模型也滤掉。
    const legacy = pool({ capabilities: undefined });
    expect(isOperationOnlyPool(legacy)).toBe(false);
    expect(buildVisualAgentModelOptions([legacy])).toHaveLength(1);
  });
});
