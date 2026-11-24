/**
 * CDS 配对连接路由（系统级，2026-05-06）
 *
 * 实现 spec.cds.map-pairing-protocol.md v1：
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

import { Router, urlencoded, type Request, type Response } from 'express';

import type { StateService } from '../services/state.js';
import type { CdsConnection, CdsConfig, Project } from '../types.js';
import { CDS_MAP_CONNECTION_PATH, type ClusterIdentityService } from '../services/cluster-identity.js';
import { isHumanSystemOwner } from '../services/human-auth.js';
import {
  CdsPairingService,
  PairingError,
  DEFAULT_SCOPES,
  CLUSTER_MAP_SCOPES,
  clusterMapOrigin,
  decodeClipboard,
} from '../services/connection/pairing-service.js';

export interface CdsSystemConnectionsRouterDeps {
  stateService: StateService;
  config: CdsConfig;
  clusterIdentity?: ClusterIdentityService;
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
  workspaceOnly?: boolean;
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
    workspaceOnly: conn.clusterMemberId ? true : undefined,
  };
}

export function createCdsSystemConnectionsRouter(
  deps: CdsSystemConnectionsRouterDeps,
): Router {
  const { stateService, config, clusterIdentity } = deps;

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

  function ownsManagement(req: Request, res: Response): boolean {
    if (clusterIdentity?.getConfig()?.role === 'member') {
      res.status(409).json({ error: { code: 'cluster_authority_required', message: '连接由主 CDS 管理' } });
      return false;
    }
    if (clusterIdentity?.memberOf(req) && !isHumanSystemOwner(req)) {
      res.status(403).json({ error: { code: 'system_owner_required', message: '系统所有者才能批准或管理集群 MAP 配对' } });
      return false;
    }
    return true;
  }

  function visibleConnection(req: Request, conn: CdsConnection): boolean {
    const member = clusterIdentity?.memberOf(req);
    return member ? conn.clusterMemberId === member.nodeId : !conn.clusterMemberId || isHumanSystemOwner(req);
  }

  router.post('/cds-system/connections/issue', async (req, res, next) => {
    if (!ownsManagement(req, res)) return;
    const body = (req.body || {}) as Record<string, unknown>;
    const member = clusterIdentity?.memberOf(req);
    let memberBinding: Parameters<CdsPairingService['issue']>[0]['memberBinding'];
    if (member) {
      const projectId = typeof body.projectId === 'string' ? body.projectId : '';
      if (!Object.hasOwn(member.projects, projectId) || member.projects[projectId] !== body.memberProjectId
        || !stateService.getProject(projectId)) {
        res.status(400).json({ error: { code: 'pairing_project_unbound', message: '请选择主备双方均已绑定的项目' } });
        return;
      }
      const mapBaseUrl = clusterMapOrigin(body.mapBaseUrl);
      if (!mapBaseUrl) {
        res.status(400).json({ error: { code: 'pairing_origin_invalid', message: '请填写 MAP 的 HTTPS 站点地址' } });
        return;
      }
      if (body.memberApprovalOrigin !== undefined && clusterMapOrigin(body.memberApprovalOrigin) !== member.url) {
        res.status(403).json({ error: { code: 'pairing_approval_origin_mismatch', message: '请在选定的 CDS 节点确认授权' } });
        return;
      }
      if (body.scopes !== undefined && (!Array.isArray(body.scopes) || body.scopes.length === 0
        || body.scopes.some(scope => !CLUSTER_MAP_SCOPES.includes(scope)))) {
        res.status(400).json({ error: { code: 'pairing_scope_invalid', message: '请选择 MAP 会话所需的授权范围' } });
        return;
      }
      memberBinding = { nodeId: member.nodeId, baseUrl: member.url, projectId, mapBaseUrl };
    }
    const scopes = Array.isArray(body.scopes) && body.scopes.every(scope => typeof scope === 'string')
      ? body.scopes as string[]
      : member ? CLUSTER_MAP_SCOPES : undefined;
    try {
      stateService.gcExpiredPairingConnections();
      const result = pairing.issue({
        name: typeof body.name === 'string' ? body.name : undefined,
        scopes,
        ttlMinutes: typeof body.ttlMinutes === 'number' ? body.ttlMinutes : undefined,
        hint: typeof body.hint === 'object' && body.hint !== null ? body.hint as Record<string, unknown> : undefined,
        memberBinding,
      });
      if (member) await stateService.flush();
      // 配对码只在剪贴板载荷内返回。
      res.status(201).json({
        connectionId: result.connectionId,
        clipboardText: result.clipboardText,
        expiresAt: result.expiresAt,
      });
    } catch (error) { next(error); }
  });

  async function redeemConnection(req: Request, res: Response, oauth: boolean): Promise<void> {
    const member = clusterIdentity?.memberOf(req);
    if (clusterIdentity?.getConfig()?.role === 'member') {
      res.status(409).json({ error: { code: 'cluster_authority_required', message: '配对由主 CDS 兑换' } });
      return;
    }
    const body = (req.body || {}) as Record<string, unknown>;
    const intent = (body.projectIntent || {}) as Record<string, unknown>;
    if (intent.kind !== 'shared-service') {
      res.status(400).json({ error: { code: 'project_intent_unsupported', message: 'projectIntent.kind must be shared-service in v1' } });
      return;
    }
    const partnerKind = !oauth && (body.partnerKind === 'cli' || body.partnerKind === 'other') ? body.partnerKind : 'map';
    const partnerName = String(body.mapName || body.partnerName || '');
    try {
      const result = pairing.accept({
        pairingToken: String((oauth ? body.code : body.pairingToken) || ''),
        partnerKind,
        partnerId: String(body.mapId || body.partnerId || ''),
        partnerName,
        partnerBaseUrl: String(body.mapBaseUrl || body.partnerBaseUrl || ''),
        projectIntent: {
          kind: 'shared-service',
          name: typeof intent.name === 'string' ? intent.name : 'shared-service',
          displayName: typeof intent.displayName === 'string' ? intent.displayName : undefined,
        },
      }, requested => createSharedServiceProject(stateService, requested, partnerName), member);
      if (member) await stateService.flush();
      res.json({
        ...result,
        ...(member ? { workspaceOnly: true } : {}),
        ...(oauth ? {
          cdsId: member ? `${cdsIdGetter()}:${member.nodeId}` : cdsIdGetter(),
          cdsName: cdsNameGetter(),
          scopes: member ? stateService.getCdsConnection(result.connectionId)?.scopes : DEFAULT_SCOPES,
        } : {}),
      });
    } catch (error) {
      if (error instanceof PairingError) {
        res.status(error.httpStatus).json({ error: { code: error.errorCode, message: error.message } });
        return;
      }
      res.status(500).json({ error: member
        ? { code: 'pairing_exchange_failed', message: '配对兑换未确认，请在 CDS 查看连接状态后重新发起' }
        : { code: 'internal_error', message: error instanceof Error ? error.message : String(error) } });
    }
  }

  router.post('/cds-system/connections/accept', (req, res) => redeemConnection(req, res, false));

  // ── authorize / token（MAP 端输入 CDS 地址后跳转授权） ─────────────
  router.get('/cds-system/connections/authorize', (req, res) => {
    const mode = clusterIdentity?.getConfig();
    if (mode?.role === 'member') {
      if (!isHumanSystemOwner(req)) {
        res.status(403).type('html').send(renderAuthorizeError('请使用 CDS 系统所有者账号批准 MAP 接入。'));
        return;
      }
      const approval = readMapWorkspaceApproval(req.query);
      const projects = Object.values(mode.projects).flatMap(id => {
        const project = stateService.getProject(id);
        return project ? [{ id, name: project.name }] : [];
      });
      if (!approval || !projects.length) {
        res.status(400).type('html').send(renderAuthorizeError('请核对 MAP 回跳地址和当前 CDS 节点已绑定的项目，再发起授权。'));
        return;
      }
      // Chromium sends Origin: null for a form submitted from a no-referrer document.
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('Content-Security-Policy', `frame-ancestors 'none'; form-action 'self' ${approval.mapBaseUrl}; base-uri 'none'`);
      res.type('html').send(renderAuthorizePage({
        mapName: approval.mapName, mapBaseUrl: approval.mapBaseUrl, redirectHost: approval.redirectUri.origin,
        workspace: { approval, projects },
      }));
      return;
    }
    const redirectUri = String(req.query.redirectUri || '');
    const state = String(req.query.state || '');
    const mapBaseUrl = String(req.query.mapBaseUrl || '');
    const mapId = String(req.query.mapId || '');
    const mapName = String(req.query.mapName || 'MAP');
    const approved = String(req.query.approve || '') === '1';

    if (!redirectUri || !state || !mapBaseUrl || !mapId) {
      res.status(400).type('html').send(renderAuthorizeError('授权参数不完整，请回到 MAP 重新发起连接。'));
      return;
    }

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(redirectUri);
    } catch {
      res.status(400).type('html').send(renderAuthorizeError('MAP 回跳地址无效，请检查 MAP 配置。'));
      return;
    }

    if (!approved) {
      const approveUrl = new URL(`${req.protocol}://${req.get('host')}${req.originalUrl}`);
      approveUrl.searchParams.set('approve', '1');
      res.type('html').send(renderAuthorizePage({
        mapName,
        mapBaseUrl,
        redirectHost: redirectUrl.origin,
        approveUrl: approveUrl.toString(),
      }));
      return;
    }

    try {
      const result = pairing.issue({
        name: `authorize ${mapName}`,
        scopes: DEFAULT_SCOPES,
        ttlMinutes: 10,
        hint: { supportsSidecar: true, defaultSidecarPort: 7400 },
      });
      redirectUrl.searchParams.set('cds_code', result.pairingToken);
      redirectUrl.searchParams.set('state', state);
      redirectUrl.searchParams.set('cds_base_url', cdsBaseUrlGetter());
      res.redirect(302, redirectUrl.toString());
    } catch (err) {
      res.status(500).type('html').send(renderAuthorizeError(
        err instanceof Error ? err.message : String(err),
      ));
    }
  });

  router.post('/cds-system/connections/authorize', urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    if (clusterIdentity?.getConfig()?.role !== 'member' || !isHumanSystemOwner(req)) {
      res.status(403).type('html').send(renderAuthorizeError('请从绑定的 CDS 节点由系统所有者确认授权。'));
      return;
    }
    const approval = readMapWorkspaceApproval(req.body);
    const memberApprovalOrigin = clusterMapOrigin(req.get('origin'));
    if (!approval || !memberApprovalOrigin) {
      res.status(400).type('html').send(renderAuthorizeError('授权信息已失效，请从 MAP 重新发起。'));
      return;
    }
    try {
      const reply = await clusterIdentity.forwardMapConnection(req, CDS_MAP_CONNECTION_PATH + '/issue', {
        projectId: req.body.projectId, mapBaseUrl: approval.mapBaseUrl, memberApprovalOrigin,
        name: `MAP 工作区授权 ${approval.mapName}`,
      });
      const result = reply.json as { clipboardText?: string; error?: { message?: string } } | undefined;
      if (reply.status !== 201 || typeof result?.clipboardText !== 'string') {
        res.status(reply.status === 201 ? 502 : reply.status).type('html').send(renderAuthorizeError(result?.error?.message || '主 CDS 未确认授权。'));
        return;
      }
      const decoded = decodeClipboard(result.clipboardText);
      const payload = decoded.payload;
      if (!decoded.ok || typeof payload?.pairingToken !== 'string' || payload.cdsBaseUrl !== memberApprovalOrigin) {
        res.status(502).type('html').send(renderAuthorizeError('授权结果与当前 CDS 节点不一致，请重新发起。'));
        return;
      }
      approval.redirectUri.searchParams.set('cds_code', payload.pairingToken);
      approval.redirectUri.searchParams.set('state', approval.state);
      approval.redirectUri.searchParams.set('cds_base_url', memberApprovalOrigin);
      res.redirect(303, approval.redirectUri.toString());
    } catch {
      res.status(503).type('html').send(renderAuthorizeError('暂时无法与主 CDS 确认授权，请稍后重试。'));
    }
  });

  router.post('/cds-system/connections/token', (req, res) => redeemConnection(req, res, true));

  router.get('/cds-system/connections', (req, res) => {
    if (!ownsManagement(req, res)) return;
    stateService.gcExpiredPairingConnections();
    const connections = stateService.getCdsConnections().filter(conn => visibleConnection(req, conn)).map(toPublicView);
    res.json({ connections });
  });

  function managedConnection(req: Request, res: Response): CdsConnection | undefined {
    if (!ownsManagement(req, res)) return undefined;
    const conn = stateService.getCdsConnection(req.params.id);
    if (!conn || !visibleConnection(req, conn)) {
      res.status(404).json({ error: { code: 'not_found', message: 'connection not found' } });
      return undefined;
    }
    return conn;
  }

  router.get('/cds-system/connections/:id', (req, res) => {
    const conn = managedConnection(req, res);
    if (conn) res.json({ connection: toPublicView(conn) });
  });

  router.delete('/cds-system/connections/:id', async (req, res, next) => {
    const conn = managedConnection(req, res);
    if (!conn) return;
    try {
      stateService.removeCdsConnection(conn.id);
      if (conn.clusterMemberId) await stateService.flush();
      res.status(204).end();
    } catch (error) { next(error); }
  });

  router.post('/cds-system/connections/:id/revoke', async (req, res, next) => {
    const conn = managedConnection(req, res);
    if (!conn) return;
    try {
      const updated = stateService.updateCdsConnection(conn.id, { status: 'revoked', longTokenHash: undefined });
      if (conn.clusterMemberId) await stateService.flush();
      res.json({ connection: toPublicView(updated) });
    } catch (error) { next(error); }
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

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readMapWorkspaceApproval(input: Record<string, unknown> | undefined) {
  const mapBaseUrl = clusterMapOrigin(input?.mapBaseUrl);
  const { state, redirectUri: target, mapId, mapName } = input ?? {};
  if (!mapBaseUrl || typeof state !== 'string' || !state || state.length > 4096
    || typeof mapId !== 'string' || !mapId || mapId.length > 128
    || typeof target !== 'string' || target.length > 2048) return undefined;
  try {
    const redirectUri = new URL(target);
    if (redirectUri.origin !== mapBaseUrl || redirectUri.username || redirectUri.password || redirectUri.hash
      || redirectUri.pathname !== '/settings' || redirectUri.searchParams.get('tab') !== 'infra-services') return undefined;
    return { redirectUri, state, mapId, mapBaseUrl, mapName: typeof mapName === 'string' ? mapName.slice(0, 128) : 'MAP' };
  } catch {
    return undefined;
  }
}

function renderAuthorizePage(input: {
  mapName: string;
  mapBaseUrl: string;
  redirectHost: string;
  approveUrl?: string;
  workspace?: {
    approval: NonNullable<ReturnType<typeof readMapWorkspaceApproval>>;
    projects: Array<{ id: string; name: string }>;
  };
}): string {
  const mapName = escapeHtml(input.mapName || 'MAP');
  const mapBaseUrl = escapeHtml(input.mapBaseUrl);
  const redirectHost = escapeHtml(input.redirectHost);
  const workspace = input.workspace;
  const approvalFields = workspace ? {
    redirectUri: workspace.approval.redirectUri.toString(),
    state: workspace.approval.state,
    mapId: workspace.approval.mapId,
    mapBaseUrl: workspace.approval.mapBaseUrl,
    mapName: workspace.approval.mapName,
  } : null;
  const approvalControls = workspace
    ? `<form method="post" action="/api/cds-system/connections/authorize">
      ${Object.entries(approvalFields ?? {}).map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />`).join('')}
      <label for="projectId">执行项目</label>
      <select id="projectId" name="projectId" required>
        <option value="">选择已绑定的项目</option>
        ${workspace.projects.map(project => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('')}
      </select>
      <button class="button" type="submit">授权并返回 MAP</button>
    </form>`
    : `<a class="button" href="${escapeHtml(input.approveUrl ?? '')}">授权并返回 MAP</a>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>授权 MAP 连接 CDS</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(560px, calc(100vw - 32px)); border: 1px solid rgba(148,163,184,.28); background: rgba(15,23,42,.96); border-radius: 12px; padding: 28px; box-shadow: 0 24px 80px rgba(0,0,0,.32); }
    h1 { margin: 0 0 10px; font-size: 22px; }
    p { color: #94a3b8; line-height: 1.7; }
    dl { display: grid; gap: 10px; margin: 20px 0; }
    div.row { display: grid; grid-template-columns: 96px 1fr; gap: 12px; font-size: 14px; }
    dt { color: #94a3b8; }
    dd { margin: 0; word-break: break-all; }
    .scopes { border: 1px solid rgba(148,163,184,.18); border-radius: 10px; padding: 12px; color: #cbd5e1; background: rgba(255,255,255,.03); }
    .button { display: inline-flex; margin-top: 18px; padding: 10px 14px; border: 0; border-radius: 8px; background: #38bdf8; color: #082f49; text-decoration: none; font-weight: 700; cursor: pointer; }
    form { margin-top: 18px; }
    label, select { display: block; }
    select { margin-top: 8px; min-height: 42px; width: 100%; font: inherit; }
    @media (prefers-color-scheme: light) {
      body { background: #f5f3ef; color: #292622; }
      main { background: #fff; border-color: #d8d2ca; }
      p, dt { color: #5a534c; }
      .scopes { color: #403932; background: #f5f3ef; border-color: #d8d2ca; }
    }
  </style>
</head>
<body>
  <main>
    <h1>授权 MAP 连接 CDS</h1>
    <p>${workspace ? '授权后，MAP 可在所选项目使用此 CDS 节点的 OpenDesign 工作区。' : '授权后，MAP 将创建一个 shared-service 项目，用于发现并调用 Claude SDK sidecar 等远程执行实例。'}</p>
    <dl>
      <div class="row"><dt>MAP 名称</dt><dd>${mapName}</dd></div>
      <div class="row"><dt>MAP 地址</dt><dd>${mapBaseUrl}</dd></div>
      <div class="row"><dt>回跳地址</dt><dd>${redirectHost}</dd></div>
    </dl>
    <div class="scopes">${workspace ? '授权范围：查看运行能力、创建和停止会话、收发会话消息' : `授权范围：${DEFAULT_SCOPES.join(", ")}`}</div>
    ${approvalControls}
  </main>
</body>
</html>`;
}

function renderAuthorizeError(message: string): string {
  const safe = escapeHtml(message);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CDS 授权失败</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f172a; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(520px, calc(100vw - 32px)); border: 1px solid rgba(248,113,113,.35); background: rgba(15,23,42,.96); border-radius: 12px; padding: 28px; }
    h1 { margin: 0 0 10px; font-size: 22px; }
    p { color: #fecaca; line-height: 1.7; }
    @media (prefers-color-scheme: light) {
      body { background: #f5f3ef; color: #292622; }
      main { background: #fff; border-color: #b85248; }
      p { color: #782f26; }
    }
  </style>
</head>
<body><main><h1>授权失败</h1><p>${safe}</p></main></body>
</html>`;
}
