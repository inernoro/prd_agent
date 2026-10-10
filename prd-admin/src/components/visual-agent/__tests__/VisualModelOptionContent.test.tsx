import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildVisualAgentModelOptions } from '@/pages/ai-chat/visualAgentModelOptions';
import { ModelHealthStatus, type ModelGroupForApp } from '@/types/modelGroup';
import { VisualModelOptionContent } from '../VisualModelOptionContent';

const pool: ModelGroupForApp = {
  id: 'gateway-model', code: 'gpt-image-2', name: 'GPT 画师', description: '文字生图，也可上传参考图修改',
  priority: 0, modelType: 'generation', isDefaultForType: true, isDefault: true,
  resolutionType: 'LogicalModel', isDedicated: false, isLegacy: false, strategyType: 0,
  createdAt: '', updatedAt: '',
  models: [{ modelId: 'gpt-image-2', platformId: 'logical-model', priority: 1,
    healthStatus: ModelHealthStatus.Healthy, consecutiveFailures: 0, consecutiveSuccesses: 0 }],
};

describe('模型短名与真实身份分开展示', () => {
  it('短名不改请求身份，默认标记与选中状态独立', () => {
    const [model] = buildVisualAgentModelOptions([pool]);
    const markup = renderToStaticMarkup(<VisualModelOptionContent model={model} />);
    expect(markup).toContain('GPT 画师');
    expect(markup).toContain('gpt-image-2');
    expect(markup).toContain(pool.description);
    expect(markup).toContain('默认');
    expect(markup).not.toContain('当前选中');
    expect(model.id).toBe('pool_gateway-model');
    expect(model.modelName).toBe('gpt-image-2');
    expect(model.platformId).toBe('logical-model');
    expect(renderToStaticMarkup(<VisualModelOptionContent model={model} selected />)).toContain('当前选中');
  });

  it('只有服务端明确允许探测才呈现恢复提示，不把不可用线路伪装可选', () => {
    const unavailable = { ...pool, models: [{ ...pool.models[0], healthStatus: ModelHealthStatus.Unavailable }] };
    const [blocked] = buildVisualAgentModelOptions([unavailable]);
    expect(blocked.enabled).toBe(false);
    const blockedMarkup = renderToStaticMarkup(<VisualModelOptionContent model={blocked} />);
    expect(blockedMarkup).toContain('暂时无法生成，请选其他模型');
    expect(blockedMarkup).not.toContain('可以尝试生成');
    const [recovering] = buildVisualAgentModelOptions([{ ...unavailable,
      models: [{ ...unavailable.models[0], isRecoveryProbeAvailable: true }] }]);
    expect(recovering.enabled).toBe(true);
    expect(renderToStaticMarkup(<VisualModelOptionContent model={recovering} />)).toContain('正在恢复，可以尝试生成');
  });
});
