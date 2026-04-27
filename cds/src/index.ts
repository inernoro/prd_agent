import http from 'node:http';
import os from 'node:os';
import express from 'express';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadConfig } from './config.js';
import { discoverComposeFiles, parseCdsCompose } from './services/compose-parser.js';
import fs from 'node:fs';
import { createServer, installSpaFallback, broadcastActivity, nextActivitySeq } from './server.js';
import type { ActivityEvent } from './server.js';
import { ShellExecutor } from './services/shell-executor.js';
import { StateService } from './services/state.js';
import { WorktreeService } from './services/worktree.js';
import { ContainerService } from './services/container.js';
import { ProxyService } from './services/proxy.js';
import { SchedulerService } from './services/scheduler.js';
import { JanitorService } from './services/janitor.js';
import { BridgeService } from './services/bridge.js';
import { buildPreviewUrl } from './services/comment-template.js';
import crypto from 'node:crypto';
import { BranchDispatcher, HttpSnapshotFetcher } from './scheduler/dispatcher.js';
import { ExecutorAgent } from './executor/agent.js';
import { createExecutorRouter } from './executor/routes.js';
import { ExecutorRegistry } from './scheduler/executor-registry.js';
import { createSchedulerRouter } from './scheduler/routes.js';
import { createClusterRouter } from './routes/cluster.js';
import { updateEnvFile, defaultEnvFilePath } from './services/env-file.js';

/**
 * 2026-04-18 bug fix — .cds.env self-loader.
 *
 * 历史行为：依赖 exec_cds.sh 的 load_env() 在 bash 层 source .cds.env，
 * 再 exec node。但 systemd-managed 部署（cds-master.service 的
 * `ExecStart=/usr/bin/node dist/index.js`）会直接 exec node，绕过
 * exec_cds.sh，于是 `.cds.env` 里的 `export CDS_MONGO_URI=...` 永远
 * 不会进入 process.env。生产侧诊断发现：
 *   切 Mongo → persisted=true → systemd 重启 → mode=json（URI 没读到）
 *
 * 修复策略：node 启动一开始自己解析 .cds.env，与 shell 无关。
 * 已经在 process.env 里的变量（systemd Environment= 或 shell export）
 * **不覆盖**，保证运维显式设置仍然有最高优先级。
 *
 * 支持语法：`export KEY="value"` 和 `KEY="value"`，值里 bash 双引号
 * 转义（\\ \" \$）反向 unescape。忽略 `#` 注释行和空行。
 *
 * 位置：必须在 loadConfig() 之前调用，否则 config 里引用的
 * repoRoot / rootDomains 等还是从未配置的 env 读。
 */
function loadCdsEnvFile(): void {
  const candidates = [
    path.resolve(process.cwd(), '.cds.env'),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '.cds.env'),
  ];
  for (const envPath of candidates) {
    try {
      if (!fs.existsSync(envPath)) continue;
      const content = fs.readFileSync(envPath, 'utf-8');
      const lineRe = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S*))\s*$/;
      let loaded = 0;
      for (const line of content.split('\n')) {
        if (!line || /^\s*#/.test(line)) continue;
        const m = line.match(lineRe);
        if (!m) continue;
        const key = m[1];
        const raw = m[2] ?? m[3] ?? m[4] ?? '';
        // Unescape bash double-quoted: \" \\ \$ → " \ $
        const value = (m[2] !== undefined)
          ? raw.replace(/\\(.)/g, '$1')
          : raw;
        // process.env 已有值（systemd/shell 显式设置）优先
        if (process.env[key] === undefined) {
          process.env[key] = value;
          loaded++;
        }
      }
      if (loaded > 0) {
        // 用 console.log 而不是 logger，这一步比 logger 早
        console.log(`[cds-env-loader] 从 ${envPath} 加载 ${loaded} 个变量到 process.env`);
      }
      return; // 只读第一个找到的
    } catch (err) {
      console.warn(`[cds-env-loader] 跳过 ${envPath}: ${(err as Error).message}`);
    }
  }
}

// 必须在 loadConfig 之前调用
loadCdsEnvFile();

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value.split(',').map(v => v.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

const configPath = process.argv[2] || undefined;
const config = loadConfig(configPath);

const shell = new ShellExecutor();

// ── State ──
//
// CDS_STORAGE_MODE selects the physical storage backend that the
// StateService writes through. See doc/plan.cds-multi-project-phases.md P3
// and doc/rule.cds-mongo-migration.md.
//
//   - 'json'  (default): state.json on disk with rolling .bak.* backups
//   - 'mongo':           MongoDB-backed store (P4 Part 18 D.1-D.2).
//                        Fails fast on connection error so operators
//                        notice immediately instead of silently losing
//                        writes.
//   - 'auto':            Try mongo, fall back to json with a WARN log
//                        when mongo isn't reachable. Default for new
//                        installs that want "mongo if available, file
//                        otherwise" semantics without config.
//
// CDS_MONGO_URI + CDS_MONGO_DB configure the connection. Absent →
// auto-mode falls back to json; mongo-mode throws.
const stateFile = path.join(config.repoRoot, '.cds', 'state.json');
const rawStorageMode = (process.env.CDS_STORAGE_MODE || 'json').toLowerCase();
if (!['json', 'mongo', 'mongo-split', 'auto'].includes(rawStorageMode)) {
  throw new Error(
    `Unknown CDS_STORAGE_MODE '${rawStorageMode}'. Valid values: 'json' | 'mongo' | 'mongo-split' | 'auto'.`,
  );
}
/**
 * P4 Part 18 (D.2): storage-mode resolution.
 *
 * Behaviour matrix (updated 2026-04-18):
 *   - 'json' mode                     → JSON backing (legacy)
 *   - 'mongo' mode + URI connect OK   → Mongo backing
 *   - 'mongo' mode + URI missing/fail → throw (FATAL) — operator must fix
 *   - 'auto' mode + URI missing       → JSON backing (silent; expected)
 *   - 'auto' mode + URI present + OK  → Mongo backing
 *   - 'auto' mode + URI present + fail→ throw (FATAL) — was fallback before
 *
 * The only fallback remaining is the "auto + no URI" case, which maps
 * to JSON because the operator didn't ask for Mongo at all. Once a URI
 * is present, we treat Mongo as the contract — silently dropping to
 * JSON with the URI still configured led to "I swore I was on Mongo but
 * state.json kept growing" confusion in production.
 *
 * Rollback path: operators can still call POST /api/storage-mode/switch-to-json
 * from the Dashboard to return to JSON mode — that path clears the
 * .cds.env Mongo vars atomically. So "Mongo is down and I need CDS up"
 * is "unset CDS_MONGO_URI in .cds.env or set CDS_STORAGE_MODE=json, restart".
 */
// Definite-assignment: initStateService() is awaited at module top
// level before any downstream code touches stateService. The `!`
// tells TypeScript we've satisfied that contract.
let stateService!: StateService;
/** When mongo is active (either mode=mongo or mode=auto + connected)
 *  we stash the handle here so the Settings panel / shutdown hook
 *  can flush + close it without reaching back into StateService. */
let activeMongoHandle: { close: () => Promise<void> } | null = null;
/** Records which backend actually ended up running — surfaced via
 *  GET /api/storage-mode for the Settings panel and startup logs. */
let storageModeResolved: 'json' | 'mongo' | 'mongo-split' | 'auto-fallback-json' = 'json';

async function initStateService(): Promise<void> {
  // JSON path — unchanged from pre-D.2 behaviour.
  if (rawStorageMode === 'json') {
    stateService = new StateService(stateFile, config.repoRoot);
    stateService.load();
    storageModeResolved = 'json';
    return;
  }

  // Lazy-import the mongo bits so a 'json'-mode CDS never pulls the
  // driver into memory on startup.
  const { JsonStateBackingStore } = await import('./infra/state-store/json-backing-store.js');

  const uri = process.env.CDS_MONGO_URI;
  const dbName = process.env.CDS_MONGO_DB || 'cds_state_db';

  if (!uri) {
    if (rawStorageMode === 'mongo' || rawStorageMode === 'mongo-split') {
      throw new Error(
        `CDS_STORAGE_MODE=${rawStorageMode} requires CDS_MONGO_URI to be set (e.g. mongodb://localhost:27017).`,
      );
    }
    // auto mode without URI → straight to json, no warning (expected)
    console.log('  [storage] CDS_STORAGE_MODE=auto + no CDS_MONGO_URI → using JSON backend');
    stateService = new StateService(stateFile, config.repoRoot);
    stateService.load();
    storageModeResolved = 'auto-fallback-json';
    return;
  }

  // ── mongo-split: PR_B.5 起的多 collection 模式 ──
  // cds_projects / cds_branches 各自独立 collection，
  // cds_global_state 仍是单文档放剩余字段。
  if (rawStorageMode === 'mongo-split') {
    const { MongoSplitStateBackingStore } = await import('./infra/state-store/mongo-split-store.js');
    const { RealMongoSplitHandle } = await import('./infra/state-store/mongo-split-handle.js');
    const splitHandle = new RealMongoSplitHandle({ uri, databaseName: dbName });
    const splitStore = new MongoSplitStateBackingStore(splitHandle);
    try {
      await splitStore.init();
    } catch (err) {
      const msg = (err as Error).message;
      console.error(
        `  [storage] FATAL: CDS_STORAGE_MODE=mongo-split init 失败: ${msg}`,
      );
      try { await splitHandle.close(); } catch { /* best effort */ }
      throw err;
    }
    // Seed: 全空 mongo + 有 state.json → 把 JSON 一次性导入 split collections
    if (splitStore.load() === null) {
      const jsonStore = new JsonStateBackingStore(stateFile);
      const existing = jsonStore.load();
      if (existing) {
        console.log('  [storage] mongo-split 全空但 state.json 存在 — seed 数据中');
        await splitStore.seedIfEmpty(existing);
      }
    }
    stateService = new StateService(stateFile, config.repoRoot, splitStore);
    stateService.load();
    storageModeResolved = 'mongo-split';
    activeMongoHandle = splitHandle;
    console.log(
      `  [storage] mongo-split backend active (uri=${uri.replace(/\/\/[^@]*@/, '//***:***@')}, db=${dbName}, collections=cds_projects/cds_branches/cds_global_state)`,
    );
    return;
  }

  // ── mongo (single doc, legacy) ──
  const { MongoStateBackingStore } = await import('./infra/state-store/mongo-backing-store.js');
  const { RealMongoHandle } = await import('./infra/state-store/mongo-handle.js');

  const handle = new RealMongoHandle({ uri, databaseName: dbName });
  const mongoStore = new MongoStateBackingStore(handle);
  try {
    await mongoStore.init();
  } catch (err) {
    const msg = (err as Error).message;
    console.error(
      `  [storage] FATAL: CDS_STORAGE_MODE=${rawStorageMode} + CDS_MONGO_URI 已配置，`
      + `但 mongo init 失败: ${msg}`,
    );
    console.error(
      `  [storage] 不再自动退回 JSON（用户需求：Mongo 是主存储）。`
      + `紧急回退：编辑 cds/.cds.env 注释掉 CDS_MONGO_URI 或改 CDS_STORAGE_MODE=json，重启。`
      + `或在 Dashboard Settings 里点 "切回 JSON"（需要 Mongo 先恢复）`,
    );
    try { await handle.close(); } catch { /* best effort */ }
    throw err;
  }

  // Mongo init succeeded. If the collection is fresh (load() returned
  // null from the init-time query) AND a state.json exists on disk,
  // import the file snapshot once so existing deployments can
  // opt-in to mongo without losing data. After the seed, mongo owns
  // the canonical state.
  if (mongoStore.load() === null) {
    const jsonStore = new JsonStateBackingStore(stateFile);
    const existing = jsonStore.load();
    if (existing) {
      console.log('  [storage] mongo is empty but state.json exists — seeding mongo from file');
      await mongoStore.seedIfEmpty(existing);
    }
  }

  stateService = new StateService(stateFile, config.repoRoot, mongoStore);
  stateService.load();
  storageModeResolved = 'mongo';
  activeMongoHandle = handle;
  console.log(`  [storage] mongo backend active (uri=${uri.replace(/\/\/[^@]*@/, '//***:***@')}, db=${dbName})`);
}

await initStateService();

// ── Auth store (FU-02) ───────────────────────────────────────────────────────
//
// CDS_AUTH_BACKEND selects the auth persistence backend:
//   'memory'  (default) — in-process Map, lost on restart (P2 behaviour)
//   'mongo'             — MongoDB-backed; requires CDS_MONGO_URI
//
// Auth backend is independent of the state storage backend
// (CDS_STORAGE_MODE). You can mix them freely: e.g. state=json + auth=mongo.
// See doc/guide.cds-env.md §3 and doc/design.cds-fu-02-auth-store-mongo.md.
let activeAuthStore: import('./infra/auth-store/memory-store.js').AuthStore | undefined;

async function initAuthStore(): Promise<void> {
  const authBackend = (process.env.CDS_AUTH_BACKEND || 'memory').toLowerCase();

  if (authBackend === 'mongo') {
    const mongoUri = process.env.CDS_MONGO_URI;
    if (!mongoUri) {
      throw new Error('CDS_AUTH_BACKEND=mongo requires CDS_MONGO_URI to be set');
    }
    const mongoDb = process.env.CDS_AUTH_MONGO_DB || process.env.CDS_MONGO_DB || 'cds_auth_db';

    const { RealAuthMongoHandle } = await import('./infra/auth-store/mongo-handle.js');
    const { MongoAuthStore } = await import('./infra/auth-store/mongo-store.js');

    const handle = new RealAuthMongoHandle({ uri: mongoUri, databaseName: mongoDb, connectTimeoutMs: 5000 });
    await handle.connect();
    activeAuthStore = new MongoAuthStore(handle);
    console.log(`  [auth] backend=mongo (db=${mongoDb})`);
  } else {
    if (authBackend !== 'memory') {
      console.warn(`  [auth] unknown CDS_AUTH_BACKEND '${authBackend}', falling back to memory`);
    }
    // activeAuthStore left undefined — server.ts will create MemoryAuthStore
    console.log('  [auth] backend=memory (default)');
  }
}

await initAuthStore();

// ── Sync deploy modes from compose file into existing profiles ──
{
  const composeFiles = discoverComposeFiles(config.repoRoot);
  for (const file of composeFiles) {
    try {
      const yaml = fs.readFileSync(file, 'utf-8');
      const cds = parseCdsCompose(yaml);
      if (!cds) continue;
      for (const bp of cds.buildProfiles) {
        if (!bp.deployModes || Object.keys(bp.deployModes).length === 0) continue;
        const existing = stateService.getBuildProfile(bp.id);
        if (existing) {
          stateService.updateBuildProfile(bp.id, { deployModes: bp.deployModes });
        }
      }
      stateService.save();
      break; // Only process first matching compose file
    } catch { /* skip */ }
  }
}

// ── Apply custom env overrides to config ──
// Users set these in CDS custom env vars (UI),
// but config.ts only reads process.env at startup. Merge them here.
const customEnv = stateService.getCustomEnv();
if (customEnv.ROOT_DOMAINS && !config.rootDomains?.length) config.rootDomains = parseCsv(customEnv.ROOT_DOMAINS);
if (customEnv.SWITCH_DOMAIN && !config.switchDomain) config.switchDomain = customEnv.SWITCH_DOMAIN;
if (customEnv.MAIN_DOMAIN && !config.mainDomain) config.mainDomain = customEnv.MAIN_DOMAIN;
if (customEnv.DASHBOARD_DOMAIN && !config.dashboardDomain) config.dashboardDomain = customEnv.DASHBOARD_DOMAIN;
if (customEnv.PREVIEW_DOMAIN && !config.previewDomain) config.previewDomain = customEnv.PREVIEW_DOMAIN;
if (config.rootDomains?.length) {
  if (!config.dashboardDomain) config.dashboardDomain = config.rootDomains[0];
  if (!config.previewDomain) config.previewDomain = config.rootDomains[0];
  if (!config.mainDomain) config.mainDomain = config.rootDomains[0];
}
// Directory isolation: allow UI to override repo root and worktree base
if (customEnv.CDS_REPO_ROOT) config.repoRoot = customEnv.CDS_REPO_ROOT;
if (customEnv.CDS_WORKTREE_BASE) config.worktreeBase = customEnv.CDS_WORKTREE_BASE;
// P4 Part 18 (G1.4): reposBase can be set either via CDS_REPOS_BASE
// env at process-start (config.ts) or via customEnv at runtime (UI).
// The runtime override wins so operators can flip on multi-repo clone
// without restarting.
if (customEnv.CDS_REPOS_BASE) config.reposBase = customEnv.CDS_REPOS_BASE;

// ── Services ──
// P4 Part 18 (G1.2): WorktreeService is stateless; every call passes
// the repoRoot explicitly. The bootstrap path and the proxy auto-build
// path pass `config.repoRoot` (legacy single-repo behavior); the
// multi-project deploy path resolves per-project via
// StateService.getProjectRepoRoot().
const worktreeService = new WorktreeService(shell);

// ── FU-04: flat → per-project worktree layout migration ──
//
// One-shot on-boot sweep. Symlinks any surviving `<worktreeBase>/<slug>`
// entries into `<worktreeBase>/default/<slug>` and rewrites matching
// BranchEntry.worktreePath values. Guarded by state.worktreeLayoutVersion
// so subsequent boots skip the scan. See doc/plan.cds-backlog-matrix.md
// §FU-04 for the rationale.
try {
  const migratedCount = WorktreeService.migrateFlatLayoutIfNeeded({
    worktreeBase: config.worktreeBase,
    projectIds: stateService.getProjects().map(p => p.id),
    branches: stateService.getAllBranches().map(b => ({ id: b.id, projectId: b.projectId, worktreePath: b.worktreePath })),
    currentVersion: stateService.getWorktreeLayoutVersion(),
    updateBranchWorktreePath: (branchId, nextPath) => stateService.setBranchWorktreePath(branchId, nextPath),
    markMigrated: (v) => stateService.setWorktreeLayoutVersion(v),
  });
  if (migratedCount > 0) {
    console.log(`  [worktree] FU-04 migration: adopted ${migratedCount} legacy worktree(s) under '${config.worktreeBase}/default/'`);
  }
  stateService.save();
} catch (err) {
  console.warn(`  [worktree] FU-04 migration skipped due to error: ${(err as Error).message}`);
}

const containerService = new ContainerService(shell, config);
const proxyService = new ProxyService(stateService, config);
proxyService.setWorktreeService(worktreeService);
const bridgeService = new BridgeService();

// ── Warm-pool scheduler (v3.1) ──
// Disabled unless cds.config.json { "scheduler": { "enabled": true, ... } }.
// See doc/design.cds-resilience.md and doc/plan.cds-resilience-rollout.md.
//
// Runtime override: the Dashboard can toggle the scheduler via
// PUT /api/scheduler/enabled, which writes to state.json. That value wins
// over the config-file setting so operators can flip the scheduler without
// shelling into the box. `undefined` means "no override, use config".
{
  const uiOverride = stateService.getSchedulerEnabledOverride();
  if (uiOverride !== undefined && config.scheduler) {
    config.scheduler.enabled = uiOverride;
    console.log(`  [scheduler] applying UI override: enabled=${uiOverride}`);
  }
}
const schedulerService = new SchedulerService(
  stateService,
  config.scheduler || {
    enabled: false,
    maxHotBranches: 3,
    idleTTLSeconds: 900,
    tickIntervalSeconds: 60,
    pinnedBranches: [],
  },
);
// coolFn: stop all containers of a branch but keep the branch entry in state.
// The next request to this branch will trigger the existing auto-build path,
// which re-runs docker run and brings the services back to HOT.
schedulerService.setCoolFn(async (slug: string) => {
  const branch = stateService.getBranch(slug);
  if (!branch) return;
  branch.status = 'stopping';
  stateService.save();
  for (const svc of Object.values(branch.services)) {
    if (svc.status === 'running' || svc.status === 'starting') {
      try {
        await containerService.stop(svc.containerName);
      } catch (err) {
        console.warn(`[scheduler] stop(${svc.containerName}) failed: ${(err as Error).message}`);
      }
      svc.status = 'stopped';
    }
  }
  branch.status = 'idle';
  stateService.save();
});
// wakeFn intentionally left unset at boot: the proxy's existing onAutoBuild
// handler already covers the "branch is not running" case and runs the full
// SSE build flow. A dedicated wakeFn would duplicate that logic. Future
// work (Phase 2) may introduce a lighter-weight restart path.
proxyService.setScheduler(schedulerService);

// ── Janitor (Phase 2 resilience) ──
// Disabled by default. Opt-in via cds.config.json { "janitor": { "enabled": true, ... } }.
// Sweeps stale worktrees (> worktreeTTLDays idle) and warns on disk usage.
// See doc/design.cds-resilience.md Phase 2.
const janitorService = new JanitorService(
  stateService,
  config.janitor || {
    enabled: false,
    worktreeTTLDays: 30,
    diskWarnPercent: 80,
    sweepIntervalSeconds: 3600,
  },
  config.worktreeBase,
);
janitorService.setRemoveFn(async (slug: string) => {
  // Reuse the existing removal path: stop containers → git worktree remove → drop state.
  const branch = stateService.getBranch(slug);
  if (!branch) return;
  for (const svc of Object.values(branch.services)) {
    try { await containerService.stop(svc.containerName); } catch { /* best effort */ }
  }
  try {
    const repoRoot = stateService.getProjectRepoRoot(branch.projectId, config.repoRoot);
    await worktreeService.remove(repoRoot, branch.worktreePath);
  } catch { /* best effort */ }
  stateService.removeBranch(slug);
  stateService.save();
});

// The BranchDispatcher (Phase 3) is instantiated later, inside the scheduler-mode
// block where ExecutorRegistry becomes available. See the `if (mode === 'scheduler')`
// branch near the bottom of this file.

// ── Discover and reconcile infrastructure containers ──
(async () => {
  try {
    const discovered = await containerService.discoverInfraContainers();
    const stateServices = stateService.getInfraServices();

    for (const svc of stateServices) {
      const found = discovered.get(svc.id);
      if (found) {
        // Container exists in Docker — sync status
        svc.status = found.running ? 'running' : 'stopped';
        discovered.delete(svc.id);
      } else if (svc.status === 'running') {
        // State says running but container is gone — try to recreate
        console.log(`  [infra] Recreating missing container for ${svc.id}...`);
        try {
          await containerService.startInfraService(svc);
          svc.status = 'running';
          console.log(`  [infra] ${svc.id} recreated successfully`);
        } catch (err) {
          svc.status = 'error';
          svc.errorMessage = (err as Error).message;
          console.error(`  [infra] Failed to recreate ${svc.id}:`, (err as Error).message);
        }
      }
    }

    // Log orphan containers (in Docker but not in state)
    for (const [id, info] of discovered) {
      console.warn(`  [infra] Orphan container detected: ${info.containerName} (service.id=${id}). Not managed by current state.`);
    }

    stateService.save();
    if (stateServices.length > 0) {
      const running = stateServices.filter(s => s.status === 'running').length;
      console.log(`  [infra] ${stateServices.length} service(s) configured, ${running} running`);
    }

    // ── Discover and reconcile app containers ──
    const appContainers = await containerService.discoverAppContainers();
    const branches = stateService.getAllBranches();
    let appReconciled = 0;

    for (const branch of branches) {
      for (const [profileId, svc] of Object.entries(branch.services)) {
        const key = `${branch.id}/${profileId}`;
        const found = appContainers.get(key);
        if (found) {
          // Container exists in Docker — sync status
          const wasStatus = svc.status;
          svc.status = found.running ? 'running' : 'error';
          if (wasStatus !== svc.status) appReconciled++;
          appContainers.delete(key);
        } else if (svc.status === 'running') {
          // State says running but container is gone
          svc.status = 'error';
          svc.errorMessage = '容器已丢失，需重新部署';
          appReconciled++;
        }
      }
    }

    // Log orphan app containers
    for (const [key, info] of appContainers) {
      console.warn(`  [app] Orphan container detected: ${info.containerName} (${key}). Not managed by current state.`);
    }

    if (appReconciled > 0) {
      console.log(`  [app] Reconciled ${appReconciled} app container(s)`);
      stateService.save();
    }
  } catch (err) {
    console.error('  [infra] Discovery failed:', (err as Error).message);
  }

  // Start warm-pool scheduler after reconciliation so initial heat states
  // reflect real container state. No-op when scheduler is disabled.
  // On startup, branches with status='running' and no heatState get marked hot.
  if (schedulerService.isEnabled()) {
    for (const b of stateService.getAllBranches()) {
      if (b.heatState === undefined && b.status === 'running') {
        b.heatState = 'hot';
      }
    }
    stateService.save();
    schedulerService.start();
  }

  // Start janitor (Phase 2) — safe to call even when disabled (internal no-op).
  janitorService.start();
})();

// Shut the scheduler/janitor down cleanly on process exit so background timers
// don't keep running orphaned.
// P4 Part 18 (D.2): graceful shutdown — flush the mongo write-behind
// chain before exit so the last few state mutations don't get lost
// sitting in the flush queue. Best-effort with a 3-second ceiling to
// avoid hanging the process if mongo is already unreachable.
async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] received ${signal}, stopping services...`);
  schedulerService.stop();
  janitorService.stop();
  if (activeMongoHandle) {
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('shutdown flush timeout')), 3000),
      );
      await Promise.race([
        (async () => {
          const store = stateService.getBackingStore();
          if (store.kind === 'mongo' && 'flush' in store && typeof (store as any).flush === 'function') {
            await (store as any).flush();
          }
          await activeMongoHandle!.close();
        })(),
        timeout,
      ]);
      console.log('[shutdown] mongo flushed + closed');
    } catch (err) {
      console.warn(`[shutdown] mongo teardown failed: ${(err as Error).message}`);
    }
  }
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

// Configure proxy: resolve branch slug → upstream URL
proxyService.setResolveUpstream((branchId, profileId) => {
  const branch = stateService.getBranch(branchId);
  if (!branch) return null;

  if (profileId && branch.services[profileId]) {
    const svc = branch.services[profileId];
    if (svc.status === 'running') return `http://127.0.0.1:${svc.hostPort}`;
  }

  // Fallback: find first running service
  for (const svc of Object.values(branch.services)) {
    if (svc.status === 'running') return `http://127.0.0.1:${svc.hostPort}`;
  }
  return null;
});

// ── Web access tracking (throttled: max 1 event per branch per 2s) ──
const webAccessThrottle = new Map<string, number>();
proxyService.setOnAccess((branchId, method, reqPath, status, duration, profileId) => {
  const now = Date.now();
  const lastSent = webAccessThrottle.get(branchId) || 0;
  if (now - lastSent < 2000) return; // throttle: 1 event per 2 seconds per branch
  webAccessThrottle.set(branchId, now);

  const branchTags = stateService.getBranch(branchId)?.tags ?? [];
  const event: ActivityEvent = {
    id: nextActivitySeq(),
    ts: new Date().toISOString(),
    method,
    path: reqPath,
    status,
    duration,
    type: 'web',
    source: 'user',
    branchId,
    branchTags: branchTags.length ? branchTags : undefined,
    profileId,
  };
  broadcastActivity(event);
});

// ── Build lock for race conditions ──
// Concurrent requests for the same branch wait for the first build to finish.
const buildLocks = new Map<string, { promise: Promise<void>; listeners: http.ServerResponse[] }>();

// ── "Branch is gone" friendly page ──
/**
 * Rendered when a preview subdomain resolves to a branch that neither exists
 * locally nor in the remote git repo. Replaces the old SSE-error-inside-
 * transit-page experience (which landed on Chrome's raw 400 for most users)
 * with a proper HTML page that:
 *   - Explains the branch is deleted / never deployed
 *   - Lists live preview branches the user can jump to
 *   - Auto-redirects to the dashboard so the tab doesn't sit blank forever
 * See .claude/rules/cds-auto-deploy.md (no-blank-wait principle).
 */
function buildBranchGonePageHtml(slug: string, opts: { dashboardUrl?: string; mainDomain?: string; liveBranches?: Array<{ slug: string; url: string | null }> }): string {
  const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
  const live = (opts.liveBranches || []).slice(0, 8);
  const liveHtml = live.length > 0
    ? `<div class="section-title">当前可用预览（${live.length}）</div><div class="live-list">${live.map(b => {
        const safe = escape(b.slug);
        return b.url
          ? `<a class="live-item" href="${escape(b.url)}">${safe}</a>`
          : `<div class="live-item disabled">${safe}</div>`;
      }).join('')}</div>`
    : '';
  const dashHtml = opts.dashboardUrl
    ? `<a class="btn primary" href="${escape(opts.dashboardUrl)}">返回 CDS 控制台</a>`
    : '';
  const redirectScript = opts.dashboardUrl
    ? `<script>setTimeout(function(){location.href=${JSON.stringify(opts.dashboardUrl)}},15000)</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>预览已下线 — ${escape(slug)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{max-width:520px;width:100%;padding:32px;background:#161b22;border:1px solid #30363d;border-radius:12px;text-align:center}
.emoji{font-size:40px;margin-bottom:12px}
h2{font-size:18px;font-weight:600;color:#f0f6fc;margin-bottom:8px}
.branch{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;color:#f85149;background:#2a0d11;border:1px solid #5a1d1d;padding:4px 10px;border-radius:4px;margin-bottom:16px;display:inline-block;word-break:break-all}
.desc{font-size:13px;color:#8b949e;line-height:1.6;margin-bottom:20px}
.section-title{font-size:12px;color:#8b949e;text-align:left;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}
.live-list{display:flex;flex-direction:column;gap:4px;margin-bottom:20px;text-align:left}
.live-item{display:block;padding:8px 12px;background:#0d1117;border:1px solid #21262d;border-radius:6px;color:#58a6ff;font-size:13px;font-family:ui-monospace,monospace;text-decoration:none;transition:border-color .15s}
.live-item:hover{border-color:#58a6ff}
.live-item.disabled{color:#6e7681;cursor:not-allowed}
.btn{display:inline-block;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;border:1px solid #30363d;color:#c9d1d9;background:#21262d;transition:background .15s}
.btn:hover{background:#30363d}
.btn.primary{background:#238636;border-color:#238636;color:#fff}
.btn.primary:hover{background:#2ea043}
.hint{font-size:11px;color:#6e7681;margin-top:16px}
</style>
</head><body>
<div class="card">
  <div class="emoji">🪦</div>
  <h2>预览已下线</h2>
  <div class="branch">${escape(slug)}</div>
  <div class="desc">
    该分支已被删除，或从未在 CDS 上部署过。<br>
    如果分支仍在开发，请先运行部署流水线再来访问。
  </div>
  ${liveHtml}
  ${dashHtml}
  ${opts.dashboardUrl ? '<div class="hint">15 秒后自动返回控制台</div>' : ''}
</div>
${redirectScript}
</body></html>`;
}

// ── Auto-build transit page HTML ──
//
// 这是用户访问"未构建"分支子域名时看到的全屏过渡页 —— 没有引入 dashboard
// 的 style.css，所以 CSS token 必须在页面里 inline 双写
// (`:root` 暗黑默认 + `prefers-color-scheme: light` 翻成浅色)，与
// `.claude/rules/cds-theme-tokens.md` 的双主题原则保持一致。
//
// 完成态采用「按钮 + 兜底提示」而不是倒计时自动刷新：
// 后台 SSE complete 事件代表"我们认为容器跑起来了"，但 TCP 探活通过
// 不等于上游 HTTP 真的在响应（自动 reload 撞上窗口期就是 Chrome
// HTTP ERROR 400）。把决定权交回用户：默认显示「前往预览」按钮 + 小字
// "如果显示 HTTP 400 / 503 请等几秒再点"——主流程一点就到，过渡窗口里
// 也不会被强制刷新坑到。
function buildTransitPageHtml(branchName: string): string {
  // 分支名嵌进 HTML 前先转义，避免特殊字符破坏页面或脚本注入。
  const safeBranch = branchName.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
  return `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>正在准备预览 — ${safeBranch}</title>
<style>
:root{
  --bg-page:#0d1117;
  --bg-card:#161b22;
  --bg-elevated:#21262d;
  --bg-base:#0d1117;
  --bg-terminal:#010409;
  --border:#30363d;
  --border-subtle:#21262d;
  --text-primary:#f0f6fc;
  --text-secondary:#c9d1d9;
  --text-muted:#8b949e;
  --text-subtle:#6e7681;
  --accent:#58a6ff;
  --accent-bg:rgba(88,166,255,.14);
  --success:#3fb950;
  --success-bg:rgba(63,185,80,.14);
  --danger:#f85149;
  --danger-bg:rgba(248,81,73,.12);
  --shadow-card:0 12px 32px rgba(0,0,0,.45);
}
@media (prefers-color-scheme: light){
  :root{
    --bg-page:#f4efe9;
    --bg-card:#ffffff;
    --bg-elevated:#f1eae4;
    --bg-base:#efe7df;
    --bg-terminal:#efe7df;
    --border:#d8cfc6;
    --border-subtle:#e6ddd3;
    --text-primary:#2a1f19;
    --text-secondary:#3f3128;
    --text-muted:#7a6a5e;
    --text-subtle:#9c8e82;
    --accent:#1f6feb;
    --accent-bg:rgba(31,111,235,.10);
    --success:#1a7f37;
    --success-bg:rgba(26,127,55,.10);
    --danger:#cf222e;
    --danger-bg:rgba(207,34,46,.08);
    --shadow-card:0 8px 24px rgba(43,33,28,.10);
  }
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg-page);color:var(--text-secondary);display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{max-width:560px;width:100%;padding:28px 30px;background:var(--bg-card);border:1px solid var(--border);border-radius:14px;box-shadow:var(--shadow-card)}
.header{display:flex;align-items:center;gap:12px;margin-bottom:6px}
.spinner{width:22px;height:22px;border:2.5px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.done-icon{width:22px;height:22px;display:none;color:var(--success);flex-shrink:0}
.error-icon{width:22px;height:22px;display:none;color:var(--danger);flex-shrink:0}
h1{font-size:18px;font-weight:600;color:var(--text-primary);letter-spacing:.2px}
.subtitle{font-size:12px;color:var(--text-muted);margin-bottom:18px;padding-left:34px;line-height:1.55}
.branch-chip{display:inline-flex;align-items:center;gap:6px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;color:var(--accent);background:var(--accent-bg);padding:5px 10px;border-radius:99px;margin-bottom:18px;word-break:break-all;border:1px solid var(--border-subtle)}
.branch-chip::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 3px var(--accent-bg);flex-shrink:0}
/* 时间轴：左侧圆点 + 连接线，比"每步一张白卡"更紧凑 */
.timeline{position:relative;padding-left:22px;margin-bottom:14px}
.timeline::before{content:"";position:absolute;left:9px;top:6px;bottom:6px;width:2px;background:var(--border-subtle)}
.step{position:relative;padding:6px 0 6px 14px;font-size:13px;color:var(--text-secondary);min-height:26px;line-height:1.5}
.step::before{content:"";position:absolute;left:-19px;top:9px;width:12px;height:12px;border-radius:50%;background:var(--bg-card);border:2px solid var(--border)}
.step.running::before{border-color:var(--accent);background:var(--bg-card);animation:pulse 1.4s ease-in-out infinite}
.step.done::before{border-color:var(--success);background:var(--success)}
.step.error::before{border-color:var(--danger);background:var(--danger)}
.step.done::after,.step.error::after{position:absolute;left:-15.5px;top:7px;font-size:9px;color:var(--bg-card);font-weight:700;line-height:1}
.step.done::after{content:"✓"}
.step.error::after{content:"✕"}
.step-title{font-weight:500}
.step.done .step-title,.step.error .step-title{color:var(--text-secondary)}
.step.running .step-title{color:var(--text-primary)}
@keyframes pulse{0%,100%{box-shadow:0 0 0 4px var(--accent-bg)}50%{box-shadow:0 0 0 7px var(--accent-bg)}}
/* 日志折叠：默认收起，避免一屏白噪声 */
.log-toggle{display:none;font-size:11px;color:var(--text-muted);cursor:pointer;padding:4px 0;user-select:none}
.log-toggle:hover{color:var(--text-secondary)}
.log-toggle.visible{display:inline-block}
.log-toggle::before{content:"▸ ";display:inline-block;transition:transform .15s}
.log-toggle.open::before{transform:rotate(90deg)}
.log-box{max-height:0;overflow:hidden;min-height:0;background:var(--bg-terminal);border:1px solid var(--border-subtle);border-radius:8px;font-family:ui-monospace,monospace;font-size:11px;line-height:1.55;color:var(--text-muted);white-space:pre-wrap;word-break:break-all;transition:max-height .25s ease,padding .25s ease;padding:0 12px;margin-top:6px}
.log-box.open{max-height:240px;overflow-y:auto;padding:10px 12px}
.log-box::-webkit-scrollbar{width:4px}
.log-box::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
/* 完成 / 失败状态 */
.actions{display:none;margin-top:18px;flex-direction:column;gap:8px}
.actions.visible{display:flex}
.btn-primary{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 18px;background:var(--accent);color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none;transition:filter .15s,transform .05s}
.btn-primary:hover{filter:brightness(1.08)}
.btn-primary:active{transform:scale(.98)}
.hint{font-size:12px;color:var(--text-muted);text-align:center;line-height:1.55}
.hint code{font-family:ui-monospace,monospace;background:var(--bg-elevated);color:var(--text-secondary);padding:1px 6px;border-radius:4px;font-size:11px}
.error-msg{font-size:13px;color:var(--danger);background:var(--danger-bg);border:1px solid var(--danger);border-radius:8px;padding:10px 12px;margin-top:14px;display:none;font-family:ui-monospace,monospace;line-height:1.55;word-break:break-all}
.error-msg.visible{display:block}
</style>
</head><body>
<div class="card">
  <div class="header">
    <div class="spinner" id="hdrSpinner"></div>
    <svg class="done-icon" id="hdrDone" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0a8 8 0 110 16A8 8 0 018 0zm3.78 4.97a.75.75 0 00-1.06 0L7 8.69 5.28 6.97a.75.75 0 00-1.06 1.06l2.25 2.25a.75.75 0 001.06 0l4.25-4.25a.75.75 0 000-1.06z"/></svg>
    <svg class="error-icon" id="hdrErr" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M2.343 13.657A8 8 0 1113.657 2.343 8 8 0 012.343 13.657zM6.03 4.97a.75.75 0 00-1.06 1.06L6.94 8 4.97 9.97a.75.75 0 101.06 1.06L8 9.06l1.97 1.97a.75.75 0 101.06-1.06L9.06 8l1.97-1.97a.75.75 0 10-1.06-1.06L8 6.94 6.03 4.97z"/></svg>
    <h1 id="hdrTitle">正在准备预览环境</h1>
  </div>
  <div class="subtitle" id="hdrSub">CDS 正在拉起容器、跑构建、等待端口就绪</div>
  <div class="branch-chip">${safeBranch}</div>
  <div class="timeline" id="steps"></div>
  <span class="log-toggle" id="logToggle">查看构建日志</span>
  <div class="log-box" id="logBox"></div>
  <div class="error-msg" id="errMsg"></div>
  <div class="actions" id="actions">
    <a class="btn-primary" id="goBtn" href="#">前往预览 →</a>
    <div class="hint" id="hintTxt">如显示 <code>HTTP 400</code> 或 <code>503</code>，请等 <strong>3-5 秒</strong>再点 ——上游服务正在接管端口。</div>
  </div>
</div>
<script>
(function(){
  var steps=document.getElementById('steps');
  var logBox=document.getElementById('logBox');
  var logToggle=document.getElementById('logToggle');
  var hdrSpinner=document.getElementById('hdrSpinner');
  var hdrDone=document.getElementById('hdrDone');
  var hdrErr=document.getElementById('hdrErr');
  var hdrTitle=document.getElementById('hdrTitle');
  var hdrSub=document.getElementById('hdrSub');
  var actions=document.getElementById('actions');
  var goBtn=document.getElementById('goBtn');
  var hintTxt=document.getElementById('hintTxt');
  var errMsg=document.getElementById('errMsg');
  var stepMap={};

  // 把"前往预览"指向页面原本的 path（不带 ?sse=1，那只是 SSE 通道用的）
  function goHref(){
    var loc=location;
    var q=loc.search.replace(/[?&]sse=1\\b/,'').replace(/^&/,'?');
    return loc.pathname+q+loc.hash;
  }

  logToggle.addEventListener('click',function(){
    var open=logBox.classList.toggle('open');
    logToggle.classList.toggle('open',open);
    logToggle.textContent=open?'收起构建日志':'查看构建日志';
    if(open) logBox.scrollTop=logBox.scrollHeight;
  });

  function addOrUpdateStep(id,status,title){
    var el=stepMap[id];
    if(!el){
      el=document.createElement('div');
      el.className='step '+status;
      el.innerHTML='<span class="step-title"></span>';
      steps.appendChild(el);
      stepMap[id]=el;
    }
    el.className='step '+status;
    el.querySelector('.step-title').textContent=title;
  }

  function appendLog(text){
    logToggle.classList.add('visible');
    logBox.textContent+=text;
    if(logBox.classList.contains('open')) logBox.scrollTop=logBox.scrollHeight;
  }

  function finish(ok,msg){
    hdrSpinner.style.display='none';
    if(ok){
      hdrDone.style.display='block';
      hdrTitle.textContent='预览环境已就绪';
      hdrSub.textContent=msg||'容器都跑起来了，可以打开预览了';
      goBtn.href=goHref();
      actions.classList.add('visible');
    }else{
      hdrErr.style.display='block';
      hdrTitle.textContent='构建失败';
      hdrSub.textContent='查看下方日志或回到 CDS 控制台排查';
      errMsg.textContent=msg||'构建过程中发生错误';
      errMsg.classList.add('visible');
      // 失败态把按钮改成"重试"，hint 切成失败用语
      goBtn.textContent='重新尝试';
      goBtn.href=goHref();
      hintTxt.innerHTML='如错误反复出现，请回到 <code>CDS 控制台</code> 查看分支构建日志';
      actions.classList.add('visible');
    }
  }

  var url=location.href+(location.href.indexOf('?')>=0?'&':'?')+'sse=1';
  var es=new EventSource(url);
  es.addEventListener('step',function(e){
    var d=JSON.parse(e.data);
    addOrUpdateStep(d.step,d.status,d.title);
  });
  es.addEventListener('log',function(e){
    var d=JSON.parse(e.data);
    appendLog(d.chunk);
  });
  es.addEventListener('complete',function(e){
    es.close();
    var d={};
    try{d=JSON.parse(e.data);}catch(ex){}
    finish(true,d.message);
  });
  es.addEventListener('error',function(e){
    if(e.data){
      try{var d=JSON.parse(e.data);finish(false,d.message);}catch(ex){finish(false,'连接中断');}
    }else{
      finish(false,'连接中断，请稍后重试');
    }
    es.close();
  });
})();
</script>
</body></html>`;
}

// Helper: collect currently-running preview branches + build their public
// URLs so the "branch gone" page can offer live alternatives to jump to.
function liveBranchesForGonePage(host: string): Array<{ slug: string; url: string | null }> {
  const state = stateService.getState();
  // Derive the preview host ("foo.miduo.org" → "miduo.org") so links work
  // under any configured root domain without hardcoding.
  const rootDomains = config.rootDomains || (config.previewDomain ? [config.previewDomain] : []);
  const hostLower = host.split(':')[0].toLowerCase();
  let previewHost: string | null = null;
  for (const rd of rootDomains) {
    const s = `.${rd.toLowerCase()}`;
    if (hostLower.endsWith(s)) { previewHost = rd.toLowerCase(); break; }
  }
  // 走 buildPreviewUrl 全栈唯一入口，列出来的链接和 PR 评论 / settings preview
  // 输出格式一致（v3 = tail-prefix-projectSlug）。
  const out: Array<{ slug: string; url: string | null }> = [];
  for (const [slug, b] of Object.entries(state.branches)) {
    if (b.status !== 'running' && b.status !== 'starting') continue;
    let url: string | null = null;
    if (previewHost && b.branch) {
      const project = b.projectId ? stateService.getProject(b.projectId) : undefined;
      const projectSlug = project?.slug || b.projectId;
      if (projectSlug) {
        const built = buildPreviewUrl(previewHost, b.branch, projectSlug);
        if (built) url = built;
      }
    }
    out.push({ slug, url });
  }
  // Newest (most recently accessed) first — best signals what's active today.
  out.sort((a, b) => {
    const ba = state.branches[a.slug]?.lastAccessedAt || '';
    const bb = state.branches[b.slug]?.lastAccessedAt || '';
    return bb.localeCompare(ba);
  });
  return out;
}

// Serve the friendly "branch is gone" page. Returns HTTP 404 + HTML so
// browsers render the body, search engines don't index, and Cloudflare
// won't treat it as a long-lived 200 to cache.
function serveBranchGonePage(slug: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const host = req.headers.host || '';
  const dashboardDomain = config.dashboardDomain || config.mainDomain || null;
  const dashboardUrl = dashboardDomain ? `https://${dashboardDomain}` : undefined;
  const live = liveBranchesForGonePage(host);
  const html = buildBranchGonePageHtml(slug, { dashboardUrl, mainDomain: config.mainDomain, liveBranches: live });
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(html);
}

// Auto-build: when a request hits an unbuilt branch
proxyService.setOnAutoBuild(async (branchSlug, _req, res) => {
  const url = new URL(_req.url || '/', `http://${_req.headers.host || 'localhost'}`);
  const isSSE = url.searchParams.get('sse') === '1';

  // Browser request (no ?sse=1): decide up-front between the transit page
  // (branch exists → build will kick off) and the friendly "gone" page
  // (branch nowhere to be found — deleted, typo, never deployed). Doing the
  // remote existence check here avoids the old UX where the user waited
  // through a spinner just to see "远程仓库中未找到分支" — or worse, landed
  // on a raw Chrome 400 when the SSE connection was never established.
  if (!isSSE) {
    // Skip remote check when the branch already exists locally (deploy in
    // progress, or just-created with status=running) — the transit page
    // will handle it via the SSE path.
    const localBranch = stateService.getBranch(branchSlug);
    if (!localBranch) {
      const autoRepoRoot = config.repoRoot;
      let foundRemote = false;
      try {
        foundRemote = await worktreeService.branchExists(autoRepoRoot, branchSlug)
          || !!(await worktreeService.findBranchBySuffix(autoRepoRoot, branchSlug))
          || !!(await worktreeService.findBranchBySlug(autoRepoRoot, branchSlug));
      } catch {
        foundRemote = false;
      }
      if (!foundRemote) {
        serveBranchGonePage(branchSlug, _req, res);
        return;
      }
    }
    const displayName = branchSlug;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buildTransitPageHtml(displayName));
    return;
  }

  // ── SSE mode: stream build events ──
  const branch = stateService.getBranch(branchSlug);

  // Race condition: if a build is already in progress for this slug,
  // add this response as a listener and wait for the first build to finish
  const existingLock = buildLocks.get(branchSlug);
  if (existingLock || branch?.status === 'building') {
    if (existingLock) {
      // Subscribe this response to receive SSE events from the ongoing build
      existingLock.listeners.push(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      try { res.write(`event: step\ndata: ${JSON.stringify({ step: 'wait', status: 'running', title: `分支 "${branchSlug}" 正在构建中，等待完成...` })}\n\n`); } catch { /* */ }
      // The build promise will resolve/reject and the finally block will end this response
      existingLock.promise.then(() => {
        try {
          res.write(`event: complete\ndata: ${JSON.stringify({ message: `分支 "${branchSlug}" 已就绪` })}\n\n`);
        } catch { /* */ }
        res.end();
      }).catch((err) => {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
        } catch { /* */ }
        res.end();
      });
      return;
    }

    // Building but no lock (stale state) — send SSE error so transit page shows status
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: step\ndata: ${JSON.stringify({ step: 'wait', status: 'running', title: `分支 "${branchSlug}" 正在构建中...` })}\n\n`);
    // Poll until building finishes
    const poll = setInterval(() => {
      const b = stateService.getBranch(branchSlug);
      if (!b || b.status !== 'building') {
        clearInterval(poll);
        if (b?.status === 'running') {
          try { res.write(`event: complete\ndata: ${JSON.stringify({ message: `分支 "${branchSlug}" 已就绪` })}\n\n`); } catch { /* */ }
        } else {
          try { res.write(`event: error\ndata: ${JSON.stringify({ message: b?.errorMessage || '构建状态异常' })}\n\n`); } catch { /* */ }
        }
        res.end();
      }
    }, 2000);
    return;
  }

  // P4 Part 18 (G1.2): auto-build path stays on the legacy single
  // repo root. Subdomain-triggered auto-build predates multi-project;
  // new projects must be created explicitly via POST /projects + clone.
  const autoRepoRoot = config.repoRoot;

  // Check if remote branch exists
  const exists = await worktreeService.branchExists(autoRepoRoot, branchSlug);
  // Also try suffix matching and common patterns
  const candidates = [branchSlug, `feature/${branchSlug}`, `fix/${branchSlug}`];
  let resolvedBranch: string | null = null;

  if (exists) {
    resolvedBranch = branchSlug;
  } else {
    for (const candidate of candidates) {
      if (await worktreeService.branchExists(autoRepoRoot, candidate)) {
        resolvedBranch = candidate;
        break;
      }
    }
  }

  // If still not found, try suffix matching against all remote branches
  if (!resolvedBranch) {
    resolvedBranch = await worktreeService.findBranchBySuffix(autoRepoRoot, branchSlug);
  }

  // If still not found, try slug matching (e.g. slug "claude-fix-xxx" → branch "claude/fix-xxx")
  if (!resolvedBranch) {
    resolvedBranch = await worktreeService.findBranchBySlug(autoRepoRoot, branchSlug);
  }

  if (!resolvedBranch) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: error\ndata: ${JSON.stringify({ message: `远程仓库中未找到分支 "${branchSlug}"` })}\n\n`);
    res.end();
    return;
  }

  // Recompute slug from the actual resolved branch name
  const finalSlug = StateService.slugify(resolvedBranch);

  // SSE: stream build progress
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const listeners: http.ServerResponse[] = [];

  const sendEvent = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    try { res.write(msg); } catch { /* */ }
    // Also broadcast to waiting listeners
    for (const listener of listeners) {
      try { listener.write(msg); } catch { /* */ }
    }
  };

  // Register build lock(s). Track every key we register so the finally
  // block can clean them all up — the set can grow inside the try
  // block when an existing entry resolved via findBranchByProjectAndName
  // is stored under a canonical id different from finalSlug/branchSlug.
  // PR #498 review (2026-04-26): without this tracking, the entry.id
  // lock at line 1064 leaks indefinitely.
  const lockKeys = new Set<string>([finalSlug]);
  let resolveLock: () => void;
  let rejectLock: (err: Error) => void;
  const lockPromise = new Promise<void>((resolve, reject) => {
    resolveLock = resolve;
    rejectLock = reject;
  });
  buildLocks.set(finalSlug, { promise: lockPromise, listeners });
  if (finalSlug !== branchSlug) {
    buildLocks.set(branchSlug, { promise: lockPromise, listeners });
    lockKeys.add(branchSlug);
  }

  // Track the actual id under which the branch entry lives so the
  // catch block can flip status='error' on deploy failure. For
  // non-legacy projects this is `${slug}-${finalSlug}`, NOT finalSlug —
  // looking up by finalSlug there returns undefined and the entry
  // stays stuck in 'building' forever (PR #498 review fix).
  let resolvedEntryId: string | null = null;

  try {
    // FU-04 follow-up (2026-04-24): resolve the real project that owns
    // `autoRepoRoot` before creating any entry. The original code hard-
    // coded projectId='default', which broke after the legacy-cleanup
    // rename flow: once 'default' → 'prd-agent', new subdomain hits
    // would mint an orphan branch pointing at a project id that no
    // longer exists ("加载项目失败 HTTP 404" + permanent "检测到遗留
    // default" banner). Resolution is centralised in StateService to
    // keep this decision testable.
    const ownerProject = stateService.resolveProjectForAutoBuild(autoRepoRoot);
    if (!ownerProject) {
      // PR #498 second-round review (Bugbot): the early return originally
      // dropped through finally without ever settling lockPromise. Any
      // concurrent SSE listener that subscribed via the dedup branch at
      // line 917 would hang forever waiting on `existingLock.promise`.
      // Reject so those listeners' `.catch` writes an SSE error and
      // closes their response cleanly. The throw also unifies the error
      // accounting with the rest of the try block — the catch below
      // will sendEvent('error') and the finally tears down the locks.
      throw new Error(
        `无法为分支 "${resolvedBranch}" 定位所属项目（存在多个项目且都设置了 repoPath）。请在 Dashboard 里显式创建分支。`,
      );
    }

    // Align the id formula + lookup with branches.ts / webhook dispatcher.
    const slugPrefix = ownerProject.legacyFlag ? '' : `${ownerProject.slug}-`;
    const canonicalId = `${slugPrefix}${finalSlug}`;
    let entry =
      stateService.getBranch(canonicalId) ??
      stateService.findBranchByProjectAndName(ownerProject.id, resolvedBranch);
    // Lock the entry id (existing) or canonicalId (about-to-be-created)
    // so the catch path can mark the right entry as 'error' and the
    // finally path tears every lock down.
    resolvedEntryId = entry?.id ?? canonicalId;
    if (entry && !buildLocks.has(entry.id)) {
      // Re-register the build lock under the entry's canonical id so
      // concurrent hits using either slug share the same lock.
      buildLocks.set(entry.id, { promise: lockPromise, listeners });
      lockKeys.add(entry.id);
    }
    if (!buildLocks.has(canonicalId)) {
      // Same for the to-be-created path: register early so the catch
      // path can locate the entry by canonicalId and so a stop/redeploy
      // racing the worktree create sees the lock.
      buildLocks.set(canonicalId, { promise: lockPromise, listeners });
      lockKeys.add(canonicalId);
    }
    if (!entry) {
      sendEvent('step', { step: 'worktree', status: 'running', title: `正在为 ${resolvedBranch} 创建工作树...` });
      await shell.exec(`mkdir -p "${config.worktreeBase}/${ownerProject.id}"`);
      const worktreePath = WorktreeService.worktreePathFor(config.worktreeBase, ownerProject.id, canonicalId);
      await worktreeService.create(autoRepoRoot, resolvedBranch, worktreePath);

      entry = {
        id: canonicalId,
        projectId: ownerProject.id,
        branch: resolvedBranch,
        worktreePath,
        services: {},
        status: 'building',
        createdAt: new Date().toISOString(),
      };
      stateService.addBranch(entry);
      stateService.save();
      sendEvent('step', { step: 'worktree', status: 'done', title: '工作树已创建' });
    }

    entry.status = 'building';
    stateService.save();

    // Build only this branch's project's profiles. Earlier this used
    // the global `getBuildProfiles()`, which meant a subdomain-preview
    // request for a default-project branch would iterate EVERY project's
    // profiles (creating cross-project service entries + running the
    // wrong containers). Confirmed root cause of the "构建配置 X 缺少
    // command 字段" error when a fork project had a half-specified
    // profile. See `isolation-bug` note in changelogs/.
    const profiles = stateService.getBuildProfilesForProject(entry.projectId || 'default');
    for (const profile of profiles) {
      sendEvent('step', { step: `build-${profile.id}`, status: 'running', title: `正在构建 ${profile.name}...` });

      if (!entry.services[profile.id]) {
        const hostPort = stateService.allocatePort(config.portStart);
        entry.services[profile.id] = {
          profileId: profile.id,
          containerName: `cds-${entry.id}-${profile.id}`,
          hostPort,
          status: 'building',
        };
        stateService.save();
      }

      const svc = entry.services[profile.id];
      svc.status = 'building';

      // Merge CDS_* auto-generated vars (CDS_HOST, CDS_*_PORT) with user
      // custom env. Scoped by the deploying branch's project so a
      // JWT_SECRET in project A never leaks into project B.
      const cdsEnv = stateService.getCdsEnvVars();
      const customEnv = stateService.getCustomEnv(entry.projectId || 'default');
      const mergedEnv = { ...cdsEnv, ...customEnv };
      await containerService.runService(entry, profile, svc, (chunk) => {
        sendEvent('log', { profileId: profile.id, chunk });
      }, mergedEnv);

      // Gate 'running' on readiness probe — container alive isn't enough.
      // See .claude/rules/cds-auto-deploy.md. Auto-build path does not block
      // on HTTP probes (users tapping a cold subdomain want the loading page,
      // not a long SSE stream) but TCP readiness is cheap and closes the
      // window where the host port is bound but not yet accepting.
      svc.status = 'starting';
      stateService.save();
      const ready = await containerService.waitForReadiness(
        svc.hostPort,
        profile.readinessProbe,
        (info) => sendEvent('probe', { profileId: profile.id, attempt: info.attempt, max: info.max, stage: info.stage, ok: info.ok, error: info.error }),
      );
      if (ready) {
        svc.status = 'running';
        sendEvent('step', { step: `build-${profile.id}`, status: 'done', title: `${profile.name} 就绪 :${svc.hostPort}` });
      } else {
        svc.status = 'error';
        svc.errorMessage = '就绪探测超时';
        sendEvent('step', { step: `build-${profile.id}`, status: 'error', title: `${profile.name} 就绪探测超时 :${svc.hostPort}` });
      }
    }

    // Aggregate overall branch state from the per-service status so a
    // readiness-timeout on any service doesn't silently resolve as 'running'.
    const svcStatuses = Object.values(entry.services).map(s => s.status);
    const anyError = svcStatuses.some(s => s === 'error');
    const anyStarting = svcStatuses.some(s => s === 'starting');
    const anyRunning = svcStatuses.some(s => s === 'running');
    entry.status = anyError && !anyRunning
      ? 'error'
      : anyStarting && !anyRunning
        ? 'starting'
        : 'running';
    entry.lastAccessedAt = new Date().toISOString();
    stateService.save();

    sendEvent('complete', {
      message: anyError
        ? `分支 "${finalSlug}" 部分服务就绪探测超时，详见日志`
        : `分支 "${finalSlug}" 已就绪，可以打开预览`,
    });
    resolveLock!();
  } catch (err) {
    // Look up by the canonical id we tracked through the try block,
    // not finalSlug — for non-legacy projects the entry lives under
    // `${slug}-${finalSlug}` and looking up by finalSlug returns
    // undefined, leaving the entry stuck in 'building' forever.
    // Fall back to finalSlug for the "failed before resolving project"
    // case where resolvedEntryId is still null.
    const entry = stateService.getBranch(resolvedEntryId ?? finalSlug);
    if (entry) {
      entry.status = 'error';
      entry.errorMessage = (err as Error).message;
      stateService.save();
    }
    sendEvent('error', { message: (err as Error).message });
    rejectLock!(err as Error);
  } finally {
    // Tear down every lock we registered (including the canonicalId /
    // entry.id locks added inside the try block once we resolved the
    // project — without this they leak and block future concurrent
    // auto-build requests for the same entry id).
    for (const key of lockKeys) buildLocks.delete(key);
    res.end();
  }
});

// ── Executor registry (needed BEFORE createServer so the branch router's
// deploy handler can dispatch to remote executors). Also used below by the
// scheduler and cluster routers. One shared instance. ──
//
// We create it here (not in the scheduler-mode block like before) because
// the branch deploy handler is part of createServer's routing and needs to
// check registry state on every /api/branches/:id/deploy call. Standalone
// deployments without remote executors still work — the registry just
// reports the embedded master and resolveDeployTarget returns null.
const registry = new ExecutorRegistry(stateService);
registry.startHealthChecks();
registry.registerEmbeddedMaster(config.masterPort);

// Current dispatcher strategy — mutable so the Dashboard's strategy radio
// can change it at runtime. Read fresh on every deploy by both the branch
// router and the cluster router. Default: 'least-load' (memory+CPU weighted).
let clusterStrategy: 'least-branches' | 'least-load' | 'round-robin' = 'least-load';

// P4 Part 18 (D.3): shared storage-mode context lets the
// storage-mode router surface + mutate the running backing store at
// runtime. initStateService() seeded the mutable fields above; we
// just wrap them in a plain object the router can hold by reference.
const storageModeContext = {
  resolvedMode: storageModeResolved,
  mongoHandle: activeMongoHandle as { close: () => Promise<void>; ping: () => Promise<boolean> } | null,
  mongoUri: process.env.CDS_MONGO_URI || null,
  mongoDb: process.env.CDS_MONGO_DB || 'cds_state_db',
};

// ── Master server (dashboard + API on masterPort) ──
const app = createServer({
  stateService,
  worktreeService,
  containerService,
  proxyService,
  bridgeService,
  shell,
  config,
  schedulerService,
  registry,
  getClusterStrategy: () => clusterStrategy,
  storageModeContext,
  stateFile,
  authStore: activeAuthStore,
});

// ── Helper: kill process on port so CDS can bind ──
// force=true → kill any process (used for masterPort which belongs exclusively to CDS)
// force=false → kill only CDS node processes (safe default)
function tryKillOnPort(port: number, force: boolean): boolean {
  try {
    const pids = execSync(`lsof -ti :${port} 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
    if (!pids) return false;
    let killed = false;
    for (const pid of pids.split('\n').filter(Boolean)) {
      const cmd = execSync(`ps -p ${pid} -o comm= 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
      if (force || ['node', 'tsx', 'ts-node', 'npx'].includes(cmd)) {
        console.log(`  Stopping process on port ${port} (PID: ${pid}, cmd: ${cmd})`);
        // Kill the entire process group to prevent tsx watch from respawning
        try {
          const pgid = execSync(`ps -p ${pid} -o pgid= 2>/dev/null || true`, { encoding: 'utf-8' }).trim();
          if (pgid && pgid !== String(process.pid)) {
            execSync(`kill -9 -- -${pgid} 2>/dev/null || true`);
          } else {
            execSync(`kill -9 ${pid} 2>/dev/null || true`);
          }
        } catch {
          execSync(`kill -9 ${pid} 2>/dev/null || true`);
        }
        killed = true;
      } else {
        console.log(`  [WARN] Port ${port} held by non-CDS process (PID: ${pid}, cmd: ${cmd}) — not killing`);
      }
    }
    if (killed) {
      // Wait briefly for kernel to release the socket
      execSync('sleep 0.5');
    }
    return killed;
  } catch {
    return false;
  }
}

// force: force-kill any process on the port (for masterPort)
// optional: if true, port conflict is non-fatal (for workerPort shared with other services)
function listenWithRetry(
  server: http.Server | ReturnType<typeof createServer>,
  port: number,
  label: string,
  onSuccess: () => void,
  opts: { force?: boolean; optional?: boolean } = {},
) {
  const MAX_ATTEMPTS = 5;
  // Track success so a late-arriving retry setTimeout doesn't call
  // `server.listen()` again on an already-bound socket and crash with
  // ERR_SERVER_ALREADY_LISTEN. Seen on B's CDS after `tsx watch` race
  // conditions produced multiple concurrent retries while the first one
  // eventually succeeded.
  let listening = false;
  const doListen = (attempt: number) => {
    if (listening) return; // retry scheduled before success became visible
    const s = server.listen(port, () => {
      listening = true;
      onSuccess();
    });
    s.on('error', (err: Error & { code?: string }) => {
      if (listening) return; // same late-retry guard after listening flipped
      if (err.code === 'EADDRINUSE' && attempt < MAX_ATTEMPTS) {
        console.log(`  [WARN] Port ${port} in use, attempting to reclaim (${label}, attempt ${attempt + 1}/${MAX_ATTEMPTS})...`);
        const killed = tryKillOnPort(port, !!opts.force);
        if (killed) {
          // Exponential backoff: 1.5s, 2s, 3s, 4s, 5s
          const delay = 1500 + attempt * 500;
          setTimeout(() => doListen(attempt + 1), delay);
        } else if (opts.optional) {
          console.log(`  [INFO] Port ${port} occupied by another service — ${label} skipped (non-essential)`);
        } else {
          console.error(`  [ERROR] Port ${port} is occupied by a non-CDS process. Please free it manually.`);
          process.exit(1);
        }
      } else if (opts.optional) {
        console.log(`  [INFO] ${label} on port ${port} unavailable — skipped`);
      } else {
        console.error(`  [ERROR] Cannot bind ${label} to port ${port}: ${err.message}`);
        process.exit(1);
      }
    });
  };
  doListen(0);
}

// ── Mode-based startup ──
const mode = config.mode;
console.log(`\n  Cloud Development Suite (mode: ${mode})`);
console.log(`  ──────────────────────`);

if (mode === 'executor') {
  // ── Executor mode: only start executor API, no dashboard/proxy ──
  const executorApp = express();
  executorApp.use(express.json());
  executorApp.use('/exec', createExecutorRouter({
    stateService, worktreeService, containerService, shell, config,
  }));

  const agent = new ExecutorAgent(config, stateService);

  listenWithRetry(executorApp, config.executorPort, 'Executor', async () => {
    console.log(`  Executor API:  http://localhost:${config.executorPort}`);
    console.log(`  Scheduler:     ${config.schedulerUrl || '(not set)'}`);
    console.log(`  State file:    ${stateFile}`);
    console.log(`  Repo root:     ${config.repoRoot}`);
    console.log('');

    // Register with scheduler and start heartbeat
    await agent.register();
    agent.startHeartbeat();
  }, { force: true });

  // ── Executor status page on masterPort (9900) ──
  //
  // In executor mode the Dashboard is intentionally absent, but users
  // often open http://<executor-host>:9900/ expecting SOMETHING, not
  // "connection refused". We serve a small informative page on the
  // master port that tells them:
  //   - this node is an executor
  //   - which cluster it belongs to (with link to master Dashboard)
  //   - executor id + last heartbeat age
  //   - how to disconnect (CLI command)
  // The page refreshes itself every 5 seconds.
  const statusApp = express();
  statusApp.use(express.json());
  statusApp.get('/healthz', (_req, res) => {
    res.json({ ok: true, role: 'executor', master: config.masterUrl || config.schedulerUrl || null });
  });
  // Liveness check used by CLI connect_cmd polling — mirror master status shape
  statusApp.get('/api/cluster/status', (_req, res) => {
    res.json({
      mode: 'executor',
      effectiveRole: 'executor',
      masterUrl: config.masterUrl || config.schedulerUrl || null,
      executorId: agent.executorId,
      hasBootstrapToken: !!config.bootstrapToken,
      remoteExecutorCount: 0,
      capacity: null,
      strategy: null,
    });
  });
  statusApp.get('*', (_req, res) => {
    const masterUrl = config.masterUrl || config.schedulerUrl || '';
    const masterDashboard = masterUrl || '#';
    const hostname = os.hostname();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CDS Executor · ${hostname}</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{max-width:520px;width:100%;padding:36px;background:#161b22;border:1px solid #30363d;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,0.4)}
.icon{width:52px;height:52px;margin:0 auto 18px;background:linear-gradient(135deg,rgba(88,166,255,0.2),rgba(88,166,255,0.05));border:1px solid rgba(88,166,255,0.4);border-radius:12px;display:flex;align-items:center;justify-content:center;color:#58a6ff}
h1{text-align:center;font-size:20px;font-weight:700;margin-bottom:6px;color:#f0f6fc}
.subtitle{text-align:center;font-size:13px;color:#8b949e;margin-bottom:28px}
.info{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:14px 16px;margin-bottom:14px}
.info-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;font-size:12px;border-bottom:1px solid #21262d}
.info-row:last-child{border-bottom:none}
.info-row .label{color:#8b949e}
.info-row .value{color:#c9d1d9;font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;word-break:break-all;text-align:right;margin-left:16px}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3fb950;margin-right:6px;animation:pulse 2s ease infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
.btn{display:block;width:100%;padding:11px;background:#238636;color:white;text-align:center;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600;margin-bottom:10px}
.btn:hover{background:#2ea043}
.btn-secondary{background:transparent;border:1px solid #30363d;color:#58a6ff}
.btn-secondary:hover{background:rgba(88,166,255,0.08)}
.cli-hint{background:#0d1117;border:1px solid #21262d;border-radius:6px;padding:10px 12px;margin-top:14px;font-size:11px;color:#8b949e}
.cli-hint code{background:#21262d;padding:2px 6px;border-radius:3px;color:#58a6ff;font-family:ui-monospace,monospace}
.auto-refresh{text-align:center;font-size:11px;color:#6e7681;margin-top:16px}
</style>
</head>
<body>
<div class="card">
<div class="icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="4" y="4" width="16" height="4" rx="1"/><rect x="4" y="11" width="16" height="4" rx="1"/><rect x="4" y="18" width="16" height="3" rx="1"/><circle cx="7" cy="6" r="0.5" fill="currentColor"/><circle cx="7" cy="13" r="0.5" fill="currentColor"/></svg></div>
<h1>本节点是集群执行器</h1>
<p class="subtitle"><span class="status-dot"></span>CDS Executor · 无独立 Dashboard · 由主节点统一管理</p>
<div class="info">
<div class="info-row"><span class="label">Executor ID</span><span class="value">${escHtmlSafe(agent.executorId)}</span></div>
<div class="info-row"><span class="label">主机名</span><span class="value">${escHtmlSafe(hostname)}</span></div>
<div class="info-row"><span class="label">集群主节点</span><span class="value">${escHtmlSafe(masterUrl || '(未配置)')}</span></div>
<div class="info-row"><span class="label">Executor 端口</span><span class="value">http://localhost:${config.executorPort}/exec/*</span></div>
<div class="info-row"><span class="label">心跳周期</span><span class="value">15 秒</span></div>
</div>
${masterUrl ? `<a class="btn" href="${escHtmlSafe(masterUrl)}" target="_blank" rel="noopener">前往主节点 Dashboard →</a>` : ''}
<a class="btn btn-secondary" href="/api/cluster/status">查看本节点 JSON 状态</a>
<div class="cli-hint">
💡 <strong>为什么我看不到 Dashboard？</strong><br>
这是有意为之：executor 只负责跑容器，由主节点的 Dashboard 统一管理本机+所有远端节点的分支、部署、日志。双 Dashboard 会导致以下问题：<br>
&nbsp;&nbsp;• 两边看到的分支状态可能不一致（split-brain）<br>
&nbsp;&nbsp;• 同一分支在两边被触发部署时互相踩踏<br>
&nbsp;&nbsp;• 每台 executor 都要单独配置账号、SSL、域名，运维成本翻倍<br>
所以主节点是本集群唯一的控制平面。要在本机重新拉起 Dashboard，<strong>在主节点点「退出集群」</strong>（也可以在此服务器执行 <code>./exec_cds.sh disconnect</code>），然后 <code>./exec_cds.sh restart</code> 即可回到 standalone 模式。
</div>
<p class="auto-refresh">每 10 秒自动刷新 · <a href="#" onclick="location.reload();return false" style="color:#58a6ff;text-decoration:none">立即刷新</a></p>
</div>
<script>setTimeout(()=>location.reload(),10000);</script>
</body>
</html>`);
  });
  function escHtmlSafe(s: string): string {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  listenWithRetry(statusApp, config.masterPort, 'ExecutorStatus', () => {
    console.log(`  Status page:   http://localhost:${config.masterPort}  (executor mode info page)`);
  }, { optional: true });
} else {
  // ── Standalone or Scheduler mode: start dashboard + proxy ──
  listenWithRetry(app, config.masterPort, 'Dashboard', () => {
    console.log(`  Dashboard:  http://localhost:${config.masterPort}`);
    console.log(`  Worker:     http://localhost:${config.workerPort}`);
    console.log(`  Bridge:     http://localhost:${config.masterPort}/api/bridge/ (HTTP polling)`);
    if (config.rootDomains?.length) console.log(`  Domains:    ${config.rootDomains.join(', ')}`);
    if (config.dashboardDomain) console.log(`  Routing:    exact root domain -> Dashboard (${config.dashboardDomain})`);
    if (config.rootDomains?.length) console.log(`  Preview:    any subdomain under configured root domains`);
    console.log(`  State file: ${stateFile}`);
    console.log(`  Repo root:  ${config.repoRoot}`);
    console.log('');
  }, { force: true });

  // ── Bridge activity tracking ──
  bridgeService.onActivity((branchId, action) => {
    const branchTags = stateService.getBranch(branchId)?.tags ?? [];
    broadcastActivity({
      id: nextActivitySeq(),
      ts: new Date().toISOString(),
      method: 'BRIDGE',
      path: action,
      status: 200,
      duration: 0,
      type: 'cds',
      source: 'ai',
      branchId,
      branchTags: branchTags.length ? branchTags : undefined,
    });
  });

  // ── Worker server (reverse proxy on workerPort) ──
  const workerServer = http.createServer((req, res) => {
    proxyService.handleRequest(req, res);
  });

  workerServer.on('upgrade', (req, socket, head) => {
    proxyService.handleUpgrade(req, socket, head);
  });

  listenWithRetry(workerServer, config.workerPort, 'Worker', () => {
    console.log(`  Worker proxy listening on :${config.workerPort}`);
    console.log(`  Route via X-Branch header or configure routing rules in dashboard.`);
    console.log('');
  }, { optional: true });

  // ── Always-on scheduler router (standalone + scheduler modes) ──
  //
  // We mount `/api/executors` in both standalone and scheduler modes so that
  // a fresh machine running in standalone can accept its first bootstrap
  // registration and *then* upgrade itself to scheduler in place — no
  // process restart required. See `doc/design.cds-cluster-bootstrap.md` §4.4.
  //
  // In standalone mode the dispatcher is still created but has no remote
  // executors to dispatch to until the first one registers. The embedded
  // master is self-registered immediately so `/api/executors/capacity`
  // returns meaningful numbers on day one.
  //
  // NOTE: `registry` is now created above, BEFORE createServer(), so the
  // branch router's deploy handler can read it. We just reuse the same
  // instance here for the scheduler / cluster routers.
  const dispatcher = new BranchDispatcher(
    registry,
    new HttpSnapshotFetcher(process.env.AI_ACCESS_KEY || undefined),
  );

  // Mint a permanent token on bootstrap consume. We hold it in-memory first,
  // then persist to `.cds.env` so a process restart keeps the same token.
  //
  // CRITICAL: if persistence fails the in-memory token is still returned to
  // the executor (so the live cluster keeps working) but a master restart
  // will lose the token, falling back to the no-auth path. We log LOUDLY so
  // the operator can recover by manually re-issuing a token.
  const onBootstrapConsumed = async (): Promise<string> => {
    const token = crypto.randomBytes(32).toString('hex');
    config.executorToken = token;
    try {
      updateEnvFile(defaultEnvFilePath(), {
        CDS_EXECUTOR_TOKEN: token,
        CDS_BOOTSTRAP_TOKEN: null,
        CDS_BOOTSTRAP_TOKEN_EXPIRES_AT: null,
      });
      // Clear in-memory bootstrap token so the next registration attempt
      // (e.g., a replay of the same request) is rejected as expired.
      config.bootstrapToken = undefined;
      console.log('  [scheduler] Bootstrap token consumed, permanent token minted');
    } catch (err) {
      console.error('');
      console.error('  ╔═══════════════════════════════════════════════════════════════╗');
      console.error('  ║  ⚠️  CRITICAL: failed to persist permanent executor token!    ║');
      console.error('  ║                                                                ║');
      console.error('  ║  The live cluster will keep working, but a master restart     ║');
      console.error('  ║  will lose the token and fall back to the no-auth path.      ║');
      console.error('  ║                                                                ║');
      console.error('  ║  Recovery: fix the .cds.env permission/disk issue, then run  ║');
      console.error('  ║    ./exec_cds.sh issue-token                                   ║');
      console.error('  ║  to re-bootstrap the cluster.                                  ║');
      console.error('  ╚═══════════════════════════════════════════════════════════════╝');
      console.error(`  [scheduler] Underlying error: ${(err as Error).message}`);
      console.error('');
      // Surface to dashboard activity stream as well so the UI shows it.
      broadcastActivity({
        id: nextActivitySeq(),
        ts: new Date().toISOString(),
        method: 'CLUSTER',
        path: `⚠️ 永久 token 持久化失败: ${(err as Error).message}`,
        status: 500,
        duration: 0,
        type: 'cds',
        source: 'user',
      });
    }
    return token;
  };

  // Hot mode upgrade: standalone → scheduler on the first remote register.
  // Safe to run multiple times; subsequent calls early-return because
  // `config.mode` is already `scheduler`. The routes layer additionally
  // gates the call so it only fires when the registry has zero remote
  // executors prior to this register.
  const onFirstRegister = async (executorId: string): Promise<void> => {
    if (config.mode === 'scheduler') return; // already upgraded
    console.log(`  [scheduler] First executor ${executorId} joined — upgrading mode: standalone → scheduler`);
    config.mode = 'scheduler';
    try {
      updateEnvFile(defaultEnvFilePath(), { CDS_MODE: 'scheduler' });
    } catch (err) {
      console.error('');
      console.error('  ⚠️  WARNING: failed to persist CDS_MODE=scheduler.');
      console.error('     Cluster works in-memory but the master will boot back to');
      console.error('     standalone after a restart. Fix .cds.env and re-run');
      console.error('     ./exec_cds.sh restart to recover.');
      console.error(`     Underlying error: ${(err as Error).message}`);
      console.error('');
    }
    // Broadcast an activity event so the dashboard notices immediately.
    broadcastActivity({
      id: nextActivitySeq(),
      ts: new Date().toISOString(),
      method: 'CLUSTER',
      path: `升级为集群调度器 (first executor: ${executorId})`,
      status: 200,
      duration: 0,
      type: 'cds',
      source: 'user',
    });
  };

  app.use('/api/executors', createSchedulerRouter({
    registry,
    config,
    dispatcher,
    onFirstRegister,
    onBootstrapConsumed,
  }));
  console.log(`  Scheduler: executor management API mounted at /api/executors (mode: ${mode})`);

  // ── One-click UI cluster bootstrap (issue-token / join / leave / status) ──
  //
  // Parallels the CLI flow in exec_cds.sh but lets a human click through
  // the Dashboard without ever opening a terminal. The router holds a
  // single in-process ExecutorAgent handle so /join and /leave can flip
  // the node between standalone and "hot-joined hybrid" states without a
  // restart. See `cds/src/routes/cluster.ts` for the flow doc.
  let hotJoinAgent: ExecutorAgent | null = null;
  app.use('/api/cluster', createClusterRouter({
    config,
    stateService,
    registry,
    getExecutorAgent: () => hotJoinAgent,
    setExecutorAgent: (agent) => { hotJoinAgent = agent; },
    // Reuse the module-level strategy variable (declared before createServer)
    // so both the branch router and the cluster router see the same value.
    getStrategy: () => clusterStrategy,
    setStrategy: (s) => { clusterStrategy = s; },
  }));
  console.log(`  Cluster: one-click bootstrap API mounted at /api/cluster`);

  if (mode === 'scheduler') {
    console.log(`  Scheduler: dispatcher enabled, cluster-aware routing active`);
  } else {
    console.log(`  Scheduler: standby, will auto-upgrade on first executor bootstrap`);
  }

  // ── SPA fallback MUST be installed last ──
  //
  // The static file handler + catch-all `app.get('*', ...)` are greedy and
  // would shadow any route mounted after them (the registration order is
  // what Express honors, not the URL specificity). Both the scheduler and
  // cluster routers are mounted in this file AFTER createServer() returns,
  // so we defer the SPA fallback until here — otherwise GET requests to
  // `/api/executors/*` and `/api/cluster/*` would silently return index.html
  // and downstream clients see HTML where they expect JSON. That bug
  // masked the dashboard's new cluster panel from working in production.
  installSpaFallback(app);
}
