import { Router } from 'express';
import type { StateService } from '../services/state.js';
import { InfraCredentialRotationService, RotationStepError, publicRotationRecord } from '../services/infra-credential-rotation.js';
import { isPreviewInstance } from '../services/preview-instance.js';
import { assertNotMachineAgentKey } from './projects.js';

export interface InfraCredentialRotationRouterDeps {
  stateService: StateService;
  rotationService: InfraCredentialRotationService;
  assertProjectAccess: (req: unknown, projectId: string) => { status: number; body: unknown } | null;
}

export function createInfraCredentialRotationRouter(deps: InfraCredentialRotationRouterDeps): Router {
  const router = Router();

  router.get('/projects/:projectId/infra/:serviceId/credential-rotation', (req, res) => {
    const mismatch = deps.assertProjectAccess(req, req.params.projectId);
    if (mismatch) { res.status(mismatch.status).json(mismatch.body); return; }
    const service = deps.stateService.getInfraServiceForProjectAndId(req.params.projectId, req.params.serviceId);
    if (!service) { res.status(404).json({ error: 'rotation.service_not_found' }); return; }
    res.json({ rotation: service.credentialRotation ? publicRotationRecord(service.credentialRotation) : null });
  });

  router.post('/projects/:projectId/infra/:serviceId/credential-rotation', async (req, res) => {
    if (isPreviewInstance()) {
      res.status(403).json({ error: 'preview_instance', message: 'CDS 预览实例没有真实基础设施，不能执行凭据轮换。' });
      return;
    }
    const mismatch = deps.assertProjectAccess(req, req.params.projectId);
    if (mismatch) { res.status(mismatch.status).json(mismatch.body); return; }
    const machineKey = assertNotMachineAgentKey(req as unknown as { cdsProjectKey?: unknown; cdsAccess?: unknown });
    if (machineKey) { res.status(machineKey.status).json(machineKey.body); return; }
    if (String(req.headers['x-cds-confirm-service'] || '') !== req.params.serviceId) {
      res.status(400).json({
        error: 'rotation.confirmation_required',
        message: '这是会撤销旧数据库凭据的操作，请用 X-CDS-Confirm-Service 逐字确认目标服务。',
      });
      return;
    }
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    try {
      const rotation = await deps.rotationService.execute(req.params.projectId, req.params.serviceId, idempotencyKey);
      res.json({ ok: true, rotation });
    } catch (error) {
      const code = error instanceof RotationStepError ? error.code : 'rotation.failed';
      const status = code === 'rotation.service_not_found' ? 404
        : code.includes('idempotency') || code.includes('runtime_unsupported') ? 400
          : code.includes('incomplete') ? 409
            : 503;
      res.status(status).json({
        error: code,
        message: code === 'rotation.failed'
          ? '凭据轮换失败，系统已尝试回滚。请查看轮换状态中的 failureCode 与 rollback。'
          : '凭据轮换未完成，请查看轮换状态中的安全错误码与回滚结果。',
      });
    }
  });

  return router;
}
