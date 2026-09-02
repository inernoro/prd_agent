import { describe, expect, it } from 'vitest';
import { ModelHealthStatus, PoolStrategyType, type ModelGroupForApp } from '@/types/modelGroup';
import { buildVisualAgentModelOptions, resolveVisualResultModelLabel, selectVisualModel, visualImageSizeChoices } from './visualAgentModelOptions';

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
  it('混合模型池不再伪装成业务模型', () => {
    const options = buildVisualAgentModelOptions([
      pool([
        { modelId: 'openai/gpt-image-2', platformId: 'openrouter', priority: 10, healthStatus: ModelHealthStatus.Healthy, consecutiveFailures: 0, consecutiveSuccesses: 1 },
        { modelId: 'google/gemini-3.1-flash-image', platformId: 'openrouter', priority: 20, healthStatus: ModelHealthStatus.Healthy, consecutiveFailures: 0, consecutiveSuccesses: 1 },
        { modelId: 'google/gemini-3.1-flash-lite-image', platformId: 'openrouter', priority: 30, healthStatus: ModelHealthStatus.Degraded, consecutiveFailures: 1, consecutiveSuccesses: 0 },
      ]),
    ]);

    expect(options).toEqual([]);
  });

  it('单成员默认池也不能替代业务模型目录', () => {
    const options = buildVisualAgentModelOptions([
      pool([
        { modelId: 'default-generation-stub', platformId: 'stub', priority: 1, healthStatus: ModelHealthStatus.Healthy, consecutiveFailures: 0, consecutiveSuccesses: 0 },
      ]),
    ]);

    expect(options).toEqual([]);
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

describe('resolveVisualResultModelLabel', () => {
  it('逻辑模型始终覆盖真实上游模型与旧模型池', () => {
    expect(resolveVisualResultModelLabel({
      logicalModelPublicId: 'nanobanana-2',
      modelPool: 'Nano Banana 2',
      actualModelPool: '旧默认图像池',
      actualModel: 'google/gemini-3.1-flash-image',
    })).toBe('nanobanana-2');
  });

  it('旧任务展示实际模型而不是默认池', () => {
    expect(resolveVisualResultModelLabel({ actualModelPool: '旧默认图像池', actualModel: 'upstream' }, 'selected'))
      .toBe('upstream');
    expect(resolveVisualResultModelLabel({ actualModel: 'upstream' }, 'selected')).toBe('upstream');
    expect(resolveVisualResultModelLabel(null, 'selected')).toBe('selected');
  });
});

describe('业务默认和显式选择', () => {
  const models = buildVisualAgentModelOptions([
    { ...pool([]), id: 'image2', code: 'image2', resolutionType: 'LogicalModel' },
    { ...pool([]), id: 'image1', code: 'image1', resolutionType: 'LogicalModel', isDefault: true },
  ]);
  it('默认不跟随首项，即使默认暂时不可用也保留身份', () => {
    expect(selectVisualModel(models, true)?.modelName).toBe('image1');
    expect(selectVisualModel(models, true)?.enabled).toBe(false);
  });
  it('失效的旧选择不回退到业务默认', () => {
    expect(selectVisualModel(models, false, 'removed')).toBeNull();
    expect(selectVisualModel(models, false, 'pool_image2')?.modelName).toBe('image2');
  });
  it('缺少业务默认时不选择任意模型', () => {
    expect(selectVisualModel(models.slice(0, 1), true)).toBeNull();
  });
});

describe('手机尺寸与授权目录一致', () => {
  it('保留网关发布的尺寸且跨档位去重，不生成写死的 3:4 尺寸', () => {
    expect(visualImageSizeChoices({matched:true,modelId:'image1',sizesByResolution:{
      '1k':[{size:'1024x1024',aspectRatio:'1:1'},{size:'1024x1536',aspectRatio:'2:3'},{size:'1536x1024',aspectRatio:'3:2'}],
      '2k':[{size:'1024x1024',aspectRatio:'1:1'}],
    }}).map(x=>x.size)).toEqual(['1024x1024','1024x1536','1536x1024']);
  });
  it('目录未就绪或尺寸不适用时不伪造选项', () => {
    expect(visualImageSizeChoices(null)).toEqual([]);
    expect(visualImageSizeChoices({matched:false,modelId:'unknown'})).toEqual([]);
    expect(visualImageSizeChoices({matched:true,modelId:'adaptive',sizesNotApplicable:true})).toEqual([]);
  });
});
