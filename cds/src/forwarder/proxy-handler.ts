/**
 * Forwarder HTTP / SSE / WebSocket 代理(B'.2-forwarder)
 *
 * 对应 doc/report.cds-forwarder-success.md
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
import zlib from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { ProxyStats, RouteRecord } from './types.js';
import { buildWidgetScript } from '../widget-script.js';
import { buildForwarderWaitingPageHtml } from './waiting-page.js';
import {
  createBodyCapture,
  createRequestId,
  redactHeaders,
  type HttpLogSink,
} from '../services/http-log-store.js';

export interface ProxyHandlerOptions {
  /** upstream 连接超时 ms,默认 5000(connect 5s 无应答 → 504) */
  upstreamTimeoutMs?: number;
  /** 等候页文案 */
  waitingPageHtml?: string;
  /** keepalive agent(可注入测试) */
  agent?: http.Agent;
  /** logger 注入 */
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  /** 持久化 HTTP 日志 sink；每条请求单独文档写入 Mongo。 */
  httpLogStore?: HttpLogSink | null;
  /** master daemon 的 admin REST 端口(默认 127.0.0.1) */
  masterPassthroughHost?: string;
  /** master daemon 的 admin REST 端口(默认 9900),`/_cds/api/*` 请求转发到此 */
  masterPassthroughPort?: number;
  /**
   * Unknown host fallback:当 route 表查不到 host(分支 building/error/stopped 等
   * 非 running 状态,publisher 不发布)时,转给 master 的 worker proxy 端口
   * (默认 5500),让 master 用 ProxyService.serveStartingPageV2 等丰富等候/错误页
   * 处理。设为 0 或 undefined 关闭 fallback,走原本的 plain text 503 等候页。
   */
  unknownHostFallbackHost?: string;
  /** Unknown host fallback 端口(默认 5500 = master workerPort)。 */
  unknownHostFallbackPort?: number;
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

interface ResolvedProxyOptions {
  upstreamTimeoutMs: number;
  waitingPageHtml: string;
  masterPassthroughHost: string;
  masterPassthroughPort: number;
  unknownHostFallbackHost: string | undefined;
  unknownHostFallbackPort: number | undefined;
  logger: ProxyHandlerOptions['logger'];
  httpLogStore: HttpLogSink | null;
}

export class ProxyHandler {
  private agent: http.Agent;
  private opts: ResolvedProxyOptions;
  private stats = new StatsCollector();

  constructor(opts: ProxyHandlerOptions = {}) {
    this.opts = {
      upstreamTimeoutMs: opts.upstreamTimeoutMs ?? 5000,
      waitingPageHtml: opts.waitingPageHtml ?? DEFAULT_WAITING_HTML,
      masterPassthroughHost: opts.masterPassthroughHost ?? '127.0.0.1',
      masterPassthroughPort: opts.masterPassthroughPort ?? 9900,
      unknownHostFallbackHost: opts.unknownHostFallbackHost,
      unknownHostFallbackPort: opts.unknownHostFallbackPort,
      logger: opts.logger,
      httpLogStore: opts.httpLogStore ?? null,
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
    const requestId = String(req.headers['x-cds-request-id'] || '').trim() || createRequestId();
    req.headers['x-cds-request-id'] = requestId;
    res.setHeader('X-CDS-Request-Id', requestId);
    const requestCapture = createBodyCapture();
    req.on('data', (chunk: Buffer | string) => requestCapture.onChunk(chunk));
    // 原始 URL 留给日志用(/_cds/api/branches → /_cds/api/branches),
    // 不污染 req 共享对象。Cursor Bugbot Low:之前 mutate req.url 让 forward 日志
    // 显示 strip 后的 path,debug 时无法关联客户端原请求。
    const originalUrl = req.url ?? '/';
    let outgoingPath = originalUrl;
    let extraHeaders: Record<string, string> | null = null;

    // /_cds/api/* passthrough(对齐 master proxy.ts:360-373)
    // widget script 通过这个前缀回调 master REST API 获取 branch / bridge / build
    // 数据。**必须**转给 master 端口(默认 9900)而不是分支容器,否则:
    //   widget fetch /_cds/api/branches/stream → forwarder 转给分支容器 → 404
    // 这是 2026-05-08 用户反馈"widget badge 回来了但请求 404"的真因。
    if (originalUrl.startsWith('/_cds/')) {
      const sourceRoute = route;
      outgoingPath = originalUrl.slice(5); // strip "/_cds" → /api/branches/stream
      extraHeaders = {
        'x-cds-internal': '1',
        'x-cds-source-host': host,
        ...(sourceRoute?.branchId ? { 'x-cds-source-branch-id': sourceRoute.branchId } : {}),
      }; // 让 master 跳过外部 auth,同时保留预览来源上下文(本地变量,不 mutate req)
      const masterRoute: RouteRecord = {
        _id: 'master-passthrough',
        host: 'master', // 占位,不参与任何 vhost 比对
        upstreamHost: this.opts.masterPassthroughHost,
        upstreamPort: this.opts.masterPassthroughPort,
        weight: 100,
        // 故意不设 branchId / branchName → widget injection 自动跳过(master REST 不该被注入)
      };
      route = masterRoute;
    }

    if (!route) {
      // Unknown host fallback:转给 master worker proxy(5500),保留原 Host
      // 让 master.ProxyService.handleRequest 自己 detectBranch + serveStartingPageV2
      // 等候/错误页(2026-05-08 用户反馈:刚 deploy 失败的分支看到 plain 503 没意义,
      // master 那边能识别 status=error 给丰富错误页 + 重新部署链接)。
      if (this.opts.unknownHostFallbackHost && this.opts.unknownHostFallbackPort) {
        this.opts.logger?.info?.(
          `[forward] ${req.method ?? 'GET'} ${req.url ?? '/'} → no route for host=${host},fallback to master ${this.opts.unknownHostFallbackHost}:${this.opts.unknownHostFallbackPort}(preserve Host)`,
        );
        route = {
          _id: 'master-unknown-host-fallback',
          host: 'master',
          upstreamHost: this.opts.unknownHostFallbackHost,
          upstreamPort: this.opts.unknownHostFallbackPort,
          weight: 100,
          preserveHost: true, // 关键:master detectBranch 需要看到原 Host header
          // 故意不设 branchId/branchName → forwarder 不注入 widget(master 自己注入)
        };
      } else {
        this.opts.httpLogStore?.record({
          layer: 'forwarder',
          requestId,
          method: req.method || 'GET',
          protocol: String(req.headers['x-forwarded-proto'] || 'http').split(',')[0],
          host,
          path: originalUrl,
          status: 503,
          durationMs: Date.now() - t0,
          outcome: 'server-error',
          remoteAddr: (req.headers['cf-connecting-ip'] as string)
            || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
            || req.socket?.remoteAddress,
          request: {
            headers: redactHeaders(req.headers),
            ...requestCapture.snapshot(),
          },
          response: {
            headers: redactHeaders(res.getHeaders() as Record<string, unknown>),
          },
          error: { code: 'NO_ROUTE', message: `no route for host=${host}` },
        });
        this.respondWaiting(res, 503);
        this.stats.record(host, 503, Date.now() - t0);
        this.opts.logger?.warn?.(
          `[forward] ${req.method ?? 'GET'} ${req.url ?? '/'} → no route for host=${host} (503,无 fallback 配置)`,
        );
        return;
      }
    }
    const upstreamHost = route.upstreamHost ?? '127.0.0.1';
    const upstreamPort = route.upstreamPort;
    const logHttp = (
      status: number,
      response: { bodyPreview?: string; bodyBytes?: number } = {},
      outcome?: 'ok' | 'client-error' | 'server-error' | 'upstream-error' | 'timeout',
      error?: { code?: string; message?: string },
    ) => {
      this.opts.httpLogStore?.record({
        layer: 'forwarder',
        requestId,
        method: req.method || 'GET',
        protocol: String(req.headers['x-forwarded-proto'] || 'http').split(',')[0],
        host,
        path: originalUrl,
        status,
        durationMs: Date.now() - t0,
        outcome: outcome || (status >= 500 ? 'server-error' : status >= 400 ? 'client-error' : 'ok'),
        remoteAddr: (req.headers['cf-connecting-ip'] as string)
          || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
          || req.socket?.remoteAddress,
        branchId: route.branchId ?? null,
        upstream: `${upstreamHost}:${upstreamPort}${outgoingPath !== originalUrl ? outgoingPath : ''}`,
        request: {
          headers: redactHeaders(req.headers),
          ...requestCapture.snapshot(),
        },
        response: {
          headers: redactHeaders(res.getHeaders() as Record<string, unknown>),
          ...response,
        },
        error,
      });
    };
    if (process.env.CDS_FORWARDER_ACCESS_LOG === '1') {
      this.opts.logger?.info?.(
        `[forward] ${req.method ?? 'GET'} ${originalUrl} → ${upstreamHost}:${upstreamPort}${outgoingPath !== originalUrl ? ` (rewrite path → ${outgoingPath})` : ''} (host=${host}, branch=${route.branchId ?? 'unknown'})`,
      );
    }

    // 透传 headers + X-Forwarded-* 累积。先复制 req.headers 不 mutate,
    // 再合并 passthrough 注入的 extraHeaders(如 x-cds-internal)。
    const fwdHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      fwdHeaders[k] = v as string | string[];
    }
    // Hop-by-hop headers belong to the client↔forwarder connection and must
    // not be replayed upstream, otherwise a browser/client `Connection: close`
    // disables the forwarder's keepalive agent and defeats socket reuse.
    for (const key of ['connection', 'proxy-connection', 'keep-alive', 'te', 'trailer', 'upgrade']) {
      delete fwdHeaders[key];
    }
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) fwdHeaders[k] = v;
    }
    fwdHeaders['x-cds-request-id'] = requestId;
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
    // X-Forwarded-Host:原始外部域名(应用如果要做绝对 URL 拼接可消费)
    const originalHost = (req.headers.host ?? route.host) as string;
    if (!fwdHeaders['x-forwarded-host']) {
      fwdHeaders['x-forwarded-host'] = originalHost;
    }
    // Host 字段改写为 upstream 的 hostname:port —— 容器内应用通常以 vhost
    // 路由(nginx server_name / .NET Host filtering / Vite host check),
    // 看不到 127.0.0.1:port 这类内部 host 就返回 404 / "Invalid Host header"。
    // 改写让上游以为是 localhost 直连,与 master ProxyService.proxyRequest 行为对齐
    // (cds/src/services/proxy.ts:912)。原始域名通过 X-Forwarded-Host 暴露给应用。
    //
    // 例外:route.preserveHost=true(unknown host fallback to master)。master 需要原
    // Host 做 detectBranch,看到 127.0.0.1:port 会找不到分支。
    if (!route.preserveHost) {
      fwdHeaders['host'] = `${upstreamHost}:${upstreamPort}`;
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
          path: outgoingPath, // /_cds passthrough 时是 strip 后路径,否则等于 req.url
          headers: fwdHeaders,
          agent: this.agent,
          timeout: this.opts.upstreamTimeoutMs,
        },
        (upstreamRes) => {
          const status = upstreamRes.statusCode ?? 502;
          const contentType = String(upstreamRes.headers['content-type'] || '');
          // 改写后续要透传给客户端的 headers
          const respHeaders: Record<string, string | string[] | undefined> = { ...upstreamRes.headers };
          // Cookie cache control:cookie 含 cds_branch 时禁缓存(对齐 master proxy.ts:971-973)。
          // 防止浏览器在 cookie 路由场景下混用不同分支的 disk cache。
          if (req.headers.cookie?.includes('cds_branch')) {
            respHeaders['cache-control'] = 'no-store, must-revalidate';
            respHeaders['vary'] = 'Cookie';
          }
          if (route.branchId && this.isStaticAssetRequest(req.url || '/')) {
            respHeaders['cache-control'] = 'no-cache, must-revalidate';
          }

          // Widget injection 条件:HTML 200 + route 带 branchId+branchName(对齐
          // master ProxyService.proxyRequest 行为,2026-05-08 用户反馈预览左下角
          // badge 消失时定位到此处缺失)。
          const shouldInjectWidget =
            !!route.branchId &&
            !!route.branchName &&
            contentType.includes('text/html') &&
            status >= 200 && status < 300;

          if (shouldInjectWidget) {
            this.injectWidgetAndSend(upstreamRes, res, route, finish, logHttp, respHeaders);
          } else {
            // 非 HTML 或非 2xx:原样透传(保留压缩 / chunked / SSE 等)
            if (!res.headersSent) {
              res.writeHead(status, respHeaders as http.OutgoingHttpHeaders);
            }
            let bodyBytes = 0;
            const previewChunks: Buffer[] = [];
            const shouldLogApiFailure =
              status >= 400 && (originalUrl.startsWith('/api/') || originalUrl.startsWith('/_cds/api/'));
            upstreamRes.on('data', (chunk: Buffer | string) => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
              bodyBytes += buf.length;
              const captured = previewChunks.reduce((n, part) => n + part.length, 0);
              if (captured < 8 * 1024) previewChunks.push(buf.subarray(0, 8 * 1024 - captured));
            });
            upstreamRes.on('end', () => {
              const bodyPreview = Buffer.concat(previewChunks).toString('utf8').replace(/\0/g, '').trim();
              if (shouldLogApiFailure) {
                this.opts.logger?.warn?.(
                  `[forward] api upstream ${status}: ${req.method ?? 'GET'} ${originalUrl} → ${upstreamHost}:${upstreamPort}${outgoingPath !== originalUrl ? ` path=${outgoingPath}` : ''} (host=${host}, branch=${route.branchId ?? 'unknown'}, requestId=${String(upstreamRes.headers['x-cds-request-id'] || req.headers['x-cds-request-id'] || '-')}, bytes=${bodyBytes}, contentType=${contentType || '-'})${bodyPreview ? ` body="${bodyPreview.slice(0, 240)}"` : ' emptyBody=true'}`,
                );
              }
              logHttp(status, { bodyPreview: bodyPreview || undefined, bodyBytes });
              finish(status);
            });
            upstreamRes.on('error', (err) => {
              logHttp(502, {}, 'upstream-error', { message: err.message });
              try {
                if (!res.headersSent) this.respondWaiting(res, 502);
                else res.end();
              } catch {
                // noop
              }
              finish(502);
            });
            upstreamRes.pipe(res);
          }
        },
      );

      upstream.on('timeout', () => {
        try {
          upstream.destroy(new Error('upstream timeout'));
        } catch {
          // noop
        }
        logHttp(504, {}, 'timeout', { code: 'ETIMEDOUT', message: 'upstream timeout' });
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
        // 错误码 hint — **必须与 cds/src/services/proxy.ts:1033-1039 同步**
        // (/human-verify finding #3)。master 改 hint 时这里也要同步,
        // 否则 forwarder 与 master 的 debug 文案不一致。
        const ERR_HINTS: Record<string, string> = {
          ECONNREFUSED: '上游端口未监听 — 容器可能没启动完或服务崩了',
          ECONNRESET: '上游主动断开 — 服务启动到一半挂了或进程 OOM',
          ETIMEDOUT: '上游不响应 — 卡在启动或 hang 住',
          EHOSTUNREACH: 'docker 网络不通 — 容器 IP 失效',
          ENOTFOUND: 'DNS 无法解析 upstream host',
        };
        const hint = ERR_HINTS[code ?? ''] ?? '上游异常';
        const acceptsHtml = this.isHtmlNavigationRequest(req);
        this.opts.logger?.warn?.(
          `[forward] upstream error: code=${code ?? 'UNKNOWN'} ${hint} → ${upstreamHost}:${upstreamPort} (host=${host})`,
        );
        const wantStatus =
          code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND' ? 503 : 502;
        logHttp(wantStatus, {}, code === 'ETIMEDOUT' ? 'timeout' : 'upstream-error', {
          code,
          message: err.message,
        });
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
        // 浏览器请求(accept: text/html) → 友好 HTML 自动刷新页(对齐 master proxy.ts:1074-1092)
        if (acceptsHtml) {
          this.respondHtmlError(res, wantStatus, hint, code ?? 'UNKNOWN');
        } else {
          // API / 非浏览器请求 → JSON
          this.respondJsonError(res, wantStatus, hint, code ?? 'UNKNOWN');
        }
        finish(wantStatus);
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

  private isHtmlNavigationRequest(req: IncomingMessage): boolean {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;

    const url = req.url || '/';
    if (this.isStaticAssetRequest(url)) return false;

    const dest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
    if (dest && dest !== 'document' && dest !== 'iframe' && dest !== 'empty') return false;

    const acceptHeader = req.headers.accept;
    if (!acceptHeader) return false;
    return String(acceptHeader).toLowerCase().includes('text/html');
  }

  private isStaticAssetRequest(url: string): boolean {
    let pathname = url;
    try {
      pathname = new URL(url, 'http://cds.local').pathname;
    } catch {
      pathname = url.split('?')[0] || '/';
    }
    const lower = pathname.toLowerCase();
    if (
      lower.startsWith('/@vite/')
      || lower === '/@vite/client'
      || lower.startsWith('/node_modules/')
      || lower.startsWith('/__vite')
    ) {
      return true;
    }
    return /\.(?:js|mjs|cjs|jsx|ts|tsx|css|map|json|wasm|png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i.test(lower);
  }

  /** WebSocket Upgrade 处理 */
  async handleUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    route: RouteRecord | null,
  ): Promise<void> {
    // /_cds/* passthrough 同样适用于 WebSocket Upgrade(/_cds/api/*/stream 等)
    // 同 handle():用本地变量,不 mutate req(Cursor Bugbot Low)。
    const originalUrlUp = req.url ?? '/';
    let outgoingPathUp = originalUrlUp;
    let extraHeadersUp: Record<string, string> | null = null;
    if (originalUrlUp.startsWith('/_cds/')) {
      outgoingPathUp = originalUrlUp.slice(5);
      extraHeadersUp = { 'x-cds-internal': '1' };
      route = {
        _id: 'master-passthrough',
        host: 'master',
        upstreamHost: this.opts.masterPassthroughHost,
        upstreamPort: this.opts.masterPassthroughPort,
        weight: 100,
      };
    }
    if (!route) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstreamHost = route.upstreamHost ?? '127.0.0.1';
    const upstreamPort = route.upstreamPort;

    // 透传 headers + 合并 passthrough 注入(本地变量,不 mutate req)
    const fwdHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v != null) fwdHeaders[k] = v as string | string[];
    }
    if (extraHeadersUp) {
      for (const [k, v] of Object.entries(extraHeadersUp)) fwdHeaders[k] = v;
    }
    const clientIp = (req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
    const existingXff = req.headers['x-forwarded-for'];
    fwdHeaders['x-forwarded-for'] = existingXff
      ? `${Array.isArray(existingXff) ? existingXff.join(', ') : existingXff}, ${clientIp}`
      : clientIp;
    // 同 handle():改写 Host 为 upstream 内部 hostname:port,X-Forwarded-{Proto,Host}
    // 与 HTTP 路径对齐(/human-verify finding #2)。
    if (!fwdHeaders['x-forwarded-proto']) {
      fwdHeaders['x-forwarded-proto'] = 'http';
    }
    const originalHostUp = (req.headers.host ?? route.host) as string;
    if (!fwdHeaders['x-forwarded-host']) {
      fwdHeaders['x-forwarded-host'] = originalHostUp;
    }
    if (!route.preserveHost) {
      fwdHeaders['host'] = `${upstreamHost}:${upstreamPort}`;
    }

    const upstreamReq = http.request({
      host: upstreamHost,
      port: upstreamPort,
      method: req.method ?? 'GET',
      path: outgoingPathUp,
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

  /**
   * HTML 200 响应注入 CDS widget(左下角分支 badge + bridge 通信脚本)。
   * 行为对齐 master ProxyService.proxyRequest(proxy.ts:967-1027):
   *   1. buffer 整段响应
   *   2. 按 content-encoding 解压(gzip / br / deflate)
   *   3. 在 </body> 前插入 widget;没 </body> 就尾追
   *   4. 删除 content-encoding + transfer-encoding,重算 content-length
   *   5. 一次性 writeHead + end
   * 解压失败兜底:不注入,原样透传(防止把流体响应写成乱码)。
   */
  private injectWidgetAndSend(
    upstreamRes: IncomingMessage,
    res: ServerResponse,
    route: RouteRecord,
    finish: (status: number) => void,
    logHttp: (
      status: number,
      response?: { bodyPreview?: string; bodyBytes?: number },
      outcome?: 'ok' | 'client-error' | 'server-error' | 'upstream-error' | 'timeout',
      error?: { code?: string; message?: string },
    ) => void,
    overrideHeaders?: Record<string, string | string[] | undefined>,
  ): void {
    const status = upstreamRes.statusCode ?? 200;
    const headers: Record<string, string | string[] | undefined> = overrideHeaders
      ? { ...overrideHeaders }
      : { ...upstreamRes.headers };
    const encoding = String(headers['content-encoding'] || '').toLowerCase();
    let stream: NodeJS.ReadableStream = upstreamRes;
    let aborted = false;
    // Cursor Bugbot Medium (PR #541):upstreamRes 自身的 'error' 事件必须挂监听,
    // 否则 ECONNRESET 等 mid-stream 错误会让 EventEmitter 抛 uncaughtException
    // 让整个 forwarder 进程崩。decompressor stream.on('error') 不覆盖 upstreamRes
    // 自己的 error(pipe 不传播 source 错误到 dest)。
    upstreamRes.on('error', (err) => {
      if (aborted) return;
      aborted = true;
      this.opts.logger?.warn?.(
        `[forward] upstreamRes mid-stream error during widget injection: ${err.message} (branch=${route.branchId ?? 'unknown'})`,
      );
      if (!res.headersSent) {
        this.respondWaiting(res, 502);
      } else if (!res.writableEnded) {
        try { res.end(); } catch { /* noop */ }
      }
      logHttp(502, {}, 'upstream-error', { message: err.message });
      finish(502);
    });
    try {
      if (encoding === 'gzip') stream = upstreamRes.pipe(zlib.createGunzip());
      else if (encoding === 'br') stream = upstreamRes.pipe(zlib.createBrotliDecompress());
      else if (encoding === 'deflate') stream = upstreamRes.pipe(zlib.createInflate());
    } catch {
      // 罕见:zlib 直接构造失败。退化到原样透传。
      if (!res.headersSent) res.writeHead(status, headers);
      upstreamRes.pipe(res);
      upstreamRes.on('end', () => {
        logHttp(status);
        finish(status);
      });
      return;
    }
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      if (aborted) return; // upstreamRes 已 errored,不应再 inject 残缺 body
      try {
        let body = Buffer.concat(chunks).toString('utf-8');
        const responseForLog = {
          bodyPreview: body.slice(0, 8 * 1024),
          bodyBytes: Buffer.byteLength(body, 'utf8'),
        };
        const widget = buildWidgetScript(route.branchId ?? '', route.branchName ?? '');
        const idx = body.lastIndexOf('</body>');
        if (idx !== -1) {
          body = body.slice(0, idx) + widget + body.slice(idx);
        } else {
          body += widget;
        }
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        headers['content-length'] = String(Buffer.byteLength(body, 'utf-8'));
        if (!res.headersSent) {
          res.writeHead(status, headers as http.OutgoingHttpHeaders);
        }
        res.end(body);
        logHttp(status, responseForLog);
        finish(status);
      } catch (err) {
        // 编码 / 解码异常:不再注入,直接关闭。日志真相之源(/human-verify finding #1)。
        this.opts.logger?.error?.(
          `[forward] widget injection failed: ${(err as Error).message} (branch=${route.branchId ?? 'unknown'})`,
        );
        if (!res.writableEnded) {
          try { res.end(); } catch { /* noop */ }
        }
        logHttp(status, {}, 'upstream-error', { message: (err as Error).message });
        finish(status);
      }
    });
    stream.on('error', (err) => {
      if (aborted) return; // upstreamRes 已处理过 error
      aborted = true;
      this.opts.logger?.error?.(
        `[forward] decompress stream error: ${(err as Error).message} encoding=${encoding} (branch=${route.branchId ?? 'unknown'})`,
      );
      // 解压失败:passthrough 已不可能(已经吸了部分数据),只能 503 兜底
      if (!res.headersSent) {
        this.respondWaiting(res, 502);
      } else if (!res.writableEnded) {
        try { res.end(); } catch { /* noop */ }
      }
      logHttp(502, {}, 'upstream-error', { message: (err as Error).message });
      finish(502);
    });
  }

  /** 写 502/503 友好 HTML 自动刷新页。用户只需要知道预览仍在等待，不暴露 upstream 细节。 */
  private respondHtmlError(res: ServerResponse, status: number, hint: string, code: string) {
    if (res.headersSent || res.writableEnded) return;
    try {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Retry-After': '3',
        'X-CDS-Preview-Wait-Code': code,
        'X-CDS-Preview-Wait-Hint': encodeURIComponent(hint).slice(0, 180),
      });
      res.end(buildForwarderWaitingPageHtml());
    } catch {
      // noop
    }
  }

  /** 写 502/503 JSON(API 客户端场景) */
  private respondJsonError(res: ServerResponse, status: number, hint: string, code: string) {
    if (res.headersSent || res.writableEnded) return;
    try {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'upstream-error', code, hint, status }));
    } catch {
      // noop
    }
  }

  private escapeHtml(s: string): string {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
  }

  /** 写 503 / 504 / 502 等候页(legacy,无路由时用)
   *
   * Content-Type 根据 waitingPageHtml 内容自动判断(以 `<` 开头视为 HTML):
   * forwarder-main 默认传完整 HTML 含 auto-reload script,以 text/plain 发出
   * 会让浏览器把标签当文本显示 + script 不执行(Cursor Bugbot 抓到)。
   */
  private respondWaiting(res: ServerResponse, status: number) {
    if (res.headersSent || res.writableEnded) return;
    const body = this.opts.waitingPageHtml;
    const isHtml = body.trimStart().startsWith('<');
    const contentType = isHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
    try {
      res.writeHead(status, { 'Content-Type': contentType });
      res.end(body);
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
