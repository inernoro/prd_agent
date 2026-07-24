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
    expect(edges).toEqual(['llmgw-web->llmgw', 'llmgw-web->llmgw-serve']);
    const toServe = g.edges.find((e) => e.to === 'llmgw-serve')!;
    expect(toServe.envKeys).toEqual(['LLMGW_SERVING_PROXY_TARGET']);
  });

  it('`${CDS_<INFRA>_PORT}` 模板产生服务到基础设施的边', () => {
    expect(infraPortVar('mongodb')).toBe('CDS_MONGODB_PORT');
    const profiles = [profile('api', { env: { MongoDB__ConnectionString: 'mongodb://${CDS_HOST}:${CDS_MONGODB_PORT}' } })];
    const g = buildServiceGraph(profiles, [infra('mongodb')]);
    const e = g.edges.find((x) => x.from === 'api' && x.to === 'mongodb');
    expect(e).toBeDefined();
    expect(e!.envKeys).toContain('MongoDB__ConnectionString');
  });

  it('depends_on 声明产生边（服务与基础设施都认）', () => {
    const profiles = [profile('web', { dependsOn: ['api', 'redis'] }), profile('api')];
    const g = buildServiceGraph(profiles, [infra('redis', 'redis:7')]);
    expect(g.edges.find((e) => e.from === 'web' && e.to === 'api')?.dependsOn).toBe(true);
    expect(g.edges.find((e) => e.from === 'web' && e.to === 'redis')?.dependsOn).toBe(true);
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
});
