import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Router, type Request } from 'express';
import type { ManagedProjectSpec, ProjectDeliveryMode } from '../types.js';
import type { ManagedProjectService } from '../services/managed-project.js';
import type { StateService } from '../services/state.js';

export function createManagedProjectsRouter(deps: {
  stateService: StateService;
  managedProjectService: ManagedProjectService;
  assertProjectAccess: (req: Request, projectId: string) => { status: number; body: unknown } | null;
}): Router {
  const router = Router();

  router.get('/projects/:id/delivery', (req, res) => {
    const project = deps.stateService.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }
    const access = deps.assertProjectAccess(req, project.id);
    if (access) { res.status(access.status).json(access.body); return; }
    const branches = deps.stateService.getBranchesForProject(project.id);
    const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : '';
    const sourceBranch = branchId ? branches.find(branch => branch.id === branchId) : undefined;
    const sourceCommit = sourceBranch ? repositoryHead(sourceBranch.worktreePath) : null;
    res.json({
      revision: deliveryRevision(project, sourceBranch, sourceCommit),
      projectRevision: deliveryRevision(project),
      planBranches: branches.map(branch => ({ id: branch.id, branch: branch.branch })),
      generationSource: sourceBranch ? { branchId: sourceBranch.id, branch: sourceBranch.branch, commitSha: sourceCommit } : null,
      projectId: project.id,
      mode: project.deliveryMode || 'compose',
      managedSpec: project.managedSpec || { apps: [], capabilities: [] },
      effectiveProfiles: project.deliveryMode === 'managed' ? project.managedProfiles || [] : [],
      planUpdatedAt: project.managedPlanUpdatedAt,
    });
  });

  router.put('/projects/:id/delivery', (req, res) => {
    const project = deps.stateService.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }
    const access = deps.assertProjectAccess(req, project.id);
    if (access) { res.status(access.status).json(access.body); return; }
    const mode = req.body?.mode as ProjectDeliveryMode;
    if (mode !== 'managed' && mode !== 'compose') {
      res.status(400).json({ error: 'mode 必须是 managed 或 compose' });
      return;
    }
    let managedSpec: ManagedProjectSpec | undefined;
    if (mode === 'managed') {
      try {
        managedSpec = sanitizeManagedSpec(req.body?.managedSpec);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
    }
    if (req.body?.generatePlan === true) {
      const branchId = typeof req.body.branchId === 'string' ? req.body.branchId : '';
      const candidateBranch = mode === 'managed' ? deps.stateService.getBranch(branchId) : undefined;
      const branch = candidateBranch && (candidateBranch.projectId || 'default') === project.id ? candidateBranch : undefined;
      const sourceCommit = branch ? repositoryHead(branch.worktreePath) : null;
      if (!req.body.expectedRevision) { res.status(428).json({ error: '请先读取当前项目配置后再保存' }); return; }
      if (mode === 'managed' && (!branch || (branch.projectId || 'default') !== project.id || !sourceCommit)) {
        res.status(409).json({ error: '生成依据不属于当前项目，或工作区版本未确认、存在未提交文件。请同步分支并提交或还原变更后重试' }); return;
      }
      const revision = deliveryRevision(project, mode === 'managed' ? branch : undefined, mode === 'managed' ? sourceCommit : null);
      if (req.body.expectedRevision !== revision) { res.status(409).json({ error: '项目配置或生成依据已变化，请重新读取并核对后保存' }); return; }
      let plan: ReturnType<ManagedProjectService['planForProject']> | null;
      try {
        const candidate = { ...project, deliveryMode: mode, managedSpec };
        plan = mode === 'managed' && branch ? deps.managedProjectService.planForProject(candidate, branch, sourceCommit || undefined) : null;
      } catch (err) {
        res.status(422).json({ error: '配置生成失败，原配置保持不变', message: (err as Error).message });
        return;
      }
      const current = deps.stateService.getProject(project.id);
      const currentBranch = mode === 'managed' ? deps.stateService.getBranch(branchId) : undefined;
      const currentCommit = currentBranch ? repositoryHead(currentBranch.worktreePath) : null;
      if (!current || deliveryRevision(current, currentBranch, currentCommit) !== revision) {
        res.status(409).json({ error: '计算期间项目配置或仓库版本已变化，本次未写入，请重新读取核对' }); return;
      }
      // 复核与唯一状态写入之间没有异步窗口。写入阶段异常不能冒充纯计算拒绝。
      try {
        deps.stateService.updateProject(project.id, {
          deliveryMode: mode,
          managedSpec,
          managedProfiles: plan?.profiles,
          managedPlanUpdatedAt: plan?.generatedAt,
        });
      } catch {
        res.status(500).json({ error: '配置写入阶段未能确认保存结果，请重新读取核对，勿重复提交' });
        return;
      }
      res.json({ projectId: project.id, mode, managedSpec: managedSpec || null, plan });
      return;
    }
    deps.stateService.updateProject(project.id, {
      deliveryMode: mode,
      managedSpec,
      managedProfiles: undefined,
      managedPlanUpdatedAt: undefined,
    });
    res.json({ projectId: project.id, mode, managedSpec: managedSpec || null });
  });

  router.post('/projects/:id/managed-plan', (req, res) => {
    const project = deps.stateService.getProject(req.params.id);
    if (!project) { res.status(404).json({ error: '项目不存在' }); return; }
    const access = deps.assertProjectAccess(req, project.id);
    if (access) { res.status(access.status).json(access.body); return; }
    if (project.deliveryMode !== 'managed') {
      res.status(409).json({ error: '项目当前不是 managed 模式' });
      return;
    }
    const branchId = typeof req.body?.branchId === 'string' ? req.body.branchId.trim() : '';
    const branch = branchId
      ? deps.stateService.getBranch(branchId)
      : deps.stateService.getBranchesForProject(project.id)[0];
    if (!branch || (branch.projectId || 'default') !== project.id) {
      res.status(404).json({ error: '没有可用于生成计划的项目分支' });
      return;
    }
    try {
      const plan = deps.managedProjectService.ensurePlanForBranch(branch);
      res.json({ plan });
    } catch (err) {
      res.status(422).json({ error: 'managed_plan_invalid', message: (err as Error).message });
    }
  });

  return router;
}

function sanitizeManagedSpec(input: unknown): ManagedProjectSpec {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const apps = Array.isArray(raw.apps) ? raw.apps : [];
  const capabilities = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  return {
    apps: apps.map((item, index) => {
      const app = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const id = cleanId(app.id, `apps[${index}].id`);
      const appPath = cleanString(app.appPath, `apps[${index}].appPath`);
      const workload = app.workload;
      if (workload !== 'web' && workload !== 'api' && workload !== 'worker') {
        throw new Error(`apps[${index}].workload 必须是 web、api 或 worker`);
      }
      const health = sanitizeHealth(app.health, index);
      return {
        id,
        name: optionalString(app.name),
        appPath,
        workload,
        dockerImage: optionalString(app.dockerImage),
        installCommand: optionalString(app.installCommand),
        buildCommand: optionalString(app.buildCommand),
        startCommand: optionalString(app.startCommand),
        containerPort: Number.isInteger(app.containerPort) && Number(app.containerPort) > 0 ? Number(app.containerPort) : undefined,
        health,
        capabilityIds: Array.isArray(app.capabilityIds) ? app.capabilityIds.map((value) => cleanId(value, 'capabilityId')) : undefined,
      };
    }),
    capabilities: capabilities.map((item, index) => {
      const capability = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const kind = capability.kind;
      if (!['database', 'cache', 'assets', 'identity', 'secrets'].includes(String(kind))) {
        throw new Error(`capabilities[${index}].kind 非法`);
      }
      return {
        id: cleanId(capability.id, `capabilities[${index}].id`),
        kind: kind as 'database' | 'cache' | 'assets' | 'identity' | 'secrets',
        bindingId: cleanId(capability.bindingId, `capabilities[${index}].bindingId`),
        envKeys: Array.isArray(capability.envKeys)
          ? capability.envKeys.map((value) => cleanEnvKey(value, `capabilities[${index}].envKeys`))
          : undefined,
      };
    }),
  };
}

function sanitizeHealth(value: unknown, index: number): { type: 'http'; path: string } | { type: 'tcp' } | undefined {
  if (value === undefined || value === null) return undefined;
  const health = typeof value === 'object' ? value as Record<string, unknown> : {};
  if (health.type === 'tcp') return { type: 'tcp' };
  if (health.type === 'http') {
    const healthPath = cleanString(health.path, `apps[${index}].health.path`);
    if (!healthPath.startsWith('/')) throw new Error(`apps[${index}].health.path 必须以 / 开头`);
    return { type: 'http', path: healthPath };
  }
  throw new Error(`apps[${index}].health.type 必须是 http 或 tcp`);
}

function cleanId(value: unknown, field: string): string {
  const result = cleanString(value, field);
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(result)) throw new Error(`${field} 格式非法`);
  return result;
}

function cleanEnvKey(value: unknown, field: string): string {
  const result = cleanString(value, field);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(result)) throw new Error(`${field} 必须是大写环境变量名`);
  return result;
}

function cleanString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必填`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** 本地只读获取版本，不触发拉取、构建、部署或外部服务。 */
function repositoryHead(worktreePath: string): string | null {
  try {
    const options = { encoding: 'utf8' as const, timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'] };
    if (execFileSync('git', ['-C', worktreePath, 'status', '--porcelain', '--untracked-files=normal'], options).trim()) return null;
    return execFileSync('git', ['-C', worktreePath, 'rev-parse', '--verify', 'HEAD'], options).trim() || null;
  }
  catch { return null; }
}

function deliveryRevision(project: import('../types.js').Project, branch?: import('../types.js').BranchEntry, sourceCommit: string | null = null): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    id: project.id, updatedAt: project.updatedAt, identity: { slug: project.slug, name: project.name, aliasName: project.aliasName, history: project.identityHistory }, gitRepoUrl: project.gitRepoUrl,
    mode: project.deliveryMode, spec: project.managedSpec, planUpdatedAt: project.managedPlanUpdatedAt,
    branch: branch ? { id: branch.id, projectId: branch.projectId, path: branch.worktreePath, sha: branch.githubCommitSha, lastPullAt: branch.lastPullAt, sourceCommit } : null,
  })).digest('hex');
}
