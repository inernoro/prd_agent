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

  // 把 caller 标识哈希成 session key(用 AI access key / cookie token / IP 兜底)
  const callerKeyFor = (req: Request): string => {
    const aiKey = String(req.headers['x-ai-access-key'] || '').trim();
    const cookieToken = (req.headers.cookie || '').match(/cds_token=([^;]+)/)?.[1] || '';
    const raw = aiKey || cookieToken || String(req.socket?.remoteAddress || 'anon');
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  };

  router.get('/cds-system/operator/ops', (_req, res) => {
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

  router.post('/cds-system/operator/requests/:id/approve', (req, res) => {
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

  router.post('/cds-system/operator/requests/:id/reject', (req, res) => {
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

  router.get('/cds-system/operator/requests/:id', (req, res) => {
    const r = operatorApprovalService.get(req.params.id);
    if (!r) { res.status(404).json({ ok: false, error: 'not found' }); return; }
    res.json({ ok: true, request: r });
  });

  router.get('/cds-system/operator/requests', (_req, res) => {
    res.json({
      ok: true,
      pending: operatorApprovalService.listPending(),
      recent: operatorApprovalService.listRecent(20),
      sessions: operatorApprovalService.listSessions(),
    });
  });

  router.post('/cds-system/operator/run', async (req: Request, res: Response) => {
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
    if (op.confirmText && confirmText !== op.confirmText) {
      res.status(400).json({
        ok: false,
        error: 'confirmation required',
        confirmText: op.confirmText,
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
