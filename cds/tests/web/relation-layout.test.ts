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
    // 第二条从入口左沿出发（走左侧走线槽），不是从入口下沿直落
    expect(entries[1].d.startsWith(`M${l.entry.x},`)).toBe(true);
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
    // 徽标走专用的 --badge-* 对（实色底 + 墨色字，两个主题各验过对比度），线色走 --graph-call
    for (const token of ['--badge-web', '--badge-api', '--badge-job', '--badge-gw', '--badge-ext', '--badge-ink', '--graph-call']) expect(src).toContain(token);
  });
  it('关系图用到的 token 在两个主题块里都有定义', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../../web/src/index.css'), 'utf8');
    for (const token of ['--role-web', '--role-api', '--role-worker', '--graph-call', '--graph-external', '--badge-web', '--badge-api', '--badge-job', '--badge-gw', '--badge-ext', '--badge-db', '--badge-r', '--badge-ink', '--warn-ink', '--ok-ink']) {
      expect(css.match(new RegExp(`${token}:`, 'g'))?.length, token).toBe(2);
    }
  });
});

describe('两档几何（设计稿「CDS 关系视图改版」02 / 04）', () => {
  it('桌面档：卡片 280 宽，壳到前缀成员走直角总线', () => {
    const l = layoutRelations(manySubs(), 1289);
    expect(l.compact).toBe(false);
    expect(l.pos.get('imp-admin')!.w).toBeGreaterThanOrEqual(232);
    expect(l.pos.get('imp-admin')!.w).toBeLessThanOrEqual(280);
    // 4 个前缀成员同一行（此前固定 280 宽时第 4 个掉到第二行）
    expect(new Set(['imp-api', 'imp-open-platform-api', 'imp-vendor-api'].map((id) => l.pos.get(id)!.y)).size).toBe(1);
    const prefix = l.edges.filter((e) => e.kind === 'prefix');
    expect(prefix.length).toBe(3);
    // 直角总线：壳下沿中点出发 → 下到总线 → 横到成员正上方 → 落下
    const shell = l.pos.get('imp-admin')!;
    for (const e of prefix) {
      expect(e.d.startsWith(`M${shell.x + shell.w / 2},${shell.y + shell.h} V`)).toBe(true);
      expect(e.d).toMatch(/^M[\d.]+,[\d.]+ V[\d.]+ H[\d.]+ V[\d.]+$/);
    }
    // 4 列：8 个子域排两行
    const subs = l.frames.find((f) => f.key === 'subdomains')!;
    const ys = new Set(Array.from(l.pos.values()).filter((p) => p.y > subs.y && p.y < subs.y + subs.h).map((p) => p.y));
    expect(ys.size).toBe(2);
  });
  it('手机档（390 宽）：不整体缩小，前缀成员改成缩进的树状列表，子域两列', () => {
    const l = layoutRelations(manySubs(), 374);
    expect(l.compact).toBe(true);
    expect(l.width).toBe(374);
    const shell = l.pos.get('imp-admin')!;
    const members = ['imp-api', 'imp-open-platform-api', 'imp-vendor-api'].map((id) => l.pos.get(id)!);
    for (const m of members) { expect(m.x).toBeGreaterThan(shell.x); expect(m.x + m.w).toBeLessThanOrEqual(374); }
    expect(new Set(members.map((m) => m.x)).size).toBe(1);
    // 树状：从壳下方缩进处的竖线出发，横进成员卡左沿
    for (const e of l.edges.filter((x) => x.kind === 'prefix')) {
      expect(e.d.startsWith(`M${shell.x + 20},${shell.y + shell.h} V`)).toBe(true);
      expect(e.d.endsWith(`H${e.to.x - 2}`)).toBe(true);
    }
    const subs = l.frames.find((f) => f.key === 'subdomains')!;
    const xs = new Set(Array.from(l.pos.values()).filter((p) => p.y > subs.y && p.y < subs.y + subs.h).map((p) => p.x));
    expect(xs.size).toBe(2);
  });
});
