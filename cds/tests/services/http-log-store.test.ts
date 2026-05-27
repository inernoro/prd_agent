import { describe, expect, it } from 'vitest';
import {
  bodyPreviewFromUnknown,
  createBodyCapture,
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
});
