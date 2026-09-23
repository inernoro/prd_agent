import { describe, expect, it } from 'vitest';
import { allPermissions, menuList } from '../authzMenuMapping';
import { canOpenLlmGateway } from '../llmGatewayAccess';

describe('canOpenLlmGateway', () => {
  it('允许显式拥有模型网关权限的用户', () => {
    expect(canOpenLlmGateway(['llm-gateway.access'])).toBe(true);
  });

  it('不把权限管理能力扩大成模型网关权限', () => {
    expect(canOpenLlmGateway(['authz.manage'])).toBe(false);
  });

  it('不把普通模型维护权限扩大成网关管理员', () => {
    expect(canOpenLlmGateway(['mds.write'])).toBe(false);
  });

  it('允许超级权限', () => {
    expect(canOpenLlmGateway(['super'])).toBe(true);
  });

  it('允许 root', () => {
    expect(canOpenLlmGateway([], true)).toBe(true);
  });

  it('在权限管理矩阵中提供可分配的模型网关权限', () => {
    expect(allPermissions.some((permission) => permission.key === 'llm-gateway.access')).toBe(true);
    expect(menuList.find((menu) => menu.appKey === 'llm-gateway')?.permissions)
      .toContain('llm-gateway.access');
  });
});
