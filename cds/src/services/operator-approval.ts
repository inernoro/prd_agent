// 运维操作审批管理 — 弹窗式 ai-initiated flow
//
// 2026-05-28 用户反馈:不希望进 UI 一个个点 op,要 AI 发起 + 全局弹窗 +
// 一键允许本次或本 session 所有同类请求。
//
// 数据模型:
//   - PendingRequest: 一次具体的 op 请求 (id, opId, args, requestedBy, status, result)
//   - SessionApproval: 同一个 caller(access key 哈希)+同一个 opId 在 1h 内自动通过
//
// 流程:
//   1. AI POST /operator/request {opId, args} → 检查 session 自动通过 → 直接 run
//                                              → 否则创建 pending,返 202 + requestId
//                                                  并 bus.publish 'operator.request.created'
//   2. 任意页面订阅 cds-events 的 operator.request.* → 全局 Modal 显示
//   3. 用户点「允许本次」→ POST /operator/requests/:id/approve {scope:'once'}
//      用户点「允许 session」→ POST /operator/requests/:id/approve {scope:'session'}
//      用户点「拒绝」→ POST /operator/requests/:id/reject
//   4. backend 执行 op,bus.publish 'operator.request.completed'/'failed'
//   5. AI 通过 GET /operator/requests/:id 轮询或订阅 cds-events 拿结果

import crypto from 'node:crypto';
import { cdsEventsBus } from './cds-events-bus.js';
import { operatorOpRegistry, type OperatorOpContext } from './operator-console.js';
import type { IShellExecutor } from '../types.js';
import type { StateService } from './state.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

export type RequestStatus =
  | 'pending'        // 等待审批
  | 'approved'       // 已批,在跑
  | 'completed'      // 跑完成功
  | 'failed'         // 跑完失败
  | 'rejected'       // 用户拒绝
  | 'expired';       // 超时未审批(默认 5min)

export interface PendingRequest {
  id: string;
  opId: string;
  opName: string;
  opDanger: 'safe' | 'sensitive' | 'destructive';
  args?: Record<string, unknown>;
  requestedBy: string;     // actor
  requestedFromIp?: string;
  requestedAt: string;
  callerKey: string;       // hash for session lookup
  status: RequestStatus;
  approvedBy?: string;
  approvedAt?: string;
  approvedScope?: 'once' | 'session';
  rejectedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: { summary: string; details?: Record<string, unknown> };
  error?: string;
  logs: Array<{ ts: string; level: 'info' | 'warning' | 'error'; message: string }>;
}

interface SessionApproval {
  callerKey: string;
  opId: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 60 * 60 * 1000;    // 1 小时
const REQUEST_TTL_MS = 5 * 60 * 1000;     // 5 分钟未审批自动 expire
const REQUEST_HISTORY_MAX = 200;

class OperatorApprovalService {
  private requests = new Map<string, PendingRequest>();
  private sessions = new Map<string, SessionApproval>(); // key: `${callerKey}::${opId}`
  private shell: IShellExecutor | null = null;
  private stateService: StateService | null = null;
  private repoRoot: string = '';
  private logStore: ServerEventLogSink | null = null;

  init(opts: {
    shell: IShellExecutor;
    stateService: StateService;
    repoRoot: string;
    serverEventLogStore?: ServerEventLogSink | null;
  }): void {
    this.shell = opts.shell;
    this.stateService = opts.stateService;
    this.repoRoot = opts.repoRoot;
    this.logStore = opts.serverEventLogStore ?? null;
  }

  /**
   * AI agent 调用入口。三种返回:
   *   - { status: 'completed', requestId, result } — session 已批,直接执行完成
   *   - { status: 'pending', requestId } — 等用户审批,bus 已通知 dashboard
   *   - { status: 'rejected', requestId, error } — caller 已被禁用 / 校验失败
   */
  async submitRequest(opts: {
    opId: string;
    args?: Record<string, unknown>;
    actor: string;
    ip?: string;
    callerKey: string;
  }): Promise<PendingRequest> {
    const op = operatorOpRegistry.get(opts.opId);
    if (!op) {
      const req: PendingRequest = {
        id: this.genId(),
        opId: opts.opId,
        opName: opts.opId,
        opDanger: 'safe',
        args: opts.args,
        requestedBy: opts.actor,
        requestedFromIp: opts.ip,
        requestedAt: new Date().toISOString(),
        callerKey: opts.callerKey,
        status: 'rejected',
        error: `op '${opts.opId}' not found`,
        logs: [],
      };
      this.persist(req);
      return req;
    }

    const req: PendingRequest = {
      id: this.genId(),
      opId: op.id,
      opName: op.name,
      opDanger: op.danger,
      args: opts.args,
      requestedBy: opts.actor,
      requestedFromIp: opts.ip,
      requestedAt: new Date().toISOString(),
      callerKey: opts.callerKey,
      status: 'pending',
      logs: [],
    };
    this.persist(req);

    // 检查 session 自动通过
    const sessionKey = `${opts.callerKey}::${op.id}`;
    const session = this.sessions.get(sessionKey);
    if (session && session.expiresAt > Date.now()) {
      req.status = 'approved';
      req.approvedBy = session.approvedBy;
      req.approvedAt = new Date().toISOString();
      req.approvedScope = 'session';
      this.persist(req);
      this.logEvent('operator.request.auto-approved', req, `session approved by ${session.approvedBy}`);
      // 异步执行
      void this.executeRequest(req);
      return req;
    }

    publishOperatorEvent('operator.request.created', { request: req });
    this.logEvent('operator.request.created', req, `AI 请求执行 op ${op.id}`);
    // 设 expire 计时器
    setTimeout(() => this.maybeExpire(req.id), REQUEST_TTL_MS + 500).unref?.();
    return req;
  }

  approve(opts: {
    requestId: string;
    scope: 'once' | 'session';
    approver: string;
  }): PendingRequest | null {
    const req = this.requests.get(opts.requestId);
    if (!req || req.status !== 'pending') return null;
    req.status = 'approved';
    req.approvedBy = opts.approver;
    req.approvedAt = new Date().toISOString();
    req.approvedScope = opts.scope;
    if (opts.scope === 'session') {
      const sessionKey = `${req.callerKey}::${req.opId}`;
      this.sessions.set(sessionKey, {
        callerKey: req.callerKey,
        opId: req.opId,
        approvedBy: opts.approver,
        approvedAt: req.approvedAt,
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
    }
    this.persist(req);
    this.logEvent('operator.request.approved', req, `${opts.approver} 已允许(${opts.scope})`);
    publishOperatorEvent('operator.request.approved', { request: req });
    void this.executeRequest(req);
    return req;
  }

  reject(opts: { requestId: string; approver: string }): PendingRequest | null {
    const req = this.requests.get(opts.requestId);
    if (!req || req.status !== 'pending') return null;
    req.status = 'rejected';
    req.rejectedAt = new Date().toISOString();
    req.approvedBy = opts.approver;
    this.persist(req);
    this.logEvent('operator.request.rejected', req, `${opts.approver} 拒绝`);
    publishOperatorEvent('operator.request.rejected', { request: req });
    return req;
  }

  get(requestId: string): PendingRequest | null {
    return this.requests.get(requestId) ?? null;
  }

  listPending(): PendingRequest[] {
    return [...this.requests.values()]
      .filter((r) => r.status === 'pending')
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  listRecent(limit = 20): PendingRequest[] {
    return [...this.requests.values()]
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .slice(0, limit);
  }

  listSessions(): SessionApproval[] {
    const now = Date.now();
    return [...this.sessions.values()].filter((s) => s.expiresAt > now);
  }

  revokeSession(callerKey: string, opId: string): boolean {
    return this.sessions.delete(`${callerKey}::${opId}`);
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private async executeRequest(req: PendingRequest): Promise<void> {
    if (!this.shell || !this.stateService) {
      req.status = 'failed';
      req.error = 'approval service not initialized';
      this.persist(req);
      publishOperatorEvent('operator.request.failed', { request: req });
      return;
    }
    const op = operatorOpRegistry.get(req.opId);
    if (!op) {
      req.status = 'failed';
      req.error = `op '${req.opId}' missing at execute time`;
      this.persist(req);
      publishOperatorEvent('operator.request.failed', { request: req });
      return;
    }
    req.startedAt = new Date().toISOString();
    const log = (level: 'info' | 'warning' | 'error', message: string): void => {
      const line = { ts: new Date().toISOString(), level, message };
      req.logs.push(line);
      // 限长
      if (req.logs.length > 200) req.logs.splice(0, req.logs.length - 200);
      this.persist(req);
      publishOperatorEvent('operator.request.log', { requestId: req.id, line });
    };
    const ctx: OperatorOpContext = {
      shell: this.shell,
      stateService: this.stateService,
      repoRoot: this.repoRoot,
      serverEventLogStore: this.logStore,
      actor: req.requestedBy,
      log,
    };
    try {
      let result: { summary: string; details?: Record<string, unknown> };
      if (req.opId === 'shell.run') {
        const command = String((req.args ?? {}).command || '').trim();
        if (!command) throw new Error('args.command 不能为空');
        log('warning', `执行 shell: ${command.slice(0, 200)}`);
        const r = await this.shell.exec(command, { timeout: 60_000 });
        log('info', `exit=${r.exitCode}`);
        result = {
          summary: `shell 命令完成 (exit=${r.exitCode})`,
          details: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr },
        };
      } else {
        result = await op.run(ctx);
      }
      req.status = 'completed';
      req.result = result;
      req.finishedAt = new Date().toISOString();
      this.persist(req);
      this.logEvent('operator.request.completed', req, result.summary);
      publishOperatorEvent('operator.request.completed', { request: req });
    } catch (err) {
      req.status = 'failed';
      req.error = (err as Error).message || String(err);
      req.finishedAt = new Date().toISOString();
      this.persist(req);
      this.logEvent('operator.request.failed', req, req.error);
      publishOperatorEvent('operator.request.failed', { request: req });
    }
  }

  private persist(req: PendingRequest): void {
    this.requests.set(req.id, req);
    // 简单 LRU 清理:超过上限就删最老
    if (this.requests.size > REQUEST_HISTORY_MAX) {
      const oldest = [...this.requests.values()]
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))[0];
      if (oldest) this.requests.delete(oldest.id);
    }
  }

  private maybeExpire(requestId: string): void {
    const req = this.requests.get(requestId);
    if (req && req.status === 'pending') {
      req.status = 'expired';
      this.persist(req);
      this.logEvent('operator.request.expired', req, '5 分钟未审批,自动过期');
      publishOperatorEvent('operator.request.rejected', { request: req });
    }
  }

  private genId(): string {
    return `req-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  private logEvent(action: string, req: PendingRequest, message: string): void {
    this.logStore?.record({
      category: 'system',
      severity: action.includes('failed') || action.includes('rejected') ? 'warn' : 'info',
      source: 'operator-approval',
      action,
      message,
      details: { requestId: req.id, opId: req.opId, actor: req.requestedBy, status: req.status },
    });
  }
}

function publishOperatorEvent(
  type:
    | 'operator.request.created'
    | 'operator.request.approved'
    | 'operator.request.rejected'
    | 'operator.request.log'
    | 'operator.request.completed'
    | 'operator.request.failed',
  data: Record<string, unknown>,
): void {
  cdsEventsBus.publish(type, data);
}

export const operatorApprovalService = new OperatorApprovalService();
