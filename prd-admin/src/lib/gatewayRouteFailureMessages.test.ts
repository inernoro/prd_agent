import { describe, expect, it } from 'vitest';
import { toUserReadableErrorMessage } from './userReadableError';

/**
 * 矩阵 D2：前端不得再把「配置不兼容」显示成「Provider 宕机」。
 *
 * 这些码与后端 prd-api/src/PrdAgent.Core/LlmGateway/GatewayRouteFailure.cs 一一对应。
 * 少一个，用户就会在那条链路上重新看到那句包治百病的「服务暂时不可用」，
 * 于是又要靠猜来分辨「重试有没有用」。
 */
const ROUTE_FAILURE_CODES = [
  'ROUTE_CONFIG_INCOMPATIBLE',
  'APPCALLER_POOL_UNBOUND',
  'MODEL_POOL_EMPTY',
  'MODEL_POOL_ALL_UNAVAILABLE',
  'LOGICAL_MODEL_CAPABILITY_MISMATCH',
  'OFFERING_UNRESOLVABLE',
  'PLATFORM_DISABLED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_QUOTA_EXCEEDED',
  'GATEWAY_CONFIG_UNAVAILABLE',
  'MODEL_NOT_IN_CATALOG',
] as const;

/** 重试不会自行恢复的配置类问题：必须把用户导向管理员，而不是让他一直点重试。 */
const CONFIGURATION_FAULTS = [
  'ROUTE_CONFIG_INCOMPATIBLE',
  'APPCALLER_POOL_UNBOUND',
  'MODEL_POOL_EMPTY',
  'LOGICAL_MODEL_CAPABILITY_MISMATCH',
  'OFFERING_UNRESOLVABLE',
  'PLATFORM_DISABLED',
  'MODEL_NOT_IN_CATALOG',
] as const;

const options = {
  fallbackMessage: '图片生成未完成',
  recoveryMessage: '请稍后重新生成。',
};

describe('路由失败错误码的用户文案', () => {
  it('每个结构化原因都有自己的文案，不落到兜底句', () => {
    const messages = ROUTE_FAILURE_CODES.map((code) =>
      toUserReadableErrorMessage({ code }, { ...options, code }),
    );

    for (const message of messages) {
      expect(message).not.toContain(options.fallbackMessage);
    }
    expect(new Set(messages).size).toBe(ROUTE_FAILURE_CODES.length);
  });

  it('配置类问题告诉用户找管理员，而不是让他反复重试', () => {
    for (const code of CONFIGURATION_FAULTS) {
      const message = toUserReadableErrorMessage({ code }, { ...options, code });
      expect(message, code).toContain('管理员');
    }
  });

  it('配置不兼容不再和上游宕机共用同一句文案', () => {
    const configFault = toUserReadableErrorMessage(
      { code: 'LOGICAL_MODEL_CAPABILITY_MISMATCH' },
      { ...options, code: 'LOGICAL_MODEL_CAPABILITY_MISMATCH' },
    );
    const providerFault = toUserReadableErrorMessage(
      { code: 'PROVIDER_UNAVAILABLE' },
      { ...options, code: 'PROVIDER_UNAVAILABLE' },
    );
    const legacyLump = toUserReadableErrorMessage(
      { code: 'IMAGE_GEN_UNAVAILABLE' },
      { ...options, code: 'IMAGE_GEN_UNAVAILABLE' },
    );

    expect(configFault).not.toBe(providerFault);
    expect(configFault).not.toBe(legacyLump);
    expect(providerFault).not.toBe(legacyLump);
  });

  it('用户文案不泄漏 appCaller / 池 / Offering 这类内部标识', () => {
    for (const code of ROUTE_FAILURE_CODES) {
      const message = toUserReadableErrorMessage({ code }, { ...options, code });
      expect(message, code).not.toMatch(/appCaller|offering|::/i);
    }
  });
});
