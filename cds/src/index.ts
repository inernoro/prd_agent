import http from 'node:http';
import os from 'node:os';
import * as v8 from 'node:v8';
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
import { AutoLifecycleService } from './services/auto-lifecycle.js';
import { InfraFlapWatchdog } from './services/infra-flap-watchdog.js';
import { BridgeService } from './services/bridge.js';
import { buildPreviewUrlForProject } from './services/comment-template.js';
import { previewSlugMatchPercent } from './services/preview-slug.js';
import crypto from 'node:crypto';
import { BranchDispatcher, HttpSnapshotFetcher } from './scheduler/dispatcher.js';
import { ExecutorAgent } from './executor/agent.js';
import { createExecutorRouter } from './executor/routes.js';
import { ExecutorRegistry } from './scheduler/executor-registry.js';
import { createSchedulerRouter } from './scheduler/routes.js';
import { createClusterRouter } from './routes/cluster.js';
import { updateEnvFile, defaultEnvFilePath } from './services/env-file.js';
import { getCdsAiAccessKey } from './config/known-env-keys.js';
import { createGracefulShutdownController } from './services/graceful-shutdown.js';
import { ForwarderRoutePublisher } from './services/forwarder-route-publisher.js';
import { PreviewCanaryService, type PreviewCanaryTarget } from './services/preview-canary.js';
import { syncAllSystemdUnits } from './services/systemd-sync.js';
import { branchEvents, nowIso } from './services/branch-events.js';
import { archiveBranchContainerLogs } from './services/container-log-archiver.js';
import { reconcileStaleDeployDispatches, type DeployDispatchReconcileResult } from './services/deploy-dispatch-reconciler.js';
import { shouldRetryInterruptedWebhookDispatch } from './services/deploy-dispatch-retry.js';
import { httpLogStoreFromEnv } from './services/http-log-store.js';
import { serverEventLogStoreFromEnv } from './services/server-event-log-store.js';
import { resolveStateBootstrapMode, seedStateFromJsonIfAllowed } from './services/state-bootstrap.js';

(globalThis as unknown as { __CDS_PROCESS_STARTED_AT?: string }).__CDS_PROCESS_STARTED_AT = new Date().toISOString();
import type { ServerEventLogSink, ServerEventSeverity } from './services/server-event-log-store.js';
import { DockerEventMonitor } from './services/container-diagnostics.js';
import { classifyDockerLifecycleEvent } from './services/docker-lifecycle-classifier.js';
import { SystemLogMonitor } from './services/system-log-monitor.js';
import {
  BranchOperationCoordinator,
  type BranchOperationKind,
  type BranchOperationLease,
  type BranchOperationTrigger,
  type PendingWebhookDeploy,
} from './services/branch-operation-coordinator.js';

// .cds.env 注入 process.env 的逻辑搬到 ./load-env.js，并被 ./config.js 顶部
// side-effect import。这里保留 side-effect import 是为了即便有人未来调整
// import 顺序、把 config 的 import 挪走，env loading 也仍然先于业务模块求值。
import './load-env.js';
import { parseCsv } from './util/parse-csv.js';
import type { BranchEntry } from './types.js';

const configPath = process.argv[2] || undefined;
const config = loadConfig(configPath);

const shell = new ShellExecutor();

const MASTER_MEMORY_MONITOR_INTERVAL_MS = Math.max(
  10_000,
  Number.parseInt(process.env.CDS_MASTER_MEMORY_MONITOR_INTERVAL_MS || '', 10) || 30_000,
);
const MASTER_MEMORY_EVENT_MIN_INTERVAL_MS = Math.max(
  30_000,
  Number.parseInt(process.env.CDS_MASTER_MEMORY_EVENT_MIN_INTERVAL_MS || '', 10) || 120_000,
);
const STALE_DEPLOY_DISPATCH_RECONCILE_INTERVAL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.CDS_STALE_DEPLOY_DISPATCH_RECONCILE_INTERVAL_MS || '', 10) || 300_000,
);

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function startMasterMemoryMonitor(store: ServerEventLogSink | null): NodeJS.Timeout | null {
  if (!store) return null;
  let lastSeverity: ServerEventSeverity | null = null;
  let lastRecordedAt = 0;
  let maxHeapUsed = 0;
  let maxRss = 0;

  const sample = () => {
    const mem = process.memoryUsage();
    const heapStats = v8.getHeapStatistics();
    maxHeapUsed = Math.max(maxHeapUsed, mem.heapUsed);
    maxRss = Math.max(maxRss, mem.rss);
    const heapLimit = heapStats.heap_size_limit || 0;
    const heapRatio = heapLimit > 0 ? mem.heapUsed / heapLimit : 0;
    const severity: ServerEventSeverity | null =
      heapRatio >= 0.9 ? 'error' :
        heapRatio >= 0.75 ? 'warn' :
          null;
    const now = Date.now();
    if (!severity) {
      if (lastSeverity && heapRatio < 0.65) lastSeverity = null;
      return;
    }
    if (lastSeverity === severity && now - lastRecordedAt < MASTER_MEMORY_EVENT_MIN_INTERVAL_MS) return;
    lastSeverity = severity;
    lastRecordedAt = now;
    const message =
      `cds-master heap pressure ${Math.round(heapRatio * 100)}% ` +
      `(heapUsed=${mb(mem.heapUsed)}MB heapLimit=${mb(heapLimit)}MB rss=${mb(mem.rss)}MB)`;
    store.record({
      category: 'system',
      severity,
      source: 'cds-master-memory',
      action: 'process.memory.pressure',
      message,
      status: severity,
      details: {
        pid: process.pid,
        heapUsedMB: mb(mem.heapUsed),
        heapTotalMB: mb(mem.heapTotal),
        heapLimitMB: mb(heapLimit),
        heapRatio,
        rssMB: mb(mem.rss),
        externalMB: mb(mem.external),
        arrayBuffersMB: mb(mem.arrayBuffers),
        maxHeapUsedMB: mb(maxHeapUsed),
        maxRssMB: mb(maxRss),
      },
    });
    console.warn(`[memory] ${message}`);
  };

  const timer = setInterval(sample, MASTER_MEMORY_MONITOR_INTERVAL_MS);
  timer.unref?.();
  sample();
  return timer;
}

function startStaleDeployDispatchReconciler(
  state: StateService,
  store: ServerEventLogSink | null,
): NodeJS.Timeout | null {
  if (config.mode === 'executor') return null;
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    try {
      const reconciled = reconcileStaleDeployDispatches(state, {
        source: 'deploy-dispatch-reconciler.interval',
        serverEventLogStore: store,
      });
      if (reconciled.length > 0) {
        console.warn(`[deploy-dispatch] reconciled ${reconciled.length} stale webhook dispatch state(s)`);
      }
      dispatchRecoveredWebhookDeploys(state, store, reconciled, 'deploy-dispatch-reconciler.interval');
    } catch (err) {
      store?.record({
        category: 'system',
        severity: 'error',
        source: 'deploy-dispatch-reconciler.interval',
        action: 'branch.deploy-dispatch.reconcile.failed',
        message: `stale webhook deploy dispatch reconcile failed: ${(err as Error).message}`,
        details: { error: (err as Error).message },
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(run, STALE_DEPLOY_DISPATCH_RECONCILE_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function dispatchRecoveredWebhookDeploys(
  state: StateService,
  store: ServerEventLogSink | null,
  reconciled: DeployDispatchReconcileResult[],
  source: string,
): void {
  for (const result of reconciled) {
    if (result.nextStatus !== 'interrupted') continue;
    const traceHash = crypto.createHash('sha1')
      .update(`${result.branchId}\0${result.dispatchAt}\0${source}`)
      .digest('hex')
      .slice(0, 12);
    const operationId = `op_dispatch_retry_${traceHash}`;
    const requestId = `retry_${traceHash}`;
    const branch = state.getBranch(result.branchId);
    const decision = shouldRetryInterruptedWebhookDispatch(branch, result);
    if (!decision.retry || !branch || !result.commitSha) {
      store?.record({
        category: 'system',
        severity: 'info',
        source,
        action: 'branch.deploy-dispatch.retry-skipped',
        message: `stale webhook deploy retry skipped for ${result.branchId}: ${decision.reason}`,
        projectId: result.projectId,
        branchId: result.branchId,
        requestId,
        operationId,
        details: {
          operationId,
          requestId,
          reason: decision.reason,
          commitSha: result.commitSha || null,
          dispatchAt: result.dispatchAt,
          previousStatus: result.previousStatus,
        },
      });
      continue;
    }

    const retryAt = new Date().toISOString();
    branch.lastDeployDispatchAt = retryAt;
    branch.lastDeployDispatchCommitSha = result.commitSha;
    branch.lastDeployDispatchSource = 'webhook';
    branch.lastDeployDispatchStatus = 'dispatching';
    branch.lastDeployDispatchError = undefined;
    state.save();

    store?.record({
      category: 'system',
      severity: 'warn',
      source,
      action: 'branch.deploy-dispatch.retry-started',
      message: `retrying interrupted webhook deploy for ${result.branchId}`,
      projectId: branch.projectId,
      branchId: branch.id,
      requestId,
      operationId,
      details: {
        operationId,
        requestId,
        reason: decision.reason,
        commitSha: result.commitSha,
        originalDispatchAt: result.dispatchAt,
        retryAt,
        previousStatus: result.previousStatus,
      },
    });

    void fetch(`http://127.0.0.1:${config.masterPort}/api/branches/${encodeURIComponent(result.branchId)}/deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CDS-Internal': '1',
        'X-CDS-Trigger': 'webhook',
        'X-CDS-Request-Id': requestId,
        ...(branch.projectId ? { 'X-CDS-Source-Project-Id': branch.projectId } : {}),
        'X-CDS-Source-Branch-Id': branch.id,
      },
      body: JSON.stringify({ commitSha: result.commitSha }),
    }).then(async (response) => {
      const fresh = state.getBranch(result.branchId);
      if (response.ok) {
        if (fresh && fresh.lastDeployDispatchAt === retryAt) {
          fresh.lastDeployDispatchStatus = 'accepted';
          state.save();
        }
        const reader = response.body?.getReader();
        if (!reader) return;
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        return;
      }
      throw new Error(`HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    }).catch((err) => {
      const fresh = state.getBranch(result.branchId);
      if (fresh && fresh.lastDeployDispatchAt === retryAt) {
        fresh.lastDeployDispatchStatus = 'failed';
        fresh.lastDeployDispatchError = (err as Error).message;
        state.save();
      }
      store?.record({
        category: 'system',
        severity: 'error',
        source,
        action: 'branch.deploy-dispatch.retry-failed',
        message: `interrupted webhook deploy retry failed for ${result.branchId}: ${(err as Error).message}`,
        projectId: branch.projectId,
        branchId: branch.id,
        requestId,
        operationId,
        details: {
          operationId,
          requestId,
          commitSha: result.commitSha,
          originalDispatchAt: result.dispatchAt,
          retryAt,
          error: (err as Error).message,
        },
      });
    });
  }
}

function reconcileBranchStatusFromServices(branch: BranchEntry): { previousStatus: string; nextStatus: string; changed: boolean } {
  const previousStatus = branch.status;
  let serviceErrorCleared = false;
  for (const service of Object.values(branch.services || {})) {
    if (service.status === 'running' && service.errorMessage) {
      service.errorMessage = undefined;
      serviceErrorCleared = true;
    }
  }
  const statuses = Object.values(branch.services || {}).map((service) => service.status);
  if (statuses.some((status) => status === 'error')) branch.status = 'error';
  else if (statuses.some((status) => status === 'building')) branch.status = 'building';
  else if (statuses.some((status) => status === 'starting' || status === 'restarting')) branch.status = 'starting';
  else if (statuses.some((status) => status === 'running')) branch.status = 'running';
  else branch.status = 'idle';

  const failedReasons = Object.entries(branch.services || {})
    .filter(([, service]) => service.status === 'error')
    .map(([id, service]) => `${id}: ${service.errorMessage || '启动失败'}`);
  branch.errorMessage = failedReasons.length ? failedReasons.join('\n') : undefined;
  if (branch.status === 'running' && previousStatus !== 'running') {
    branch.lastReadyAt = new Date().toISOString();
  }
  return { previousStatus, nextStatus: branch.status, changed: previousStatus !== branch.status || serviceErrorCleared };
}

// ── State ──
//
// CDS_STORAGE_MODE selects the physical storage backend that the
// StateService writes through. See doc/plan.cds-multi-project-phases.md P3
// and doc/rule.cds-mongo-migration.md.
//
//   - 'json':            legacy state.json backend (explicit opt-in / tests)
//   - 'mongo-split':     MongoDB multi-collection store (default runtime)
//   - 'mongo':           Legacy MongoDB single-document store (explicit
//                        opt-in only).
//                        Fails fast on connection error so operators
//                        notice immediately instead of silently losing
//                        writes.
//   - 'auto':            Try mongo, fall back to json with a WARN log
//                        when mongo isn't reachable. Default for new
//                        installs that want "mongo if available, file
//                        otherwise" semantics without config.
//
// CDS_MONGO_URI + CDS_MONGO_DB configure the connection. Absent →
// explicit auto-mode falls back to json; mongo-mode throws.
const stateFile = path.join(config.repoRoot, '.cds', 'state.json');
const storageDefaultMode =
  process.env.CDS_MONGO_URI
    ? 'mongo-split'
    : process.env.NODE_ENV === 'test'
      ? 'json'
      : 'mongo-split';
const rawStorageMode = (
  process.env.CDS_STORAGE_MODE
  || storageDefaultMode
).toLowerCase();
if (!['json', 'mongo', 'mongo-split', 'auto'].includes(rawStorageMode)) {
  throw new Error(
    `Unknown CDS_STORAGE_MODE '${rawStorageMode}'. Valid values: 'json' | 'mongo' | 'mongo-split' | 'auto'.`,
  );
}
const stateBootstrapMode = resolveStateBootstrapMode(process.env.CDS_STATE_BOOTSTRAP_MODE);
/**
 * P4 Part 18 (D.2): storage-mode resolution.
 *
 * Behaviour matrix (updated 2026-04-18):
 *   - 'json' mode                     → JSON backing (legacy)
 *   - 'mongo' mode + URI connect OK   → Mongo backing
 *   - 'mongo' mode + URI missing/fail → throw (FATAL) — operator must fix
 *   - default runtime + URI missing   → FATAL; run ./exec_cds.sh init
 *   - explicit 'auto' + URI missing   → JSON backing (legacy escape hatch)
 *   - 'auto' mode + URI present + OK  → Mongo backing
 *   - 'auto' mode + URI present + fail→ throw (FATAL) — was fallback before
 *
 * The only fallback remaining is explicit "auto + no URI". A normal
 * runtime boot without CDS_MONGO_URI now fails fast instead of silently
 * creating state.json; tests keep their isolated JSON backend through
 * NODE_ENV=test.
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
        `CDS_STORAGE_MODE=${rawStorageMode} requires CDS_MONGO_URI. Run ./exec_cds.sh init to start cds-state-mongo and write .cds.env.`,
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
    // Seed: 全空 mongo + 有 state.json → 仅在显式 migrate 模式下导入。
    // 新安装默认 fresh，避免旧 repoRoot 里的 .cds/state.json 污染新 CDS。
    const splitSeedResult = await seedStateFromJsonIfAllowed(
      stateBootstrapMode,
      splitStore,
      new JsonStateBackingStore(stateFile),
    );
    if (splitSeedResult === 'seeded') {
      console.log('  [storage] mongo-split 全空且 CDS_STATE_BOOTSTRAP_MODE=migrate — 从 state.json seed 数据');
    } else if (splitSeedResult === 'skipped') {
      console.warn(
        '  [storage] mongo-split 全空但 state.json 存在 — 默认 fresh 启动，已跳过旧数据导入。'
        + ' 如需迁移旧数据，设置 CDS_STATE_BOOTSTRAP_MODE=migrate 后重启。',
      );
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
  // import the file snapshot only when operators explicitly opt in.
  // Default fresh startup must not silently carry old default data into
  // a new CDS instance.
  const mongoSeedResult = await seedStateFromJsonIfAllowed(
    stateBootstrapMode,
    mongoStore,
    new JsonStateBackingStore(stateFile),
  );
  if (mongoSeedResult === 'seeded') {
    console.log('  [storage] mongo is empty and CDS_STATE_BOOTSTRAP_MODE=migrate — seeding mongo from file');
  } else if (mongoSeedResult === 'skipped') {
    console.warn(
      '  [storage] mongo is empty but state.json exists — default fresh startup skipped file seed. '
      + 'Set CDS_STATE_BOOTSTRAP_MODE=migrate to import legacy state.',
    );
  }

  stateService = new StateService(stateFile, config.repoRoot, mongoStore);
  stateService.load();
  storageModeResolved = 'mongo';
  activeMongoHandle = handle;
  console.log(`  [storage] mongo backend active (uri=${uri.replace(/\/\/[^@]*@/, '//***:***@')}, db=${dbName})`);
}

await initStateService();

// ── Stale self-update 清扫(2026-05-07 用户反馈"卡 web-build 看不清状态"):
// .cds/active-update.json 里如果还有未结束的 update 记录但写它的进程已死,
// 说明上次 sidecar/路由异常崩溃。标 interrupted=true 让前端面板渲染"已中断"
// 红色态,而不是骗用户"还在跑"。下次正常 update 触发会覆盖。 ──
try {
  const { reconcileStaleOnStartup } = await import('./updater/active-update-store.js');
  const verdict = reconcileStaleOnStartup(config.repoRoot);
  if (verdict === 'marked-interrupted') {
    console.log('  [self-update] 检测到上次更新进程异常退出,已标记为中断状态(详见 .cds/active-update.json)');
  } else if (verdict === 'still-running') {
    console.log('  [self-update] 检测到正在进行的更新进程,跳过清扫');
  }
} catch (err) {
  console.warn(`  [self-update] reconcileStaleOnStartup 跳过: ${(err as Error).message}`);
}

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
const activeHttpLogStore = httpLogStoreFromEnv();
if (activeHttpLogStore) {
  try {
    await activeHttpLogStore.init();
    console.log('  [http-log] persistent request logging enabled (collection=cds_http_logs)');
  } catch (err) {
    console.warn(`  [http-log] init failed, persistent request logging disabled: ${(err as Error).message}`);
  }
}
const activeServerEventLogStore = serverEventLogStoreFromEnv();
if (activeServerEventLogStore) {
  try {
    await activeServerEventLogStore.init();
    console.log('  [server-event-log] persistent diagnostics enabled (collection=cds_server_events)');
  } catch (err) {
    console.warn(`  [server-event-log] init failed, persistent diagnostics disabled: ${(err as Error).message}`);
  }
}
const branchOperationCoordinator = new BranchOperationCoordinator(activeServerEventLogStore);
const masterMemoryMonitor = startMasterMemoryMonitor(activeServerEventLogStore);
const staleDeployDispatchReconciler = startStaleDeployDispatchReconciler(stateService, activeServerEventLogStore);

function beginBackgroundBranchOperation(input: {
  branchId: string;
  kind: BranchOperationKind;
  trigger: BranchOperationTrigger;
  source: string;
  reason: string;
  actor?: string;
  profileId?: string | null;
  commitSha?: string | null;
}): BranchOperationLease | null {
  const branch = stateService.getBranch(input.branchId);
  if (!branch) return null;
  const decision = branchOperationCoordinator.begin({
    branchId: branch.id,
    projectId: branch.projectId,
    profileId: input.profileId || null,
    kind: input.kind,
    trigger: input.trigger,
    actor: input.actor || input.trigger,
    requestId: null,
    commitSha: input.commitSha || branch.githubCommitSha || null,
    source: input.source,
    reason: input.reason,
  });
  if (decision.status === 'started') return decision.lease || null;
  throw new Error(`branch operation ${decision.status}: ${decision.reason || decision.activeKind || 'busy'}`);
}

function dispatchBackgroundPendingWebhookDeploy(pending: PendingWebhookDeploy | null): void {
  if (!pending) return;
  const branch = stateService.getBranch(pending.branchId);
  if (!branch) {
    activeServerEventLogStore?.record({
      category: 'system',
      severity: 'warn',
      source: 'branch-operation-coordinator',
      action: 'branch.operation.pending-drop',
      message: `pending webhook deploy dropped because branch is gone: ${pending.branchId}`,
      branchId: pending.branchId,
      requestId: pending.request.requestId || null,
      operationId: pending.operationId,
      operationKind: pending.request.kind,
      operationTrigger: pending.request.trigger,
      operationActor: pending.request.actor || null,
      operationSource: pending.request.source || null,
      commitSha: pending.request.commitSha || null,
      details: {
        operationId: pending.operationId,
        commitSha: pending.request.commitSha || null,
        trigger: pending.request.trigger,
        actor: pending.request.actor || null,
        source: pending.request.source || null,
        kind: pending.request.kind,
      },
    });
    return;
  }
  void fetch(`http://127.0.0.1:${config.masterPort}/api/branches/${encodeURIComponent(pending.branchId)}/deploy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CDS-Internal': '1',
      'X-CDS-Trigger': 'webhook',
      'X-CDS-Request-Id': pending.request.requestId || pending.operationId,
      ...(branch.projectId ? { 'X-CDS-Source-Project-Id': branch.projectId } : {}),
      'X-CDS-Source-Branch-Id': pending.branchId,
    },
    body: JSON.stringify({ commitSha: pending.request.commitSha || undefined }),
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
    }
    const reader = response.body?.getReader();
    if (!reader) return;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  }).catch((err) => {
    activeServerEventLogStore?.record({
      category: 'system',
      severity: 'error',
      source: 'branch-operation-coordinator',
      action: 'branch.operation.pending-dispatch.failed',
      message: `pending webhook deploy dispatch failed: ${(err as Error).message}`,
      projectId: branch.projectId,
      branchId: pending.branchId,
      requestId: pending.request.requestId || null,
      operationId: pending.operationId,
      operationKind: pending.request.kind,
      operationTrigger: pending.request.trigger,
      operationActor: pending.request.actor || null,
      operationSource: pending.request.source || null,
      commitSha: pending.request.commitSha || null,
      details: {
        operationId: pending.operationId,
        commitSha: pending.request.commitSha || null,
        trigger: pending.request.trigger,
        actor: pending.request.actor || null,
        source: pending.request.source || null,
        kind: pending.request.kind,
      },
    });
  });
  activeServerEventLogStore?.record({
    category: 'system',
    severity: 'info',
    source: 'branch-operation-coordinator',
    action: 'branch.operation.pending-dispatch.started',
    message: `pending webhook deploy dispatched: ${pending.branchId}`,
    projectId: branch.projectId,
    branchId: pending.branchId,
    requestId: pending.request.requestId || null,
    operationId: pending.operationId,
    operationKind: pending.request.kind,
    operationTrigger: pending.request.trigger,
    operationActor: pending.request.actor || null,
    operationSource: pending.request.source || null,
    commitSha: pending.request.commitSha || null,
    details: {
      operationId: pending.operationId,
      commitSha: pending.request.commitSha || null,
      trigger: pending.request.trigger,
      actor: pending.request.actor || null,
      source: pending.request.source || null,
      kind: pending.request.kind,
    },
  });
}

function completeBackgroundBranchOperation(
  lease: BranchOperationLease | null | undefined,
  status: 'completed' | 'failed' | 'cancelled',
  error?: string,
): void {
  if (!lease) return;
  dispatchBackgroundPendingWebhookDeploy(branchOperationCoordinator.complete(lease, status, error));
}

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
if (customEnv.CDS_REPOS_BASE) {
  config.reposBase = customEnv.CDS_REPOS_BASE;
  config.reposBaseSource = 'env';
} else if (config.reposBaseSource === 'default') {
  // Default path was deferred in config.ts so that any CDS_REPO_ROOT
  // override above takes effect first. Compute it now against the final
  // repoRoot value.
  config.reposBase = path.resolve(config.repoRoot, '.cds-repos');
  console.log(`[config] reposBase defaulting to ${config.reposBase}`);
}

// Ensure reposBase directory exists so git clone commands don't fail on
// a fresh install where the operator hasn't created the directory yet.
if (config.reposBase) {
  try {
    fs.mkdirSync(config.reposBase, { recursive: true });
  } catch (e) {
    console.warn(`[config] Warning: could not create reposBase directory ${config.reposBase}:`, e);
  }
}

// ── Services ──
// P4 Part 18 (G1.2): WorktreeService is stateless; every call passes
// the repoRoot explicitly. Deploy/bootstrap paths choose the correct
// repository root explicitly; preview requests are not allowed to create
// worktrees or containers.
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

// systemd unit 自动同步 — 让自更新无需 SSH。
// 历史背景:用户反馈"systemd 守护进程应该自动管,为什么要我 sudo cp?"
// 自更新后新 daemon 启动时检测 /etc/systemd/system/cds-{master,forwarder}.service
// 与 repo 模板有实质 drift 时,以 root 身份自动备份 + 重写 + daemon-reload,
// forwarder 还会立即 systemctl restart 让新 ExecStart 生效。
// 详细策略 + 跳过条件见 services/systemd-sync.ts 头部注释。
try {
  syncAllSystemdUnits(config.repoRoot);
} catch (err) {
  console.warn(`  [systemd-sync] 自动同步跳过/失败: ${(err as Error).message}`);
}

// 2026-05-07 一次性迁移:hotReload.mode === 'dotnet-watch' 的 BuildProfile 全部
// 升级到 'dotnet-run'。原因详见 cds/src/types.ts:240-281 —— dotnet watch 的 hot
// reload 在我们绑挂 worktree 长驻容器场景下偶发"DLL 时间戳新但运行进程仍跑老
// 字节码"。dotnet-run 信任 MSBuild 增量 + kill+rerun,撒谎概率显著低,真撒谎时
// 用户走 force-rebuild 即可破缓存。新创建的 profile 在 routes/branches.ts:4757
// 的 defaultMode 已经是 dotnet-run,本迁移只兜底已落库的旧记录。
// 用户反馈来源:举报报告 "git 行号回溯证明 worker 跑的是 24h 前的 cbef04c, 不是 HEAD"
try {
  const profiles = stateService.getBuildProfiles();
  let dotnetWatchMigrated = 0;
  for (const p of profiles) {
    if (p.hotReload && p.hotReload.mode === 'dotnet-watch') {
      p.hotReload.mode = 'dotnet-run';
      dotnetWatchMigrated += 1;
    }
  }
  if (dotnetWatchMigrated > 0) {
    stateService.save();
    console.log(
      `  [hot-reload] 一次性迁移完成: ${dotnetWatchMigrated} 个 BuildProfile 从 dotnet-watch 升级为 dotnet-run` +
      ` (举报报告"worker 加载旧字节码"的根因修复;详见 types.ts:240-281)`
    );
  }
} catch (err) {
  console.warn(`  [hot-reload] dotnet-watch 迁移跳过: ${(err as Error).message}`);
}

const containerService = new ContainerService(shell, config, {
  // Week 4.9 多项目网络隔离：从 StateService 取 project.dockerNetwork。
  // ContainerService 不直接依赖 StateService（避免循环导入）,通过这个轻量
  // 适配器拿值。老项目 dockerNetwork 字段可能为空,此时返回 undefined,
  // ContainerService 会兜底到 config.dockerNetwork。
  getDockerNetwork: (projectId) => stateService.getProject(projectId)?.dockerNetwork,
  // Bug D-residual followup(2026-05-10):computeProfileAliases 用 slug 做
  // 短别名启发式比对(profile.id 形如 `mysql-mdimp`,projectId 是
  // `defd4695ab5f`,slug 才是 `mdimp`)。adapter 把 slug 暴露给容器层。
  getProjectSlug: (projectId) => stateService.getProject(projectId)?.slug,
}, activeServerEventLogStore);

function allBranchServicesInactive(branch: { services?: Record<string, { status?: string }> }): boolean {
  return Object.values(branch.services || {}).every((item) =>
    item.status !== 'running' &&
    item.status !== 'starting' &&
    item.status !== 'building' &&
    item.status !== 'restarting'
  );
}

const dockerEventMonitor = new DockerEventMonitor(shell, activeServerEventLogStore, async (event) => {
  const action = String(event.action || '').toLowerCase();
  if (!['die', 'kill', 'destroy', 'oom'].includes(action)) return;
  if (!event.branchId || !event.profileId || !event.containerName) return;
  const branch = stateService.getBranch(event.branchId);
  const svc = branch?.services?.[event.profileId];
  if (!branch || !svc || svc.containerName !== event.containerName) return;
  const previousStatus = svc.status;
  if (!['running', 'starting', 'building', 'restarting'].includes(String(previousStatus || ''))) return;

  const classified = classifyDockerLifecycleEvent(event);
  svc.status = classified.nextServiceStatus;
  svc.errorMessage = classified.reason;
  if (allBranchServicesInactive(branch)) {
    branch.status = classified.nextBranchStatus;
    branch.errorMessage = classified.nextBranchStatus === 'error' ? classified.reason : undefined;
  }
  branch.lastStoppedAt = new Date().toISOString();
  branch.lastStopReason = classified.reason;
  branch.lastStopSource = classified.source;
  if (classified.unexpected) {
    stateService.incrementBranchStat(branch.id, 'stopCount');
  }
  try {
    stateService.appendActivityLog(branch.projectId, {
      type: classified.unexpected ? 'crash' : 'stop',
      branchId: branch.id,
      branchName: branch.branch,
      actor: 'docker-events',
      note: classified.reason,
    });
  } catch { /* activity log is best-effort */ }
  stateService.save();
  branchEvents.emitEvent({
    type: 'branch.status',
    payload: {
      branchId: branch.id,
      projectId: branch.projectId,
      status: branch.status,
      branch,
      ts: nowIso(),
    },
  });
  const lifecycleTrigger = event.lifecycleIntent
    ? event.lifecycleIntent.trigger || event.lifecycleIntent.actor || 'cds'
    : classified.unexpected
      ? 'external'
      : classified.source;
  const lifecycleActor = event.lifecycleIntent?.actor || (classified.source === 'cds' ? 'cds' : 'docker-events');
  const lifecycleSource = event.lifecycleIntent?.source || 'docker-events-state-sync';
  const syncAction = classified.source === 'cds'
    ? 'app.cds-stop.synced'
    : classified.unexpected
      ? 'app.external-stop.unexpected-synced'
      : 'app.lifecycle-stop.synced';
  activeServerEventLogStore?.record({
    category: 'container',
    severity: classified.unexpected ? 'error' : 'warn',
    source: 'docker-events-state-sync',
    action: syncAction,
    message: classified.reason,
    projectId: branch.projectId,
    branchId: branch.id,
    profileId: event.profileId,
    requestId: event.lifecycleIntent?.requestId || null,
    operationId: event.lifecycleIntent?.operationId || null,
    operationKind: event.lifecycleIntent?.operation || event.lifecycleIntent?.kind || null,
    operationTrigger: lifecycleTrigger,
    operationActor: lifecycleActor,
    operationSource: lifecycleSource,
    commitSha: branch.githubCommitSha || null,
    containerName: event.containerName,
    status: svc.status,
    details: {
      operationId: event.lifecycleIntent?.operationId || null,
      requestId: event.lifecycleIntent?.requestId || null,
      actor: lifecycleActor,
      trigger: lifecycleTrigger,
      source: lifecycleSource,
      commitSha: branch.githubCommitSha || null,
      action,
      previousStatus,
      nextStatus: svc.status,
      branchStatus: branch.status,
      exitCode: event.exitCode,
      oomKilled: event.oomKilled,
      dockerStatus: event.status,
      lifecycleIntent: event.lifecycleIntent,
      stopClass: classified.stopClass,
      stopSource: classified.source,
      unexpected: classified.unexpected,
      reason: 'sync-cds-state-after-docker-lifecycle-event',
    },
  });
});
const systemLogMonitor = new SystemLogMonitor(shell, activeServerEventLogStore);
const proxyService = new ProxyService(stateService, config);
proxyService.setWorktreeService(worktreeService);
proxyService.setHttpLogStore(activeHttpLogStore);
const bridgeService = new BridgeService();

// ── Forwarder route publisher (B'.2-forwarder, 2026-05-08) ──
// daemon 周期把当前 running 分支表写到 cds/.cds/forwarder-routes.json,
// 让独立的 cds-forwarder 进程消费。CDS_USE_FORWARDER=1 时启用;否则跳过
// 不浪费 IO。详见 cds/src/services/forwarder-route-publisher.ts。
let forwarderRoutePublisher: ForwarderRoutePublisher | null = null;
let previewCanaryService: PreviewCanaryService | null = null;
if (process.env.CDS_USE_FORWARDER === '1') {
  const rootDomainsForPublisher = (config.rootDomains && config.rootDomains.length)
    ? config.rootDomains
    : (config.previewDomain ? [config.previewDomain] : []);
  if (!rootDomainsForPublisher.length) {
    console.warn(
      '  [forwarder-publisher] CDS_USE_FORWARDER=1 但 rootDomains 为空,跳过启动(请配置 CDS_ROOT_DOMAINS)',
    );
  } else {
    const outputPath =
      process.env.CDS_FORWARDER_ROUTES_JSON ??
      path.join(config.repoRoot, 'cds', '.cds', 'forwarder-routes.json');
    forwarderRoutePublisher = new ForwarderRoutePublisher({
      state: stateService,
      outputPath,
      rootDomains: rootDomainsForPublisher,
      stableSamplesRequired: Math.max(
        1,
        Number.parseInt(process.env.CDS_FORWARDER_ROUTE_STABLE_SAMPLES || '', 10) || 2,
      ),
      logger: {
        info: (m) => console.log(m),
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });
    forwarderRoutePublisher.start();
    console.log(
      `  [forwarder-publisher] enabled, writing routes to ${outputPath} every 2s`,
    );
  }
}

if (config.mode !== 'executor') {
  const explicitCanaryUrls = parseCsv(process.env.CDS_PREVIEW_CANARY_URLS || '') ?? [];
  previewCanaryService = new PreviewCanaryService({
    getTargets: (): PreviewCanaryTarget[] => {
      if (explicitCanaryUrls.length) {
        return explicitCanaryUrls.map((url) => ({ url, label: url }));
      }
      const previewHost = config.previewDomain || config.rootDomains?.[0];
      if (!previewHost) return [];
      const targets: PreviewCanaryTarget[] = [];
      for (const branch of stateService.getAllBranches()) {
        if (branch.status !== 'running' || !branch.branch) continue;
        const project = stateService.getProject(branch.projectId);
        const built = buildPreviewUrlForProject(previewHost, branch.branch, project, branch.projectId);
        if (!built.url) continue;
        targets.push({ url: built.url, label: branch.id });
      }
      return targets;
    },
    intervalMs: Math.max(10_000, Number.parseInt(process.env.CDS_PREVIEW_CANARY_INTERVAL_MS || '', 10) || 30_000),
    timeoutMs: Math.max(2_000, Number.parseInt(process.env.CDS_PREVIEW_CANARY_TIMEOUT_MS || '', 10) || 8_000),
    sampleLimit: Math.max(1, Number.parseInt(process.env.CDS_PREVIEW_CANARY_SAMPLE_LIMIT || '', 10) || 3),
    maxFailureRatio: Number.parseFloat(process.env.CDS_PREVIEW_CANARY_MAX_FAILURE_RATIO || '') || 0,
    minFailuresToAlert: Math.max(1, Number.parseInt(process.env.CDS_PREVIEW_CANARY_MIN_FAILURES || '', 10) || 1),
    logger: {
      warn: (m) => console.warn(m),
      info: (m) => console.log(m),
      error: (m) => console.error(m),
    },
    onAlert: (payload) => {
      const first = payload.results.find((r) => !r.ok);
      activeServerEventLogStore?.record({
        category: 'system',
        severity: 'warn',
        source: 'preview-canary',
        action: 'preview.canary.alert',
        message: `${payload.failures}/${payload.total} preview probe(s) failed`,
        branchId: first?.headers?.cdsBranch || first?.label || null,
        requestId: first?.requestId || first?.probeId,
        upstream: first?.headers?.cdsUpstream || null,
        status: first ? String(first.status) : null,
        error: first?.error ? { message: first.error } : undefined,
        details: payload as unknown as Record<string, unknown>,
      });
    },
    onRecovery: (payload) => {
      const first = payload.recovered[0];
      activeServerEventLogStore?.record({
        category: 'system',
        severity: 'info',
        source: 'preview-canary',
        action: 'preview.canary.recovered',
        message: `${payload.recovered.length} preview probe(s) recovered`,
        branchId: first?.headers?.cdsBranch || first?.label || null,
        requestId: first?.requestId || first?.probeId,
        upstream: first?.headers?.cdsUpstream || null,
        status: first ? String(first.status) : null,
        details: payload as unknown as Record<string, unknown>,
      });
    },
  });
  previewCanaryService.start();
  console.log('  [preview-canary] enabled for running preview URLs');
}

// ── Graceful shutdown controller ──
// SIGTERM/self-update 触发 master 退出前,drain SSE / abort worker run / flush mongo。
const gracefulShutdownController = createGracefulShutdownController();
let dashboardHttpServer: http.Server | null = null;
let workerHttpServer: http.Server | null = null;
let shutdownInProgress = false;

// ── Warm-pool scheduler (v3.1) ──
// Disabled unless cds.config.json { "scheduler": { "enabled": true, ... } }.
// See doc/design.cds-resilience.md and doc/plan.cds-resilience-rollout.md.
//
// Runtime override: the Dashboard can toggle the scheduler via
// PUT /api/scheduler/enabled, which writes to state.json. That value wins
// over the config-file setting so operators can flip the scheduler without
// shelling into the box. `undefined` means "no override, use config".
{
  // cds.config.json 省略 scheduler 块时也要让持久化的 UI override 生效:
  // 先把默认 scheduler config 实体化,否则下面三个 override 因 `&&
  // config.scheduler` 守卫被跳过,用户在 Dashboard 存的 enabled/idleTTL/
  // maxHot 重启后丢回默认,违反"survives restart"(Codex P2)。实体化后
  // SchedulerService 也从同一个对象构造,保持一致。
  if (!config.scheduler) {
    config.scheduler = {
      enabled: false,
      maxHotBranches: 3,
      idleTTLSeconds: 900,
      tickIntervalSeconds: 60,
      pinnedBranches: [],
    };
  }
  const uiOverride = stateService.getSchedulerEnabledOverride();
  if (uiOverride !== undefined) {
    config.scheduler.enabled = uiOverride;
    console.log(`  [scheduler] applying UI override: enabled=${uiOverride}`);
  }
  const idleTTLOverride = stateService.getSchedulerIdleTTLOverride();
  if (idleTTLOverride !== undefined) {
    config.scheduler.idleTTLSeconds = idleTTLOverride;
    console.log(`  [scheduler] applying UI override: idleTTLSeconds=${idleTTLOverride}`);
  }
  const maxHotOverride = stateService.getSchedulerMaxHotOverride();
  if (maxHotOverride !== undefined) {
    config.scheduler.maxHotBranches = maxHotOverride;
    console.log(`  [scheduler] applying UI override: maxHotBranches=${maxHotOverride}`);
  }
}
const schedulerService = new SchedulerService(stateService, config.scheduler);
// coolFn: stop all containers of a branch but keep the branch entry in state.
// A later explicit deploy/webhook/cdscli action can bring it back to HOT;
// passive preview requests must only show state and must not start containers.
schedulerService.setCoolFn(async (slug: string) => {
  const branch = stateService.getBranch(slug);
  if (!branch) return;
  const branchOperationLease = beginBackgroundBranchOperation({
    branchId: slug,
    kind: 'scheduler-cooling',
    trigger: 'scheduler',
    actor: 'scheduler',
    source: 'schedulerService.setCoolFn',
    reason: '调度器降温（保留容器，可秒级唤醒）',
  });
  let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
  try {
  branch.status = 'stopping';
  stateService.save();
  for (const svc of Object.values(branch.services)) {
    branchOperationLease?.assertCurrent(`scheduler cooling before ${svc.profileId}`);
    if (svc.status === 'running' || svc.status === 'starting') {
      // 先把 svc.status 翻成 stopping 再 await stop()。stop() 重构后容器
      // 停止仍保留(exited)，若此处仍是 running，30s auto-restart tick 命中
      // 这段 await 窗口会把"正在主动降温"的容器误判为 crash、bump stopCount、
      // 还 docker start 抢跑（Cursor Bugbot High）。与手动 /stop 处理一致。
      svc.status = 'stopping';
      try {
        await containerService.stop(svc.containerName, '调度器降温（保留容器，可秒级唤醒）', {
          projectId: branch.projectId,
          branchId: branch.id,
          profileId: svc.profileId,
          operationId: branchOperationLease?.operationId || null,
          actor: 'scheduler',
          trigger: 'scheduler',
          operation: 'scheduler-cooling',
          source: 'schedulerService.setCoolFn',
        });
      } catch (err) {
        console.warn(`[scheduler] stop(${svc.containerName}) failed: ${(err as Error).message}`);
      }
      svc.status = 'stopped';
    }
  }
  await archiveBranchContainerLogs({
    stateService,
    containerService,
    branch,
    source: 'scheduler-stop',
    serverEventLogStore: activeServerEventLogStore,
    message: 'captured after scheduler cooling stop preserved containers',
    operationId: branchOperationLease?.operationId || null,
    actor: 'scheduler',
    trigger: 'scheduler',
  });
  branch.status = 'idle';
  // 2026-05-14: 记录调度器降温原因，让用户在 UI 上看清"为什么变灰"。
  // 区分空闲降温和容量驱逐，便于排查。
  branch.lastStoppedAt = new Date().toISOString();
  const idleTTLSec = config.scheduler?.idleTTLSeconds ?? 900;
  const lastAccessMs = branch.lastAccessedAt ? Date.parse(branch.lastAccessedAt) : 0;
  const idleSec = lastAccessMs > 0 ? Math.floor((Date.now() - lastAccessMs) / 1000) : 0;
  if (lastAccessMs > 0 && idleSec >= idleTTLSec) {
    branch.lastStopReason = `调度器：空闲 ${Math.floor(idleSec / 60)} 分钟，超过 ${Math.floor(idleTTLSec / 60)} 分钟阈值自动降温`;
  } else {
    branch.lastStopReason = '调度器：超出热容量上限被驱逐（LRU）';
  }
  branch.lastStopSource = 'scheduler';
  // 同步追加项目活动日志，便于在分支日志面板里看到时间线。
  try {
    stateService.appendActivityLog(branch.projectId, {
      type: 'stop',
      branchId: slug,
      branchName: branch.branch,
      actor: 'scheduler',
      note: branch.lastStopReason,
    });
  } catch { /* activity log 是辅助手段，失败不影响主流程 */ }
  // 2026-05-14 Cursor Bugbot review 修复：与另外两条停止路径
  // （AutoLifecycleService.stopBranch / 手动 stop handler）保持一致，
  // 调度器降温也要 +1 stopCount，否则 UI 上"停止次数"对调度器停止漏计。
  stateService.incrementBranchStat(slug, 'stopCount');
  branchOperationLease?.assertCurrent('scheduler cooling before final save');
  stateService.save();
  } catch (err) {
    branchOperationFinalStatus = 'failed';
    throw err;
  } finally {
    completeBackgroundBranchOperation(branchOperationLease, branchOperationFinalStatus);
  }
});
proxyService.setScheduler(schedulerService);

// Preview auto-wake (the lighter-weight restart path the cooling closure above
// left as a TODO). A branch the scheduler put to sleep keeps its containers
// (cooling only `docker stop`s them), so a real page navigation can revive it
// with a cheap `docker restart` instead of dumping the visitor on a "go
// redeploy manually" dead-end. Strictly scoped by the proxy to
// scheduler-cooled branches; this callback double-guards the same. Errored /
// crashed / user-stopped branches are never revived here. Kill-switch:
// CDS_PREVIEW_AUTOWAKE=0 disables it (falls back to the diagnostic page).
if (process.env.CDS_PREVIEW_AUTOWAKE !== '0') {
  proxyService.setOnReviveCooled(async (slug: string) => {
    const branch = stateService.getBranch(slug);
    if (!branch) return;
    // Re-check eligibility on this side: only scheduler-cooled, still idle, with
    // preserved containers. Guards against a status change between the proxy's
    // check and this async entry.
    if (branch.lastStopSource !== 'scheduler') return;
    if (branch.status !== 'idle') return;
    const services = Object.values(branch.services);
    if (services.length === 0) return;

    // Executor-owned branches can't be revived by a LOCAL docker restart. A
    // resolved deploy clears executorId to undefined for embedded/local runs
    // (branches.ts: `stillRemote?.role==='embedded' || !stillRemote` → undefined),
    // so a truthy executorId always means a REMOTE executor — whether currently
    // registered OR temporarily absent from the registry (coordinator restart /
    // missed heartbeat). In both cases the container runs off-master and the
    // local `restartServiceInPlace` is a doomed no-op that would flip the branch
    // to `error` and stop future retries. Skip without touching state so the
    // diagnostic page stays and a later visit retries once the executor
    // re-registers. Mirrors the auto-lifecycle stop path's
    // `if (branch.executorId && !remoteExecutor)` remote-unavailable handling.
    if (branch.executorId) return;

    // Acquire the operation lease BEFORE mutating state — throws on conflict
    // (a deploy / cooling already owns the branch), in which case we abort
    // without flipping status and the proxy renders the normal page.
    const lease = beginBackgroundBranchOperation({
      branchId: slug,
      kind: 'restart',
      trigger: 'scheduler',
      actor: 'scheduler',
      source: 'proxy.preview-auto-wake',
      reason: '预览访问自动唤醒（调度器降温分支，docker restart 未重建代码）',
    });
    let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';

    try {
      // Synchronous prefix (runs before the first await): flip to a loading
      // state and persist, so the waiting page the proxy renders right after
      // firing this callback shows live progress instead of the cooled
      // dead-end. Kept INSIDE the try so a throwing save() (disk/Mongo failure)
      // still hits the finally and completes the lease — otherwise the
      // coordinator would keep an active op forever and reject all future
      // deploy/restart/stop on this branch until process restart.
      branch.status = 'restarting';
      for (const svc of services) {
        if (svc.status === 'stopped' || svc.status === 'idle') svc.status = 'starting';
      }
      stateService.save();

      // Enforce the scheduler's hot-pool budget the same way scheduler.wake()
      // does — evict the LRU branch before bringing this one up. Otherwise
      // opening several cooled preview URLs would markHot() them all past
      // maxHotBranches until the next scheduler tick, blowing the configured
      // hot-container budget. No-op when the scheduler is disabled or
      // maxHotBranches is unset.
      //
      // Best-effort: eviction can throw when the chosen LRU victim has an active
      // higher-priority operation (its cool path rethrows the lease rejection).
      // That's unrelated to THIS branch — letting it fall into the catch below
      // would poison the requested branch into `error` and stop future preview
      // retries over a mere capacity hiccup. Swallow it; the next scheduler tick
      // re-enforces capacity. (A superseding op on THIS branch still surfaces via
      // the assertCurrent checks in the restart loop, not here.)
      try {
        await schedulerService.evictLruIfOverCapacity(slug);
      } catch (evictErr) {
        console.warn(`[auto-wake] capacity eviction skipped for "${slug}": ${(evictErr as Error).message}`);
      }

      const profiles = stateService.getBuildProfilesForProject(branch.projectId);
      const failed: string[] = [];
      for (const svc of services) {
        lease?.assertCurrent(`auto-wake before ${svc.profileId}`);
        const ok = await containerService.restartServiceInPlace(svc.containerName, undefined, {
          projectId: branch.projectId,
          branchId: branch.id,
          profileId: svc.profileId,
          operationId: lease?.operationId || null,
          actor: 'scheduler',
          trigger: 'scheduler',
          operation: 'branch-auto-wake',
          source: 'proxy.preview-auto-wake',
          reason: '预览访问自动唤醒（docker restart，未重建代码）',
        });
        lease?.assertCurrent(`auto-wake after ${svc.profileId}`);
        if (!ok) {
          svc.status = 'error';
          svc.errorMessage = `容器 ${svc.containerName} 自动唤醒失败（可能已被回收），请改用「重新部署」`;
          failed.push(svc.containerName);
          continue;
        }
        // restartServiceInPlace only waits for container liveness
        // (waitForContainerAlive), not for the app to actually bind its port /
        // serve HTTP. If we marked running here, the waiting poll would flip to
        // ready, reload, and proxy to a still-binding upstream (502 / refresh
        // loop) for slow-booting apps. Gate on real readiness exactly like the
        // deploy path: optional startup-signal, then TCP/HTTP probe. The branch
        // stays 'restarting' meanwhile, so the waiting page keeps showing
        // progress until the upstream truly serves.
        const profile = profiles.find((p) => p.id === svc.profileId);
        let ready = false;
        if (profile?.startupSignal) {
          ready = await containerService.waitForStartupSignal(svc.containerName, profile.startupSignal);
        }
        if (!profile?.startupSignal || ready) {
          ready = await containerService.waitForReadiness(svc.hostPort, profile?.readinessProbe);
        }
        lease?.assertCurrent(`auto-wake readiness ${svc.profileId}`);
        if (ready) {
          svc.status = 'running';
          svc.errorMessage = undefined;
        } else {
          svc.status = 'error';
          svc.errorMessage = `容器 ${svc.containerName} 就绪探测超时，请改用「重新部署」`;
          failed.push(svc.containerName);
        }
      }

      if (failed.length === 0) {
        lease?.assertCurrent('auto-wake before success save');
        branch.status = 'running';
        branch.errorMessage = undefined;
        branch.lastStoppedAt = undefined;
        branch.lastStopReason = undefined;
        branch.lastStopSource = undefined;
        // Refresh lastReadyAt to now: the branch just became ready again. If we
        // only cleared lastStoppedAt, AutoLifecycleService.tick() (which backfills
        // stale readiness only while lastReadyAt <= lastStoppedAt) would keep
        // computing age from the OLD pre-cooling readiness time and could
        // immediately auto-publish/redeploy a branch the user just opened.
        branch.lastReadyAt = new Date().toISOString();
        // Manual /restart 同款：先刷新 lastAccessedAt 再 markHot，否则被空闲 TTL
        // 降温过的陈旧时间戳会让下一个调度 tick 立刻又把它降温。
        branch.lastAccessedAt = new Date().toISOString();
        schedulerService.markHot(slug);
        try {
          stateService.appendActivityLog(branch.projectId, {
            type: 'restart',
            branchId: slug,
            branchName: branch.branch,
            actor: 'scheduler',
            note: '预览访问自动唤醒（docker restart，未重建代码）',
          });
        } catch { /* activity log 是辅助手段，失败不影响主流程 */ }
        stateService.save();
      } else {
        branchOperationFinalStatus = 'failed';
        branch.status = 'error';
        branch.errorMessage = `${failed.length} 个容器自动唤醒失败：${failed.join(', ')}`;
        stateService.save();
      }
    } catch (err) {
      const superseded = (err as Error).name === 'BranchOperationSupersededError';
      branchOperationFinalStatus = superseded ? 'cancelled' : 'failed';
      // Superseded = a higher-priority op (manual deploy/restart) took over the
      // branch. It now owns the state machine, so we must NOT touch status here
      // (reverting would clobber the in-flight op, leaving persisted 'idle' while
      // services are actually 'starting'). Same handling as manual /restart.
      // Genuine failure: move starting→error + branch→error (NOT back to 'idle')
      // so the next visit shows the diagnostic page instead of re-triggering
      // auto-wake forever (idle + lastStopSource='scheduler' stays eligible).
      if (!superseded) {
        try {
          const fresh = stateService.getBranch(slug);
          if (fresh) {
            for (const svc of Object.values(fresh.services)) {
              if (svc.status === 'starting') svc.status = 'error';
            }
            if (fresh.status === 'restarting') {
              fresh.status = 'error';
              fresh.errorMessage = `预览自动唤醒异常：${(err as Error).message}`;
            }
            stateService.save();
          }
        } catch { /* 状态恢复尽力而为，不掩盖原始错误 */ }
        throw err;
      }
      // superseded: leave state to the new owner; swallow so the proxy doesn't
      // log a misleading "auto-wake failed".
    } finally {
      completeBackgroundBranchOperation(lease, branchOperationFinalStatus);
    }
  });
}

// ── Janitor (Phase 2 resilience) ──
// Enabled by default. Sweeps stale local containers/worktrees after a global
// expiry window. The retention window is capped at 7 days by product policy.
// See doc/design.cds-resilience.md Phase 2.
{
  const defaultJanitor = {
    enabled: true,
    worktreeTTLDays: 7,
    diskWarnPercent: 80,
    sweepIntervalSeconds: 3600,
  };
  if (!config.janitor) {
    config.janitor = { ...defaultJanitor };
  } else {
    config.janitor = {
      ...defaultJanitor,
      ...config.janitor,
      worktreeTTLDays: Math.min(Math.max(Number(config.janitor.worktreeTTLDays) || 7, 1), 7),
    };
  }
  const janitorEnabledOverride = stateService.getJanitorEnabledOverride();
  if (janitorEnabledOverride !== undefined) {
    config.janitor.enabled = janitorEnabledOverride;
    console.log(`  [janitor] applying UI override: enabled=${janitorEnabledOverride}`);
  }
  const janitorTTLOverride = stateService.getJanitorWorktreeTTLOverride();
  if (janitorTTLOverride !== undefined) {
    config.janitor.worktreeTTLDays = Math.min(Math.max(janitorTTLOverride, 1), 7);
    console.log(`  [janitor] applying UI override: worktreeTTLDays=${config.janitor.worktreeTTLDays}`);
  }
}
const janitorService = new JanitorService(
  stateService,
  config.janitor,
  config.worktreeBase,
);
// ── AutoLifecycle (项目级 N 分钟自动切发布版；自动停止交给系统级 Scheduler) ──
// 与 SchedulerService 正交：那个按访问时间降温，这个按"部署完成时间"处理。
// 默认开（项目里两个字段都不配就自动 no-op）。tick 30s 一拍。
const infraFlapWatchdog = new InfraFlapWatchdog(
  {
    shell,
    serverEventLogStore: activeServerEventLogStore,
    stateService,
  },
  {
    tickIntervalMs: Number(process.env.CDS_INFRA_FLAP_TICK_MS) || 60_000,
    restartDeltaThreshold: Number(process.env.CDS_INFRA_FLAP_THRESHOLD) || 5,
    windowMs: Number(process.env.CDS_INFRA_FLAP_WINDOW_MS) || 300_000,
  },
);

const autoLifecycleService = new AutoLifecycleService(
  {
    stateService,
    stopBranch: async (slug: string) => {
      const branch = stateService.getBranch(slug);
      if (!branch) return;
      const branchOperationLease = beginBackgroundBranchOperation({
        branchId: slug,
        kind: 'scheduler-cooling',
        trigger: 'auto-lifecycle',
        actor: 'auto-lifecycle',
        source: 'autoLifecycleService.stopBranch',
        reason: 'auto-lifecycle 自动停止（保留容器，可秒级唤醒）',
      });
      let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
      try {
      // 2026-05-14 Codex review P2：远端 stop 失败时要能回滚到 running，
      // 否则分支卡在 stopping，AutoLifecycleService.tick 的
      // `status==='running'` 过滤会永久跳过它、不再重试。先快照原状态。
      const prevBranchStatus = branch.status;
      const prevSvcStatus = new Map(
        Object.values(branch.services).map(s => [s.profileId, s.status] as const),
      );
      const restoreRunning = (): void => {
        branch.status = prevBranchStatus;
        for (const s of Object.values(branch.services)) {
          const prev = prevSvcStatus.get(s.profileId);
          if (prev) s.status = prev;
        }
        stateService.save();
      };
      branch.status = 'stopping';
      stateService.save();

      // 2026-05-14 Codex review P2 修复：cluster 部署下分支可能跑在远端
      // executor 上，master 本地没有它的容器。这里复刻手动 stop 路径的
      // /exec/stop 代理逻辑——否则 auto-stop/auto-publish 只停了 master
      // 本地的空壳，远端容器还在跑，下一个 heartbeat 又把状态报回 running。
      // `registry` 在模块下方构建（startup 同步执行完），tick 30s 才首次
      // 触发本回调，引用安全。
      const remoteExecutor =
        branch.executorId && registry
          ? registry.getAll().find(n => n.id === branch.executorId && n.role !== 'embedded')
          : null;
      // 2026-05-14 Codex review P2 "Retry when the owning executor is not
      // registered"：分支有 executorId 但 registry 里查不到（coordinator
      // 重启 / 漏 heartbeat）时，容器其实还在远端跑，本地 stop 是 no-op。
      // 此时**不能**走下面的本地 stop 把分支标 idle/cold（会让 auto-lifecycle
      // 误以为停成功、不再重试）。当作远端停止失败：回滚 + throw，下一拍
      // 等执行器重新注册后重试。
      if (branch.executorId && !remoteExecutor) {
        restoreRunning();
        throw new Error(`分支 ${slug} 归属执行器 ${branch.executorId} 当前未注册（可能 coordinator 刚重启或漏 heartbeat），稍后重试`);
      }
      if (remoteExecutor) {
        branchOperationLease?.assertCurrent('auto-lifecycle stop before remote stop');
        for (const svc of Object.values(branch.services)) {
          if (svc.status === 'running' || svc.status === 'starting') svc.status = 'stopping';
        }
        stateService.save();
        // 连接失败与"远端拒绝"分开处理，各自给准确错误信息，且不让
        // !ok 的 throw 被同一个 catch 二次包装成误导性的"无法连接"。
        let upstream: Awaited<ReturnType<typeof fetch>>;
        try {
          upstream = await fetch(`http://${remoteExecutor.host}:${remoteExecutor.port}/exec/stop`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(config.executorToken ? { 'X-Executor-Token': config.executorToken } : {}),
            },
            body: JSON.stringify({
              branchId: slug,
              operationId: branchOperationLease?.operationId || null,
              actor: 'auto-lifecycle',
              trigger: 'auto-lifecycle',
            }),
          });
        } catch (err) {
          // 执行器不可达：回滚到原 running 状态 + 抛出。caller
          // (applyAutoStop/applyAutoPublish) 不会 stamp 假成功，tick 下一拍
          // 因 status 仍是 running 会重试。
          restoreRunning();
          throw new Error(`无法连接远端执行器 ${remoteExecutor.id}: ${(err as Error).message}`);
        }
        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => '');
          restoreRunning();
          throw new Error(`远端执行器 ${remoteExecutor.id} 拒绝停止 (HTTP ${upstream.status}): ${errText.slice(0, 160)}`);
        }
        // 执行器下一次 heartbeat 会 reconcile，这里先设可信本地态。
        for (const svc of Object.values(branch.services)) svc.status = 'stopped';
        branch.status = 'idle';
        branch.heatState = 'cold';
        stateService.incrementBranchStat(slug, 'stopCount');
        branchOperationLease?.assertCurrent('auto-lifecycle stop before remote final save');
        stateService.save();
        return;
      }

      for (const svc of Object.values(branch.services)) {
        branchOperationLease?.assertCurrent(`auto-lifecycle stop before ${svc.profileId}`);
        if (svc.status === 'running' || svc.status === 'starting') {
          // 同 coolFn：先翻 stopping 再 await stop()，否则 auto-restart tick
          // 在 await 窗口会把主动停止误判为 crash 并 docker start 抢跑
          // （Cursor Bugbot High）。
          svc.status = 'stopping';
          try {
            await containerService.stop(svc.containerName, 'auto-lifecycle 自动停止（保留容器，可秒级唤醒）', {
              projectId: branch.projectId,
              branchId: branch.id,
              profileId: svc.profileId,
              operationId: branchOperationLease?.operationId || null,
              actor: 'auto-lifecycle',
              trigger: 'auto-lifecycle',
              operation: 'auto-lifecycle-stop',
              source: 'autoLifecycleService.stopBranch',
            });
          } catch (err) {
            console.warn(`[auto-lifecycle] stop(${svc.containerName}) failed: ${(err as Error).message}`);
          }
          svc.status = 'stopped';
        }
      }
      await archiveBranchContainerLogs({
        stateService,
        containerService,
        branch,
        source: 'auto-lifecycle-stop',
        serverEventLogStore: activeServerEventLogStore,
        message: 'captured after auto-lifecycle stop preserved containers',
        operationId: branchOperationLease?.operationId || null,
        actor: 'auto-lifecycle',
        trigger: 'auto-lifecycle',
      });
      branch.status = 'idle';
      // 2026-05-14 Cursor Bugbot review 修复：必须同步把 heatState 置 cold。
      // SchedulerService.getHotBranches() 只看 heatState==='hot'（或
      // heatState===undefined && status==='running'）。如果这里只改 status
      // 不改 heatState，调度器仍把这个已停的分支算进 maxHotBranches 容量，
      // 还会在下一 tick 重复 cool 它、写一条重复的 stop reason。
      branch.heatState = 'cold';
      stateService.incrementBranchStat(slug, 'stopCount');
      branchOperationLease?.assertCurrent('auto-lifecycle stop before final save');
      stateService.save();
      } catch (err) {
        branchOperationFinalStatus = 'failed';
        throw err;
      } finally {
        completeBackgroundBranchOperation(branchOperationLease, branchOperationFinalStatus);
      }
    },
    beginAutoPublishOperation: (slug: string) => {
      const lease = beginBackgroundBranchOperation({
        branchId: slug,
        kind: 'auto-lifecycle-redeploy',
        trigger: 'auto-lifecycle',
        actor: 'auto-lifecycle',
        source: 'autoLifecycleService.applyAutoPublish',
        reason: 'auto-lifecycle 写入发布版 override 并触发重部署',
      });
      if (!lease) return null;
      return {
        operationId: lease.operationId,
        assertCurrent: (step?: string) => lease.assertCurrent(step),
        complete: (status, error) => completeBackgroundBranchOperation(lease, status, error),
      };
    },
    // 2026-05-14 用户决策：auto-publish 必须全自动「停源码 → 重建发布版」，
    // 不靠懒唤醒（懒唤醒路径 index.ts 用 raw profile 不 resolve override）。
    // 复用 webhook dispatcher 同款"内部 HTTP 自调 /deploy"机制：deploy 路由
    // 会走 resolveEffectiveProfile，override 已是 release → 重建成发布版。
    // 不动核心热路径。X-CDS-Trigger=auto-lifecycle 让活动日志能区分来源。
    redeployBranch: async (slug: string) => {
      const url = `http://127.0.0.1:${config.masterPort}/api/branches/${encodeURIComponent(slug)}/deploy`;
      // 2026-05-14 Codex review P2 "Include source project headers"：开了
      // auth 时 X-CDS-Internal 走 loopback bypass guard，branch 级
      // /deploy 要求能解析出源 project，否则 403 source-project-unresolved。
      // 复刻 webhook dispatcher 的 sourceHeadersForBranch 逻辑。
      const srcBranch = stateService.getBranch(slug);
      // 2026-05-14 Cursor Bugbot Medium 修复：SSE 读循环必须有总超时。
      // 否则 deploy 端只发进度事件、永不发 complete/error 也不关连接时，
      // for(;;) reader.read() 永久阻塞；tick() 全程持 this.running，之后
      // 每个 setInterval tick 都在 `if (this.running) return` 处空转，
      // 整个 AutoLifecycleService 对所有项目永久瘫痪直到进程重启。
      // 用 AbortController + 硬总时限兜底（真实部署 pull+build+就绪极少
      // 超 20min；超了就回滚 override，下一拍重试，绝不卡死全局）。
      const REDEPLOY_DEADLINE_MS = 20 * 60 * 1000;
      const ac = new AbortController();
      const deadline = setTimeout(() => ac.abort(), REDEPLOY_DEADLINE_MS);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-CDS-Internal': '1',
            'X-CDS-Trigger': 'auto-lifecycle',
            'X-CDS-Source-Branch-Id': slug,
            ...(srcBranch?.projectId ? { 'X-CDS-Source-Project-Id': srcBranch.projectId } : {}),
          },
          body: JSON.stringify({}),
          signal: ac.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`auto-publish 重部署 ${slug} 失败: HTTP ${res.status} ${body.slice(0, 160)}`);
        }
        // 2026-05-14 Codex review P2 "Await the deploy stream"：deploy 是 SSE，
        // fetch 在响应头就 resolve，pull/build/readiness 失败都在流后续才发。
        // 必须把流读到终态事件再判定成败，否则 redeploy 提前返回成功、后续
        // 部署失败无法触发 applyAutoPublish 的 override 回滚。
        // 终态契约（branches.ts /deploy 路由）：
        //   event: error    → 硬失败（抛异常路径）
        //   event: complete → 跑完；优先读权威 ok，缺省回退 services 推导
        //   流结束但无 complete/error → 视为未完成（失败）
        if (!res.body || typeof (res.body as { getReader?: unknown }).getReader !== 'function') {
          throw new Error(`auto-publish 重部署 ${slug}：响应无 SSE body，无法确认部署结果`);
        }
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let terminal: { ok: boolean; message: string } | null = null;
        const parseBlock = (block: string): void => {
          let evName = 'message';
          let dataRaw = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) evName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataRaw += line.slice(5).trim();
          }
          if (evName === 'error') {
            let msg = '部署失败';
            try { msg = (JSON.parse(dataRaw) as { message?: string }).message || msg; } catch { /* keep default */ }
            terminal = { ok: false, message: msg };
          } else if (evName === 'complete') {
            // 2026-05-14 Codex review P2：直接读路由下发的权威 ok（路由基于
            // activeServices 算出，已剔除已删除/僵尸 profile）。不再用全量
            // services 重新推导，避免僵尸服务误判失败。无 ok 字段（旧路由）
            // 才回退到 services 推导兜底。
            let parsed: { ok?: boolean; services?: Record<string, { status?: string }>; message?: string } = {};
            try { parsed = JSON.parse(dataRaw) as typeof parsed; } catch { /* unparseable → fail below */ }
            const msg = parsed.message || '';
            if (typeof parsed.ok === 'boolean') {
              terminal = parsed.ok
                ? { ok: true, message: msg || '部署完成' }
                : { ok: false, message: msg || '部署失败' };
            } else {
              const services = parsed.services || {};
              const failed = Object.entries(services)
                .filter(([, s]) => s?.status !== 'running')
                .map(([pid]) => pid);
              terminal = failed.length === 0 && Object.keys(services).length > 0
                ? { ok: true, message: msg || '部署完成' }
                : { ok: false, message: `部署完成但有服务未就绪: ${failed.join(', ') || '无 running 服务'}` };
            }
          }
        };
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (value) {
              buf += decoder.decode(value, { stream: true });
              let idx: number;
              while ((idx = buf.indexOf('\n\n')) !== -1) {
                parseBlock(buf.slice(0, idx));
                buf = buf.slice(idx + 2);
              }
            }
            if (done) break;
          }
          if (buf.trim()) parseBlock(buf);
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }
        if (!terminal) {
          throw new Error(`auto-publish 重部署 ${slug}：SSE 流结束但未收到 complete/error 终态事件`);
        }
        if (!(terminal as { ok: boolean }).ok) {
          throw new Error(`auto-publish 重部署 ${slug} 失败: ${(terminal as { message: string }).message}`);
        }
      } catch (err) {
        if (ac.signal.aborted) {
          throw new Error(`auto-publish 重部署 ${slug} 超时（>${REDEPLOY_DEADLINE_MS / 60000}min 未出终态），已中止；override 将回滚，下一拍重试`);
        }
        throw err;
      } finally {
        clearTimeout(deadline);
      }
    },
  },
  { tickIntervalSeconds: 30, enabled: true },
);

janitorService.setRemoveFn(async (slug: string) => {
  // Reuse the existing removal path: stop containers → git worktree remove → drop state.
  const branch = stateService.getBranch(slug);
  if (!branch) return;
  const branchOperationLease = beginBackgroundBranchOperation({
    branchId: slug,
    kind: 'janitor-remove',
    trigger: 'janitor',
    actor: 'janitor',
    source: 'janitorService.setRemoveFn',
    reason: 'Janitor 自动回收：超过保留期或磁盘清理',
  });
  let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
  try {
  // janitor 回收前先留痕，否则用户看到分支整个消失却无任何记录。
  try {
    stateService.appendActivityLog(branch.projectId, {
      type: 'branch-deleted',
      branchId: branch.id,
      branchName: branch.branch,
      actor: 'janitor',
      note: 'Janitor 自动回收：停止容器并移除 worktree（超过保留期 / 磁盘清理）',
    });
  } catch { /* activity log 是辅助手段，失败不影响主流程 */ }
  for (const svc of Object.values(branch.services)) {
    branchOperationLease?.assertCurrent(`janitor remove before ${svc.profileId}`);
    try {
      await containerService.remove(svc.containerName, {
        projectId: branch.projectId,
        branchId: branch.id,
        profileId: svc.profileId,
        operationId: branchOperationLease?.operationId || null,
        actor: 'janitor',
        trigger: 'janitor',
        operation: 'janitor-remove',
        source: 'janitorService.setRemoveFn',
        reason: 'Janitor 自动回收：超过保留期或磁盘清理',
      });
    } catch { /* best effort */ }
  }
  try {
    const repoRoot = stateService.getProjectRepoRoot(branch.projectId, config.repoRoot);
    await worktreeService.remove(repoRoot, branch.worktreePath);
  } catch { /* best effort */ }
  branchOperationLease?.assertCurrent('janitor remove before state delete');
  stateService.removeBranch(slug);
  stateService.save();
  } catch (err) {
    branchOperationFinalStatus = 'failed';
    throw err;
  } finally {
    completeBackgroundBranchOperation(branchOperationLease, branchOperationFinalStatus);
  }
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
      // Phase 2 fix: discoverInfraContainers 现在用 containerName 当 key
      // (跨项目唯一);老的按 svc.id 查会撞 — project A 和 B 都有 'mongodb'
      const found = discovered.get(svc.containerName);
      if (found) {
        // Container exists in Docker — sync status
        svc.status = found.running ? 'running' : 'stopped';
        discovered.delete(svc.containerName);
      } else if (svc.status === 'running') {
        // State says running but container is gone — try to recreate
        console.log(`  [infra] Recreating missing container for ${svc.id}...`);
        try {
          // Phase 1: 传入项目 customEnv 让 ${VAR} 展开生效
          await containerService.startInfraService(svc, stateService.getCustomEnv(svc.projectId));
          svc.status = 'running';
          svc.errorMessage = undefined;
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
          // Docker "running" only means PID 1 is alive. It does not prove the
          // mapped service port is ready; build-mode containers can spend
          // minutes in pnpm install/vite build while Docker still reports
          // running. Never promote an error/in-flight service to running here,
          // or startup reconcile can erase a real readiness failure.
          const wasStatus = svc.status;
          if (found.running) {
            if (wasStatus === 'running') {
              svc.status = 'running';
            } else {
              activeServerEventLogStore?.record({
                category: 'container',
                severity: wasStatus === 'error' ? 'warn' : 'info',
                source: 'startup-reconcile',
                action: 'app.reconcile.running-not-ready-authority',
                message: `Docker container is running but service state remains ${wasStatus}: ${svc.containerName}`,
                projectId: branch.projectId,
                branchId: branch.id,
                profileId,
                containerName: svc.containerName,
                status: wasStatus,
                details: {
                  dockerState: 'running',
                  preservedStatus: wasStatus,
                  reason: 'container-running-is-not-service-ready',
                },
              });
            }
          } else if (wasStatus === 'running' || wasStatus === 'starting') {
            // 持久态认为在跑但容器已退出 → 真·异常退出，标 error
            activeServerEventLogStore?.record({
              category: 'container',
              severity: 'error',
              source: 'startup-reconcile',
              action: 'app.reconcile.exited',
              message: `state says ${wasStatus} but Docker container is not running: ${svc.containerName}`,
              projectId: branch.projectId,
              branchId: branch.id,
              profileId,
              containerName: svc.containerName,
              status: 'stopped',
              details: {
                previousStatus: wasStatus,
                nextStatus: 'error',
                reason: 'exited-container-on-startup',
              },
            });
            svc.status = 'error';
            svc.errorMessage = '容器异常退出，疑似崩溃，需重新部署';
          } else if (wasStatus === 'error') {
            // 已知失败态(auto-restart 耗尽 / 部署失败)不得在重启后被降级为
            // stopped，否则失败看起来像正常停止，没人去 redeploy。保持 error
            // 且保留原 errorMessage（Cursor Bugbot Medium）。
            svc.status = 'error';
          } else {
            // stop() 重构后主动停止保留容器(exited)：CDS 进程重启后 boot
            // reconcile 不得把"被用户/调度器/auto-lifecycle 主动停掉"的分支
            // 误标 error。退出且持久态为 stopped/idle/stopping 等 → 归一为
            // stopped（Cursor Bugbot Medium）。
            svc.status = 'stopped';
          }
          if (wasStatus !== svc.status) appReconciled++;
          appContainers.delete(key);
        } else if (svc.status === 'running') {
          // State says running but container is gone
          activeServerEventLogStore?.record({
            category: 'container',
            severity: 'error',
            source: 'startup-reconcile',
            action: 'app.reconcile.missing',
            message: `state says running but Docker container is missing: ${svc.containerName}`,
            projectId: branch.projectId,
            branchId: branch.id,
            profileId,
            containerName: svc.containerName,
            details: {
              previousStatus: svc.status,
              nextStatus: 'error',
              reason: 'missing-container-on-startup',
            },
          });
          svc.status = 'error';
          svc.errorMessage = '容器已丢失，需重新部署';
          appReconciled++;
        }
      }
    }

    // Log orphan app containers
    for (const [key, info] of appContainers) {
      console.warn(`  [app] Orphan container detected: ${info.containerName} (${key}). Not managed by current state.`);
      activeServerEventLogStore?.record({
        category: 'container',
        severity: 'warn',
        source: 'startup-reconcile',
        action: 'app.reconcile.orphan',
        message: `Docker container exists but is not managed by current state: ${info.containerName}`,
        branchId: info.branchId,
        profileId: info.profileId,
        containerName: info.containerName,
        status: info.running ? 'running' : 'stopped',
        details: { key, reason: 'orphan-container-on-startup' },
      });
    }

    let branchStatusReconciled = 0;
    for (const branch of stateService.getAllBranches()) {
      const result = reconcileBranchStatusFromServices(branch);
      if (!result.changed) continue;
      branchStatusReconciled++;
      activeServerEventLogStore?.record({
        category: 'system',
        severity: result.nextStatus === 'error' ? 'warn' : 'info',
        source: 'startup-reconcile',
        action: 'branch.reconcile.status-derived',
        message: `Branch ${branch.id} status reconciled from services: ${result.previousStatus} -> ${result.nextStatus}`,
        projectId: branch.projectId,
        branchId: branch.id,
        details: {
          previousStatus: result.previousStatus,
          nextStatus: result.nextStatus,
          reason: 'derive-branch-status-from-service-statuses',
          serviceStatuses: Object.fromEntries(
            Object.entries(branch.services || {}).map(([profileId, svc]) => [profileId, svc.status]),
          ),
        },
      });
    }

    if (appReconciled > 0 || branchStatusReconciled > 0) {
      console.log(`  [app] Reconciled ${appReconciled} app container(s), ${branchStatusReconciled} branch status(es)`);
      stateService.save();
    }

    const staleDispatches = reconcileStaleDeployDispatches(stateService, {
      source: 'startup-reconcile',
      serverEventLogStore: activeServerEventLogStore,
    });
    if (staleDispatches.length > 0) {
      console.warn(`  [app] Converged ${staleDispatches.length} stale webhook deploy dispatch state(s) to interrupted`);
    }
    dispatchRecoveredWebhookDeploys(stateService, activeServerEventLogStore, staleDispatches, 'startup-reconcile');

    // ── #551 (c)(d) 终态收敛 ──
    //
    // 启动时把上次进程没跑完留下的 in-flight 分支状态（building / starting /
    // restarting / stopping）显式收敛成 'error'。否则 SSE 写崩、CLI 中断
    // (IncompleteRead)、CDS 进程被 kill -9 等场景会让 branch.status 永远停在
    // 'building'，前端轮询/Dashboard 无法判断"还在跑"还是"早就死了"，且
    // history logs 也是空（opLog 在中途被吞，没机会 appendLog）。
    //
    // 这里提供清晰的 errorMessage 让用户和 Agent 知道："上一次构建被 CDS
    // 重启中断，请重新部署"。重新 deploy 会把 errorMessage 清空（branches.ts
    // 的 deploy 端点头部有 entry.errorMessage = undefined），无副作用。
    //
    // 仅扫一次（启动期），与 reconcile 容器状态那段并行处理；不影响热路径。
    let staleInFlight = 0;
    let recoveredInFlight = 0;
    const IN_FLIGHT_STATES = new Set(['building', 'starting', 'restarting', 'stopping']);
    for (const branch of stateService.getAllBranches()) {
      const recoverableInterruptedError =
        branch.status === 'error'
        && typeof branch.errorMessage === 'string'
        && branch.errorMessage.includes('CDS 重启时上一次部署任务');
      if (IN_FLIGHT_STATES.has(branch.status) || recoverableInterruptedError) {
        const prev = branch.status;
        const serviceStatuses = Object.values(branch.services || {}).map((svc) => svc.status);
        const hasRunningService = serviceStatuses.some((status) => status === 'running');
        const hasStartingService = serviceStatuses.some((status) => status === 'starting' || status === 'building' || status === 'restarting');
        if (hasRunningService && !hasStartingService) {
          branch.status = 'running';
          branch.errorMessage = undefined;
          branch.lastReadyAt = branch.lastReadyAt || new Date().toISOString();
          recoveredInFlight++;
          activeServerEventLogStore?.record({
            category: 'system',
            severity: 'info',
            source: 'startup-reconcile',
            action: 'branch.reconcile.inflight-recovered',
            message: `Branch ${branch.id} recovered from stale in-flight status=${prev}; services are already running`,
            projectId: branch.projectId,
            branchId: branch.id,
            details: {
              previousStatus: prev,
              serviceStatuses,
              reason: 'running services are authoritative after CDS restart',
            },
          });
          continue;
        }
        branch.status = 'error';
        branch.errorMessage = `CDS 重启时上一次部署任务（status=${prev}）被中断；请重新部署。`;
        // 同步把 services 里同样停滞的状态收敛成 error，便于 UI 渲染。
        for (const svc of Object.values(branch.services)) {
          if (IN_FLIGHT_STATES.has(svc.status)) {
            svc.status = 'error';
            if (!svc.errorMessage) svc.errorMessage = '上一次部署被 CDS 重启中断';
          }
        }
        await archiveBranchContainerLogs({
          stateService,
          containerService,
          branch,
          source: 'boot-reconcile',
          serverEventLogStore: activeServerEventLogStore,
          message: `captured when CDS boot reconciled stale in-flight status=${prev}`,
        });
        staleInFlight++;
      }
    }
    if (staleInFlight > 0) {
      console.warn(
        `  [boot] Converged ${staleInFlight} stale in-flight branch(es) (status=building/starting/restarting/stopping → error). ` +
        '这些分支需要重新部署。',
      );
      stateService.save();
    }
    if (recoveredInFlight > 0) {
      console.log(`  [boot] Recovered ${recoveredInFlight} stale in-flight branch(es) because services were already running.`);
      stateService.save();
    }
  } catch (err) {
    console.error('  [infra] Discovery failed:', (err as Error).message);
  }

  // Start warm-pool scheduler after reconciliation so initial heat states
  // reflect real container state. No-op when scheduler is disabled.
  // On startup, branches with status='running' and no heatState get marked hot.
  //
  // ── Bug P fix(2026-05-10) auto-restart loop ──
  // 每 30 秒扫一次 app + infra 容器,发现 state.status=='running' 但 docker 实际
  // 不 running 的 → 触发 docker start(轻量重启,保留 volume / env)。失败时按
  // exponential backoff 重试,3 次都失败后标 service.status='error' + 写 errorMessage,
  // 不再继续打。重启计数存内存 Map(restartAttempts),CDS 重启清零(可接受 — 最坏
  // 多 retry 一次)。
  // 核心场景:noHttp:true 之前没 fallback TCP 探测 → service 标 stopped 但 cds
  // 一直认为它该 running,需要人工干预。Bug G 同步修了 fallback,这里做兜底。
  const restartAttempts = new Map<string, { count: number; nextAtMs: number }>();
  // 2026-05-28 追加:跟踪每个 service 上次成功启动的时间戳。
  // 用于识别 "docker start 成功但容器内部立刻崩溃" 的 crash loop(minio 典型):
  //   start 成功 → restartAttempts.delete → 5s 后容器死 → 下次 tick start 又成功
  //   → 永远跑,占用 docker daemon + master event loop。
  // 修法:start 后记 timestamp,下次该 service 再触发 auto-restart 时,
  // 若距上次 < SOFT_FAIL_WINDOW_MS,计入 soft-fail 累加器,达到上限后标 error 停。
  const lastSuccessfulStartMs = new Map<string, number>();
  const SOFT_FAIL_WINDOW_MS = 60_000; // 启动后 60s 内再死 = 真在 crash loop
  let autoRestartHandle: NodeJS.Timeout | null = null;
  function startAutoRestartLoop(): void {
    if (autoRestartHandle) return;
    autoRestartHandle = setInterval(() => {
      void runAutoRestartTick().catch((err) => {
        console.error('[auto-restart] tick failed:', (err as Error).message);
      });
    }, 30_000);
    if (typeof autoRestartHandle.unref === 'function') autoRestartHandle.unref();
    console.log('[auto-restart] loop started (30s tick)');
  }
  function stopAutoRestartLoop(): void {
    if (autoRestartHandle) {
      clearInterval(autoRestartHandle);
      autoRestartHandle = null;
    }
  }
  async function runAutoRestartTick(): Promise<void> {
    const now = Date.now();
    const MAX_RETRIES = 3;
    const BASE_BACKOFF_MS = 30_000; // 30s, 60s, 120s
    // 崩溃留痕按"分支"去重，本 tick 内一个分支只记一次 stopCount /
    // lastStop* / 活动日志，与其它停止路径（手动 / scheduler / executor /
    // auto-lifecycle 均为 once-per-branch）保持一致；docker start 重试仍
    // 按 service 进行（Cursor Bugbot：多服务同时崩溃会重复计数）。
    const crashRecordedThisTick = new Set<string>();

    // App 容器
    const appContainers = await containerService.discoverAppContainers();
    const branches = stateService.getAllBranches();
    for (const branch of branches) {
      for (const [profileId, svc] of Object.entries(branch.services)) {
        if (svc.status !== 'running') continue;
        const key = `${branch.id}/${profileId}`;
        const found = appContainers.get(key);
        if (found && found.running) continue;
        if (!found) continue; // 容器完全不存在 → 已是 error,不在本 loop 范围(走 redeploy)

        const attemptKey = `app:${key}`;
        const isNewCrash = !restartAttempts.has(attemptKey);
        const att = restartAttempts.get(attemptKey) || { count: 0, nextAtMs: 0 };
        // 容器自行退出（崩溃 / OOM / docker kill）首次被巡检发现：留痕，
        // 否则用户只看到分支变灰、"停止次数 0"、零日志（莫名其妙停止）。
        // 同一分支同一 tick 只记一次，避免多服务同崩重复计数 / 覆盖原因。
        if (isNewCrash && !crashRecordedThisTick.has(branch.id)) {
          crashRecordedThisTick.add(branch.id);
          const reason = `容器异常退出（docker 显示未运行），auto-restart 介入尝试拉起：${found.containerName}`;
          branch.lastStoppedAt = new Date().toISOString();
          branch.lastStopReason = reason;
          branch.lastStopSource = 'crash';
          stateService.incrementBranchStat(branch.id, 'stopCount');
          try {
            stateService.appendActivityLog(branch.projectId, {
              type: 'crash',
              branchId: branch.id,
              branchName: branch.branch,
              actor: 'auto-restart',
              note: reason,
            });
          } catch { /* activity log 是辅助手段，失败不影响主流程 */ }
          await archiveBranchContainerLogs({
            stateService,
            containerService,
            branch,
            source: 'crash-detected',
            profileIds: new Set([profileId]),
            serverEventLogStore: activeServerEventLogStore,
            message: reason,
          });
          stateService.save();
        }
        if (now < att.nextAtMs) continue;
        if (att.count >= MAX_RETRIES) {
          svc.status = 'error';
          svc.errorMessage = `auto-restart 已尝试 ${MAX_RETRIES} 次仍失败,请手动 redeploy 或查看容器日志(${found.containerName})`;
          try {
            stateService.appendActivityLog(branch.projectId, {
              type: 'deploy-failed',
              branchId: branch.id,
              branchName: branch.branch,
              actor: 'auto-restart',
              note: `auto-restart 重试 ${MAX_RETRIES} 次仍失败，已标记 error，请手动重新部署`,
            });
          } catch { /* 辅助 */ }
          stateService.save();
          continue;
        }
        let branchOperationLease: BranchOperationLease | null = null;
        let branchOperationFinalStatus: 'completed' | 'failed' | 'cancelled' = 'completed';
        try {
          branchOperationLease = beginBackgroundBranchOperation({
            branchId: branch.id,
            kind: 'auto-restart',
            trigger: 'system',
            actor: 'auto-restart',
            profileId,
            source: 'auto-restart.tick',
            reason: `容器异常退出后自动拉起：${found.containerName}`,
          });
        } catch (err) {
          activeServerEventLogStore?.record({
            category: 'container',
            severity: 'warn',
            source: 'auto-restart',
            action: 'app.auto-restart.skipped',
            message: `auto-restart skipped for ${found.containerName}: ${(err as Error).message}`,
            projectId: branch.projectId,
            branchId: branch.id,
            profileId,
            containerName: found.containerName,
            details: {
              attempt: att.count + 1,
              maxRetries: MAX_RETRIES,
              reason: 'branch-operation-busy',
              error: (err as Error).message,
            },
          });
          continue;
        }
        try {
          branchOperationLease?.assertCurrent(`auto-restart before docker start ${profileId}`);
          const startRes = await shell.exec(`docker start ${found.containerName}`);
          branchOperationLease?.assertCurrent(`auto-restart after docker start ${profileId}`);
          activeServerEventLogStore?.record({
            category: 'container',
            severity: startRes.exitCode === 0 ? 'info' : 'error',
            source: 'auto-restart',
            action: startRes.exitCode === 0 ? 'app.auto-restart.completed' : 'app.auto-restart.failed',
            message: `auto-restart docker start ${found.containerName} attempt ${att.count + 1}`,
            projectId: branch.projectId,
            branchId: branch.id,
            profileId,
            requestId: branchOperationLease?.request.requestId || null,
            operationId: branchOperationLease?.operationId || null,
            containerName: found.containerName,
            command: {
              name: 'docker start',
              exitCode: startRes.exitCode,
              stdoutPreview: startRes.stdout,
              stderrPreview: startRes.stderr,
            },
            details: {
              operationId: branchOperationLease?.operationId || null,
              attempt: att.count + 1,
              maxRetries: MAX_RETRIES,
              actor: 'auto-restart',
              trigger: 'system',
              source: 'auto-restart.tick',
            },
          });
          if (startRes.exitCode === 0) {
            console.log(`[auto-restart] app ${found.containerName} 已重启(attempt ${att.count + 1})`);
            restartAttempts.delete(attemptKey);
            try {
              stateService.appendActivityLog(branch.projectId, {
                type: 'restart',
                branchId: branch.id,
                branchName: branch.branch,
                actor: 'auto-restart',
                note: `容器异常退出后由 auto-restart 自动拉起成功（第 ${att.count + 1} 次尝试）：${found.containerName}`,
              });
            } catch { /* 辅助 */ }
            branchOperationLease?.assertCurrent(`auto-restart before final save ${profileId}`);
            stateService.save();
          } else {
            branchOperationFinalStatus = 'failed';
            att.count += 1;
            att.nextAtMs = now + BASE_BACKOFF_MS * Math.pow(2, att.count - 1);
            restartAttempts.set(attemptKey, att);
            console.warn(
              `[auto-restart] app ${found.containerName} 第 ${att.count}/${MAX_RETRIES} 次重启失败:${(startRes.stderr || startRes.stdout || '').slice(0, 120)}`,
            );
          }
        } catch (err) {
          if ((err as Error).name === 'BranchOperationSupersededError') {
            branchOperationFinalStatus = 'cancelled';
            activeServerEventLogStore?.record({
              category: 'container',
              severity: 'warn',
              source: 'auto-restart',
              action: 'app.auto-restart.cancelled',
              message: `auto-restart cancelled for ${found.containerName}: ${(err as Error).message}`,
              projectId: branch.projectId,
              branchId: branch.id,
              profileId,
              operationId: branchOperationLease?.operationId || null,
              containerName: found.containerName,
              details: {
                operationId: branchOperationLease?.operationId || null,
                reason: 'branch-operation-superseded',
                error: (err as Error).message,
              },
            });
          } else {
            branchOperationFinalStatus = 'failed';
            throw err;
          }
        } finally {
          completeBackgroundBranchOperation(branchOperationLease, branchOperationFinalStatus);
        }
      }
    }

    // Infra 容器
    const infraContainers = await containerService.discoverInfraContainers();
    for (const svc of stateService.getInfraServices()) {
      if (svc.status !== 'running') continue;
      const found = infraContainers.get(svc.containerName);
      if (found && found.running) {
        // 2026-05-28 真恢复检测:容器活着 + 距离上次启动 >= SOFT_FAIL_WINDOW_MS
        // 才视为真正恢复,清掉软失败计数。这之前一直保留 attempts,即使
        // crash-loop 期间 docker start 偶尔成功也不会洗白。
        const key = `infra:${svc.containerName}`;
        const lastSuccess = lastSuccessfulStartMs.get(key);
        if (lastSuccess && now - lastSuccess >= SOFT_FAIL_WINDOW_MS) {
          if (restartAttempts.has(key)) {
            console.log(`[auto-restart] infra ${svc.containerName} 已稳定存活 ${Math.round((now - lastSuccess) / 1000)}s,清除软失败计数`);
            restartAttempts.delete(key);
          }
          lastSuccessfulStartMs.delete(key);
        }
        continue;
      }
      if (!found) continue;

      const attemptKey = `infra:${svc.containerName}`;
      const att = restartAttempts.get(attemptKey) || { count: 0, nextAtMs: 0 };
      if (now < att.nextAtMs) continue;

      // 2026-05-28 软失败检测:如果上次 docker start 成功了不到 SOFT_FAIL_WINDOW_MS
      // 容器又死了,这是内部 crash loop(minio 凭密码 < 8 字符 / volume 权限 / 镜像
      // 自杀等),docker start 永远会成功但马上又死。计入 att.count 防止 30s 一次
      // 死循环占满 CPU。
      const lastSuccess = lastSuccessfulStartMs.get(attemptKey);
      if (lastSuccess && now - lastSuccess < SOFT_FAIL_WINDOW_MS) {
        att.count += 1;
        att.nextAtMs = now + BASE_BACKOFF_MS * Math.pow(2, att.count - 1);
        restartAttempts.set(attemptKey, att);
        console.warn(
          `[auto-restart] infra ${svc.containerName} 检测到 crash loop ` +
          `(启动后 ${Math.round((now - lastSuccess) / 1000)}s 内崩溃),` +
          `软失败计数 ${att.count}/${MAX_RETRIES}`,
        );
        // 不立刻 docker start,下次 tick 再说(给 backoff 时间)
        if (att.count >= MAX_RETRIES) {
          svc.status = 'error';
          svc.errorMessage = `auto-restart 检测到 crash loop:容器启动后短时间内反复崩溃,已停止重试。请检查容器日志(${svc.containerName}),常见原因:镜像 entrypoint 失败 / 环境变量缺失 / 卷权限错误`;
          stateService.save();
          lastSuccessfulStartMs.delete(attemptKey);
          activeServerEventLogStore?.record({
            category: 'container',
            severity: 'error',
            source: 'auto-restart',
            action: 'infra.auto-restart.crash-loop-detected',
            message: `infra ${svc.containerName} crash loop detected, auto-restart disabled`,
            projectId: svc.projectId,
            serviceId: svc.id,
            containerName: svc.containerName,
            details: { attempt: att.count, maxRetries: MAX_RETRIES, softFailWindowMs: SOFT_FAIL_WINDOW_MS },
          });
        }
        continue;
      }

      if (att.count >= MAX_RETRIES) {
        svc.status = 'error';
        svc.errorMessage = `auto-restart 已尝试 ${MAX_RETRIES} 次仍失败,请检查容器日志(${svc.containerName})`;
        stateService.save();
        continue;
      }
      const startRes = await shell.exec(`docker start ${svc.containerName}`);
      activeServerEventLogStore?.record({
        category: 'container',
        severity: startRes.exitCode === 0 ? 'info' : 'error',
        source: 'auto-restart',
        action: startRes.exitCode === 0 ? 'infra.auto-restart.completed' : 'infra.auto-restart.failed',
        message: `auto-restart docker start infra ${svc.containerName} attempt ${att.count + 1}`,
        projectId: svc.projectId,
        serviceId: svc.id,
        containerName: svc.containerName,
        command: {
          name: 'docker start',
          exitCode: startRes.exitCode,
          stdoutPreview: startRes.stdout,
          stderrPreview: startRes.stderr,
        },
        details: { attempt: att.count + 1, maxRetries: MAX_RETRIES },
      });
      if (startRes.exitCode === 0) {
        console.log(`[auto-restart] infra ${svc.containerName} 已重启(attempt ${att.count + 1})`);
        // 2026-05-28 修复:**不**清 restartAttempts。crash loop 场景下 docker start
        // 永远会返 exit 0(容器先 spawn 再内部崩),不能因为 spawn 成功就清零软失败
        // 计数 — 否则 soft-fail → start success → delete → soft-fail → ... 永远累积不到 MAX_RETRIES。
        // 只在下一 tick 看到容器存活 >= SOFT_FAIL_WINDOW_MS 才视为真"恢复",到时统一清。
        lastSuccessfulStartMs.set(attemptKey, now);
      } else {
        att.count += 1;
        att.nextAtMs = now + BASE_BACKOFF_MS * Math.pow(2, att.count - 1);
        restartAttempts.set(attemptKey, att);
        console.warn(
          `[auto-restart] infra ${svc.containerName} 第 ${att.count}/${MAX_RETRIES} 次重启失败:${(startRes.stderr || startRes.stdout || '').slice(0, 120)}`,
        );
      }
    }
  }

  // B'.2:standby 模式下**不**启动 scheduler/janitor。supervisor 调
  // /api/_internal/promote 后通过 onPromote hook 再启动。这避免双 daemon 同时
  // 写 mongo 状态(scheduler 会改 heatState、janitor 会移 worktree)。
  function startBackgroundServices(): void {
    dockerEventMonitor.start();
    void systemLogMonitor.start();
    if (schedulerService.isEnabled()) {
      for (const b of stateService.getAllBranches()) {
        if (b.heatState === undefined && b.status === 'running') {
          b.heatState = 'hot';
        }
      }
      stateService.save();
      schedulerService.start();
    }
    if (config.mode !== 'executor') {
      janitorService.start();
    } else {
      console.log('[janitor] skipped on executor node (cleanup decisions are coordinator-only)');
    }
    // 2026-05-14 Codex review P1 修复：auto-lifecycle 只能在协调者角色
    // （standalone / scheduler）跑。executor 是 worker 节点，集群共享 state
    // 时若每个 executor 都扫全部项目跑 auto-stop/publish，会把别的 executor
    // 拥有的分支也标 idle/cold（executor 侧 registry 没有 master 条目，
    // stopBranch 还会 fallback 到本地停）。lifecycle 决策必须集中在协调者。
    if (config.mode !== 'executor') {
      autoLifecycleService.start();
    } else {
      console.log('[auto-lifecycle] skipped on executor node (lifecycle decisions are coordinator-only)');
    }
    startAutoRestartLoop();
    // 2026-05-28:infra 容器 flap 熔断守卫。每 60s 扫 RestartCount,5 分钟内
    // delta ≥ 5 → 自动 docker stop 打破 unless-stopped 循环。openvisual minio
    // 缺 cmd 灾难的根因防御。standalone / scheduler 角色启用,executor 跳过。
    if (config.mode !== 'executor') {
      infraFlapWatchdog.start();
    }
  }
  function stopBackgroundServices(): void {
    dockerEventMonitor.stop();
    systemLogMonitor.stop();
    schedulerService.stop();
    janitorService.stop();
    autoLifecycleService.stop();
    stopAutoRestartLoop();
    infraFlapWatchdog.stop();
    forwarderRoutePublisher?.stop();
    previewCanaryService?.stop();
  }

  startBackgroundServices();
})();

// Shut the scheduler/janitor down cleanly on process exit so background timers
// don't keep running orphaned.
// P4 Part 18 (D.2): graceful shutdown — flush the mongo write-behind
// chain before exit so the last few state mutations don't get lost
// sitting in the flush queue. Best-effort with a 3-second ceiling to
// avoid hanging the process if mongo is already unreachable.
//
// graceful-shutdown 接 SSE drain + worker abort + mongo flush。
// 本函数做 scheduler/janitor.stop() + mongo close 收尾。
async function closeHttpServerForShutdown(server: http.Server | null, label: string): Promise<void> {
  if (!server || !server.listening) return;
  try {
    await Promise.race([
      new Promise<void>((resolve) => server.close(() => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
    console.log(`[shutdown] ${label} listener closed`);
  } catch (err) {
    console.warn(`[shutdown] ${label} listener close failed: ${(err as Error).message}`);
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[shutdown] received ${signal}, stopping services...`);
  branchOperationCoordinator.interruptAll(`CDS process is shutting down (${signal})`, 'process.shutdown');
  if (masterMemoryMonitor) clearInterval(masterMemoryMonitor);
  if (staleDeployDispatchReconciler) clearInterval(staleDeployDispatchReconciler);
  dockerEventMonitor.stop();
  systemLogMonitor.stop();
  schedulerService.stop();
  janitorService.stop();
  forwarderRoutePublisher?.stop();
  previewCanaryService?.stop();
  // 2026-05-14 Cursor Bugbot Medium 修复：shutdown() 直接逐个 stop，
  // 漏了 autoLifecycleService.stop()（stopBackgroundServices 里有，但
  // 信号处理走的是本函数）。否则 graceful shutdown 期间 auto-lifecycle
  // 的 setInterval 还在跑，可能在 mongo flush/close 时触发停容器/重部署。
  autoLifecycleService.stop();
  try {
    const pendingWritesPath = path.join(config.repoRoot, 'cds', '.cds', 'pending-writes.json');
    const snap = await gracefulShutdownController.runShutdown({
      signal: signal === 'SIGTERM' ? 'SIGTERM' : signal === 'SIGINT' ? 'SIGINT' : 'manual',
      httpServer: dashboardHttpServer ?? undefined,
      pendingWritesPath,
      onForceKill: (s) => console.error('[shutdown] forced kill snapshot:', JSON.stringify(s)),
    });
    console.log(
      `[shutdown] drain done sse=${snap.sseClosed} runs=${snap.runsCompleted} interrupted=${snap.runsInterrupted.length} forced=${snap.forcedKill} duration=${snap.durationMs}ms`,
    );
  } catch (err) {
    console.warn(`[shutdown] graceful drain failed: ${(err as Error).message}`);
  }
  await closeHttpServerForShutdown(workerHttpServer, 'worker');
  if (activeMongoHandle) {
    try {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('shutdown flush timeout')), 3000),
      );
      await Promise.race([
        (async () => {
          const store = stateService.getBackingStore();
          if ((store.kind === 'mongo' || store.kind === 'mongo-split') && 'flush' in store && typeof (store as any).flush === 'function') {
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
  if (activeHttpLogStore) {
    try {
      await activeHttpLogStore.close();
      console.log('[shutdown] http log store flushed + closed');
    } catch (err) {
      console.warn(`[shutdown] http log store teardown failed: ${(err as Error).message}`);
    }
  }
  if (activeServerEventLogStore) {
    try {
      await activeServerEventLogStore.close();
      console.log('[shutdown] server event log store flushed + closed');
    } catch (err) {
      console.warn(`[shutdown] server event log store teardown failed: ${(err as Error).message}`);
    }
  }
  process.exit(signal === 'SIGINT' ? 130 : 0);
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
interface BranchGoneLivePreview {
  slug: string;
  branch: string;
  previewSlug: string;
  url: string | null;
  matchPercent: number;
}

function buildBranchGonePageHtml(slug: string, opts: { dashboardUrl?: string; mainDomain?: string; liveBranches?: BranchGoneLivePreview[] }): string {
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
    ? `<div class="section-title">最匹配可用预览（${live.length}）</div><div class="live-list">${live.map(b => {
        const safe = escape(b.previewSlug || b.slug);
        const branch = escape(b.branch || b.slug);
        const score = `${Math.max(0, Math.min(100, b.matchPercent || 0))}%`;
        const content = `<span class="live-main"><span class="live-host">${safe}</span><span class="live-branch">${branch}</span></span><span class="match-badge">匹配 ${score}</span>`;
        return b.url
          ? `<a class="live-item" href="${escape(b.url)}">${content}</a>`
          : `<div class="live-item disabled">${content}</div>`;
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
<title>启动失败 — ${escape(slug)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{max-width:520px;width:100%;padding:32px;background:#161b22;border:1px solid #30363d;border-radius:12px;text-align:center}
h2{font-size:18px;font-weight:600;color:#f0f6fc;margin-bottom:8px}
.branch{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;color:#f85149;background:#2a0d11;border:1px solid #5a1d1d;padding:4px 10px;border-radius:4px;margin-bottom:16px;display:inline-block;word-break:break-all}
.desc{font-size:13px;color:#8b949e;line-height:1.6;margin-bottom:20px}
.section-title{font-size:12px;color:#8b949e;text-align:left;margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}
.live-list{display:flex;flex-direction:column;gap:4px;margin-bottom:20px;text-align:left}
.live-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;background:#0d1117;border:1px solid #21262d;border-radius:6px;color:#58a6ff;font-size:13px;font-family:ui-monospace,monospace;text-decoration:none;transition:border-color .15s}
.live-item:hover{border-color:#58a6ff}
.live-item.disabled{color:#6e7681;cursor:not-allowed}
.live-main{min-width:0;display:flex;flex-direction:column;gap:2px}
.live-host{overflow:hidden;text-overflow:ellipsis}
.live-branch{font-size:11px;color:#8b949e;overflow:hidden;text-overflow:ellipsis}
.match-badge{flex:0 0 auto;font-size:11px;color:#7ee787;background:rgba(35,134,54,.14);border:1px solid rgba(46,160,67,.35);border-radius:999px;padding:2px 8px}
.btn{display:inline-block;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;border:1px solid #30363d;color:#c9d1d9;background:#21262d;transition:background .15s}
.btn:hover{background:#30363d}
.btn.primary{background:#238636;border-color:#238636;color:#fff}
.btn.primary:hover{background:#2ea043}
.hint{font-size:11px;color:#6e7681;margin-top:16px}
</style>
</head><body>
<div class="card">
  <h2>启动失败</h2>
  <div class="branch">${escape(slug)}</div>
  <div class="desc">
    该分支已被删除、从未部署，或 CDS 没有找到可路由的运行环境。<br>
    这是不可自动恢复状态，请回到控制台重新部署或选择可用分支。
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
.shape-grid-bg{position:fixed;inset:0;width:100%;height:100%;border:0;display:block;pointer-events:none;opacity:.44}
.shape-grid-vignette{position:fixed;inset:0;pointer-events:none;background:radial-gradient(900px 620px at 24% 18%,rgba(255,255,255,.08),transparent 60%),radial-gradient(circle at center,transparent 0%,rgba(0,0,0,.2) 56%,rgba(0,0,0,.78) 100%)}
.card{position:relative;z-index:1;background:linear-gradient(180deg,rgba(18,22,27,.94),rgba(13,16,20,.9))!important;border-color:rgba(232,237,242,.15)!important;border-radius:28px!important;box-shadow:0 34px 110px rgba(0,0,0,.48),inset 0 1px 0 rgba(255,255,255,.05)!important}
.subtitle,.hint{color:rgba(232,237,242,.58)}
.branch-chip,.step,.log-box,.error-msg{position:relative;z-index:1}
body{--bg-card:#12161b;--bg-elevated:#1b2026;--bg-terminal:#07090b;--border:rgba(232,237,242,.15);--border-subtle:rgba(232,237,242,.1);--text-primary:#f5f7fa;--text-secondary:#dbe4ee;--text-muted:rgba(232,237,242,.58);--text-subtle:rgba(232,237,242,.42);--accent:#dfe6ec;--accent-bg:rgba(223,230,236,.12);background:linear-gradient(180deg,#050708 0%,#090d10 48%,#050606 100%);color:#dbe4ee;overflow:hidden}
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
<canvas class="shape-grid-bg" id="shapeGridBg" aria-hidden="true"></canvas>
<div class="shape-grid-vignette" aria-hidden="true"></div>
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
  var canvas=document.getElementById('shapeGridBg');
  if(!canvas) return;
  var ctx=canvas.getContext('2d');
  if(!ctx) return;
  var offset={x:0,y:0};
  var size=42;
  var reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function resize(){
    var d=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.floor(window.innerWidth*d));
    canvas.height=Math.max(1,Math.floor(window.innerHeight*d));
    canvas.style.width='100%';
    canvas.style.height='100%';
    ctx.setTransform(d,0,0,d,0,0);
  }
  function draw(){
    var w=window.innerWidth;
    var h=window.innerHeight;
    ctx.clearRect(0,0,w,h);
    if(!reduced){
      offset.x=(offset.x-.14+size)%size;
      offset.y=(offset.y-.14+size)%size;
    }
    var ox=((offset.x%size)+size)%size;
    var oy=((offset.y%size)+size)%size;
    ctx.strokeStyle='rgba(232,237,242,.085)';
    ctx.lineWidth=1;
    for(var x=-size+ox;x<w+size;x+=size){
      for(var y=-size+oy;y<h+size;y+=size){
        ctx.strokeRect(x,y,size,size);
      }
    }
    var gradient=ctx.createRadialGradient(w/2,h/2,0,w/2,h/2,Math.sqrt(w*w+h*h)/2);
    gradient.addColorStop(0,'rgba(0,0,0,0)');
    gradient.addColorStop(.75,'rgba(0,0,0,.16)');
    gradient.addColorStop(1,'rgba(0,0,0,.58)');
    ctx.fillStyle=gradient;
    ctx.fillRect(0,0,w,h);
    requestAnimationFrame(draw);
  }
  resize();
  window.addEventListener('resize',resize);
  requestAnimationFrame(draw);
}());
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
function liveBranchesForGonePage(host: string, targetSlug: string): BranchGoneLivePreview[] {
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
  const out: BranchGoneLivePreview[] = [];
  for (const [slug, b] of Object.entries(state.branches)) {
    if (b.status !== 'running' && b.status !== 'starting') continue;
    let url: string | null = null;
    let previewSlug = slug;
    if (previewHost && b.branch) {
      const project = b.projectId ? stateService.getProject(b.projectId) : undefined;
      const built = buildPreviewUrlForProject(previewHost, b.branch, project, b.projectId);
      if (built.previewSlug) previewSlug = built.previewSlug;
      if (built.url) url = built.url;
    }
    out.push({
      slug,
      branch: b.branch || slug,
      previewSlug,
      url,
      matchPercent: previewSlugMatchPercent(targetSlug, previewSlug, b.branch || slug),
    });
  }
  // Match first; recency breaks ties so users see the likeliest replacement.
  out.sort((a, b) => {
    if (b.matchPercent !== a.matchPercent) return b.matchPercent - a.matchPercent;
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
  const live = liveBranchesForGonePage(host, slug);
  const html = buildBranchGonePageHtml(slug, { dashboardUrl, mainDomain: config.mainDomain, liveBranches: live });
  res.writeHead(404, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(html);
}

// Preview requests must never create worktrees or containers. Containers may only
// be started by webhook dispatch, explicit dashboard deploy, or cdscli.
proxyService.setOnAutoBuild(async (branchSlug, req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const isSSE = url.searchParams.get('sse') === '1';
  const message = `预览访问不会自动启动容器。分支 "${branchSlug}" 只能通过 webhook、手动部署或 cdscli 启动。`;

  activeServerEventLogStore?.record({
    category: 'container',
    severity: 'warn',
    source: 'proxy-auto-build',
    action: 'app.auto-build.blocked.disabled',
    message,
    branchId: branchSlug,
    details: {
      requestedSlug: branchSlug,
      host: req.headers.host || null,
      url: req.url || null,
      sse: isSSE,
      reason: 'preview-auto-build-disabled',
    },
  });

  if (!isSSE) {
    serveBranchGonePage(branchSlug, req, res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: error\ndata: ${JSON.stringify({ code: 'preview_auto_build_disabled', message })}\n\n`);
  res.end();
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

function stateStorageLabel(): string {
  if (storageModeResolved === 'mongo-split') {
    return `MongoDB split (${storageModeContext.mongoDb}: cds_projects / cds_branches / cds_global_state)`;
  }
  if (storageModeResolved === 'mongo') {
    return `MongoDB (${storageModeContext.mongoDb}: cds_state)`;
  }
  if (storageModeResolved === 'auto-fallback-json') {
    return `state.json fallback (${stateFile})`;
  }
  return `state.json (${stateFile})`;
}

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
  janitorService,
  registry,
  getClusterStrategy: () => clusterStrategy,
  storageModeContext,
  stateFile,
  authStore: activeAuthStore,
  gracefulShutdown: gracefulShutdownController,
  httpLogStore: activeHttpLogStore,
  serverEventLogStore: activeServerEventLogStore,
  branchOperationCoordinator,
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
  opts: { force?: boolean; optional?: boolean; onServer?: (server: http.Server) => void } = {},
) {
  // 2026-05-28 keepalive 匹配修复 — nginx upstream `keepalive_timeout` 默认 60s,
  // Node `http.Server.keepAliveTimeout` 默认 **5s**。
  //
  // 场景:nginx 代理 → CDS,nginx 把 idle 连接保留进自己的 upstream 池(60s);
  //   - 5 秒后 Node 主动 FIN 这条 idle TCP socket
  //   - nginx 仍以为它能复用,把下条请求写过去 → recv() 返 ECONNRESET
  //   - nginx 上抛 502/400(SSE 场景观测到 400 比例 ≈ 50%)
  //
  // SSH 现场诊断证据(2026-05-28):
  //   - nginx upstream 单 backend,SSE 端点 200/400 严格交替 50%
  //   - `docker logs cds_nginx`:upstream prematurely closed connection / recv() failed (104)
  //   - 直连 master:9900 5/5 全 200(绕过 nginx pool 就好)
  //
  // 修复:Node keepAliveTimeout 必须**大于** nginx upstream idle timeout,
  // 这样 socket 总是由 nginx 先回收(它知道自己不再用),Node 不会先主动 RST。
  // Node 文档同时要求 headersTimeout >= keepAliveTimeout(否则 EBADF 风险)。
  const applyKeepAliveTimings = (s: http.Server): void => {
    // 65s > nginx 60s 上限,留 5s 余量
    s.keepAliveTimeout = 65_000;
    // 70s > keepAliveTimeout 5s,Node ≥ 18 文档要求
    s.headersTimeout = 70_000;
  };

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
      // 2026-05-07 timing 审视:盖戳 daemon ready,让 recordSelfUpdate 能算
      // 真实"用户感受到的等待" totalElapsedMs。详见 report.cds-self-update-timing-audit.md
      try { stateService.recordDaemonReady(); } catch { /* 不致命 */ }
      onSuccess();
    });
    // 2026-05-28: 给所有 listenWithRetry 的 server 统一应用 keepalive 超时,
    // 解决 nginx idle pool 比 Node 长导致的 stale-socket 50% 失败。
    applyKeepAliveTimings(s as http.Server);
    opts.onServer?.(s as http.Server);
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
    console.log(`  State store:   ${stateStorageLabel()}`);
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
    console.log(`  State store: ${stateStorageLabel()}`);
    console.log(`  Repo root:  ${config.repoRoot}`);
    console.log('');
  }, { force: true, onServer: (server) => { dashboardHttpServer = server; } });

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
  // 2026-05-08: 即使 CDS_USE_FORWARDER=1,master 也保留 workerPort 反代作为
  // compatibility fallback。forwarder 监听不同端口(默认 9090),无端口冲突。这样
  // bootstrap 阶段(forwarder 起来但 nginx 还没切 upstream)预览仍能从 master
  // 5500 提供;forwarder 死掉时也不会全量 502。defense in depth。
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
  }, { optional: true, onServer: (server) => { workerHttpServer = server; } });

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
    new HttpSnapshotFetcher(getCdsAiAccessKey()),
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
