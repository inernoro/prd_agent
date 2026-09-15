import { describe, expect, it } from 'vitest';
import { collectStaleNavTokens, isStaleNavToken } from '@/lib/navStaleTokens';

/**
 * 守卫：全员导航总览的「已下线」判定。
 * 2026-09-05 线上复现：默认导航存着旧前缀 id `utility:emergence`，直接按原样查目录查不到，
 * 67 个沿用默认的用户每行都被标成红框，「清理已下线菜单」按钮把 emergence 当成待删项。
 */
describe('collectStaleNavTokens', () => {
  const known = new Set(['ai-toolbox', 'emergence', 'users', 'settings']);

  it('旧前缀 id 不算下线（按迁移后的 id 查目录）', () => {
    expect(collectStaleNavTokens([['ai-toolbox', 'utility:emergence', 'users']], known)).toEqual([]);
    expect(isStaleNavToken('utility:emergence', known)).toBe(false);
  });

  it('目录里真的没有的 key 才算下线，且返回原始写法、去重、排序', () => {
    expect(collectStaleNavTokens([
      ['ai-toolbox', 'mds', '---', 'users'],
      ['prd-agent', 'mds'],
    ], known)).toEqual(['mds', 'prd-agent']);
    expect(isStaleNavToken('mds', known)).toBe(true);
  });

  it('分隔符永远不算下线', () => {
    expect(collectStaleNavTokens([['---', '---']], known)).toEqual([]);
    expect(isStaleNavToken('---', known)).toBe(false);
  });
});
