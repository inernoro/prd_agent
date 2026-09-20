/*
 * 守卫：自检端点不是公开的。
 *
 * 用户 2026-09-16：「免登录自检端点这个不行，泄漏数据，避免外部获取。」
 * 三件事各有用例：令牌只发给自检端点自己的地址；回环单独不放行、令牌单独不放行；
 * 每个进程一份随机令牌，两个进程互不相认。
 */
import { describe, expect, it } from 'vitest';

import { createSelfCheckAuth, internalProbeHeaders, isLoopbackAddress, SELF_CHECK_HEADER, selfCheckAuth } from '../../src/services/self-check-auth.js';

describe('令牌只发给自检端点自己', () => {
  it('本机回环 + 自检路径才带令牌头', () => {
    const auth = createSelfCheckAuth('tok');
    expect(auth.headersFor('http://127.0.0.1:9900/api/self-check')).toEqual({ [SELF_CHECK_HEADER]: 'tok' });
    expect(auth.headersFor('http://localhost:9900/api/self-check')).toEqual({ [SELF_CHECK_HEADER]: 'tok' });
  });

  it('外部地址、别的路径、坏地址一律不带——内部令牌带出去就是泄漏', () => {
    const auth = createSelfCheckAuth('tok');
    expect(auth.headersFor('https://cds.example.test/api/self-check')).toEqual({});
    expect(auth.headersFor('http://10.0.0.5:9900/api/self-check')).toEqual({});
    expect(auth.headersFor('http://127.0.0.1:9900/api/healthz')).toEqual({});
    expect(auth.headersFor('not a url')).toEqual({});
  });

  it('进程内那份默认实例与 internalProbeHeaders 是同一份令牌', () => {
    const url = 'http://127.0.0.1:1/api/self-check';
    const h = internalProbeHeaders(url);
    expect(Object.keys(h)).toEqual([SELF_CHECK_HEADER]);
    expect(h[SELF_CHECK_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(selfCheckAuth.verify({ remoteAddress: '127.0.0.1', header: h[SELF_CHECK_HEADER] })).toBe(true);
  });
});

describe('放行要两个条件同时成立', () => {
  const auth = createSelfCheckAuth('secret-token');

  it('回环 + 令牌相等 → 放行', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(auth.verify({ remoteAddress: ip, header: 'secret-token' }), ip).toBe(true);
    }
  });

  it('回环但令牌缺失 / 不对 / 长度不同 → 拒（nginx 反代来的请求也是回环，回环单独不算数）', () => {
    expect(auth.verify({ remoteAddress: '127.0.0.1', header: undefined })).toBe(false);
    expect(auth.verify({ remoteAddress: '127.0.0.1', header: '' })).toBe(false);
    expect(auth.verify({ remoteAddress: '127.0.0.1', header: 'secret-tokeN' })).toBe(false);
    expect(auth.verify({ remoteAddress: '127.0.0.1', header: 'secret' })).toBe(false);
  });

  it('令牌对但不是回环 → 拒', () => {
    expect(auth.verify({ remoteAddress: '10.0.0.5', header: 'secret-token' })).toBe(false);
    expect(auth.verify({ remoteAddress: undefined, header: 'secret-token' })).toBe(false);
  });

  it('两个进程各自的令牌互不相认', () => {
    const a = createSelfCheckAuth();
    const b = createSelfCheckAuth();
    const url = 'http://127.0.0.1:1/api/self-check';
    expect(b.verify({ remoteAddress: '127.0.0.1', header: a.headersFor(url)[SELF_CHECK_HEADER] })).toBe(false);
    expect(a.verify({ remoteAddress: '127.0.0.1', header: a.headersFor(url)[SELF_CHECK_HEADER] })).toBe(true);
  });

  it('回环判定只认三种写法', () => {
    expect(isLoopbackAddress('127.0.0.2')).toBe(false);
    expect(isLoopbackAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('::1')).toBe(true);
  });
});
