// GET  /api/cds-system/operator/ops — 列已注册 ops
// POST /api/cds-system/operator/run — 执行 op,SSE 流式返回日志 + 最终结果
//
// 2026-05-28:用户反馈"不希望在前端 agent 和 SSH agent 之间反复 bounce"。
// 本路由提供 CDS Dashboard 一键自助修复运维问题的能力,替代外部 SSH。

import { Router, type Request, type Response } from 'express';
import type { StateService } from '../services/state.js';
import type { IShellExecutor } from '../types.js';
import type { ServerEventLogSink } from '../services/server-event-log-store.js';
import { operatorOpRegistry, type OperatorOpContext } from '../services/operator-console.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';

export function createOperatorConsoleRouter(deps: {
  stateService: StateService;
  shell: IShellExecutor;
  repoRoot: string;
  serverEventLogStore?: ServerEventLogSink | null;
}): Router {
  const router = Router();

  router.get('/cds-system/operator/ops', (_req, res) => {
    res.json({
      ok: true,
      ops: operatorOpRegistry.list(),
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
      deps.serverEventLogStore?.record({
        category: 'system',
        severity: 'info',
        source: 'operator-console',
        action: 'operator.op.completed',
        message: `operator op completed: ${op.id} (${durationMs}ms) — ${result.summary}`,
        details: { opId: op.id, durationMs, summary: result.summary, actor },
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
