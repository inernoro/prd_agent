/**
 * 服务调用关系图推导测试（复制集两页签定案 2026-07-24）。
 * 覆盖：env 主机名引用（最长 id 优先）、`${CDS_<INFRA>_PORT}` 模板、depends_on、
 * 分层（调用链自上而下）、环路兜底、安全边界（不泄漏 env 值）。
 */
import { describe, it, expect } from 'vitest';
import { buildServiceGraph, extractHostTokens, matchHostToId, infraPortVar } from '../../src/services/service-graph.js';
import type { BuildProfile, InfraService } from '../../src/types.js';

function profile(id: string, extra: Partial<BuildProfile> = {}): BuildProfile {
  return {
    id,
    projectId: 'p1',
    name: id,
    dockerImage: 'node:20',
    workDir: '.',
    containerPort: 3000,
    ...extra,
  } as BuildProfile;
}

function infra(id: string, dockerImage = 'mongo:7.0'): InfraService {
  return { id, projectId: 'p1', dockerImage } as unknown as InfraService;
}

describe('extractHostTokens', () => {
  it('识别 ://host、@host、host:port 三种上下文', () => {
    expect(extractHostTokens('http://llmgw-prd-agent:8090')).toContain('llmgw-prd-agent');
    expect(extractHostTokens('mongodb://user:pw@mongodb:27017/db')).toContain('mongodb');
    expect(extractHostTokens('redis:6379')).toContain('redis');
  });
  it('普通文案不误报', () => {
    expect(extractHostTokens('Production')).toEqual([]);
    expect(extractHostTokens('true')).toEqual([]);
  });
});

describe('matchHostToId 最长 id 优先', () => {
  const ids = ['llmgw-serve', 'llmgw', 'api'].sort((a, b) => b.length - a.length);
  it('llmgw-serve-prd-agent 归 llmgw-serve，不被 llmgw 抢走', () => {
    expect(matchHostToId('llmgw-serve-prd-agent', ids)).toBe('llmgw-serve');
  });
  it('llmgw-prd-agent 归 llmgw', () => {
    expect(matchHostToId('llmgw-prd-agent', ids)).toBe('llmgw');
  });
  it('不相关主机返回 null', () => {
    expect(matchHostToId('example.com', ids)).toBeNull();
  });
});

describe('buildServiceGraph', () => {
  it('env 主机名引用产生服务间调用边（含 env 键名证据）', () => {
    const profiles = [
      profile('llmgw-web', { env: { LLMGW_PROXY_TARGET: 'http://llmgw-prd-agent:8090', LLMGW_SERVING_PROXY_TARGET: 'http://llmgw-serve-prd-agent:8091' } }),
      profile('llmgw'),
      profile('llmgw-serve'),
    ];
    const g = buildServiceGraph(profiles, []);
    const edges = g.edges.map((e) => `${e.from}->${e.to}`).sort();
    expect(edges).toEqual(['service:llmgw-web->service:llmgw', 'service:llmgw-web->service:llmgw-serve']);
    const toServe = g.edges.find((e) => e.to === 'service:llmgw-serve')!;
    expect(toServe.envKeys).toEqual(['LLMGW_SERVING_PROXY_TARGET']);
  });

  it('`${CDS_<INFRA>_PORT}` 模板产生服务到基础设施的边', () => {
    expect(infraPortVar('mongodb')).toBe('CDS_MONGODB_PORT');
    const profiles = [profile('api', { env: { MongoDB__ConnectionString: 'mongodb://${CDS_HOST}:${CDS_MONGODB_PORT}' } })];
    const g = buildServiceGraph(profiles, [infra('mongodb')]);
    const e = g.edges.find((x) => x.from === 'service:api' && x.to === 'infra:mongodb');
    expect(e).toBeDefined();
    expect(e!.envKeys).toContain('MongoDB__ConnectionString');
  });

  it('depends_on 声明产生边（服务与基础设施都认）', () => {
    const profiles = [profile('web', { dependsOn: ['api', 'redis'] }), profile('api')];
    const g = buildServiceGraph(profiles, [infra('redis', 'redis:7')]);
    expect(g.edges.find((e) => e.from === 'service:web' && e.to === 'service:api')?.dependsOn).toBe(true);
    expect(g.edges.find((e) => e.from === 'service:web' && e.to === 'infra:redis')?.dependsOn).toBe(true);
  });

  it('分层：调用方在上、被调方下沉；infra 不进分层', () => {
    const profiles = [
      profile('web', { env: { API_BASE: 'http://api-prd:5000' } }),
      profile('api', { env: { GW: 'http://llmgw-x:8090' } }),
      profile('llmgw'),
    ];
    const g = buildServiceGraph(profiles, [infra('mongodb')]);
    expect(g.layers).toEqual([['web'], ['api'], ['llmgw']]);
  });

  it('环路不死循环，全部服务仍在分层里', () => {
    const profiles = [
      profile('a', { env: { X: 'http://b-slug:1' } }),
      profile('b', { env: { Y: 'http://a-slug:2' } }),
    ];
    const g = buildServiceGraph(profiles, []);
    expect(g.layers.flat().sort()).toEqual(['a', 'b']);
  });

  it('安全边界：输出任何位置都不包含 env 值', () => {
    const secret = 'mongodb://root:SUPER_SECRET_PW@mongodb:27017';
    const profiles = [profile('api', { env: { CONN: secret } })];
    const g = buildServiceGraph(profiles, [infra('mongodb')]);
    expect(JSON.stringify(g)).not.toContain('SUPER_SECRET_PW');
  });

  it('不产生自引用边', () => {
    const profiles = [profile('api', { env: { SELF: 'http://api-slug:5000' }, dependsOn: ['api'] })];
    const g = buildServiceGraph(profiles, []);
    expect(g.edges).toEqual([]);
  });

  it('服务与基础设施同名时不再互相吞掉（Codex 第二十七轮 P2）', () => {
    // 项目里自管一个叫 mongodb 的服务 + 一个 mongodb 基础设施：此前两者 id 撞平面，
    // 真实的服务→基础设施依赖被当成自环丢弃，节点 id 还重复导致前端 Map 后写覆盖先写。
    const profiles = [profile('mongodb', { env: { CONN: 'mongodb://mongodb-slug:27017' } })];
    const g = buildServiceGraph(profiles, [infra('mongodb')]);
    const ids = g.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['infra:mongodb', 'service:mongodb']);
    expect(g.nodes.find((n) => n.kind === 'service')!.rawId).toBe('mongodb');
    expect(g.nodes.find((n) => n.kind === 'infra')!.rawId).toBe('mongodb');
  });

  it('同名场景下 depends_on 指向基础设施仍成边（不被自环规则误杀）', () => {
    const profiles = [profile('redis', { dependsOn: ['redis'] })];
    const g = buildServiceGraph(profiles, [infra('redis', 'redis:7')]);
    expect(g.edges).toEqual([
      expect.objectContaining({ from: 'service:redis', to: 'infra:redis', dependsOn: true }),
    ]);
  });
});

/* ── 角色推断 + 站点分组（2026-09-02 运行画布「入口 → 站点 → 壳 → 前缀成员」）── */
import { buildServiceSites, inferServiceRole } from '../../src/services/service-graph.js';

/** mdimp main 分支的真实声明（cdscli project show 抽出的 cds.* 标签），名字推导在这里会栽三次。 */
function mdimpProfiles(): BuildProfile[] {
  return [
    profile('imp-database-bootstrap', { readinessProbe: { path: '/health' } }),
    profile('imp-api', { pathPrefixes: ['/api/', '/open/', '/partner/', '/ops/', '/health', '/actuator/', '/health-api/'], readinessProbe: { path: '/health' } }),
    profile('cloudbridge-api', { readinessProbe: { path: '/api/webhook/event/list?pageSize=1' } }),
    profile('cloudbridge-web', { subdomain: 'cloudbridge', webEntry: { name: '云桥运维控制台', path: '/' }, readinessProbe: { path: '/' }, env: { API_BASE: 'http://cloudbridge-api-mdimp:8080' } }),
    profile('imp-admin', { pathPrefixes: ['/'], readinessProbe: { path: '/' } }),
    profile('imp-vendor-api', { pathPrefixes: ['/api/portal/', '/vendor-health-api/'], readinessProbe: { path: '/health' } }),
    profile('imp-vendor', { pathPrefixes: ['/vendor/'], readinessProbe: { path: '/vendor/' } }),
    profile('imp-open-platform-api', { subdomain: 'open-platform-api', pathPrefixes: ['/api/open-platform/', '/open/', '/health'], readinessProbe: { path: '/health' } }),
    profile('imp-open-platform', { subdomain: 'open-platform', readinessProbe: { path: '/' } }),
    profile('imp-scan-runtime-api', { subdomain: 'scan-runtime', pathPrefixes: ['/'], readinessProbe: { path: '/health' } }),
  ];
}

describe('inferServiceRole 角色判定优先级', () => {
  it('显式 cds.role 覆盖一切推断', () => {
    const v = inferServiceRole(profile('cloudbridge-web', { role: 'worker', webEntry: { name: 'x', path: '/' } }));
    expect(v).toEqual({ role: 'worker', source: 'declared', reason: '配置声明 cds.role: worker' });
  });
  it('声明了用户入口就是 web，与名字无关', () => {
    const v = inferServiceRole(profile('thing-api', { webEntry: { name: '控制台', path: '/' } }));
    expect(v.role).toBe('web');
    expect(v.source).toBe('route');
  });
  it('不监听 HTTP 的就是 worker', () => {
    expect(inferServiceRole(profile('foo', { readinessProbe: { noHttp: true } })).role).toBe('worker');
  });
  it('承载根路径且探活是页面 → web；承载根路径但探活是健康检查 → 交给名字', () => {
    expect(inferServiceRole(profile('zzz', { pathPrefixes: ['/'], readinessProbe: { path: '/' } })))
      .toMatchObject({ role: 'web', source: 'route' });
    expect(inferServiceRole(profile('imp-scan-runtime-api', { subdomain: 'scan-runtime', pathPrefixes: ['/'], readinessProbe: { path: '/health' } })))
      .toMatchObject({ role: 'api', source: 'name' });
  });
  it('名字两种词根都命中时取靠后的名词本体', () => {
    expect(inferServiceRole(profile('admin-api')).role).toBe('api');
    expect(inferServiceRole(profile('api-admin')).role).toBe('web');
  });
  it('名字判不出时看弱路由特征：接口样式前缀 / 健康检查探活 / 页面探活 / 独占子域', () => {
    expect(inferServiceRole(profile('alpha', { pathPrefixes: ['/graphql', '/v2/'] }))).toMatchObject({ role: 'api', source: 'route' });
    expect(inferServiceRole(profile('beta', { readinessProbe: { path: '/healthz' } }))).toMatchObject({ role: 'api', source: 'route' });
    expect(inferServiceRole(profile('imp-vendor', { pathPrefixes: ['/vendor/'], readinessProbe: { path: '/vendor/' } }))).toMatchObject({ role: 'web', source: 'route' });
    expect(inferServiceRole(profile('imp-open-platform', { subdomain: 'open-platform', readinessProbe: { path: '/' } }))).toMatchObject({ role: 'web', source: 'route' });
  });
  it('什么都判不出 → 默认 api 并如实标 default', () => {
    expect(inferServiceRole(profile('zeta'))).toEqual({ role: 'api', source: 'default', reason: '无声明、无路由特征、名字无法判断，默认按接口显示' });
  });
  it('mdimp 十个服务全部判对，且每个都带来源与理由', () => {
    const g = buildServiceGraph(mdimpProfiles(), []);
    const roleOf = (id: string) => g.nodes.find((n) => n.rawId === id)!;
    const expected: Record<string, string> = {
      'imp-database-bootstrap': 'worker', 'imp-api': 'api', 'cloudbridge-api': 'api', 'cloudbridge-web': 'web',
      'imp-admin': 'web', 'imp-vendor-api': 'api', 'imp-vendor': 'web', 'imp-open-platform-api': 'api',
      'imp-open-platform': 'web', 'imp-scan-runtime-api': 'api',
    };
    for (const [id, role] of Object.entries(expected)) {
      expect(roleOf(id).role, id).toBe(role);
      expect(roleOf(id).roleSource, id).toBeDefined();
      expect(roleOf(id).roleReason, id).toBeTruthy();
    }
    expect(roleOf('imp-admin').roleSource).toBe('route');
    expect(roleOf('imp-database-bootstrap').roleSource).toBe('name');
  });
});

describe('buildServiceSites 站点分组与 forwarder 同源', () => {
  it('mdimp：主域名壳是 imp-admin，前缀成员挂在它下面；每个子域各一站；无路由的进 internal', () => {
    const g = buildServiceGraph(mdimpProfiles(), []);
    const main = g.sites.find((s) => s.kind === 'main')!;
    expect(main.shellId).toBe('imp-admin');
    expect(main.shellSource).toBe('declared');
    expect(main.members.map((m) => m.id).sort()).toEqual(['imp-api', 'imp-open-platform-api', 'imp-vendor', 'imp-vendor-api']);
    expect(main.members.find((m) => m.id === 'imp-api')!.prefixes).toContain('/api/');
    expect(main.members.every((m) => !m.viaConvention)).toBe(true);
    // 同一前缀被多个服务声明：forwarder 只能按 id 二选一，必须报成冲突而不是静默。
    // mdimp 真实配置里有三处（`/` 两个壳抢；`/health` `/open/` 两个 api 抢），名字推导永远发现不了
    expect(main.conflicts).toEqual([
      { prefix: '/', ids: ['imp-admin', 'imp-scan-runtime-api'] },
      { prefix: '/health', ids: ['imp-api', 'imp-open-platform-api'] },
      { prefix: '/open/', ids: ['imp-api', 'imp-open-platform-api'] },
    ]);
    expect(g.sites.filter((s) => s.kind === 'subdomain').map((s) => [s.subdomain, s.shellId])).toEqual([
      ['cloudbridge', 'cloudbridge-web'], ['open-platform-api', 'imp-open-platform-api'], ['open-platform', 'imp-open-platform'], ['scan-runtime', 'imp-scan-runtime-api'],
    ]);
    expect(g.internal.sort()).toEqual(['cloudbridge-api', 'imp-database-bootstrap']);
    // 无路由的 cloudbridge-api 通过环境变量引用边挂在 cloudbridge-web 下
    expect(g.edges.some((e) => e.from === 'service:cloudbridge-web' && e.to === 'service:cloudbridge-api')).toBe(true);
  });
  it('无人声明 `/` 时按名兜底选壳，无人声明 /api/ 时按名约定接管（与发布器同一份规则）', () => {
    const g = buildServiceGraph([profile('backend'), profile('frontend')], []);
    const main = g.sites[0];
    expect(main.shellId).toBe('frontend');
    expect(main.shellSource).toBe('convention');
    expect(main.members).toEqual([{ id: 'backend', prefixes: ['/api/'], viaConvention: true }]);
    expect(g.internal).toEqual([]);
  });
  it('多个服务声明 `/` 时壳按发布器的先到先得（id 字典序第一）选，并记入冲突；webEntry / 角色不改变归属', () => {
    const roles = new Map([
      ['a-api', inferServiceRole(profile('a-api', { pathPrefixes: ['/'] }))],
      ['b-web', inferServiceRole(profile('b-web', { pathPrefixes: ['/'] }))],
    ]);
    // 发布器 routableServices 按 id 排、writtenPrefixes 先到先得：`/` 实际归 a-api，图必须说同一句话
    const r = buildServiceSites([profile('b-web', { pathPrefixes: ['/'] }), profile('a-api', { pathPrefixes: ['/'] })], roles);
    expect(r.sites[0].shellId).toBe('a-api');
    expect(r.sites[0].conflicts).toEqual([{ prefix: '/', ids: ['a-api', 'b-web'] }]);
    const r2 = buildServiceSites([profile('a-api', { pathPrefixes: ['/'] }), profile('b-web', { pathPrefixes: ['/'], webEntry: { name: 'x', path: '/', primary: true } })], roles);
    expect(r2.sites[0].shellId).toBe('a-api');
  });
  it('多个服务同时命中按名约定时按 id 字典序取胜者，与发布器排序一致，不随存储顺序漂移', () => {
    const g = buildServiceGraph([profile('web-b'), profile('web-a'), profile('api-z'), profile('api-y')], []);
    expect(g.sites[0].shellId).toBe('web-a');
    expect(g.sites[0].members).toEqual([{ id: 'api-y', prefixes: ['/api/'], viaConvention: true }]);
  });
  it('没有服务时没有站点', () => {
    expect(buildServiceGraph([], []).sites).toEqual([]);
  });
});

describe('cds.calls 显式声明的调用边', () => {
  it('指向不存在服务的声明不画边但保留在 unresolvedCalls，供体检报 unknown-callee', () => {
    const g = buildServiceGraph([profile('web', { calls: ['api', 'mongodb', 'ghost'] }), profile('api')], [{ id: 'mongodb', projectId: 'p', name: 'm', dockerImage: 'mongo', containerPort: 27017, hostPort: 1, containerName: 'c', status: 'running', volumes: [], env: {} } as never]);
    expect(g.unresolvedCalls).toEqual([{ from: 'web', callee: 'ghost' }]);
    expect(g.edges.some((e) => e.to === 'service:api' && e.declared)).toBe(true);
  });
  it('角色推断用的默认站与站点壳同源：无根路径声明、名字判不出时都取 id 字典序第一', () => {
    const g = buildServiceGraph([profile('zeta'), profile('alpha')], []);
    expect(g.sites[0].shellId).toBe('alpha');
    expect(g.nodes.find((n) => n.rawId === 'alpha')?.role).toBe('web');
    expect(g.nodes.find((n) => n.rawId === 'zeta')?.role).not.toBe('web');
  });
  it('声明的被调方存在时画边并标 declared；写错的 id 静默忽略', () => {
    const g = buildServiceGraph([profile('web', { calls: ['api', 'ghost'] }), profile('api')], []);
    const e = g.edges.find((x) => x.from === 'service:web' && x.to === 'service:api');
    expect(e).toMatchObject({ declared: true, dependsOn: false, envKeys: [] });
    expect(g.edges.some((x) => x.to.endsWith('ghost'))).toBe(false);
    expect(g.layers).toEqual([['web'], ['api']]);
  });
});
