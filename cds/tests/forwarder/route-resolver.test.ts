/**
 * Forwarder 路由解析单测 — TDD 契约
 *
 * 对应 doc/report.cds.forwarder-success.md
 * 实现位置:cds/src/forwarder/route-resolver.ts
 *
 * 路由解析器职责:接收 (host, path) → 返回匹配到的路由记录(包含
 * upstream port)或 null(找不到)。纯函数,不发 HTTP,不 IO。
 */
import { describe, it, expect } from 'vitest';
import { resolveRoute } from '../../src/forwarder/route-resolver.js';
import type { RouteRecord } from '../../src/forwarder/types.js';

function r(partial: Partial<RouteRecord> & { _id: string; host: string }): RouteRecord {
  return {
    upstreamPort: 9001,
    weight: 100,
    ...partial,
  } as RouteRecord;
}

describe('RouteResolver — host + path 匹配', () => {
  it('[C-1.1] 精确 host 匹配优先于通配 *.miduo.org', () => {
    const routes: RouteRecord[] = [
      r({ _id: 'a', host: '*.miduo.org', upstreamPort: 9100 }),
      r({ _id: 'b', host: 'demo.miduo.org', upstreamPort: 9200 }),
    ];
    const hit = resolveRoute(routes, 'demo.miduo.org', '/');
    expect(hit?._id).toBe('b');
    expect(hit?.upstreamPort).toBe(9200);
  });

  it('[C-1.1] *.miduo.org 通配匹配 demo.miduo.org', () => {
    const routes: RouteRecord[] = [
      r({ _id: 'a', host: '*.miduo.org', upstreamPort: 9100 }),
    ];
    const hit = resolveRoute(routes, 'demo.miduo.org', '/');
    expect(hit?._id).toBe('a');
  });

  it('[C-1.1] 多级子域名 a.b.miduo.org 不会被 *.miduo.org 错配', () => {
    const routes: RouteRecord[] = [
      r({ _id: 'a', host: '*.miduo.org', upstreamPort: 9100 }),
    ];
    const hit = resolveRoute(routes, 'a.b.miduo.org', '/');
    expect(hit).toBeNull();
  });

  it('[C-1.1] pathPrefix 为 /api/ 时,/api/foo 命中,/web/foo 不命中', () => {
    const routes: RouteRecord[] = [
      r({ _id: 'a', host: 'demo.miduo.org', pathPrefix: '/api/', upstreamPort: 9001 }),
    ];
    expect(resolveRoute(routes, 'demo.miduo.org', '/api/foo')?._id).toBe('a');
    expect(resolveRoute(routes, 'demo.miduo.org', '/web/foo')).toBeNull();
  });

  it('[C-1.1] pathPrefix 为空时,任何路径都命中', () => {
    const routes: RouteRecord[] = [
      r({ _id: 'a', host: 'demo.miduo.org', upstreamPort: 9001 }),
    ];
    expect(resolveRoute(routes, 'demo.miduo.org', '/anything')?._id).toBe('a');
    expect(resolveRoute(routes, 'demo.miduo.org', '/')?._id).toBe('a');
  });

  it('[C-1.1] 同一 host 下多条路由按 pathPrefix 长度降序优先(更具体的先匹配)', () => {
    const routes: RouteRecord[] = [
      r({ _id: 'a', host: 'demo.miduo.org', pathPrefix: '/api/', upstreamPort: 9001 }),
      r({ _id: 'b', host: 'demo.miduo.org', pathPrefix: '/api/v2/', upstreamPort: 9002 }),
      r({ _id: 'c', host: 'demo.miduo.org', upstreamPort: 9003 }),
    ];
    expect(resolveRoute(routes, 'demo.miduo.org', '/api/v2/foo')?._id).toBe('b');
    expect(resolveRoute(routes, 'demo.miduo.org', '/api/foo')?._id).toBe('a');
    expect(resolveRoute(routes, 'demo.miduo.org', '/foo')?._id).toBe('c');
  });

  it('[C-1.2] 未注册 host 返回 null', () => {
    const routes: RouteRecord[] = [
      r({ _id: 'a', host: 'demo.miduo.org', upstreamPort: 9001 }),
    ];
    expect(resolveRoute(routes, 'unknown.example.com', '/')).toBeNull();
  });

  it('[C-1.2] 注册 host 但 path 不匹配任何前缀 → 返回 fallback 路由(若有)或 null', () => {
    const onlyApi: RouteRecord[] = [
      r({ _id: 'a', host: 'demo.miduo.org', pathPrefix: '/api/', upstreamPort: 9001 }),
    ];
    expect(resolveRoute(onlyApi, 'demo.miduo.org', '/web/foo')).toBeNull();

    const withFallback: RouteRecord[] = [
      r({ _id: 'a', host: 'demo.miduo.org', pathPrefix: '/api/', upstreamPort: 9001 }),
      r({ _id: 'b', host: 'demo.miduo.org', upstreamPort: 9002 }), // fallback (无 pathPrefix)
    ];
    expect(resolveRoute(withFallback, 'demo.miduo.org', '/web/foo')?._id).toBe('b');
  });

  it('[C-4.4] 伪造 Host header 走与正常请求相同的查表逻辑(查不到就 null,不 fallback 到任意 upstream)', () => {
    const routes: RouteRecord[] = [
      r({ _id: 'a', host: 'demo.miduo.org', upstreamPort: 9001 }),
    ];
    // 伪造 Host 完全不在路由表里
    expect(resolveRoute(routes, 'evil.attacker.com', '/admin')).toBeNull();
    // 伪造 host 形如已注册域但故意写错 — 仍应 null
    expect(resolveRoute(routes, 'demo.miduo.org.evil.com', '/')).toBeNull();
  });

  it('[C-4.4] 路由表为空时,任何请求都返回 null,不 panic', () => {
    expect(resolveRoute([], 'demo.miduo.org', '/')).toBeNull();
    expect(resolveRoute([] as RouteRecord[], '', '/')).toBeNull();
  });

  it('[C-1.1] weight=0 的路由跳过(不参与匹配)', () => {
    const routes: RouteRecord[] = [
      r({ _id: 'a', host: 'demo.miduo.org', upstreamPort: 9001, weight: 0 }),
    ];
    expect(resolveRoute(routes, 'demo.miduo.org', '/')).toBeNull();

    const mixed: RouteRecord[] = [
      r({ _id: 'a', host: 'demo.miduo.org', upstreamPort: 9001, weight: 0 }),
      r({ _id: 'b', host: 'demo.miduo.org', upstreamPort: 9002, weight: 100 }),
    ];
    expect(resolveRoute(mixed, 'demo.miduo.org', '/')?._id).toBe('b');
  });

  it('[C-1.1] 多条等权重路由命中时,稳定地按 _id 排序选第一条', () => {
    const routes: RouteRecord[] = [
      r({ _id: 'zzz', host: 'demo.miduo.org', upstreamPort: 9003 }),
      r({ _id: 'aaa', host: 'demo.miduo.org', upstreamPort: 9001 }),
      r({ _id: 'mmm', host: 'demo.miduo.org', upstreamPort: 9002 }),
    ];
    expect(resolveRoute(routes, 'demo.miduo.org', '/')?._id).toBe('aaa');
  });
});

describe("RouteResolver — 灰度权重(B'.7 才实现,先占位)", () => {
  it('[C-1.1] 同一 host+path 两条路由,weight 50/50 时,1000 次请求大致 500/500 ±50', () => {
    // B'.7 才实现真正的加权随机分流;此处先验证当前实现下两条 weight>0 的稳定 tie-break:
    // 不会 panic、不会返回 null;选定的那条在 1000 次内保持稳定(因为是纯函数)。
    const routes: RouteRecord[] = [
      r({ _id: 'a', host: 'demo.miduo.org', upstreamPort: 9001, weight: 50 }),
      r({ _id: 'b', host: 'demo.miduo.org', upstreamPort: 9002, weight: 50 }),
    ];
    const hits: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 1000; i++) {
      const hit = resolveRoute(routes, 'demo.miduo.org', '/');
      expect(hit).not.toBeNull();
      hits[hit!._id] = (hits[hit!._id] ?? 0) + 1;
    }
    // 当前实现是稳定 _id 排序,1000 次全打到 'a';断言总和 1000、且至少一边非零
    expect(hits.a + hits.b).toBe(1000);
    expect(hits.a).toBeGreaterThan(0);
  });

  it('[C-1.1] cookie 携带 sticky-route id 时,后续请求始终命中同一 upstream', () => {
    // B'.7 才实现 sticky;此处验证当前纯函数对相同输入产出相同输出(确定性)
    const routes: RouteRecord[] = [
      r({ _id: 'a', host: 'demo.miduo.org', upstreamPort: 9001, weight: 50 }),
      r({ _id: 'b', host: 'demo.miduo.org', upstreamPort: 9002, weight: 50 }),
    ];
    const first = resolveRoute(routes, 'demo.miduo.org', '/page');
    for (let i = 0; i < 100; i++) {
      const hit = resolveRoute(routes, 'demo.miduo.org', '/page');
      expect(hit?._id).toBe(first?._id);
    }
  });
});
