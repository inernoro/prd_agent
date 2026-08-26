import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { api } from '@/services/api';

/**
 * 「还剩几次」这条旁路必须真的打得通。
 *
 * 它坏掉的方式全是静默的：路径拼错、后端换了段名、`[AllowAnonymous]` 被摘掉，
 * 三种情况前端都只是 `setQuota(null)` —— 那一行数字安静地不出现，页面看着完全正常，
 * 没有任何报错，也没有任何测试会红（predicate-and-wiring-discipline 形状 2 + 4b）。
 *
 * 所以断言的不是「字符串长什么样」，而是**前端拼出来的路径能被后端那个 attribute 接住**，
 * 且那个 action 对匿名开放。后端改了段名、或哪天顺手加回 [Authorize]，这里就红。
 */

const CONTROLLER = path.resolve(
  __dirname,
  '../../../../prd-api/src/PrdAgent.Api/Controllers/Api/WebPageAskController.cs',
);

const SRC = fs.readFileSync(CONTROLLER, 'utf8');

/** 类级 [Route("...")] 前缀 */
function routePrefix(): string {
  const m = SRC.match(/\[Route\("([^"]+)"\)\]/);
  if (!m) throw new Error('读不出类级 Route —— 这条守卫已经空转了');
  return m[1];
}

/** 收集 [HttpGet("x")] / [HttpPost("x")] 声明的完整路径 */
function declaredRoutes(): { verb: string; template: string }[] {
  const prefix = routePrefix().replace(/\/+$/, '');
  return [...SRC.matchAll(/\[Http(Get|Post|Patch|Put|Delete)\("([^"]*)"\)\]/g)].map((m) => ({
    verb: m[1].toUpperCase(),
    template: `/${prefix}/${m[2]}`.replace(/\/+/g, '/'),
  }));
}

/** 把 ASP.NET 的 {token} 段变成可匹配任意一段的正则 */
const asRegex = (t: string) => new RegExp(`^${t.replace(/\{[^}]+\}/g, '[^/]+')}$`);

describe('提问剩余额度端点', () => {
  it('后端路由表读得出来（读不出说明守卫在空转，不是「没问题」）', () => {
    const routes = declaredRoutes();
    expect(routes.length).toBeGreaterThan(3);
    // 同族的提问流端点必须在，否则说明这份文件已经不是我以为的那个
    expect(routes.some((r) => r.verb === 'POST' && r.template.endsWith('/ask/stream'))).toBe(true);
  });

  it('前端拼的路径能被后端某条 GET 路由接住', () => {
    const url = api.webPages.askQuotaByShare('tj2fAWmtN9--');
    const gets = declaredRoutes().filter((r) => r.verb === 'GET');
    const hit = gets.filter((r) => asRegex(r.template).test(url));
    expect(hit.map((r) => r.template), `${url} 匹配不到任何后端 GET 路由`).not.toHaveLength(0);
  });

  it('额度端点与提问端点挂在同一个 token 域下（换个域读的就是另一个桶的数）', () => {
    const quota = api.webPages.askQuotaByShare('T');
    const stream = api.webPages.askStreamByShare('T');
    expect(quota).toBe(`${stream.replace(/\/stream$/, '')}/quota`);
  });

  it('额度 action 对匿名开放 —— 摘掉 AllowAnonymous 只会让访客那行数字安静消失', () => {
    const idx = SRC.indexOf('AskQuotaByShare');
    expect(idx, '找不到 AskQuotaByShare，后端可能已改名').toBeGreaterThan(0);
    // 往回看这个 action 的 attribute 块（到上一个 action 的结尾为止足够宽松）
    const head = SRC.slice(Math.max(0, idx - 400), idx);
    expect(head).toContain('[AllowAnonymous]');
    expect(head).toContain('shares/view/{token}/ask/quota');
  });
});
