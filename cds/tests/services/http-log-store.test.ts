import { describe, expect, it } from 'vitest';
import {
  bodyPreviewFromUnknown,
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
});
