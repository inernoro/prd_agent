/**
 * 拓扑体检（plan.cds.service-relations 第一批）。夹具是 mdimp main 的真实声明：
 * 三处前缀冲突、两个服务把 /health 写进前缀、一个子域服务又抢主域名根路径、
 * 一个服务两个公网面、一个游离的初始化作业。名字推导永远发现不了这些。
 */
import { describe, it, expect } from 'vitest';
import { buildServiceGraph } from '../../src/services/service-graph.js';
import { isProbePrefix, lintComposeYaml, lintTopology } from '../../src/services/topology-lint.js';
import type { BuildProfile } from '../../src/types.js';

function profile(id: string, extra: Partial<BuildProfile> = {}): BuildProfile {
  return { id, projectId: 'p1', name: id, dockerImage: 'node:20', workDir: '.', containerPort: 3000, ...extra } as BuildProfile;
}

function mdimp(): BuildProfile[] {
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

describe('isProbePrefix', () => {
  it('健康 / 就绪 / 存活 / actuator / metrics 都算探活；业务前缀不算', () => {
    for (const p of ['/health', '/healthz', '/api/health', '/actuator/', '/metrics', '/readyz', '/live/']) expect(isProbePrefix(p), p).toBe(true);
    for (const p of ['/api/', '/open/', '/vendor-health-api/', '/healthcheck-ui/']) expect(isProbePrefix(p), p).toBe(false);
  });
});

describe('lintTopology 对 mdimp 的发现', () => {
  const report = lintTopology(buildServiceGraph(mdimp(), []));
  const rule = (r: string) => report.findings.filter((f) => f.rule === r);

  it('三处前缀冲突全部按 error 报出，并点名双方', () => {
    const conflicts = rule('prefix-conflict');
    expect(conflicts.map((f) => f.message.match(/路由前缀 (\S+) /)?.[1]).sort()).toEqual(['/', '/health', '/open/']);
    expect(conflicts.every((f) => f.severity === 'error')).toBe(true);
    expect(conflicts.find((f) => f.message.includes('/open/'))!.services).toEqual(['imp-api', 'imp-open-platform-api']);
  });
  it('探活路径进前缀按 error 报出，两个服务各一条', () => {
    const probes = rule('probe-in-prefix');
    expect(probes.map((f) => f.services[0]).sort()).toEqual(['imp-api', 'imp-open-platform-api']);
    expect(probes.find((f) => f.services[0] === 'imp-api')!.message).toContain('/actuator/');
    expect(probes.every((f) => f.severity === 'error')).toBe(true);
  });
  it('有子域又抢主域名根路径 → warn，壳是 imp-admin', () => {
    expect(rule('subdomain-root-claim')).toMatchObject([{ severity: 'warn', services: ['imp-scan-runtime-api'] }]);
    expect(rule('subdomain-root-claim')[0].message).toContain('imp-admin');
  });
  it('一个服务两个公网面 → warn', () => {
    expect(rule('double-public-surface').map((f) => f.services[0])).toEqual(['imp-open-platform-api']);
  });
  it('游离服务只报没人调用也不调用别人的那个；被 cloudbridge-web 引用的 cloudbridge-api 不算', () => {
    expect(rule('orphan-service').map((f) => f.services[0])).toEqual(['imp-database-bootstrap']);
  });
  it('角色靠名字推断合并成一条 info', () => {
    const info = rule('role-by-name');
    expect(info).toHaveLength(1);
    expect(info[0].severity).toBe('info');
    expect(info[0].services).toContain('imp-database-bootstrap');
    expect(info[0].services).not.toContain('imp-admin');
  });
  it('汇总数与排序：error 在前，其后 warn，最后 info', () => {
    expect(report.summary).toEqual({ errors: 5, warnings: 3, infos: 1 });
    const sev = report.findings.map((f) => f.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ({ error: 0, warn: 1, info: 2 })[a] - ({ error: 0, warn: 1, info: 2 })[b]));
  });
});

describe('lintTopology 边界', () => {
  it('干净的前后端分离项目零发现（admin 承载 /，api 挂 /api/，声明了角色）', () => {
    const g = buildServiceGraph([
      profile('admin', { pathPrefixes: ['/'], readinessProbe: { path: '/' }, role: 'web' }),
      profile('api', { pathPrefixes: ['/api/'], readinessProbe: { path: '/health' }, role: 'api' }),
    ], []);
    expect(lintTopology(g).findings).toEqual([]);
  });
  it('声明了 cds.role 的无路由服务不算游离；声明了 cds.calls 的也不算', () => {
    const g = buildServiceGraph([
      profile('web', { pathPrefixes: ['/'], readinessProbe: { path: '/' } }),
      profile('seed', { role: 'worker' }),
      profile('sync', { calls: ['web'] }),
    ], []);
    expect(lintTopology(g).findings.filter((f) => f.rule === 'orphan-service')).toEqual([]);
  });
  it('没有服务时没有发现', () => {
    expect(lintTopology(buildServiceGraph([], [])).findings).toEqual([]);
  });
});

describe('lintComposeYaml', () => {
  it('从 compose 文本直接体检，能报出前缀冲突与探活前缀', () => {
    const report = lintComposeYaml(`
services:
  admin:
    build: ./admin
    ports: ["3000"]
    labels:
      cds.path-prefix: "/"
      cds.readiness-path: "/"
  api-a:
    build: ./a
    ports: ["8080"]
    labels:
      cds.path-prefix: "/api/,/open/,/health"
  api-b:
    build: ./b
    ports: ["8081"]
    labels:
      cds.path-prefix: "/open/"
`);
    expect(report).not.toBeNull();
    expect(report!.summary.errors).toBe(2);
    expect(report!.findings.map((f) => f.rule).sort()).toEqual(['prefix-conflict', 'probe-in-prefix', 'role-by-name']);
  });
  it('不是 CDS compose 时返回 null', () => {
    expect(lintComposeYaml('hello: world')).toBeNull();
  });
});

describe('unknown-callee', () => {
  it('cds.calls 指向不存在的服务时按 warn 报出，并点名调用方与写错的名字', () => {
    const graph = buildServiceGraph([
      { id: 'web', projectId: 'p', name: 'web', dockerImage: 'x', workDir: '.', containerPort: 3000, pathPrefixes: ['/'], calls: ['apii'] } as never,
      { id: 'api', projectId: 'p', name: 'api', dockerImage: 'x', workDir: '.', containerPort: 8080, pathPrefixes: ['/api/'] } as never,
    ], []);
    const report = lintTopology(graph);
    const f = report.findings.find((x) => x.rule === 'unknown-callee');
    expect(f?.severity).toBe('warn');
    expect(f?.services).toEqual(['web']);
    expect(f?.message).toContain('apii');
  });
});
