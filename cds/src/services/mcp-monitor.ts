import crypto from 'node:crypto';
import type { MonitorObservation, UptimeCustomMonitor } from '../types.js';
import { unsealToken, type SealedSecret } from '../infra/secret-seal.js';
import { maskSecrets } from './secret-masker.js';

export interface McpMonitorConfig {
  toolName: string;
  arguments: Record<string, unknown>;
  bearerTokenEncrypted?: SealedSecret;
}
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  reason?: string;
}
export interface McpCallEvidence {
  requestId: string;
  operation: string;
  endpoint: string;
  startedAt: string;
  elapsedMs: number;
  received: boolean;
  status?: number;
  contentType?: string;
  responseBytes?: number;
  truncated?: boolean;
  snapshot?: Record<string, unknown>;
  verdict: 'ok' | 'upstream-error' | 'invalid-response' | 'network-error';
  reason?: string;
}
const BODY_LIMIT = 1024 * 1024;
const TOOL_LIMIT = 500;
const PROTOCOL = '2025-03-26';
function safeLabel(value: unknown, limit = 160, secret?: string): string {
  if (typeof value !== 'string') return '';
  // Asterisks cannot occur in a valid Bearer token, so the marker cannot
  // reintroduce a short token such as "masked" into the sanitized text.
  const redact = (text: string) => secret ? text.split(secret).join('***') : text;
  return redact(maskSecrets(redact(value))
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b1[3-9]\d{9}\b/g, '[phone]'))
    .slice(0, limit);
}

/** Evidence keys are our fixed schema, never upstream-controlled property names. */
function redactAuditText(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.split(secret).join('***');
  if (Array.isArray(value)) return value.map(item => redactAuditText(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      // Digests and their scope are generated from received bytes, not upstream
      // text. A short token coinciding with a hex digit must not corrupt them.
      key === 'bodySha256' || key === 'hashScope' ? item : redactAuditText(item, secret),
    ]));
  }
  return value;
}

export function validateMcpUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('请填写完整的 MCP 服务地址');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('MCP 地址格式不正确，请输入完整的 HTTP 或 HTTPS 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('MCP 地址须为 HTTP 或 HTTPS，凭据请填写在访问令牌中');
  }
  return url.href;
}

/** Only approved public facts are retained; tool results and secrets are never copied. */
function snapshotRpc(value: unknown, secret?: string): Record<string, unknown> {
  const label = (value: unknown, limit = 160) => safeLabel(value, limit, secret);
  const doc = value as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') return { shape: typeof value };
  const error = doc.error as Record<string, unknown> | undefined;
  const result = doc.result as Record<string, unknown> | undefined;
  const server = result?.serverInfo as Record<string, unknown> | undefined;
  return {
    jsonrpc: label(doc.jsonrpc),
    ...(error ? { error: { code: typeof error.code === 'number' ? error.code : label(error.code, 64), message: label(error.message, 300) } } : {}),
    ...(result ? { result: {
      ...(server ? { serverInfo: { name: label(server.name), version: label(server.version) } } : {}),
      ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}),
      ...(Array.isArray(result.tools) ? { toolNames: result.tools.slice(0, TOOL_LIMIT).map(t => label((t as Record<string, unknown>)?.name)) } : {}),
      ...(Array.isArray(result.content) ? { contentTypes: result.content.slice(0, 20).map(c => label((c as Record<string, unknown>)?.type, 32)), contentOmitted: '工具产物正文不进入调用审计' } : {}),
    } } : {}),
  };
}

interface ResponseBodyEvidence {
  bodySha256: string;
  hashedBytes: number;
  bodyComplete: boolean;
  hashScope: 'entire-response' | 'received-prefix';
}

async function readResponse(
  res: Response,
  id: string | undefined,
  onBytes?: (bytes: number) => void,
  onEvidence?: (evidence: ResponseBodyEvidence) => void,
): Promise<{ doc?: Record<string, unknown>; bytes: number }> {
  if (id === undefined) { await res.body?.cancel(); return { bytes: 0 }; }
  if (!res.body) {
    onEvidence?.({ bodySha256: crypto.createHash('sha256').digest('hex'), hashedBytes: 0, bodyComplete: true, hashScope: 'entire-response' });
    throw new Error('MCP 服务未返回内容');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sse = (res.headers.get('content-type') ?? '').includes('text/event-stream');
  let raw = '', bytes = 0;
  let bodyComplete = false;
  const digest = crypto.createHash('sha256');
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { bodyComplete = true; break; }
      // Hash bytes before decoding/CRLF normalization, including the received
      // chunk that crosses the limit. No untrusted response text is persisted.
      digest.update(next.value);
      bytes += next.value.byteLength; onBytes?.(bytes);
      if (bytes > BODY_LIMIT) throw new Error('MCP 返回超过 1 MB，请缩小服务工具目录');
      raw = (raw + decoder.decode(next.value, { stream: true })).replace(/\r\n/g, '\n');
      if (sse) {
        let end: number;
        while ((end = raw.indexOf('\n\n')) !== -1) {
          const event = raw.slice(0, end); raw = raw.slice(end + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          let doc: Record<string, unknown>;
          try { doc = JSON.parse(data) as Record<string, unknown>; } catch { throw new Error('MCP 流包含无效 JSON'); }
          if (doc.id === id) return { doc, bytes };
        }
      }
    }
    if (sse) throw new Error('MCP 流在返回结果之前结束');
    let doc: Record<string, unknown>;
    try { doc = JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error('MCP 响应不是有效 JSON'); }
    if (doc?.id !== id) throw new Error('MCP 响应标识与请求不一致');
    return { doc, bytes };
  } finally {
    // Parsed RPC replies need the same raw-byte evidence as parse failures:
    // tool-level errors and omitted content must remain distinguishable too.
    onEvidence?.({ bodySha256: digest.digest('hex'), hashedBytes: bytes, bodyComplete,
      hashScope: bodyComplete ? 'entire-response' : 'received-prefix' });
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export class McpMonitorClient {
  private session?: string;
  private startedAt = Date.now();
  private protocol = PROTOCOL;
  readonly evidence: McpCallEvidence[] = [];
  readonly requestId = crypto.randomUUID();
  constructor(private url: string, private token: string | undefined, private timeoutMs = 15000, private record?: (e: McpCallEvidence) => void | Promise<void>) { this.url = validateMcpUrl(url); }

  private label(value: unknown, limit = 160): string { return safeLabel(value, limit, this.token); }

  private async rpc(operation: string, params?: unknown, notification = false): Promise<Record<string, unknown>> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, this.timeoutMs - (Date.now() - this.startedAt)));
    const id = notification ? undefined : crypto.randomUUID();
    const evidence: McpCallEvidence = { requestId: this.requestId, operation, endpoint: this.url, startedAt: new Date(started).toISOString(), elapsedMs: 0, received: false, verdict: 'network-error' };
    try {
      const res = await fetch(this.url, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': this.protocol,
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(this.session ? { 'Mcp-Session-Id': this.session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method: operation, ...(params ? { params } : {}) }),
      });
      evidence.received = true; evidence.status = res.status; evidence.contentType = res.headers.get('content-type') ?? '';
      if (!res.ok) {
        evidence.verdict = 'upstream-error';
        // Keep bounded, redacted business error facts without retaining an HTML
        // page, personal document, credentials, or arbitrary response headers.
        const reader = res.body?.getReader(); let bytes = 0; let raw = '';
        const digest = crypto.createHash('sha256');
        let bodyComplete = !reader;
        try {
          if (reader) for (;;) {
            const part = await reader.read(); if (part.done) { bodyComplete = true; break; }
            digest.update(part.value);
            bytes += part.value.length;
            raw += new TextDecoder().decode(part.value.subarray(0, Math.max(0, 8192 - raw.length)));
            if (bytes > 8192) { evidence.truncated = true; break; }
          }
        } finally {
          // Keep actual received-byte evidence even when the error response
          // cannot finish or has no recognized business-error fields.
          evidence.responseBytes = bytes;
          evidence.snapshot = { httpStatus: res.status, bodySha256: digest.digest('hex'), hashedBytes: bytes,
            bodyComplete, hashScope: bodyComplete ? 'entire-response' : 'received-prefix',
            bodyOmitted: '响应正文未保留，仅记录实际接收字节摘要和白名单事实' };
          await reader?.cancel().catch(() => undefined); reader?.releaseLock();
        }
        let facts: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const error = parsed.error && typeof parsed.error === 'object' ? parsed.error as Record<string, unknown> : parsed;
          facts = { code: typeof error.code === 'number' ? error.code : this.label(error.code, 64), message: this.label(error.message, 300), error: typeof parsed.error === 'string' ? this.label(parsed.error, 100) : undefined };
        } catch { facts = { bodyOmitted: '非结构化响应正文已省略，仅保留有界原字节摘要' }; }
        evidence.snapshot = { ...evidence.snapshot, ...facts };

        throw new Error(res.status === 401 || res.status === 403 ? 'MCP 服务未授权，请检查访问令牌' : `MCP 服务返回 HTTP ${res.status}`);
      }
      if (operation === 'initialize') this.session = res.headers.get('mcp-session-id') ?? undefined;
      evidence.verdict = 'invalid-response';
      const { doc, bytes } = await readResponse(res, id, bytes => { evidence.responseBytes = bytes; }, bodyEvidence => {
        evidence.responseBytes = bodyEvidence.hashedBytes;
        evidence.snapshot = { ...bodyEvidence, bodyOmitted: '响应正文未保留，仅记录实际接收字节摘要和白名单事实' };
      });
      evidence.responseBytes = bytes; evidence.snapshot = { ...evidence.snapshot, ...snapshotRpc(doc, this.token) };
      if (doc?.error) { evidence.verdict = 'upstream-error'; throw new Error('MCP 服务拒绝了请求，请查看调用审计'); }
      if (!notification && (!doc?.result || typeof doc.result !== 'object')) throw new Error('MCP 服务返回结果格式不正确');
      evidence.verdict = 'ok';
      return (doc?.result ?? {}) as Record<string, unknown>;
    } catch (err) {
      if (evidence.responseBytes && evidence.responseBytes > BODY_LIMIT) evidence.truncated = true;
      if (!evidence.snapshot && evidence.received) evidence.snapshot = { bodyOmitted: '响应解析失败或中断，正文未保留' };
      const failure = err as Error & { cause?: Error };
      const timedOut = failure.name === 'AbortError' || failure.name === 'TimeoutError';
      // Keep the transport fact in the private audit; the ordinary interface
      // explains the result and a recovery action without exposing Node errors.
      evidence.reason = this.label(failure.cause?.message || failure.message, 300);
      if (timedOut) throw new Error('连接服务超时，请稍后重试，或检查服务是否能正常响应');
      if (evidence.verdict === 'network-error') throw new Error('无法连接服务，请检查地址及服务是否在线后重试');
      throw new Error(evidence.reason);
    } finally {
      clearTimeout(timer); evidence.elapsedMs = Date.now() - started;
      if (this.token) {
        // The validated endpoint has no URL credentials, query or fragment.
        // Preserve it alongside generated correlation/protocol fields: a short
        // token coinciding with an address digit or scheme is not a secret echo.
        const { requestId: _requestId, operation: _operation, startedAt: _startedAt, verdict: _verdict, endpoint: _endpoint, ...dynamic } = evidence;
        Object.assign(evidence, redactAuditText(dynamic, this.token));
      }
      this.evidence.push(evidence);
      // The API persists each attempt before any normalized result is returned.
      try { await this.record?.(evidence); }
      catch { throw new Error('MCP 调用审计无法保存，请稍后重试'); }
    }
  }

  async discover(): Promise<{ server: { name: string; version: string }; tools: McpTool[] }> {
    const init = await this.rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'CDS Monitor', version: '1.0' } });
    if (typeof init.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(init.protocolVersion)) throw new Error('MCP 服务未协商协议版本');
    this.protocol = init.protocolVersion;
    await this.rpc('notifications/initialized', undefined, true);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : undefined);
      if (!Array.isArray(result.tools)) throw new Error('MCP 工具目录格式不正确');
      for (const raw of result.tools) {
        const tool = raw as Record<string, unknown>;
        if (typeof tool.name !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(tool.name)) continue;
        const schema = tool.inputSchema as Record<string, unknown>;
        const readOnly = (tool.annotations as Record<string, unknown> | undefined)?.readOnlyHint === true;
        tools.push({ name: tool.name, ...(typeof tool.title === 'string' ? { title: this.label(tool.title) } : {}),
          ...(typeof tool.description === 'string' ? { description: this.label(tool.description, 600) } : {}),
          inputSchema: schema && typeof schema === 'object' ? schema : { type: 'object' }, readOnly,
          ...(!readOnly ? { reason: '服务未声明只读，此工具可能修改业务数据，不能自动巡检' } : {}) });
      }
      if (tools.length > TOOL_LIMIT) throw new Error('MCP 工具超过 500 项，请按服务拆分后接入');
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) {
        const server = init.serverInfo as Record<string, unknown> | undefined;
        return { server: { name: this.label(server?.name) || 'MCP 服务', version: this.label(server?.version) }, tools };
      }
    }
    throw new Error('MCP 目录分页过多，请按服务拆分后接入');
  }

  async call(tool: McpTool, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    validateMcpArguments(tool, args);
    const result = await this.rpc('tools/call', { name: tool.name, arguments: args });
    if (result.isError !== undefined && typeof result.isError !== 'boolean') throw new Error('MCP 工具错误状态格式不正确');
    if (!Array.isArray(result.content) && result.structuredContent === undefined) throw new Error('MCP 工具没有返回业务结果');
    return result;
  }
}

/** Required/type constraints are checked before any scheduled tool call is sent. */
export function validateMcpArguments(tool: McpTool, args: Record<string, unknown>): void {
  if (!tool.readOnly) throw new Error(`工具 ${tool.name} 没有声明只读，不能自动巡检`);
  const visit = (schema: Record<string, unknown>, value: unknown, path: string, depth = 0): void => {
    if (depth > 12) throw new Error('工具参数结构过深');
    const type = schema.type;
    const types = Array.isArray(type) ? type : type ? [type] : [];
    const matches = (t: unknown): boolean => t === 'null' ? value === null : t === 'array' ? Array.isArray(value) : t === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value) : t === 'integer' ? typeof value === 'number' && Number.isInteger(value) : typeof value === t;
    if (types.length && !types.some(matches)) throw new Error(`工具参数 ${path} 类型不正确`);
    if (Array.isArray(schema.enum) && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) throw new Error(`工具参数 ${path} 不在允许范围内`);
    if (typeof value === 'string' && typeof schema.minLength === 'number' && value.length < schema.minLength) throw new Error(`工具参数 ${path} 太短`);
    if (typeof value === 'number' && ((typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum))) throw new Error(`工具参数 ${path} 超出允许范围`);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const key of Array.isArray(schema.required) ? schema.required : []) if (typeof key === 'string' && (!Object.hasOwn(obj, key) || obj[key] === undefined || obj[key] === null || obj[key] === '')) throw new Error(`工具参数 ${path}.${key} 必填`);
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
      for (const [key, v] of Object.entries(obj)) {
        if (properties?.[key]) visit(properties[key], v, `${path}.${key}`, depth + 1);
        else if (schema.additionalProperties === false) throw new Error(`工具参数 ${path}.${key} 未在服务中声明`);
      }
    }
    if (Array.isArray(value) && schema.items && typeof schema.items === 'object') for (const v of value) visit(schema.items as Record<string, unknown>, v, `${path}[]`, depth + 1);
  };
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是 JSON 对象');
  if (JSON.stringify(args).length > 16384) throw new Error('工具参数不能超过 16 KB');
  visit(tool.inputSchema, args, 'arguments');
}

export async function probeMcpMonitor(url: string, config: McpMonitorConfig, timeoutMs: number): Promise<{ up: boolean; ms: number; err?: string; observation: MonitorObservation }> {
  const start = Date.now();
  let client: McpMonitorClient | undefined;
  let err: string | undefined;
  try {
    let token: string | undefined;
    try { token = config.bearerTokenEncrypted ? unsealToken(config.bearerTokenEncrypted) : undefined; }
    catch { throw new Error('MCP 访问令牌无法解密，请重新接入服务'); }
    client = new McpMonitorClient(url, token, timeoutMs);
    const { tools } = await client.discover();
    const tool = tools.find(t => t.name === config.toolName);
    if (!tool) throw new Error('已订阅的 MCP 工具不再存在，请重新选择工具');
    const result = await client.call(tool, config.arguments);
    if (result.isError === true) throw new Error('MCP 工具返回业务失败，请检查服务');
  } catch (error) { err = safeLabel((error as Error).message, 300); }
  const ms = Date.now() - start;
  return { up: !err, ms, ...(err ? { err } : {}), observation: { at: new Date(start).toISOString(), ok: !err, elapsedMs: ms,
    results: [{ path: 'result.isError', op: 'ne', expected: 'true', ok: !err, ...(err ? { err } : {}) }],
    ...(err ? { err } : {}), upstreamCalls: client?.evidence ?? [] } };
}

export function publicMcpMonitor(monitor: UptimeCustomMonitor): Omit<UptimeCustomMonitor, 'mcp'> & { mcp?: { toolName: string; arguments: Record<string, unknown>; tokenSet: boolean } } {
  const { mcp, ...publicMonitor } = monitor;
  return { ...publicMonitor, ...(mcp ? { mcp: { toolName: mcp.toolName, arguments: mcp.arguments, tokenSet: !!mcp.bearerTokenEncrypted } } : {}) };
}
