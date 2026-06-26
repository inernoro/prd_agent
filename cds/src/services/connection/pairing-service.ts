/**
 * CdsPairingService —— spec.cds.map-pairing-protocol.md v1 实施。
 *
 * 职责：
 *   1. issue：生成一次性 pairing token + 剪贴板密文（base64url JSON），
 *      内部记录一条 status='pending-pairing' 的 CdsConnection
 *   2. accept：校验 pairingToken hash + TTL + 未使用 → 创建 shared-service
 *      Project（kind='shared-service'）→ 签发长效 token → connection 转 active
 *   3. authenticateLongToken：把 partner 后续请求里的 long token 反查到具体
 *      connection，返回上下文供 controller 鉴权
 *
 * 安全：
 *   - 所有 token 仅存 SHA256 hash
 *   - pairing token TTL 默认 10 分钟，可配置 1-60
 *   - long token 为系统级长期授权；除非显式 revoke / delete，不因时间自动失效
 *   - issue/accept 里手动用 crypto.randomBytes(32) 生成强随机
 */

import crypto from 'node:crypto';

import type { StateService } from '../state.js';
import type { CdsConnection, Project } from '../../types.js';

export interface IssueRequest {
  /** 给自己看的标识（如 "for noroenrn map"）。 */
  name?: string;
  /** 默认 ['shared-service:deploy', 'instance:read', 'deployment:stream']。 */
  scopes?: string[];
  /** 默认 10 分钟，限制 1-60。 */
  ttlMinutes?: number;
  /** 协议给 MAP 的 hint（可选）。 */
  hint?: Record<string, unknown>;
}

export interface IssueResult {
  connectionId: string;
  pairingToken: string;
  /** "cds-connect:v1:<base64url(json)>" 直接给 UI 一键复制。 */
  clipboardText: string;
  /** ISO 8601。 */
  expiresAt: string;
}

export interface AcceptRequest {
  pairingToken: string;
  partnerKind: 'map' | 'cli' | 'other';
  partnerId: string;
  partnerName: string;
  partnerBaseUrl: string;
  projectIntent: {
    kind: 'shared-service';
    name: string;
    displayName?: string;
  };
}

export interface AcceptResult {
  connectionId: string;
  cdsLongToken: string;
  cdsLongTokenExpiresAt: string | null;
  projectId: string;
  instanceDiscoveryUrl: string;
  deployStreamUrlTemplate: string;
}

export class PairingError extends Error {
  constructor(
    public readonly errorCode: string,
    public readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

const DEFAULT_SCOPES = ['shared-service:deploy', 'instance:read', 'deployment:stream'];
const PAIRING_TTL_DEFAULT_MIN = 10;
const PAIRING_TTL_MIN = 1;
const PAIRING_TTL_MAX = 60;

export class CdsPairingService {
  constructor(
    private readonly stateService: StateService,
    private readonly cdsBaseUrl: () => string,
    private readonly cdsId: () => string,
    private readonly cdsName: () => string,
  ) {}

  // ── 1. Issue ──────────────────────────────────────

  issue(req: IssueRequest): IssueResult {
    const ttlMin = clampTtl(req.ttlMinutes ?? PAIRING_TTL_DEFAULT_MIN);
    const scopes = (req.scopes && req.scopes.length > 0 ? req.scopes : DEFAULT_SCOPES).slice();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + ttlMin * 60_000);

    const pairingToken = `pt_${crypto.randomBytes(24).toString('hex')}`;
    const id = `conn_${crypto.randomBytes(8).toString('hex')}`;

    const conn: CdsConnection = {
      id,
      name: (req.name && req.name.trim()) || `pending ${issuedAt.toISOString().slice(0, 16)}`,
      partnerKind: 'map',
      status: 'pending-pairing',
      scopes,
      pairingTokenHash: sha256Hex(pairingToken),
      pairingExpiresAt: expiresAt.toISOString(),
      createdAt: issuedAt.toISOString(),
    };
    this.stateService.addCdsConnection(conn);

    const clipboardPayload = {
      version: 1,
      cdsBaseUrl: this.cdsBaseUrl(),
      cdsId: this.cdsId(),
      cdsName: this.cdsName(),
      pairingToken,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      scopes,
      hint: req.hint,
    };
    const clipboardText = encodeClipboard(clipboardPayload);

    return {
      connectionId: id,
      pairingToken,
      clipboardText,
      expiresAt: expiresAt.toISOString(),
    };
  }

  // ── 2. Accept ─────────────────────────────────────

  accept(
    req: AcceptRequest,
    createProject: (intent: AcceptRequest['projectIntent']) => Project,
  ): AcceptResult {
    if (!req.pairingToken || typeof req.pairingToken !== 'string') {
      throw new PairingError('pairing_token_missing', 400, 'pairingToken is required');
    }
    if (!req.partnerBaseUrl || !req.partnerName || !req.partnerId) {
      throw new PairingError('partner_info_missing', 400, 'partnerBaseUrl/partnerName/partnerId are required');
    }
    if (req.projectIntent?.kind !== 'shared-service') {
      throw new PairingError('project_intent_unsupported', 400, 'only kind=shared-service supported in v1');
    }

    const hash = sha256Hex(req.pairingToken);
    const conn = this.stateService.findCdsConnectionByPairingHash(hash);
    if (!conn) {
      // 区分 expired vs not_found：如果有匹配但已过期的，给更准确的错误码。
      // 简化版：直接看一下全表里有没有 used/expired 的同 hash。
      const all = this.stateService.getCdsConnections();
      const matched = all.find(c => c.pairingTokenHash === hash);
      if (matched && matched.status === 'active') {
        throw new PairingError('pairing_token_used', 410, 'pairing token already used');
      }
      throw new PairingError('pairing_token_not_found', 404, 'pairing token not found or expired');
    }
    if (
      conn.pairingExpiresAt &&
      new Date(conn.pairingExpiresAt).getTime() < Date.now()
    ) {
      throw new PairingError('pairing_token_expired', 410, 'pairing token expired');
    }

    // 同一个 partner 重新授权时，旋转 long token 并撤销旧连接。
    // MAP 端的 DataProtection key 丢失后旧 long token 无法解密，但 CDS 侧仍有 active
    // connection；如果这里继续返回 duplicate，用户会卡在“旧连接已失效但无法重连”。
    const dup = this.stateService
      .getActiveCdsConnections()
      .find(c => c.partnerKind === req.partnerKind && c.partnerId === req.partnerId && c.id !== conn.id);
    if (dup) {
      this.stateService.updateCdsConnection(dup.id, {
        status: 'revoked',
      });
    }

    // 创建 shared-service Project
    const project = createProject(req.projectIntent);

    // 签发系统级长期 token。10 分钟只属于一次性 pairing token；
    // long token 不设置时间过期，除非管理员显式撤销连接。
    const longToken = `ct_${crypto.randomBytes(32).toString('hex')}`;

    const updated = this.stateService.updateCdsConnection(conn.id, {
      status: 'active',
      pairingTokenHash: undefined,
      pairingExpiresAt: undefined,
      longTokenHash: sha256Hex(longToken),
      longTokenIssuedAt: new Date().toISOString(),
      longTokenExpiresAt: undefined,
      partnerKind: req.partnerKind,
      partnerId: req.partnerId,
      partnerName: req.partnerName,
      partnerBaseUrl: req.partnerBaseUrl,
      projectId: project.id,
      activatedAt: new Date().toISOString(),
      // 给 connection 一个更友好的名（覆盖 issue 时的占位）
      name: `${req.partnerName} -> ${req.projectIntent.name}`,
    });

    return {
      connectionId: updated.id,
      cdsLongToken: longToken,
      cdsLongTokenExpiresAt: null,
      projectId: project.id,
      instanceDiscoveryUrl: `/api/projects/${project.id}/instances`,
      deployStreamUrlTemplate: '/api/service-deployments/{id}/stream',
    };
  }

  // ── 3. Long token 鉴权（partner 后续请求用） ───────────

  authenticateLongToken(rawToken: string | undefined): CdsConnection | null {
    if (!rawToken) return null;
    const hash = sha256Hex(rawToken);
    const conn = this.stateService.findActiveCdsConnectionByLongTokenHash(hash);
    if (!conn) return null;
    // lastUsedAt is observability metadata, not part of auth correctness.
    // High-frequency discovery polling must not save the whole CDS state on
    // every request; in Mongo-backed state that path clones/sanitizes the full
    // state document and can push the master heap into OOM.
    const now = Date.now();
    const lastUsedAt = conn.lastUsedAt ? Date.parse(conn.lastUsedAt) : 0;
    if (!lastUsedAt || !Number.isFinite(lastUsedAt) || now - lastUsedAt > 60_000) {
      this.stateService.updateCdsConnection(conn.id, { lastUsedAt: new Date(now).toISOString() });
    }
    return conn;
  }
}

// ── Pure helpers（导出供单测直接验证） ────────────────────

export function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function encodeClipboard(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload);
  const b64url = Buffer.from(json, 'utf-8').toString('base64url');
  return `cds-connect:v1:${b64url}`;
}

export function decodeClipboard(text: string): {
  ok: boolean;
  errorCode?: string;
  payload?: Record<string, unknown>;
} {
  if (!text || typeof text !== 'string') {
    return { ok: false, errorCode: 'clipboard_invalid_format' };
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith('cds-connect:v1:')) {
    if (trimmed.startsWith('cds-connect:')) {
      return { ok: false, errorCode: 'clipboard_version_not_supported' };
    }
    return { ok: false, errorCode: 'clipboard_invalid_format' };
  }
  const b64url = trimmed.slice('cds-connect:v1:'.length);
  let json: string;
  try {
    json = Buffer.from(b64url, 'base64url').toString('utf-8');
  } catch {
    return { ok: false, errorCode: 'clipboard_invalid_format' };
  }
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (typeof obj !== 'object' || obj === null) {
      return { ok: false, errorCode: 'clipboard_invalid_format' };
    }
    return { ok: true, payload: obj };
  } catch {
    return { ok: false, errorCode: 'clipboard_invalid_format' };
  }
}

function clampTtl(min: number): number {
  if (!Number.isFinite(min)) return PAIRING_TTL_DEFAULT_MIN;
  if (min < PAIRING_TTL_MIN) return PAIRING_TTL_MIN;
  if (min > PAIRING_TTL_MAX) return PAIRING_TTL_MAX;
  return Math.floor(min);
}
