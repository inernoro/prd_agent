import { Router, type Request, type Response } from 'express';
import type { DtsService } from '../services/dts.js';
import { DtsError, dtsReject, dtsText } from '../services/dts-policy.js';
import type { DtsActor, DtsMode } from '../shared/dts.js';
import type { StateService } from '../services/state.js';
import { assertProjectAccess } from './projects.js';
import { canHumanAccessProject } from '../services/human-project-access.js';
import { isHumanSystemOwner } from '../services/human-auth.js';

export function createDtsRouter(input: { service: DtsService; state: StateService; actor: (req: Request) => DtsActor }): Router {
  const router = Router(); const { service, state } = input;
  const project = (req: Request): string => {
    const stamp = req as Request & { cdsProjectKey?: { projectId: string } };
    const id = dtsText(req.body?.projectId ?? req.query.projectId ?? stamp.cdsProjectKey?.projectId, '所属项目');
    const denied = assertProjectAccess(req as never, id);
    if (!state.getProject(id) || denied || !canHumanAccessProject(req, state, id)) dtsReject('project_forbidden', '该项目不存在或当前身份无权访问', 403);
    return id;
  };
  const owner = (req: Request) => {
    if (!isHumanSystemOwner(req) && input.actor(req).kind !== 'static') dtsReject('owner_required', '数据服务连接需由系统所有者管理，请联系管理员', 403);
  };
  const writer = (req: Request) => {
    // Project credentials operate only on connections already approved by the owner.
    const actor = input.actor(req);
    if (!isHumanSystemOwner(req) && actor.kind !== 'static' && actor.kind !== 'project-key' && actor.kind !== 'principal') dtsReject('writer_required', '当前身份没有同步执行权限，请使用已批准的项目凭据', 403);
    return actor;
  };
  const handler = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => {
    res.locals.cdsSuppressRequestBodyLog = true;
    void fn(req, res).catch(e => {
      const error = e instanceof DtsError ? e : new DtsError(503, 'dts_unavailable', '数据同步服务暂时不可用，请稍后重试');
      res.status(error.status).json({ error: error.code, message: error.message });
    });
  };
  router.get('/dts/capabilities', handler(async (req, res) => {
    const id = project(req), actor = input.actor(req);
    const configureAllowed = isHumanSystemOwner(req) || actor.kind === 'static';
    return res.json({ ...await service.capabilities(id), configureAllowed,
      executeAllowed: configureAllowed || actor.kind === 'project-key' || actor.kind === 'principal' });
  }));
  router.get('/dts/connections', handler(async (req, res) => res.json({ connections: await service.connections(project(req)) })));
  router.post('/dts/connections', handler(async (req, res) => { owner(req); return res.status(201).json({ connection: await service.addConnection(project(req), req.body) }); }));
  router.put('/dts/engine', handler(async (req, res) => { owner(req); return res.json(await service.configureEngine(project(req), req.body)); }));
  router.post('/dts/plans', handler(async (req, res) => res.status(201).json({ plan: await service.plan(project(req),
    dtsText(req.body.sourceId, '源连接'), dtsText(req.body.targetId, '目标连接'), req.body.mode as DtsMode, writer(req)) })));
  router.post('/dts/runs', handler(async (req, res) => res.status(202).json({ run: service.publicRun(await service.start(project(req),
    dtsText(req.body.planId, '差异计划'), dtsText(req.body.idempotencyKey, '操作编号', 120), writer(req))) })));
  router.get('/dts/runs', handler(async (req, res) => res.json({ runs: (await service.runs(project(req))).map(r => service.publicRun(r)) })));
  router.get('/dts/runs/:id', handler(async (req, res) => res.json({ run: service.publicRun(await service.refresh(project(req), req.params.id)) })));
  for (const action of ['pause', 'resume', 'cancel'] as const) router.post(`/dts/runs/:id/${action}`, handler(async (req, res) => res.json({
    run: service.publicRun(await service.control(project(req), req.params.id, action, writer(req))),
  })));
  router.get('/dts/policies', handler(async (req, res) => res.json({ policies: (await service.policies(project(req))).map(p => service.publicPolicy(p)) })));
  router.post('/dts/policies', handler(async (req, res) => res.status(201).json({ policy: service.publicPolicy(await service.addPolicy(project(req), {
    sourceId: dtsText(req.body.sourceId, '源连接'), targetId: dtsText(req.body.targetId, '目标连接'),
  }, writer(req))) })));
  router.patch('/dts/policies/:id', handler(async (req, res) => {
    if (typeof req.body.enabled !== 'boolean') dtsReject('invalid_input', '请选择是否启用账号同步');
    return res.json({ policy: service.publicPolicy(await service.setPolicy(project(req), req.params.id, req.body.enabled, writer(req))) });
  }));
  return router;
}
