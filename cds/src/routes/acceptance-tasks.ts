import { Router, json, type Request, type Response } from 'express';
import { AcceptanceError, type AcceptanceTaskService } from '../services/acceptance-tasks.js';
import { assertProjectAccess } from './projects.js';

export interface AcceptanceTasksRouterDeps { service: AcceptanceTaskService }

type ScopedRequest = Request & Parameters<typeof assertProjectAccess>[0];

export function createAcceptanceTasksRouter({ service }: AcceptanceTasksRouterDeps): Router {
  const router = Router();
  router.use(json({ limit: '1mb' }));
  const handler = (fn: (req: ScopedRequest, res: Response) => unknown | Promise<unknown>) => async (req: Request, res: Response) => {
    try { await fn(req as ScopedRequest, res); }
    catch (error) {
      if (error instanceof AcceptanceError) res.status(error.status).json({ error: error.code, message: error.message });
      else res.status(500).json({ error: 'acceptance_unavailable', message: '验收服务未完成本次操作，请查看服务诊断后重试' });
    }
  };
  const access = (req: ScopedRequest, projectId: string) => {
    const denied = assertProjectAccess(req, projectId);
    if (denied) throw new AcceptanceError(denied.status, String(denied.body.error), String(denied.body.message));
  };
  const project = (req: ScopedRequest, supplied: unknown): string => {
    const id = supplied === undefined ? req.cdsProjectKey?.projectId : supplied;
    if (typeof id !== 'string' || !id.trim()) throw new AcceptanceError(400, 'project_required', '请选择项目或使用项目级凭证');
    access(req, id); return id;
  };
  const task = (req: ScopedRequest) => {
    const value = service.getTask(req.params.id); access(req, value.projectId); return value;
  };
  const numericVersion = (value: unknown): number | undefined => {
    if (value === undefined) return undefined;
    const version = Number(value);
    if (!Number.isSafeInteger(version) || version < 1) throw new AcceptanceError(400, 'invalid_version', '版本须为正整数');
    return version;
  };

  router.get('/health', handler((req, res) => { const health = service.health(project(req, req.query.projectId)); res.status(health.ok ? 200 : 503).json(health); }));
  router.get('/templates', handler((req, res) => { res.json({ templates: service.listTemplates(project(req, req.query.projectId)) }); }));
  router.post('/templates', handler(async (req, res) => {
    const projectId = project(req, req.body?.projectId);
    if (req.body?.templateId) { const template = service.getTemplate(req.body.templateId); access(req, template.projectId); }
    res.status(201).json({ template: await service.publishTemplate({ ...req.body, projectId }) });
  }));
  router.get('/templates/:id', handler((req, res) => {
    const template = service.getTemplate(req.params.id, numericVersion(req.query.version)); access(req, template.projectId); res.json({ template });
  }));
  router.get('/tasks', handler((req, res) => { res.json({ tasks: service.listTasks(project(req, req.query.projectId)) }); }));
  router.post('/tasks', handler(async (req, res) => {
    const projectId = project(req, req.body?.projectId);
    const templateVersion = numericVersion(req.body?.templateVersion);
    const template = service.getTemplate(req.body?.templateId, templateVersion); access(req, template.projectId);
    res.status(201).json({ task: await service.createTask({ ...req.body, projectId, templateVersion }) });
  }));
  router.get('/tasks/:id', handler((req, res) => { res.json({ task: task(req) }); }));
  router.post('/tasks/:id/claim', handler(async (req, res) => { task(req); res.json(await service.claim(req.params.id, req.body?.agentName)); }));
  router.post('/tasks/:id/heartbeat', handler(async (req, res) => { task(req); res.json({ task: await service.heartbeat(req.params.id, req.body?.leaseToken) }); }));
  router.post('/tasks/:id/release', handler(async (req, res) => { task(req); res.json({ task: await service.release(req.params.id, req.body?.leaseToken) }); }));
  router.post('/tasks/:id/results/:caseId', handler(async (req, res) => {
    task(req); res.json({ task: await service.submit(req.params.id, req.params.caseId, req.body?.leaseToken, req.body) });
  }));
  router.post('/tasks/:id/complete', handler(async (req, res) => { task(req); res.json({ task: await service.complete(req.params.id, req.body?.leaseToken) }); }));
  router.post('/tasks/:id/cancel', handler(async (req, res) => { task(req); res.json({ task: await service.cancel(req.params.id, req.body?.leaseToken) }); }));
  router.post('/tasks/:id/report', handler((req, res) => { const value = task(req); res.json({ task: value, report: service.reportSource(value.id) }); }));
  router.post('/tasks/:id/bind-report', handler(async (req, res) => {
    task(req); const value = await service.bindReport(req.params.id, req.body?.reportId); res.json({ task: value, report: value.report });
  }));
  router.get('/matrix', handler((req, res) => {
    const projectId = project(req, req.query.projectId);
    const templateId = typeof req.query.templateId === 'string' ? req.query.templateId : undefined;
    if (templateId) access(req, service.getTemplate(templateId).projectId);
    if (req.query.environment !== undefined && req.query.environment !== 'production' && req.query.environment !== 'cds') throw new AcceptanceError(400, 'invalid_environment', '请选择正式环境或 CDS');
    res.json(service.matrix(projectId, templateId, req.query.environment as 'production' | 'cds' | undefined));
  }));
  router.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    const status = (error as { status?: number })?.status;
    res.status(status === 413 ? 413 : 400).json({ error: 'invalid_body', message: status === 413 ? '验收清单超过请求容量，请减少单次用例或输入长度' : '请求正文无效，请检查结构化字段' });
  });
  return router;
}
