import { describe, it, expect } from 'vitest';
import { maskKey, normalizeBaseUrl, toPublicView } from '../../src/routes/project-migration.js';
import type { CdsPeer } from '../../src/types.js';

/**
 * 项目迁移路由的纯函数单测。真实推送需要远端 CDS,但「地址归一化、密钥脱敏、
 * 对外视图绝不泄露明文 accessKey」是安全关键点,这里无需网络全覆盖。
 */

describe('normalizeBaseUrl', () => {
  it('补全 https 协议', () => {
    expect(normalizeBaseUrl('noroenrn.com')).toBe('https://noroenrn.com');
  });
  it('去掉尾部斜杠', () => {
    expect(normalizeBaseUrl('https://noroenrn.com/')).toBe('https://noroenrn.com');
    expect(normalizeBaseUrl('https://noroenrn.com///')).toBe('https://noroenrn.com');
  });
  it('保留显式 http 协议', () => {
    expect(normalizeBaseUrl('http://10.0.0.1:9900')).toBe('http://10.0.0.1:9900');
  });
  it('空串返回空', () => {
    expect(normalizeBaseUrl('   ')).toBe('');
  });
});

describe('maskKey', () => {
  it('null/empty 返回 null', () => {
    expect(maskKey(undefined)).toBeNull();
    expect(maskKey('')).toBeNull();
  });
  it('短 key 全掩码', () => {
    expect(maskKey('abc123')).toBe('****');
  });
  it('长 key 保留首4尾2', () => {
    expect(maskKey('shenmijianding-secret-xy')).toBe('shen****xy');
  });
});

describe('toPublicView', () => {
  const peer: CdsPeer = {
    id: 'peer_1',
    name: '生产 CDS',
    baseUrl: 'https://noroenrn.com',
    accessKey: 'shenmijianding-secret-xyzz',
    createdAt: '2026-06-23T00:00:00Z',
    lastVerifiedAt: '2026-06-23T01:00:00Z',
    remoteLabel: 'admin',
  };

  it('绝不回明文 accessKey', () => {
    const view = toPublicView(peer);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('shenmijianding-secret-xyzz');
    expect((view as Record<string, unknown>).accessKey).toBeUndefined();
  });

  it('给 hasKey + 脱敏 keyMasked', () => {
    const view = toPublicView(peer);
    expect(view.hasKey).toBe(true);
    expect(view.keyMasked).toBe('shen****zz');
    expect(view.remoteLabel).toBe('admin');
  });

  it('无 key 的 peer hasKey=false', () => {
    const view = toPublicView({ ...peer, accessKey: '' });
    expect(view.hasKey).toBe(false);
    expect(view.keyMasked).toBeNull();
  });
});
