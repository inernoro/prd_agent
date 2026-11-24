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
import { classifyDbEnvKeys, dbInvolvementOf, type DbEnvKeyClassification, type DbInvolvement } from '../services/replica-db-clone.js';
import { effectiveDbInit, isDbInitMode, MONGO_CLONE_REFUSAL, type DbInitMode } from '../services/db-init-mode.js';

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
  /**
   * 分类器认出的全部库名变量（收敛 1）：白名单家族会被改写；框架家族（.NET 双下划线）与
   * 引擎中立家族（DB_NAME）只识别不改写，前端标「已识别，按项目约定不加后缀」。
   * 与复制集定位、库探测同一份分类器，三入口口径一致。
   */
  dbEnvKeyDetails: DbEnvKeyClassification[];
  /**
   * 涉不涉及数据库：db = 认得库名变量；unrecognized = 只有疑似变量（如 DATABASE_URL）但分类器认不出，
   * 需要用户补连接串或改 key 名；none = 什么数据库变量都没有（web / 静态服务），档位对它无意义，
   * 前端不许再把它当「缺库」提示。
   */
  dbInvolvement: DbInvolvement;
  /** involvement=unrecognized 时列出疑似变量名（只报 key，不报值） */
  suspectDbEnvKeys: string[];
  /** 只从项目级 env 灌下来、服务自己没声明的疑似变量（按不涉及数据库处理，但注明来源） */
  inheritedSuspectDbEnvKeys: string[];
  /** 有多少条分支对这个服务写了自己的覆盖（这些分支不受项目默认影响）。 */
  branchOverrideCount: number;
  /** 分支独立库初始化方式（收敛 4）：empty 空库重跑迁移（默认）/ clone 从共享库时间点克隆 */
  dbInit: DbInitMode;
  /** 能不能选时间点克隆：只有认出关系型库名变量（mysql / postgres）的服务可以 */
  dbInitSupported: boolean;
  dbInitUnsupportedReason?: string;
}

export interface ProjectDbIsolationBranchOverride {
  branchId: string;
  branch: string;
  /** profileId → 该分支自己钉住的档位 */
  overrides: Record<string, DbScope>;
}

export interface ProjectDbIsolationBranch {
  branchId: string;
  branch: string;
  status: string;
  /** 这条分支对本项目服务写过覆盖（与 branchOverrides 对应） */
  hasOverride: boolean;
}

export interface ProjectDbIsolationView {
  projectId: string;
  /** 托管交付项目的 profile 由 StackDetector 生成、只读，不允许在这里改。 */
  readOnly: boolean;
  readOnlyReason?: string;
  services: ProjectDbIsolationService[];
  branchOverrides: ProjectDbIsolationBranchOverride[];
  /** 项目下全部分支（供「各分支实测」逐条探测；探测本体走 GET /api/branches/:id/db-probe） */
  branches: ProjectDbIsolationBranch[];
  summary: {
    services: number;
    shared: number;
    perBranch: number;
    branches: number;
    /** 至少有一个服务写了分支覆盖的分支数 */
    branchesWithOverride: number;
    /** 不涉及数据库的服务数（shared / perBranch 只数涉及数据库的服务） */
    withoutDb: number;
  };
}

export interface ProjectDbIsolationWriteBody {
  /** 批量：项目内所有服务统一设为这一档。 */
  all?: unknown;
  /** 逐服务：profileId → 档位。与 all 同时给时，这里的条目优先。 */
  services?: unknown;
  /** 逐服务：profileId → 分支独立库初始化方式（收敛 4）。可单独提交，不必同时改档位。 */
  inits?: unknown;
}

export interface ProjectDbInitChange {
  profileId: string;
  from: DbInitMode;
  to: DbInitMode;
}

export interface ProjectDbIsolationChange {
  profileId: string;
  from: DbScope;
  to: DbScope;
}

export type ProjectDbIsolationPlan =
  | { ok: true; changes: ProjectDbIsolationChange[]; initChanges: ProjectDbInitChange[]; unchanged: string[] }
  | { ok: false; status: number; error: string; unknownProfileIds?: string[] };

export interface ProjectDbIsolationWriteResult {
  projectId: string;
  changes: ProjectDbIsolationChange[];
  /** 初始化方式的变更（收敛 4） */
  initChanges: ProjectDbInitChange[];
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
 * 这个服务能不能选「时间点克隆」：只有认出关系型库名变量（会被改写的 mysql / postgres key）才行；
 * mongo 走不了共享实例克隆，不涉及数据库或认不出库名的服务没有独立库可克隆。
 */
export function dbInitSupportOf(profile: Pick<BuildProfile, 'env'>, projectEnv: Record<string, string> = {}): { supported: boolean; reason?: string } {
  const mergedEnv = { ...projectEnv, ...(profile.env || {}) };
  const details = classifyDbEnvKeys(mergedEnv);
  const { involvement } = dbInvolvementOf(mergedEnv, new Set(Object.keys(profile.env || {})));
  if (involvement === 'none') return { supported: false, reason: '不涉及数据库，没有独立库可克隆' };
  if (involvement === 'unrecognized') return { supported: false, reason: '库名变量无法识别，先改成分类器认得的家族名再谈克隆' };
  if (details.length > 0 && details.every((k) => k.engine === 'mongo')) return { supported: false, reason: MONGO_CLONE_REFUSAL };
  const rewritten = details.filter((k) => k.rewritten && k.engine !== 'mongo');
  if (rewritten.length === 0) return { supported: false, reason: '库名变量不在改写白名单（只识别不加后缀），没有独立库可克隆' };
  return { supported: true };
}

/**
 * 纯函数：把项目 profiles + 分支列表折算成面板视图。
 * 只读，不依赖 StateService，便于单测与前端 mock 对齐。
 */
export function buildProjectDbIsolationView(
  project: Pick<Project, 'id' | 'deliveryMode'>,
  profiles: BuildProfile[],
  branches: BranchEntry[],
  /** 项目级 customEnv：库名变量常放在这里（灌给全部服务），定位时与 profile.env 合并，profile 优先 */
  projectEnv: Record<string, string> = {},
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
    // 与 resolveReplicaDbTarget 同口径：项目 customEnv → profile.env（分支层在项目视图里不存在）
    const mergedEnv = { ...projectEnv, ...(profile.env || {}) };
    const dbEnvKeyDetails = classifyDbEnvKeys(mergedEnv);
    const dbEnvKeys = dbEnvKeyDetails.filter((k) => k.rewritten).map((k) => k.key);
    const { involvement, suspects, inheritedSuspects } = dbInvolvementOf(mergedEnv, new Set(Object.keys(profile.env || {})));
    return {
      profileId: profile.id,
      name: profile.name || profile.id,
      dockerImage: profile.dockerImage || '',
      dbScope: effectiveDbScope(profile),
      dbScopeSource: isDbScope(profile.dbScope) ? 'explicit' : 'default',
      dbEnvKeys,
      dbEnvKeyDetails,
      dbInvolvement: involvement,
      suspectDbEnvKeys: suspects,
      inheritedSuspectDbEnvKeys: inheritedSuspects,
      branchOverrideCount: overrideCountByProfile.get(profile.id) || 0,
      dbInit: effectiveDbInit(profile),
      ...(() => { const sup = dbInitSupportOf(profile, projectEnv); return { dbInitSupported: sup.supported, ...(sup.reason ? { dbInitUnsupportedReason: sup.reason } : {}) }; })(),
    };
  });

  const readOnly = project.deliveryMode === 'managed';
  return {
    projectId: project.id,
    readOnly,
    ...(readOnly ? { readOnlyReason: '托管交付项目的服务配置由 CDS 自动生成，数据库隔离档位不在这里修改' } : {}),
    services,
    branchOverrides,
    branches: branches.map((b) => ({
      branchId: b.id, branch: b.branch, status: b.status,
      hasOverride: branchOverrides.some((o) => o.branchId === b.id),
    })),
    summary: {
      services: services.length,
      // 只数涉及数据库的服务：web / 静态服务的档位没有意义，不该进「N 个服务共享库」的判断句
      shared: services.filter((s) => s.dbInvolvement !== 'none' && s.dbScope === 'shared').length,
      perBranch: services.filter((s) => s.dbInvolvement !== 'none' && s.dbScope === 'per-branch').length,
      withoutDb: services.filter((s) => s.dbInvolvement === 'none').length,
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
  projectEnv: Record<string, string> = {},
): ProjectDbIsolationPlan {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, error: '请求体必须是对象，且至少提供 all、services、inits 之一' };
  }
  const { all, services, inits } = body;
  if (all === undefined && services === undefined && inits === undefined) {
    return { ok: false, status: 400, error: '至少提供 all（批量）、services（逐服务档位）或 inits（逐服务初始化方式）之一' };
  }
  // 初始化方式（收敛 4）：与档位同一套「全量校验先行、整批拒绝」
  const initChanges: ProjectDbInitChange[] = [];
  if (inits !== undefined) {
    if (!inits || typeof inits !== 'object' || Array.isArray(inits)) {
      return { ok: false, status: 400, error: "inits 必须是 { profileId: 'empty' | 'clone' } 形状的对象" };
    }
    const known = new Map(profiles.map((p) => [p.id, p]));
    const unknown: string[] = [];
    for (const [profileId, value] of Object.entries(inits as Record<string, unknown>)) {
      const profile = known.get(profileId);
      if (!profile) { unknown.push(profileId); continue; }
      if (!isDbInitMode(value)) {
        return { ok: false, status: 400, error: `服务 "${profileId}" 的初始化方式非法（仅允许 'empty' 或 'clone'）` };
      }
      if (value === 'clone') {
        const sup = dbInitSupportOf(profile, projectEnv);
        if (!sup.supported) return { ok: false, status: 400, error: `服务 "${profileId}" 不支持时间点克隆：${sup.reason}（整批未写入）` };
      }
      const from = effectiveDbInit(profile);
      if (from !== value) initChanges.push({ profileId, from, to: value });
    }
    if (unknown.length > 0) {
      return { ok: false, status: 400, error: `以下服务不属于本项目：${unknown.join(', ')}（整批未写入）`, unknownProfileIds: unknown };
    }
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
  if (all === undefined && perService.size === 0 && inits === undefined) {
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
  return { ok: true, changes, initChanges, unchanged };
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
    return { project, view: buildProjectDbIsolationView(project, profiles, branches, stateService.getCustomEnv(project.id) || {}) };
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
    const plan = planProjectDbIsolationWrite(profiles, req.body as ProjectDbIsolationWriteBody, stateService.getCustomEnv(project.id) || {});
    if (!plan.ok) {
      res.status(plan.status).json({
        error: plan.error,
        ...(plan.unknownProfileIds ? { unknownProfileIds: plan.unknownProfileIds } : {}),
      });
      return;
    }

    const branches = stateService.getBranchesForProject(projectId);
    const { affectedBranches, keptBranchOverrides } = countAffectedBranches(branches, plan.changes);

    if (plan.changes.length === 0 && plan.initChanges.length === 0) {
      res.json({
        projectId,
        changes: [],
        initChanges: [],
        unchanged: plan.unchanged,
        affectedBranches: 0,
        keptBranchOverrides: 0,
        message: '没有需要写入的变更',
        view: buildProjectDbIsolationView(project, profiles, branches, stateService.getCustomEnv(project.id) || {}),
      } satisfies ProjectDbIsolationWriteResult);
      return;
    }

    // 批量改底座是可回滚的破坏性写入：先拍配置快照，再一次性落盘。
    const snapshot = stateService.createConfigSnapshot({
      trigger: 'pre-destructive',
      label: `修改项目数据库隔离（${plan.changes.length + plan.initChanges.length} 个服务）`,
      projectId,
    });

    // 原子落盘：内存里逐个改，最后只 save 一次；save 抛错就把内存回滚到改动前，
    // 让「内存 = 磁盘」在失败时依然成立，不留下半份已改的状态。
    const before = new Map<string, DbScope | undefined>();
    for (const change of plan.changes) {
      const profile = stateService.getBuildProfile(change.profileId);
      before.set(change.profileId, profile?.dbScope);
    }
    const beforeInit = new Map<string, BuildProfile['dbInit']>();
    for (const change of plan.initChanges) {
      const profile = stateService.getBuildProfile(change.profileId);
      beforeInit.set(change.profileId, profile?.dbInit);
    }
    try {
      for (const change of plan.changes) {
        stateService.updateBuildProfile(change.profileId, { dbScope: change.to });
      }
      for (const change of plan.initChanges) {
        stateService.updateBuildProfile(change.profileId, { dbInit: change.to });
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
      for (const [profileId, prev] of beforeInit) {
        try {
          const profile = stateService.getBuildProfile(profileId);
          if (!profile) continue;
          if (prev === undefined) delete profile.dbInit;
          else profile.dbInit = prev;
        } catch { /* 回滚尽力而为 */ }
      }
      res.status(500).json({ error: `保存失败，整批未写入：${(err as Error).message}` });
      return;
    }

    stateService.recordDestructiveOp({
      type: 'other',
      snapshotId: snapshot.id,
      summary: `项目 ${projectId} 数据库隔离：${[
        ...plan.changes.map((c) => `${c.profileId} ${c.from}→${c.to}`),
        ...plan.initChanges.map((c) => `${c.profileId} 初始化 ${c.from}→${c.to}`),
      ].join('，')}`,
    });

    const nextProfiles = stateService.getBuildProfilesForProject(projectId);
    const parts: string[] = [];
    if (plan.changes.length > 0) parts.push(`已更新 ${plan.changes.length} 个服务的数据库隔离`);
    if (plan.initChanges.length > 0) parts.push(`已更新 ${plan.initChanges.length} 个服务的独立库初始化方式（对还没建库的分支首次部署时生效）`);
    if (plan.changes.length > 0) {
      parts.push(affectedBranches > 0
        ? `${affectedBranches} 个继承项目配置的分支重新部署后生效`
        : '当前没有继承项目配置的分支');
    }
    if (keptBranchOverrides > 0) parts.push(`${keptBranchOverrides} 个分支的本分支覆盖保持不变`);
    res.json({
      projectId,
      changes: plan.changes,
      initChanges: plan.initChanges,
      unchanged: plan.unchanged,
      affectedBranches,
      keptBranchOverrides,
      snapshotId: snapshot.id,
      message: `${parts.join('；')}。`,
      view: buildProjectDbIsolationView(project, nextProfiles, branches, stateService.getCustomEnv(project.id) || {}),
    } satisfies ProjectDbIsolationWriteResult);
  });

  return router;
}
