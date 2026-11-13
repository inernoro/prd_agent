import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeUptimeMonitorInput, customProbeTargetId, type UptimeMonitorInput } from './uptime-custom-monitor.js';
import type { UptimeCustomMonitor } from '../types.js';
import type { UptimeMonitorStore } from '../routes/uptime.js';
import type { MonitorNotificationSettings } from './alarm-route.js';

export type OnboardingStatus = 'waiting' | 'connected' | 'proposed' | 'confirming' | 'completed' | 'revoked';
export interface MonitorProposal extends UptimeMonitorInput { id: string; name: string; kind: 'http' | 'keyword' | 'health-json' | 'tcp'; existingMonitorId?: string; }
export interface OnboardingResult { monitors: Array<{ id: string; name: string }>; targetIds: string[]; }
interface Session {
  id: string; hash: Buffer; expiresAt: number; projectId: string | null; status: OnboardingStatus;
  agentName?: string; proposals: MonitorProposal[]; timeline: Array<{ at: string; kind: string }>;
  result?: OnboardingResult; confirming?: Promise<OnboardingResult>; confirmedSelection?: string;
  terminalOrder?: number; receiptExpiresAt?: number;
}
export class OnboardingError extends Error { constructor(public status: number, message: string) { super(message); } }
const FIELDS = new Set(['name', 'kind', 'url', 'host', 'port', 'method', 'expectedStatus', 'keyword', 'healthComponentId', 'healthField', 'healthOp', 'healthValue', 'intervalSeconds', 'timeoutMs', 'environment', 'observeMode', 'sampleCountPath']);
const hash = (value: string): Buffer => createHash('sha256').update(value).digest();
const id = (): string => randomBytes(16).toString('hex');
const COMPLETED_RECEIPT_GRACE_MS = 15 * 60_000;
const probeIdentity = (m: UptimeCustomMonitor): string => JSON.stringify([m.projectId || null, m.kind, m.url || null, m.host || null, m.port || null,
  m.method || 'GET', m.expectedStatus || '200-399', m.keyword || null, m.healthComponentId || null, m.healthField || 'observedValue', m.healthOp || 'eq', m.healthValue ?? null]);

/** A token can only contribute drafts to one owner-created session. It never grants CDS API identity. */
export class MonitorOnboardingService {
  private sessions = new Map<string, Session>();
  private terminalSequence = 0;
  constructor(private deps: {
    store: UptimeMonitorStore;
    now?: () => number;
    getNotifications?: () => MonitorNotificationSettings;
    setNotifications?: (settings: MonitorNotificationSettings) => void;
    listChannelIds?: () => string[];
    stampPreviewBranch?: (monitor: UptimeCustomMonitor) => void;
    refreshTarget?: (targetId: string) => boolean;
    forgetTarget?: (targetId: string) => boolean;
  }) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private retentionExpiresAt(s: Session): number {
    return s.status === 'completed' ? s.receiptExpiresAt ?? s.expiresAt : s.expiresAt;
  }
  private prune(): void {
    for (const [key, s] of this.sessions) if (this.retentionExpiresAt(s) <= this.now() && !s.confirming) this.sessions.delete(key);
    // Canceled dialogs must not consume live capacity or evict recent idempotent confirmations.
    // Keep at most 100 live sessions plus 100 results and 100 revoked-session receipts.
    for (const status of ['completed', 'revoked'] as const) {
      const history = [...this.sessions.values()].filter(s => s.status === status)
        .sort((a, b) => (a.terminalOrder ?? 0) - (b.terminalOrder ?? 0));
      for (const s of history.slice(0, Math.max(0, history.length - 100))) this.sessions.delete(s.id);
    }
  }
  private event(s: Session, kind: string): void { s.timeline.push({ at: new Date(this.now()).toISOString(), kind }); }
  private session(sessionId: string): Session {
    const s = this.sessions.get(sessionId);
    if (!s) throw new OnboardingError(404, '接入会话不存在，请重新开始。');
    if (this.retentionExpiresAt(s) <= this.now() && !s.confirming) { this.sessions.delete(sessionId); throw new OnboardingError(410, '接入令牌已过期，请重新开始。'); }
    return s;
  }
  create(input: { ttlHours?: unknown; projectId?: unknown } = {}): Record<string, unknown> {
    this.prune();
    const activeCount = [...this.sessions.values()].filter(s => s.status !== 'completed' && s.status !== 'revoked').length;
    if (activeCount >= 100) throw new OnboardingError(429, '待处理接入会话过多，请关闭旧会话后重试。');
    const ttlHours = input.ttlHours === undefined ? 24 : input.ttlHours;
    if (ttlHours !== 1 && ttlHours !== 24) throw new OnboardingError(400, '有效期仅支持 1 小时或 24 小时。');
    if (input.projectId !== undefined && input.projectId !== null && typeof input.projectId !== 'string') throw new OnboardingError(400, '归属项目无效。');
    const projectId = typeof input.projectId === 'string' && input.projectId.trim() ? input.projectId.trim() : null;
    if (projectId && (!this.deps.store.getProject || !this.deps.store.getProject(projectId))) throw new OnboardingError(400, '归属项目不存在。');
    const token = `cdsmon_${randomBytes(32).toString('base64url')}`;
    const s: Session = { id: id(), hash: hash(token), expiresAt: this.now() + ttlHours * 3_600_000, projectId, status: 'waiting', proposals: [], timeline: [] };
    this.event(s, 'created'); this.sessions.set(s.id, s);
    return { ...this.view(s.id), token, scope: 'propose-only' };
  }
  view(sessionId: string): Record<string, unknown> {
    const s = this.session(sessionId);
    return structuredClone({ id: s.id, expiresAt: s.expiresAt, projectId: s.projectId, status: s.status, agentName: s.agentName, timeline: s.timeline, proposals: s.proposals, ...(s.result ? { result: s.result } : {}) });
  }
  private agent(sessionId: string, token: string): Session {
    const s = this.sessions.get(sessionId); const actual = hash(token);
    const matches = timingSafeEqual(s?.hash ?? Buffer.alloc(32), actual);
    if (!s || !matches || s.expiresAt <= this.now() || s.status === 'revoked' || s.status === 'completed' || s.status === 'confirming') throw new OnboardingError(401, '接入令牌无效、已完成或已过期。');
    return s;
  }
  instructions(sessionId: string, token: string, agentName?: unknown): Record<string, unknown> {
    const s = this.agent(sessionId, token);
    if (!s.agentName) s.agentName = this.agentName(typeof agentName === 'string' && agentName.includes(token) ? undefined : agentName);
    if (s.status === 'waiting') { s.status = 'connected'; this.event(s, 'connected'); this.event(s, 'instructions-read'); }
    return { scope: 'propose-only', expiresAt: s.expiresAt, submitPath: `/api/uptime/onboarding-agent/${s.id}/proposals`,
      instructions: '只提交只读监控提议，不会立即执行检查或创建监控。每项应有 name、kind 和 url（TCP 为 host、port）。kind 仅支持 http、keyword、health-json、tcp。HTTP 仅 GET/HEAD。不要提交凭据、请求头、密钥或任何业务写操作。由用户逐项确认后生效。',
      example: { agentName: 'my-service-agent', proposals: [{ name: '我的服务 · 健康检查', kind: 'http', url: 'https://service.example/healthz', method: 'GET', expectedStatus: '200-299' }] } };
  }
  private agentName(value: unknown): string {
    return typeof value === 'string' && /^[^\u0000-\u001f\u007f]{1,80}$/.test(value.trim()) ? value.trim() : '已连接的智能体';
  }
  submit(sessionId: string, token: string, input: unknown): Record<string, unknown> {
    const s = this.agent(sessionId, token);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new OnboardingError(400, '请提交监控提议对象。');
    if (Buffer.byteLength(JSON.stringify(input)) > 65_536) throw new OnboardingError(413, '提议内容过大，请减少监控项。');
    if (JSON.stringify(input).includes(token)) throw new OnboardingError(400, '提议不能包含接入令牌。');
    const body = input as { agentName?: unknown; proposals?: unknown };
    if (!Array.isArray(body.proposals) || body.proposals.length < 1 || body.proposals.length > 20) throw new OnboardingError(400, '每次需提交 1–20 项监控提议。');
    const identities = new Set<string>();
    const next: MonitorProposal[] = body.proposals.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OnboardingError(400, '监控提议格式无效。');
      const v = value as Record<string, unknown>;
      if (Object.keys(v).some(key => !FIELDS.has(key))) throw new OnboardingError(400, '提议包含不允许的字段；只可提交只读监控定义。');
      if (!['http', 'keyword', 'health-json', 'tcp'].includes(String(v.kind))) throw new OnboardingError(400, '仅支持只读 HTTP、自检、关键字或 TCP 监控。');
      if (String(v.method || 'GET').toUpperCase() !== 'GET' && String(v.method).toUpperCase() !== 'HEAD') throw new OnboardingError(400, '监控提议只允许 GET 或 HEAD 请求。');
      if (typeof v.url === 'string') {
        let u: URL; try { u = new URL(v.url); } catch { throw new OnboardingError(400, '监控地址无效。'); }
        if (u.username || u.password || u.search || u.hash) throw new OnboardingError(400, '请使用不包含凭据、查询参数和片段的监控地址。');
      }
      const proposalId = id();
      const normalized = normalizeUptimeMonitorInput({ ...v, id: proposalId, projectId: s.projectId, enabled: true });
      if (!normalized.ok) throw new OnboardingError(400, normalized.error);
      const identity = probeIdentity(normalized.monitor);
      if (identities.has(identity)) throw new OnboardingError(400, '本次提议含重复监控，请合并后重新提交。');
      identities.add(identity);
      const existing = this.deps.store.listUptimeMonitors().find(m => probeIdentity(m) === identity);
      const clean: Record<string, unknown> = {};
      for (const key of FIELDS) if (v[key] !== undefined) clean[key] = v[key];
      return { ...clean, id: proposalId, name: normalized.monitor.name, kind: normalized.monitor.kind, ...(existing ? { existingMonitorId: existing.id } : {}) } as MonitorProposal;
    });
    if (!s.agentName) s.agentName = this.agentName(body.agentName);
    // A reviewed set is immutable: late agent messages cannot change what the owner is confirming.
    if (s.status === 'proposed') throw new OnboardingError(409, '提议已提交，请等待用户确认；修改需重新开始接入。');
    s.proposals = next; s.status = 'proposed'; this.event(s, 'proposals-submitted');
    return { ok: true, count: next.length, status: s.status };
  }
  revoke(sessionId: string): void {
    const s = this.session(sessionId);
    if (s.confirming) throw new OnboardingError(409, '正在保存已确认的监控，请等待完成。');
    s.status = 'revoked'; s.hash = randomBytes(32); s.proposals = []; s.terminalOrder = ++this.terminalSequence; this.event(s, 'revoked'); this.prune();
  }
  confirm(sessionId: string, input: { proposalIds?: unknown; channelIds?: unknown }): Promise<OnboardingResult> {
    const s = this.session(sessionId);
    if (!Array.isArray(input.proposalIds) || !input.proposalIds.length || input.proposalIds.some(v => typeof v !== 'string')) throw new OnboardingError(400, '请选择要追加的监控项。');
    const ids = [...new Set(input.proposalIds as string[])].sort();
    if (ids.length !== input.proposalIds.length || ids.some(key => !s.proposals.some(p => p.id === key))) throw new OnboardingError(400, '所选监控不属于本次提议。');
    let channels: string[] | undefined;
    if (input.channelIds !== undefined) {
      if (!Array.isArray(input.channelIds) || input.channelIds.some(v => typeof v !== 'string') || input.channelIds.length > 100) throw new OnboardingError(400, '通知通道选择无效。');
      channels = [...new Set(input.channelIds as string[])].sort();
    }
    const selection = JSON.stringify({ ids, channels });
    if (s.status === 'completed' && s.result && s.confirmedSelection === selection) return Promise.resolve(structuredClone(s.result));
    if (s.confirming) {
      if (s.confirmedSelection !== selection) throw new OnboardingError(409, '正在保存另一组选择，请等待完成。');
      return s.confirming.then(result => structuredClone(result));
    }
    if (s.status !== 'proposed') throw new OnboardingError(409, '当前接入会话无法确认，请重新开始。');
    if (channels !== undefined) {
      const known = new Set(this.deps.listChannelIds?.() ?? []);
      if (channels.some(value => !known.has(value))) throw new OnboardingError(400, '通知通道已不存在，请刷新后重试。');
      if (!this.deps.getNotifications || !this.deps.setNotifications) throw new OnboardingError(503, '通知设置尚未接入。');
    }
    const monitors = ids.map(key => {
      const draft = s.proposals.find(p => p.id === key)!;
      const normalized = normalizeUptimeMonitorInput({ ...draft, projectId: s.projectId, enabled: true });
      if (!normalized.ok) throw new OnboardingError(400, normalized.error);
      const m = normalized.monitor;
      if (m.projectId && (!this.deps.store.getProject || !this.deps.store.getProject(m.projectId))) throw new OnboardingError(400, '归属项目已不存在。');
      if (this.deps.store.getUptimeMonitor(m.id)) throw new OnboardingError(409, '监控标识已存在，请重新开始。');
      if (this.deps.store.listUptimeMonitors().some(existing => probeIdentity(existing) === probeIdentity(m))) throw new OnboardingError(409, '所选监控已在订阅中，请取消该项或重新开始。');
      m.createdBy = `${s.agentName || '智能体'}提议 · 用户确认`;
      m.createdByKind = 'human'; m.origin = 'manual';
      this.deps.stampPreviewBranch?.(m); return m;
    });
    s.status = 'confirming'; s.confirmedSelection = selection;
    const previousNotifications = this.deps.getNotifications ? structuredClone(this.deps.getNotifications()) : undefined;
    const saved: UptimeCustomMonitor[] = [];
    s.confirming = (async () => {
      try {
        for (const m of monitors) saved.push(this.deps.store.upsertUptimeMonitor(m));
        if (channels !== undefined) {
          const settings = structuredClone(this.deps.getNotifications!()); settings.overrides ??= {};
          for (const m of saved) settings.overrides[customProbeTargetId(m)] = channels;
          this.deps.setNotifications!(settings);
        }
        await this.deps.store.flush?.();
        // Register an empty, unknown record immediately; this neither probes nor emits an alert.
        for (const m of saved) {
          if (this.deps.refreshTarget && !this.deps.refreshTarget(customProbeTargetId(m))) throw new Error('target registration failed');
        }
        s.result = { monitors: saved.map(m => ({ id: m.id, name: m.name })), targetIds: saved.map(customProbeTargetId) };
        // Preserve a bounded owner receipt if persistence crossed the agent token's deadline.
        // Reads/retries never renew it, and agent() still checks the original token expiry.
        s.receiptExpiresAt = Math.max(s.expiresAt, this.now() + COMPLETED_RECEIPT_GRACE_MS);
        s.status = 'completed'; s.hash = randomBytes(32); s.terminalOrder = ++this.terminalSequence; this.event(s, 'completed'); this.prune();
        return structuredClone(s.result);
      } catch {
        for (const m of saved) this.deps.store.removeUptimeMonitor(m.id);
        for (const m of saved) this.deps.forgetTarget?.(customProbeTargetId(m));
        if (previousNotifications && this.deps.getNotifications && this.deps.setNotifications) {
          const current = structuredClone(this.deps.getNotifications());
          for (const key of ['overrides', 'mutedUntil', 'acknowledgedAt'] as const) {
            const next = { ...(current[key] ?? {}) };
            for (const m of saved) {
              const targetId = customProbeTargetId(m);
              if (Object.prototype.hasOwnProperty.call(previousNotifications[key] ?? {}, targetId)) next[targetId] = previousNotifications[key]![targetId] as never;
              else delete next[targetId];
            }
            if (Object.keys(next).length || previousNotifications[key] !== undefined) current[key] = next as never;
            else delete current[key];
          }
          this.deps.setNotifications(current);
        }
        await this.deps.store.flush?.().catch(() => undefined);
        s.status = 'proposed'; s.confirmedSelection = undefined;
        throw new OnboardingError(503, '监控保存未完成，未保留本次追加，请重试。');
      } finally { s.confirming = undefined; }
    })();
    return s.confirming;
  }
}
