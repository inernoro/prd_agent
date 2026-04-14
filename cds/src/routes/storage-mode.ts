/**
 * Storage-mode router — P4 Part 18 (D.3).
 *
 * Exposes the mutable storage backend as a first-class admin surface
 * so operators can:
 *   1. See which backend is currently running (json / mongo / fallback)
 *   2. Health-check a candidate mongo URI before committing to the switch
 *   3. Switch json → mongo at runtime (with automatic state import)
 *   4. Switch mongo → json as a rollback path
 *
 * The routes NEVER touch process.env — switches are ephemeral until
 * the operator also sets CDS_STORAGE_MODE / CDS_MONGO_URI in .cds.env
 * for the next process restart. The UI makes this explicit so users
 * aren't surprised on reboot.
 *
 * Contract summary:
 *   GET  /api/storage-mode
 *     → { mode, kind, mongoHealthy?, mongoUri?, mongoDb? }
 *   POST /api/storage-mode/test-mongo { uri, databaseName? }
 *     → { ok: true, ms } | { ok: false, message }
 *   POST /api/storage-mode/switch-to-mongo { uri, databaseName? }
 *     → { ok: true, kind: 'mongo', imported }
 *   POST /api/storage-mode/switch-to-json
 *     → { ok: true, kind: 'json' }
 */

import { Router } from 'express';
import path from 'node:path';
import type { StateService } from '../services/state.js';
import type { StateBackingStore } from '../infra/state-store/backing-store.js';
import { JsonStateBackingStore } from '../infra/state-store/json-backing-store.js';
import { MongoStateBackingStore } from '../infra/state-store/mongo-backing-store.js';
import { RealMongoHandle } from '../infra/state-store/mongo-handle.js';

/**
 * Mutable context shared between index.ts and this router. index.ts
 * creates the context at startup, seeds it with the initial resolved
 * mode, and passes it in. Every mutation here also updates the shared
 * context so subsequent GETs reflect the new state.
 */
export interface StorageModeContext {
  /** The currently-resolved running mode, user-facing. */
  resolvedMode: 'json' | 'mongo' | 'auto-fallback-json';
  /** Mongo handle tied to the running MongoStateBackingStore, or null. */
  mongoHandle: { close: () => Promise<void>; ping: () => Promise<boolean> } | null;
  /** URI used to connect the current mongo (masked for display). */
  mongoUri: string | null;
  /** Database name. */
  mongoDb: string | null;
}

export interface StorageModeRouterDeps {
  stateService: StateService;
  /** Path to the JSON state file used when falling back / switching back. */
  stateFile: string;
  /** Absolute path of the repo root, passed through to StateService helpers. */
  repoRoot: string;
  /** Shared mutable context — see interface. */
  context: StorageModeContext;
}

/**
 * Mask credentials in a mongo URI for display. Preserves the structure
 * but hides the user:password segment.
 *   mongodb://admin:secret@host:27017 → mongodb://***:***@host:27017
 */
function maskMongoUri(uri: string | null): string | null {
  if (!uri) return null;
  return uri.replace(/\/\/[^@]*@/, '//***:***@');
}

export function createStorageModeRouter(deps: StorageModeRouterDeps): Router {
  const router = Router();
  const { stateService, stateFile, context } = deps;

  // GET /api/storage-mode — current state + health
  router.get('/storage-mode', async (_req, res) => {
    const backing = stateService.getBackingStore();
    let mongoHealthy: boolean | undefined;
    if (backing.kind === 'mongo' && 'isHealthy' in backing) {
      try {
        mongoHealthy = await (backing as MongoStateBackingStore).isHealthy();
      } catch {
        mongoHealthy = false;
      }
    }
    res.json({
      mode: context.resolvedMode,
      kind: backing.kind,
      mongoHealthy,
      mongoUri: maskMongoUri(context.mongoUri),
      mongoDb: context.mongoDb,
    });
  });

  // POST /api/storage-mode/test-mongo — preflight a candidate URI
  // without touching the running store. Returns ping latency on
  // success so the UI can sanity-check connectivity.
  router.post('/storage-mode/test-mongo', async (req, res) => {
    const { uri, databaseName } = (req.body || {}) as { uri?: string; databaseName?: string };
    if (!uri || typeof uri !== 'string') {
      res.status(400).json({ ok: false, message: 'uri 不能为空' });
      return;
    }
    const handle = new RealMongoHandle({
      uri,
      databaseName: databaseName || 'cds_state_db',
      connectTimeoutMs: 5000,
    });
    const start = Date.now();
    try {
      await handle.connect();
      const healthy = await handle.ping();
      const ms = Date.now() - start;
      if (!healthy) {
        res.status(200).json({ ok: false, message: 'connect 成功但 ping 失败', ms });
        return;
      }
      res.json({ ok: true, ms });
    } catch (err) {
      res.status(200).json({ ok: false, message: (err as Error).message });
    } finally {
      try { await handle.close(); } catch { /* */ }
    }
  });

  // POST /api/storage-mode/switch-to-mongo — runtime swap json → mongo.
  //
  // Flow:
  //   1. Validate input + reject if already on mongo
  //   2. Create a new handle + mongo store, init() (connect)
  //   3. Snapshot the current stateService state
  //   4. seedIfEmpty(snapshot) — idempotent; if the collection is
  //      empty we import, else we skip import but still swap
  //   5. Call stateService.setBackingStore(mongoStore)
  //   6. Force an immediate save() so the swap is recorded in mongo
  //   7. Update context + release the old mongo handle (if any)
  //
  // On failure at any step we close the new handle and leave the
  // running store untouched — the operator sees an error and can
  // retry without corrupting anything.
  router.post('/storage-mode/switch-to-mongo', async (req, res) => {
    const { uri, databaseName } = (req.body || {}) as { uri?: string; databaseName?: string };
    if (!uri || typeof uri !== 'string') {
      res.status(400).json({ ok: false, message: 'uri 不能为空' });
      return;
    }
    if (context.resolvedMode === 'mongo') {
      res.status(409).json({
        ok: false,
        message: '当前已经是 mongo 模式，如需换库请先切回 json 再切回来',
      });
      return;
    }

    const dbName = databaseName || 'cds_state_db';
    const handle = new RealMongoHandle({ uri, databaseName: dbName, connectTimeoutMs: 5000 });
    const newStore = new MongoStateBackingStore(handle);

    try {
      await newStore.init();
    } catch (err) {
      try { await handle.close(); } catch { /* */ }
      res.status(500).json({ ok: false, message: 'mongo connect 失败: ' + (err as Error).message });
      return;
    }

    // Idempotent import: if the collection is already seeded (e.g.
    // operator previously switched to mongo then rolled back, and the
    // mongo data is newer), we don't clobber it. Otherwise we import
    // the current in-memory state so mongo starts with the same
    // snapshot the operator sees in the UI.
    const snapshot = stateService.getState();
    let imported = false;
    try {
      imported = await newStore.seedIfEmpty(snapshot);
    } catch (err) {
      try { await newStore.close(); } catch { /* */ }
      res.status(500).json({ ok: false, message: 'seed 失败: ' + (err as Error).message });
      return;
    }

    // Swap + force-flush. stateService.save() runs synchronously
    // into the new store's write-behind cache; flush() waits for
    // the upsert to land before we return success.
    const oldHandle = context.mongoHandle;
    stateService.setBackingStore(newStore);
    stateService.save();
    try {
      await newStore.flush();
    } catch (err) {
      // Revert on flush failure so the operator isn't left with a
      // store that "switched" but doesn't persist.
      stateService.setBackingStore(new JsonStateBackingStore(stateFile));
      try { await newStore.close(); } catch { /* */ }
      res.status(500).json({ ok: false, message: 'flush 失败: ' + (err as Error).message });
      return;
    }

    // Update context and tear down the previous mongo handle if any.
    context.resolvedMode = 'mongo';
    context.mongoHandle = handle;
    context.mongoUri = uri;
    context.mongoDb = dbName;
    if (oldHandle) {
      try { await oldHandle.close(); } catch { /* */ }
    }

    res.json({
      ok: true,
      kind: 'mongo',
      imported,
      message: imported
        ? '切换成功，已将当前 state 一次性导入 mongo'
        : '切换成功，mongo 已有数据，未重复导入',
    });
  });

  // POST /api/storage-mode/switch-to-json — rollback to file mode.
  //
  // Flow:
  //   1. Reject if already on json
  //   2. Flush pending mongo writes
  //   3. Build a JsonStateBackingStore + save current state to disk
  //   4. Swap + update context
  //   5. Close the mongo handle
  router.post('/storage-mode/switch-to-json', async (_req, res) => {
    if (context.resolvedMode !== 'mongo') {
      res.status(409).json({
        ok: false,
        message: '当前已经是 ' + context.resolvedMode + ' 模式，无需切换',
      });
      return;
    }

    const backing = stateService.getBackingStore();
    if (backing.kind === 'mongo' && 'flush' in backing) {
      try {
        await (backing as MongoStateBackingStore).flush();
      } catch (err) {
        res.status(500).json({
          ok: false,
          message: '最终刷新 mongo 失败: ' + (err as Error).message,
        });
        return;
      }
    }

    const jsonStore = new JsonStateBackingStore(stateFile);
    try {
      // Ensure the target dir exists — StateService's filePath lives
      // under repoRoot/.cds/ which should already exist, but on a
      // freshly-created mongo-first install it might not.
      const fs = await import('node:fs');
      const dir = path.dirname(stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      jsonStore.save(stateService.getState());
    } catch (err) {
      res.status(500).json({
        ok: false,
        message: 'state.json 写入失败: ' + (err as Error).message,
      });
      return;
    }

    const oldHandle = context.mongoHandle;
    stateService.setBackingStore(jsonStore);
    context.resolvedMode = 'json';
    context.mongoHandle = null;
    context.mongoUri = null;
    context.mongoDb = null;

    if (oldHandle) {
      try { await oldHandle.close(); } catch { /* */ }
    }

    res.json({ ok: true, kind: 'json', message: '已切回 JSON 模式，state.json 已重新写入' });
  });

  return router;
}
