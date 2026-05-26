/**
 * Topology Aggregator — 网络拓扑数据聚合器
 *
 * 把"系统的真实状态"从多个独立来源(env / docker / nginx-conf /
 * process-self / 文件)聚合成一张可被 ReactFlow 渲染的图:
 *
 *   - domains       (env CDS_ROOT_DOMAINS + project routingRules)
 *   - nginxUpstreams(解析 cds-active-upstream.conf)
 *   - forwarder     (HTTP 探测 :9090/__forwarder/healthz)
 *   - master        (HTTP 探测 master :9900/healthz)
 *   - containers    (docker ps 通过 containerService discover*)
 *   - edges         (推导 nginx → forwarder / nginx → master / forwarder → 容器)
 *
 * 一致性检查产出 inconsistencies[]:
 *   - forwarder.routesCount vs running app containers
 *   - nginx upstream cds_master 的 target 端口 vs master daemon port
 *
 * 任一不一致 → healthy=false。
 *
 * 注入点(便于单测):createTopologyAggregator(deps) 工厂接收所有 IO 依赖,
 * 测试里全部 mock,完全无外部依赖。
 */

/** 数据来源标识 — 暴露给运维定位"为什么这条不对"。 */
export type TopologyDataSource =
  | 'config'
  | 'mongo'
  | 'nginx-conf'
  | 'process-self'
  | 'http-probe'
  | 'docker'
  | 'file';

export interface TopologyDomainNode {
  id: string;
  host: string;
  isWildcard: boolean;
  hasTls: boolean;
  dataSource: 'config' | 'mongo';
}

export interface TopologyUpstreamNode {
  id: string;
  name: string;
  /** "127.0.0.1:9090" 之类 */
  target: string;
  dataSource: 'nginx-conf';
}

export type TopologyForwarderRoutesHealth =
  | 'live'
  | 'fallback'
  | 'stale'
  | 'unknown';

export interface TopologyForwarderNode {
  id: 'forwarder';
  port: number;
  healthy: boolean;
  routesCount: number;
  routesHealthState: TopologyForwarderRoutesHealth;
  dataSource: 'process-self' | 'http-probe';
}

export interface TopologyMasterDaemonNode {
  id: 'master';
  port: number;
  alive: boolean;
  buildSha: string | null;
  uptime: number | null;
  dataSource: 'process-self' | 'http-probe' | 'file';
}

export interface TopologyContainerNode {
  id: string;
  name: string;
  branchId?: string;
  profileId?: string;
  port?: number;
  status: string;
  role: 'app' | 'infra';
  dataSource: 'docker';
}

export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  trafficWeight?: number;
  dataSource: TopologyDataSource;
}

export interface TopologyInconsistency {
  kind:
    | 'mongo-vs-forwarder'
    | 'forwarder-vs-docker'
    | 'nginx-vs-master';
  detail: string;
}

export interface TopologyPayload {
  healthy: boolean;
  inconsistencies: TopologyInconsistency[];
  domains: TopologyDomainNode[];
  nginxUpstreams: TopologyUpstreamNode[];
  forwarder: TopologyForwarderNode;
  master: TopologyMasterDaemonNode;
  containers: TopologyContainerNode[];
  edges: TopologyEdge[];
}

/** 仅用于路由表反查的最小记录形态(避免与 forwarder/types 强耦合)。 */
export interface AggregatorRouteRecord {
  host: string;
  pathPrefix?: string;
  upstreamHost?: string;
  upstreamPort: number;
  branchId?: string;
  weight?: number;
}

export interface AggregatorProjectLike {
  id: string;
  routingRules?: Array<{
    type?: string;
    match?: string;
    enabled?: boolean;
  }>;
}

export interface AggregatorAppContainerInfo {
  containerName: string;
  branchId: string;
  profileId: string;
  running: boolean;
  network?: string;
  /** 端口可选 — discover 函数可能不暴露 */
  port?: number;
}

export interface AggregatorInfraContainerInfo {
  containerName: string;
  serviceId: string;
  running: boolean;
}

export interface AggregatorForwarderProbe {
  healthy: boolean;
  port: number;
  routesCount: number;
  routesHealthState: TopologyForwarderRoutesHealth;
}

export interface AggregatorAdminProbe {
  alive: boolean;
  buildSha: string | null;
  uptime: number | null;
}

export interface TopologyAggregatorDeps {
  /** 域名根集合,通常来自 env CDS_ROOT_DOMAINS。 */
  readDomainsConfig: () => string[];
  /** 项目列表(routing rules 来源)。空数组也合法。 */
  readProjects: () => AggregatorProjectLike[];
  /** 直接喂 nginx active-upstream 文件文本,测试里直接传字符串。 */
  readNginxConfText: () => string;
  /** Forwarder /__forwarder/healthz 探测。失败时 throw 或返 healthy=false。 */
  probeForwarder: () => Promise<AggregatorForwarderProbe>;
  /** 探测 master daemon /healthz?probe=routes;失败 throw 或返 alive=false。 */
  probeAdminDaemon: (port: number) => Promise<AggregatorAdminProbe>;
  /** discover app + infra containers。 */
  discoverAppContainers: () => Promise<Map<string, AggregatorAppContainerInfo>>;
  discoverInfraContainers: () => Promise<
    Map<string, AggregatorInfraContainerInfo>
  >;
  /** 可选:forwarder 当前路由表(直接调内存表),用于 edges 推导。 */
  readForwarderRoutes?: () => AggregatorRouteRecord[];
  /** master daemon 监听端口,通常 9900。 */
  masterPort: number;
}

export interface TopologyAggregator {
  build(): Promise<TopologyPayload>;
}

/** 节点稳定 id 拼接(host+port 形式或纯 string 标签)。 */
function makeId(...parts: Array<string | number | undefined>): string {
  return parts.filter(p => p !== undefined && p !== '').join(':');
}

function isWildcardHost(host: string): boolean {
  return host.startsWith('*.') || host.includes('{{');
}

/**
 * 从 nginx active-upstream.conf 文本里解析所有 `upstream <name> { server <target>; ... }` 块。
 * 容错:多行 / 多余空格 / 缺末尾分号都尽量解析。
 */
export function parseNginxUpstreams(text: string): TopologyUpstreamNode[] {
  const result: TopologyUpstreamNode[] = [];
  if (!text) return result;
  // 抓 upstream <name> { ... server <target> ; ... }
  const blockRe = /upstream\s+([A-Za-z0-9_\-]+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(text)) !== null) {
    const name = match[1];
    const body = match[2] || '';
    const serverRe = /server\s+([^\s;]+)/;
    const sm = serverRe.exec(body);
    if (!sm) continue;
    result.push({
      id: makeId('upstream', name),
      name,
      target: sm[1],
      dataSource: 'nginx-conf',
    });
  }
  return result;
}

/** 从 target "127.0.0.1:9900" 解析端口,失败返 NaN。 */
function targetPort(target: string): number {
  const idx = target.lastIndexOf(':');
  if (idx < 0) return NaN;
  return Number(target.slice(idx + 1));
}

export function createTopologyAggregator(
  deps: TopologyAggregatorDeps,
): TopologyAggregator {
  return {
    async build(): Promise<TopologyPayload> {
      const inconsistencies: TopologyInconsistency[] = [];

      // ── 1. domains ────────────────────────────────────────────
      const rootDomains = (deps.readDomainsConfig() || []).filter(
        s => typeof s === 'string' && s.length > 0,
      );
      const projects = deps.readProjects() || [];
      const domains: TopologyDomainNode[] = [];
      const seenHost = new Set<string>();

      for (const root of rootDomains) {
        // 通配根:一律按 *.<root> 暴露,加 hasTls=true(CDS 默认 LE)
        const host = `*.${root}`;
        if (!seenHost.has(host)) {
          seenHost.add(host);
          domains.push({
            id: makeId('domain', host),
            host,
            isWildcard: true,
            hasTls: true,
            dataSource: 'config',
          });
        }
        // 同时暴露根域名本身(admin 入口)
        if (!seenHost.has(root)) {
          seenHost.add(root);
          domains.push({
            id: makeId('domain', root),
            host: root,
            isWildcard: false,
            hasTls: true,
            dataSource: 'config',
          });
        }
      }
      // routingRules: type='domain' 的 match 视为额外的精确域名
      for (const proj of projects) {
        for (const rule of proj.routingRules || []) {
          if (!rule.enabled) continue;
          if (rule.type !== 'domain') continue;
          const match = (rule.match || '').trim();
          if (!match) continue;
          if (seenHost.has(match)) continue;
          seenHost.add(match);
          domains.push({
            id: makeId('domain', match),
            host: match,
            isWildcard: isWildcardHost(match),
            hasTls: true,
            dataSource: 'mongo',
          });
        }
      }

      // ── 2. nginx upstreams ───────────────────────────────────
      const upstreams = parseNginxUpstreams(deps.readNginxConfText() || '');

      // ── 3. forwarder probe ───────────────────────────────────
      let forwarderProbe: AggregatorForwarderProbe;
      try {
        forwarderProbe = await deps.probeForwarder();
      } catch (err) {
        forwarderProbe = {
          healthy: false,
          port: 9090,
          routesCount: 0,
          routesHealthState: 'unknown',
        };
        // 不算不一致,只是探测失败 — healthy=false 已反映
        void err;
      }
      const forwarder: TopologyForwarderNode = {
        id: 'forwarder',
        port: forwarderProbe.port,
        healthy: forwarderProbe.healthy,
        routesCount: forwarderProbe.routesCount,
        routesHealthState: forwarderProbe.routesHealthState,
        dataSource: forwarderProbe.healthy ? 'http-probe' : 'process-self',
      };

      // ── 4. master daemon ─────────────────────────────────────
      let masterProbe: AggregatorAdminProbe;
      try {
        masterProbe = await deps.probeAdminDaemon(deps.masterPort);
      } catch {
        masterProbe = { alive: false, buildSha: null, uptime: null };
      }
      const master: TopologyMasterDaemonNode = {
        id: 'master',
        port: deps.masterPort,
        alive: masterProbe.alive,
        buildSha: masterProbe.buildSha,
        uptime: masterProbe.uptime,
        dataSource: masterProbe.alive ? 'http-probe' : 'file',
      };

      // ── 5. containers ────────────────────────────────────────
      const containers: TopologyContainerNode[] = [];
      let appContainersMap: Map<string, AggregatorAppContainerInfo>;
      try {
        appContainersMap = await deps.discoverAppContainers();
      } catch {
        appContainersMap = new Map();
      }
      for (const info of appContainersMap.values()) {
        containers.push({
          id: makeId('container', info.containerName),
          name: info.containerName,
          branchId: info.branchId,
          profileId: info.profileId,
          port: info.port,
          status: info.running ? 'running' : 'stopped',
          role: 'app',
          dataSource: 'docker',
        });
      }
      let infraContainersMap: Map<string, AggregatorInfraContainerInfo>;
      try {
        infraContainersMap = await deps.discoverInfraContainers();
      } catch {
        infraContainersMap = new Map();
      }
      for (const info of infraContainersMap.values()) {
        containers.push({
          id: makeId('container', info.containerName),
          name: info.containerName,
          status: info.running ? 'running' : 'stopped',
          role: 'infra',
          dataSource: 'docker',
        });
      }

      // ── 6. edges ─────────────────────────────────────────────
      const edges: TopologyEdge[] = [];
      // nginx → forwarder (永远存在)
      edges.push({
        id: 'edge:nginx->forwarder',
        from: 'nginx',
        to: forwarder.id,
        label: '*.miduo.org',
        trafficWeight: 100,
        dataSource: 'nginx-conf',
      });
      // nginx → master(admin/控制面流量)
      if (master.alive) {
        edges.push({
          id: `edge:nginx->${master.id}`,
          from: 'nginx',
          to: master.id,
          label: 'cds.miduo.org',
          trafficWeight: 100,
          dataSource: 'nginx-conf',
        });
      }
      // forwarder → 各 app container (从路由表推导)
      const routes = deps.readForwarderRoutes ? deps.readForwarderRoutes() : [];
      const appContainersByBranch = new Map<string, AggregatorAppContainerInfo>();
      for (const info of appContainersMap.values()) {
        if (info.branchId) appContainersByBranch.set(info.branchId, info);
      }
      for (const route of routes) {
        const app =
          route.branchId !== undefined
            ? appContainersByBranch.get(route.branchId)
            : undefined;
        if (!app) continue;
        const containerNodeId = makeId('container', app.containerName);
        const label = `${route.host}${route.pathPrefix || ''}`;
        edges.push({
          id: `edge:forwarder->${app.containerName}:${route.host}${route.pathPrefix || ''}`,
          from: forwarder.id,
          to: containerNodeId,
          label,
          trafficWeight: route.weight ?? 100,
          dataSource: 'mongo',
        });
      }

      // ── 7. consistency checks ────────────────────────────────
      const runningAppContainers = containers.filter(
        c => c.role === 'app' && c.status === 'running',
      );
      // forwarder.routesCount vs running apps
      if (
        forwarder.healthy &&
        forwarder.routesCount !== runningAppContainers.length
      ) {
        inconsistencies.push({
          kind: 'forwarder-vs-docker',
          detail: `forwarder routesCount=${forwarder.routesCount} 与 running app containers=${runningAppContainers.length} 不等`,
        });
      }
      // mongo route count vs forwarder route count(若注入了 readForwarderRoutes)
      if (deps.readForwarderRoutes && forwarder.healthy) {
        if (routes.length !== forwarder.routesCount) {
          inconsistencies.push({
            kind: 'mongo-vs-forwarder',
            detail: `mongo 路由表=${routes.length} 与 forwarder 内存表=${forwarder.routesCount} 不等`,
          });
        }
      }
      // nginx upstream cds_master target 端口 vs master daemon port
      const cdsMaster = upstreams.find(u => u.name === 'cds_master');
      if (cdsMaster && master.alive) {
        const port = targetPort(cdsMaster.target);
        if (Number.isFinite(port) && port !== master.port) {
          inconsistencies.push({
            kind: 'nginx-vs-master',
            detail: `nginx upstream cds_master target 端口=${port},但 master daemon 端口=${master.port}`,
          });
        }
      }

      const healthy = inconsistencies.length === 0;

      return {
        healthy,
        inconsistencies,
        domains,
        nginxUpstreams: upstreams,
        forwarder,
        master,
        containers,
        edges,
      };
    },
  };
}
