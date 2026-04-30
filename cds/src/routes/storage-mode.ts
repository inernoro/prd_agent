/**
 * Storage-mode router — P4 Part 18 (D.3).
 *
 * Exposes the mutable storage backend as a first-class admin surface
 * so operators can:
 *   1. See which backend is currently running (json / mongo-split / fallback)
 *   2. Health-check a candidate mongo URI before committing to the switch
 *   3. Switch json → mongo-split at runtime (with automatic state import)
 *   4. Switch mongo → json as a rollback path
 *
 * Persistence note (2026-04-18): switch-to-mongo / switch-to-json now
 * upsert/remove CDS_STORAGE_MODE / CDS_MONGO_URI / CDS_MONGO_DB lines in
 * cds/.cds.env so the next CDS restart re-enters the same mode without
 * manual operator intervention. Previously switches were runtime-only
 * and one restart silently dropped back to JSON.
 *
 * Contract summary:
 *   GET  /api/storage-mode
 *     → { mode, kind, mongoHealthy?, mongoUri?, mongoDb? }
 *   POST /api/storage-mode/test-mongo { uri, databaseName? }
 *     → { ok: true, ms } | { ok: false, message }
 *   POST /api/storage-mode/switch-to-mongo { uri, databaseName? }
 *     → { ok: true, kind: 'mongo-split', imported }
 *   POST /api/storage-mode/switch-to-json
 *     → { ok: true, kind: 'json' }
 */

import { Router } from 'express';
import path from 'node:path';
import type { StateService } from '../services/state.js';
import { JsonStateBackingStore } from '../infra/state-store/json-backing-store.js';
import { MongoSplitStateBackingStore } from '../infra/state-store/mongo-split-store.js';
import { RealMongoSplitHandle } from '../infra/state-store/mongo-split-handle.js';
import { createEnvFileOps } from '../infra/env-file.js';

/**
 * Mutable context shared between index.ts and this router. index.ts
 * creates the context at startup, seeds it with the initial resolved
 * mode, and passes it in. Every mutation here also updates the shared
 * context so subsequent GETs reflect the new state.
 */
export interface StorageModeContext {
  /** The currently-resolved running mode, user-facing. */
  resolvedMode: 'json' | 'mongo' | 'mongo-split' | 'auto-fallback-json';
  /** Mongo handle tied to the running Mongo backing store, or null. */
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

  // .cds.env sits alongside exec_cds.sh in the cds/ repo. Best-effort:
  // if the process can't write this file (e.g. readonly FS, or CDS is
  // running outside of the expected layout), switch-to-mongo still
  // succeeds at runtime — we just log a warning so operators know the
  // next restart won't re-enter mongo mode automatically.
  const envFile = createEnvFileOps(path.join(deps.repoRoot, 'cds', '.cds.env'));

  function persistMongoToEnvFile(uri: string, dbName: string): { persisted: boolean; note: string } {
    try {
      envFile.upsert('CDS_STORAGE_MODE', 'mongo-split');
      envFile.upsert('CDS_MONGO_URI', uri);
      envFile.upsert('CDS_MONGO_DB', dbName);
      return {
        persisted: true,
        note: `已将 CDS_STORAGE_MODE/CDS_MONGO_URI/CDS_MONGO_DB 写入 ${envFile.getPath()}，下次重启自动进 mongo-split 模式`,
      };
    } catch (err) {
      return {
        persisted: false,
        note: `运行时切换成功，但写 .cds.env 失败（${(err as Error).message}）。下次重启会退回 json 模式，请手动设置 CDS_STORAGE_MODE=mongo-split + CDS_MONGO_URI`,
      };
    }
  }

  function removeMongoFromEnvFile(): { persisted: boolean; note: string } {
    try {
      envFile.removeKey('CDS_STORAGE_MODE');
      envFile.removeKey('CDS_MONGO_URI');
      envFile.removeKey('CDS_MONGO_DB');
      return { persisted: true, note: `已从 ${envFile.getPath()} 清除 mongo 启动变量` };
    } catch (err) {
      return { persisted: false, note: `清除 .cds.env 里 mongo 变量失败: ${(err as Error).message}` };
    }
  }

  // GET /api/storage-mode — current state + health + startup env diagnostics
  //
  // 2026-04-18: 加入启动 env 诊断字段，以便判定 .cds.env 持久化
  // 是否真的在下次重启时被 exec_cds.sh 读到。生产实测发现切 mongo +
  // self-update 后退回 json——为这种 bug 定位加可观测性。所有字段都
  // 是 bool 或 redacted path，不暴露 URI 明文。
  router.get('/storage-mode', async (_req, res) => {
    const backing = stateService.getBackingStore();
    let mongoHealthy: boolean | undefined;
    const healthProbe = backing as { isHealthy?: () => Promise<boolean> };
    if ((backing.kind === 'mongo' || backing.kind === 'mongo-split') && typeof healthProbe.isHealthy === 'function') {
      try {
        mongoHealthy = await healthProbe.isHealthy();
      } catch {
        mongoHealthy = false;
      }
    }
    // 启动 env 诊断
    const fs = await import('node:fs');
    const envFilePath = envFile.getPath();
    const envFileExists = fs.existsSync(envFilePath);
    let envHasMongoUri = false;
    let envHasStorageMode = false;
    let envMongoStorageMode: string | null = null;
    if (envFileExists) {
      try {
        const content = fs.readFileSync(envFilePath, 'utf-8');
        envHasMongoUri = /^export\s+CDS_MONGO_URI=/m.test(content);
        envHasStorageMode = /^export\s+CDS_STORAGE_MODE=/m.test(content);
        const smMatch = content.match(/^export\s+CDS_STORAGE_MODE="?([^"\n]+)"?/m);
        envMongoStorageMode = smMatch ? smMatch[1] : null;
      } catch { /* best effort */ }
    }
    const snapshot = stateService.getState();
    const splitCollections =
      backing.kind === 'mongo-split'
        ? [
            {
              name: 'cds_projects',
              role: '项目索引',
              documents: snapshot.projects?.length || 0,
              note: '每个项目独立文档',
            },
            {
              name: 'cds_branches',
              role: '分支运行态',
              documents: Object.keys(snapshot.branches || {}).length,
              note: '按 projectId 建索引',
            },
            {
              name: 'cds_global_state',
              role: '全局小状态',
              documents: 1,
              note: '路由、变量、执行器等低频状态',
            },
          ]
        : [];

    res.json({
      mode: context.resolvedMode,
      kind: backing.kind,
      mongoHealthy,
      mongoUri: maskMongoUri(context.mongoUri),
      mongoDb: context.mongoDb,
      targetMode: 'mongo-split',
      splitCollections,
      // Diagnostics — useful for "我切了 mongo，重启怎么又回 json" 排查
      startupEnv: {
        processEnvStorageMode: process.env.CDS_STORAGE_MODE || null,
        processEnvMongoUriSet: !!process.env.CDS_MONGO_URI,
        processEnvMongoDb: process.env.CDS_MONGO_DB || null,
      },
      envFile: {
        path: envFilePath,
        exists: envFileExists,
        hasStorageMode: envHasStorageMode,
        storageModeValue: envMongoStorageMode,
        hasMongoUri: envHasMongoUri,
      },
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
    const handle = new RealMongoSplitHandle({
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

  // POST /api/storage-mode/switch-to-mongo — runtime swap json → mongo-split.
  //
  // Flow:
  //   1. Validate input + reject if already on mongo
  //   2. Create a new handle + mongo-split store, init() (connect)
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
    if (context.resolvedMode === 'mongo' || context.resolvedMode === 'mongo-split') {
      res.status(409).json({
        ok: false,
        message: `当前已经是 ${context.resolvedMode} 模式，如需换库请先切回 json 再切回来`,
      });
      return;
    }

    const dbName = databaseName || 'cds_state_db';
    const handle = new RealMongoSplitHandle({ uri, databaseName: dbName, connectTimeoutMs: 5000 });
    const newStore = new MongoSplitStateBackingStore(handle);

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
    context.resolvedMode = 'mongo-split';
    context.mongoHandle = handle;
    context.mongoUri = uri;
    context.mongoDb = dbName;
    if (oldHandle) {
      try { await oldHandle.close(); } catch { /* */ }
    }

    // Persist to .cds.env so the next CDS restart picks up mongo
    // mode automatically. Failure here doesn't roll back the runtime
    // switch — operator can fix .cds.env manually from the warning.
    const persisted = persistMongoToEnvFile(uri, dbName);

    res.json({
      ok: true,
      kind: 'mongo-split',
      imported,
      persisted: persisted.persisted,
      persistNote: persisted.note,
      message: imported
        ? '切换成功，已将当前 state 一次性导入 mongo-split'
        : '切换成功，mongo-split 已有数据，未重复导入',
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
    if (context.resolvedMode !== 'mongo' && context.resolvedMode !== 'mongo-split') {
      res.status(409).json({
        ok: false,
        message: '当前已经是 ' + context.resolvedMode + ' 模式，无需切换',
      });
      return;
    }

    const backing = stateService.getBackingStore();
    const flushable = backing as { flush?: () => Promise<void> };
    if ((backing.kind === 'mongo' || backing.kind === 'mongo-split') && typeof flushable.flush === 'function') {
      try {
        await flushable.flush();
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

    // Symmetric to switch-to-mongo: remove the persisted mongo vars
    // from .cds.env so the next restart actually honours the json
    // choice. Leaving stale CDS_MONGO_URI in .cds.env would trap the
    // operator on reboot.
    const cleaned = removeMongoFromEnvFile();

    res.json({
      ok: true,
      kind: 'json',
      persisted: cleaned.persisted,
      persistNote: cleaned.note,
      message: '已切回 JSON 模式，state.json 已重新写入',
    });
  });

  return router;
}
