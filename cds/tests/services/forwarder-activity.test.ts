import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ForwarderActivityReader, ForwarderActivityWriter, ACTIVITY_MAX_AGE_MS } from '../../src/services/forwarder-activity.js';
import { probeRequestHeaders, PROBE_MARKER_HEADER } from '../../src/services/probe-marker.js';

describe('forwarder activity across independent processes', () => {
  let dir: string, file: string, now: number;
  let writer: ForwarderActivityWriter, reader: ForwarderActivityReader;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cbd-activity-'));
    file = path.join(dir, 'routes.activity.json'); now = 1700000000000;
    writer = new ForwarderActivityWriter(file, () => now);
    reader = new ForwarderActivityReader(file, () => now);
  });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const noop = () => {};

  it('keeps real API flow active, finishes idempotently and never substitutes read time', async () => {
    const end = writer.begin('app', {}, '/api/orders');
    await writer.flush(); await reader.refresh();
    expect(reader.activity('app')).toEqual({ at: now, active: true });
    now += 2000; end(); end();
    await writer.flush(); await reader.refresh();
    const observed = now; now += 3000; await reader.refresh();
    expect(reader.activity('app')).toEqual({ at: observed, active: false });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('excludes only trusted probe tokens; public polling and fake tokens remain real visits', async () => {
    writer.begin('probe', probeRequestHeaders(), '/');
    writer.begin('poll', { 'x-cds-poll': 'true' }, '/api/items');
    writer.begin('fake', { [PROBE_MARKER_HEADER]: 'untrusted' }, '/');
    await writer.flush(); await reader.refresh();
    expect(reader.activity('probe')).toEqual({ at: 0, active: false });
    expect(reader.activity('poll')?.active).toBe(true);
    expect(reader.activity('fake')?.active).toBe(true);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).not.toContain(probeRequestHeaders()[PROBE_MARKER_HEADER]);
    expect(raw).not.toContain('/api/items');
  });

  it('ignores control-plane widgets and unmapped hosts', async () => {
    writer.begin('app', {}, '/_cds/api/stream');
    writer.begin('app', {}, '/__forwarder/healthz');
    writer.begin(undefined, {}, '/');
    await writer.flush(); await reader.refresh();
    expect(reader.activity('app')).toEqual({ at: 0, active: false });
  });

  it('makes missing, expired, oversized, malformed and future snapshots unavailable', async () => {
    await reader.refresh(); expect(reader.activity('app')).toBeNull();
    writer.begin('app', {}, '/'); await writer.flush(); await reader.refresh();
    now += ACTIVITY_MAX_AGE_MS + 1; expect(reader.activity('app')).toBeNull();
    for (const body of ['{', 'x'.repeat(2 * 1024 * 1024 + 1), JSON.stringify({ version: 1, at: now + 1, rows: [], overflow: false }),
      JSON.stringify({ version: 1, at: now, overflow: false, rows: [{ branchId: 'app', probeHash: '', at: now, active: -1 }] })]) {
      await fs.writeFile(file, body); await reader.refresh(); expect(reader.activity('app')).toBeNull();
    }
  });

  it('keeps overflow fail-closed rather than silently forgetting a dropped visit', async () => {
    for (let i = 0; i < 4096; i++) writer.begin(`b${i}`, {}, '/');
    const end = writer.begin('overflow', {}, '/');
    now += ACTIVITY_MAX_AGE_MS * 2;
    await writer.flush(); await reader.refresh(); expect(reader.activity('b1')).toBeNull();
    end(); end(); now += ACTIVITY_MAX_AGE_MS + 1;
    await writer.flush(); await reader.refresh(); expect(reader.activity('b1')).toBeNull();
  });

  it('observes a real HTTP response lifetime without storing request secrets', async () => {
    let finish: () => void = noop;
    const server = http.createServer((req, res) => {
      const end = writer.begin('app', req.headers, req.url || '/');
      res.once('close', end); res.once('finish', end);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: ready\n\n');
      finish = () => res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/api/stream?secret=private`, { headers: { Cookie: 'session=private' } }, resolve).on('error', reject);
      });
      response.resume();
      await writer.flush(); await reader.refresh(); expect(reader.activity('app')?.active).toBe(true);
      const ended = new Promise<void>(resolve => response.on('end', resolve)); finish(); await ended;
      await writer.flush(); await reader.refresh(); expect(reader.activity('app')?.active).toBe(false);
      expect(await fs.readFile(file, 'utf8')).not.toContain('private');
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
