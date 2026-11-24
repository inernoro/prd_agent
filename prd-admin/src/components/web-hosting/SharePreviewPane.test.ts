import { describe, it, expect } from 'vitest';
import { resolveVisitorGate, isPlaceholderShareUrl } from './SharePreviewPane';

/**
 * 实时预览必须描述**后端真实的放行范围**，不能三档合成两档。
 *
 * 后端 EnforceShareVisibilityAsync：
 * - owner-only → 创建者 + 站点已共享团队的成员；其余人在密码之前就被 403
 * - logged-in  → 只判「有没有登录」，团队外的陌生人登录了照样进
 * - public     → 都放行，密码由 EnforceShareAccessAsync 单独判
 * 且团队内部人免密（IsTeamInsiderForShareAsync）。
 *
 * 这一版之前把 owner-only 与 logged-in 判成同一个门，而那个门的文案写着
 * 「团队外的人打不开」——对 logged-in 是**往更安全的方向谎报**：owner 以为
 * 外人进不来，于是放心把链接发出去。谎报方向朝安全那边，比朝不安全那边更难被发现。
 */
describe('resolveVisitorGate', () => {
  it('三档各自不同，owner-only 与 logged-in 不许合成同一个门', () => {
    const ownerOnly = resolveVisitorGate('owner-only', false);
    const loggedIn = resolveVisitorGate('logged-in', false);
    expect(ownerOnly).not.toBe(loggedIn);
    expect(resolveVisitorGate('owner-only', true)).not.toBe(resolveVisitorGate('logged-in', true));
  });

  it('owner-only：加不加密码，对外都是「团队外打不开」', () => {
    expect(resolveVisitorGate('owner-only', false)).toBe('team-only');
    expect(resolveVisitorGate('owner-only', true)).toBe('team-only-with-password');
  });

  it('logged-in：任何登录用户都能进，密码只是再加一道', () => {
    expect(resolveVisitorGate('logged-in', false)).toBe('any-login');
    expect(resolveVisitorGate('logged-in', true)).toBe('any-login-then-password');
  });

  it('public：只由密码决定', () => {
    expect(resolveVisitorGate('public', true)).toBe('password');
    expect(resolveVisitorGate('public', false)).toBe('open');
  });

  it('六种组合各自映射到一个门，没有两种组合撞在一起', () => {
    const combos: Array<[Parameters<typeof resolveVisitorGate>[0], boolean]> = [
      ['owner-only', false], ['owner-only', true],
      ['logged-in', false], ['logged-in', true],
      ['public', false], ['public', true],
    ];
    const gates = combos.map(([v, p]) => resolveVisitorGate(v, p));
    expect(new Set(gates).size).toBe(6);
  });

  it('只有 public 无密码才是全开', () => {
    const combos: Array<[Parameters<typeof resolveVisitorGate>[0], boolean]> = [
      ['owner-only', false], ['owner-only', true],
      ['logged-in', false], ['logged-in', true],
      ['public', false], ['public', true],
    ];
    const open = combos.filter(([v, p]) => resolveVisitorGate(v, p) === 'open');
    expect(open).toEqual([['public', false]]);
  });
});

describe('isPlaceholderShareUrl', () => {
  it('链接还没生成时给的示意串判为占位', () => {
    expect(isPlaceholderShareUrl('example.org/s/wp/{生成后可见}')).toBe(true);
    expect(isPlaceholderShareUrl('example.org/s/wp/{数字短链}')).toBe(true);
  });

  it('真地址不判成占位', () => {
    expect(isPlaceholderShareUrl('example.org/s/wp/uhmrj3eXAr5b')).toBe(false);
    expect(isPlaceholderShareUrl('example.org/s/wp/123456')).toBe(false);
  });
});
