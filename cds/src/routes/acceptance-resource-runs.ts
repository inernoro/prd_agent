import { Router, json, type Request, type Response, type NextFunction } from 'express';
import type { StateService } from '../services/state.js';
import { AcceptanceResourceRunService } from '../services/acceptance-resource-run.js';
import { assertProjectAccess } from './projects.js';

const RUN_ID = /^ar_[a-f0-9]{32}$/;
const ERRORS = new Map<string, number>([
  ['acceptance_scope_invalid', 400], ['acceptance_scope_mismatch', 409],
  ['acceptance_owner_required', 403], ['acceptance_branch_changed', 409],
  ['acceptance_resource_already_exists', 409], ['acceptance_resource_owned', 409],
  ['acceptance_resource_unconfirmed', 409], ['acceptance_resource_changed', 409],
  ['acceptance_run_recovery_required', 409], ['acceptance_run_conflict', 409],
  ['acceptance_run_stage', 409], ['acceptance_run_busy', 409],
  ['acceptance_run_capacity', 429], ['acceptance_operation_capacity', 429],
  ['acceptance_report_capacity', 429], ['acceptance_report_pending', 409],
  ['acceptance_report_timeout', 504], ['acceptance_report_mismatch', 409],
  ['acceptance_report_unreadable', 409], ['acceptance_report_changed', 409],
  ['acceptance_terminal_receipt_required', 409],
]);
function failure(res: Response, error: unknown): void {
  const code = error instanceof Error ? error.message : '';
  const status = ERRORS.get(code);
  res.status(status ?? 500).json({ error: status ? code : 'internal' });
}
function field(req: Request, key: string): string {
  const value = req.body?.[key];
  return typeof value === 'string' && value.length <= 128 ? value : '';
}
function deny(req: Request, res: Response, projectId: string): boolean {
  const denied = assertProjectAccess(req as unknown as Parameters<typeof assertProjectAccess>[0], projectId);
  if (denied) res.status(denied.status).json(denied.body);
  return Boolean(denied);
}

/** Authenticated server mount only. Receipt evidence never executes a Docker/Profile cleanup. */
export function createAcceptanceResourceRunsRouter(deps: { stateService: StateService }): Router {
  const router = Router();
  const service = new AcceptanceResourceRunService(deps.stateService);
  router.use('/acceptance-resource-runs', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.post('/acceptance-resource-runs', json({ limit: '2kb' }), async (req, res) => {
    const projectId = field(req, 'projectId');
    if (!projectId) { res.status(400).json({ error: 'acceptance_scope_invalid' }); return; }
    if (deny(req, res, projectId)) return;
    if (!deps.stateService.getProject(projectId)) { res.status(404).json({ error: 'project_not_found' }); return; }
    try {
      const owner = await service.begin({ projectId, branchId: field(req, 'branchId'), targetSha: field(req, 'targetSha'),
        isolationRunId: field(req, 'isolationRunId'), profileId: field(req, 'profileId') });
      res.status(201).json(owner);
    } catch (error) { failure(res, error); }
  });
  router.get('/acceptance-resource-runs/:id', (req, res) => {
    const id = req.params.id;
    const run = RUN_ID.test(id) ? service.get(id) : undefined;
    if (!run) { res.status(404).json({ error: 'acceptance_run_not_found' }); return; }
    if (deny(req, res, run.projectId)) return;
    res.json({ run });
  });
  for (const action of ['register', 'finish', 'cleanup-evidence'] as const) {
    router.post(`/acceptance-resource-runs/:id/${action}`, json({ limit: '2kb' }), async (req, res) => {
      const id = req.params.id;
      const run = RUN_ID.test(id) ? service.get(id) : undefined;
      if (!run) { res.status(404).json({ error: 'acceptance_run_not_found' }); return; }
      if (deny(req, res, run.projectId)) return;
      try {
        const ownerToken = field(req, 'ownerToken');
        if (action === 'cleanup-evidence') res.json(await service.requireCleanupEvidence(id, ownerToken));
        else res.json({ run: action === 'register' ? await service.register(id, ownerToken) : await service.finish(id, ownerToken, field(req, 'reportId')) });
      } catch (error) { failure(res, error); }
    });
  }
  router.use('/acceptance-resource-runs', (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (error as { type?: unknown } | undefined)?.type;
    if (type === 'entity.too.large') res.status(413).json({ error: 'acceptance_payload_too_large' });
    else if (type === 'entity.parse.failed') res.status(400).json({ error: 'acceptance_payload_invalid' });
    else failure(res, error);
  });
  return router;
}
