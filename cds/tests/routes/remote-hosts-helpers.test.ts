/**
 * remote-hosts-helpers.test.ts — 锁住 remote-hosts 路由里少数纯逻辑工具：
 *
 *   - deriveContainerSlug：把 host.name + host.id 派生成符合 isSafeContainerSlug
 *     的容器 slug。规则演化记录在 PR #529 Bugbot MEDIUM 修复中。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { deriveContainerSlug, resolvePreviewRootDomain } from '../../src/routes/remote-hosts.js';
import { isSafeContainerSlug } from '../../src/services/sidecar/sidecar-deployer.js';

const previewEnvKeys = [
  'CDS_PREVIEW_DOMAIN',
  'PREVIEW_DOMAIN',
  'CDS_MAIN_DOMAIN',
  'MAIN_DOMAIN',
  'CDS_DASHBOARD_DOMAIN',
  'DASHBOARD_DOMAIN',
  'CDS_ROOT_DOMAINS',
  'ROOT_DOMAINS',
];

afterEach(() => {
  for (const key of previewEnvKeys) delete process.env[key];
});

describe('resolvePreviewRootDomain', () => {
  it('优先读取 CDS 前缀预览域名', () => {
    process.env.CDS_PREVIEW_DOMAIN = 'preview.miduo.org';
    process.env.PREVIEW_DOMAIN = 'legacy.miduo.org';

    expect(resolvePreviewRootDomain()).toBe('preview.miduo.org');
  });

  it('在 direct 域名缺省时读取 CDS_ROOT_DOMAINS 第一项', () => {
    process.env.CDS_ROOT_DOMAINS = 'miduo.org, example.com';
    process.env.ROOT_DOMAINS = 'legacy.miduo.org';

    expect(resolvePreviewRootDomain()).toBe('miduo.org');
  });
});

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

  it('slice 卡在 - 边界时不能产生 trailing -- (PR #529 Bugbot MEDIUM)', () => {
    // `my-production-sandbox-server`（28 字）经第一轮 trim 不变，slice(0, 22)
    // 后变 `my-production-sandbox-`（22 字含尾 -），与 idSuffix 拼会撞 `--`，
    // 之前会被 isSafeContainerSlug reject 让部署直接 throw。
    const slug = deriveContainerSlug(
      'my-production-sandbox-server',
      'a1b2c3d4e5f6',
    );
    expect(slug).not.toContain('--');
    expect(slug.endsWith('-a1b2c3d4')).toBe(true);
    expect(isSafeContainerSlug(slug)).toBe(true);
    // 具体值：base trim 后再 slice → my-production-sandbox- → 二次 trim → my-production-sandbox
    expect(slug).toBe('my-production-sandbox-a1b2c3d4');
  });

  it('多种 slice 边界 case 都安全', () => {
    // 22 字本来就以 - 结尾的边缘场景
    const cases = [
      { name: 'foo-bar-baz-qux-quux-corge', id: '11111111' }, // 25 chars
      { name: 'a-b-c-d-e-f-g-h-i-j-k-l-m', id: '22222222' }, // 多 -
      { name: 'a'.repeat(21) + '-b', id: '33333333' }, // 边界刚好在 -
    ];
    for (const c of cases) {
      const slug = deriveContainerSlug(c.name, c.id);
      expect(slug).not.toContain('--');
      expect(slug.startsWith('-')).toBe(false);
      expect(slug.endsWith('-')).toBe(false);
      expect(isSafeContainerSlug(slug)).toBe(true);
    }
  });
});
