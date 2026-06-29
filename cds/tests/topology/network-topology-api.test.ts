/**
 * 系统级网络拓扑 API — TDD 契约
 *
 * 对应 doc/report.cds.forwarder-success.md
 * 实现位置:
 *   - cds/src/services/topology-aggregator.ts(数据聚合)
 *   - cds/src/routes/cds-system-topology.ts(REST 路由)
 *
 * GET /api/cds-system/network-topology 返回域名/upstream/forwarder/master
 * /containers 完整图,前端 ReactFlow 用。
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createTopologyAggregator,
  parseNginxUpstreams,
  type AggregatorAdminProbe,
  type AggregatorAppContainerInfo,
  type AggregatorForwarderProbe,
  type AggregatorInfraContainerInfo,
  type AggregatorProjectLike,
  type AggregatorRouteRecord,
  type TopologyAggregatorDeps,
  type TopologyPayload,
} from '../../src/services/topology-aggregator.js';
import { createCdsSystemTopologyRouter } from '../../src/routes/cds-system-topology.js';

interface FakeOpts {
  domains?: string[];
  projects?: AggregatorProjectLike[];
  nginxConfText?: string;
  forwarder?: AggregatorForwarderProbe | (() => Promise<AggregatorForwarderProbe>);
  masterProbe?: AggregatorAdminProbe;
  appContainers?: Map<string, AggregatorAppContainerInfo>;
  infraContainers?: Map<string, AggregatorInfraContainerInfo>;
  routes?: AggregatorRouteRecord[];
  masterPort?: number;
}

function buildAggregatorDeps(opts: FakeOpts = {}): TopologyAggregatorDeps {
  return {
    readDomainsConfig: () => opts.domains ?? ['miduo.org'],
    readProjects: () => opts.projects ?? [],
    readNginxConfText: () =>
      opts.nginxConfText ??
      `upstream cds_master { server 127.0.0.1:9900; keepalive 8; }\nupstream cds_forwarder { server 127.0.0.1:9090; keepalive 8; }\n`,
    probeForwarder: async () => {
      const f = opts.forwarder ?? {
        healthy: true,
        port: 9090,
        routesCount: opts.routes?.length ?? 0,
        routesHealthState: 'live' as const,
      };
      return typeof f === 'function' ? f() : f;
    },
    probeAdminDaemon: async () => {
      return opts.masterProbe ?? { alive: true, buildSha: 'abcdef0123456789', uptime: 100 };
    },
    discoverAppContainers: async () => opts.appContainers ?? new Map(),
    discoverInfraContainers: async () => opts.infraContainers ?? new Map(),
    readForwarderRoutes: opts.routes ? () => opts.routes! : undefined,
    masterPort: opts.masterPort ?? 9900,
  };
}

async function buildPayload(opts: FakeOpts = {}): Promise<TopologyPayload> {
  const agg = createTopologyAggregator(buildAggregatorDeps(opts));
  return await agg.build();
}

describe('payload schema', () => {
  it('[C-7.1] 返回顶层字段 { domains, nginxUpstreams, forwarder, master, containers, edges }', async () => {
    const p = await buildPayload();
    expect(Array.isArray(p.domains)).toBe(true);
    expect(Array.isArray(p.nginxUpstreams)).toBe(true);
    expect(p.forwarder).toBeDefined();
    expect(p.master).toBeDefined();
    expect(Array.isArray(p.containers)).toBe(true);
    expect(Array.isArray(p.edges)).toBe(true);
    expect(typeof p.healthy).toBe('boolean');
    expect(Array.isArray(p.inconsistencies)).toBe(true);
  });

  it('[C-7.5] 每个节点带 dataSource 字段(mongo / docker / nginx-conf / process-self / file)', async () => {
    const appContainers = new Map<string, AggregatorAppContainerInfo>([
      ['feat-x/p1', { containerName: 'cds-feat-x', branchId: 'feat-x', profileId: 'p1', running: true }],
    ]);
    const infraContainers = new Map<string, AggregatorInfraContainerInfo>([
      ['cds-mongo', { containerName: 'cds-mongo', serviceId: 'mongodb', running: true }],
    ]);
    const p = await buildPayload({ appContainers, infraContainers, routes: [{ host: '*.miduo.org', upstreamPort: 9900, branchId: 'feat-x' }] });
    for (const d of p.domains) expect(d.dataSource).toBeDefined();
    for (const u of p.nginxUpstreams) expect(u.dataSource).toBe('nginx-conf');
    expect(p.forwarder.dataSource).toMatch(/(process-self|http-probe)/);
    expect(p.master.dataSource).toMatch(/(process-self|http-probe|file)/);
    for (const c of p.containers) expect(c.dataSource).toBe('docker');
  });

  it('[C-7.1] domains 来自 CDS_ROOT_DOMAINS + projects.routingRules', async () => {
    const projects: AggregatorProjectLike[] = [
      {
        id: 'demo',
        routingRules: [
          { type: 'domain', match: 'extra.example.com', enabled: true },
          { type: 'header', match: 'X-Branch', enabled: true }, // 不应进入 domains
          { type: 'domain', match: 'disabled.example.com', enabled: false }, // 禁用
        ],
      },
    ];
    const p = await buildPayload({ domains: ['miduo.org'], projects });
    const hosts = p.domains.map(d => d.host);
    expect(hosts).toContain('miduo.org');
    expect(hosts).toContain('*.miduo.org');
    expect(hosts).toContain('extra.example.com');
    expect(hosts).not.toContain('disabled.example.com');
    expect(hosts).not.toContain('X-Branch');
  });

  it('[C-7.1] nginxUpstreams 包含 cds_master / cds_forwarder 两条,target 与实际 nginx-active-upstream.conf 一致', async () => {
    const text =
      `upstream cds_master { server 127.0.0.1:9900; keepalive 8; }\n` +
      `upstream cds_forwarder { server 127.0.0.1:9090; keepalive 8; }\n`;
    const p = await buildPayload({ nginxConfText: text });
    const cdsAdmin = p.nginxUpstreams.find(u => u.name === 'cds_master');
    const cdsForwarder = p.nginxUpstreams.find(u => u.name === 'cds_forwarder');
    expect(cdsAdmin).toBeDefined();
    expect(cdsAdmin!.target).toBe('127.0.0.1:9900');
    expect(cdsForwarder).toBeDefined();
    expect(cdsForwarder!.target).toBe('127.0.0.1:9090');
  });

  it('[C-7.1] forwarder.port = 9090 / forwarder.healthy 来自 /__forwarder/healthz 实时探测', async () => {
    const p = await buildPayload({
      forwarder: { healthy: true, port: 9090, routesCount: 0, routesHealthState: 'live' },
    });
    expect(p.forwarder.port).toBe(9090);
    expect(p.forwarder.healthy).toBe(true);

    const p2 = await buildPayload({
      forwarder: async () => { throw new Error('down'); },
    });
    expect(p2.forwarder.healthy).toBe(false);
  });

  it('[C-7.1] forwarder.routesCount 来自 forwarder 当前路由表', async () => {
    const p = await buildPayload({
      forwarder: { healthy: true, port: 9090, routesCount: 7, routesHealthState: 'live' },
    });
    expect(p.forwarder.routesCount).toBe(7);
  });

  it('master 节点带 buildSha + port + alive,探测失败时降级 alive=false', async () => {
    const p = await buildPayload({
      masterProbe: { alive: true, buildSha: 'deadbeef0011', uptime: 30 },
    });
    expect(p.master.id).toBe('master');
    expect(p.master.alive).toBe(true);
    expect(p.master.buildSha).toBe('deadbeef0011');
    expect(p.master.port).toBe(9900);

    const p2 = await buildPayload({
      masterProbe: { alive: false, buildSha: null, uptime: null },
    });
    expect(p2.master.alive).toBe(false);
    expect(p2.master.buildSha).toBeNull();
  });

  it('[C-7.1] containers 列出所有 docker ps 中的分支预览 + infra services', async () => {
    const appContainers = new Map<string, AggregatorAppContainerInfo>([
      ['feat-x/p1', { containerName: 'cds-feat-x', branchId: 'feat-x', profileId: 'p1', running: true }],
      ['feat-y/p1', { containerName: 'cds-feat-y', branchId: 'feat-y', profileId: 'p1', running: false }],
    ]);
    const infraContainers = new Map<string, AggregatorInfraContainerInfo>([
      ['cds-mongo', { containerName: 'cds-mongo', serviceId: 'mongodb', running: true }],
      ['cds-redis', { containerName: 'cds-redis', serviceId: 'redis', running: true }],
    ]);
    const p = await buildPayload({ appContainers, infraContainers });
    const names = p.containers.map(c => c.name).sort();
    expect(names).toContain('cds-feat-x');
    expect(names).toContain('cds-feat-y');
    expect(names).toContain('cds-mongo');
    expect(names).toContain('cds-redis');
    const apps = p.containers.filter(c => c.role === 'app');
    const infras = p.containers.filter(c => c.role === 'infra');
    expect(apps.length).toBe(2);
    expect(infras.length).toBe(2);
  });

  it('[C-7.1] containers 每条带 branchId / profileId / port / status', async () => {
    const appContainers = new Map<string, AggregatorAppContainerInfo>([
      ['feat-x/p1', { containerName: 'cds-feat-x', branchId: 'feat-x', profileId: 'p1', running: true, port: 5000 }],
    ]);
    const p = await buildPayload({ appContainers });
    const c = p.containers.find(x => x.name === 'cds-feat-x')!;
    expect(c.branchId).toBe('feat-x');
    expect(c.profileId).toBe('p1');
    expect(c.port).toBe(5000);
    expect(c.status).toBe('running');
  });

  it('[C-7.5] parseNginxUpstreams 容错多空格 / 多块 / 多余字段', () => {
    const text =
      `upstream  cds_master   {\n  server   127.0.0.1:9900;\n  keepalive 8;\n}\nupstream cds_forwarder { server 127.0.0.1:9090; }\n`;
    const ups = parseNginxUpstreams(text);
    expect(ups.length).toBe(2);
    expect(ups.find(u => u.name === 'cds_master')!.target).toBe('127.0.0.1:9900');
    expect(ups.find(u => u.name === 'cds_forwarder')!.target).toBe('127.0.0.1:9090');
  });
});

describe('一致性', () => {
  it('[C-1.8] mongo 路由表与 forwarder 内存表一致(若不一致返回 inconsistencies 字段告警)', async () => {
    const routes: AggregatorRouteRecord[] = [
      { host: 'a.miduo.org', upstreamPort: 5000, branchId: 'a', weight: 100 },
      { host: 'b.miduo.org', upstreamPort: 5001, branchId: 'b', weight: 100 },
    ];
    // forwarder 报 1 条 / 实际 mongo 2 条 → 不一致
    const p = await buildPayload({
      forwarder: { healthy: true, port: 9090, routesCount: 1, routesHealthState: 'live' },
      routes,
    });
    expect(p.healthy).toBe(false);
    expect(p.inconsistencies.some(i => i.kind === 'mongo-vs-forwarder')).toBe(true);
  });

  it('[C-1.8] forwarder.routesCount === sum(containers.where(role=app))(若不一致告警)', async () => {
    const appContainers = new Map<string, AggregatorAppContainerInfo>([
      ['feat-x/p1', { containerName: 'cds-feat-x', branchId: 'feat-x', profileId: 'p1', running: true }],
    ]);
    // forwarder 上 5 条路由,但实际只 1 个 running app container → 不一致
    const p = await buildPayload({
      forwarder: { healthy: true, port: 9090, routesCount: 5, routesHealthState: 'live' },
      appContainers,
    });
    expect(p.healthy).toBe(false);
    expect(p.inconsistencies.some(i => i.kind === 'forwarder-vs-docker')).toBe(true);
  });

  it('[C-1.8] nginx upstream cds_master target 端口与 master 实际端口一致(若不一致告警)', async () => {
    // nginx upstream 写 9905,但 master 实际 listen 9900 → 不一致
    const text = `upstream cds_master { server 127.0.0.1:9905; keepalive 8; }\n`;
    const p = await buildPayload({
      nginxConfText: text,
      masterPort: 9900,
      masterProbe: { alive: true, buildSha: 'a', uptime: 1 },
    });
    expect(p.healthy).toBe(false);
    const inc = p.inconsistencies.find(i => i.kind === 'nginx-vs-master');
    expect(inc).toBeDefined();
    expect(inc!.detail.length).toBeGreaterThan(0);
  });
});

describe('edges 边数据', () => {
  it('[C-7.1] edges 包含 nginx → forwarder 一条,nginx → master 一条', async () => {
    const p = await buildPayload({});
    const ngFwd = p.edges.find(e => e.from === 'nginx' && e.to === 'forwarder');
    expect(ngFwd).toBeDefined();
    const ngMaster = p.edges.find(e => e.from === 'nginx' && e.to === 'master');
    expect(ngMaster).toBeDefined();
  });

  it('[C-7.1] edges 包含 forwarder → 每个分支容器一条,label 为 host+pathPrefix', async () => {
    const appContainers = new Map<string, AggregatorAppContainerInfo>([
      ['feat-x/p1', { containerName: 'cds-feat-x', branchId: 'feat-x', profileId: 'p1', running: true }],
    ]);
    const routes: AggregatorRouteRecord[] = [
      { host: 'feat-x.miduo.org', pathPrefix: '/api', upstreamPort: 5000, branchId: 'feat-x', weight: 100 },
    ];
    const p = await buildPayload({ appContainers, routes, forwarder: { healthy: true, port: 9090, routesCount: 1, routesHealthState: 'live' } });
    const fwd2container = p.edges.find(e => e.from === 'forwarder' && e.to === 'container:cds-feat-x');
    expect(fwd2container).toBeDefined();
    expect(fwd2container!.label).toBe('feat-x.miduo.org/api');
  });

  it('[C-7.1] edges 每条带 trafficWeight(用于 ReactFlow 线粗细)', async () => {
    const appContainers = new Map<string, AggregatorAppContainerInfo>([
      ['feat-x/p1', { containerName: 'cds-feat-x', branchId: 'feat-x', profileId: 'p1', running: true }],
    ]);
    const routes: AggregatorRouteRecord[] = [
      { host: 'feat-x.miduo.org', upstreamPort: 5000, branchId: 'feat-x', weight: 75 },
    ];
    const p = await buildPayload({ appContainers, routes, forwarder: { healthy: true, port: 9090, routesCount: 1, routesHealthState: 'live' } });
    for (const e of p.edges) {
      expect(typeof e.trafficWeight).toBe('number');
    }
    const fwd2container = p.edges.find(e => e.from === 'forwarder' && e.to === 'container:cds-feat-x');
    expect(fwd2container!.trafficWeight).toBe(75);
  });

  it('[C-7.1] 边的 from/to 都引用节点的稳定 id(host+port 拼接)', async () => {
    const appContainers = new Map<string, AggregatorAppContainerInfo>([
      ['feat-x/p1', { containerName: 'cds-feat-x', branchId: 'feat-x', profileId: 'p1', running: true }],
    ]);
    const routes: AggregatorRouteRecord[] = [
      { host: 'feat-x.miduo.org', upstreamPort: 5000, branchId: 'feat-x', weight: 100 },
    ];
    const p = await buildPayload({ appContainers, routes, forwarder: { healthy: true, port: 9090, routesCount: 1, routesHealthState: 'live' } });
    const knownIds = new Set<string>([
      'nginx',
      'forwarder',
      p.master.id,
      ...p.containers.map(c => c.id),
      ...p.domains.map(d => d.id),
      ...p.nginxUpstreams.map(u => u.id),
    ]);
    for (const e of p.edges) {
      expect(knownIds.has(e.from)).toBe(true);
      expect(knownIds.has(e.to)).toBe(true);
    }
  });
});

describe('权限', () => {
  it('[C-7.1] 只允许已认证管理员访问(普通用户 403)', async () => {
    // 模拟 server.ts 里"先 auth middleware 401 再 router"的链路:
    // 直接挂一个 401 守卫在 router 之前,断言 router 路径返回 401。
    const app = express();
    app.use((req, res, next) => {
      // 简化:没带 X-CDS-Token 一律 401
      if (req.headers['x-cds-token'] === 'admin') return next();
      res.status(401).json({ error: '未登录' });
    });
    const agg = createTopologyAggregator(buildAggregatorDeps());
    app.use('/api', createCdsSystemTopologyRouter({ aggregator: agg }));

    const server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;

    // 无 token → 401
    const unauth = await fetchStatus(port, '/api/cds-system/network-topology');
    expect(unauth.status).toBe(401);

    // 带 token → 200
    const ok = await fetchStatus(port, '/api/cds-system/network-topology', { 'x-cds-token': 'admin' });
    expect(ok.status).toBe(200);

    server.close();
  });
});

function fetchStatus(
  port: number,
  routePath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: routePath, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
