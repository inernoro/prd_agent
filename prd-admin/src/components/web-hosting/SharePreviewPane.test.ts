import { describe, expect, it } from 'vitest';
import { resolveVisitorGate } from './SharePreviewPane';

/**
 * 这条组合逻辑是分享弹窗右栏「访客会先撞上哪道门」的唯一判定源。
 * 写在 JSX 里就只能靠断言文案字面量，改一个字测试就红——所以抽成纯函数在这里测行为。
 */
describe('访客先撞上哪道门', () => {
  it('可见性与密码是「与」的关系，不是二选一', () => {
    // 这是最容易写错的一格：以为选了登录可见，密码就不生效了
    expect(resolveVisitorGate('logged-in', true)).toBe('login-then-password');
    expect(resolveVisitorGate('owner-only', true)).toBe('login-then-password');
  });

  it('要登录的两档在没密码时都是先登录', () => {
    expect(resolveVisitorGate('owner-only', false)).toBe('login');
    expect(resolveVisitorGate('logged-in', false)).toBe('login');
  });

  it('公开 + 密码 = 只有密码门', () => {
    expect(resolveVisitorGate('public', true)).toBe('password');
  });

  it('公开 + 无密码 = 完全没有拦截，这一档要能被单独认出来（右栏据此出警告）', () => {
    expect(resolveVisitorGate('public', false)).toBe('open');
  });

  it('只有「公开且无密码」这一种组合是 open，其余三档都有门', () => {
    const combos: Array<[Parameters<typeof resolveVisitorGate>[0], boolean]> = [
      ['owner-only', true], ['owner-only', false],
      ['logged-in', true], ['logged-in', false],
      ['public', true], ['public', false],
    ];
    const open = combos.filter(([v, p]) => resolveVisitorGate(v, p) === 'open');
    expect(open).toEqual([['public', false]]);
  });
});
