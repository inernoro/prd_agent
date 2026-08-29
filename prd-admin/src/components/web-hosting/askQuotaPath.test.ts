import { readFileSync } from 'node:fs';
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

describe('额度窗口等待时长', () => {
  it('不许截断服务端给的 Retry-After', () => {
    // 原先写的是 Math.min(..., 3_600_000)：本意防一个离谱的值把定时器挂死，实际后果是
    // 站点日上限那档（Retry-After 常常超过一小时）在一小时就把门收起来，用户重新写一段
    // 话发出去，再吃一个同样的 429。提前解锁比锁着更伤人——他为此白写了一遍。
    //
    // 2026-08-29 第三十八轮：同一个判断此前在两处各写了一遍，只有提交闸门那处做了分段重排；
    // 额度快照那处仍是「最多睡一小时就拉一次」，于是按天的窗口离现在还有几小时时，
    // 闸门到点解开了、头上的剩余次数却一直写着 0，直到下一次请求才对上（形状 3）。
    // 现在收敛成 useDeadline 一份，判据也跟着钉到那一份上，而不是钉某个调用方的写法。
    const deadline = readFileSync(new URL('./ask/useDeadline.ts', import.meta.url), 'utf-8');
    const stream = readFileSync(new URL('./ask/useAskStream.ts', import.meta.url), 'utf-8');
    const quota = readFileSync(new URL('./ask/useAskQuota.ts', import.meta.url), 'utf-8');

    // 分段是手段，不是终点：睡够一段之后没到点必须重排，否则「最多一小时」会退化成
    // 「一小时后执行一次」——那正是这条守卫要防的提前解锁。
    expect(deadline).toMatch(/Math\.min\(remaining, MAX_CHUNK_MS\)/);
    expect(deadline).toMatch(/Date\.now\(\) >= deadline/);
    expect(deadline).toMatch(/setTick\(\(n\) => n \+ 1\)/);

    // 两个消费方都必须走这一份，不许谁再就地写一遍
    for (const [name, src] of [['useAskStream', stream], ['useAskQuota', quota]] as const) {
      expect(src, `${name} 没有走 useDeadline`).toMatch(/useDeadline\(/);
      expect(src, `${name} 又就地夹了一个一小时上限`).not.toMatch(/3_600_000/);
    }
  });
});

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
