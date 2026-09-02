/**
 * 跨项目引用变量（plan.cds.service-relations 第三批）。
 *
 * 写法：`${CDS_REF:<项目 id 或 slug>/<服务 id>[@<分支名或分支 id>]}`，可出现在环境变量值的任意位置。
 * 部署时由平台解析成目标项目那条分支上该服务的**公网入口**（子域服务给子域地址，其余给主入口）。
 * 必须走公网入口：各项目容器网络互相隔离，容器名在跨项目时不可达。
 * 不带 @ 时绑目标项目的默认分支；分支级可以钉到目标项目的某个分支（写进分支覆盖）。
 *
 * 解析结果带来源与目标状态，配置页「引用」分区、关系图的「引用断裂」都从这里取数。
 */
import type { BranchEntry, BuildProfile, Project } from '../types.js';
import { resolveBranchEntrypointsEnv, branchEntrypointDepsFromState, type BranchEntrypointDeps, PREVIEW_URL_ENV_KEY, SERVICE_URLS_ENV_KEY } from './preview-entrypoints.js';
import { buildPreviewUrlForProject } from './comment-template.js';

export const CDS_REF_RE = /\$\{CDS_REF:([A-Za-z0-9_.~-]+)\/([A-Za-z0-9_.~-]+)(?:@([^}\s]+))?\}/g;

export interface CdsRef {
  raw: string;
  projectRef: string;
  serviceId: string;
  branchRef?: string;
}

/** 从一个环境变量值里抽出全部引用（同一值可以含多个）。 */
export function parseCdsRefs(value: string): CdsRef[] {
  const out: CdsRef[] = [];
  for (const m of String(value ?? '').matchAll(CDS_REF_RE)) {
    out.push({ raw: m[0], projectRef: m[1], serviceId: m[2], ...(m[3] ? { branchRef: m[3] } : {}) });
  }
  return out;
}

export function formatCdsRef(ref: Pick<CdsRef, 'projectRef' | 'serviceId' | 'branchRef'>): string {
  return `\${CDS_REF:${ref.projectRef}/${ref.serviceId}${ref.branchRef ? `@${ref.branchRef}` : ''}}`;
}

export type RefTargetStatus = 'running' | 'stopped' | 'building' | 'error' | 'missing-service' | 'missing-branch' | 'missing-project';

export interface ResolvedCdsRef {
  ref: CdsRef;
  /** 解析成功时的公网地址 */
  url: string | null;
  status: RefTargetStatus;
  target: {
    projectId?: string;
    projectSlug?: string;
    branchId?: string;
    branchName?: string;
    serviceId: string;
    /** 目标分支是不是目标项目的默认分支（未钉分支时永远是） */
    isDefaultBranch?: boolean;
  };
  reason?: string;
}

export interface CdsRefResolverDeps {
  getProject: (idOrSlug: string) => Project | undefined;
  getAllBranches: () => BranchEntry[];
  getEffectiveProfilesForBranch: (entry: BranchEntry) => BuildProfile[];
  /** 用来算目标分支的已发布入口（与容器注入的入口表同一份） */
  entrypointDeps: BranchEntrypointDeps;
}

function findProject(deps: CdsRefResolverDeps, ref: string): Project | undefined {
  return deps.getProject(ref);
}

function projectDefaultBranch(project: Project): string {
  const p = project as Project & { gitDefaultBranch?: string | null; defaultBranch?: string | null };
  return (p.gitDefaultBranch || p.defaultBranch || 'main').trim() || 'main';
}

function findBranch(deps: CdsRefResolverDeps, project: Project, branchRef: string | undefined): { entry?: BranchEntry; name: string; isDefault: boolean } {
  const wanted = branchRef || projectDefaultBranch(project);
  const isDefault = !branchRef || wanted === projectDefaultBranch(project);
  const all = deps.getAllBranches().filter((b) => b.projectId === project.id);
  const entry = all.find((b) => b.id === wanted) ?? all.find((b) => b.branch === wanted);
  return { entry, name: entry?.branch ?? wanted, isDefault };
}

/** 目标服务在目标分支上的公网地址：子域服务给子域，其余给主入口。 */
export function serviceUrlOnBranch(deps: CdsRefResolverDeps, entry: BranchEntry, serviceId: string): string | null {
  const profiles = deps.getEffectiveProfilesForBranch(entry);
  const profile = profiles.find((p) => p.id === serviceId);
  if (!profile) return null;
  const env = resolveBranchEntrypointsEnv(entry, deps.entrypointDeps).env;
  if (profile.subdomain) {
    try {
      const table = JSON.parse(env[SERVICE_URLS_ENV_KEY] || '{}') as Record<string, string>;
      if (table[profile.subdomain]) return table[profile.subdomain];
    } catch { /* 表损坏按主入口兜底 */ }
  }
  if (env[PREVIEW_URL_ENV_KEY]) return env[PREVIEW_URL_ENV_KEY];
  const project = deps.getProject(entry.projectId);
  const built = buildPreviewUrlForProject(deps.entrypointDeps.previewHost, entry.branch, project, entry.projectId);
  return (built as { url?: string }).url ?? null;
}

export function resolveCdsRef(deps: CdsRefResolverDeps, ref: CdsRef): ResolvedCdsRef {
  const project = findProject(deps, ref.projectRef);
  if (!project) {
    return { ref, url: null, status: 'missing-project', target: { serviceId: ref.serviceId }, reason: `找不到项目 ${ref.projectRef}` };
  }
  const { entry, name, isDefault } = findBranch(deps, project, ref.branchRef);
  const base = { projectId: project.id, projectSlug: project.slug, serviceId: ref.serviceId, branchName: name, isDefaultBranch: isDefault };
  if (!entry) {
    return { ref, url: null, status: 'missing-branch', target: base, reason: `项目 ${project.slug} 没有分支 ${name}` };
  }
  const url = serviceUrlOnBranch(deps, entry, ref.serviceId);
  const target = { ...base, branchId: entry.id };
  if (!url) {
    return { ref, url: null, status: 'missing-service', target, reason: `分支 ${name} 上没有服务 ${ref.serviceId}` };
  }
  const svc = entry.services?.[ref.serviceId];
  const raw = String(svc?.status ?? entry.status ?? 'stopped');
  const status: RefTargetStatus = raw === 'running' ? 'running'
    : raw === 'error' ? 'error'
      : (raw === 'building' || raw === 'starting' || raw === 'restarting') ? 'building'
        : 'stopped';
  return { ref, url, status, target };
}

/** 把值里的引用全部换成地址；任一引用解析失败则原样保留该 token（由体检报「引用断裂」）。 */
export function substituteCdsRefs(value: string, resolve: (ref: CdsRef) => ResolvedCdsRef): { value: string; resolved: ResolvedCdsRef[] } {
  const resolved: ResolvedCdsRef[] = [];
  const out = String(value ?? '').replace(CDS_REF_RE, (raw, projectRef: string, serviceId: string, branchRef?: string) => {
    const r = resolve({ raw, projectRef, serviceId, ...(branchRef ? { branchRef } : {}) });
    resolved.push(r);
    return r.url ?? raw;
  });
  return { value: out, resolved };
}

/** 环境变量里「像地址」的键：引用变量、值是网址、键名带 URL/BASE/ENDPOINT/HOST 后缀。 */
export type ReferenceKind = 'cds-ref' | 'url' | 'name-hint' | 'platform';
const URL_VALUE_RE = /^https?:\/\/[^\s]+$/i;
const NAME_HINT_RE = /(_URL|_BASE|_BASE_URL|_ENDPOINT|_HOST|_ORIGIN)$/;
export const PLATFORM_ADDRESS_KEYS = new Set([PREVIEW_URL_ENV_KEY, SERVICE_URLS_ENV_KEY, 'CDS_CONSOLE_URL', 'CDS_HOST']);

export function classifyReference(key: string, value: string): ReferenceKind | null {
  if (PLATFORM_ADDRESS_KEYS.has(key)) return 'platform';
  if (parseCdsRefs(value).length > 0) return 'cds-ref';
  if (URL_VALUE_RE.test(String(value ?? '').trim())) return 'url';
  if (NAME_HINT_RE.test(key)) return 'name-hint';
  return null;
}

/** 从 StateService 造解析依赖（与容器注入的入口表同一份口径）。 */
export function cdsRefResolverDepsFromState(
  stateService: {
    getProject: (id: string) => Project | undefined;
    getAllBranches: () => BranchEntry[];
    getEffectiveProfilesForBranch: (entry: BranchEntry) => BuildProfile[];
    getState: () => { projects?: Project[] };
  },
  previewHost?: string,
): CdsRefResolverDeps {
  const byIdOrSlug = (ref: string): Project | undefined =>
    stateService.getProject(ref) ?? (stateService.getState().projects ?? []).find((p) => p.slug === ref || (p as { aliasSlug?: string }).aliasSlug === ref);
  return {
    getProject: byIdOrSlug,
    getAllBranches: () => stateService.getAllBranches(),
    getEffectiveProfilesForBranch: (entry) => stateService.getEffectiveProfilesForBranch(entry),
    entrypointDeps: branchEntrypointDepsFromState(stateService as Parameters<typeof branchEntrypointDepsFromState>[0], previewHost),
  };
}
