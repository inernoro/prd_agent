/**
 * WS3 — MAP-KBTP v1 peer-sync 端点（CDS 作为「源 peer」）。
 *
 * 职责分离的最后一环：验收报告归 CDS（验收中心），MAP 等系统通过知识库开放协议
 * （MAP-KBTP v1）把 CDS 报告整库 pull 过去展示。CDS 在此实现协议的 6 个端点，
 * 资源类型对外暴露为 `document-store`（MAP 已有的 apply 处理器即可零改动消费）：
 * 每个「item」= 一个 CDS 项目（或全局）的验收报告集合，每个「record」= 一份报告。
 *
 * 协议契约（与 prd-api 的 PeerSyncController / PeerNodeService 对齐，可互通）：
 *  - 鉴权：HMAC-SHA256。请求头 X-Peer-Node / X-Peer-Ts / X-Peer-Sign。
 *    待签串 = `${METHOD}\n${path}\n${ts}\n${bodyHashHexOrEmpty}`，
 *    其中 path 不含 query；无 body 时末段为空串，有 body 时为 sha256hex(rawBody)。
 *    密钥 = base64decode(sharedSecret)；签名为 hmac-sha256 的小写 hex。时间窗 ±5 分钟。
 *  - 响应包络：成功 `{ success:true, data }`；失败 `{ success:false, errorCode, message }`，camelCase。
 *  - handshake 自身不签名，由一次性配对码鉴权，换发 sharedSecret 建立 PeerNode。
 *
 * 安全：本实现是「只读源」——只导出报告，从不回调 partnerBaseUrl，故 SSRF 面极小。
 * apply 为 no-op（CDS 不接受对端写入）。管理端点（生成配对码 / 列举撤销节点）走 CDS 登录态。
 */
import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { StateService } from '../services/state.js';
import type { AcceptanceReportMeta, Project } from '../types.js';

/**
 * 取请求原始正文字符串（HMAC 必须用对端签名时的同一份字节）。
 * 全局 JSON 解析器（server.ts）的 verify 钩子已把原字节存到 req.rawBody，
 * 故这里直接读它，不能用自带 body 解析器（流已被全局解析器消费，会拿到空串）。
 */
function rawBodyOf(req: Request): string {
  const buf = (req as Request & { rawBody?: Buffer }).rawBody;
  return buf ? buf.toString('utf8') : '';
}

/** 取已解析的 JSON body 对象（全局解析器已把 JSON 解析进 req.body）。 */
function jsonBodyOf(req: Request): Record<string, unknown> {
  const b = req.body;
  return b && typeof b === 'object' && !Buffer.isBuffer(b) ? (b as Record<string, unknown>) : {};
}

const MAX_SKEW_MS = 5 * 60 * 1000;
const RESOURCE_TYPE = 'document-store';
const SELF_DISPLAY_NAME = 'CDS 验收中心';
/** 全局（projectId=null）报告的 item key（MAP 侧用此 key 拉 CDS 自身的报告）。 */
const GLOBAL_ITEM_KEY = '__cds_global__';

function sha256hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function ok(res: Response, data: unknown): void {
  res.json({ success: true, data });
}
function fail(res: Response, status: number, errorCode: string, message: string): void {
  // 顶层 errorCode/message 保留向后兼容；嵌套 error.{code,message} 让 MAP 发起方
  // （AdminPeerNodesController 解析 error.message）能显示精确失败原因，而非泛化文案。
  res.status(status).json({ success: false, errorCode, message, error: { code: errorCode, message } });
}

/**
 * 校验 HMAC 签名，返回命中的 PeerNode（并 touch lastUsedAt），失败返回 null。
 * rawBody 是请求原始正文字符串（GET 为空串）——HMAC 必须用对端签名时的同一份字节。
 */
function verifyPeerSignature(
  req: Request,
  rawBody: string,
  stateService: StateService,
): { id: string } | null {
  const nodeId = String(req.headers['x-peer-node'] || '').trim();
  const ts = String(req.headers['x-peer-ts'] || '').trim();
  const sign = String(req.headers['x-peer-sign'] || '').trim().toLowerCase();
  if (!nodeId || !ts || !sign) return null;

  const node = stateService.getPeerNodeByPartnerId(nodeId);
  if (!node) return null;

  const tsMs = Number(ts);
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > MAX_SKEW_MS) return null;

  // 空 body 也要 sha256（空串 → e3b0c4…），与 MAP PeerNodeService.Compute 的
  // `Sha256Hex(body ?? "")` 对齐。早期写成「空 body → 空串」只在 CDS 自测里自洽，
  // 与 MAP 的 GET /ping、/capabilities（空 body）签名串不一致会被 401，配对回滚。
  const bodyHash = sha256hex(rawBody);
  const path = String(req.originalUrl || '').split('?')[0];
  const payload = `${(req.method || 'GET').toUpperCase()}\n${path}\n${ts}\n${bodyHash}`;

  let expected: string;
  try {
    const key = Buffer.from(node.sharedSecret, 'base64');
    expected = crypto.createHmac('sha256', key).update(payload, 'utf8').digest('hex');
  } catch {
    return null;
  }
  // 等长才比较，避免 timingSafeEqual 抛错；仍走常量时间比较防 timing 侧信道。
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sign, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  stateService.touchPeerNode(node.id);
  return { id: node.id };
}

/** 解析某 item（项目 / 全局）下的验收报告集合，返回 { item 元信息, reports } 或 null（item 不存在）。 */
function resolveItem(
  stateService: StateService,
  itemId: string,
): { key: string; name: string; reports: AcceptanceReportMeta[] } | null {
  if (itemId === GLOBAL_ITEM_KEY) {
    const reports = stateService.listAcceptanceReports(null).filter((r) => !r.projectId);
    return { key: GLOBAL_ITEM_KEY, name: 'CDS 验收报告（全局）', reports };
  }
  const project: Project | undefined = stateService.getProject(itemId);
  if (!project) return null;
  const reports = stateService.listAcceptanceReports(project.id);
  return { key: project.id, name: `${project.name || project.slug || project.id} · 验收报告`, reports };
}

/** 计算 item 的漂移指纹：报告(id|updatedAt|title) 排序后 sha256hex。报告变动即指纹变。 */
function computeSignature(reports: AcceptanceReportMeta[]): string {
  const parts = reports
    .map((r) => `${r.id}|${r.updatedAt || r.createdAt}|${r.title}|0`)
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return sha256hex(parts.join('\n'));
}

/** 把一个 item 的报告组装成 MAP-KBTP SyncResourceBundle（resourceType=document-store）。 */
function buildBundle(
  stateService: StateService,
  itemId: string,
): Record<string, unknown> | null {
  const resolved = resolveItem(stateService, itemId);
  if (!resolved) return null;
  const { key, name, reports } = resolved;

  const records = reports.map((r) => {
    const content = stateService.readAcceptanceReportContent(r.id) ?? '';
    const tags = [r.verdict ? verdictTag(r.verdict) : '', r.tier || ''].filter(Boolean);
    // metadata 一律字符串值（与协议 Dictionary<string,string> 对齐）。
    const metadata: Record<string, string> = { syncLineageId: r.id };
    if (r.verdict) metadata.verdict = r.verdict;
    if (r.tier) metadata.tier = r.tier;
    if (r.commitSha) metadata.commitSha = r.commitSha;
    if (r.branch) metadata.branch = r.branch;
    if (r.prNumber) metadata.prNumber = String(r.prNumber);
    if (r.deployMode) metadata.deployMode = r.deployMode;
    if (r.projectId) metadata.cdsProjectId = r.projectId;
    metadata.peerSourceContentHash = sha256hex(content);
    return {
      lineageId: r.id,
      parentLineageId: null,
      isFolder: false,
      title: r.title,
      summary: null,
      contentType: r.format === 'html' ? 'text/html' : 'text/markdown',
      fileSize: r.sizeBytes,
      tags,
      metadata,
      content,
      contentHash: sha256hex(content),
      sortOrder: null,
      category: null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      lastChangedAt: r.updatedAt,
      extras: {},
    };
  });

  const createdAt = reports.length ? reports.map((r) => r.createdAt).sort()[0] : new Date(0).toISOString();
  const updatedAt = reports.length
    ? reports.map((r) => r.updatedAt || r.createdAt).sort().slice(-1)[0]
    : new Date(0).toISOString();

  return {
    schemaVersion: 1,
    resourceType: RESOURCE_TYPE,
    item: {
      key,
      name,
      description: 'CDS 验收中心同步的验收报告',
      tags: ['acceptance', 'cds'],
      ownerUserName: null,
      ownerEmail: null,
      createdAt,
      updatedAt,
      templateKey: null,
      primaryEntryLineage: null,
      pinnedEntryLineages: null,
      defaultSortMode: 'created-desc',
      extras: {},
    },
    records,
  };
}

function verdictTag(v: 'pass' | 'conditional' | 'fail'): string {
  return v === 'pass' ? '通过' : v === 'conditional' ? '有条件通过' : '不通过';
}

export interface PeerSyncRouterDeps {
  stateService: StateService;
}

/**
 * 协议路由（HMAC / 配对码鉴权，**不经 CDS 登录网关**——server.ts 已在白名单放行
 * `/api/peer-sync/handshake|ping|capabilities|resources/:type/(signature|export|apply)`）。
 */
export function createPeerSyncRouter(deps: PeerSyncRouterDeps): Router {
  const router = Router();
  const { stateService } = deps;

  const requireSig = (req: Request, res: Response): boolean => {
    const node = verifyPeerSignature(req, rawBodyOf(req), stateService);
    if (!node) {
      fail(res, 401, 'UNAUTHORIZED', '签名校验失败或节点未配对');
      return false;
    }
    return true;
  };

  // 1) handshake — 配对码鉴权，换发 sharedSecret。
  router.post('/handshake', (req: Request, res: Response) => {
    const body = jsonBodyOf(req);
    const pairingCode = String(body.pairingCode || '').trim();
    const initiatorNodeId = String(body.initiatorNodeId || '').trim();
    if (!pairingCode || !initiatorNodeId) {
      return fail(res, 400, 'INVALID_FORMAT', '缺少 pairingCode 或 initiatorNodeId');
    }
    if (!stateService.consumePeerPairingCode(pairingCode)) {
      return fail(res, 401, 'UNAUTHORIZED', '配对码无效、已使用或已过期');
    }
    const sharedSecret = crypto.randomBytes(32).toString('base64');
    stateService.createPeerNode({
      partnerNodeId: initiatorNodeId,
      sharedSecret,
      partnerBaseUrl: body.initiatorBaseUrl ? String(body.initiatorBaseUrl) : undefined,
      partnerDisplayName: body.initiatorDisplayName ? String(body.initiatorDisplayName) : undefined,
    });
    return ok(res, {
      nodeId: stateService.getOrCreatePeerSelfNodeId(),
      displayName: SELF_DISPLAY_NAME,
      sharedSecret,
    });
  });

  // 1b) 两阶段握手的 confirm/finalize：CDS 是「握手即提交」单阶段 peer，不实现两阶段。
  // 必须返回 404，让 MAP 发起方（AdminPeerNodesController）的 legacy 判定
  // （`!confirm.Ok && confirm.Status == 404`）命中、按 legacy peer 继续配对；
  // 若被登录网关拦成 401 或落 SPA fallback 200，MAP 会判「确认失败」而取消配对。
  router.post('/handshake/confirm', (_req: Request, res: Response) =>
    fail(res, 404, 'NOT_FOUND', 'CDS 为单阶段 peer，握手即提交，无 confirm 阶段'));
  router.post('/handshake/finalize', (_req: Request, res: Response) =>
    fail(res, 404, 'NOT_FOUND', 'CDS 为单阶段 peer，无 finalize 阶段'));
  // cancel：MAP 在配对失败回滚时best-effort调用。CDS 握手时已落 PeerNode，
  // 这里按 initiatorNodeId 删除半连接节点，返回 200（MAP 忽略其结果）。
  router.post('/handshake/cancel', (req: Request, res: Response) => {
    const initiatorNodeId = String(jsonBodyOf(req).initiatorNodeId || '').trim();
    if (initiatorNodeId) {
      const node = stateService.getPeerNodeByPartnerId(initiatorNodeId);
      if (node) stateService.deletePeerNode(node.id);
    }
    return ok(res, { cancelled: true });
  });

  // 2) ping — 连通性 + 签名自检。
  router.get('/ping', (req: Request, res: Response) => {
    if (!requireSig(req, res)) return;
    return ok(res, { ok: true, node: stateService.getOrCreatePeerSelfNodeId() });
  });

  // 3) capabilities — 广告资源类型。
  router.get('/capabilities', (req: Request, res: Response) => {
    if (!requireSig(req, res)) return;
    return ok(res, {
      items: [
        { resourceType: RESOURCE_TYPE, displayName: 'CDS 验收报告', supportsBidirectional: false, schemaVersion: 1 },
      ],
    });
  });

  // 4) signature — item 漂移指纹。
  router.post('/resources/:type/signature', (req: Request, res: Response) => {
    if (!requireSig(req, res)) return;
    if (req.params.type !== RESOURCE_TYPE) return fail(res, 404, 'NOT_FOUND', `未注册的资源类型：${req.params.type}`);
    const itemId = String(jsonBodyOf(req).itemId || '').trim();
    const resolved = resolveItem(stateService, itemId);
    if (!resolved) return fail(res, 404, 'NOT_FOUND', `item 不存在：${itemId}`);
    return ok(res, { signature: computeSignature(resolved.reports) });
  });

  // 5) export — 导出 item 的 SyncResourceBundle。
  router.post('/resources/:type/export', (req: Request, res: Response) => {
    if (!requireSig(req, res)) return;
    if (req.params.type !== RESOURCE_TYPE) return fail(res, 404, 'NOT_FOUND', `未注册的资源类型：${req.params.type}`);
    const itemId = String(jsonBodyOf(req).itemId || '').trim();
    const bundle = buildBundle(stateService, itemId);
    if (!bundle) return fail(res, 404, 'NOT_FOUND', `item 不存在：${itemId}`);
    return ok(res, bundle);
  });

  // 6) apply — no-op（CDS 是只读源，不接受对端写入）。
  router.post('/resources/:type/apply', (req: Request, res: Response) => {
    if (!requireSig(req, res)) return;
    if (req.params.type !== RESOURCE_TYPE) return fail(res, 404, 'NOT_FOUND', `未注册的资源类型：${req.params.type}`);
    return ok(res, {
      created: 0, updated: 0, skipped: 0, failed: 0, deleted: 0,
      partial: false, unmatchedAuthors: 0,
      message: 'CDS 验收报告为只读源，不接受写入（apply 已忽略）',
      targetItemId: null, assetsRewritten: 0, assetRewriteFailed: 0,
    });
  });

  return router;
}

/**
 * 管理路由（**走 CDS 登录态**，不在 peer 白名单里）：生成配对码 / 列举撤销节点。
 * 挂在 `/api/peer-sync/admin`。
 */
export function createPeerSyncAdminRouter(deps: PeerSyncRouterDeps): Router {
  const router = Router();
  const { stateService } = deps;

  // 生成一次性配对码（明文仅返回一次）。body 已由全局 JSON 解析器解析。
  router.post('/admin/pairing-codes', (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body))
      ? (req.body as Record<string, unknown>) : {};
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : undefined;
    const { code, record } = stateService.createPeerPairingCode(displayName);
    return res.status(201).json({
      pairingCode: code,
      expiresAt: record.expiresAt,
      selfNodeId: stateService.getOrCreatePeerSelfNodeId(),
      note: '把 pairingCode 交给对端（MAP）在「同步中心」配对本 CDS；明文只显示这一次。',
    });
  });

  // 列举已配对节点（不返回 sharedSecret）。
  router.get('/admin/nodes', (_req: Request, res: Response) => {
    const nodes = stateService.listPeerNodes().map((n) => ({
      id: n.id,
      partnerNodeId: n.partnerNodeId,
      partnerBaseUrl: n.partnerBaseUrl ?? null,
      partnerDisplayName: n.partnerDisplayName ?? null,
      createdAt: n.createdAt,
      lastUsedAt: n.lastUsedAt ?? null,
    }));
    return res.json({ selfNodeId: stateService.getOrCreatePeerSelfNodeId(), nodes });
  });

  // 撤销一个已配对节点（其后续请求立即 401）。
  router.delete('/admin/nodes/:id', (req: Request, res: Response) => {
    const removed = stateService.deletePeerNode(req.params.id);
    if (!removed) return res.status(404).json({ error: 'not_found', message: '节点不存在' });
    return res.json({ success: true });
  });

  return router;
}
