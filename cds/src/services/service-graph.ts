/**
 * 服务调用关系图推导（复制集两页签定案 2026-07-24，doc/debt.cds.md「CDS 复制集模式工程债务」 #22）。
 *
 * 容器级画布需要「前端页面调用某个服务、某个服务调用另一个服务」的顺序调用关系。
 * 关系在服务端推导（前端零猜测），来源三条：
 *   1. env 值里的主机名引用 —— compose 服务经容器网络互调时 env 会写
 *      `http://<profileId>-<slug>:port` 这类地址；按「最长 id 优先」匹配，
 *      避免 llmgw 抢走 llmgw-serve-prd-agent 的引用；
 *   2. env 值里的 `${CDS_<INFRA>_PORT}` 模板 —— 服务对基础设施的引用
 *      （与 state.ts 注入的 `CDS_${id.toUpperCase().replace(/-/g,'_')}_PORT` 同规则）；
 *   3. compose depends_on（BuildProfile.dependsOn）。
 *
 * 安全边界：输出只含 env **键名**，env 值（可能含连接串 / 密钥）绝不出网。
 */
import type { BuildProfile, InfraService, ServiceRole } from '../types.js';
import { API_NAME_RE, WEB_NAME_RE, WORKER_NAME_RE, resolveMainDomainRoutes } from './route-conventions.js';
import { handlesRootPath } from './web-entry.js';

export interface ServiceGraphNode {
  /** 带命名空间前缀的唯一 id（`service:<id>` / `infra:<id>`），跨两类节点不撞名。 */
  id: string;
  /** 原始 profileId / infraId（前端按 profileId 关联复制集时用这个）。 */
  rawId: string;
  name: string;
  kind: 'service' | 'infra';
  /** 入口 forwarder 按这些前缀把公网流量路由给它（有值 = 入口直达） */
  pathPrefixes?: string[];
  /** 命名子域（有值 = 独立公网入口） */
  subdomain?: string;
  containerPort?: number;
  dockerImage?: string;
  /** 服务角色（web / api / worker）：声明优先，否则按路由事实与服务名推断。 */
  role?: ServiceRole;
  /** 角色的来源：声明 / 路由事实 / 服务名 / 兜底默认。前端据此标「推断」。 */
  roleSource?: RoleSource;
  /** 一句话说明角色是怎么得出的（给人看的证据）。 */
  roleReason?: string;
}

export type RoleSource = 'declared' | 'route' | 'name' | 'default';
export interface ServiceRoleVerdict { role: ServiceRole; source: RoleSource; reason: string }

/** 站点成员：同一 host 下按前缀分流给它的服务。 */
export interface ServiceGraphSiteMember {
  id: string;
  /** 主域名上命中它的前缀（子域站点的壳不列前缀：整个 host 都是它的）。 */
  prefixes: string[];
  /** true = 没人声明 `/api/`，由「id 含 api/backend」的按名约定接管。 */
  viaConvention?: boolean;
}

/**
 * 站点 = 一个公网 host。主域名一个站点，每个 `cds.subdomain` 各一个站点。
 * 站点里承载根路径（或按名兜底承载未匹配路径）的服务是「壳」，通常就是静态站；
 * 其余成员按前缀挂在壳下面——这就是「API 在静态文件之下」在路由事实上的含义：
 * 同一个 host，forwarder 按最长前缀分流，静态容器并不代理这些请求。
 */
export interface ServiceGraphSite {
  id: string;
  kind: 'main' | 'subdomain';
  subdomain?: string;
  shellId?: string;
  /** declared = 显式 `cds.path-prefix: /`；convention = 无人声明根路径，按名兜底（pickDefaultProfile）。 */
  shellSource?: 'declared' | 'convention';
  members: ServiceGraphSiteMember[];
  /** 同一 host 上被多个服务同时声明的前缀（forwarder 只能按 id 字典序二选一，属配置缺陷）。 */
  conflicts: Array<{ prefix: string; ids: string[] }>;
}

export interface ServiceGraphEdge {
  /** 调用方（发起请求的服务） */
  from: string;
  /** 被调方（服务或基础设施） */
  to: string;
  /** 证据：调用方哪些 env 键的值引用了被调方（只给键名） */
  envKeys: string[];
  /** 证据：compose depends_on 声明 */
  dependsOn: boolean;
  /** 证据：调用方用 cds.calls 显式声明了这条调用 */
  declared?: boolean;
}

export interface ServiceGraph {
  nodes: ServiceGraphNode[];
  edges: ServiceGraphEdge[];
  /** 服务节点自上而下分层：第 0 层没人调用（入口直达面），被调服务逐层下沉。环路兜底封顶。 */
  layers: string[][];
  /** 公网站点分组（入口 → 站点 → 壳 → 前缀成员），与 forwarder 发布规则同源。 */
  sites: ServiceGraphSite[];
  /** 没有任何公网路由的服务：只能被别的服务经容器网络调用（画布挂在引用它的服务下面）。 */
  internal: string[];
  /** cds.calls 里指向不存在服务的声明（写错或已删除），体检据此报 unknown-callee */
  unresolvedCalls: Array<{ from: string; callee: string }>;
}

const OPERATIONAL_PROBE_RE = /(?:^|\/)(?:health|healthz|health-check|ready|readyz|readiness|live|livez|liveness|actuator|metrics)(?:\/|\?|$)/i;
/** 「一看就是接口」的前缀：全部命中才算路由层面的 api 证据。 */
const API_PREFIX_RE = /^\/(?:api|graphql|gw|gateway|rpc|ws|socket|v\d+|health|healthz|actuator|metrics|swagger|openapi)(?:[\/\-?]|$)/i;

type RoleInput = Pick<BuildProfile, 'id' | 'role' | 'pathPrefixes' | 'subdomain' | 'webEntry' | 'readinessProbe'>;

function nameRole(id: string): { role: ServiceRole; hit: string } | null {
  const worker = WORKER_NAME_RE.exec(id);
  if (worker) return { role: 'worker', hit: worker[0] };
  const api = API_NAME_RE.exec(id);
  const web = WEB_NAME_RE.exec(id);
  if (api && web) {
    // 两种词根都命中时取靠后的那个：后缀才是名词本体（admin-api 是接口，api-admin 是页面）
    const apiLast = id.toLowerCase().lastIndexOf(api[0].toLowerCase());
    const webLast = id.toLowerCase().lastIndexOf(web[0].toLowerCase());
    return apiLast >= webLast ? { role: 'api', hit: api[0] } : { role: 'web', hit: web[0] };
  }
  if (api) return { role: 'api', hit: api[0] };
  if (web) return { role: 'web', hit: web[0] };
  return null;
}

/**
 * 服务角色判定（唯一定义处；前端只消费结果，不再自己按名字猜）。
 *
 * 优先级：① 显式 `cds.role` → ② 强路由事实（声明了用户入口 / 声明不监听 HTTP /
 * 承载根路径且探活是页面）→ ③ 服务名词根 → ④ 弱路由特征（前缀全是接口样式 /
 * 探活是健康检查 / 探活是页面 / 按名兜底成了默认站）→ ⑤ 默认按 api。
 * 名字在中间：它比「探活路径长什么样」可信，但比「配置里写了什么」不可信。
 * 每个结论都带 source + reason，画布把非声明的标成「推断」。
 */
export function inferServiceRole(
  p: RoleInput,
  ctx: { apiConventionId?: string; defaultProfileId?: string } = {},
): ServiceRoleVerdict {
  if (p.role) return { role: p.role, source: 'declared', reason: `配置声明 cds.role: ${p.role}` };

  const readiness = (p.readinessProbe?.path || '').trim();
  const readinessIsProbe = readiness !== '' && OPERATIONAL_PROBE_RE.test(readiness);
  const readinessIsPage = readiness !== '' && !readinessIsProbe;
  const prefixes = (p.pathPrefixes || []).map((x) => x.trim()).filter(Boolean);
  const ownsRoot = handlesRootPath(p);

  if (p.webEntry?.name) return { role: 'web', source: 'route', reason: `声明了用户入口「${p.webEntry.name}」` };
  if (p.readinessProbe?.noHttp) return { role: 'worker', source: 'route', reason: '声明不监听 HTTP（cds.no-http-readiness）' };
  if (ownsRoot && readinessIsPage) return { role: 'web', source: 'route', reason: '承载根路径且探活路径是页面' };

  const byName = nameRole(p.id);
  if (byName) return { role: byName.role, source: 'name', reason: `服务名含「${byName.hit}」` };

  const nonRoot = prefixes.filter((x) => x !== '/');
  if (nonRoot.length > 0 && nonRoot.every((x) => API_PREFIX_RE.test(x))) {
    return { role: 'api', source: 'route', reason: `路由前缀 ${nonRoot.join(' ')} 都是接口样式` };
  }
  if (readinessIsProbe) return { role: 'api', source: 'route', reason: `探活路径 ${readiness} 是健康检查` };
  if (readinessIsPage) return { role: 'web', source: 'route', reason: `探活路径 ${readiness} 是页面` };
  if (ownsRoot || p.subdomain) return { role: 'web', source: 'route', reason: ownsRoot ? '承载根路径' : `独占子域 ${p.subdomain}` };
  if (ctx.defaultProfileId === p.id) return { role: 'web', source: 'route', reason: '按名兜底成为主域名默认站' };
  if (ctx.apiConventionId === p.id) return { role: 'api', source: 'route', reason: '按名约定接管 /api/' };
  return { role: 'api', source: 'default', reason: '无声明、无路由特征、名字无法判断，默认按接口显示' };
}

/**
 * 站点分组（与 forwarder-route-publisher 的主域名三层路由 + 命名子域路由同源）：
 *   主域名：显式前缀 → 按名约定 `/api/`（无人声明时）→ 默认站兜底；
 *   子域：每个 `cds.subdomain` 一个站点，整个 host 归该服务。
 * 壳的选择：显式 `/` 的服务；多个都声明 `/` 时优先 web-entry primary，再优先角色为 web 的，
 * 最后按 id 排序取第一，并记入 conflicts；无人声明 `/` 时按名兜底（pickDefaultProfile）。
 */
export function buildServiceSites(
  profiles: readonly RoleInput[],
  roles: ReadonlyMap<string, ServiceRoleVerdict>,
): { sites: ServiceGraphSite[]; internal: string[] } {
  // 主域名归属（壳 / 前缀成员 / 按名约定 / 冲突）只在 route-conventions.resolveMainDomainRoutes 判一次，
  // 与发布器逐字一致：同一前缀多人声明按 id 字典序先到先得，壳不再按 webEntry / 角色另挑一套
  //（Codex 五轮 P2：图说 b-web 是壳、发布器却把 / 给了 a-api）。
  const ids = profiles.map((p) => p.id).sort((a, b) => a.localeCompare(b));
  const routes = resolveMainDomainRoutes(profiles);
  const conflicts = Array.from(routes.claims.entries())
    .filter(([, owners]) => owners.length > 1)
    .map(([prefix, owners]) => ({ prefix, ids: [...owners].sort() }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
  const shellId = routes.shellId;
  const shellSource = routes.shellSource;
  const members: ServiceGraphSiteMember[] = [];
  for (const id of ids) {
    if (id === shellId) continue;
    const prefixes = routes.prefixes.get(id);
    if (prefixes && prefixes.length > 0) members.push({ id, prefixes, ...(routes.viaConvention.has(id) ? { viaConvention: true } : {}) });
  }

  const sites: ServiceGraphSite[] = [];
  if (ids.length > 0) {
    sites.push({ id: 'main', kind: 'main', shellId, shellSource, members, conflicts });
  }
  const seenSub = new Set<string>();
  for (const p of profiles) {
    const sub = (p.subdomain || '').trim();
    if (!sub || seenSub.has(sub)) continue;
    seenSub.add(sub);
    sites.push({ id: `sub:${sub}`, kind: 'subdomain', subdomain: sub, shellId: p.id, shellSource: 'declared', members: [], conflicts: [] });
  }

  const routed = new Set<string>();
  for (const site of sites) {
    if (site.shellId) routed.add(site.shellId);
    for (const m of site.members) routed.add(m.id);
  }
  const internal = ids.filter((id) => !routed.has(id));
  return { sites, internal };
}

/** 从 env 值里提取「像主机名的 token」：`://host`、`@host`、`host:port` 三种上下文。 */
export function extractHostTokens(value: string): string[] {
  const out = new Set<string>();
  const urlRe = /(?:\/\/|@)([a-zA-Z0-9][a-zA-Z0-9._-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(value))) out.add(m[1]);
  const hostPortRe = /(?:^|[\s"'=,;(])([a-zA-Z0-9][a-zA-Z0-9._-]*):(\d{2,5})(?=[/\s"',;)]|$)/g;
  while ((m = hostPortRe.exec(value))) out.add(m[1]);
  return Array.from(out);
}

/**
 * host token 归属判定：token 恰为 id，或以 `<id>-` / `<id>.` 开头
 * （容器名是 `<profileId>-<projectSlug>` 形态）。候选按 id 长度降序，
 * 第一个命中即返回 —— llmgw-serve 优先于 llmgw。
 */
export function matchHostToId(host: string, idsByLengthDesc: string[]): string | null {
  const h = host.toLowerCase();
  for (const id of idsByLengthDesc) {
    const low = id.toLowerCase();
    if (h === low || h.startsWith(`${low}-`) || h.startsWith(`${low}.`)) return id;
  }
  return null;
}

/** 基础设施端口模板变量名（与 state.ts 注入规则同源） */
export function infraPortVar(infraId: string): string {
  return `CDS_${infraId.toUpperCase().replace(/-/g, '_')}_PORT`;
}

/**
 * 图节点 id 分命名空间（Codex 第二十七轮 P2）。
 *
 * 此前节点 id 直接用 profileId / infraId 原值，两个命名空间共用一个平面：项目里
 * 只要存在同名的服务与基础设施（例如自管一个叫 `mongodb` 的服务 + 一个 `mongodb`
 * 基础设施），后果有两层——① 真实的「服务 → 基础设施」依赖在 upsert 里表现为
 * from === to 被当成自环丢弃；② 响应里出现重复 id，前端 `new Map(nodes.map(...))`
 * 后写覆盖先写，画布渲染成错的。
 *
 * 分层数组 `layers` 仍是**原始 profileId**（按构造只含服务，前端直接当 profileId 用）。
 */
export const SERVICE_NODE_PREFIX = 'service:';
export const INFRA_NODE_PREFIX = 'infra:';
export const serviceNodeId = (id: string): string => `${SERVICE_NODE_PREFIX}${id}`;
export const infraNodeId = (id: string): string => `${INFRA_NODE_PREFIX}${id}`;

/** 反解节点 id；不带前缀的旧数据按 unknown 原样返回，消费方自行兜底。 */
export function parseNodeId(nodeId: string): { kind: 'service' | 'infra' | 'unknown'; id: string } {
  if (nodeId.startsWith(SERVICE_NODE_PREFIX)) return { kind: 'service', id: nodeId.slice(SERVICE_NODE_PREFIX.length) };
  if (nodeId.startsWith(INFRA_NODE_PREFIX)) return { kind: 'infra', id: nodeId.slice(INFRA_NODE_PREFIX.length) };
  return { kind: 'unknown', id: nodeId };
}

export function buildServiceGraph(profiles: BuildProfile[], infra: InfraService[]): ServiceGraph {
  const ids = profiles.map((p) => p.id);
  // 角色推断用的「按名兜底成为默认站 / 按名约定接管 /api/」取自与发布器同一份主域名判定，
  // 否则输入顺序不同时徽标和站点壳会各说各话（Codex 六轮 P2）
  const mainRoutes = resolveMainDomainRoutes(profiles);
  const roleCtx = {
    apiConventionId: [...mainRoutes.viaConvention][0],
    defaultProfileId: mainRoutes.shellSource === 'convention' ? mainRoutes.shellId : undefined,
  };
  const roles = new Map<string, ServiceRoleVerdict>(profiles.map((p) => [p.id, inferServiceRole(p, roleCtx)]));
  const nodes: ServiceGraphNode[] = [
    ...profiles.map((p): ServiceGraphNode => {
      const verdict = roles.get(p.id)!;
      return {
        id: serviceNodeId(p.id),
        rawId: p.id,
        name: p.name || p.id,
        kind: 'service',
        pathPrefixes: p.pathPrefixes,
        subdomain: p.subdomain,
        containerPort: p.containerPort,
        role: verdict.role,
        roleSource: verdict.source,
        roleReason: verdict.reason,
      };
    }),
    ...infra.map((s): ServiceGraphNode => ({
      id: infraNodeId(s.id),
      rawId: s.id,
      name: (s as { name?: string }).name || s.id,
      kind: 'infra',
      dockerImage: (s as { dockerImage?: string }).dockerImage,
    })),
  ];

  const serviceIds = profiles.map((p) => p.id);
  const infraIds = infra.map((s) => s.id);
  const allIdsDesc = [...serviceIds, ...infraIds].sort((a, b) => b.length - a.length);
  const infraIdSet = new Set(infraIds);
  const serviceIdSet = new Set(serviceIds);

  const edgeMap = new Map<string, ServiceGraphEdge>();

  const unresolvedCalls: Array<{ from: string; callee: string }> = [];
  const upsert = (from: string, to: string, envKey?: string, viaDepends?: boolean, viaDeclared?: boolean): void => {
    if (from === to) return;
    const key = `${from}\u0000${to}`;
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { from, to, envKeys: [], dependsOn: false };
      edgeMap.set(key, edge);
    }
    if (envKey && !edge.envKeys.includes(envKey)) edge.envKeys.push(envKey);
    if (viaDepends) edge.dependsOn = true;
    if (viaDeclared) edge.declared = true;
  };

  for (const p of profiles) {
    const self = serviceNodeId(p.id);
    for (const [envKey, raw] of Object.entries(p.env ?? {})) {
      const value = String(raw ?? '');
      if (!value) continue;
      // 1) 主机名引用（服务或基础设施）。同名时服务优先——与 docker 网络别名的
      //    解析顺序无关紧要：同一网络上两个容器不可能占用同一个别名，真撞名属病态配置。
      for (const host of extractHostTokens(value)) {
        const target = matchHostToId(host, allIdsDesc);
        if (!target) continue;
        const targetNode = serviceIdSet.has(target) ? serviceNodeId(target) : infraNodeId(target);
        if (targetNode !== self) upsert(self, targetNode, envKey);
      }
      // 2) `${CDS_<INFRA>_PORT}` 模板引用
      for (const infraId of infraIds) {
        if (value.includes(infraPortVar(infraId))) upsert(self, infraNodeId(infraId), envKey);
      }
    }
    // 3) depends_on 声明（可指向服务或基础设施）
    for (const dep of p.dependsOn ?? []) {
      if (serviceIdSet.has(dep) && serviceNodeId(dep) !== self) upsert(self, serviceNodeId(dep), undefined, true);
      else if (infraIdSet.has(dep)) upsert(self, infraNodeId(dep), undefined, true);
    }
    // 4) cds.calls 显式声明的调用；写错 / 已删除的被调方不画边但保留下来，由体检报 unknown-callee
    for (const callee of p.calls ?? []) {
      if (serviceIdSet.has(callee)) {
        if (serviceNodeId(callee) !== self) upsert(self, serviceNodeId(callee), undefined, false, true);
      } else if (!infraIdSet.has(callee)) {
        unresolvedCalls.push({ from: p.id, callee });
      }
    }
  }

  const edges = Array.from(edgeMap.values());

  // ── 服务分层（只对 service 节点；infra 由数据层框承载）──
  // depth[callee] >= depth[caller] + 1。松弛 V 轮：有环时深度封顶，不死循环。
  // 深度按**原始 profileId** 计（layers 对外仍是原始 id），边端点先反解命名空间
  const depth = new Map<string, number>(serviceIds.map((id) => [id, 0]));
  const svcEdges = edges
    .map((e) => ({ from: parseNodeId(e.from), to: parseNodeId(e.to) }))
    .filter((e) => e.from.kind === 'service' && e.to.kind === 'service'
      && serviceIdSet.has(e.from.id) && serviceIdSet.has(e.to.id));
  for (let round = 0; round < serviceIds.length; round += 1) {
    let changed = false;
    for (const e of svcEdges) {
      const want = (depth.get(e.from.id) ?? 0) + 1;
      if (want > (depth.get(e.to.id) ?? 0) && want < serviceIds.length + 1) {
        depth.set(e.to.id, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const maxDepth = serviceIds.length ? Math.max(...serviceIds.map((id) => depth.get(id) ?? 0)) : 0;
  const layers: string[][] = [];
  for (let d = 0; d <= maxDepth; d += 1) {
    const layer = serviceIds.filter((id) => (depth.get(id) ?? 0) === d).sort();
    if (layer.length) layers.push(layer);
  }

  const { sites, internal } = buildServiceSites(profiles, roles);
  return { nodes, edges, layers, sites, internal, unresolvedCalls };
}
