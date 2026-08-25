import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sharePath } from './SharesWorkspace';

/**
 * 分享列表给出的地址必须真的能打开。
 *
 * 这一条不是理论上的洁癖：原实现把数字短链拼成 `/s/wp/{seq}`（按 token 查的那条路由，
 * 号码查不到 → 404），把合集拼成 `/s/wp/c/{token}`（路由表里压根没有这段 → 404 页）。
 * 两处都编译得过、看着也像那么回事，只有真的点一下才知道是死的。
 *
 * 所以这里不断言「字符串长什么样」，而是断言**它能被前端路由表匹配上**——
 * 路由改了、这里没跟上，同样要红。
 */

const APP = fs.readFileSync(path.join(__dirname, '../../app/App.tsx'), 'utf8');

/** 从 App.tsx 里读出所有 <Route path="..."> 的字面量，转成可匹配的正则 */
function routeMatchers(): { path: string; re: RegExp }[] {
  return [...APP.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => {
    const p = m[1];
    const re = new RegExp(`^${p.replace(/:[^/]+/g, '[^/]+').replace(/\*/g, '.*')}$`);
    return { path: p, re };
  });
}

const matches = (url: string) => routeMatchers().filter((r) => r.re.test(url));

describe('分享列表给的地址', () => {
  it('路由表本身读得出来（读不出就说明这条守卫已经空转了）', () => {
    const all = routeMatchers();
    expect(all.length).toBeGreaterThan(20);
    expect(all.some((r) => r.path === '/s/wp/:token')).toBe(true);
    expect(all.some((r) => r.path === '/s/:slug')).toBe(true);
  });

  it('没有数字短链时走 /s/wp/{token}，能被路由匹配', () => {
    const url = sharePath({ token: 'tj2fAWmtN9--', shortSeq: 0 });
    expect(url).toBe('/s/wp/tj2fAWmtN9--');
    expect(matches(url).map((r) => r.path)).toContain('/s/wp/:token');
  });

  it('有数字短链时走 /s/{seq}，不能塞进按 token 查的那条路由', () => {
    const url = sharePath({ token: 'tj2fAWmtN9--', shortSeq: 42 });
    expect(url).toBe('/s/42');
    expect(matches(url).map((r) => r.path)).toContain('/s/:slug');
    expect(url.startsWith('/s/wp/'), '号码塞进 /s/wp/ 会 404').toBe(false);
  });

  it('合集也用同一条 /s/wp/{token}，没有 /s/wp/c 这种路由', () => {
    expect(APP).not.toContain('/s/wp/c/');
    const url = sharePath({ token: 'colTok123', shortSeq: 0 });
    expect(matches(url).length).toBeGreaterThan(0);
  });

  it('任何形态拼出来的地址都至少命中一条路由', () => {
    for (const l of [
      { token: 'abc', shortSeq: 0 },
      { token: 'abc', shortSeq: undefined },
      { token: 'abc', shortSeq: 7 },
    ]) {
      const url = sharePath(l);
      expect(matches(url).length, `${url} 匹配不到任何路由`).toBeGreaterThan(0);
    }
  });
});
