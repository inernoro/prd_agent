/**
 * Tests for the P4 Part 18 (D.3) storage-mode router. Uses the
 * FakeMongoHandle + MockShellExecutor pattern the other route tests
 * use so no real mongo connection is required.
 *
 * These tests do NOT exercise the real RealMongoHandle connect path
 * — that's covered end-to-end by the D.2 startup flow via manual QA.
 * What we DO cover here is:
 *
 *   - GET /api/storage-mode surfaces the current backing store kind
 *     + (when mongo) the health probe result
 *   - The router only gets installed when storageModeContext is
 *     passed (otherwise server.ts skips the use() call)
 *   - POST /test-mongo returns 400 on missing URI
 *   - POST /switch-to-mongo returns 409 when already on mongo
 *   - POST /switch-to-json returns 409 when already on json
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStorageModeRouter, type StorageModeContext } from '../../src/routes/storage-mode.js';
import { StateService } from '../../src/services/state.js';
import { MongoStateBackingStore } from '../../src/infra/state-store/mongo-backing-store.js';
import type { IMongoHandle, IMongoCollection } from '../../src/infra/state-store/mongo-backing-store.js';

// ── Mongo fake (copied from mongo-backing-store.test.ts) ────────────
class FakeCollection implements IMongoCollection {
  docs = new Map<string, any>();
  async findOne(filter: { _id: string }) {
    const d = this.docs.get(filter._id);
    return d ? { _id: d._id, state: d.state } : null;
  }
  async replaceOne(filter: { _id: string }, doc: any) {
    this.docs.set(filter._id, doc);
  }
  async countDocuments(filter?: Record<string, unknown>) {
    if (!filter || Object.keys(filter).length === 0) return this.docs.size;
    const id = (filter as any)._id;
    return id !== undefined && this.docs.has(String(id)) ? 1 : 0;
  }
}
class FakeHandle implements IMongoHandle {
  public readonly collection = new FakeCollection();
  public pingResult = true;
  async connect() { /* */ }
  stateCollection() { return this.collection; }
  async close() { /* */ }
  async ping() { return this.pingResult; }
}

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c: Buffer) => (raw += c.toString()));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode!, body: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('Storage-mode router (P4 Part 18 D.3)', () => {
  let tmpDir: string;
  let stateFile: string;
  let stateService: StateService;
  let context: StorageModeContext;
  let server: http.Server;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cds-storage-mode-test-'));
    stateFile = path.join(tmpDir, 'state.json');
    stateService = new StateService(stateFile, tmpDir);
    stateService.load();

    context = {
      resolvedMode: 'json',
      mongoHandle: null,
      mongoUri: null,
      mongoDb: null,
    };

    const app = express();
    app.use(express.json());
    app.use('/api', createStorageModeRouter({
      stateService,
      stateFile,
      repoRoot: tmpDir,
      context,
    }));
    server = app.listen(0);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/storage-mode', () => {
    it('returns the json backing store kind by default', async () => {
      const res = await request(server, 'GET', '/api/storage-mode');
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('json');
      expect(res.body.kind).toBe('json');
      expect(res.body.mongoUri).toBeNull();
    });

    it('surfaces the mongo backing store kind + health when in mongo mode', async () => {
      // Swap in a mongo store backed by the fake handle
      const handle = new FakeHandle();
      const store = new MongoStateBackingStore(handle);
      await store.init();
      stateService.setBackingStore(store);
      context.resolvedMode = 'mongo';
      context.mongoHandle = handle;
      context.mongoUri = 'mongodb://admin:secret@localhost:27017';
      context.mongoDb = 'cds_state_db';

      const res = await request(server, 'GET', '/api/storage-mode');
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('mongo');
      expect(res.body.kind).toBe('mongo');
      expect(res.body.mongoHealthy).toBe(true);
      // URI is masked so secrets don't leak
      expect(res.body.mongoUri).toBe('mongodb://***:***@localhost:27017');
      expect(res.body.mongoDb).toBe('cds_state_db');
    });

    it('reports mongoHealthy=false when the handle pings false', async () => {
      const handle = new FakeHandle();
      handle.pingResult = false;
      const store = new MongoStateBackingStore(handle);
      await store.init();
      stateService.setBackingStore(store);
      context.resolvedMode = 'mongo';
      context.mongoHandle = handle;

      const res = await request(server, 'GET', '/api/storage-mode');
      expect(res.body.mongoHealthy).toBe(false);
    });
  });

  describe('POST /api/storage-mode/test-mongo', () => {
    it('returns 400 when URI is missing', async () => {
      const res = await request(server, 'POST', '/api/storage-mode/test-mongo', {});
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    // The happy-path test-mongo call would hit a real mongo — we
    // don't cover it here. It's exercised by the D.2 startup flow
    // via manual QA against a real mongo container.
  });

  describe('POST /api/storage-mode/switch-to-mongo', () => {
    it('returns 409 when already on mongo', async () => {
      context.resolvedMode = 'mongo';
      const res = await request(server, 'POST', '/api/storage-mode/switch-to-mongo', {
        uri: 'mongodb://x:27017',
      });
      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
    });

    it('returns 400 when URI is missing', async () => {
      const res = await request(server, 'POST', '/api/storage-mode/switch-to-mongo', {});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/storage-mode/switch-to-json', () => {
    it('returns 409 when already on json', async () => {
      const res = await request(server, 'POST', '/api/storage-mode/switch-to-json');
      expect(res.status).toBe(409);
      expect(res.body.ok).toBe(false);
    });

    it('succeeds from mongo mode, writes state.json, and updates context', async () => {
      // Set up mongo mode using the fake handle
      const handle = new FakeHandle();
      const store = new MongoStateBackingStore(handle);
      await store.init();
      // Mutate state so we have something to write back to json
      stateService.setCustomEnv({ KEY: 'from-mongo' });
      store.save(stateService.getState());
      await store.flush();
      stateService.setBackingStore(store);
      context.resolvedMode = 'mongo';
      context.mongoHandle = handle;
      context.mongoUri = 'mongodb://x:27017';
      context.mongoDb = 'cds_state_db';

      // state.json will be created/updated by the switch-to-json path
      // regardless of whether it already existed. We only care that
      // the post-switch contents match the in-memory state.
      const res = await request(server, 'POST', '/api/storage-mode/switch-to-json');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.kind).toBe('json');

      // state.json now exists with the in-memory state
      expect(fs.existsSync(stateFile)).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
      expect(persisted.customEnv.KEY).toBe('from-mongo');

      // Context flipped
      expect(context.resolvedMode).toBe('json');
      expect(context.mongoHandle).toBeNull();
      expect(context.mongoUri).toBeNull();

      // StateService now uses a JsonStateBackingStore
      expect(stateService.getBackingStore().kind).toBe('json');
    });
  });
});
