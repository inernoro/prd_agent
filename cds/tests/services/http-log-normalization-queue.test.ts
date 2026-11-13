import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { HttpLogNormalizationQueue } from '../../src/services/http-log-normalization-queue.js';
import { createBodyCapture, HttpLogStore, normalizeCapturedHttpLog, normalizeHttpLogRecord,
  type CapturedHttpLog, type HttpLogRecord } from '../../src/services/http-log-store.js';

const queues = new Set<HttpLogNormalizationQueue>();
let directory: string, workerFile: string;
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cds-audit-worker-'));
  workerFile = path.join(directory, 'worker.cjs');
  const entry = new URL('../../src/services/http-log-normalization-worker.ts', import.meta.url);
  await build({ entryPoints: [fileURLToPath(entry)], outfile: workerFile, bundle: true, platform: 'node', format: 'cjs',
    define: { 'import.meta.url': JSON.stringify(entry.href) }, logLevel: 'warning' });
});
afterEach(async () => { for (const queue of queues) await queue.close(); queues.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });
afterAll(async () => { await fs.rm(directory, { recursive: true, force: true }); });

function input(id: string, text = '{"password":"worker-secret","message":"ordinary"}'): CapturedHttpLog {
  const capture = createBodyCapture(); capture.onChunk(text);
  return { record: { layer: 'master', requestKind: 'control-plane', requestId: id, method: 'GET',
    path: '/api/branches', status: 200, durationMs: 15, outcome: 'ok', ts: new Date('2026-11-13T00:00:00Z'),
    request: { headers: { authorization: 'Bearer worker-header-secret' } },
    response: { headers: { 'content-type': 'application/json' } } }, body: capture.prepareSnapshot('application/json').serialize() };
}
class FakeWorker extends EventEmitter {
  sent: Array<{ id: number; input: CapturedHttpLog }> = [];
  postMessage(message: { id: number; input: CapturedHttpLog }) { this.sent.push(message); }
  ref() { return this; } unref() { return this; }
  async terminate() { return 1; }
  reply() { const message = this.sent.at(-1)!; this.emit('message', { id: message.id, record: normalizeCapturedHttpLog(message.input) }); }
}
function setup(real = false) {
  const records: HttpLogRecord[] = [], failed = vi.fn(), fake = new FakeWorker();
  const factory = vi.fn(() => real ? new Worker(workerFile, { resourceLimits: { maxOldGenerationSizeMb: 64 } }) : fake as unknown as Worker);
  const queue = new HttpLogNormalizationQueue({ workerFactory: factory, onNormalized: record => records.push(record),
    onInline: job => records.push(normalizeCapturedHttpLog(job)), onFailure: failed });
  queues.add(queue);
  return { queue, records, failed, fake, factory };
}
const withoutId = ({ _id: _ignored, ...record }: HttpLogRecord) => record;

describe('private HTTP audit CPU worker', () => {
  it('runs both existing redaction steps in a real worker with identical payload semantics', async () => {
    const { queue, records, failed } = setup(true);
    const texts = [
      '{"password":"worker-secret","message":"ordinary"}',
      '{"accessToken":"' + 's'.repeat(9000),
      'ordinary 中文\u0000 text ct_AuditCanary0123456789abcdefghijklmnop',
    ];
    const expected = texts.map((text, n) => {
      const job = input(String(n), text), capture = createBodyCapture(); capture.onChunk(text);
      queue.enqueue(job);
      return normalizeHttpLogRecord({ ...job.record, response: { ...job.record.response, ...capture.snapshot('application/json') } });
    });
    await queue.flush();
    expect(failed).not.toHaveBeenCalled();
    expect(queue.snapshot()).toMatchObject({ normalized: 3, inline: 0, workerFailures: 0, queuedBytes: 0 });
    expect(records.map(withoutId)).toEqual(expected.map(withoutId));
    expect(JSON.stringify(records)).not.toContain('worker-secret');
    expect(JSON.stringify(records)).not.toContain('worker-header-secret');
    expect(JSON.stringify(records)).not.toContain('ct_AuditCanary');
  });

  it('has one in-flight message and bounds count without dropping overflow', async () => {
    const { queue, records, fake, factory } = setup();
    for (let n = 0; n < 129; n++) queue.enqueue(input(String(n)));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.sent).toHaveLength(1);
    expect(records.map(r => r.requestId)).toEqual(['128']);
    expect(queue.snapshot()).toMatchObject({ queuedRecords: 128, peakRecords: 128, capacityFallback: 1 });
    for (let n = 0; n < 128; n++) fake.reply();
    await queue.flush();
    expect(new Set(records.map(r => r.requestId)).size).toBe(129);
    expect(records.slice(1).map(r => r.requestId)).toEqual(Array.from({ length: 128 }, (_, n) => String(n)));
    expect(queue.snapshot().queuedBytes).toBe(0);
  });

  it('counts active payload toward the byte budget', () => {
    const { queue, records } = setup();
    for (let n = 0; n < 3; n++) {
      const job = input(String(n)); job.record.response.headers!.large = 'a'.repeat(1024 * 1024); queue.enqueue(job);
    }
    expect(queue.snapshot()).toMatchObject({ queuedRecords: 1, capacityFallback: 2 });
    expect(queue.snapshot().peakBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(records).toHaveLength(2);
  });

  it('reports worker failure, recovers every pending record once, and ignores late messages', async () => {
    const { queue, records, fake, failed } = setup();
    for (let n = 0; n < 4; n++) queue.enqueue(input(String(n)));
    fake.emit('error', new Error('worker unavailable'));
    fake.reply();
    queue.enqueue(input('late'));
    await queue.flush();
    expect(failed).toHaveBeenCalledTimes(1);
    expect(records.map(r => r.requestId)).toEqual(['0', '1', '2', '3', 'late']);
    expect(queue.snapshot()).toMatchObject({ workerFailures: 1, inline: 5, queuedRecords: 0, queuedBytes: 0 });
  });

  it('recovers a stalled worker within the background deadline', async () => {
    vi.useFakeTimers();
    const { queue, records, failed } = setup();
    queue.enqueue(input('stalled'));
    await vi.advanceTimersByTimeAsync(5000);
    await queue.flush();
    expect(records).toHaveLength(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(queue.snapshot().workerFailures).toBe(1);
  });

  it('drains synchronously on close, terminates the worker and handles late completions inline', async () => {
    const { queue, records, fake, factory } = setup();
    queue.enqueue(input('active')); queue.enqueue(input('pending'));
    await queue.close(); fake.reply(); queue.enqueue(input('late'));
    expect(records.map(r => r.requestId)).toEqual(['active', 'pending', 'late']);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(queue.snapshot()).toMatchObject({ queuedRecords: 0, queuedBytes: 0 });
  });
});

describe('hot normalized bodies with cold worker isolation', () => {
  function storeSetup() {
    const records: HttpLogRecord[] = [];
    const factory = vi.fn(() => new Worker(workerFile));
    const store = new HttpLogStore({ uri: 'mongodb://unused' }, factory);
    Object.assign(store, { collection: { insertOne: async (doc: HttpLogRecord) => { records.push(doc); }, countDocuments: async () => 0 } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    return { store, records, factory, log };
  }

  it('skips hot IPC but independently normalizes each request, headers and observed byte count', async () => {
    const { store, records, factory, log } = storeSetup();
    const expected: HttpLogRecord[] = [];
    try {
      for (let n = 0; n < 3; n++) {
        const text = '{"password":"memo-secret","text":"' + 'x'.repeat(9000) + '"}' + ' '.repeat(n);
        const job = input('memo-' + n, text), capture = createBodyCapture(); capture.onChunk(text);
        job.record.durationMs += n; job.record.status += n;
        job.record.response.headers!['x-sequence'] = String(n);
        job.record.request.bodyPreview = JSON.stringify({ publicSequence: n, password: 'request-secret-' + n });
        expected.push(normalizeCapturedHttpLog(job));
        store.recordCaptured(job.record, capture.prepareSnapshot('application/json'));
        await store.flush();
      }
      expect(records.map(withoutId)).toEqual(expected.map(withoutId));
      expect(new Set(records.map(r => r._id)).size).toBe(3);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(records)).not.toContain('memo-secret');
      expect(JSON.stringify(records)).not.toContain('request-secret');
    } finally { await store.close(); }
    const summary = JSON.parse(log.mock.calls.find(args => args[0] === '[http-log] normalization summary:')![1]);
    log.mockRestore();
    expect(summary.normalized).toBe(1);
    expect(summary.redactionCache).toMatchObject({ hits: 2, misses: 1 });
  });

  it('bounds final previews and evicts instead of retaining every observed body', async () => {
    const { store, records, log } = storeSetup();
    try {
      for (let n = 0; n < 25; n++) {
        const text = JSON.stringify({ n: n % 24, text: 'x'.repeat(9000) }), capture = createBodyCapture(); capture.onChunk(text);
        store.recordCaptured(input(String(n), text).record, capture.prepareSnapshot('application/json'));
        await store.flush();
      }
      expect(records).toHaveLength(25);
    } finally { await store.close(); }
    const summary = JSON.parse(log.mock.calls.find(args => args[0] === '[http-log] normalization summary:')![1]);
    log.mockRestore();
    expect(summary.normalized).toBe(25);
    expect(summary.redactionCache.entries).toBeLessThanOrEqual(16);
    expect(summary.redactionCache.peakBytes).toBeLessThanOrEqual(128 * 1024);
    expect(summary.redactionCache.evictions).toBeGreaterThan(0);
  });

  it('does not reuse textual previews for binary headers or suppressed preview routes', async () => {
    const { store, records, log } = storeSetup();
    const text = 'private-body-' + 'x'.repeat(500), expected: HttpLogRecord[] = [];
    try {
      for (let n = 0; n < 3; n++) {
        const job = input('policy-' + n, text), capture = createBodyCapture(); capture.onChunk(text);
        if (n === 1) job.record.response.headers = { 'Content-Type': 'application/octet-stream' };
        if (n === 2) { job.record.path = '/api/hosted-site-preview-files/bootstrap/private-ticket'; job.record.requestKind = 'container-op'; }
        expected.push(normalizeCapturedHttpLog(job));
        store.recordCaptured(job.record, capture.prepareSnapshot('text/plain'));
        await store.flush();
      }
      expect(records.map(withoutId)).toEqual(expected.map(withoutId));
      expect(records[1].response.bodyPreview).not.toContain('private-body');
      expect(JSON.stringify(records[2].response)).not.toContain('private-body');
    } finally { await store.close(); log.mockRestore(); }
  });
});

describe('sample before preparing captured bodies', () => {
  it('preserves the GET sampling rule and all branch-list samples before serialization', async () => {
    const store = new HttpLogStore({ uri: 'mongodb://unused' }), enqueue = vi.fn();
    const insertOne = vi.fn(async () => {});
    Object.assign(store, { collection: { insertOne, countDocuments: async () => 0 },
      normalizer: { enqueue, flush: async () => {}, close: async () => {}, snapshot: () => ({}) } });
    const capture = createBodyCapture(); capture.onChunk('ordinary');
    const prepared = capture.prepareSnapshot(), serialize = vi.spyOn(prepared, 'serialize');
    for (let n = 0; n < 10; n++) store.recordCaptured({ ...input(String(n)).record, path: '/api/projects' }, prepared);
    expect(enqueue).toHaveBeenCalledTimes(1); expect(serialize).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 10; n++) store.recordCaptured(input('branch-' + n).record, prepared);
    expect(enqueue).toHaveBeenCalledTimes(11);
    store.recordCaptured({ ...input('error').record, status: 500 }, prepared);
    await store.flush();
    expect(enqueue).toHaveBeenCalledTimes(11); expect(insertOne).toHaveBeenCalledTimes(1);
    await store.close();
  });
});
