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
