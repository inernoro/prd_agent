/**
 * 主域名路由的「按名约定」（唯一定义处）。
 *
 * forwarder 在主域名上发三层路由：① 显式 `cds.path-prefix`；② 没人声明 `/api/` 时，
 * 按服务名约定把 `/api/*` 交给 id 含 api / backend 的服务；③ 其余路径交给默认站
 * （id 含 web / frontend / admin，否则第一个）。②③ 是名字推导，只在没有显式声明时兜底。
 *
 * 发布器（forwarder-route-publisher）与服务图（service-graph 的站点分组 / 角色推断）
 * 必须用同一份判定，否则画布画的和 forwarder 走的会各说各话
 * （predicate-and-wiring-discipline 形状 3）。改这里要同时跑两边的测试。
 */

/** 默认站（承载主域名上未被任何前缀命中的路径）：id 含 web / frontend / admin 优先，否则第一个。 */
export function pickDefaultProfile(profileIds: string[]): string {
  const webProfile = profileIds.find(
    (id) => id.includes('web') || id.includes('frontend') || id.includes('admin'),
  );
  if (webProfile) return webProfile;
  return profileIds[0];
}

/** `/api/*` 的按名约定：id 含 api / backend 的第一个服务（大小写敏感，与 master detectProfileFromRequest 对齐）。 */
export function pickApiConventionProfile(profileIds: string[]): string | undefined {
  return profileIds.find((id) => id.includes('api') || id.includes('backend'));
}

/** 服务名里「像前端」的词根（只用于角色推断的名字信号，不参与路由）。 */
export const WEB_NAME_RE = /web|admin|front|console|ui|portal|site|www|dashboard/i;
/** 服务名里「像后端接口」的词根。 */
export const API_NAME_RE = /api|gateway|\bgw\b|serve|server|service|backend/i;
/** 服务名里「像后台任务」的词根。 */
export const WORKER_NAME_RE = /worker|job|bootstrap|cron|consumer|migrat|seed|scheduler|runner/i;

/** 探活语义的路径段（与 topology-lint / web-entry 同一份口径；发布器据此不给探活路径发公网路由）。 */
export const OPERATIONAL_PROBE_PREFIX_RE = /(?:^|\/)(?:health|healthz|health-check|ready|readyz|readiness|live|livez|liveness|actuator|metrics)(?:\/|\?|$)/i;
export function isOperationalProbePrefix(prefix: string): boolean {
  const p = prefix.trim();
  return p !== '/' && OPERATIONAL_PROBE_PREFIX_RE.test(p);
}

export interface RoutableProfile {
  id: string;
  pathPrefixes?: readonly string[];
}

/**
 * 「这条路径在主域名上该给哪个服务」的唯一判定（plan.cds.service-relations 第二批）。
 *
 * 与 forwarder 对已发布路由的解析结果逐字一致：
 *   1. 声明前缀里最长匹配者胜；同一前缀被多个服务声明时按 id 字典序取第一个
 *      （发布器同样按 id 排序去重，所以两边一致）；探活前缀不参与（发布器不发布它们）；
 *   2. 没有声明命中且路径以 /api/ 开头、又没人声明 /api/ → 按名约定（id 含 api / backend）；
 *   3. 都没有 → 默认站（id 含 web / frontend / admin，否则第一个）。
 * master 兜底代理必须调这个函数而不是自己再写一套，否则转发器暂时没路由的窗口里
 * 同一 URL 会落到不同服务（2026-09-02 用户反馈「A 入口偶发进 B 端口」的机制之一）。
 */
export function resolveProfileForPath(profiles: readonly RoutableProfile[], path: string): string | undefined {
  const ordered = [...profiles].sort((a, b) => a.id.localeCompare(b.id));
  if (ordered.length === 0) return undefined;
  const url = path || '/';
  let best: { id: string; len: number } | undefined;
  for (const p of ordered) {
    for (const raw of p.pathPrefixes ?? []) {
      const prefix = raw.trim();
      if (!prefix || isOperationalProbePrefix(prefix)) continue;
      const hit = prefix === '/' || url.startsWith(prefix);
      if (!hit) continue;
      if (!best || prefix.length > best.len) best = { id: p.id, len: prefix.length };
    }
  }
  if (best) return best.id;
  const ids = ordered.map((p) => p.id);
  const declaresApi = ordered.some((p) => (p.pathPrefixes ?? []).some((x) => x.trim() === '/api/'));
  if (url.startsWith('/api/') && !declaresApi) {
    const api = pickApiConventionProfile(ids);
    if (api) return api;
  }
  return pickDefaultProfile(ids);
}
