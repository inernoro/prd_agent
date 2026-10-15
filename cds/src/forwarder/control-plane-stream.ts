import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface WidgetStreamRecoveryOptions {
  retryIntervalMs?: number;
  recoveryTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxAttempts?: number;
  maxConnections?: number;
}

interface StreamTarget {
  host: string;
  port: number;
  path: string;
  headers: Record<string, string | string[]>;
  agent: http.Agent;
  unavailable: (code: string) => void;
  completed: (status: number) => void;
}

const HOP_HEADERS = new Set(['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);
const bounded = (value: number | undefined, fallback: number, max: number) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error('Invalid widget stream recovery budget');
  return result;
};

/** 仅两条预览挂件流：状态未知显式下发；业务数据仍等原上游鉴权成功，且不缓存/伪造事件。 */
export class ControlPlaneStreams {
  private readonly active = new Set<() => void>();
  private readonly retryMs: number;
  private readonly recoveryMs: number;
  private readonly connectMs: number;
  private readonly attempts: number;
  private readonly capacity: number;
  private failures = 0;
  private recovering = 0;

  constructor(options: WidgetStreamRecoveryOptions = {}) {
    this.retryMs = bounded(options.retryIntervalMs, 1000, 5000);
    this.recoveryMs = bounded(options.recoveryTimeoutMs, 30_000, 30_000);
    this.connectMs = bounded(options.connectTimeoutMs, 2000, 5000);
    this.attempts = bounded(options.maxAttempts, 30, 30);
    this.capacity = bounded(options.maxConnections, 128, 128);
  }

  snapshot() { return { active: this.active.size, recovering: this.recovering, upstreamFailures: this.failures }; }
  destroy() { for (const cancel of [...this.active]) cancel(); }

  serve(req: IncomingMessage, res: ServerResponse, target: StreamTarget): Promise<void> {
    if (this.active.size >= this.capacity) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '3' });
      res.end(JSON.stringify({ error: 'widget_stream_capacity', message: '连接繁忙，请稍后重试。' }));
      target.completed(503);
      return Promise.resolve();
    }
    return new Promise(resolve => {
      let stopped = false, forwarded = false, failureReported = false, recoveryActive = false, count = 0;
      let upstream: http.ClientRequest | undefined, response: IncomingMessage | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
      let connect: ReturnType<typeof setTimeout> | undefined;
      let retireAttempt: (() => void) | undefined;
      const clearTimers = () => { clearTimeout(retry); clearTimeout(deadline); clearTimeout(connect); };
      const done = (status = res.statusCode || 200, destroy = false) => {
        if (stopped) return;
        stopped = true; clearTimers();
        response?.unpipe(res); response?.destroy(); upstream?.destroy();
        if (recoveryActive) { this.recovering--; recoveryActive = false; }
        this.active.delete(cancel);
        res.off('close', cancel);
        if (destroy) res.destroy(); else if (!res.writableEnded) res.end();
        target.completed(status); resolve();
      };
      const cancel = () => done(res.statusCode || 200, true);
      this.active.add(cancel);
      res.once('close', cancel);

      const state = (value: string) => {
        if (!res.headersSent) res.writeHead(200, {
          'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no',
        });
        res.write(`event: cds.transport\ndata: ${JSON.stringify({ state: value, attempt: count })}\n\n`);
      };
      const unavailable = (code: string) => {
        if (stopped) return;
        retireAttempt?.();
        clearTimeout(connect); response?.unpipe(res); response?.destroy(); upstream?.destroy();
        this.failures++;
        if (!failureReported) { failureReported = true; target.unavailable(code); }
        // 已转过真实事件的连接不能拼接重连数据：中断帧交由浏览器丢弃，新连接重新鉴权/补读。
        if (forwarded) { done(); return; }
        if (!recoveryActive) {
          recoveryActive = true; this.recovering++;
          deadline = setTimeout(() => { if (!stopped) { state('unavailable'); done(); } }, this.recoveryMs);
        }
        if (count >= this.attempts) { state('unavailable'); done(); return; }
        state('reconnecting');
        retry = setTimeout(open, this.retryMs);
      };
      const open = () => {
        if (stopped) return;
        let retired = false;
        retireAttempt = () => { retired = true; };
        const fail = (code: string) => {
          if (stopped || retired) return;
          retired = true;
          unavailable(code);
        };
        count++;
        const attempt = http.request({ host: target.host, port: target.port, path: target.path,
          method: 'GET', headers: target.headers, agent: target.agent }, incoming => {
          if (stopped || retired || upstream !== attempt) { incoming.destroy(); return; }
          clearTimeout(connect); response = incoming;
          const status = incoming.statusCode ?? 502;
          if (status >= 500) { fail(`HTTP_${status}`); return; }
          const isStream = status === 200 && String(incoming.headers['content-type'] || '').includes('text/event-stream');
          if (!isStream) {
            if (res.headersSent) { incoming.destroy(); state(status === 401 || status === 403 ? 'forbidden' : 'unavailable'); done(); return; }
            const headers = { ...incoming.headers };
            for (const name of [...HOP_HEADERS, ...String(headers.connection || '').toLowerCase().split(',').map(v => v.trim())]) delete headers[name];
            delete headers['content-length'];
            res.writeHead(status, headers);
            incoming.pipe(res);
            incoming.once('end', () => done(status));
            incoming.once('aborted', () => done(status, true));
            incoming.once('error', () => done(status, true));
            return;
          }
          forwarded = true;
          clearTimeout(deadline);
          if (recoveryActive) { this.recovering--; recoveryActive = false; }
          if (!res.headersSent) {
            const headers = { ...incoming.headers };
            for (const name of [...HOP_HEADERS, ...String(headers.connection || '').toLowerCase().split(',').map(v => v.trim())]) delete headers[name];
            res.writeHead(status, headers);
          }
          state('connected');
          incoming.pipe(res, { end: false }); // Node背压，不保存分支快照或活动缓冲副本。
          incoming.once('end', () => done());
          incoming.once('aborted', () => fail('ECONNRESET'));
          incoming.once('error', () => fail('ECONNRESET'));
        });
        upstream = attempt;
        connect = setTimeout(() => attempt.destroy(Object.assign(new Error('control plane stream connect deadline'), { code: 'ETIMEDOUT' })), this.connectMs);
        attempt.once('error', error => { if (upstream === attempt) fail((error as NodeJS.ErrnoException).code || 'UNKNOWN'); });
        attempt.end();
      };
      open();
    });
  }
}
