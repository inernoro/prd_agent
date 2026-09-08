import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildVisualAgentModelOptions, isOperationOnlyPool, poolIdFromVisualModelOptionId, visualModelOptionIdOf, selectVisualModel } from '../visualAgentModelOptions';
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
      .toEqual(['gpt-image-2']);
  });

  it('旧后端不下发 capabilities 时不误伤正常模型', () => {
    // capabilities 是新加的字段；老部署返回不带它，此时只能靠 code 判断，
    // 不能因为「没有能力标签」就把正常模型也滤掉。
    const legacy = pool({ capabilities: undefined });
    expect(isOperationOnlyPool(legacy)).toBe(false);
    expect(buildVisualAgentModelOptions([legacy])).toHaveLength(1);
  });
});

describe('【关键】选项 id 与模型池 id 差一个前缀，两个方向都得走同一处', () => {
  // 首页把用户选的是 `option.id`（`pool_xxx`）放进交接包；手机端编辑器拿它去跟
  // 原始池列表的 `pool.id`（`xxx`）比，永远比不中，于是静默退回「第一个可用池」——
  // 界面显示 A、真跑 B，一次要花钱的生成，且违反 ai-model-visibility
  //（显示的必须是真正在用的那个）。不报错、不变红（Codex PR #1476 P1）。

  it('构造出来的选项 id 确实带前缀，能原样还原成池 id', () => {
    // 用真正的 builder 产出，不手写 'pool_' —— 手写就是把被测的那个常量抄了第二份。
    const [option] = buildVisualAgentModelOptions([pool({ id: 'grp-77' })]);
    expect(option, '应产出一个可选模型').toBeTruthy();
    expect(option!.id).not.toBe('grp-77');
    expect(poolIdFromVisualModelOptionId(option!.id), '还原后必须等于池 id').toBe('grp-77');
  });

  it('已经是裸池 id 的原样返回，不会被削掉一段', () => {
    // 偏好里可能存着别处写的裸 id，认不出来就当它已经是池 id，
    // 比判空退回「第一个可用」强。
    expect(poolIdFromVisualModelOptionId('grp-77')).toBe('grp-77');
    expect(poolIdFromVisualModelOptionId('  grp-77  ')).toBe('grp-77');
    expect(poolIdFromVisualModelOptionId('')).toBe('');
  });

  it('前缀只有一处定义，没人再手写第二份', () => {
    const src = readFileSync(resolve(__dirname, '../visualAgentModelOptions.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code.match(/'pool_'/g) ?? [], "'pool_' 字面量应只出现在常量定义那一处").toHaveLength(1);
    expect(code).not.toMatch(/`pool_\$\{/);
  });
});

describe('【关键】交接包里的模型 id 归一之后必须能在目录里选中', () => {
  // 这条是**行为**判据，不是源码守卫——因为源码守卫在这件事上已经失手过一次。
  //
  // 手机端存进 pickedPoolId 的值要拿去跟目录比。比较对象的口径被改过两次：
  // 一开始比的是原始池的 id（不带前缀），后来 main 改成比选项的 id（带前缀）。
  // 那次改动之后，「剥掉前缀再存」这个写法当场反了——存进去的再也匹配不上，
  // 选中恒为 null，连自动发送都不会触发。而当时那条源码守卫断言的是
  // 「调用了 poolIdFromVisualModelOptionId」，这句话在反了之后依然成立，所以它没红。
  //
  // 判据换成：把交接包里的值归一之后，selectVisualModel 必须真的选得中同一个模型。
  const normalize = (raw: string) => (raw.trim() ? visualModelOptionIdOf(poolIdFromVisualModelOptionId(raw)) : '');

  it('交接包给的选项 id：归一后选得中', () => {
    const [option] = buildVisualAgentModelOptions([pool({ id: 'grp-77' })]);
    expect(option).toBeTruthy();
    const picked = selectVisualModel([option!], false, normalize(option!.id));
    expect(picked?.id, '归一后应选中同一个模型').toBe(option!.id);
  });

  it('万一给的是裸池 id：归一后同样选得中', () => {
    const [option] = buildVisualAgentModelOptions([pool({ id: 'grp-77' })]);
    const picked = selectVisualModel([option!], false, normalize('grp-77'));
    expect(picked?.id).toBe(option!.id);
  });

  it('归一是幂等的，反复套用不会越套越长', () => {
    expect(normalize(normalize(normalize('grp-77')))).toBe(visualModelOptionIdOf('grp-77'));
  });

  it('空值仍是空值，不会变成一个只有前缀的假 id', () => {
    expect(normalize('')).toBe('');
    expect(normalize('   ')).toBe('');
  });
});
