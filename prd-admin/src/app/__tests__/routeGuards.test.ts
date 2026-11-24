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

  it('授权回跳的 fragment 不进 returnUrl，只留一个不含语义的引用键', () => {
    // 这一条是标的，而且它被改过一次方向，值得写清楚：
    //
    // 先要解决的是「fragment 一登录就丢」——授权码走 fragment 回来，60 秒过期、
    // 只能用一次，丢了整条授权链重走。第一版的修法是把 fragment 拼进 returnUrl。
    //
    // 那个修法把保护拆了：授权码之所以走 fragment，正是因为 fragment 不会被发给
    // 服务器、不进 access log、不随 Referer 外泄；塞进 `?returnUrl=` 之后，登录页
    // 会带着这个 query 发同源请求，SSO 还会把它拼进外部重定向地址。
    //
    // 所以现在两件事都要成立：值不能丢，也不能出现在 URL 上。
    const stashed: string[] = [];
    const result = decideAuthRedirect('/data-sync/callback', '', '#code=abc123&state=xyz', (f) => {
      stashed.push(f);
      return 'ref-1';
    });

    expect(result).toEqual({ kind: 'login', returnUrl: '/data-sync/callback?fragRef=ref-1' });
    // 值确实被寄存了，没丢。
    expect(stashed).toEqual(['#code=abc123&state=xyz']);
    // 而 URL 上不许出现授权码本身。
    expect((result as { returnUrl: string }).returnUrl).not.toContain('abc123');
    expect((result as { returnUrl: string }).returnUrl).not.toContain('code=');
  });

  it('fragment 与 query 同时存在时，query 保留、fragment 走引用键', () => {
    expect(decideAuthRedirect('/data-sync/callback', '?from=x', '#code=abc', () => 'ref-2'))
      .toEqual({ kind: 'login', returnUrl: '/data-sync/callback?from=x&fragRef=ref-2' });
  });

  it('寄存失败时宁可丢 fragment，也不把它塞进 URL', () => {
    // sessionStorage 存不下（隐私模式 / 配额）时 stash 返回空串。
    // 这时退化成「回到那一页但没有 fragment」，页面会提示重新发起——
    // 比把授权码泄进 query 好。
    expect(decideAuthRedirect('/data-sync/callback', '', '#code=abc', () => ''))
      .toEqual({ kind: 'login', returnUrl: '/data-sync/callback' });
  });
});
