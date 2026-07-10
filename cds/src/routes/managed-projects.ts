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
    res.json({
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
