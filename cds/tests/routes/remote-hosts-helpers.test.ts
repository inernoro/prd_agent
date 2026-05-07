/**
 * remote-hosts-helpers.test.ts — 锁住 remote-hosts 路由里少数纯逻辑工具：
 *
 *   - deriveContainerSlug：把 host.name + host.id 派生成符合 isSafeContainerSlug
 *     的容器 slug。规则演化记录在 PR #529 Bugbot MEDIUM 修复中。
 */

import { describe, expect, it } from 'vitest';

import { deriveContainerSlug } from '../../src/routes/remote-hosts.js';
import { isSafeContainerSlug } from '../../src/services/sidecar/sidecar-deployer.js';

describe('deriveContainerSlug', () => {
  it('普通名字 + id 后缀', () => {
    const slug = deriveContainerSlug('prod-sandbox', 'a1b2c3d4e5f6');
    expect(slug).toBe('prod-sandbox-a1b2c3d4');
    expect(isSafeContainerSlug(slug)).toBe(true);
  });

  it('大写 / 特殊字符 sanitize 成小写 + 折叠 - + 去首尾 -', () => {
    const slug = deriveContainerSlug('Prod__Sandbox!!', 'deadbeefcafef00d');
    // Prod__Sandbox!! → prod-sandbox （连续 _ 都成 -，再折叠）
    expect(slug).toBe('prod-sandbox-deadbeef');
    expect(isSafeContainerSlug(slug)).toBe(true);
  });

  it('首尾 - 被 trim', () => {
    const slug = deriveContainerSlug('-test-', 'aaaaaaaa');
    expect(slug.startsWith('-')).toBe(false);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug).toBe('test-aaaaaaaa');
    expect(isSafeContainerSlug(slug)).toBe(true);
  });

  it('全是非法字符（如 ___）退化成 host-{id}', () => {
    const slug = deriveContainerSlug('___', 'feedface12345678');
    expect(slug).toBe('host-feedface');
    expect(isSafeContainerSlug(slug)).toBe(true);
  });

  it('空名字退化', () => {
    const slug = deriveContainerSlug('', 'aabbccdd');
    expect(slug).toBe('host-aabbccdd');
    expect(isSafeContainerSlug(slug)).toBe(true);
  });

  it('两个名字只差被 strip 的字符 — id 后缀使容器名不撞（PR #529 Bugbot MEDIUM）', () => {
    // host.name='test!' 和 host.name='test@' sanitize 后都是 test，但 host.id
    // 不同 → 容器名不同，第二次 deploy 不会静默 docker rm -f 第一台容器
    const a = deriveContainerSlug('test!', 'aaaaaaaa11111111');
    const b = deriveContainerSlug('test@', 'bbbbbbbb22222222');
    expect(a).toBe('test-aaaaaaaa');
    expect(b).toBe('test-bbbbbbbb');
    expect(a).not.toBe(b);
  });

  it('超长名字截到 22 字 + id 后缀', () => {
    const slug = deriveContainerSlug('a'.repeat(100), 'cccccccc');
    expect(slug.length).toBeLessThanOrEqual(22 + 1 + 8);
    expect(isSafeContainerSlug(slug)).toBe(true);
  });
});
