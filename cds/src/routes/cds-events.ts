// GET /api/cds-events  — 单一实时事件通道(SSE)
// POST /api/self-refresh — 任务化刷新(202 + jobId)
//
// 2026-05-28 目标:
//   - 浏览器只订阅这一条 SSE,不再各组件分别订阅 self-status/stream / branches/stream
//   - 事件类型严格遵循目标文档:self.status / self.refresh.{started,done,failed} /
//     self.update.{started,step,done,failed} / heartbeat
//   - POST /api/self-refresh 立刻 202 返回 jobId,git fetch 在后台跑,进度走事件流

import { Router, type Request, type Response } from 'express';
import { selfStatusCache, type RefreshTrigger } from '../services/self-status-cache.js';
import { cdsEventsBus, type CdsEventEnvelope } from '../services/cds-events-bus.js';

export function createCdsEventsRouter(): Router {
  const router = Router();

  /**
   * GET /api/cds-events — 单一 SSE 通道
   *
   * 连接后:
   *   1. 立即发一个 `self.status` 事件(当前 snapshot,可能是 cached / lastKnownGood)
   *   2. 后续 bus 的所有事件原样转发(self.refresh.*, self.update.*, self.status)
   *   3. 每 25s 一条 heartbeat,避免 nginx 60s 闲置 timeout
   *   4. 首个客户端连上 + 缓存未跑过完整 refresh → 入队一次"启动 refresh"
   *
   * 鉴权:复用 server.ts 顶层的 auth middleware(本路由挂在 /api 之下)
   * 出错:永不返回 4xx/5xx,即使 snapshot 抛错也只是不发 self.status 而已
   */
  router.get('/cds-events', (req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      // 2026-05-28: Connection: close (原 keep-alive) — 跟 nginx 反代场景里
      // upstream keepalive pool 的 stale-socket race 解耦。SSE 流自身的生命周期
      // 跟 keep-alive 池无关:连接是为了流而不是为了复用。改 close 后 nginx
      // 不会把这条 SSE socket 加进 cds_master upstream 池,根除"下条请求拿到
      // 已 FIN 的 socket → recv RST → 400/502"的 root cause。
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });
    if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
      (res as { flushHeaders: () => void }).flushHeaders();
    }

    let alive = true;
    const write = (envelope: CdsEventEnvelope): boolean => {
      if (!alive) return false;
      try {
        res.write(`event: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`);
        return true;
      } catch {
        alive = false;
        return false;
      }
    };

    // 1) 立即发当前 snapshot(self.status)。snapshot 可能是空的 EMPTY,无碍。
    try {
      const snapshot = selfStatusCache.getSnapshot();
      write({
        type: 'self.status',
        ts: new Date().toISOString(),
        data: snapshot,
      });
    } catch (err) {
      // 失败也不挂连接 — 客户端会等下一条事件
      // eslint-disable-next-line no-console
      console.warn('[cds-events] initial snapshot push failed:', (err as Error).message);
    }

    // 2) 订阅 bus
    const unsubscribe = cdsEventsBus.subscribe((envelope) => {
      write(envelope);
    });

    // 3) heartbeat — 每 25s 一条,带服务端 ts。前端用它做 SSE 连接健康判断。
    const heartbeat = setInterval(() => {
      if (!alive) {
        clearInterval(heartbeat);
        return;
      }
      const ok = write({
        type: 'heartbeat',
        ts: new Date().toISOString(),
        data: {
          subscribers: cdsEventsBus.listenerCount(),
          cacheRefreshAt: selfStatusCache.getSnapshot().lastRefreshAt,
        },
      });
      if (!ok) {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }, 25_000);

    // 4) 客户端断开清理
    req.on('close', () => {
      alive = false;
      clearInterval(heartbeat);
      unsubscribe();
      try { res.end(); } catch { /* tolerate */ }
    });

    // 5) 首个客户端连上 + cache 未跑过完整 refresh → 触发一次。
    //    多客户端连上时由 cache 内部 dedupe(同 trigger 5s 内不重跑),无害。
    const snapshot = selfStatusCache.getSnapshot();
    if (!snapshot.lastRefreshAt || snapshot.lastRefreshTrigger === 'startup') {
      selfStatusCache.enqueueRefresh('stream-subscribe', { dedupeWindowMs: 5_000 });
    }
  });

  /**
   * POST /api/self-refresh — 任务化刷新
   *
   * Body 可选:{ trigger?: 'manual' | ... }(默认 manual)
   *
   * 返回:
   *   - 202 Accepted + { jobId, status: 'queued' | 'running', trigger, startedAt }
   *   - 已有 refresh 在跑 → 仍返 202,jobId/状态指向当前 job(同 id,等价于"已合并到当前请求")
   *   - cache 未初始化 → 200 + { ok: false, degraded: true, reason: 'cache_not_initialized' }
   *
   * 进度/结果走 GET /api/cds-events:
   *   self.refresh.started → self.refresh.done | self.refresh.failed
   */
  router.post('/self-refresh', (req: Request, res: Response) => {
    if (!selfStatusCache.isInitialized()) {
      // 不到这一步不开 cache,所以应该不会命中。但兜底降级。
      res.status(200).json({
        ok: false,
        degraded: true,
        reason: 'cache_not_initialized',
        message: 'self-status cache is not initialized yet',
        data: null,
        lastKnownGood: null,
      });
      return;
    }
    // 校验 trigger(只接受合法值,默认 manual)
    const allowed: RefreshTrigger[] = ['manual', 'webhook', 'startup', 'schedule', 'stream-subscribe'];
    const reqBody = (req.body ?? {}) as { trigger?: string };
    const triggerInput = typeof reqBody.trigger === 'string' ? reqBody.trigger as RefreshTrigger : 'manual';
    const trigger: RefreshTrigger = allowed.includes(triggerInput) ? triggerInput : 'manual';

    const job = selfStatusCache.enqueueRefresh(trigger);
    res.status(202).json({
      ok: true,
      jobId: job.jobId,
      trigger: job.trigger,
      status: job.status,
      startedAt: job.startedAt,
    });
  });

  return router;
}
