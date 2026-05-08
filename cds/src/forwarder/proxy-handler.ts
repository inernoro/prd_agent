/**
 * Forwarder HTTP / SSE / WebSocket 代理(B'.2-forwarder)
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md C-1.2 / C-3.3 / C-4.4 / C-5.1。
 *
 * 职责:
 *   1. 给定 RouteRecord(由 resolver 返回)+ 客户端 req/res,把请求 pipe 到 upstream
 *   2. 透传 headers + 累积 X-Forwarded-For + Host + X-Forwarded-Proto
 *   3. SSE / 长连接不缓冲;客户端断开释放 upstream
 *   4. WebSocket Upgrade 双向 socket pipe
 *   5. 失败:upstream 拒接 → 503;upstream 超时 → 504;upstream reset → 502;无路由 → 503
 *   6. 暴露 getStats() 滑动窗口统计
 *
 * 设计要点:
 *   - 用 Node 内置 http.request,**不**引第三方 lib
 *   - upstreamHost / upstreamPort 全部来自路由表,client headers 不能改写
 *   - keepalive Agent 复用上游连接(socket leak 防御)
 *   - getStats 内部用环形 latency 数组 + 60s 时间窗口 RPS
 */

import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { ProxyStats, RouteRecord } from './types.js';

export interface ProxyHandlerOptions {
  /** upstream 连接超时 ms,默认 5000(connect 5s 无应答 → 504) */
  upstreamTimeoutMs?: number;
  /** 等候页文案 */
  waitingPageHtml?: string;
  /** keepalive agent(可注入测试) */
  agent?: http.Agent;
  /** logger 注入 */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
}

const DEFAULT_WAITING_HTML = 'CDS waiting';

/** 滑动窗口最近 60 秒的请求时间戳 + 最近 N 条延迟。 */
class StatsCollector {
  totalRequests = 0;
  requestsByHost: Map<string, number> = new Map();
  statusCounts: Map<string, number> = new Map();
  errorCount = 0;
  error503Count = 0;
  private latencies: number[] = []; // 环形,只保留最后 1000 条
  private requestTimestamps: number[] = []; // 最近 60s

  record(host: string, status: number, latencyMs: number) {
    this.totalRequests += 1;
    this.requestsByHost.set(host, (this.requestsByHost.get(host) ?? 0) + 1);
    const skey = String(status);
    this.statusCounts.set(skey, (this.statusCounts.get(skey) ?? 0) + 1);
    if (status >= 400) this.errorCount += 1;
    if (status === 503) this.error503Count += 1;
    this.latencies.push(latencyMs);
    if (this.latencies.length > 1000) this.latencies.shift();
    const now = Date.now();
    this.requestTimestamps.push(now);
    // 清理 60s 之外
    const cutoff = now - 60_000;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < cutoff) {
      this.requestTimestamps.shift();
    }
  }

  snapshot(): ProxyStats {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p50 = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length * 0.5)];
    const p99 = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length * 0.99)] ?? sorted[sorted.length - 1];
    const requestsByHost: Record<string, number> = {};
    for (const [k, v] of this.requestsByHost.entries()) requestsByHost[k] = v;
    const statusCounts: Record<string, number> = {};
    for (const [k, v] of this.statusCounts.entries()) statusCounts[k] = v;
    // 60s rps:窗口内总数 / 60(浮点)
    const rps = this.requestTimestamps.length / 60;
    return {
      totalRequests: this.totalRequests,
      requestsByHost,
      statusCounts,
      p50LatencyMs: p50,
      p99LatencyMs: p99,
      last60sRps: rps,
      errorCount: this.errorCount,
      error503Count: this.error503Count,
    };
  }
}

export class ProxyHandler {
  private agent: http.Agent;
  private opts: Required<Pick<ProxyHandlerOptions, 'upstreamTimeoutMs' | 'waitingPageHtml'>> &
    Pick<ProxyHandlerOptions, 'logger'>;
  private stats = new StatsCollector();

  constructor(opts: ProxyHandlerOptions = {}) {
    this.opts = {
      upstreamTimeoutMs: opts.upstreamTimeoutMs ?? 5000,
      waitingPageHtml: opts.waitingPageHtml ?? DEFAULT_WAITING_HTML,
      logger: opts.logger,
    };
    this.agent = opts.agent ?? new http.Agent({ keepAlive: true, maxSockets: 256 });
  }

  /** HTTP 请求处理(SSE/长连接走同一路径,不缓冲) */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    route: RouteRecord | null,
  ): Promise<void> {
    const t0 = Date.now();
    const host = (req.headers.host ?? '').split(':')[0];
    if (!route) {
      this.respondWaiting(res, 503);
      this.stats.record(host, 503, Date.now() - t0);
      return;
    }
    const upstreamHost = route.upstreamHost ?? '127.0.0.1';
    const upstreamPort = route.upstreamPort;

    // 透传 headers + X-Forwarded-* 累积
    const fwdHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      // host 透传给 upstream(让上游看到原始域名)
      fwdHeaders[k] = v as string | string[];
    }
    // X-Forwarded-For:append client IP
    const clientIp = (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
    const existingXff = req.headers['x-forwarded-for'];
    fwdHeaders['x-forwarded-for'] = existingXff
      ? `${Array.isArray(existingXff) ? existingXff.join(', ') : existingXff}, ${clientIp}`
      : clientIp;
    // X-Forwarded-Proto:用上游传入的(nginx 已设),没有就 http
    if (!fwdHeaders['x-forwarded-proto']) {
      fwdHeaders['x-forwarded-proto'] = 'http';
    }
    // Host 字段透传(要求项),如果客户端没有 Host header 就用路由表 host
    if (!fwdHeaders['host']) {
      fwdHeaders['host'] = route.host;
    }

    return new Promise<void>((resolve) => {
      let resolved = false;
      const finish = (status: number) => {
        if (resolved) return;
        resolved = true;
        this.stats.record(host, status, Date.now() - t0);
        resolve();
      };

      const upstream = http.request(
        {
          host: upstreamHost,
          port: upstreamPort,
          method: req.method,
          path: req.url,
          headers: fwdHeaders,
          agent: this.agent,
          timeout: this.opts.upstreamTimeoutMs,
        },
        (upstreamRes) => {
          // 透传 status + headers
          if (!res.headersSent) {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          }
          upstreamRes.on('end', () => finish(upstreamRes.statusCode ?? 502));
          upstreamRes.on('error', () => {
            // upstream 中途 reset
            try {
              if (!res.headersSent) this.respondWaiting(res, 502);
              else res.end();
            } catch {
              // noop
            }
            finish(502);
          });
          upstreamRes.pipe(res);
        },
      );

      upstream.on('timeout', () => {
        try {
          upstream.destroy(new Error('upstream timeout'));
        } catch {
          // noop
        }
        if (!res.headersSent) this.respondWaiting(res, 504);
        else {
          try {
            res.end();
          } catch {
            // noop
          }
        }
        finish(504);
      });

      upstream.on('error', (err) => {
        // ECONNREFUSED 等,503;timeout 已在上面 finish
        if (resolved) return;
        const code = (err as NodeJS.ErrnoException).code;
        // 已发响应头 → 不能再 writeHead,直接 end
        if (res.headersSent) {
          try {
            res.end();
          } catch {
            // noop
          }
          finish(502);
          return;
        }
        if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND') {
          this.respondWaiting(res, 503);
          finish(503);
        } else if (code === 'ECONNRESET') {
          this.respondWaiting(res, 502);
          finish(502);
        } else {
          this.respondWaiting(res, 502);
          finish(502);
        }
      });

      // 客户端断开 → 释放 upstream
      // 注意:只在 res 还在写入(未 end)时,res.close 才表示客户端真断开;
      // 已经 end 的 close 不应触发 upstream destroy。req 的 close 事件
      // 在 Node 20+ 会在 message 结束后触发(即使连接还活着),所以不监听它。
      const onResClose = () => {
        if (res.writableEnded) return;
        if (!upstream.destroyed) upstream.destroy();
      };
      res.on('close', onResClose);

      // 把客户端 body 流式 pipe 到 upstream(支持大 body / SSE / chunked)
      req.pipe(upstream);
    });
  }

  /** WebSocket Upgrade 处理 */
  async handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    route: RouteRecord | null,
  ): Promise<void> {
    if (!route) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstreamHost = route.upstreamHost ?? '127.0.0.1';
    const upstreamPort = route.upstreamPort;

    // 透传 headers
    const fwdHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v != null) fwdHeaders[k] = v as string | string[];
    }
    const clientIp = (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
    const existingXff = req.headers['x-forwarded-for'];
    fwdHeaders['x-forwarded-for'] = existingXff
      ? `${Array.isArray(existingXff) ? existingXff.join(', ') : existingXff}, ${clientIp}`
      : clientIp;

    const upstreamReq = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method ?? 'GET',
      path: req.url,
      headers: fwdHeaders,
    });

    return new Promise<void>((resolve) => {
      upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
        // 把 upstream 的 101 + headers 写回客户端
        const headers = ['HTTP/1.1 101 Switching Protocols'];
        for (const [k, v] of Object.entries(upstreamRes.headers)) {
          if (Array.isArray(v)) {
            for (const vv of v) headers.push(`${k}: ${vv}`);
          } else if (v != null) {
            headers.push(`${k}: ${v}`);
          }
        }
        socket.write(headers.join('\r\n') + '\r\n\r\n');
        if (upstreamHead && upstreamHead.length > 0) socket.write(upstreamHead);
        // 双向 pipe
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
        const cleanup = () => {
          try {
            upstreamSocket.destroy();
          } catch {
            // noop
          }
          try {
            socket.destroy();
          } catch {
            // noop
          }
          resolve();
        };
        upstreamSocket.on('close', cleanup);
        socket.on('close', cleanup);
        upstreamSocket.on('error', cleanup);
        socket.on('error', cleanup);
      });

      upstreamReq.on('error', () => {
        try {
          socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          socket.destroy();
        } catch {
          // noop
        }
        resolve();
      });

      // 把客户端的 head 数据写到 upstreamReq
      if (head && head.length > 0) {
        upstreamReq.write(head);
      }
      upstreamReq.end();
    });
  }

  getStats(): ProxyStats {
    return this.stats.snapshot();
  }

  /** 写 503 / 504 / 502 等候页 */
  private respondWaiting(res: ServerResponse, status: number) {
    if (res.headersSent || res.writableEnded) return;
    try {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(this.opts.waitingPageHtml);
    } catch {
      // noop
    }
  }

  /** 关闭 keepalive agent(测试 / shutdown 用)。 */
  destroy(): void {
    try {
      this.agent.destroy();
    } catch {
      // noop
    }
  }
}
