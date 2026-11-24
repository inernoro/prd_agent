/**
 * 主域名路径判定的唯一函数（plan.cds.service-relations 第二批）：
 * master 兜底与转发器对已发布路由的解析必须逐字一致，这里用同一批 URL 对两边做一致性断言。
 */
import { describe, it, expect } from 'vitest';
import { isOperationalProbePrefix, pickApiConventionProfile, pickDefaultProfile, resolveProfileForPath } from '../../src/services/route-conventions.js';
import { resolveRoute } from '../../src/forwarder/route-resolver.js';
import type { RouteRecord } from '../../src/forwarder/types.js';

const mdimp = [
  { id: 'imp-admin', pathPrefixes: ['/'] },
  { id: 'imp-api', pathPrefixes: ['/api/', '/open/', '/partner/', '/ops/', '/health', '/actuator/', '/health-api/'] },
  { id: 'imp-vendor-api', pathPrefixes: ['/api/portal/', '/vendor-health-api/'] },
  { id: 'imp-vendor', pathPrefixes: ['/vendor/'] },
  { id: 'imp-open-platform-api', pathPrefixes: ['/api/open-platform/', '/open/', '/health'] },
  { id: 'imp-scan-runtime-api', pathPrefixes: ['/'] },
  { id: 'imp-database-bootstrap' },
];

describe('resolveProfileForPath', () => {
  it('最长声明前缀胜；同前缀按 id 排序取第一个；探活前缀不参与', () => {
    expect(resolveProfileForPath(mdimp, '/api/portal/list')).toBe('imp-vendor-api');
    expect(resolveProfileForPath(mdimp, '/api/open-platform/x')).toBe('imp-open-platform-api');
    expect(resolveProfileForPath(mdimp, '/api/users')).toBe('imp-api');
    expect(resolveProfileForPath(mdimp, '/open/x')).toBe('imp-api');
    expect(resolveProfileForPath(mdimp, '/')).toBe('imp-admin');
    expect(resolveProfileForPath(mdimp, '/vendor/')).toBe('imp-vendor');
    // /health 是探活前缀，不给任何 API；落回根路径的壳
    expect(resolveProfileForPath(mdimp, '/health')).toBe('imp-admin');
  });
  it('无人声明 /api/ 时按名约定接管；都没有时默认站', () => {
    expect(resolveProfileForPath([{ id: 'frontend' }, { id: 'backend' }], '/api/x')).toBe('backend');
    expect(resolveProfileForPath([{ id: 'frontend' }, { id: 'backend' }], '/about')).toBe('frontend');
    expect(resolveProfileForPath([{ id: 'zeta' }, { id: 'alpha' }], '/')).toBe('alpha');
    expect(resolveProfileForPath([], '/')).toBeUndefined();
  });
  it('探活判定与按名约定辅助函数', () => {
    expect(isOperationalProbePrefix('/health')).toBe(true);
    expect(isOperationalProbePrefix('/')).toBe(false);
    expect(isOperationalProbePrefix('/vendor-health-api/')).toBe(false);
    expect(pickApiConventionProfile(['web', 'backend'])).toBe('backend');
    expect(pickDefaultProfile(['api', 'zzz'])).toBe('api');
  });
});

describe('master 兜底与转发器判定一致', () => {
  // 按发布器规则手工发布 mdimp 的路由：id 排序去重、探活不发、默认站兜底
  const host = 'main-mdimp.miduo.org';
  const routes: RouteRecord[] = [];
  const written = new Set<string>();
  const port: Record<string, number> = {};
  for (const [i, p] of [...mdimp].sort((a, b) => a.id.localeCompare(b.id)).entries()) {
    port[p.id] = 10000 + i;
    for (const prefix of p.pathPrefixes ?? []) {
      if (isOperationalProbePrefix(prefix) || written.has(prefix)) continue;
      written.add(prefix);
      routes.push({ _id: `b:${p.id}:bp:${routes.length}`, host, pathPrefix: prefix, upstreamPort: port[p.id], weight: 100, profileId: p.id });
    }
  }
  const def = pickDefaultProfile(mdimp.map((p) => p.id).sort());
  routes.push({ _id: `b:${def}:default:x`, host, upstreamPort: port[def], weight: 100, profileId: def });

  it('同一批 URL 两边给同一个服务', () => {
    const urls = ['/', '/index.html', '/api/users', '/api/portal/x', '/api/open-platform/y', '/open/z', '/partner/', '/vendor/', '/vendor-health-api/x', '/health', '/actuator/info', '/ops/q', '/unknown/path'];
    for (const url of urls) {
      const fwd = resolveRoute(routes, host, url)?.profileId;
      const master = resolveProfileForPath(mdimp, url);
      expect(fwd, url).toBe(master);
    }
  });
});
