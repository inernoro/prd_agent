// 项目级数据库隔离路由（2026-09-02）
//
// 背景：`BuildProfile.dbScope`（共享库 / 分支独立库）一直是项目级底座字段，但项目设置
// 里没有任何入口——唯一能看见它的地方是分支抽屉里的「覆盖」下拉，层级倒置：
// 用户以为它是分支级开关，而它真正的默认值藏在没人打开的 profile 里。
//
// 这里把它提升为项目设置的一级页签，并给出**项目级原子读写**：
//   GET /api/projects/:id/db-isolation   → 项目内每个服务的档位 + 分支覆盖概况
//   PUT /api/projects/:id/db-isolation   → 一次写多个服务，先全量校验再落盘，
//                                          任何一项不合法就整批拒绝，不存在「保存一半」
//
// 数据源不变：仍然只有 `BuildProfile.dbScope` 一份（SSOT），分支覆盖仍在
// `BranchEntry.profileOverrides[profileId].dbScope`，本路由**不碰**分支覆盖——
// 「已有分支覆盖保持不变」是对用户的明确承诺（见 view.branchOverrides）。
//
// 与部署路径的关系：applyProfileOverride（container.ts）合并 override.dbScope，
// applyPerBranchDbIsolation（db-scope-isolation.ts）按最终 dbScope 改写库名 key。
// 本路由改的是 baseline，所以只影响「没有分支覆盖」的分支，且重新部署后才生效。

import { Router } from 'express';
import type { StateService } from '../services/state.js';
import type { BranchEntry, BuildProfile, Project } from '../types.js';
import { PER_BRANCH_DB_ENV_KEYS } from '../services/db-scope-isolation.js';

export type DbScope = 'shared' | 'per-branch';

export const DB_SCOPES: readonly DbScope[] = ['shared', 'per-branch'] as const;

/** 未显式声明时的档位。与 applyPerBranchDbIsolation 的「非 per-branch 即 noop」口径一致。 */
export const DEFAULT_DB_SCOPE: DbScope = 'shared';

export function isDbScope(value: unknown): value is DbScope {
  return value === 'shared' || value === 'per-branch';
}

export interface ProjectDbIsolationService {
  profileId: string;
  name: string;
  dockerImage: string;
  /** 生效档位（未声明时按默认值折算，前端不必再判 undefined）。 */
  dbScope: DbScope;
  /** explicit = profile 上写了；default = 没写，按 DEFAULT_DB_SCOPE 折算。 */
  dbScopeSource: 'explicit' | 'default';
  /**
   * 这个服务 env 里会被「分支独立库」改写的库名 key。空数组意味着切到 per-branch
   * 也不会有任何效果——前端据此给出「未声明库名变量」的提示，而不是让用户切完
   * 发现「修了像没修」。
   */
  dbEnvKeys: string[];
  /** 有多少条分支对这个服务写了自己的覆盖（这些分支不受项目默认影响）。 */
  branchOverrideCount: number;
}

export interface ProjectDbIsolationBranchOverride {
  branchId: string;
  branch: string;
  /** profileId → 该分支自己钉住的档位 */
  overrides: Record<string, DbScope>;
}

export interface ProjectDbIsolationView {
  projectId: string;
  /** 托管交付项目的 profile 由 StackDetector 生成、只读，不允许在这里改。 */
  readOnly: boolean;
  readOnlyReason?: string;
  services: ProjectDbIsolationService[];
  branchOverrides: ProjectDbIsolationBranchOverride[];
  summary: {
    services: number;
    shared: number;
    perBranch: number;
    branches: number;
    /** 至少有一个服务写了分支覆盖的分支数 */
    branchesWithOverride: number;
  };
}

export interface ProjectDbIsolationWriteBody {
  /** 批量：项目内所有服务统一设为这一档。 */
  all?: unknown;
  /** 逐服务：profileId → 档位。与 all 同时给时，这里的条目优先。 */
  services?: unknown;
}

export interface ProjectDbIsolationChange {
  profileId: string;
  from: DbScope;
  to: DbScope;
}

export type ProjectDbIsolationPlan =
  | { ok: true; changes: ProjectDbIsolationChange[]; unchanged: string[] }
  | { ok: false; status: number; error: string; unknownProfileIds?: string[] };

export interface ProjectDbIsolationWriteResult {
  projectId: string;
  changes: ProjectDbIsolationChange[];
  unchanged: string[];
  /** 继承项目默认（对被改的服务没有分支覆盖）、因此会受影响的分支数 */
  affectedBranches: number;
  /** 对被改的服务写了分支覆盖、本次保持原样的分支数 */
  keptBranchOverrides: number;
  snapshotId?: string;
  message: string;
  view: ProjectDbIsolationView;
}

export function effectiveDbScope(profile: Pick<BuildProfile, 'dbScope'>): DbScope {
  return isDbScope(profile.dbScope) ? profile.dbScope : DEFAULT_DB_SCOPE;
}

/** 分支对某个服务是否写了 dbScope 覆盖。 */
function branchDbScopeOverride(branch: BranchEntry, profileId: string): DbScope | undefined {
  const value = branch.profileOverrides?.[profileId]?.dbScope;
  return isDbScope(value) ? value : undefined;
}

/**
 * 纯函数：把项目 profiles + 分支列表折算成面板视图。
 * 只读，不依赖 StateService，便于单测与前端 mock 对齐。
 */
export function buildProjectDbIsolationView(
  project: Pick<Project, 'id' | 'deliveryMode'>,
  profiles: BuildProfile[],
  branches: BranchEntry[],
): ProjectDbIsolationView {
  const branchOverrides: ProjectDbIsolationBranchOverride[] = [];
  const overrideCountByProfile = new Map<string, number>();
  for (const branch of branches) {
    const overrides: Record<string, DbScope> = {};
    for (const profile of profiles) {
      const scope = branchDbScopeOverride(branch, profile.id);
      if (!scope) continue;
      overrides[profile.id] = scope;
      overrideCountByProfile.set(profile.id, (overrideCountByProfile.get(profile.id) || 0) + 1);
    }
    if (Object.keys(overrides).length > 0) {
      branchOverrides.push({ branchId: branch.id, branch: branch.branch, overrides });
    }
  }

  const services: ProjectDbIsolationService[] = profiles.map((profile) => {
    const env = profile.env || {};
    const dbEnvKeys = PER_BRANCH_DB_ENV_KEYS.filter((key) => typeof env[key] === 'string' && env[key] !== '');
    return {
      profileId: profile.id,
      name: profile.name || profile.id,
      dockerImage: profile.dockerImage || '',
      dbScope: effectiveDbScope(profile),
      dbScopeSource: isDbScope(profile.dbScope) ? 'explicit' : 'default',
      dbEnvKeys,
      branchOverrideCount: overrideCountByProfile.get(profile.id) || 0,
    };
  });

  const readOnly = project.deliveryMode === 'managed';
  return {
    projectId: project.id,
    readOnly,
    ...(readOnly ? { readOnlyReason: '托管交付项目的服务配置由 CDS 自动生成，数据库隔离档位不在这里修改' } : {}),
    services,
    branchOverrides,
    summary: {
      services: services.length,
      shared: services.filter((s) => s.dbScope === 'shared').length,
      perBranch: services.filter((s) => s.dbScope === 'per-branch').length,
      branches: branches.length,
      branchesWithOverride: branchOverrides.length,
    },
  };
}

/**
 * 纯函数：把请求体折算成「要改哪些服务、改成什么」。
 *
 * 全量校验先行：任何一个 profileId 不存在、任何一个值不在枚举内，整批拒绝，
 * 不返回部分 plan——这是「原子」的前半段，后半段是路由里的一次 save()。
 */
export function planProjectDbIsolationWrite(
  profiles: BuildProfile[],
  body: ProjectDbIsolationWriteBody | null | undefined,
): ProjectDbIsolationPlan {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: '请求体必须是对象，且至少提供 all 或 services 之一' };
  }
  const { all, services } = body;
  if (all === undefined && services === undefined) {
    return { ok: false, status: 400, error: '至少提供 all（批量）或 services（逐服务）之一' };
  }
  if (all !== undefined && !isDbScope(all)) {
    return { ok: false, status: 400, error: `all 非法（仅允许 'shared' 或 'per-branch'）` };
  }
  const perService = new Map<string, DbScope>();
  if (services !== undefined) {
    if (!services || typeof services !== 'object' || Array.isArray(services)) {
      return { ok: false, status: 400, error: 'services 必须是 { profileId: dbScope } 形状的对象' };
    }
    const known = new Set(profiles.map((p) => p.id));
    const unknown: string[] = [];
    for (const [profileId, value] of Object.entries(services as Record<string, unknown>)) {
      if (!known.has(profileId)) { unknown.push(profileId); continue; }
      if (!isDbScope(value)) {
        return { ok: false, status: 400, error: `服务 "${profileId}" 的档位非法（仅允许 'shared' 或 'per-branch'）` };
      }
      perService.set(profileId, value);
    }
    if (unknown.length > 0) {
      return {
        ok: false,
        status: 400,
        error: `以下服务不属于本项目：${unknown.join(', ')}（整批未写入）`,
        unknownProfileIds: unknown,
      };
    }
  }
  if (all === undefined && perService.size === 0) {
    return { ok: false, status: 400, error: 'services 为空，没有可写入的服务' };
  }

  const changes: ProjectDbIsolationChange[] = [];
  const unchanged: string[] = [];
  for (const profile of profiles) {
    const target = perService.get(profile.id) ?? (isDbScope(all) ? all : undefined);
    if (target === undefined) { unchanged.push(profile.id); continue; }
    // 生效档位已经等于目标就不算变更——「没写 = shared」与「写了 shared」对部署路径
    // 完全等价，不为了把 default 变成 explicit 而制造一条假变更。
    const from = effectiveDbScope(profile);
    if (from === target) { unchanged.push(profile.id); continue; }
    changes.push({ profileId: profile.id, from, to: target });
  }
  return { ok: true, changes, unchanged };
}

/** 被改的服务里，哪些分支会跟着变（没写覆盖）、哪些分支不受影响（写了覆盖）。 */
export function countAffectedBranches(
  branches: BranchEntry[],
  changes: ProjectDbIsolationChange[],
): { affectedBranches: number; keptBranchOverrides: number } {
  if (changes.length === 0) return { affectedBranches: 0, keptBranchOverrides: 0 };
  let affectedBranches = 0;
  let keptBranchOverrides = 0;
  for (const branch of branches) {
    const inherits = changes.some((c) => !branchDbScopeOverride(branch, c.profileId));
    const kept = changes.some((c) => !!branchDbScopeOverride(branch, c.profileId));
    if (inherits) affectedBranches += 1;
    if (kept) keptBranchOverrides += 1;
  }
  return { affectedBranches, keptBranchOverrides };
}

export interface ProjectDbIsolationDeps {
  stateService: StateService;
  assertProjectAccess: (req: any, projectId: string) => { status: number; body: unknown } | null;
}

export function createProjectDbIsolationRouter(deps: ProjectDbIsolationDeps): Router {
  const { stateService, assertProjectAccess } = deps;
  const router = Router();

  function loadView(projectId: string): { project: Project; view: ProjectDbIsolationView } | null {
    const project = stateService.getProject(projectId);
    if (!project) return null;
    const profiles = stateService.getBuildProfilesForProject(projectId);
    const branches = stateService.getBranchesForProject(projectId);
    return { project, view: buildProjectDbIsolationView(project, profiles, branches) };
  }

  router.get('/projects/:id/db-isolation', (req, res) => {
    const projectId = req.params.id;
    const denied = assertProjectAccess(req, projectId);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    const loaded = loadView(projectId);
    if (!loaded) { res.status(404).json({ error: `项目 "${projectId}" 不存在` }); return; }
    res.json(loaded.view);
  });

  router.put('/projects/:id/db-isolation', (req, res) => {
    const projectId = req.params.id;
    const denied = assertProjectAccess(req, projectId);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    const project = stateService.getProject(projectId);
    if (!project) { res.status(404).json({ error: `项目 "${projectId}" 不存在` }); return; }
    if (project.deliveryMode === 'managed') {
      res.status(409).json({ error: '托管交付项目的服务配置由 CDS 自动生成，数据库隔离档位不在这里修改' });
      return;
    }

    const profiles = stateService.getBuildProfilesForProject(projectId);
    const plan = planProjectDbIsolationWrite(profiles, req.body as ProjectDbIsolationWriteBody);
    if (!plan.ok) {
      res.status(plan.status).json({
        error: plan.error,
        ...(plan.unknownProfileIds ? { unknownProfileIds: plan.unknownProfileIds } : {}),
      });
      return;
    }

    const branches = stateService.getBranchesForProject(projectId);
    const { affectedBranches, keptBranchOverrides } = countAffectedBranches(branches, plan.changes);

    if (plan.changes.length === 0) {
      res.json({
        projectId,
        changes: [],
        unchanged: plan.unchanged,
        affectedBranches: 0,
        keptBranchOverrides: 0,
        message: '没有需要写入的变更',
        view: buildProjectDbIsolationView(project, profiles, branches),
      } satisfies ProjectDbIsolationWriteResult);
      return;
    }

    // 批量改底座是可回滚的破坏性写入：先拍配置快照，再一次性落盘。
    const snapshot = stateService.createConfigSnapshot({
      trigger: 'pre-destructive',
      label: `修改项目数据库隔离（${plan.changes.length} 个服务）`,
      projectId,
    });

    // 原子落盘：内存里逐个改，最后只 save 一次；save 抛错就把内存回滚到改动前，
    // 让「内存 = 磁盘」在失败时依然成立，不留下半份已改的状态。
    const before = new Map<string, DbScope | undefined>();
    for (const change of plan.changes) {
      const profile = stateService.getBuildProfile(change.profileId);
      before.set(change.profileId, profile?.dbScope);
    }
    try {
      for (const change of plan.changes) {
        stateService.updateBuildProfile(change.profileId, { dbScope: change.to });
      }
      stateService.save();
    } catch (err) {
      for (const [profileId, prev] of before) {
        try {
          const profile = stateService.getBuildProfile(profileId);
          if (!profile) continue;
          if (prev === undefined) delete profile.dbScope;
          else profile.dbScope = prev;
        } catch { /* 回滚尽力而为 */ }
      }
      res.status(500).json({ error: `保存失败，整批未写入：${(err as Error).message}` });
      return;
    }

    stateService.recordDestructiveOp({
      type: 'other',
      snapshotId: snapshot.id,
      summary: `项目 ${projectId} 数据库隔离：${plan.changes.map((c) => `${c.profileId} ${c.from}→${c.to}`).join('，')}`,
    });

    const nextProfiles = stateService.getBuildProfilesForProject(projectId);
    const parts = [`已更新 ${plan.changes.length} 个服务的数据库隔离`];
    parts.push(affectedBranches > 0
      ? `${affectedBranches} 个继承项目配置的分支重新部署后生效`
      : '当前没有继承项目配置的分支');
    if (keptBranchOverrides > 0) parts.push(`${keptBranchOverrides} 个分支的本分支覆盖保持不变`);
    res.json({
      projectId,
      changes: plan.changes,
      unchanged: plan.unchanged,
      affectedBranches,
      keptBranchOverrides,
      snapshotId: snapshot.id,
      message: `${parts.join('；')}。`,
      view: buildProjectDbIsolationView(project, nextProfiles, branches),
    } satisfies ProjectDbIsolationWriteResult);
  });

  return router;
}
