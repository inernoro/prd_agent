import { describe, expect, it } from 'vitest';
import { resolveAdminIdentityLabel } from '../adminIdentityLabel';

describe('resolveAdminIdentityLabel', () => {
  it('系统管理员与业务角色不一致时同时展示两种身份', () => {
    expect(resolveAdminIdentityLabel({ role: 'QA', systemRoleKey: 'admin' }))
      .toBe('系统管理员 · QA');
  });

  it('不把普通业务角色误标成系统管理员', () => {
    expect(resolveAdminIdentityLabel({ role: 'QA', systemRoleKey: 'none' })).toBe('QA');
  });

  it('root 与传统 ADMIN 账号保持简洁标签', () => {
    expect(resolveAdminIdentityLabel({ role: 'ADMIN' }, true)).toBe('系统管理员');
    expect(resolveAdminIdentityLabel({ role: 'ADMIN', systemRoleKey: 'admin' })).toBe('系统管理员');
  });
});
