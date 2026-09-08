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
    expect(l.frames.filter((f) => f.tone === 'site').map((f) => f.key)).toEqual(['main', 'sub:gw']);
    expect(l.pos.has('gw')).toBe(true);
    expect(l.pos.has('gw@sub:gw')).toBe(true);
    expect(l.aliasOf.get('gw@sub:gw')).toBe('gw');
    // 前缀线仍从主域名壳出发到 api
    expect(l.edges.some((e) => e.kind === 'prefix' && e.label?.includes('/api/'))).toBe(true);
    // 两个入口线：每个站点一条
    expect(l.edges.filter((e) => e.kind === 'entry')).toHaveLength(2);
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
