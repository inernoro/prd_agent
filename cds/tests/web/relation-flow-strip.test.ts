/**
 * 关系流向条（RelationFlowStrip，2026-09-16）的守卫。
 *
 * 缩略卡此前画的是缩略版二维图，固定 180px 高、只按宽度缩放，宽屏上被裁得只剩「入口」
 * 一枚节点——文案说 2 个服务挂在壳下面，图里一个都没有。这类「裁掉一半」不会红、不会报错，
 * 只有真人看一眼才发现，所以钉成机械判据：流向条必须列全每个服务与基础设施。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { layoutFlow, RelationFlowStrip, RelationFlowSkeleton } from '../../web/src/components/branch/RelationFlowStrip.js';
import { formatDeployedAgo, formatUptime } from '../../web/src/components/branch/OverviewPanel.js';
import type { RelationPayload } from '../../web/src/components/branch/RelationGraph.js';

const SRC = path.resolve(__dirname, '../../web/src');
/** 扫源码只扫会执行的部分：注释里为讲病根会原样引用错误写法（predicate-and-wiring-discipline 形状 6）。 */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function payload(): RelationPayload {
  return {
    branchId: 'b', projectId: 'p', branch: 'main', status: 'running',
    graph: {
      nodes: [
        { id: 'service:admin-web', rawId: 'admin-web', name: 'admin-web', kind: 'service', pathPrefixes: ['/'], role: 'web' },
        { id: 'service:api', rawId: 'api', name: 'api', kind: 'service', pathPrefixes: ['/api/', '/hubs/'], role: 'api' },
        { id: 'service:files', rawId: 'files', name: 'files', kind: 'service', pathPrefixes: ['/files/'], role: 'api' },
        { id: 'service:cron', rawId: 'cron', name: 'cron', kind: 'service', role: 'worker' },
        { id: 'infra:mongo', name: 'mongo', kind: 'infra', dockerImage: 'mongo:7' },
        { id: 'infra:redis', name: 'redis', kind: 'infra', dockerImage: 'redis:7' },
      ],
      edges: [
        { from: 'service:api', to: 'infra:mongo', envKeys: ['MONGO_URL'], dependsOn: false },
        { from: 'service:api', to: 'infra:redis', envKeys: ['REDIS_URL'], dependsOn: false },
        { from: 'service:files', to: 'infra:redis', envKeys: ['REDIS_URL'], dependsOn: false },
        { from: 'service:cron', to: 'infra:mongo', envKeys: ['MONGO_URL'], dependsOn: false },
      ],
      layers: [['admin-web'], ['api', 'files', 'cron']],
      sites: [
        { id: 'main', kind: 'main', shellId: 'admin-web', shellSource: 'declared', members: [{ id: 'api', prefixes: ['/api/', '/hubs/'] }, { id: 'files', prefixes: ['/files/'], viaConvention: true }], conflicts: [] },
      ],
      internal: ['cron'],
    },
    lint: { findings: [{ rule: 'prefix-by-convention', severity: 'warn', services: ['files'], message: '/files/ 只是按名兜底', fix: '写上 cds.path-prefix' }], summary: { errors: 0, warnings: 1, infos: 0 } },
    references: [],
  };
}

describe('layoutFlow', () => {
  it('列全每个服务与基础设施：壳一列、前缀成员与内网服务一列、共享基础设施一列，一个都不能少', () => {
    const m = layoutFlow(payload(), 'main.example.test');
    expect(m.entry.name).toBe('main.example.test');
    expect(m.shells.map((c) => c.id)).toEqual(['admin-web']);
    expect(m.members.map((c) => c.id)).toEqual(['api', 'files', 'cron']);
    expect(m.tail.map((c) => c.id)).toEqual(['infra:mongo', 'infra:redis']);
    const all = new Set([...m.shells, ...m.members, ...m.tail].map((c) => c.id));
    for (const n of payload().graph.nodes) expect(all.has(n.rawId ?? n.id), n.id).toBe(true);
  });
  it('前缀写在节点里；按名推断的成员标 inferred 并挂问题数；壳到成员只给前缀成员连线', () => {
    const m = layoutFlow(payload());
    expect(m.members[0].sub).toBe('/api/ · /hubs/');
    expect(m.members[1]).toMatchObject({ inferred: true, problem: 'warn', problemCount: 1 });
    expect(m.members[2].sub).toContain('内网');
    expect(m.shellLinks).toEqual([{ from: 0, to: 0, kind: 'prefix' }, { from: 0, to: 1, kind: 'prefix' }]);
    expect(m.tailLinks).toEqual([
      { from: 0, to: 0, kind: 'call' }, { from: 0, to: 1, kind: 'call' }, { from: 1, to: 1, kind: 'call' }, { from: 2, to: 0, kind: 'call' },
    ]);
  });
  it('事实行的六个数字与图同源', () => {
    const m = layoutFlow(payload());
    expect(m.facts).toEqual({ sites: 1, services: 4, prefixes: 3, infra: 2, refs: 0, errors: 0, warnings: 1 });
  });
  it('主域名没有壳时不静默：壳列放一枚说明 chip，其余服务仍全部出现', () => {
    const p = payload();
    p.graph.sites[0].shellId = undefined;
    const m = layoutFlow(p);
    expect(m.shells[0].id).toBe('no-shell');
    expect(m.members.map((c) => c.id).sort()).toEqual(['admin-web', 'api', 'cron', 'files']);
  });
});

describe('RelationFlowStrip 渲染', () => {
  it('每个服务与基础设施都渲染成 data-node，出问题的节点带 data-problem', () => {
    const html = renderToStaticMarkup(createElement(RelationFlowStrip, { model: layoutFlow(payload(), 'main.example.test') }));
    for (const id of ['admin-web', 'api', 'files', 'cron', 'infra:mongo', 'infra:redis']) expect(html, id).toContain(`data-node="${id}"`);
    expect(html).toContain('data-problem="warn"');
    expect(html).toContain('1 问题');
    // 前缀在节点里，不在线上
    expect(html).toContain('/api/ · /hubs/');
  });
  it('骨架与真实流向条同一副外形（同一 testid 前缀、同一圆角与底色），卡片高度不跳', () => {
    const real = renderToStaticMarkup(createElement(RelationFlowStrip, { model: layoutFlow(payload()) }));
    const ghost = renderToStaticMarkup(createElement(RelationFlowSkeleton, { note: '正在算' }));
    for (const cls of ['rounded-[0.625rem]', 'bg-[hsl(var(--surface-sunken))]', 'py-3.5']) { expect(real).toContain(cls); expect(ghost).toContain(cls); }
  });
  it('徽标不占语义色：redis 不用 --bad，mongo 不用 --ok（红色只在「坏了」时出现）', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/branch/RelationFlowStrip.tsx'), 'utf8');
    const kindLine = src.split('\n').find((l) => l.startsWith('const KIND_TOKEN'))!;
    expect(kindLine).not.toMatch(/--bad|--ok|--warn/);
    const graph = fs.readFileSync(path.join(SRC, 'components/branch/RelationGraph.tsx'), 'utf8');
    expect(graph).not.toContain("'--bad' : '--ok'");
  });
});

describe('关系卡接进总览面板，不再常驻页签之上', () => {
  it('RelationCard 只在 OverviewPanel 的 relationSlot 里出现，且带主入口域名与去配置落点', () => {
    const drawer = fs.readFileSync(path.join(SRC, 'components/BranchDetailDrawer.tsx'), 'utf8');
    const uses = drawer.match(/<RelationCard\b/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(drawer).toMatch(/relationSlot=\{[^}]*<RelationCard[^>]*previewUrl=/);
    expect(drawer).toMatch(/<RelationCard[^>]*onConfigure=/);
    const panel = fs.readFileSync(path.join(SRC, 'components/branch/OverviewPanel.tsx'), 'utf8');
    // 判断行之下、入口之上
    expect(panel.indexOf('{relationSlot ?? null}')).toBeGreaterThan(panel.indexOf('<HealthRing'));
    expect(panel.indexOf('{relationSlot ?? null}')).toBeLessThan(panel.indexOf('<EntryCards'));
  });
  it('关系卡不再给流向条一个固定高度的盒子（那正是被裁掉一半的根因）', () => {
    const card = fs.readFileSync(path.join(SRC, 'components/branch/RelationCard.tsx'), 'utf8');
    expect(card).not.toMatch(/height: '11\.25rem'/);
    expect(card).not.toMatch(/<RelationGraph[^>]*compact/);
  });
});

describe('关系图线型有语义', () => {
  it('EDGE_STYLE 里不再给每种线配 dash：虚线只由 inferred 决定', () => {
    const graph = fs.readFileSync(path.join(SRC, 'components/branch/RelationGraph.tsx'), 'utf8');
    const block = graph.slice(graph.indexOf('const EDGE_STYLE'), graph.indexOf('const INFERRED_DASH'));
    expect(block).not.toMatch(/dash:/);
    expect(graph).toContain("strokeDasharray={e.inferred ? INFERRED_DASH : undefined}");
    // 框角与入口不再写实现术语
    const code = stripComments(graph);
    for (const jargon of ['壳在上', 'forwarder 按 host']) expect(code).not.toContain(jargon);
  });
});

describe('总览判断行的时长文案', () => {
  const t0 = Date.parse('2026-09-16T10:00:00Z');
  it('不满 1 分钟按秒计，不再显示「0 分钟」', () => {
    expect(formatUptime(new Date(t0).toISOString(), t0 + 42_000)).toBe('42 秒');
    expect(formatUptime(new Date(t0).toISOString(), t0 + 61_000)).toBe('1 分钟');
  });
  it('部署时间不满 1 分钟写「刚刚部署」', () => {
    expect(formatDeployedAgo(new Date(t0).toISOString(), t0 + 30_000)).toBe('刚刚部署');
    expect(formatDeployedAgo(new Date(t0).toISOString(), t0 + 5 * 60_000)).toBe('5 分钟前部署');
  });
});

describe('零服务的空态（2026-09-16 真站截图：master 分支一个 service 都没有）', () => {
  const empty = (): RelationPayload => ({ ...payload(), graph: { nodes: [{ id: 'infra:mongo', name: 'mongo', kind: 'infra' }], edges: [], layers: [], sites: [], internal: [] }, lint: { findings: [], summary: { errors: 0, warnings: 0, infos: 0 } } });
  it('结论不再说「体检无错误」，而是明说没有服务', async () => {
    const { relationHeadline, RELATION_EMPTY_HEADLINE } = await import('../../web/src/components/branch/RelationGraph.js');
    expect(relationHeadline(empty())).toBe(RELATION_EMPTY_HEADLINE);
  });
  it('关系图不开画布、不出图例，改出空态', async () => {
    const { RelationGraph } = await import('../../web/src/components/branch/RelationGraph.js');
    const html = renderToStaticMarkup(createElement(RelationGraph, { payload: empty() }));
    expect(html).toContain('data-testid="relation-graph-empty"');
    expect(html).not.toContain('data-testid="relation-legend"');
    expect(html).not.toContain('data-node=');
  });
  it('关系卡零服务时不出事实行与流向条（源码守卫：空态分支在 layoutFlow 之前返回）', () => {
    const card = fs.readFileSync(path.join(SRC, 'components/branch/RelationCard.tsx'), 'utf8');
    const emptyAt = card.indexOf("every((n) => n.kind !== 'service')");
    expect(emptyAt).toBeGreaterThan(0);
    expect(emptyAt).toBeLessThan(card.indexOf('const model = layoutFlow'));
    expect(card.slice(emptyAt, card.indexOf('const model = layoutFlow'))).toContain('<RelationEmptyState');
  });
  it('图例每一项不换行：窄抽屉里不许把「声明的关系」折成两行', () => {
    const graph = fs.readFileSync(path.join(SRC, 'components/branch/RelationGraph.tsx'), 'utf8');
    const legend = graph.slice(graph.indexOf('data-testid="relation-legend"'), graph.indexOf('角色是推断的'));
    const items = legend.match(/<span className="inline-flex items-center gap-1\.5[^"]*"/g) ?? [];
    expect(items.length).toBeGreaterThanOrEqual(5);
    for (const it of items) expect(it).toContain('whitespace-nowrap');
  });
});
