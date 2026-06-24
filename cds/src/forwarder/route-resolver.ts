/**
 * Forwarder 路由解析器(B'.2-forwarder)
 *
 * 对应 doc/report.cds.forwarder-success.md
 *
 * 纯函数:输入 (routes, host, path) → 返回唯一命中的 RouteRecord 或 null。
 * 不发 HTTP、不 IO、不 throw(参数缺陷返 null)。
 *
 * 匹配优先级(从高到低):
 *   1. host:精确 host 优先于通配 *.miduo.org;通配只匹配单级子域(a.b 不会被 *.b 匹配错位)
 *   2. weight=0 跳过(等于禁用)
 *   3. pathPrefix:有定义的按长度降序优先(更具体先);空串视为 "/"
 *   4. 等权重等优先级时按 _id 字典序稳定选第一条
 */

import type { RouteRecord } from './types.js';

/**
 * 候选项:从 (routes, host, path) 过滤后留下的可能命中,带"匹配评分"用于排序。
 *
 * 评分维度优先级(从高到低):
 *   1. hostScore:精确 = 2,通配 = 1
 *   2. pathPrefixLen:数值越大越具体
 *   3. _id:字典序升序(稳定 tie-break)
 */
interface Candidate {
  route: RouteRecord;
  hostScore: 1 | 2;
  pathPrefixLen: number;
}

/**
 * host 是否匹配 pattern。
 *
 * 规则:
 *   - 精确字符串(无通配 `*`):大小写不敏感全等
 *   - `*.suffix`:host 必须严格"单级子域 + 同 suffix",即 host = `<label>.suffix`
 *     - `*.miduo.org` 命中 `demo.miduo.org` (yes)
 *     - `*.miduo.org` 不命中 `a.b.miduo.org` (no,走显式 `*.b.miduo.org` 或精确)
 *     - `*.miduo.org` 不命中 `miduo.org` 本身 (no)
 *   - 其他形式(如中间带 `*`)目前不支持,返回 false
 */
export function hostMatches(pattern: string, host: string): boolean {
  if (!pattern || !host) return false;
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (!p.includes('*')) {
    return p === h;
  }
  if (p.startsWith('*.')) {
    const suffix = p.slice(2); // 去掉 "*."
    if (!suffix) return false;
    if (!h.endsWith(`.${suffix}`)) return false;
    const label = h.slice(0, h.length - suffix.length - 1); // 去掉 .suffix
    if (!label) return false; // *.miduo.org 不应命中 miduo.org 本身
    if (label.includes('.')) return false; // 不允许多级
    return true;
  }
  return false;
}

/**
 * pathPrefix 是否匹配 path。
 *   - 空 / undefined / "/" 视为"任何路径都命中"
 *   - 否则要求 path 以 prefix 起始
 */
export function pathPrefixMatches(prefix: string | undefined, path: string): boolean {
  if (!prefix || prefix === '' || prefix === '/') return true;
  // 防御:path 应以 / 起始;不强求,但匹配比较宽松
  return path.startsWith(prefix);
}

/**
 * 计算 hostScore;不匹配返 0。
 */
function hostScore(pattern: string, host: string): 0 | 1 | 2 {
  if (!pattern.includes('*')) {
    return pattern.toLowerCase() === host.toLowerCase() ? 2 : 0;
  }
  return hostMatches(pattern, host) ? 1 : 0;
}

/**
 * 主入口。
 */
export function resolveRoute(
  routes: RouteRecord[],
  host: string,
  path: string,
): RouteRecord | null {
  if (!routes || routes.length === 0) return null;
  if (!host) return null;

  const candidates: Candidate[] = [];
  for (const r of routes) {
    if (!r) continue;
    if (typeof r.weight === 'number' && r.weight <= 0) continue; // 跳过禁用
    const hs = hostScore(r.host, host);
    if (hs === 0) continue;
    if (!pathPrefixMatches(r.pathPrefix, path)) continue;
    candidates.push({
      route: r,
      hostScore: hs,
      pathPrefixLen: (r.pathPrefix ?? '').length,
    });
  }

  if (candidates.length === 0) return null;

  // 排序:hostScore desc → pathPrefixLen desc → _id asc
  candidates.sort((a, b) => {
    if (b.hostScore !== a.hostScore) return b.hostScore - a.hostScore;
    if (b.pathPrefixLen !== a.pathPrefixLen) return b.pathPrefixLen - a.pathPrefixLen;
    const aid = String(a.route._id);
    const bid = String(b.route._id);
    if (aid < bid) return -1;
    if (aid > bid) return 1;
    return 0;
  });

  return candidates[0].route;
}
