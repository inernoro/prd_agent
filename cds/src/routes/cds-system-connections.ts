/**
 * CDS 配对连接路由（系统级，2026-05-06）
 *
 * 实现 spec.cds-map-pairing-protocol.md v1：
 *   POST   /api/cds-system/connections/issue       生成剪贴板密钥
 *   POST   /api/cds-system/connections/accept      MAP 端粘贴 → 完成 handshake
 *   GET    /api/cds-system/connections             列出所有连接（含 pending）
 *   GET    /api/cds-system/connections/:id         单条详情
 *   DELETE /api/cds-system/connections/:id         撤销
 *   POST   /api/cds-system/connections/:id/revoke  显式撤销（保留记录）
 *
 * 命名：路径走 `/api/cds-system/*` 系统级前缀（scope-naming.md §3）。
 *
 * 安全：所有 token 仅存 SHA256 hash；accept 前先 GC 过期的 pending 连接。
 */

import { Router } from 'express';

import type { StateService } from '../services/state.js';
import type { CdsConnection, CdsConfig, Project } from '../types.js';
import {
  CdsPairingService,
  PairingError,
} from '../services/connection/pairing-service.js';

export interface CdsSystemConnectionsRouterDeps {
  stateService: StateService;
  config: CdsConfig;
}

interface PublicView {
  id: string;
  name: string;
  partnerKind: string;
  status: string;
  scopes: string[];
  pairingExpiresAt?: string;
  partnerId?: string;
  partnerName?: string;
  partnerBaseUrl?: string;
  projectId?: string;
  longTokenExpiresAt?: string;
  createdAt: string;
  activatedAt?: string;
  lastUsedAt?: string;
}

function toPublicView(conn: CdsConnection): PublicView {
  return {
    id: conn.id,
    name: conn.name,
    partnerKind: conn.partnerKind,
    status: conn.status,
    scopes: conn.scopes,
    pairingExpiresAt: conn.pairingExpiresAt,
    partnerId: conn.partnerId,
    partnerName: conn.partnerName,
    partnerBaseUrl: conn.partnerBaseUrl,
    projectId: conn.projectId,
    longTokenExpiresAt: conn.longTokenExpiresAt,
    createdAt: conn.createdAt,
    activatedAt: conn.activatedAt,
    lastUsedAt: conn.lastUsedAt,
  };
}

export function createCdsSystemConnectionsRouter(
  deps: CdsSystemConnectionsRouterDeps,
): Router {
  const { stateService, config } = deps;

  const cdsBaseUrlGetter = () => deriveCdsBaseUrl(config);
  const cdsIdGetter = () => deriveCdsId(stateService);
  const cdsNameGetter = () => deriveCdsName(config);

  const pairing = new CdsPairingService(
    stateService,
    cdsBaseUrlGetter,
    cdsIdGetter,
    cdsNameGetter,
  );

  const router = Router();

  // ── issue ──────────────────────────────────────
  router.post('/cds-system/connections/issue', (req, res) => {
    // 启发式 GC：每次 issue 时清理过期 pending（避免堆积）。
    stateService.gcExpiredPairingConnections();

    const body = (req.body || {}) as Record<string, unknown>;
    const ttl =
      typeof body.ttlMinutes === 'number' ? body.ttlMinutes : undefined;
    const scopes =
      Array.isArray(body.scopes) && body.scopes.every(s => typeof s === 'string')
        ? (body.scopes as string[])
        : undefined;
    const result = pairing.issue({
      name: typeof body.name === 'string' ? body.name : undefined,
      scopes,
      ttlMinutes: ttl,
      hint: typeof body.hint === 'object' && body.hint !== null
        ? (body.hint as Record<string, unknown>)
        : undefined,
    });
    // 安全：pairingToken 已经嵌在 clipboardText 里，响应体不再单独暴露明文 token，
    // 减少其在 access logs / proxy logs / browser devtools 中的足迹（PR #529 Bugbot MEDIUM）
    res.status(201).json({
      connectionId: result.connectionId,
      clipboardText: result.clipboardText,
      expiresAt: result.expiresAt,
    });
  });

  // ── accept （MAP 端打过来） ───────────────────
  router.post('/cds-system/connections/accept', (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;

    const partnerKind: 'map' | 'cli' | 'other' =
      body.partnerKind === 'cli' || body.partnerKind === 'other'
        ? (body.partnerKind as 'cli' | 'other')
        : 'map';

    const projectIntent = (body.projectIntent || {}) as Record<string, unknown>;
    if (projectIntent.kind !== 'shared-service') {
      res.status(400).json({
        error: { code: 'project_intent_unsupported', message: 'projectIntent.kind must be shared-service in v1' },
      });
      return;
    }

    try {
      // 协议字段映射（spec §3.2）：MAP 端发 mapId/mapName/mapBaseUrl，
      // 但 CDS 内部 PairingService 用 partnerXxx 命名（更通用，未来 cli/k8s
      // 也走同一个 service）。本 controller 是协议适配层，做名字转译。
      // 兼容已有 partner* 直接传（v1 内部测试用），mapXxx 优先。
      const partnerId = String(body.mapId || body.partnerId || '');
      const partnerName = String(body.mapName || body.partnerName || '');
      const partnerBaseUrl = String(body.mapBaseUrl || body.partnerBaseUrl || '');

      const result = pairing.accept(
        {
          pairingToken: String(body.pairingToken || ''),
          partnerKind,
          partnerId,
          partnerName,
          partnerBaseUrl,
          projectIntent: {
            kind: 'shared-service',
            name: String(projectIntent.name || 'shared-service'),
            displayName:
              typeof projectIntent.displayName === 'string'
                ? (projectIntent.displayName as string)
                : undefined,
          },
        },
        intent => createSharedServiceProject(stateService, intent, partnerName),
      );
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof PairingError) {
        res.status(err.httpStatus).json({
          error: { code: err.errorCode, message: err.message },
        });
        return;
      }
      res.status(500).json({
        error: {
          code: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  // ── list / get / delete ──────────────────────
  router.get('/cds-system/connections', (_req, res) => {
    stateService.gcExpiredPairingConnections();
    const connections = stateService.getCdsConnections().map(toPublicView);
    res.json({ connections });
  });

  router.get('/cds-system/connections/:id', (req, res) => {
    const conn = stateService.getCdsConnection(req.params.id);
    if (!conn) {
      res.status(404).json({ error: { code: 'not_found', message: 'connection not found' } });
      return;
    }
    res.json({ connection: toPublicView(conn) });
  });

  router.delete('/cds-system/connections/:id', (req, res) => {
    const ok = stateService.removeCdsConnection(req.params.id);
    if (!ok) {
      res.status(404).json({ error: { code: 'not_found', message: 'connection not found' } });
      return;
    }
    res.status(204).end();
  });

  router.post('/cds-system/connections/:id/revoke', (req, res) => {
    const conn = stateService.getCdsConnection(req.params.id);
    if (!conn) {
      res.status(404).json({ error: { code: 'not_found', message: 'connection not found' } });
      return;
    }
    const updated = stateService.updateCdsConnection(conn.id, {
      status: 'revoked',
      longTokenHash: undefined,
    });
    res.json({ connection: toPublicView(updated) });
  });

  return router;
}

// ── 工具：派生 CDS 自身标识 ────────────────────────────

function deriveCdsBaseUrl(config: CdsConfig): string {
  // 优先级：dashboardDomain > mainDomain > rootDomains[0] > masterUrl > localhost
  const domain =
    (config as unknown as { dashboardDomain?: string }).dashboardDomain ||
    (config as unknown as { mainDomain?: string }).mainDomain ||
    ((config as unknown as { rootDomains?: string[] }).rootDomains || [])[0];
  if (domain) {
    return domain.startsWith('http') ? domain : `https://${domain}`;
  }
  const masterUrl = (config as unknown as { masterUrl?: string }).masterUrl;
  if (masterUrl) return masterUrl;
  return `http://localhost:${(config as unknown as { masterPort?: number }).masterPort ?? 9900}`;
}

function deriveCdsName(config: CdsConfig): string {
  const domain =
    (config as unknown as { dashboardDomain?: string }).dashboardDomain ||
    (config as unknown as { mainDomain?: string }).mainDomain;
  if (domain) return domain;
  return 'cds-local';
}

/**
 * cdsId 不需要密码学强度，只需稳定 + 跨实例可区分。我们把它存到一个隐藏 Project
 * 的 customEnv 里太重了，就直接写 dashboardDomain hash + 启动时 hostname 派生。
 * 实际持久化让 stateService 在创建第一条 connection 时把自己的 hostname 当作
 * cdsId 写到 connection 自己里 —— 同一 CDS 实例重启后名字保持。
 *
 * 简化方案：直接用 dashboardDomain（如果有）的 base64url 前 12 字；
 * 否则用 hostname。
 */
function deriveCdsId(_state: StateService): string {
  const fromEnv = process.env.CDS_INSTANCE_ID;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  const hostname = process.env.HOSTNAME || 'cds-instance';
  return `cds-${hostname}`;
}

/**
 * 在 accept 时为 partner 自动创建一个 shared-service Project。
 *
 * 设计：v1 走最小可行 —— Project.kind='shared-service'，Project.name 用
 * intent.displayName 或 intent.name；id 走 stateService 的 idgen。后续 host
 * 部署 sidecar 到这个 project 上，instance discovery 也按这个 projectId 走。
 *
 * 命名冲突：如果同名 project 已存在（手动创建过），不创建新的，复用现有那条；
 * 这种 fallback 是对运维"先建 project 再 pair"的兼容。
 */
function createSharedServiceProject(
  stateService: StateService,
  intent: { kind: 'shared-service'; name: string; displayName?: string },
  partnerName: string,
): Project {
  const desiredName = intent.displayName || intent.name;
  const existing = stateService
    .getProjects()
    .find(p => p.kind === 'shared-service' && p.name === desiredName);
  if (existing) return existing;

  const id = `shared-${(intent.name || 'service').toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${Date.now().toString(36)}`;
  const slug = id.slice(0, 60);

  const project: Project = {
    id,
    slug,
    name: desiredName,
    description: partnerName
      ? `Shared service auto-created via pairing with ${partnerName}`
      : 'Shared service auto-created via pairing',
    kind: 'shared-service',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  stateService.addProject(project);
  return project;
}
