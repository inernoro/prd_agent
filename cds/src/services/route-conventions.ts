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

/** 发布器只给这些状态的服务发路由（与 proxy / 引用解析器共用同一份口径） */
export const ROUTABLE_SERVICE_STATUSES = new Set(['running', 'starting', 'building', 'restarting']);

export interface RoutableProfile {
  id: string;
  pathPrefixes?: readonly string[];
}

export interface MainDomainRoutes {
  /** 主域名上承载根路径的服务（壳）；没有服务时为空 */
  shellId?: string;
  /** declared = 有人声明了 `/`；convention = 没人声明，按名兜底 */
  shellSource?: 'declared' | 'convention';
  /** 每个服务在主域名上的非根前缀（含按名约定补上的 `/api/`），探活前缀已剔除 */
  prefixes: Map<string, string[]>;
  /** 靠按名约定拿到 `/api/` 的服务 */
  viaConvention: Set<string>;
  /** 每个前缀（含 `/`）被哪些服务声明；多于一个即冲突 */
  claims: Map<string, string[]>;
}

/**
 * 「主域名上谁拥有哪条路由」的唯一判定，与发布器逐字一致：
 *   - 前缀按声明；同一前缀多人声明时按 id 字典序第一个胜（发布器 writtenPrefixes 先到先得、
 *     routableServices 先按 id 排），其余记入 claims 供体检报冲突；
 *   - 没人声明 `/` 时默认站按名兜底；没人声明 `/api/` 时按名约定给 id 含 api / backend 的服务；
 *   - 探活前缀不进路由。
 * 服务图的站点分组、引用解析器判「这个服务有没有公网路由」都调这里，不各写一份。
 */
export function resolveMainDomainRoutes(profiles: readonly RoutableProfile[]): MainDomainRoutes {
  const ids = profiles.map((p) => p.id).sort((a, b) => a.localeCompare(b));
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const claims = new Map<string, string[]>();
  const prefixes = new Map<string, string[]>();
  for (const id of ids) {
    for (const raw of byId.get(id)?.pathPrefixes || []) {
      const prefix = raw.trim();
      if (!prefix) continue;
      // claims 保留探活前缀：体检要据此报「探活进前缀」与它们之间的冲突；路由归属（prefixes）才剔除
      const owners = claims.get(prefix) ?? [];
      if (!owners.includes(id)) owners.push(id);
      claims.set(prefix, owners);
      if (prefix !== '/' && !isOperationalProbePrefix(prefix)) {
        const mine = prefixes.get(id) ?? [];
        if (!mine.includes(prefix)) mine.push(prefix);
        prefixes.set(id, mine);
      }
    }
  }
  const rootOwners = claims.get('/') ?? [];
  let shellId: string | undefined;
  let shellSource: MainDomainRoutes['shellSource'];
  if (rootOwners.length > 0) {
    shellId = [...rootOwners].sort((a, b) => a.localeCompare(b))[0];
    shellSource = 'declared';
  } else if (ids.length > 0) {
    shellId = pickDefaultProfile(ids);
    shellSource = 'convention';
  }
  const viaConvention = new Set<string>();
  if (!claims.has('/api/')) {
    const apiId = pickApiConventionProfile(ids);
    if (apiId && apiId !== shellId) {
      prefixes.set(apiId, [...(prefixes.get(apiId) ?? []), '/api/']);
      viaConvention.add(apiId);
    }
  }
  return { shellId, shellSource, prefixes, viaConvention, claims };
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
