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

import type { ReplicaResolveContext, RouteRecord } from './types.js';

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
 *
 * 复制集扩展（design.cds.replica-set）：命中的最优路由若带 replicaGroup，
 * 则在「同组 + 同 host 评分 + 同 prefix 长度」的兄弟路由里二次选择：
 *   1. 粘性命中（ctx.sticky === replicaMemberId）优先——weight=0 的成员也可被
 *      粘性直达（0 只表示不参与随机分流，不表示禁用）；
 *   2. 否则按 weight 加权随机（ctx.rand，默认 Math.random）；
 *   3. 总权重为 0 时回落主成员（replicaMemberId='primary'），再退组内第一条。
 * 不带 replicaGroup 的存量路由行为与历史逐字节一致（weight<=0 仍视为禁用）。
 */
export function resolveRoute(
  routes: RouteRecord[],
  host: string,
  path: string,
  ctx?: ReplicaResolveContext,
): RouteRecord | null {
  if (!routes || routes.length === 0) return null;
  if (!host) return null;

  const candidates: Candidate[] = [];
  for (const r of routes) {
    if (!r) continue;
    // weight<=0 = 禁用 —— 但复制集成员例外:0 权重成员仍可被粘性直达
    if (typeof r.weight === 'number' && r.weight <= 0 && !r.replicaGroup) continue;
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

  const top = candidates[0];
  if (!top.route.replicaGroup) return top.route;

  const siblings = candidates.filter(
    (c) =>
      c.route.replicaGroup === top.route.replicaGroup
      && c.hostScore === top.hostScore
      && c.pathPrefixLen === top.pathPrefixLen,
  );
  return pickReplica(siblings.map((c) => c.route), ctx);
}

/** 组内选择：粘性 → 加权随机 → 主成员回落。导出供单测直接覆盖分布。 */
export function pickReplica(group: RouteRecord[], ctx?: ReplicaResolveContext): RouteRecord {
  if (group.length === 1) return group[0];
  if (ctx?.sticky) {
    const stuck = group.find((r) => r.replicaMemberId === ctx.sticky);
    if (stuck) return stuck;
  }
  const weighted = group.filter((r) => (r.weight ?? 0) > 0);
  const total = weighted.reduce((sum, r) => sum + (r.weight ?? 0), 0);
  if (total <= 0) {
    return group.find((r) => r.replicaMemberId === 'primary') ?? group[0];
  }
  const rand = ctx?.rand ?? Math.random;
  let cursor = rand() * total;
  for (const r of weighted) {
    cursor -= r.weight ?? 0;
    if (cursor < 0) return r;
  }
  return weighted[weighted.length - 1];
}
