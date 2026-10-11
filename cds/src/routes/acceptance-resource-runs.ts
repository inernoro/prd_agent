import { Router, json, type Request, type Response, type NextFunction } from 'express';
import type { StateService } from '../services/state.js';
import { AcceptanceResourceRunService, type AcceptanceResourceReleaseBindings } from '../services/acceptance-resource-run.js';
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
  ['acceptance_creation_profile_invalid', 400], ['acceptance_creation_unavailable', 503],
  ...['acceptance_creation_scope', 'acceptance_creation_profile_collision', 'acceptance_creation_changed', 'acceptance_creation_busy', 'acceptance_creation_cancelled',
    'acceptance_creation_intent_changed', 'acceptance_creation_reconciliation_required'].map(code => [code, 409] as [string, number]),
  ['acceptance_release_unavailable', 503], ['acceptance_release_busy', 409], ['acceptance_release_cancelled', 409],
  ...['acceptance_release_scope', 'acceptance_release_branch_changed', 'acceptance_release_resource_changed',
    'container_release_scope', 'container_drift', 'container_stop_unconfirmed', 'container_remove_unconfirmed',
    'container_identity', 'container_owner', 'container_missing', 'container_inspect', 'container_stop', 'container_remove',
    'container_absence_unconfirmed'].map(code => [code, 409] as [string, number]),
]);
function failure(res: Response, error: unknown): void {
  const code = error instanceof Error ? error.message.split(':', 1)[0] : '';
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

/** Authenticated server mount; physical release requires the real shared execution bindings. */
export function createAcceptanceResourceRunsRouter(deps: { stateService: StateService; release?: AcceptanceResourceReleaseBindings }): Router {
  const router = Router();
  const service = new AcceptanceResourceRunService(deps.stateService, undefined, undefined, deps.release);
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
  router.post('/acceptance-resource-runs/:id/create-profile', json({ limit: '16kb' }), async (req, res) => {
    const id = req.params.id, run = RUN_ID.test(id) ? service.get(id) : undefined;
    if (!run) { res.status(404).json({ error: 'acceptance_run_not_found' }); return; }
    if (deny(req, res, run.projectId)) return;
    try { res.status(201).json({ run: await service.createProfile(id, field(req, 'ownerToken'), req.body?.profile) }); }
    catch (error) { failure(res, error); }
  });
  router.get('/acceptance-resource-runs/:id', (req, res) => {
    const id = req.params.id;
    const run = RUN_ID.test(id) ? service.get(id) : undefined;
    if (!run) { res.status(404).json({ error: 'acceptance_run_not_found' }); return; }
    if (deny(req, res, run.projectId)) return;
    res.json({ run });
  });
  for (const action of ['register', 'finish', 'cleanup-evidence', 'release'] as const) {
    router.post(`/acceptance-resource-runs/:id/${action}`, json({ limit: '2kb' }), async (req, res) => {
      const id = req.params.id;
      const run = RUN_ID.test(id) ? service.get(id) : undefined;
      if (!run) { res.status(404).json({ error: 'acceptance_run_not_found' }); return; }
      if (deny(req, res, run.projectId)) return;
      try {
        const ownerToken = field(req, 'ownerToken');
        if (action === 'cleanup-evidence') res.json(await service.requireCleanupEvidence(id, ownerToken));
        else if (action === 'release') res.json({ run: await service.release(id, ownerToken) });
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
