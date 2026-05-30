// GET  /api/cds-system/operator/ops — 列已注册 ops
// POST /api/cds-system/operator/run — 执行 op,SSE 流式返回日志 + 最终结果
//
// 2026-05-28:用户反馈"不希望在前端 agent 和 SSH agent 之间反复 bounce"。
// 本路由提供 CDS Dashboard 一键自助修复运维问题的能力,替代外部 SSH。

import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { StateService } from '../services/state.js';
import type { IShellExecutor } from '../types.js';
import type { ServerEventLogSink } from '../services/server-event-log-store.js';
import { operatorOpRegistry, type OperatorOpContext } from '../services/operator-console.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';
import { operatorApprovalService } from '../services/operator-approval.js';

export function createOperatorConsoleRouter(deps: {
  stateService: StateService;
  shell: IShellExecutor;
  repoRoot: string;
  serverEventLogStore?: ServerEventLogSink | null;
}): Router {
  // 初始化审批服务(单例)
  operatorApprovalService.init({
    shell: deps.shell,
    stateService: deps.stateService,
    repoRoot: deps.repoRoot,
    serverEventLogStore: deps.serverEventLogStore,
  });

  const router = Router();

  // ── 人类鉴权门 ────────────────────────────────────────────────────
  // Cursor Bugbot(PR #684, High)+ Codex(P1×2):operator console 能执行 root
  // `shell.run`、审批/拒绝请求。此前只靠全局中间件(放行 AI access key / 项目级
  // cdsp_ key),导致 *任何* 认证调用方(含 AI、含 project key)都能:
  //   1. POST /operator/run 直接以 root 跑任意 shell
  //   2. POST /operator/request 自己发请求,再 POST /approve 自审自批,绕过弹窗
  //   3. GET /operator/ops 读到 destructive op 的 confirmText token
  // 修复:这些"管理员动作"必须人类 cookie 鉴权(server.ts 给人类 cookie 登录打
  // 的 req._cdsCookieAuth 标记 —— 单租户 CDS 上等同 admin)。AI / project key 一律
  // 403。`/operator/request`(AI 发起待批)与 `/operator/requests/:id`(查自己请求
  // 状态)保持对 AI 开放 —— 这正是"AI 请求 → 人类审批"流程的入口。
  // Codex review(PR #684):basic-auth 模式下 server.ts 打 _cdsCookieAuth;但
  // CDS_AUTH_MODE=github 模式下 github-auth 中间件只打 req.cdsUser/cdsSession,
  // 不打 _cdsCookieAuth。原来只认 _cdsCookieAuth 会把 GitHub 登录的管理员一律 403,
  // 整个 operator console 在 github 模式不可用。这里同时接受"已验证的 GitHub 会话"。
  const isHumanAdmin = (req: Request): boolean => {
    if ((req as { _cdsCookieAuth?: boolean })._cdsCookieAuth === true) return true;
    // github-auth 中间件验证通过才会同时挂 cdsUser + cdsSession(机器密钥不会)
    const r = req as { cdsUser?: unknown; cdsSession?: unknown };
    return !!r.cdsUser && !!r.cdsSession;
  };
  const requireHuman = (req: Request, res: Response, next: () => void): void => {
    if (isHumanAdmin(req)) { next(); return; }
    res.status(403).json({
      ok: false,
      error: 'human_auth_required',
      message: '该运维操作只允许已登录的人类管理员(CDS cookie 或 GitHub 会话)执行,AI / 项目级密钥被拒绝。',
    });
  };

  // 把 caller 标识哈希成 session key。Codex review(PR #684, P1):session 审批
  // 必须绑定到"实际鉴权身份",否则同一 host/NAT 下另一个 AI/project key 会蹭到
  // 7 天 session 自动跑同一 root 命令。因此优先用真实凭据(含 Authorization Bearer
  // 与 ai-access-key 别名 + GitHub 会话 id),IP 仅作最末兜底。
  const callerKeyFor = (req: Request): string => {
    const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    const aiKey = String(req.headers['x-ai-access-key'] || req.headers['ai-access-key'] || '').trim();
    const sessionId = (req as { cdsSession?: { id?: string } }).cdsSession?.id || '';
    const cookieToken = (req.headers.cookie || '').match(/cds_token=([^;]+)/)?.[1] || '';
    const raw = sessionId || bearer || aiKey || cookieToken || String(req.socket?.remoteAddress || 'anon');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  };

  router.get('/cds-system/operator/ops', requireHuman, (_req, res) => {
    res.json({
      ok: true,
      ops: operatorOpRegistry.list(),
    });
  });

  // ── 弹窗审批流(AI 发起) ────────────────────────────────────────
  router.post('/cds-system/operator/request', async (req, res) => {
    const { opId, args } = (req.body ?? {}) as { opId?: string; args?: Record<string, unknown> };
    if (!opId || typeof opId !== 'string') {
      res.status(400).json({ ok: false, error: 'opId 必填' });
      return;
    }
    const actor =
      (req as { cdsUser?: { githubLogin?: string; login?: string } }).cdsUser?.githubLogin ||
      (req as { cdsUser?: { githubLogin?: string; login?: string } }).cdsUser?.login ||
      resolveActorFromRequest(req) ||
      'ai';
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress;
    const callerKey = callerKeyFor(req);
    const pending = await operatorApprovalService.submitRequest({ opId, args, actor, ip, callerKey });
    res.status(pending.status === 'pending' ? 202 : 200).json({
      ok: pending.status !== 'rejected',
      request: pending,
    });
  });

  router.post('/cds-system/operator/requests/:id/approve', requireHuman, (req, res) => {
    const scope = (req.body ?? {}).scope === 'session' ? 'session' : 'once';
    const approver =
      (req as { cdsUser?: { githubLogin?: string; login?: string } }).cdsUser?.githubLogin ||
      (req as { cdsUser?: { githubLogin?: string; login?: string } }).cdsUser?.login ||
      resolveActorFromRequest(req) ||
      'admin';
    const updated = operatorApprovalService.approve({ requestId: req.params.id, scope, approver });
    if (!updated) {
      res.status(404).json({ ok: false, error: 'request not found 或已审批' });
      return;
    }
    res.json({ ok: true, request: updated });
  });

  router.post('/cds-system/operator/requests/:id/reject', requireHuman, (req, res) => {
    const approver =
      (req as { cdsUser?: { githubLogin?: string; login?: string } }).cdsUser?.githubLogin ||
      (req as { cdsUser?: { githubLogin?: string; login?: string } }).cdsUser?.login ||
      resolveActorFromRequest(req) ||
      'admin';
    const updated = operatorApprovalService.reject({ requestId: req.params.id, approver });
    if (!updated) {
      res.status(404).json({ ok: false, error: 'request not found 或已审批' });
      return;
    }
    res.json({ ok: true, request: updated });
  });

  // Cursor Bugbot(PR #684, Medium):该端点返回 PendingRequest,内含 result.details
  // (shell.run 的完整 stdout/stderr)、args(实际 shell 命令)、执行 logs。原来无
  // 任何校验,任意认证调用方(含 project-scoped cdsp_ key)凭 id 即可读任意请求的
  // 系统级敏感数据。改为「人类管理员 OR 本请求发起方」:AI 发起方仍能轮询自己请求
  // 的状态(callerKey 匹配),但读不到别人的;人类管理员可读全部。
  router.get('/cds-system/operator/requests/:id', (req, res) => {
    const r = operatorApprovalService.get(req.params.id);
    if (!r) { res.status(404).json({ ok: false, error: 'not found' }); return; }
    const owns = r.callerKey && r.callerKey === callerKeyFor(req);
    if (!isHumanAdmin(req) && !owns) {
      res.status(403).json({ ok: false, error: 'forbidden', message: '只能查看自己发起的运维请求,或以人类管理员身份查看全部。' });
      return;
    }
    res.json({ ok: true, request: r });
  });

  router.get('/cds-system/operator/requests', requireHuman, (_req, res) => {
    res.json({
      ok: true,
      pending: operatorApprovalService.listPending(),
      recent: operatorApprovalService.listRecent(20),
      sessions: operatorApprovalService.listSessions(),
    });
  });

  router.post('/cds-system/operator/run', requireHuman, async (req: Request, res: Response) => {
    const { opId, confirmText, args } = (req.body ?? {}) as {
      opId?: string;
      confirmText?: string;
      args?: Record<string, unknown>;
    };
    const actor =
      (req as { cdsUser?: { githubLogin?: string; login?: string } }).cdsUser?.githubLogin ||
      (req as { cdsUser?: { githubLogin?: string; login?: string } }).cdsUser?.login ||
      resolveActorFromRequest(req) ||
      'unknown';

    if (!opId || typeof opId !== 'string') {
      res.status(400).json({ ok: false, error: 'opId is required' });
      return;
    }
    const op = operatorOpRegistry.get(opId);
    if (!op) {
      res.status(404).json({ ok: false, error: `op '${opId}' not found` });
      return;
    }
    // 二次确认 token
    // 2026-05-28 SECURITY:不在错误响应里回显期望的 confirmText —— 否则
    // 调用方一次 400 拿到 token 立刻重发就跳过了"二次确认"。confirmText
    // 是带外协议,只在 op 注册表里可见,客户端必须显式知道才能传。
    if (op.confirmText && confirmText !== op.confirmText) {
      res.status(400).json({
        ok: false,
        error: 'confirmation required',
        hint: '该操作为 destructive,客户端必须传正确的 confirmText 字段。具体值由 op 注册表定义,不再随响应回显。',
      });
      return;
    }

    // SSE 头
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
      (res as { flushHeaders: () => void }).flushHeaders();
    }
    let alive = true;
    req.on('close', () => { alive = false; });
    const send = (event: string, data: unknown): void => {
      if (!alive) return;
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { alive = false; }
    };
    const log = (level: 'info' | 'warning' | 'error', message: string): void => {
      send('log', { level, message, ts: new Date().toISOString() });
    };

    const startedAt = Date.now();
    deps.serverEventLogStore?.record({
      category: 'system',
      severity: 'info',
      source: 'operator-console',
      action: 'operator.op.started',
      message: `operator op started: ${op.id} by ${actor}`,
      details: { opId: op.id, danger: op.danger, actor, args },
    });
    send('started', { opId: op.id, name: op.name, danger: op.danger, actor, startedAt: new Date(startedAt).toISOString() });

    const ctx: OperatorOpContext = {
      shell: deps.shell,
      stateService: deps.stateService,
      repoRoot: deps.repoRoot,
      serverEventLogStore: deps.serverEventLogStore,
      actor,
      log,
    };

    try {
      let result: { summary: string; details?: Record<string, unknown> };
      if (op.id === 'shell.run') {
        // 特例:shell.run 由 router 层处理(需要 body.command)
        const command = String((args ?? {}).command || '').trim();
        if (!command) throw new Error('args.command 不能为空');
        log('warning', `执行 shell: ${command.slice(0, 200)}`);
        const r = await deps.shell.exec(command, { timeout: 60_000 });
        log('info', `exit=${r.exitCode}`);
        result = {
          summary: `shell 命令完成 (exit=${r.exitCode})`,
          details: { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr },
        };
      } else {
        result = await op.run(ctx);
      }
      const durationMs = Date.now() - startedAt;
      send('done', { opId: op.id, durationMs, ...result });
      // 2026-05-28:把 op 的 details(含 shell.run 的 stdout/stderr)也存进
      // server-event-log,这样即便 SSE 流被中间层切断,客户端仍能从
      // /api/server-events 拉回完整产出。stdout/stderr 单字段截断到 32KB
      // 避免单 event 巨大撑爆 log store。
      const truncate = (s: unknown, limit = 32_000): unknown => {
        if (typeof s !== 'string') return s;
        return s.length <= limit ? s : `${s.slice(0, limit)}\n... [truncated ${s.length - limit} chars]`;
      };
      const safeDetails = result.details
        ? Object.fromEntries(
            Object.entries(result.details).map(([k, v]) => [k, truncate(v)]),
          )
        : undefined;
      deps.serverEventLogStore?.record({
        category: 'system',
        severity: 'info',
        source: 'operator-console',
        action: 'operator.op.completed',
        message: `operator op completed: ${op.id} (${durationMs}ms) — ${result.summary}`,
        details: { opId: op.id, durationMs, summary: result.summary, actor, ...(safeDetails ? { output: safeDetails } : {}) },
      });
    } catch (err) {
      const message = (err as Error).message || String(err);
      log('error', message);
      send('failed', { opId: op.id, error: message });
      deps.serverEventLogStore?.record({
        category: 'system',
        severity: 'error',
        source: 'operator-console',
        action: 'operator.op.failed',
        message: `operator op failed: ${op.id} — ${message}`,
        details: { opId: op.id, actor, error: message },
        error: { message },
      });
    } finally {
      try { res.end(); } catch { /* tolerate */ }
    }
  });

  return router;
}
