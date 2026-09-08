/**
 * 「这个调用方是不是机器凭据」的唯一判定处。
 *
 * ## 为什么单独一个模块
 *
 * 这个判断决定要不要把「别的项目」的信息端给调用方——一把只被授权某个项目的钥匙
 * 不该顺带认识仓库里的其它项目。它至少有三个消费方（项目摘要的 repoSharing、
 * 建项目的冲突响应、绑仓库的 409 响应），而这个判断抄两份、只改一处，正是本仓库
 * `predicate-and-wiring-discipline.md` 形状 3 反复点名的那种事故——同一个 PR 里
 * 已经栽过一次（建项目那处修了，绑仓库那处漏了，第四轮 review 才抓出来）。
 * 所以收在这里，配套一条守卫禁止任何地方再写第二份。
 *
 * ## 判据为什么看 header 而不是「是不是 cookie 会话」
 *
 * 机器凭据一律通过 header 出示（`x-ai-access-key` / 兼容写法 `ai-access-key` /
 * `Authorization: Bearer`），浏览器靠 cookie。看 header 在**每种鉴权模式下都成立**；
 * 反过来用 `_cdsCookieAuth` 判则不然——`CDS_AUTH_MODE=disabled` 的实例压根不签会话，
 * 那个标志永远是假，真人用浏览器打开会被判成机器，什么都看不到且没有任何报错。
 */

/** 调用方是不是机器凭据。 */
export function isMachineCaller(req: unknown): boolean {
  const r = req as {
    headers?: Record<string, unknown>;
    cdsProjectKey?: unknown;
    cdsPrincipal?: unknown;
  };
  // 已 stamp 的作用域标记：走到这里时它们已经证明了调用方是一把范围受限的钥匙
  if (r.cdsProjectKey || r.cdsPrincipal) return true;
  const h = r.headers || {};
  if (typeof h['x-ai-access-key'] === 'string' && h['x-ai-access-key']) return true;
  if (typeof h['ai-access-key'] === 'string' && h['ai-access-key']) return true;
  const auth = h['authorization'];
  if (typeof auth === 'string' && /^bearer\s+\S/i.test(auth)) return true;
  return false;
}
