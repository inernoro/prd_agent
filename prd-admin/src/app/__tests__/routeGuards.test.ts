import { describe, expect, it } from 'vitest';

import { decideAuthRedirect } from '@/app/RouteGuards';

/**
 * `#` 后面的东西有两种含义，登录守卫必须分得清，否则会吃掉授权回跳的参数。
 */
describe('未登录时的去向判定', () => {
  it('hash 路由原样当作 returnUrl', () => {
    expect(decideAuthRedirect('/', '', '#/transcript-agent'))
      .toEqual({ kind: 'login', returnUrl: '/transcript-agent' });
  });

  it('根路径没有 hash 时去公开首页', () => {
    expect(decideAuthRedirect('/', '', '')).toEqual({ kind: 'home' });
    expect(decideAuthRedirect('/', '', '#')).toEqual({ kind: 'home' });
    expect(decideAuthRedirect('/', '', '#/')).toEqual({ kind: 'home' });
  });

  it('普通受保护路由带上 query', () => {
    expect(decideAuthRedirect('/data-sync', '?run=abc', ''))
      .toEqual({ kind: 'login', returnUrl: '/data-sync?run=abc' });
  });

  it('授权回跳的 fragment 必须原样带回', () => {
    // 这一条是标的：跨实例同步的授权码走 fragment 回来，登录一插进来就丢了，
    // 而那个码 60 秒过期、只能用一次，丢了就得把整条授权链重走。
    // 旧实现把 `code=...` 当成 hash 路由，登录完会跳到一个不存在的路由。
    expect(decideAuthRedirect('/data-sync/callback', '', '#code=abc123&state=xyz'))
      .toEqual({ kind: 'login', returnUrl: '/data-sync/callback#code=abc123&state=xyz' });
  });

  it('fragment 与 query 同时存在时都要保留', () => {
    expect(decideAuthRedirect('/data-sync/callback', '?from=x', '#code=abc'))
      .toEqual({ kind: 'login', returnUrl: '/data-sync/callback?from=x#code=abc' });
  });
});
