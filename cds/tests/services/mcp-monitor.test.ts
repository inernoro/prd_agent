import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { McpMonitorClient, probeMcpMonitor, validateMcpArguments, publicMcpMonitor, type McpCallEvidence, type McpTool } from '../../src/services/mcp-monitor.js';
import { sealToken, type SealedSecret } from '../../src/infra/secret-seal.js';
import { normalizeUptimeMonitorInput, probeCustomMonitor } from '../../src/services/uptime-custom-monitor.js';
import { StateService } from '../../src/services/state.js';
import { UptimeMonitorService } from '../../src/services/uptime-monitor.js';
import { createUptimeRouter } from '../../src/routes/uptime.js';

const servers: http.Server[] = [];
const directories: string[] = [];
const originalKey = process.env.CDS_SECRET_KEY;
afterEach(() => {
  servers.splice(0).forEach(s => { s.closeAllConnections(); s.close(); });
  directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
  if (originalKey === undefined) delete process.env.CDS_SECRET_KEY; else process.env.CDS_SECRET_KEY = originalKey;
});
const tool: McpTool = { name: 'health', inputSchema: { type: 'object', required: ['region'], properties: { region: { type: 'string', enum: ['cn'] } }, additionalProperties: false }, readOnly: true };
async function serve(options: { sse?: boolean; error?: boolean; invalid?: boolean; hang?: boolean; token?: string; httpError?: boolean; reflectToken?: boolean; toolResult?: unknown; rpcError?: { code: number; message: string }; rawResponse?: { body: string; contentType: string; partial?: boolean; status?: number } } = {}) {
  const responses: string[] = [];
  const seen: Array<{ method: string; params?: any; authorization?: string; session?: string }> = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', data => { body += data; });
    req.on('end', () => {
      const rpc = JSON.parse(body); seen.push({ ...rpc, authorization: req.headers.authorization, session: req.headers['mcp-session-id'] });
      if (options.rawResponse) {
        res.writeHead(options.rawResponse.status ?? 200, { 'content-type': options.rawResponse.contentType });
        if (options.rawResponse.partial) res.write(options.rawResponse.body);
        else res.end(options.rawResponse.body);
        return;
      }
      if (options.hang) return;
      if (options.httpError) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'invalid_token', message: `denied ${options.token} user@example.test` })); return; }
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) { res.writeHead(401); res.end(); return; }
      if (rpc.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      const result = rpc.method === 'initialize' ? { protocolVersion: '2025-03-26', serverInfo: { name: options.reflectToken ? `service ${options.token}` : 'fixture', version: '1' }, capabilities: { tools: {} } }
        : rpc.method === 'tools/list' ? { tools: [{ ...tool, ...(options.reflectToken ? { description: `tool ${options.token}` } : {}), annotations: { readOnlyHint: true } }, { name: 'delete', inputSchema: { type: 'object' } }] }
          : options.toolResult === undefined ? { isError: !!options.error, content: [{ type: 'text', text: 'private-document-do-not-log' }] } : options.toolResult;
      const out = options.invalid ? 'not JSON' : JSON.stringify(rpc.method === 'tools/call' && options.rpcError
        ? { jsonrpc: '2.0', id: rpc.id, error: options.rpcError } : { jsonrpc: '2.0', id: rpc.id, result });
      responses.push(out);
      res.writeHead(200, { 'content-type': options.sse ? 'text/event-stream' : 'application/json', ...(rpc.method === 'initialize' ? { 'mcp-session-id': 'private-session-fixture' } : {}) });
      if (options.sse) { res.write(`event: message\r\ndata: ${out}\r\n\r\n`); } else res.end(out);
    });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen, responses };
}
function state() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-monitor-')); directories.push(dir);
  const file = path.join(dir, 'state.json'); const store = new StateService(file, dir); store.load(); return { dir, file, store };
}

describe('真正 MCP 工具巡检', () => {
  it('非2xx未知JSON字段的同长度不同原文也保留完整摘要，不改401友好错误', async () => {
    const { store, file, dir } = state();
    const bodies = ['permission denied', 'quota is exceeded'].map(detail => JSON.stringify({ detail, bearer: 'fixture-bearer-never-real' }));
    expect(Buffer.byteLength(bodies[0])).toBe(Buffer.byteLength(bodies[1]));
    const digests: string[] = [];
    for (const body of bodies) {
      const remote = await serve({ rawResponse: { body, contentType: 'application/json', status: 401 } });
      const client = new McpMonitorClient(remote.url, 'e', 1000, evidence => store.recordMcpMonitorAudit(evidence));
      await expect(client.discover()).rejects.toThrow('MCP 服务未授权，请检查访问令牌');
      const expectedHash = crypto.createHash('sha256').update(body).digest('hex');
      expect(client.evidence[0]).toMatchObject({ received: true, status: 401, verdict: 'upstream-error', responseBytes: Buffer.byteLength(body), snapshot: {
        httpStatus: 401, bodySha256: expectedHash, hashedBytes: Buffer.byteLength(body), bodyComplete: true, hashScope: 'entire-response',
      } });
      expect(client.evidence[0].snapshot?.bodySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(client.evidence)).not.toContain('fixture-bearer-never-real');
      expect(JSON.stringify(client.evidence)).not.toContain(body);
      digests.push(expectedHash);
    }
    expect(digests[0]).not.toBe(digests[1]);
    const reloaded = new StateService(file, dir); reloaded.load();
    expect(reloaded.listMcpMonitorAudits().map(e => e.snapshot?.bodySha256)).toEqual([...digests].reverse());
  });

  it('非2xx响应中断仍持久化真实已收字节与前缀摘要，不只记录通用超时', async () => {
    const { store, file, dir } = state();
    const body = '{"detail":"fixture-bearer-never-real","step":';
    const remote = await serve({ rawResponse: { body, contentType: 'application/json', status: 401, partial: true } });
    const client = new McpMonitorClient(remote.url, 'fixture-bearer-never-real', 150, evidence => store.recordMcpMonitorAudit(evidence));
    await expect(client.discover()).rejects.toThrow('连接服务超时');
    expect(client.evidence[0]).toMatchObject({ received: true, status: 401, verdict: 'upstream-error', responseBytes: Buffer.byteLength(body), snapshot: {
      httpStatus: 401, bodySha256: crypto.createHash('sha256').update(body).digest('hex'), hashedBytes: Buffer.byteLength(body), bodyComplete: false, hashScope: 'received-prefix',
    } });
    expect(JSON.stringify(client.evidence)).not.toContain('fixture-bearer-never-real');
    const reloaded = new StateService(file, dir); reloaded.load();
    expect(reloaded.listMcpMonitorAudits()[0].snapshot).toEqual(client.evidence[0].snapshot);
  });

  it('非2xx继续使用原8KB上限，超限保留实读前缀原字节摘要而非解码文本哈希', async () => {
    const body = 'x'.repeat(8192 + 4096);
    const remote = await serve({ rawResponse: { body, contentType: 'text/html', status: 401 } });
    const client = new McpMonitorClient(remote.url, '1', 1000);
    await expect(client.discover()).rejects.toThrow('MCP 服务未授权，请检查访问令牌');
    const evidence = client.evidence[0];
    expect(evidence.responseBytes).toBeGreaterThan(8192);
    expect(evidence).toMatchObject({ status: 401, truncated: true, verdict: 'upstream-error', snapshot: {
      bodySha256: crypto.createHash('sha256').update(body.slice(0, evidence.responseBytes)).digest('hex'), hashedBytes: evidence.responseBytes,
      bodyComplete: false, hashScope: 'received-prefix',
    } });
    expect(JSON.stringify(evidence)).not.toContain('x'.repeat(100));
  });


  it.each(['e', 'fixture-bearer-never-real'])('HTTP200同长度工具失败保留可区分的原字节摘要并冷读持久化（token=%s）', async token => {
    const { store, file, dir } = state();
    const digests: string[] = [];
    const responseSizes: number[] = [];
    for (const message of ['permission denied', 'quota is exceeded']) {
      const text = `${message} fixture-bearer-never-real user@example.test`;
      const toolResult = { isError: true, content: [{ type: 'text', text }] };
      const remote = await serve({ token, toolResult });
      const client = new McpMonitorClient(remote.url, token, 1000, evidence => store.recordMcpMonitorAudit(evidence));
      const discovered = await client.discover();
      expect(await client.call(discovered.tools[0], { region: 'cn' })).toEqual(toolResult);
      const raw = remote.responses.at(-1)!;
      const evidence = client.evidence.at(-1)!;
      const expectedHash = crypto.createHash('sha256').update(raw).digest('hex');
      expect(evidence).toMatchObject({ operation: 'tools/call', received: true, status: 200, responseBytes: Buffer.byteLength(raw),
        snapshot: { bodySha256: expectedHash, hashedBytes: Buffer.byteLength(raw), bodyComplete: true, hashScope: 'entire-response', result: { isError: true } } });
      expect(evidence.snapshot?.bodySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(evidence)).not.toContain(message);
      expect(JSON.stringify(evidence)).not.toContain('fixture-bearer-never-real');
      expect(JSON.stringify(evidence)).not.toContain('user@example.test');
      digests.push(expectedHash); responseSizes.push(Buffer.byteLength(raw));
    }
    expect(responseSizes[0]).toBe(responseSizes[1]); expect(digests[0]).not.toBe(digests[1]);
    const reloaded = new StateService(file, dir); reloaded.load();
    expect(reloaded.listMcpMonitorAudits().filter(e => e.operation === 'tools/call').map(e => e.snapshot?.bodySha256)).toEqual([...digests].reverse());
  });

  it.each(['JSONRPC错误', '非法result'])('已解析的%s也保留原字节摘要，不依赖某个错误分支', async kind => {
    const remote = await serve(kind === 'JSONRPC错误' ? { rpcError: { code: -32001, message: 'fixture permission denied' } } : { toolResult: 'invalid-result' });
    const client = new McpMonitorClient(remote.url, '1', 1000);
    const discovered = await client.discover();
    await expect(client.call(discovered.tools[0], { region: 'cn' })).rejects.toThrow(kind === 'JSONRPC错误' ? 'MCP 服务拒绝了请求' : 'MCP 服务返回结果格式不正确');
    const raw = remote.responses.at(-1)!;
    expect(client.evidence.at(-1)).toMatchObject({ status: 200, snapshot: {
      bodySha256: crypto.createHash('sha256').update(raw).digest('hex'), hashedBytes: Buffer.byteLength(raw), bodyComplete: true, hashScope: 'entire-response',
    } });
  });

  it('正常SSE工具结果保持原样，提前返回的摘要诚实标注为已收到前缀', async () => {
    const toolResult = { isError: false, content: [{ type: 'text', text: 'private-success-result' }], structuredContent: { healthy: true } };
    const remote = await serve({ sse: true, toolResult });
    const client = new McpMonitorClient(remote.url, 'e', 1000);
    const discovered = await client.discover();
    expect(await client.call(discovered.tools[0], { region: 'cn' })).toEqual(toolResult);
    const raw = `event: message\r\ndata: ${remote.responses.at(-1)}\r\n\r\n`;
    expect(client.evidence.at(-1)).toMatchObject({ status: 200, snapshot: {
      bodySha256: crypto.createHash('sha256').update(raw).digest('hex'), hashedBytes: Buffer.byteLength(raw), bodyComplete: false, hashScope: 'received-prefix',
    } });
    expect(JSON.stringify(client.evidence)).not.toContain('private-success-result');
  });


  it.each(['1', 'http'])('合法短令牌 %s 不应改写真实配置端点，响应回显仍须脱敏', async (token) => {
    const { store, file, dir } = state();
    const remote = await serve({ token, reflectToken: true });
    const client = new McpMonitorClient(remote.url, token, 1000, evidence => store.recordMcpMonitorAudit(evidence));
    const discovered = await client.discover();
    expect(discovered.server.name).not.toContain(token);
    expect(discovered.tools[0].description).not.toContain(token);
    expect(client.evidence).toHaveLength(3);
    for (const evidence of client.evidence) expect(evidence.endpoint).toBe(remote.url);
    const unavailable = await serve({ token, httpError: true });
    const failureClient = new McpMonitorClient(unavailable.url, token, 1000, evidence => store.recordMcpMonitorAudit(evidence));
    await expect(failureClient.discover()).rejects.toThrow('未授权');
    expect(failureClient.evidence[0].endpoint).toBe(unavailable.url);
    expect(failureClient.evidence[0].snapshot?.message).not.toContain(token);
    const reloaded = new StateService(file, dir); reloaded.load();
    expect(reloaded.listMcpMonitorAudits().map(e => e.endpoint)).toEqual([unavailable.url, remote.url, remote.url, remote.url]);
    // Preserving an endpoint never bypasses URL credential/query/fragment guards.
    for (const url of [remote.url.replace('http://', 'http://user:private@'), remote.url + '?token=private', remote.url + '#private']) {
      expect(() => new McpMonitorClient(url, token)).toThrow('凭据请填写在访问令牌中');
    }
  });

  it.each([
    { kind: 'malformed JSON', contentType: 'application/json', bodies: ['{"gate":"first","token":"e"', '{"gate":"other","token":"e"'] },
    { kind: 'HTML login page', contentType: 'text/html', bodies: ['<!doctype html><title>login-aaaa e</title>', '<!doctype html><title>login-bbbb e</title>'] },
  ])('HTTP200 $kind 的同长度不同响应保留完整SHA256，不保存原文', async ({ contentType, bodies }) => {
    const { store, file, dir } = state();
    expect(Buffer.byteLength(bodies[0])).toBe(Buffer.byteLength(bodies[1]));
    const digests: unknown[] = [];
    for (const body of bodies) {
      const remote = await serve({ rawResponse: { body, contentType } });
      // A generated hexadecimal digest must survive a one-character token.
      const client = new McpMonitorClient(remote.url, 'e', 1000, evidence => store.recordMcpMonitorAudit(evidence));
      await expect(client.discover()).rejects.toThrow('有效 JSON');
      const evidence = client.evidence[0];
      const expectedHash = crypto.createHash('sha256').update(body).digest('hex');
      expect(evidence).toMatchObject({ received: true, status: 200, contentType: contentType.split('e').join('***'), responseBytes: Buffer.byteLength(body), verdict: 'invalid-response',
        snapshot: { bodySha256: expectedHash, hashedBytes: Buffer.byteLength(body), bodyComplete: true, hashScope: 'entire-response' } });
      expect(evidence.snapshot?.bodySha256).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(evidence)).not.toContain(body);
      digests.push(evidence.snapshot?.bodySha256);
    }
    expect(digests[0]).not.toBe(digests[1]);
    const reloaded = new StateService(file, dir); reloaded.load();
    expect(reloaded.listMcpMonitorAudits().map(e => e.snapshot?.bodySha256)).toEqual([...digests].reverse());
  });

  it('超限或中断只记录实际收到的前缀摘要及字节数，不宣称完整响应', async () => {
    const oversizedBody = 'x'.repeat(1024 * 1024 + 4096);
    const oversized = await serve({ rawResponse: { body: oversizedBody, contentType: 'application/json' } });
    const oversizedClient = new McpMonitorClient(oversized.url, undefined, 1000);
    await expect(oversizedClient.discover()).rejects.toThrow('超过 1 MB');
    const oversizedEvidence = oversizedClient.evidence[0];
    expect(oversizedEvidence.responseBytes).toBeGreaterThan(1024 * 1024);
    expect(oversizedEvidence).toMatchObject({ truncated: true, snapshot: {
      bodySha256: crypto.createHash('sha256').update(oversizedBody.slice(0, oversizedEvidence.responseBytes)).digest('hex'),
      hashedBytes: oversizedEvidence.responseBytes, bodyComplete: false, hashScope: 'received-prefix',
    } });
    const privateBody = '{"private":"fixture-bearer-never-real","step":';
    const partial = await serve({ rawResponse: { body: privateBody, contentType: 'application/json', partial: true } });
    const partialClient = new McpMonitorClient(partial.url, 'fixture-bearer-never-real', 150);
    await expect(partialClient.discover()).rejects.toThrow('连接服务超时');
    expect(partialClient.evidence[0]).toMatchObject({ received: true, status: 200, responseBytes: Buffer.byteLength(privateBody), snapshot: {
      bodySha256: crypto.createHash('sha256').update(privateBody).digest('hex'),
      hashedBytes: Buffer.byteLength(privateBody), bodyComplete: false, hashScope: 'received-prefix',
    } });
    expect(JSON.stringify(partialClient.evidence)).not.toContain('fixture-bearer-never-real');
  });
  it('SSE解析异常的摘要覆盖原始CRLF字节，不用归一化后的文本冒充原始响应', async () => {
    const body = 'event: message\r\ndata: malformed-json\r\n\r\n';
    const remote = await serve({ rawResponse: { body, contentType: 'text/event-stream' } });
    const client = new McpMonitorClient(remote.url, undefined, 1000);
    await expect(client.discover()).rejects.toThrow('MCP 流包含无效 JSON');
    expect(client.evidence[0]).toMatchObject({ responseBytes: Buffer.byteLength(body), snapshot: {
      bodySha256: crypto.createHash('sha256').update(body).digest('hex'), hashedBytes: Buffer.byteLength(body), bodyComplete: false, hashScope: 'received-prefix',
    } });
  });

  it.each(['true', 'null', '1', '-', '.', 'masked', 'e'])('合法短令牌 %s 不得破坏成功结果、失败原因或审计数据类型', async (token) => {
    const remote = await serve({ token, reflectToken: true });
    const recorded: McpCallEvidence[] = [];
    const client = new McpMonitorClient(remote.url, token, 1000, evidence => { recorded.push(evidence); });
    const discovered = await client.discover();
    expect(discovered.tools[0].readOnly).toBe(true);
    const result = await client.call(discovered.tools[0], { region: 'cn' });
    expect(result.isError).toBe(false);
    expect(recorded).toHaveLength(4);
    expect(client.evidence).toEqual(recorded);
    const assertStringsMasked = (value: unknown): void => {
      if (typeof value === 'string') expect(value).not.toContain(token);
      else if (Array.isArray(value)) value.forEach(assertStringsMasked);
      else if (value && typeof value === 'object') Object.entries(value).forEach(([key, item]) => {
        // Newly retained system byte metadata is not an upstream secret echo.
        if (key === 'bodySha256') expect(item).toMatch(/^[a-f0-9]{64}$/);
        else if (key === 'hashScope') expect(['entire-response', 'received-prefix']).toContain(item);
        else assertStringsMasked(item);
      });
    };
    for (const evidence of recorded) {
      expect(evidence.received).toBe(true);
      expect(typeof evidence.status).toBe('number');
      expect(typeof evidence.elapsedMs).toBe('number');
      expect(typeof evidence.responseBytes).toBe('number');
      expect(evidence.requestId).toBe(client.requestId);
      expect(Number.isFinite(Date.parse(evidence.startedAt))).toBe(true);
      expect(evidence.verdict).toBe('ok');
      assertStringsMasked(evidence.snapshot);
      assertStringsMasked(evidence.reason);
    }
    expect(recorded[3].snapshot).toMatchObject({ result: { isError: false } });
    expect(Array.isArray((recorded[3].snapshot?.result as Record<string, unknown>).contentTypes)).toBe(true);
    expect(discovered.server.name).not.toContain(token);
    expect(discovered.tools[0].description).not.toContain(token);
    const unavailable = await serve({ token, httpError: true });
    const failureRecorded: McpCallEvidence[] = [];
    const failureClient = new McpMonitorClient(unavailable.url, token, 1000, evidence => { failureRecorded.push(evidence); });
    await expect(failureClient.discover()).rejects.toThrow('MCP 服务未授权，请检查访问令牌');
    expect(failureRecorded).toHaveLength(1);
    expect(failureRecorded[0]).toMatchObject({ received: true, status: 401 });
    expect(failureRecorded[0].requestId).toBe(failureClient.requestId);
    expect(failureRecorded[0].verdict).toBe('upstream-error');
    assertStringsMasked(failureRecorded[0].snapshot);
    assertStringsMasked(failureRecorded[0].reason);
  });

  it('握手、session、只读工具、必填参数及真正tools/call，结果落观测审计而不泄漏内容', async () => {
    process.env.CDS_SECRET_KEY = 'fixture-key-never-real';
    const remote = await serve({ token: 'fixture-bearer-never-real' });
    const sealed = sealToken('fixture-bearer-never-real') as SealedSecret;
    const outcome = await probeMcpMonitor(remote.url, { toolName: 'health', arguments: { region: 'cn' }, bearerTokenEncrypted: sealed }, 3000);
    expect(outcome.up).toBe(true);
    expect(remote.seen.map(x => x.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    expect(remote.seen[3].params).toEqual({ name: 'health', arguments: { region: 'cn' } });
    expect(remote.seen[3].session).toBe('private-session-fixture');
    expect(remote.seen.every(x => x.authorization === 'Bearer fixture-bearer-never-real')).toBe(true);
    expect(JSON.stringify(outcome)).not.toMatch(/fixture-bearer|private-document|private-session/);
    const { store, file, dir } = state();
    const normalized = normalizeUptimeMonitorInput({ name: '测试MCP', kind: 'functional', url: remote.url, assertions: [{ path: 'ok', op: 'eq', value: 'true' }] });
    expect(normalized.ok).toBe(true); if (!normalized.ok) throw new Error('normalize');
    const monitor = { ...normalized.monitor, mcp: { toolName: 'health', arguments: { region: 'cn' }, bearerTokenEncrypted: sealed } };
    store.upsertUptimeMonitor(monitor); store.recordMonitorObservation(monitor.id, outcome.observation);
    for (const e of outcome.observation.upstreamCalls!) await store.recordMcpMonitorAudit(e);
    await store.flush();
    const reloaded = new StateService(file, dir); reloaded.load();
    expect(reloaded.getUptimeMonitor(monitor.id)?.observations?.[0].upstreamCalls).toHaveLength(4);
    expect(reloaded.listMcpMonitorAudits()).toHaveLength(4);
    expect(fs.readFileSync(file, 'utf8')).not.toContain('fixture-bearer-never-real');
    expect(JSON.stringify(publicMcpMonitor(monitor))).not.toMatch(/__sealed|fixture-bearer|"tag"/);
    const edit = normalizeUptimeMonitorInput({ name: '修改后' }, { existing: monitor });
    expect(edit.ok && edit.monitor.mcp).toEqual(monitor.mcp);
    const scheduled = await probeCustomMonitor(monitor, 3000);
    expect(scheduled.up).toBe(true); expect(remote.seen.filter(x => x.method === 'tools/call')).toHaveLength(2);
  });
  it('持续 SSE 收到对应结果后完成，不等服务关闭流', async () => {
    const remote = await serve({ sse: true });
    const result = await probeMcpMonitor(remote.url, { toolName: 'health', arguments: { region: 'cn' } }, 1000);
    expect(result.up).toBe(true);
  });
  it('工具业务错误不能因为HTTP200变成正常', async () => {
    const remote = await serve({ error: true });
    const result = await probeMcpMonitor(remote.url, { toolName: 'health', arguments: { region: 'cn' } }, 1000);
    expect(result.up).toBe(false); expect(result.err).toContain('业务失败');
    expect(result.observation.upstreamCalls?.at(-1)?.snapshot).toMatchObject({ result: { isError: true } });
  });
  it('目录声明非只读或必填缺失时绝不调用工具', async () => {
    const remote = await serve();
    expect((await probeMcpMonitor(remote.url, { toolName: 'delete', arguments: {} }, 1000)).up).toBe(false);
    expect((await probeMcpMonitor(remote.url, { toolName: 'health', arguments: {} }, 1000)).err).toContain('必填');
    expect(remote.seen.some(x => x.method === 'tools/call')).toBe(false);
    expect(() => validateMcpArguments(tool, { region: 42 })).toThrow('类型');
    expect(() => validateMcpArguments(tool, { region: 'us' })).toThrow('允许范围');
  });
  it('上游失败正文形成有界脱敏审计，保留业务码而不保留token和个人信息', async () => {
    const remote = await serve({ httpError: true, token: 'fixture-bearer-never-real' });
    const client = new McpMonitorClient(remote.url, 'fixture-bearer-never-real', 1000);
    await expect(client.discover()).rejects.toThrow('未授权');
    expect(client.evidence[0]).toMatchObject({ received: true, status: 401, verdict: 'upstream-error', snapshot: { code: 'invalid_token' } });
    expect(JSON.stringify(client.evidence)).not.toMatch(/fixture-bearer-never-real|user@example.test/);
    const secret = 'fixture-' + 'a'.repeat(200);
    const reflected = await serve({ token: secret, reflectToken: true });
    const displayClient = new McpMonitorClient(reflected.url, secret, 1000);
    const display = await displayClient.discover();
    expect(display.server.name).toContain('***'); expect(display.tools[0].description).toContain('***');
    expect(JSON.stringify({ display, calls: displayClient.evidence })).not.toContain('a'.repeat(80));
  });
  it('无响应超时与响应无法解析分开记录', async () => {
    const hanging = await serve({ hang: true }); const client = new McpMonitorClient(hanging.url, undefined, 35);
    await expect(client.discover()).rejects.toThrow('超时');
    expect(client.evidence[0]).toMatchObject({ received: false, verdict: 'network-error' });
    const offline = await serve(); const stopped = servers.pop()!;
    await new Promise<void>(resolve => stopped.close(() => resolve()));
    const offlineClient = new McpMonitorClient(offline.url, undefined, 1000);
    await expect(offlineClient.discover()).rejects.toThrow('无法连接服务，请检查地址及服务是否在线后重试');
    expect(offlineClient.evidence[0]).toMatchObject({ received: false, verdict: 'network-error' });
    expect(offlineClient.evidence[0].reason).toMatch(/ECONNREFUSED|fetch failed/);
    const invalid = await serve({ invalid: true }); const invalidClient = new McpMonitorClient(invalid.url, undefined, 1000);
    await expect(invalidClient.discover()).rejects.toThrow('有效 JSON');
    expect(invalidClient.evidence[0]).toMatchObject({ received: true, status: 200, verdict: 'invalid-response' });
  });
});

describe('真实接入路由与持久化', () => {
  it('稳定ID重新接入并显式指定通道时不恢复旧静默或确认，其他目标和默认规则保持', async () => {
    const remote = await serve();
    const { store, file, dir } = state();
    const args = { region: 'cn' };
    const id = `mcp_${crypto.createHash('sha256').update(JSON.stringify([null, remote.url, 'health', args])).digest('hex').slice(0, 32)}`;
    const targetId = `monitor@${id}`;
    const otherTargetId = 'monitor@keep-other';
    const other = normalizeUptimeMonitorInput({ id: 'keep-other', kind: 'http', url: 'https://keep.example.test/health' });
    if (!other.ok) throw new Error(other.error);
    store.upsertUptimeMonitor(other.monitor);
    const future = Date.now() + 60000;
    const acknowledged = Date.now() - 1000;
    store.setMonitorNotifications({ defaultChannelIds: ['default-channel'],
      overrides: { [targetId]: ['obsolete-channel'], [otherTargetId]: ['other-channel'] },
      mutedUntil: { [targetId]: future, [otherTargetId]: future },
      acknowledgedAt: { [targetId]: acknowledged, [otherTargetId]: acknowledged },
    });
    await store.flush();
    expect(store.getUptimeMonitor(id)).toBeUndefined();
    const app = express(); app.use(express.json());
    const monitor = new UptimeMonitorService({ state: { getAllBranches: () => [], getUptimeMonitors: () => store.listUptimeMonitors() },
      config: { enabled: true, intervalMs: 60000, timeoutMs: 3000, failureThreshold: 3, recoveryThreshold: 1, maxSamples: 100, excludePatterns: [], scope: 'all', storePath: '' } });
    app.use('/api', createUptimeRouter({ monitor, store,
      getNotifications: () => store.getMonitorNotifications(), setNotifications: settings => store.setMonitorNotifications(settings),
      listNotificationChannelIds: () => ['phone'], recordMcpAudit: evidence => store.recordMcpMonitorAudit(evidence) }));
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(resolve => server.once('listening', resolve));
    const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const response = await fetch(apiRoot + '/uptime/mcp/import', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: remote.url, tools: [{ name: 'health', arguments: args }], channelIds: ['phone'] }) });
    expect(response.status).toBe(201);
    expect((await response.json()).targetIds).toEqual([targetId]);
    const expected = { defaultChannelIds: ['default-channel'], overrides: { [targetId]: ['phone'], [otherTargetId]: ['other-channel'] },
      mutedUntil: { [otherTargetId]: future }, acknowledgedAt: { [otherTargetId]: acknowledged } };
    expect(store.getMonitorNotifications()).toEqual(expected);
    await store.flush();
    const reloaded = new StateService(file, dir); reloaded.load();
    expect(reloaded.getMonitorNotifications()).toEqual(expected);
    expect(reloaded.getUptimeMonitor(id)?.mcp?.toolName).toBe('health');
    await monitor.stop();
  });

  it('discover→import→读回→scheduled probe；重复导入拒绝，审计有界保留', async () => {
    process.env.CDS_SECRET_KEY = 'fixture-key-never-real';
    const remote = await serve({ token: 'fixture-bearer-never-real' });
    const { store, file, dir } = state(); const app = express(); app.use(express.json());
    const monitor = new UptimeMonitorService({ state: { getAllBranches: () => [], getUptimeMonitors: () => store.listUptimeMonitors(), recordMonitorObservation: (id, observation) => store.recordMonitorObservation(id, observation) },
      config: { enabled: true, intervalMs: 60000, timeoutMs: 3000, failureThreshold: 3, recoveryThreshold: 1, maxSamples: 100, excludePatterns: [], scope: 'all', storePath: '' } });
    app.use('/api', createUptimeRouter({ monitor, store,
      getNotifications: () => store.getMonitorNotifications(), setNotifications: s => store.setMonitorNotifications(s), listNotificationChannelIds: () => ['phone', 'legacy-map'],
      alarmChannel: () => ({ status: 'untested', channel: 'MAP 站内通知', delivered: 0, failed: 0 }),
      readAlarmNotify: () => ({ configured: true, username: 'fixture-user', endpoint: 'https://private-map.example.test', keyId: 'private-key-id', privateKeyFingerprint: 'private-fingerprint' }),
      recordMcpAudit: e => store.recordMcpMonitorAudit(e), listMcpAudits: () => store.listMcpMonitorAudits() }));
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(resolve => server.once('listening', resolve));
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const post = (route: string, body: unknown) => fetch(root + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const notificationView = await (await fetch(root + '/uptime/notifications')).json();
    expect(notificationView.legacyChannel).toMatchObject({ id: 'legacy-map', status: 'untested', map: { username: 'fixture-user' } });
    expect(JSON.stringify(notificationView)).not.toMatch(/private-key-id|private-fingerprint|private-map/);
    const body = { url: remote.url, token: 'fixture-bearer-never-real' };
    const discovered = await (await post('/uptime/mcp/discover', body)).json();
    expect(discovered.tools).toHaveLength(2); expect(discovered.tools[1].readOnly).toBe(false);
    const imported = await post('/uptime/mcp/import', { ...body, tools: [{ name: 'health', arguments: { region: 'cn' } }], channelIds: ['phone'] });
    expect(imported.status).toBe(201); const out = await imported.json();
    expect(out.monitors[0].mcp.tokenSet).toBe(true); expect(JSON.stringify(out)).not.toContain('__sealed');
    const summary = await (await fetch(root + '/uptime/summary')).json();
    expect(summary.targets[0]).toMatchObject({ id: out.targetIds[0], status: 'unknown', lastSample: null });
    const probe = await post('/uptime/targets/' + encodeURIComponent(out.targetIds[0]) + '/probe', {});
    expect(probe.status).toBe(200); expect((await probe.json()).sample.up).toBe(true);
    await store.flush();
    const reloaded = new StateService(file, dir); reloaded.load();
    expect(reloaded.getMonitorNotifications().overrides?.[out.targetIds[0]]).toEqual(['phone']);
    expect(reloaded.getUptimeMonitor(out.monitors[0].id)?.observations?.[0].upstreamCalls).toHaveLength(4);
    expect((await probeCustomMonitor(reloaded.getUptimeMonitor(out.monitors[0].id)!, 3000)).up).toBe(true);
    const audit = await (await fetch(root + '/uptime/mcp/audit')).json(); expect(audit.calls).toHaveLength(6);
    expect(JSON.stringify(audit)).not.toContain('fixture-bearer-never-real');
    const duplicate = await post('/uptime/mcp/import', { ...body, tools: [{ name: 'health', arguments: { region: 'cn' } }] });
    expect(duplicate.status).toBe(400); expect(store.listUptimeMonitors()).toHaveLength(1);
    const listed = await (await fetch(root + '/uptime/monitors')).json(); expect(JSON.stringify(listed)).not.toContain('__sealed');
    const put = (body: unknown) => fetch(root + '/uptime/notifications', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await put({ defaultChannelIds: ['phone', 'legacy-map'], targetId: out.targetIds[0], channelIds: [], acknowledged: true, muteUntil: Date.now() + 60000 })).status).toBe(200);
    const settings = (await (await fetch(root + '/uptime/notifications')).json()).settings;
    expect(settings.overrides[out.targetIds[0]]).toEqual([]); expect(settings.acknowledgedAt[out.targetIds[0]]).toBeGreaterThan(0);
    const reopened = new StateService(file, dir); reopened.load(); expect(reopened.getMonitorNotifications()).toEqual(settings);
    expect((await put({ targetId: out.targetIds[0], channelIds: null, acknowledged: false, muteUntil: null })).status).toBe(200);
    const cleared = (await (await fetch(root + '/uptime/notifications')).json()).settings;
    expect(cleared.overrides[out.targetIds[0]]).toBeUndefined(); expect(cleared.mutedUntil[out.targetIds[0]]).toBeUndefined();
    expect((await put({ defaultChannelIds: ['deleted-channel'] })).status).toBe(400);
    expect((await put({ targetId: 'monitor@missing', acknowledged: true })).status).toBe(400);
    await monitor.stop();
  });
});


describe('新写接口的鉴权边界', () => {
  it('项目级和带作用域Key不能读取通知或调用MCP，未加密的实例拒绝token持久化', async () => {
    delete process.env.CDS_SECRET_KEY;
    const { store } = state(); const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      if (req.headers['x-test-scope']) (req as any).cdsProjectKey = { projectId: 'fixture' };
      next();
    });
    app.use('/api', createUptimeRouter({ monitor: {} as never, store, recordMcpAudit: e => store.recordMcpMonitorAudit(e) }));
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(resolve => server.once('listening', resolve));
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    for (const route of ['/uptime/mcp/audit', '/uptime/notifications']) expect((await fetch(root + route, { headers: { 'x-test-scope': '1' } })).status).toBe(403);
    for (const route of ['/uptime/mcp/discover', '/uptime/mcp/import']) expect((await fetch(root + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-scope': '1' }, body: '{}' })).status).toBe(403);
    const invalidToken = await fetch(root + '/uptime/mcp/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://mcp.example.test', token: 'a"b' }) });
    expect(invalidToken.status).toBe(400); expect((await invalidToken.json()).error).toContain('令牌格式');
    const result = await fetch(root + '/uptime/mcp/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://mcp.example.test', token: 'fixture-token-never-real', tools: [{ name: 'health' }] }) });
    expect(result.status).toBe(400); expect((await result.json()).error).toContain('凭据加密'); expect(store.listUptimeMonitors()).toHaveLength(0);
  });
});
