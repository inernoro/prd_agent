import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpLogRecorder } from '../../src/services/http-log-recorder.js';
import { createBodyCapture, type HttpLogRecord } from '../../src/services/http-log-store.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const live: HttpLogRecorder[] = [];
afterEach(() => { for (const recorder of live.splice(0)) recorder.close(); vi.restoreAllMocks(); });
const input = (id: string, changes: Partial<Omit<HttpLogRecord, '_id' | 'ts'>> = {}) => ({
  layer: 'master' as const, requestKind: 'control-plane' as const, requestId: id,
  method: 'GET', path: '/api/projects', status: 200, durationMs: 12,
  ts: new Date('2026-11-13T00:00:00.000Z'), outcome: 'ok' as const,
  request: {}, response: {}, ...changes,
});
function body(text = '{"password":"audit-secret","message":"ordinary"}') {
  const capture = createBodyCapture();
  capture.onChunk(text);
  return capture.prepareSnapshot('application/json');
}
function setup(now = () => 0) {
  const write = vi.fn();
  const recorder = new HttpLogRecorder({ record: write }, now);
  live.push(recorder);
  return { recorder, write };
}

describe('bounded read audit scheduling', () => {
  it('passes an unprocessed bounded capture to a capable sink, while errors stay inline', () => {
    const write = vi.fn(), captured = vi.fn(), recorder = new HttpLogRecorder({ record: write, recordCaptured: captured });
    live.push(recorder);
    const prepared = body(), snapshot = vi.spyOn(prepared, 'snapshot');
    recorder.record(input('worker'), prepared);
    expect(captured).toHaveBeenCalledWith(input('worker'), prepared);
    expect(snapshot).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    recorder.record(input('error', { status: 500 }), prepared);
    expect(captured).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
  });

  it('yields before redaction and preserves completion metadata and redacted payload', async () => {
    const { recorder, write } = setup(), prepared = body();
    const snapshot = vi.spyOn(prepared, 'snapshot');
    const record = input('read');
    recorder.record(record, prepared);
    expect(snapshot).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    await turn();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toEqual({ ...record, response: prepared.snapshot() });
    expect(write.mock.calls[0][0].response.bodyPreview).not.toContain('audit-secret');
    expect(write.mock.calls[0][0].response.bodyPreview).toContain('ordinary');
    expect(recorder.snapshot().queuedRecords).toBe(0);
  });

  it('limits a fast turn to four records, allowing other callbacks between batches', async () => {
    const { recorder, write } = setup();
    for (let n = 0; n < 9; n++) recorder.record(input(String(n)), body('normal'));
    await turn();
    expect(write.mock.calls.map(([r]) => r.requestId)).toEqual(['0', '1', '2', '3']);
    expect(recorder.snapshot().queuedRecords).toBe(5);
    await turn();
    expect(write).toHaveBeenCalledTimes(8);
    await turn();
    expect(write.mock.calls.map(([r]) => r.requestId)).toEqual(Array.from({ length: 9 }, (_, n) => String(n)));
  });

  it('yields after a slow record consumes the time budget', async () => {
    let now = 0;
    const write = vi.fn(() => { now += 3; });
    const recorder = new HttpLogRecorder({ record: write }, () => now);
    live.push(recorder);
    for (let n = 0; n < 3; n++) recorder.record(input(String(n)), body());
    await turn();
    expect(write).toHaveBeenCalledTimes(1);
    expect(recorder.snapshot().queuedRecords).toBe(2);
  });

  it.each([
    { status: 400 }, { status: 500 }, { method: 'POST' }, { method: 'DELETE' },
    { requestKind: 'sse' as const },
  ])('keeps errors, mutations and SSE on the immediate path: %j', changes => {
    const { recorder, write } = setup();
    recorder.record(input('protected', changes), body());
    expect(write).toHaveBeenCalledTimes(1);
    expect(recorder.snapshot().queuedRecords).toBe(0);
  });

  it('keeps preview suppression on the immediate path', () => {
    const { recorder, write } = setup();
    recorder.record(input('suppressed'), body(), true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].response.bodyPreview).toBeUndefined();
    expect(recorder.snapshot().queuedRecords).toBe(0);
  });

  it('bounds record count and writes overflow synchronously without losing any record', () => {
    const { recorder, write } = setup();
    for (let n = 0; n < 129; n++) recorder.record(input(String(n)), body());
    expect(recorder.snapshot()).toMatchObject({ queuedRecords: 128, peakRecords: 128, inlineOverflow: 1 });
    expect(write.mock.calls.map(([r]) => r.requestId)).toEqual(['128']);
    recorder.close();
    expect(new Set(write.mock.calls.map(([r]) => r.requestId)).size).toBe(129);
    expect(recorder.snapshot().queuedBytes).toBe(0);
  });

  it('bounds retained metadata bytes independently of record count', () => {
    const { recorder, write } = setup();
    const large = 'a'.repeat(1024 * 1024);
    for (let n = 0; n < 3; n++) recorder.record(input(String(n), { response: { headers: { large } } }), body());
    expect(recorder.snapshot()).toMatchObject({ queuedRecords: 1, inlineOverflow: 2 });
    expect(recorder.snapshot().peakBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(write).toHaveBeenCalledTimes(2);
    recorder.close();
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('drains on shutdown and writes late HTTP completions inline', async () => {
    const { recorder, write } = setup();
    recorder.record(input('before-close'), body());
    recorder.close();
    recorder.close();
    recorder.record(input('after-close'), body());
    await turn();
    expect(write.mock.calls.map(([r]) => r.requestId)).toEqual(['before-close', 'after-close']);
    expect(recorder.snapshot()).toMatchObject({ queuedRecords: 0, queuedBytes: 0 });
  });

  it('reports processing failures and continues draining later records', async () => {
    const { recorder, write } = setup();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    write.mockImplementationOnce(() => { throw new Error('audit failure'); });
    recorder.record(input('failed'), body());
    recorder.record(input('later'), body());
    await turn();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('deferred audit failed'));
    expect(recorder.snapshot()).toMatchObject({ failures: 1, queuedRecords: 0 });
    expect(write).toHaveBeenCalledTimes(2);
  });
});

describe('prepared response capture', () => {
  it('copies only the preview and freezes byte counts without retaining a full backing buffer', () => {
    const capture = createBodyCapture(), original = Buffer.alloc(2 * 1024 * 1024, 'a');
    capture.onChunk(original);
    const prepared = capture.prepareSnapshot('text/plain');
    expect(prepared.retainedBytes).toBe(8192);
    original.fill('b');
    capture.onChunk('later');
    expect(prepared.snapshot()).toEqual({ bodyPreview: 'a'.repeat(8192), bodyBytes: original.length });
  });

  it.each([
    ['text/plain', '普通文本\u0000中文'], ['application/json', '{"accessToken":"hidden-secret","message":"ok"}'],
    ['application/json', '{"password":"' + 's'.repeat(9000)], ['application/octet-stream', 'binary-data'],
  ])('preserves the existing snapshot policy for %s', (type, value) => {
    const capture = createBodyCapture(); capture.onChunk(value);
    expect(capture.prepareSnapshot(type).snapshot()).toEqual(capture.snapshot(type));
    if (type === 'application/octet-stream') expect(capture.prepareSnapshot(type).retainedBytes).toBe(0);
  });
});
