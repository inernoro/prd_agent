/**
 * 关系图布局（纯函数）：双公网面的服务两个站点都要画；颜色只许走主题 token。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { layoutRelations, type RelationPayload } from '../../web/src/components/branch/RelationGraph.js';

const SRC = path.resolve(__dirname, '../../web/src/components/branch/RelationGraph.tsx');

function payload(): RelationPayload {
  return {
    branchId: 'b', projectId: 'p', branch: 'main', status: 'running',
    graph: {
      nodes: [
        { id: 'service:gw', rawId: 'gw', name: 'gw', kind: 'service', pathPrefixes: ['/'], subdomain: 'gw', role: 'web' },
        { id: 'service:api', rawId: 'api', name: 'api', kind: 'service', pathPrefixes: ['/api/'], role: 'api' },
      ],
      edges: [], layers: [['gw', 'api']],
      sites: [
        { id: 'main', kind: 'main', shellId: 'gw', shellSource: 'declared', members: [{ id: 'api', prefixes: ['/api/'] }], conflicts: [] },
        { id: 'sub:gw', kind: 'subdomain', subdomain: 'gw', shellId: 'gw', shellSource: 'declared', members: [], conflicts: [] },
      ],
      internal: [],
    },
    lint: { findings: [], summary: { errors: 0, warnings: 0, infos: 0 } },
    references: [],
  };
}

describe('layoutRelations', () => {
  it('同一个服务既是主域名壳又是子域壳时，两个站点框都画出来，第二处用别名映射回真实节点', () => {
    const l = layoutRelations(payload());
    // 只有一个壳的子域收进「子域」网格框
    expect(l.frames.filter((f) => f.tone === 'site').map((f) => f.key)).toEqual(['main', 'subdomains']);
    expect(l.pos.has('gw')).toBe(true);
    expect(l.pos.has('gw@sub:gw')).toBe(true);
    expect(l.aliasOf.get('gw@sub:gw')).toBe('gw');
    // 子域网格里第二行写子域名，不写它在主域名下的前缀
    expect(l.subOf.get('gw@sub:gw')).toBe('子域 gw');
    // 前缀线仍从主域名壳出发到 api
    expect(l.edges.some((e) => e.kind === 'prefix' && e.label?.includes('/api/'))).toBe(true);
    // 两个入口线：每个站点一条；第二条沿左侧走线槽，不穿过主域名框
    const entries = l.edges.filter((e) => e.kind === 'entry');
    expect(entries).toHaveLength(2);
    expect(entries[1].route).toBe('side');
  });
});

/** 2026-09-30 截图同形：主域名壳 + 3 个前缀成员 + 8 个只有壳的子域，其中一个同时是主域名成员 */
function manySubs(): RelationPayload {
  const subs = ['open-platform', 'cloudbridge', 'open-platform-api', 'scan-runtime', 'worker-generation', 'worker-code-return', 'worker-product-batch', 'worker-common'];
  const shellOf = (s: string): string => (s === 'open-platform-api' ? 'imp-open-platform-api' : `svc-${s}`);
  const nodes: RelationPayload['graph']['nodes'] = [
    { id: 'service:imp-admin', rawId: 'imp-admin', name: 'imp-admin', kind: 'service', pathPrefixes: ['/'], role: 'web' },
    { id: 'service:imp-api', rawId: 'imp-api', name: 'imp-api', kind: 'service', pathPrefixes: ['/api/'], role: 'api' },
    { id: 'service:imp-vendor-api', rawId: 'imp-vendor-api', name: 'imp-vendor-api', kind: 'service', pathPrefixes: ['/api/portal/'], role: 'api' },
    ...subs.map((s) => ({ id: `service:${shellOf(s)}`, rawId: shellOf(s), name: shellOf(s), kind: 'service' as const, subdomain: s, pathPrefixes: s === 'open-platform-api' ? ['/api/open-platform/', '/open/'] : [], role: 'api' as const })),
  ];
  return {
    branchId: 'b', projectId: 'p', branch: 'claude/beautiful-edison-m5hjsh', status: 'running',
    graph: {
      nodes, edges: [], layers: [],
      sites: [
        { id: 'main', kind: 'main', shellId: 'imp-admin', shellSource: 'declared', members: [{ id: 'imp-api', prefixes: ['/api/'] }, { id: 'imp-open-platform-api', prefixes: ['/api/open-platform/', '/open/'] }, { id: 'imp-vendor-api', prefixes: ['/api/portal/'] }], conflicts: [] },
        ...subs.map((s) => ({ id: `sub:${s}`, kind: 'subdomain' as const, subdomain: s, shellId: shellOf(s), shellSource: 'declared', members: [], conflicts: [] })),
      ],
      internal: [],
    },
    lint: { findings: [{ rule: 'double-public-surface', severity: 'warn', services: ['imp-open-platform-api'], message: '一个服务两个公网入口', fix: '二选一' }], summary: { errors: 0, warnings: 1, infos: 0 } },
    references: [],
  };
}

describe('layoutRelations 按给定宽度排版（2026-09-30：8 个子域并排成一长条，半屏里缩到看不清还被裁掉）', () => {
  for (const width of [560, 720, 1200]) {
    it(`宽 ${width} 时整图不超宽，所有卡片都落在画布里`, () => {
      const l = layoutRelations(manySubs(), width);
      expect(l.width).toBe(width);
      for (const [id, p] of l.pos) {
        expect(p.x, id).toBeGreaterThanOrEqual(0);
        expect(p.x + p.w, id).toBeLessThanOrEqual(width);
        expect(p.y + p.h, id).toBeLessThanOrEqual(l.height);
      }
      for (const f of l.frames) expect(f.x + f.w, f.key).toBeLessThanOrEqual(width);
    });
  }
  it('8 个子域收进一个网格框、折成多行；双公网面的服务两处都画', () => {
    const l = layoutRelations(manySubs(), 720);
    const subs = l.frames.find((f) => f.key === 'subdomains')!;
    expect(subs.label).toBe('子域 · 8 个');
    const inSubs = Array.from(l.pos.entries()).filter(([, p]) => p.y > subs.y && p.y < subs.y + subs.h);
    expect(inSubs).toHaveLength(8);
    expect(new Set(inSubs.map(([, p]) => p.y)).size).toBeGreaterThan(1);
    expect(l.pos.has('imp-open-platform-api')).toBe(true);
    expect(l.aliasOf.get('imp-open-platform-api@sub:open-platform-api')).toBe('imp-open-platform-api');
  });
  it('卡片互不重叠', () => {
    const l = layoutRelations(manySubs(), 720);
    const all = Array.from(l.pos.entries());
    for (let i = 0; i < all.length; i += 1) for (let j = i + 1; j < all.length; j += 1) {
      const [a, pa] = all[i]; const [b, pb] = all[j];
      const overlap = pa.x < pb.x + pb.w && pb.x < pa.x + pa.w && pa.y < pb.y + pb.h && pb.y < pa.y + pa.h;
      expect(overlap, `${a} × ${b}`).toBe(false);
    }
  });
});

describe('关系图颜色只走主题 token', () => {
  it('源码里没有硬编码的十六进制颜色，角色与线色都经 hsl(var(--...))', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    expect(src.match(/#[0-9a-f]{6}\b/gi) ?? []).toEqual([]);
    for (const token of ['--role-web', '--role-api', '--role-worker', '--graph-call', '--graph-external']) expect(src).toContain(token);
  });
  it('五个 token 在两个主题块里都有定义', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../web/src/index.css'), 'utf8');
    for (const token of ['--role-web', '--role-api', '--role-worker', '--graph-call', '--graph-external']) {
      expect(css.match(new RegExp(`${token}:`, 'g'))?.length, token).toBe(2);
    }
  });
});
