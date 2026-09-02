/**
 * 跨项目引用变量（plan.cds.service-relations 第三批）：写法解析、目标解析（默认分支 / 钉分支 /
 * 子域服务 / 主入口）、断裂判定、值内替换与环境变量溯源打标。
 */
import { describe, it, expect } from 'vitest';
import { classifyReference, formatCdsRef, parseCdsRefs, resolveCdsRef, substituteCdsRefs, type CdsRefResolverDeps } from '../../src/services/cross-project-refs.js';
import { resolveProfileRuntimeEnvWithProvenance } from '../../src/services/env-provenance.js';
import type { BranchEntry, BuildProfile, Project } from '../../src/types.js';

describe('parseCdsRefs / formatCdsRef', () => {
  it('解析项目、服务、可选分支；一个值里可以有多个引用', () => {
    expect(parseCdsRefs('${CDS_REF:prd-agent/llmgw-serve}')).toEqual([{ raw: '${CDS_REF:prd-agent/llmgw-serve}', projectRef: 'prd-agent', serviceId: 'llmgw-serve' }]);
    expect(parseCdsRefs('${CDS_REF:mdimp/imp-api@feature/x}/v1')).toEqual([{ raw: '${CDS_REF:mdimp/imp-api@feature/x}', projectRef: 'mdimp', serviceId: 'imp-api', branchRef: 'feature/x' }]);
    expect(parseCdsRefs('${CDS_REF:a/b} ${CDS_REF:c/d}')).toHaveLength(2);
    expect(parseCdsRefs('${CDS_HOST}:8080')).toEqual([]);
    expect(formatCdsRef({ projectRef: 'a', serviceId: 'b', branchRef: 'main' })).toBe('${CDS_REF:a/b@main}');
  });
  it('classifyReference 把地址类键分四种', () => {
    expect(classifyReference('X', '${CDS_REF:a/b}')).toBe('cds-ref');
    expect(classifyReference('X', 'https://main-mdimp.miduo.org/api')).toBe('url');
    expect(classifyReference('MAP_API_BASE', 'imp-api:8080')).toBe('name-hint');
    expect(classifyReference('CDS_SERVICE_URLS', '{}')).toBe('platform');
    expect(classifyReference('JWT_SECRET', 'x')).toBeNull();
  });
});

function deps(): CdsRefResolverDeps {
  const projects: Project[] = [
    { id: 'p-prd', slug: 'prd-agent', name: 'MAP', gitDefaultBranch: 'main' } as unknown as Project,
    { id: 'p-md', slug: 'mdimp', name: 'mdimp' } as unknown as Project,
  ];
  const profiles: Record<string, BuildProfile[]> = {
    'p-prd': [
      { id: 'prd-api', projectId: 'p-prd', name: 'prd-api', dockerImage: 'x', workDir: '.', containerPort: 5000, pathPrefixes: ['/api/'] } as BuildProfile,
      { id: 'llmgw-serve', projectId: 'p-prd', name: 'llmgw', dockerImage: 'x', workDir: '.', containerPort: 8091, subdomain: 'llmgw' } as BuildProfile,
    ],
    'p-md': [],
  };
  const branches: BranchEntry[] = [
    { id: 'prd-main', projectId: 'p-prd', branch: 'main', worktreePath: '/w', status: 'stopped', createdAt: 'x', services: { 'prd-api': { profileId: 'prd-api', containerName: 'c', hostPort: 1, status: 'stopped' }, 'llmgw-serve': { profileId: 'llmgw-serve', containerName: 'c2', hostPort: 2, status: 'stopped' } } } as unknown as BranchEntry,
    { id: 'prd-feat', projectId: 'p-prd', branch: 'feat/x', worktreePath: '/w', status: 'running', createdAt: 'x', services: { 'prd-api': { profileId: 'prd-api', containerName: 'c', hostPort: 1, status: 'running' }, 'llmgw-serve': { profileId: 'llmgw-serve', containerName: 'c2', hostPort: 2, status: 'running' } } } as unknown as BranchEntry,
  ];
  return {
    getProject: (ref) => projects.find((p) => p.id === ref || p.slug === ref),
    getAllBranches: () => branches,
    getEffectiveProfilesForBranch: (entry) => profiles[entry.projectId] ?? [],
    entrypointDeps: {
      previewHost: 'miduo.org',
      getAllBranches: () => branches,
      getProject: (id) => projects.find((p) => p.id === id),
      getEffectiveProfilesForBranch: (entry) => profiles[entry.projectId] ?? [],
    },
  };
}

describe('resolveCdsRef', () => {
  it('不带分支绑默认分支；子域服务给子域地址，其余给主入口；目标停了状态为 stopped 但地址仍给', () => {
    const r = resolveCdsRef(deps(), parseCdsRefs('${CDS_REF:prd-agent/llmgw-serve}')[0]);
    expect(r.status).toBe('stopped');
    expect(r.target).toMatchObject({ projectSlug: 'prd-agent', branchId: 'prd-main', branchName: 'main', isDefaultBranch: true });
    expect(r.url).toMatch(/^https:\/\/main-prd-agent-llmgw\.miduo\.org/);
    const api = resolveCdsRef(deps(), parseCdsRefs('${CDS_REF:p-prd/prd-api}')[0]);
    expect(api.url).toMatch(/^https:\/\/main-prd-agent\.miduo\.org/);
  });
  it('钉到某个分支时按该分支解析，running 即可用', () => {
    const r = resolveCdsRef(deps(), parseCdsRefs('${CDS_REF:prd-agent/prd-api@feat/x}')[0]);
    expect(r.status).toBe('running');
    expect(r.target.branchId).toBe('prd-feat');
    expect(r.target.isDefaultBranch).toBe(false);
    expect(r.url).toMatch(/feat/);
  });
  it('项目 / 分支 / 服务找不到时分别报 missing-*，url 为 null', () => {
    expect(resolveCdsRef(deps(), parseCdsRefs('${CDS_REF:nope/x}')[0]).status).toBe('missing-project');
    expect(resolveCdsRef(deps(), parseCdsRefs('${CDS_REF:prd-agent/prd-api@gone}')[0]).status).toBe('missing-branch');
    expect(resolveCdsRef(deps(), parseCdsRefs('${CDS_REF:prd-agent/ghost}')[0]).status).toBe('missing-service');
  });
  it('substituteCdsRefs 只替换能解析的，其余原样保留', () => {
    const d = deps();
    const out = substituteCdsRefs('${CDS_REF:prd-agent/prd-api@feat/x}/v1 ${CDS_REF:nope/x}', (ref) => resolveCdsRef(d, ref));
    expect(out.value).toMatch(/^https:\/\/.*\/v1 \$\{CDS_REF:nope\/x\}$/);
    expect(out.resolved.map((r) => r.status)).toEqual(['running', 'missing-project']);
  });
});

describe('env-provenance 里的引用替换', () => {
  const entry = { branch: 'main' } as Parameters<typeof resolveProfileRuntimeEnvWithProvenance>[0];
  const profile = { dockerImage: 'node:20' } as Parameters<typeof resolveProfileRuntimeEnvWithProvenance>[1];
  it('解析成功换成地址并打标 cds-ref；失败原样保留打标 cds-ref-unresolved，不抛错', () => {
    const r = resolveProfileRuntimeEnvWithProvenance(entry, profile,
      [{ source: 'branch', env: { LLMGW_BASE: '${CDS_REF:prd-agent/llmgw-serve}', BAD: '${CDS_REF:nope/x}' } }], [],
      { jwtIssuer: 'cds', resolveCdsRef: (raw) => (raw.includes('nope') ? null : 'https://main-prd-agent-llmgw.miduo.org') });
    expect(r.env.LLMGW_BASE).toBe('https://main-prd-agent-llmgw.miduo.org');
    expect(r.env.BAD).toBe('${CDS_REF:nope/x}');
    expect(r.provenance.find((p) => p.key === 'LLMGW_BASE')).toMatchObject({ source: 'platform-injected', detail: 'cds-ref' });
    expect(r.provenance.find((p) => p.key === 'BAD')).toMatchObject({ detail: 'cds-ref-unresolved' });
  });
  it('没有传解析器时引用原样保留，不会被当成缺失模板', () => {
    const r = resolveProfileRuntimeEnvWithProvenance(entry, profile, [{ source: 'branch', env: { X: '${CDS_REF:a/b}' } }], [], { jwtIssuer: 'cds' });
    expect(r.env.X).toBe('${CDS_REF:a/b}');
  });
});
