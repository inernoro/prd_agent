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
import type { BuildProfile, InfraService } from '../types.js';

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
}

export interface ServiceGraph {
  nodes: ServiceGraphNode[];
  edges: ServiceGraphEdge[];
  /** 服务节点自上而下分层：第 0 层没人调用（入口直达面），被调服务逐层下沉。环路兜底封顶。 */
  layers: string[][];
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
  const nodes: ServiceGraphNode[] = [
    ...profiles.map((p): ServiceGraphNode => ({
      id: serviceNodeId(p.id),
      rawId: p.id,
      name: p.name || p.id,
      kind: 'service',
      pathPrefixes: p.pathPrefixes,
      subdomain: p.subdomain,
      containerPort: p.containerPort,
    })),
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
  const upsert = (from: string, to: string, envKey?: string, viaDepends?: boolean): void => {
    if (from === to) return;
    const key = `${from}\u0000${to}`;
    let edge = edgeMap.get(key);
    if (!edge) {
      edge = { from, to, envKeys: [], dependsOn: false };
      edgeMap.set(key, edge);
    }
    if (envKey && !edge.envKeys.includes(envKey)) edge.envKeys.push(envKey);
    if (viaDepends) edge.dependsOn = true;
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

  return { nodes, edges, layers };
}
