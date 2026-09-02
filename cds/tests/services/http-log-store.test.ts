import { describe, expect, it } from 'vitest';
import {
  bodyPreviewFromUnknown,
  classifyHttpRequestKind,
  createBodyCapture,
  HttpLogStore,
  isBinaryContentType,
  isTextualContentType,
  redactBodyText,
} from '../../src/services/http-log-store.js';

describe('http log body redaction', () => {
  it('redacts sensitive keys in structured JSON without regex scanning', () => {
    const result = bodyPreviewFromUnknown({
      username: 'alice',
      password: 'secret',
      nested: { accessToken: 'tok_123' },
    });

    expect(result.bodyPreview).toContain('"username":"alice"');
    expect(result.bodyPreview).toContain('"password":"[redacted]"');
    expect(result.bodyPreview).toContain('"accessToken":"[redacted]"');
    expect(result.bodyPreview).not.toContain('secret');
    expect(result.bodyPreview).not.toContain('tok_123');
  });

  it('redacts the one-time authorizationKey (被动授权 cdsp_ 明文不得落日志)', () => {
    const result = bodyPreviewFromUnknown({ status: 'approved', authorizationKey: 'cdsp_demo_abc123secretplaintext' });
    expect(result.bodyPreview).toContain('"authorizationKey":"[redacted]"');
    expect(result.bodyPreview).not.toContain('cdsp_demo_abc123secretplaintext');
  });

  it('keeps malformed html-like previews linear and bounded', () => {
    const hostile = `<html>${' "not-a-json-key": "'.repeat(600)}${'x'.repeat(9000)}</html>`;
    const started = performance.now();
    const result = redactBodyText(hostile);
    const elapsedMs = performance.now() - started;

    expect(result).toContain('<html>');
    expect(elapsedMs).toBeLessThan(100);
  });

  it('captures and redacts only the bounded response preview', () => {
    const capture = createBodyCapture();
    capture.onChunk(`token=${'a'.repeat(9000)}&next=1`);
    const snapshot = capture.snapshot();

    expect(snapshot.bodyBytes).toBeGreaterThan(8192);
    expect(snapshot.bodyPreview).toContain('token=[redacted]');
    expect(snapshot.bodyPreview?.length).toBeLessThan(9000);
  });

  it('redacts bearer tokens in plain text', () => {
    expect(redactBodyText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'))
      .toBe('Authorization: Bearer [redacted]');
  });

  it('omits image body previews while preserving byte counts', () => {
    const capture = createBodyCapture(undefined, 'image/png');
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0xff);
    capture.onChunk(bytes);
    const snapshot = capture.snapshot('image/png');

    expect(snapshot.bodyBytes).toBe(bytes.length);
    expect(snapshot.bodyPreview).toBe('[cds http log omitted binary body]');
  });

  it('omits multipart upload previews', () => {
    const result = bodyPreviewFromUnknown('------boundary\r\nraw-image-bytes', 'multipart/form-data; boundary=abc');

    expect(result.bodyBytes).toBeGreaterThan(0);
    expect(result.bodyPreview).toBe('[cds http log omitted binary body]');
  });

  it('counts raw binary request captures without retaining chunks', () => {
    const capture = createBodyCapture(undefined, 'application/octet-stream');
    capture.onChunk(Buffer.alloc(512 * 1024, 1));
    capture.onChunk(Buffer.alloc(512 * 1024, 2));

    expect(capture.snapshot('application/octet-stream')).toEqual({
      bodyBytes: 1024 * 1024,
      bodyPreview: '[cds http log omitted binary body]',
    });
  });

  it('classifies common upload/download content types', () => {
    expect(isBinaryContentType('image/jpeg')).toBe(true);
    expect(isBinaryContentType('application/octet-stream')).toBe(true);
    expect(isBinaryContentType('multipart/form-data; boundary=x')).toBe(true);
    expect(isTextualContentType('application/json; charset=utf-8')).toBe(true);
    expect(isBinaryContentType('application/json; charset=utf-8')).toBe(false);
  });

  it('uses content-length as binary body size when the server responds before fully draining', async () => {
    const docs: unknown[] = [];
    const store = new HttpLogStore({ uri: 'mongodb://unused' });
    (store as unknown as { collection: { insertOne(doc: unknown): Promise<void>; countDocuments(): Promise<number> } }).collection = {
      async insertOne(doc: unknown) { docs.push(doc); },
      async countDocuments() { return docs.length; },
    };

    store.record({
      layer: 'master',
      requestId: 'binary-size',
      method: 'POST',
      path: '/api/client-events',
      status: 202,
      durationMs: 2,
      outcome: 'ok',
      request: {
        headers: { 'content-type': 'image/png', 'content-length': '1048576' },
        bodyPreview: '[cds http log omitted binary body]',
        bodyBytes: 64975,
      },
      response: {},
    });
    await store.flush();

    expect((docs[0] as any).request.bodyBytes).toBe(1048576);
    expect((docs[0] as any).request.bodyPreview).toBe('[cds http log omitted binary body]');
  });

  it('classifies deploy, polling, sse, and user traffic requests', () => {
    expect(classifyHttpRequestKind({ method: 'POST', path: '/api/branches/prd-agent-main/deploy' })).toBe('deploy');
    expect(classifyHttpRequestKind({ method: 'POST', path: '/api/branches/prd-agent-main/deploy/api' })).toBe('deploy');
    expect(classifyHttpRequestKind({
      method: 'POST',
      path: '/api/branches/prd-agent-main/deploy/api',
      headers: { accept: 'text/event-stream' },
    })).toBe('deploy');
    expect(classifyHttpRequestKind({
      method: 'POST',
      path: '/_cds/api/branches/prd-agent-main/deploy/api',
      headers: { accept: 'text/event-stream' },
    })).toBe('deploy');
    expect(classifyHttpRequestKind({
      method: 'POST',
      path: '/_cds/api/branches/prd-agent-main/restart',
      headers: { accept: 'text/event-stream' },
    })).toBe('container-op');
    expect(classifyHttpRequestKind({ method: 'GET', path: '/api/projects/a/instances', headers: { 'x-cds-poll': 'true' } })).toBe('polling');
    expect(classifyHttpRequestKind({ method: 'GET', path: '/api/branches/stream', headers: { accept: 'text/event-stream' } })).toBe('sse');
    expect(classifyHttpRequestKind({ method: 'GET', path: '/' })).toBe('user-traffic');
    expect(classifyHttpRequestKind({ layer: 'forwarder', method: 'POST', path: '/login' })).toBe('user-traffic');
    expect(classifyHttpRequestKind({ layer: 'master-proxy', method: 'POST', path: '/graphql' })).toBe('user-traffic');
    expect(classifyHttpRequestKind({ layer: 'master', method: 'POST', path: '/internal-maintenance' })).toBe('control-plane');
  });

  it('tracks active requests by age and removes them on completion', () => {
    const store = new HttpLogStore({ uri: 'mongodb://unused' });
    const deployId = store.beginActive({
      layer: 'master',
      requestKind: 'deploy',
      requestId: 'deploy-active',
      method: 'POST',
      host: '127.0.0.1:9900',
      path: '/api/branches/prd-agent-main/deploy',
      startedAt: new Date(Date.now() - 45_000),
      branchId: 'prd-agent-main',
      request: {},
    });
    store.beginActive({
      layer: 'master',
      requestKind: 'polling',
      requestId: 'poll-active',
      method: 'GET',
      host: 'cds.test',
      path: '/api/projects/prd-agent/instances',
      startedAt: new Date(Date.now() - 2_000),
      request: {},
    });

    const slowDeploys = store.findActive({ requestKind: 'deploy', minAgeMs: 30_000 });

    expect(slowDeploys).toHaveLength(1);
    expect(slowDeploys[0].requestId).toBe('deploy-active');
    expect(slowDeploys[0].ageMs).toBeGreaterThanOrEqual(30_000);

    store.completeActive(deployId);
    expect(store.findActive({ requestKind: 'deploy' })).toHaveLength(0);
  });

  it('keeps active tracking available without a Mongo connection', () => {
    const store = new HttpLogStore({ uri: 'mongodb://unused' });
    store.record({
      layer: 'forwarder',
      requestId: 'no-mongo-record',
      method: 'POST',
      path: '/login',
      status: 200,
      durationMs: 30,
      outcome: 'ok',
      request: {},
      response: {},
    });
    const activeId = store.beginActive({
      layer: 'forwarder',
      requestKind: 'user-traffic',
      requestId: 'no-mongo-active',
      method: 'POST',
      path: '/login',
      startedAt: new Date(Date.now() - 1000),
      request: {},
    });

    expect(store.findActive({ requestKind: 'user-traffic' })).toHaveLength(1);

    store.completeActive(activeId);
    expect(store.findActive()).toHaveLength(0);
  });
});

/**
 * 身份层签发接口交付明文用的字段名叫 `plaintext` —— 一个敏感词都不含，按字段名
 * 列举的那串正则一个都匹配不上。于是一把 90 天滑动、能为主体名下所有授权换项目
 * 凭据的长期密钥，会原样落进 cds_http_logs，而 /api/http-logs 把 body 预览返回给
 * 任何已鉴权调用方 —— 一把项目级凭据就能捞到刚签出的用户级凭证（Codex P1）。
 *
 * 按字段名列举必然漏下一个字段名，所以判据钉两层：字段名认得出 `plaintext`，
 * 以及**不管挂在哪个字段名下**，长得像 CDS 凭据的值一律抹掉。
 */
describe('redactBodyText：CDS 自己签发的凭据明文不许进日志', () => {
  const userCred = 'cdsu_' + 'A1b2C3d4E5f6G7h8I9j0K1l2';
  const projCred = 'cdsp_demo_' + 'Z9y8X7w6V5u4T3s2R1q0P9o8';

  it('字段名 plaintext 被认出来（身份层签发接口就用这个名字）', () => {
    const out = redactBodyText(JSON.stringify({ ok: true, plaintext: userCred }));
    expect(out).not.toContain(userCred);
    expect(out).toContain('[redacted]');
  });

  it('换个无辜字段名照样抹掉 —— 按字段名列举必然漏下一个', () => {
    for (const field of ['value', 'result', 'note', 'data']) {
      const out = redactBodyText(JSON.stringify({ [field]: userCred }));
      expect(out, `字段 ${field}`).not.toContain(userCred);
    }
  });

  it('项目级凭据明文同样抹掉（自愈接口返回的就是它）', () => {
    const out = redactBodyText(JSON.stringify({ credential: { id: 'x' }, plaintext: projCred }));
    expect(out).not.toContain(projCred);
  });

  it('嵌套结构里的也抹得掉', () => {
    const out = redactBodyText(JSON.stringify({ a: { b: [{ c: userCred }] } }));
    expect(out).not.toContain(userCred);
  });

  it('非 JSON 正文（表单 / 纯文本 / 错误页）同样兜住', () => {
    const out = redactBodyText(`issued=${userCred}&ok=1`);
    expect(out).not.toContain(userCred);
  });

  it('不误伤正常内容（判据不是把什么都抹了）', () => {
    const out = redactBodyText(JSON.stringify({ projectName: 'MAP', branch: 'feature/x', count: 3 }));
    expect(out).toContain('MAP');
    expect(out).toContain('feature/x');
    expect(out).not.toContain('[redacted]');
  });
});
