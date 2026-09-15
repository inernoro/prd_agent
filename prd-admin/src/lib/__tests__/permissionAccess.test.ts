import { describe, expect, it } from 'vitest';
import { hasEffectivePermission } from '../permissionAccess';

describe('hasEffectivePermission', () => {
  it('接受直接权限、super 与 root 的等价授权', () => {
    expect(hasEffectivePermission(['logs.read'], 'logs.read')).toBe(true);
    expect(hasEffectivePermission(['super'], 'open-platform.manage')).toBe(true);
    expect(hasEffectivePermission([], 'open-platform.manage', true)).toBe(true);
  });

  it('拒绝没有任一目标权限的普通账号', () => {
    expect(hasEffectivePermission(['logs.read'], ['models.read', 'open-platform.manage'])).toBe(false);
  });
});
