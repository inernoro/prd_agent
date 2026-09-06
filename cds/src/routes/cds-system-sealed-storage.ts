import { Router, type Request, type Response } from 'express';

import type { ServerEventLogSink } from '../services/server-event-log-store.js';
import {
  describeSealedStorage,
  initializeSealedStorage,
  SealedStorageBootstrapError,
} from '../services/sealed-storage-bootstrap.js';

export interface CdsSystemSealedStorageRouterDeps {
  authMode: string;
  env?: NodeJS.ProcessEnv;
  envFilePath?: () => string;
  randomBytes?: (size: number) => Buffer;
  audit?: ServerEventLogSink | null;
}

export function isGlobalHumanAdminRequest(
  req: Request,
  deps: Pick<CdsSystemSealedStorageRouterDeps, 'authMode'>,
): boolean {
  if (deps.authMode === 'basic') {
    return Boolean((req as Request & { _cdsBasicHumanAuth?: boolean })._cdsBasicHumanAuth);
  }
  if (deps.authMode !== 'github') return false;
  const request = req as typeof req & {
    cdsUser?: { isSystemOwner?: boolean; authProvider?: string };
    cdsSession?: unknown;
  };
  return Boolean(
    request.cdsSession
    && request.cdsUser?.isSystemOwner === true
    && request.cdsUser.authProvider !== 'sso',
  );
}

function hasRequestInput(req: Request): boolean {
  if (Object.keys(req.query || {}).length > 0) return true;
  if (Number(req.headers['content-length'] || 0) > 0) return true;
  if (req.headers['transfer-encoding']) return true;
  const body = req.body;
  if (body == null) return false;
  if (typeof body === 'object') return Object.keys(body as Record<string, unknown>).length > 0;
  return String(body).length > 0;
}

export function createCdsSystemSealedStorageRouter(
  deps: CdsSystemSealedStorageRouterDeps,
): Router {
  const router = Router();

  // This endpoint never accepts client-provided key material. Mark the body
  // as non-loggable before auth runs, so even a rejected machine request
  // cannot place an arbitrary canary in HTTP or activity logs.
  router.use('/cds-system/sealed-storage', (req, res, next) => {
    (res.locals as { cdsSuppressRequestBodyLog?: boolean }).cdsSuppressRequestBodyLog = true;
    (res.locals as { cdsSuppressRequestDetails?: boolean }).cdsSuppressRequestDetails = true;
    (res.locals as { cdsSuppressActivity?: boolean }).cdsSuppressActivity = true;
    next();
  });

  const requireHumanAdmin = (req: Request, res: Response, next: () => void): void => {
    if (isGlobalHumanAdminRequest(req, deps)) {
      next();
      return;
    }
    res.status(403).json({
      error: 'human_owner_required',
      message: '密封存储属于 CDS 系统级安全配置，只允许已登录的全局人工管理员操作。',
    });
  };

  router.get('/cds-system/sealed-storage', requireHumanAdmin, (_req, res) => {
    res.json(describeSealedStorage(deps));
  });

  router.post('/cds-system/sealed-storage/initialize', requireHumanAdmin, (req, res) => {
    if (req.headers['x-cds-human-action'] !== 'initialize-sealed-storage') {
      res.status(403).json({
        error: 'human_confirmation_required',
        message: '请从 CDS 同源管理会话发起密封存储初始化。',
      });
      return;
    }
    if (hasRequestInput(req)) {
      res.status(400).json({
        error: 'client_secret_forbidden',
        message: '该端点不接受客户端密钥或其他请求参数，密钥仅由 CDS 服务端生成。',
      });
      return;
    }
    try {
      res.json(initializeSealedStorage(deps));
    } catch (error) {
      if (error instanceof SealedStorageBootstrapError) {
        const status = error.code === 'sealed_storage_persist_failed' ? 500 : 409;
        res.status(status).json({
          error: error.code,
          message: error.message,
        });
        return;
      }
      res.status(500).json({
        error: 'sealed_storage_initialization_failed',
        message: '密封存储初始化失败，未改变当前运行配置。',
      });
    }
  });

  return router;
}
