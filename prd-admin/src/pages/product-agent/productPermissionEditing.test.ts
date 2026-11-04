import { describe, expect, it } from 'vitest';
import type { AdminUserAuthzSnapshot } from '@/services/contracts/authz';
import { mergePermissionOverrides, mergeScopedRolePermissions, permissionOverride } from './productPermissionEditing';

const snapshot: AdminUserAuthzSnapshot = {
  userId: 'u1', username: 'user', displayName: '用户', role: 'PM',
  effectiveSystemRoleKey: 'custom', systemRoleKey: 'custom',
  permAllow: ['logs.read', 'review-agent.use'], permDeny: ['assets.write', 'review-agent.manage'],
};

describe('产品权限编辑的范围保护', () => {
  it('只应用显式变更，并保留最新角色与其他应用的允许/禁止', () => {
    const latest = { ...snapshot, systemRoleKey: 'another-role', permAllow: [...snapshot.permAllow, 'new-app.use'] };
    expect(mergePermissionOverrides(latest, { 'review-agent.use': 'deny', 'review-agent.manage': 'allow' })).toEqual({
      systemRoleKey: 'another-role', permAllow: ['logs.read', 'new-app.use', 'review-agent.manage'],
      permDeny: ['assets.write', 'review-agent.use'],
    });
  });
  it('恢复继承时清除该权限的例外，不清空其他权限', () => {
    const result = mergePermissionOverrides(snapshot, { 'review-agent.manage': 'inherit' });
    expect(result.permDeny).toEqual(['assets.write']);
    expect(result.permAllow).toEqual(['logs.read', 'review-agent.use']);
  });
  it('角色保存不能添加范围外权限，也不会删除已有范围外权限', () => {
    expect(mergeScopedRolePermissions(['logs.read', 'product-agent.use'], ['product-agent.use', 'review-agent.use'], ['review-agent.use', 'super']))
      .toEqual(['logs.read', 'review-agent.use']);
  });
  it('已有双重例外以禁止为准，与服务端允许后减禁止的顺序一致', () => {
    expect(permissionOverride({ ...snapshot, permDeny: [...snapshot.permDeny, 'review-agent.use'] }, 'review-agent.use')).toBe('deny');
  });
});
