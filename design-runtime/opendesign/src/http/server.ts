// map-design-executor-v1 的 HTTP 翻译层。状态全部在 TaskManager 里，这里只做鉴权、解析与序列化。
//
//   GET  /v1/capabilities                       匿名；能力、健康与不健康的原因
//   GET  /healthz/ready                         匿名；引擎就绪 200，否则 503（部署平台的就绪探针用）
//   POST /v1/tasks                              Bearer；提交任务（忙 409 + retryAfterSeconds，同 taskId 幂等）
//   GET  /v1/tasks/{taskId}                     Bearer；任务状态
//   GET  /v1/tasks/{taskId}/events?afterSeq=N   Bearer；JSON 一次性拉取，或 SSE（Accept: text/event-stream 或 stream=1）
//   POST /v1/tasks/{taskId}/cancel              Bearer；取消（已结束的任务原样返回）
import crypto from 'node:crypto';
import http from 'node:http';

import { describeCapabilities, type CapabilitiesContext } from '../capabilities.js';
import { renderCondition } from '../conditions.js';
import { AgentWorkspaceRuntimeError } from '../errors.js';
import { normalizeTaskRequest } from '../protocol.js';
import type { TaskManager } from '../tasks.js';

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const SSE_KEEPALIVE_MS = 15_000;

export interface ServerContext extends CapabilitiesContext {
  apiKey: string;
  tasks: TaskManager;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendError(
  res: http.ServerResponse,
  status: number,
  error: { code: string; message: string; retryable?: boolean; details?: unknown },
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { error, ...extra }, headers);
}

function authorized(req: http.IncomingMessage, apiKey: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const actual = Buffer.from(header, 'utf8');
  const expected = Buffer.from(`Bearer ${apiKey}`, 'utf8');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new AgentWorkspaceRuntimeError('request_too_large', `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`);
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AgentWorkspaceRuntimeError('task_request_invalid', 'request body is not valid JSON');
  }
}

export function createServer(context: ServerContext): http.Server {
  return http.createServer((req, res) => {
    handle(context, req, res).catch((error) => {
      if (!res.headersSent) {
        sendError(res, 500, {
          code: 'internal_error',
          message: `设计执行服务处理请求时出错：${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`,
          retryable: true,
        });
      } else {
        res.end();
      }
    });
  });
}

async function handle(context: ServerContext, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://design-runtime.local');
  const method = req.method || 'GET';

  if (method === 'GET' && url.pathname === '/v1/capabilities') {
    sendJson(res, 200, await describeCapabilities(context));
    return;
  }
  if (method === 'GET' && url.pathname === '/healthz/ready') {
    const capabilities = await describeCapabilities(context);
    const engineReason = capabilities.conditions.find((condition) => condition.code !== 'api_key_not_configured') ?? null;
    sendJson(res, capabilities.engineReady ? 200 : 503, { ready: capabilities.engineReady, reason: engineReason });
    return;
  }

  const taskMatch = /^\/v1\/tasks(?:\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})(?:\/(events|cancel))?)?$/.exec(url.pathname);
  if (!taskMatch) {
    sendError(res, 404, { code: 'not_found', message: `没有这个接口：${method} ${url.pathname}` });
    return;
  }

  if (!context.apiKey) {
    const condition = (await describeCapabilities(context)).conditions.find((item) => item.code === 'api_key_not_configured');
    sendError(res, 503, condition ?? { code: 'api_key_not_configured', message: 'DESIGN_RUNTIME_API_KEY is not configured', retryable: false });
    return;
  }
  if (!authorized(req, context.apiKey)) {
    sendError(res, 401, renderCondition({
      code: 'unauthorized',
      actor: { kind: 'caller' },
      event: '没有带正确的 Authorization: Bearer <DESIGN_RUNTIME_API_KEY>',
      impact: '请求被拒绝，没有产生任何副作用',
      urgency: { kind: 'act', action: '核对调用方配置的 key 与本服务部署的 DESIGN_RUNTIME_API_KEY 是否为同一把' },
      retryable: false,
      technical: {},
    }), {}, { 'WWW-Authenticate': 'Bearer' });
    return;
  }

  const [, taskId, action] = taskMatch;
  const { tasks } = context;

  if (!taskId) {
    if (method !== 'POST') {
      sendError(res, 405, { code: 'method_not_allowed', message: `${method} /v1/tasks is not supported` });
      return;
    }
    let normalized;
    try {
      normalized = normalizeTaskRequest(await readJsonBody(req));
    } catch (error) {
      if (error instanceof AgentWorkspaceRuntimeError) {
        sendError(res, error.code === 'request_too_large' ? 413 : 400, {
          code: error.code,
          message: error.message,
          retryable: false,
        });
        return;
      }
      throw error;
    }
    // 槽位空闲、但引擎本身不可用（镜像不对、引擎没通过健康检查）时不接新任务，原因与能力接口同一份。
    // 已有记录的 taskId 照常走幂等判定（重放不依赖引擎健康）；启动中与清空失败由 submit 自己报 503。
    if (!tasks.get(normalized.taskId) && tasks.slotState() === 'idle') {
      const capabilities = await describeCapabilities(context);
      if (!capabilities.engineReady) {
        const reason = capabilities.conditions.find((condition) => condition.code !== 'api_key_not_configured');
        if (reason) {
          sendError(res, 503, reason);
          return;
        }
      }
    }
    const outcome = tasks.submit(normalized);
    switch (outcome.kind) {
      case 'accepted':
        sendJson(res, 202, { task: outcome.task });
        return;
      case 'replayed':
        sendJson(res, 200, { task: outcome.task, replayed: true });
        return;
      case 'conflict':
        sendError(res, 409, outcome.error);
        return;
      case 'busy':
        sendError(res, 409, outcome.error, { retryAfterSeconds: outcome.retryAfterSeconds }, {
          'Retry-After': String(outcome.retryAfterSeconds),
        });
        return;
      case 'unavailable':
        sendError(res, 503, outcome.error);
        return;
    }
  }

  const view = tasks.get(taskId);
  if (!view) {
    sendError(res, 404, { code: 'task_not_found', message: `这个实例上没有 taskId=${taskId} 的任务记录（可能从未提交到本实例，或已超出保留条数）` });
    return;
  }

  if (!action) {
    if (method !== 'GET') {
      sendError(res, 405, { code: 'method_not_allowed', message: `${method} is not supported here` });
      return;
    }
    sendJson(res, 200, { task: view });
    return;
  }

  if (action === 'cancel') {
    if (method !== 'POST') {
      sendError(res, 405, { code: 'method_not_allowed', message: `${method} is not supported here` });
      return;
    }
    sendJson(res, 200, { task: tasks.cancel(taskId) });
    return;
  }

  // events
  if (method !== 'GET') {
    sendError(res, 405, { code: 'method_not_allowed', message: `${method} is not supported here` });
    return;
  }
  const requestedAfterSeq = Number(url.searchParams.get('afterSeq') || 0);
  let afterSeq = Number.isSafeInteger(requestedAfterSeq) && requestedAfterSeq >= 0 ? requestedAfterSeq : 0;
  const wantsStream = (req.headers.accept || '').includes('text/event-stream')
    || url.searchParams.get('stream') === '1' || url.searchParams.get('stream') === 'true';
  if (!wantsStream) {
    const current = tasks.get(taskId)!;
    sendJson(res, 200, {
      taskId,
      attempt: current.attempt,
      state: current.state,
      terminal: current.state !== 'running',
      lastSeq: current.lastSeq,
      events: tasks.eventsAfter(taskId, afterSeq) ?? [],
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  let disconnected = false;
  res.once('close', () => { disconnected = true; });
  // 先按 afterSeq 回放，再保持连接等待新事件；任务结束（done / error 已发出）后关闭。
  while (!disconnected) {
    for (const event of tasks.eventsAfter(taskId, afterSeq) ?? []) {
      if (disconnected || res.writableEnded) break;
      res.write(`id: ${event.seq}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      afterSeq = event.seq;
    }
    const current = tasks.get(taskId);
    if (disconnected || !current || current.state !== 'running') break;
    const arrived = await tasks.waitForEvent(taskId, afterSeq, SSE_KEEPALIVE_MS);
    if (!arrived && !disconnected && !res.writableEnded) {
      res.write('event: keepalive\n');
      res.write(`data: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
    }
  }
  if (!disconnected && !res.writableEnded) res.end();
}
