import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createBranchRouter } from './routes/branches.js';
import { createCdsEventsRouter } from './routes/cds-events.js';
import { createOperatorConsoleRouter } from './routes/operator-console.js';
import { createBridgeRouter } from './routes/bridge.js';
import { createProjectsRouter, assertProjectAccess } from './routes/projects.js';
import { createPendingImportRouter } from './routes/pending-import.js';
import { createAccessRequestsRouter } from './routes/access-requests.js';
import { createProjectInfraResyncRouter } from './routes/project-infra-resync.js';
import { createProjectComposeRouter } from './routes/project-compose.js';
import { createProjectMigrationRouter } from './routes/project-migration.js';
import { createProjectStorageRouter } from './routes/project-storage.js';
import { createCacheRouter } from './routes/cache.js';
import { createScheduledJobsRouter } from './routes/scheduled-jobs.js';
import { createReportsRouter, createPublicReportShareRouter } from './routes/reports.js';
import { createPeerSyncRouter, createPeerSyncAdminRouter } from './routes/peer-sync.js';
import { createSnapshotsRouter } from './routes/snapshots.js';
import { createRemoteHostsRouter } from './routes/remote-hosts.js';
import { createReleasesRouter } from './routes/releases.js';
import { createCdsSystemConnectionsRouter } from './routes/cds-system-connections.js';
import { createCdsSystemTopologyRouter } from './routes/cds-system-topology.js';
import { createTopologyAggregator } from './services/topology-aggregator.js';
import { createInfraBackupRouter } from './routes/infra-backup.js';
import { createInfraDataRouter } from './routes/infra-data.js';
import { createLegacyCleanupRouter } from './routes/legacy-cleanup.js';
import { createStorageModeRouter, type StorageModeContext } from './routes/storage-mode.js';
import { createCommentTemplateRouter } from './routes/comment-template.js';
import { createGithubOAuthRouter } from './routes/github-oauth.js';
import { createGithubWebhookRouter } from './routes/github-webhook.js';
import { GitHubAppClient } from './services/github-app-client.js';
import { CheckRunRunner } from './services/check-run-runner.js';
import { resolveGitAuthEnv } from './services/git-auth-env.js';
import { createAuthRouter } from './routes/auth.js';
import { createAuthLocalRouter } from './routes/auth-local.js';
import { createWorkspacesRouter } from './routes/workspaces.js';
import { MemoryAuthStore } from './infra/auth-store/memory-store.js';
import type { AuthStore } from './infra/auth-store/memory-store.js';
import { GitHubOAuthClient } from './services/github-oauth-client.js';
import { AuthService } from './services/auth-service.js';
import { WorkspaceService } from './services/workspace-service.js';
import { createGithubAuthMiddleware } from './middleware/github-auth.js';
import { resolveActorFromRequest } from './services/actor-resolver.js';
import type { StateService } from './services/state.js';
import type { WorktreeService } from './services/worktree.js';
import type { ContainerService } from './services/container.js';
import type { ProxyService } from './services/proxy.js';
import type { BridgeService } from './services/bridge.js';
import type { SchedulerService } from './services/scheduler.js';
import type { JanitorService } from './services/janitor.js';
import type { CdsConfig, IShellExecutor } from './types.js';
import type { GracefulShutdownController } from './services/graceful-shutdown.js';
import {
  bodyPreviewFromUnknown,
  classifyHttpRequestKind,
  createBodyCapture,
  createRequestId,
  filterActiveHttpRequests,
  parseHttpLogLayer,
  parseHttpRequestKindValue,
  redactHeaders,
  type ActiveHttpRequestRecord,
  type HttpActiveRequestFilter,
  type HttpLogRecord,
  type HttpRequestKind,
  type HttpLogSink,
} from './services/http-log-store.js';
import type { ServerEventLogSink, ServerEventCategory, ServerEventSeverity } from './services/server-event-log-store.js';
import type { BranchOperationCoordinator } from './services/branch-operation-coordinator.js';
import { computeBundleFreshness } from './services/bundle-freshness.js';
import { readBundledCdsCliVersion } from './services/cdscli-version.js';
import { ScheduledJobService } from './services/scheduled-job-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getRemoteAddr(req: express.Request): string | undefined {
  return (req.headers['cf-connecting-ip'] as string)
    || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    || req.ip
    || req.socket?.remoteAddress;
}

function extractApiMutationContext(req: express.Request, deps: ServerDeps): {
  branchId?: string;
  projectId?: string;
  profileId?: string;
} {
  const branchMatch = req.path.match(/^\/branches\/([^/]+)/);
  const projectMatch = req.path.match(/^\/projects\/([^/]+)/);
  const profileMatch = req.path.match(/\/profiles\/([^/]+)/);
  const branchId = branchMatch ? decodeURIComponent(branchMatch[1]) : undefined;
  const stateBranch = branchId ? deps.stateService.getBranch(branchId) : undefined;
  const projectId =
    stateBranch?.projectId
    || (projectMatch ? decodeURIComponent(projectMatch[1]) : undefined)
    || (typeof req.body?.projectId === 'string' ? req.body.projectId : undefined)
    || (typeof req.query.project === 'string' ? req.query.project : undefined);
  const profileId =
    (profileMatch ? decodeURIComponent(profileMatch[1]) : undefined)
    || (typeof req.body?.profileId === 'string' ? req.body.profileId : undefined)
    || (typeof req.query.profileId === 'string' ? req.query.profileId : undefined);
  return { branchId, projectId, profileId };
}

function shouldAuditApiMutation(req: express.Request): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method.toUpperCase())) return false;
  if (req.path.startsWith('/bridge/heartbeat')) return false;
  if (req.path.startsWith('/bridge/navigate-requests/')) return false;
  if (req.path.startsWith('/bridge/handshake-requests/')) return false;
  if (req.path.startsWith('/bridge/check/')) return false;
  if (req.path === '/bridge/result') return false;
  return true;
}

function normalizeHttpLogPath(pathValue: string): string {
  const rawPath = (pathValue || '').split('?')[0] || '/';
  const segments = rawPath.split('/');
  const staticBranchRoutes = new Set(['stream', 'state-audit', 'cleanup-damaged-containers', 'cleanup-orphan-containers']);
  const staticExecutorRoutes = new Set(['register', 'capacity', 'dispatch']);
  return segments
    .map((segment, index) => {
      if (!segment) return segment;
      const decoded = decodeURIComponent(segment);
      if (segments[1] === 'api' && segments[2] === 'branches' && index === 3 && !staticBranchRoutes.has(decoded)) return ':branchId';
      if (segments[1] === 'api' && segments[2] === 'projects' && index === 3) return ':projectId';
      if (segments[1] === 'api' && segments[2] === 'executors' && index === 3 && !staticExecutorRoutes.has(decoded)) return ':executorId';
      if (/^[0-9a-f]{7,40}$/i.test(decoded)) return ':sha';
      if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(decoded)) return ':uuid';
      if (/^op_[A-Za-z0-9_-]+$/.test(decoded)) return ':operationId';
      if (/^[A-Za-z0-9_-]+-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+/.test(decoded)) return ':id';
      return decoded;
    })
    .join('/');
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

function isNoiseHttpLog(log: HttpLogRecord): boolean {
  const pathValue = (log.path || '').split('?')[0] || '/';
  const headers = log.request?.headers || {};
  if (headers['x-cds-poll'] === 'true') return true;
  if (pathValue === '/healthz' || pathValue === '/readyz' || pathValue === '/api/health') return true;
  if (pathValue === '/api/self-status/stream' || pathValue === '/api/branches/stream') return true;
  if (pathValue.startsWith('/api/bridge/')) return true;
  if (/^\/api\/projects\/[^/]+\/instances$/.test(pathValue)) return true;
  return false;
}

function summarizeSlowHttpLogs(logs: HttpLogRecord[]): Array<{
  endpoint: string;
  method: string;
  requestKind: HttpRequestKind;
  count: number;
  rps: number;
  windowMs: number;
  errorCount: number;
  errorRate: number;
  cacheHitCount: number;
  cacheHitRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  slowest: {
    ts: Date;
    requestId: string;
    status: number;
    durationMs: number;
    path: string;
    branchId?: string | null;
    profileId?: string | null;
  };
}> {
  const groups = new Map<string, {
    endpoint: string;
    method: string;
    requestKind: HttpRequestKind;
    durations: number[];
    errorCount: number;
    cacheHitCount: number;
    firstTs: number;
    lastTs: number;
    slowest: HttpLogRecord;
  }>();
  for (const log of logs) {
    const method = (log.method || 'GET').toUpperCase();
    const requestKind = log.requestKind || classifyHttpRequestKind({
      layer: log.layer,
      method,
      path: log.path,
      headers: log.request?.headers,
    });
    const endpoint = normalizeHttpLogPath(log.path);
    const key = `${requestKind} ${method} ${endpoint}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        endpoint,
        method,
        requestKind,
        durations: [log.durationMs],
        errorCount: log.status >= 400 ? 1 : 0,
        cacheHitCount: log.response?.headers?.['x-cds-cache'] === 'hit' ? 1 : 0,
        firstTs: new Date(log.ts).getTime(),
        lastTs: new Date(log.ts).getTime(),
        slowest: log,
      });
      continue;
    }
    existing.durations.push(log.durationMs);
    if (log.status >= 400) existing.errorCount += 1;
    if (log.response?.headers?.['x-cds-cache'] === 'hit') existing.cacheHitCount += 1;
    const ts = new Date(log.ts).getTime();
    if (Number.isFinite(ts)) {
      existing.firstTs = Math.min(existing.firstTs, ts);
      existing.lastTs = Math.max(existing.lastTs, ts);
    }
    if (log.durationMs > existing.slowest.durationMs) existing.slowest = log;
  }
  return [...groups.values()]
    .map((group) => {
      const sorted = [...group.durations].sort((a, b) => a - b);
      const count = sorted.length;
      const sum = sorted.reduce((acc, value) => acc + value, 0);
      const windowMs = Math.max(1000, group.lastTs - group.firstTs);
      return {
        endpoint: group.endpoint,
        method: group.method,
        requestKind: group.requestKind,
        count,
        rps: Number((count / (windowMs / 1000)).toFixed(3)),
        windowMs,
        errorCount: group.errorCount,
        errorRate: count > 0 ? group.errorCount / count : 0,
        cacheHitCount: group.cacheHitCount,
        cacheHitRate: count > 0 ? group.cacheHitCount / count : 0,
        avgMs: Math.round(sum / Math.max(1, count)),
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        maxMs: sorted[sorted.length - 1] || 0,
        slowest: {
          ts: group.slowest.ts,
          requestId: group.slowest.requestId,
          status: group.slowest.status,
          durationMs: group.slowest.durationMs,
          path: group.slowest.path,
          branchId: group.slowest.branchId,
          profileId: group.slowest.profileId,
        },
      };
    })
    .sort((a, b) => (b.p95Ms - a.p95Ms) || (b.avgMs - a.avgMs) || (b.maxMs - a.maxMs));
}

function summarizeFrequentHttpLogs(logs: HttpLogRecord[]): ReturnType<typeof summarizeSlowHttpLogs> {
  return summarizeSlowHttpLogs(logs)
    .sort((a, b) => (b.count - a.count) || (b.rps - a.rps) || (b.p95Ms - a.p95Ms));
}

function filterHttpLogsByKind(logs: HttpLogRecord[], requestKind: HttpRequestKind): HttpLogRecord[] {
  return logs.filter((log) => (log.requestKind || classifyHttpRequestKind({
    layer: log.layer,
    method: log.method,
    path: log.path,
    headers: log.request?.headers,
  })) === requestKind);
}

function summarizeActiveHttpRequests(active: ActiveHttpRequestRecord[]): {
  total: number;
  over10s: number;
  over30s: number;
  over60s: number;
  byKind: Record<HttpRequestKind, number>;
} {
  const byKind: Record<HttpRequestKind, number> = {
    'user-traffic': 0,
    'control-plane': 0,
    deploy: 0,
    'container-op': 0,
    polling: 0,
    sse: 0,
  };
  for (const request of active) {
    byKind[request.requestKind] += 1;
  }
  return {
    total: active.length,
    over10s: active.filter((request) => request.ageMs >= 10_000).length,
    over30s: active.filter((request) => request.ageMs >= 30_000).length,
    over60s: active.filter((request) => request.ageMs >= 60_000).length,
    byKind,
  };
}

function dedupeActiveHttpRequests(requests: ActiveHttpRequestRecord[]): ActiveHttpRequestRecord[] {
  const byRequestId = new Map<string, ActiveHttpRequestRecord>();
  for (const request of requests) {
    const existing = byRequestId.get(request.requestId);
    if (!existing || request.ageMs > existing.ageMs) {
      byRequestId.set(request.requestId, request);
    }
  }
  return Array.from(byRequestId.values());
}

function activeQueryString(filter: HttpActiveRequestFilter): string {
  const params = new URLSearchParams();
  const entries: Array<[string, string | number | undefined]> = [
    ['limit', filter.limit],
    ['requestId', filter.requestId],
    ['host', filter.host],
    ['layer', filter.layer],
    ['method', filter.method],
    ['pathContains', filter.pathContains],
    ['branchId', filter.branchId],
    ['profileId', filter.profileId],
    ['requestKind', filter.requestKind],
    ['minAgeMs', filter.minAgeMs],
    ['sort', filter.sort],
  ];
  for (const [key, value] of entries) {
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

function forwarderDiagnosticsPort(): number {
  const raw = Number.parseInt(process.env.CDS_FORWARDER_PORT || '9090', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 9090;
}

function coerceForwarderActiveRecords(value: unknown): ActiveHttpRequestRecord[] {
  const active = (value as { active?: unknown })?.active;
  if (!Array.isArray(active)) return [];
  return active.flatMap((item) => {
    const row = item as Partial<ActiveHttpRequestRecord>;
    if (!row || typeof row !== 'object') return [];
    if (!row.id || !row.requestId || !row.method || !row.path || !row.layer || !row.requestKind) return [];
    const startedAt = row.startedAt ? new Date(row.startedAt) : new Date();
    const ageMs = Number.isFinite(row.ageMs) ? Math.max(0, Math.floor(row.ageMs || 0)) : Math.max(0, Date.now() - startedAt.getTime());
    return [{
      id: String(row.id),
      startedAt,
      ageMs,
      layer: row.layer,
      requestKind: row.requestKind,
      requestId: String(row.requestId),
      method: String(row.method),
      protocol: row.protocol,
      host: row.host ? String(row.host) : undefined,
      path: String(row.path),
      remoteAddr: row.remoteAddr,
      branchId: row.branchId ?? null,
      profileId: row.profileId ?? null,
      upstream: row.upstream ?? null,
      request: row.request || {},
    }];
  });
}

async function findForwarderActiveRequests(filter: HttpActiveRequestFilter): Promise<ActiveHttpRequestRecord[]> {
  if (process.env.CDS_USE_FORWARDER !== '1' && !process.env.CDS_FORWARDER_PORT) return [];
  try {
    const json = await httpGetJson(
      `http://127.0.0.1:${forwarderDiagnosticsPort()}/__forwarder/active${activeQueryString(filter)}`,
      1000,
    );
    return coerceForwarderActiveRecords(json);
  } catch {
    return [];
  }
}

async function collectActiveHttpRequests(
  store: HttpLogSink | null | undefined,
  filter: HttpActiveRequestFilter,
  options: { excludeRequestId?: string } = {},
): Promise<ActiveHttpRequestRecord[]> {
  // Fetch enough rows from each source before applying the final combined cap,
  // otherwise one busy layer can hide older rows from another layer.
  const sourceFilter = {
    ...filter,
    limit: Math.max(filter.limit ?? 200, 5000),
  };
  const local = store?.findActive?.(sourceFilter) || [];
  const forwarder = await findForwarderActiveRequests(sourceFilter);
  const deduped = dedupeActiveHttpRequests([...local, ...forwarder]);
  const combined = options.excludeRequestId
    ? deduped.filter((request) => request.requestId !== options.excludeRequestId)
    : deduped;
  return filterActiveHttpRequests(combined, filter);
}

export interface ServerDeps {
  stateService: StateService;
  worktreeService: WorktreeService;
  containerService: ContainerService;
  proxyService: ProxyService;
  bridgeService: BridgeService;
  shell: IShellExecutor;
  config: CdsConfig;
  /** Optional warm-pool scheduler (v3.1). */
  schedulerService?: SchedulerService;
  janitorService?: JanitorService;
  /**
   * Cluster executor registry. Passed through to createBranchRouter so the
   * deploy handler can dispatch to remote executors when present. Absent in
   * pre-cluster deployments where the router falls back to local execution.
   */
  registry?: import('./scheduler/executor-registry.js').ExecutorRegistry;
  /** Getter for the current dispatch strategy. See routes/cluster.ts. */
  getClusterStrategy?: () => 'least-branches' | 'least-load' | 'round-robin';
  /**
   * P4 Part 18 (D.3): shared storage-mode context — used by the new
   * storage-mode router to surface + mutate the running backing store
   * at runtime. Always present after initStateService runs in index.ts.
   */
  storageModeContext?: StorageModeContext;
  /** P4 Part 18 (D.3): path to the json state file, used for rollback. */
  stateFile?: string;
  /**
   * FU-02: Optional pre-initialised AuthStore backend. When provided (by
   * index.ts after calling initAuthStore()), it is used instead of the
   * default MemoryAuthStore. Supports 'memory' (default) and 'mongo'.
   */
  authStore?: AuthStore;
  /**
   * Graceful shutdown 控制器。SIGTERM handler 调 runShutdown 让 SSE drain +
   * worker abort 完成后再退出。
   */
  gracefulShutdown?: GracefulShutdownController;
  /** Optional per-request persistent HTTP logger. Writes one Mongo document per request. */
  httpLogStore?: HttpLogSink | null;
  /** Optional persistent diagnostics logger for container/docker/system events. */
  serverEventLogStore?: ServerEventLogSink | null;
  /** Serializes/fences branch container lifecycle writes. */
  branchOperationCoordinator?: BranchOperationCoordinator;
}

function makeToken(user: string, pass: string): string {
  return crypto.createHash('sha256').update(`cds:${user}:${pass}`).digest('hex');
}

function shortText(value: unknown, max = 1200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Walk the Express router stack and collect every path string registered.
 * Used by /healthz to verify critical SPA routes are actually mounted —
 * if a refactor accidentally drops installSpaFallback(), users see a
 * blanket 404 even though the process is up. We want healthz to fail
 * loudly in that case so the post-restart probe in exec_cds.sh aborts
 * the deploy.
 *
 * Catches:
 *   - exact paths registered via app.get('/foo', ...)
 *   - the wildcard '*' registered by installSpaFallback (covers all SPA paths)
 *   - paths nested under app.use('/api', router) — best-effort, we walk
 *     into sub-routers when the layer exposes a `.handle.stack`.
 */
function collectRegisteredPaths(app: express.Express): Set<string> {
  const paths = new Set<string>();
  const stack = (app as unknown as { _router?: { stack: Layer[] } })._router?.stack;
  if (!stack) return paths;
  walkLayers(stack, '', paths);
  return paths;
}

interface Layer {
  route?: { path: string };
  name?: string;
  regexp?: RegExp;
  handle?: { stack?: Layer[] };
}

function walkLayers(layers: Layer[], prefix: string, out: Set<string>): void {
  for (const layer of layers) {
    if (layer.route?.path !== undefined) {
      // Express 4 stores the literal pattern on layer.route.path, including
      // the catch-all '*' registered by installSpaFallback().
      out.add(prefix + layer.route.path);
    } else if (layer.name === 'router' && layer.handle?.stack) {
      // Nested router (mounted via app.use('/prefix', router)). The mount
      // path isn't directly available; for /healthz purposes we only need
      // top-level paths, so we recurse without prefix tracking.
      walkLayers(layer.handle.stack, prefix, out);
    }
  }
}

/**
 * Make a minimal HTTP GET against 127.0.0.1:port to verify a route serves
 * an HTML page. Used by /healthz?probe=routes for the post-restart self-probe.
 *
 * 1s timeout per probe so a wedged route can't hang healthz indefinitely.
 * Auto-redirect handling is OFF (redirects to /login etc. are valid 302
 * responses for our purposes — we just check the route is registered and
 * not blanket-404).
 */
/**
 * Best-effort GET that parses JSON. Used by topology aggregator to probe
 * forwarder + admin daemons. Caller catches any error to fall back to
 * "alive=false".
 */
function httpGetJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      return reject(err as Error);
    }
    const req = http.request(
      {
        host: parsed.hostname,
        port: Number(parsed.port) || 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: { 'User-Agent': 'cds-topology-probe', Connection: 'close' },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (err) { reject(err as Error); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

function probeRouteHttp(
  port: number,
  routePath: string,
): Promise<{ path: string; ok: boolean; status: number; contentType: string; detail?: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: routePath,
        method: 'GET',
        // The probe loops back to the same process — keep-alive would
        // hold the socket open past the response and trip our 1s timeout.
        headers: { 'User-Agent': 'cds-healthz-probe', Connection: 'close' },
        timeout: 1000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] || '');
        // 2xx + 3xx are both acceptable: 302 to /login is the auth-redirect path
        // for protected pages, which is still "the route is wired up correctly".
        // 404 / 5xx are the failure modes we want to catch.
        const ok = status >= 200 && status < 400;
        // Drain so the socket can close.
        res.resume();
        resolve({
          path: routePath,
          ok,
          status,
          contentType,
          detail: ok ? undefined : `status=${status}`,
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('probe timeout'));
    });
    req.on('error', (err) => {
      resolve({
        path: routePath,
        ok: false,
        status: 0,
        contentType: '',
        detail: err.message,
      });
    });
    req.end();
  });
}

// ── Activity Stream (SSE broadcast for API operation monitor) ──
export interface ActivityEvent {
  id: number;
  requestId?: string;
  ts: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  source: 'user' | 'ai';
  /** Event type: 'cds' for dashboard API calls, 'web' for proxied website access */
  type?: 'cds' | 'web';
  /** AI agent name if source is 'ai' */
  agent?: string;
  /** Chinese label describing what this API does */
  label?: string;
  /** Request body summary (first 500 chars of JSON) */
  body?: string;
  /** Response error summary for 4xx/5xx, parsed from JSON/text body when available */
  errorSummary?: string;
  /** Query string params */
  query?: string;
  /** Branch ID extracted from path (for AI occupation tracking) */
  branchId?: string;
  /** Branch tags for activity display (resolved server-side to avoid timing issues) */
  branchTags?: string[];
  /** Build profile ID that handled the request (e.g. 'api', 'admin') */
  profileId?: string;
  /** Remote address of the client */
  remoteAddr?: string;
  /** User-Agent header */
  userAgent?: string;
  /** Referer header */
  referer?: string;
}

/** Map API path patterns to Chinese labels */
export function resolveApiLabel(method: string, path: string): string {
  // Normalize: remove /api prefix, trim trailing slash
  const p = path.replace(/^\/api/, '').replace(/\/$/, '');

  // Static exact matches
  const staticMap: Record<string, string> = {
    // shared 基础设施服务远程主机（系统级，2026-05-06）
    'GET /cds-system/remote-hosts': '列出远程主机',
    'POST /cds-system/remote-hosts': '登记远程主机',
    // CDS 配对连接（系统级，2026-05-06）
    'POST /cds-system/connections/issue': '生成配对密钥',
    'POST /cds-system/connections/accept': '接受配对请求',
    // 项目级资源占用排行（系统级运维视图，2026-06-23）
    'GET /cds-system/resource-usage': '查看资源占用',
    'GET /cds-system/connections': '列出配对连接',
    'GET /cds-system/network-topology': '查询网络拓扑',
    'GET /cds-system/github/webhook-deliveries': '列出 Webhook 日志',
    'GET /cds-system/github/app-whitelist': '获取 GitHub 白名单',
    'PUT /cds-system/github/app-whitelist': '更新 GitHub 白名单',
    // 发布控制面（preview → release，2026-06-10）
    'GET /releases/targets': '列出发布目标',
    'POST /releases/targets': '创建发布目标',
    'PATCH /releases/targets/:id': '更新发布目标',
    'DELETE /releases/targets/:id': '删除发布目标',
    'POST /releases/branches/:branchId/preflight': '执行发布前检查',
    'POST /releases/branches/:branchId/runs': '启动分支发布',
    'GET /releases/runs': '列出发布记录',
    'GET /releases/runs/:id': '查看发布记录',
    'POST /releases/runs/:id/rollback': '回滚发布记录',
    'GET /releases/runs/:id/stream': '订阅发布日志流',
    'GET /releases/center': '查看发布中心',
    'GET /branches': '获取系统状态信息',
    'POST /branches': '注册新分支',
    'GET /remote-branches': '获取远程分支',
    'GET /build-profiles': '获取构建配置',
    'POST /build-profiles': '创建构建配置',
    'GET /routing-rules': '获取路由规则',
    'POST /routing-rules': '创建路由规则',
    'GET /env': '获取环境变量',
    'PUT /env': '批量设置环境变量',
    'POST /env/categorize': '整理环境变量',
    'POST /validate-runtime': '试运行验证配置',
    'POST /detect-runtime': '检测仓库技术栈',
    'GET /config': '获取全局配置',
    'GET /infra': '获取基础设施列表',
    'GET /infra/catalog': '获取基建目录',
    'GET /infra/discover': '发现基础设施',
    'POST /infra': '添加基础设施',
    'POST /infra/quickstart': '快速初始化基础设施',
    'GET /docker-images': '获取 Docker 镜像',
    'POST /cleanup': '清理已停止容器',
    'POST /cleanup-orphans': '清理孤儿容器',
    'POST /branches/cleanup-damaged-containers': '清理损坏容器',
    'POST /branches/cleanup-stopped': '清理已停止分支',
    'POST /branches/cleanup-orphan-containers': '清理孤儿容器',
    'POST /prune-stale-branches': '清理过期分支',
    'POST /factory-reset': '恢复出厂设置',
    'GET /check-updates': '检查远程更新',
    'POST /quickstart': '快速开始配置',
    'GET /mirror': '获取镜像配置',
    'PUT /mirror': '更新镜像配置',
    'POST /import-config': '导入配置',
    'POST /build-profiles/bulk-set-modes': '批量设置部署命令',
    'GET /export-config': '导出配置',
    'GET /reports': '列出验收报告',
    'POST /reports': '创建验收报告',
    'GET /report-folders': '列出报告文件夹',
    'POST /report-folders': '新建报告文件夹',
    'POST /peer-sync/handshake': 'peer-sync 配对握手',
    'POST /peer-sync/handshake/confirm': 'peer-sync 握手确认',
    'POST /peer-sync/handshake/finalize': 'peer-sync 握手完成',
    'POST /peer-sync/handshake/cancel': 'peer-sync 握手取消',
    'GET /peer-sync/ping': 'peer-sync 连通自检',
    'GET /peer-sync/capabilities': 'peer-sync 能力查询',
    'POST /peer-sync/admin/pairing-codes': '生成 peer-sync 配对码',
    'GET /peer-sync/admin/nodes': '列出 peer-sync 节点',
    'GET /cache/status': '查看缓存状态',
    'POST /cache/repair': '修复缓存挂载',
    'GET /cache/export': '导出缓存包',
    'POST /cache/import': '导入缓存包',
    'POST /cache/purge': '清空缓存目录',
    'GET /proxy-log': '查看转发日志',
    'GET /proxy-log/stream': '订阅转发日志流',
    'GET /http-logs': '查看 HTTP 请求日志',
    'GET /http-logs/active': '查看运行中 HTTP 请求',
    'GET /http-logs/slow': '查看慢 HTTP 请求排行',
    'GET /perf/overview': '查看性能概览',
    'GET /server-events': '查看服务器/容器事件日志',
    'GET /config-snapshots': '列出配置快照',
    'POST /config-snapshots': '手动保存配置快照',
    'GET /destructive-ops': '列出破坏性操作',
    'GET /legacy-cleanup/status': '查看 default 遗留状态',
    'POST /legacy-cleanup/rename-default': '迁移 default 项目',
    'POST /legacy-cleanup/cleanup-residual': '清理 default 残留',
    'GET /export-skill': '导出技能配置',
    'POST /import-and-init': '导入并初始化',
    'GET /self-branches': '获取自身分支',
    'GET /self-status': '获取自更新状态',
    'GET /self-status/stream': '订阅自更新状态',
    'GET /cds-events': '订阅 CDS 事件流',
    'POST /self-refresh': '触发自更新刷新',
    'GET /cds-system/operator/ops': '列出运维控制台操作',
    'POST /cds-system/operator/run': '执行运维控制台操作',
    'POST /cds-system/operator/request': '发起运维操作审批请求',
    'GET /cds-system/operator/requests': '列出运维审批请求',
    'POST /self-update': '自我更新',
    'POST /login': '用户登录',
    'POST /logout': '用户登出',
    'GET /ai/pending': '查看待处理 AI 请求',
    'GET /ai/sessions': '查看 AI 会话',
    'GET /ai/pairing-stream': '订阅 AI 配对事件',
    'POST /ai/request-access': 'AI 请求连接',
    'GET /bridge/connections': '查看 Bridge 连接',
    'POST /bridge/heartbeat': 'Bridge 心跳',
    'POST /bridge/result': 'Bridge 上报结果',
    'POST /bridge/navigate-request': 'AI 请求用户导航',
    'POST /bridge/handshake-request': '创建 Bridge 握手请求',
    'POST /bridge/start-session': 'AI 开始操作页面',
    'POST /bridge/end-session': 'AI 操作完成',
    'POST /github/webhook': 'GitHub 推送 Webhook',
    'POST /github/webhook/self-test': 'GitHub Webhook 自测',
    'GET /github/app': '查询 GitHub App 配置',
    'GET /github/installations': '列出 GitHub App 安装',
    'GET /github/oauth/status': '查询 GitHub OAuth 状态',
    'DELETE /github/oauth': '解除 GitHub OAuth',
    'GET /github/repos': '列出 GitHub 仓库',
    'POST /github/oauth/device-start': 'GitHub 设备授权发起',
    'POST /github/oauth/device-poll': 'GitHub 设备授权轮询',
    'GET /auth/github/login': 'GitHub 登录跳转',
    'GET /auth/github/callback': 'GitHub 登录回调',
    'POST /auth/logout': '退出登录',
    'GET /auth/status': '获取认证状态',
    'POST /auth/login': '本地账号登录',
    'GET /auth/bootstrap-status': '查询首启引导状态',
    'POST /auth/bootstrap': '创建首个本地账号',
    'POST /auth/change-password': '修改密码',
    'GET /auth/users': '列出用户',
    'POST /auth/users': '创建本地账号',
    'GET /auth/activity': '查看用户操作痕迹',
    // 用户 / 系统基础信息
    'GET /me': '获取当前用户',
    'GET /status': '获取系统状态',
    'GET /healthz': '健康检查',
    'GET /host-stats': '获取主机状态',
    'GET /cds-system/perf-health': '运维健康观测',
    'GET /state-stream': '订阅状态流',
    'GET /activity-stream': '订阅活动流',
    'GET /cli-version': '获取 CLI 版本',
    'GET /preview-mode': '获取预览模式',
    'PUT /preview-mode': '设置预览模式',
    'GET /tab-title': '获取标签页标题',
    'PUT /tab-title': '更新标签页标题',
    'GET /comment-template': '获取 PR 评论模板',
    'PUT /comment-template': '更新 PR 评论模板',
    'POST /comment-template/preview': '预览 PR 评论模板',
    // 项目
    'GET /projects': '列出项目',
    'POST /projects': '创建项目',
    'POST /cleanup-cross-project-services': '清理跨项目服务',
    'GET /pending-imports': '列出待导入项目',
    'POST /projects/:id/pending-import': '提交待导入配置',
    'GET /access-requests': '列出授权申请',
    'GET /projects/:id/activity-logs': '获取项目活动日志',
    'GET /projects/:id/recent-auto-deploys': '查看自动部署历史',
    'GET /projects/:id/preview-mode': '获取项目预览模式',
    'PUT /projects/:id/preview-mode': '更新项目预览模式',
    'GET /projects/:id/comment-template': '获取项目评论模板',
    'PUT /projects/:id/comment-template': '更新项目评论模板',
    'POST /projects/:id/align-deploy-modes': '对齐全部分支运行模式',
    'GET /projects/:id/agent-sessions': '列出项目 Agent 会话',
    // 调度 / 集群
    'GET /scheduler/state': '获取调度器状态',
    'PUT /scheduler/enabled': '启停调度器',
    'PUT /scheduler/config': '更新调度器配置',
    'GET /strategy': '获取调度策略',
    'PUT /strategy': '更新调度策略',
    'GET /cluster/status': '获取集群状态',
    'GET /cluster/strategy': '获取集群调度策略',
    'PUT /cluster/strategy': '更新集群调度策略',
    'POST /cluster/join': '加入集群',
    'POST /cluster/leave': '离开集群',
    'POST /cluster/issue-token': '签发集群连接码',
    'GET /connections': '查看集群连接',
    'POST /heartbeat': '集群心跳',
    'POST /join': '加入集群',
    'POST /leave': '离开集群',
    'POST /issue-token': '签发集群令牌',
    'POST /result': '上报任务结果',
    'POST /executors/register': '注册执行器',
    'GET /executors/capacity': '获取执行器容量',
    'GET /executors': '列出执行器',
    'POST /detect-stack': '探测技术栈',
    // 存储模式
    'GET /storage-mode': '获取存储模式',
    'POST /storage-mode/switch-to-json': '切换到 JSON 存储',
    'POST /storage-mode/switch-to-mongo': '切换到 Mongo 存储',
    'POST /storage-mode/test-mongo': '测试 Mongo 连接',
    // Global / 自更新 / 其他
    'GET /global-agent-keys': '列出全局 Agent Keys',
    'POST /global-agent-keys': '创建全局 Agent Key',
    'POST /self-update-dry-run': '自更新预检',
    'POST /self-force-sync': '自更新强制更新',
    'POST /accept-invite': '接受邀请',
    'GET /self-update-history': '获取自更新完整历史',
    // 数据迁移
    'GET /data-migrations': '列出数据迁移',
    'POST /data-migrations': '创建数据迁移',
    'GET /data-migrations/my-key': '获取迁移密钥',
    'GET /data-migrations/peers': '列出迁移伙伴',
    'POST /data-migrations/peers': '创建迁移伙伴',
    'POST /data-migrations/check-tools': '检查迁移工具',
    'POST /data-migrations/install-tools': '安装迁移工具',
    'POST /data-migrations/list-collections': '列出集合',
    'POST /data-migrations/list-databases': '列出数据库',
    'POST /data-migrations/local-dump': '本地导出',
    'POST /data-migrations/local-restore': '本地导入',
    'POST /data-migrations/test-connection': '测试 Mongo 连接',
    'POST /data-migrations/test-tunnel': '测试 SSH 隧道',
    // 工作空间
    'GET /workspaces': '列出工作空间',
    'POST /workspaces': '创建工作空间',
  };

  const key = `${method} ${p}`;
  if (staticMap[key]) return staticMap[key];

  // Dynamic pattern matches (with :id params)
  const patterns: Array<[RegExp, string]> = [
    [/^PATCH \/auth\/users\/(.+)$/, '更新用户'],
    [/^GET \/cds-system\/operator\/requests\/(.+)$/, '查询运维审批请求'],
    [/^POST \/cds-system\/operator\/requests\/(.+)\/approve$/, '批准运维操作'],
    [/^POST \/cds-system\/operator\/requests\/(.+)\/reject$/, '拒绝运维操作'],
    [/^GET \/reports\/(.+)\/raw$/, '查看验收报告内容'],
    [/^POST \/reports\/(.+)\/share$/, '生成报告分享链接'],
    [/^DELETE \/reports\/(.+)\/share$/, '撤销报告分享链接'],
    [/^POST \/reports\/(.+)\/push-to-pr$/, '验收回写 PR'],
    [/^POST \/peer-sync\/resources\/(.+)\/signature$/, 'peer-sync 指纹查询'],
    [/^POST \/peer-sync\/resources\/(.+)\/export$/, 'peer-sync 导出报告'],
    [/^POST \/peer-sync\/resources\/(.+)\/apply$/, 'peer-sync 写入(忽略)'],
    [/^DELETE \/peer-sync\/admin\/nodes\/(.+)$/, '撤销 peer-sync 节点'],
    [/^GET \/reports\/assets\/(.+)$/, '获取报告图片资源'],
    [/^GET \/reports\/(.+)$/, '查看验收报告'],
    [/^PATCH \/reports\/(.+)$/, '更新验收报告'],
    [/^DELETE \/reports\/(.+)$/, '删除验收报告'],
    [/^PATCH \/report-folders\/(.+)$/, '重命名报告文件夹'],
    [/^DELETE \/report-folders\/(.+)$/, '删除报告文件夹'],
    [/^GET \/config-snapshots\/(.+)$/, '查看配置快照详情'],
    [/^POST \/config-snapshots\/(.+)\/rollback$/, '回滚到配置快照'],
    [/^DELETE \/config-snapshots\/(.+)$/, '删除配置快照'],
    [/^POST \/destructive-ops\/(.+)\/undo$/, '撤销破坏性操作'],
    // shared 基础设施服务远程主机（系统级）
    [/^GET \/cds-system\/remote-hosts\/(.+)\/instance$/, '查询主机实例'],
    [/^GET \/cds-system\/remote-hosts\/(.+)\/deployments$/, '列出主机部署'],
    [/^POST \/cds-system\/remote-hosts\/(.+)\/test$/, '测试远程主机连接'],
    [/^POST \/cds-system\/remote-hosts\/(.+)\/deploy-sidecar$/, '部署 Sidecar'],
    [/^GET \/cds-system\/remote-hosts\/(.+)$/, '查看远程主机详情'],
    [/^PATCH \/cds-system\/remote-hosts\/(.+)$/, '更新远程主机'],
    [/^DELETE \/cds-system\/remote-hosts\/(.+)$/, '删除远程主机'],
    [/^GET \/service-deployments\/(.+)\/stream$/, '订阅部署日志流'],
    [/^GET \/service-deployments\/(.+)$/, '查看部署详情'],
    // shared-service Project 实例发现（spec.cds.map-pairing-protocol §3.2）
    [/^GET \/projects\/(.+)\/instances$/, '列出项目实例'],
    // 项目迁移(配置复刻 + 数据迁移扫描，2026-06-23)
    [/^GET \/projects\/(.+)\/migration\/peers$/, '列出迁移目标'],
    [/^POST \/projects\/(.+)\/migration\/peers$/, '新增迁移目标'],
    [/^POST \/projects\/(.+)\/migration\/peers\/(.+)\/verify$/, '测试迁移目标连接'],
    [/^DELETE \/projects\/(.+)\/migration\/peers\/(.+)$/, '删除迁移目标'],
    [/^GET \/projects\/(.+)\/migration\/config-preview$/, '预览可复刻配置'],
    [/^POST \/projects\/(.+)\/migration\/replicate-config$/, '推送配置到目标 CDS'],
    [/^POST \/projects\/(.+)\/migration\/data-plan$/, '扫描数据迁移计划'],
    // CDS 配对连接 :id 路径
    [/^POST \/cds-system\/connections\/(.+)\/revoke$/, '撤销配对连接'],
    [/^GET \/cds-system\/connections\/(.+)$/, '查看配对连接'],
    [/^DELETE \/cds-system\/connections\/(.+)$/, '删除配对连接'],
    [/^DELETE \/branches\/(.+)$/, '删除分支'],
    [/^PATCH \/branches\/(.+)$/, '更新分支信息'],
    [/^POST \/branches\/(.+)\/pull$/, '拉取分支代码'],
    [/^POST \/branches\/(.+)\/deploy\/(.+)$/, '部署单服务'],
    [/^POST \/branches\/(.+)\/deploy$/, '全量部署'],
    [/^POST \/branches\/(.+)\/database-init\/run$/, '执行数据库初始化命令'],
    [/^POST \/branches\/(.+)\/stop$/, '停止分支服务'],
    [/^POST \/branches\/(.+)\/restart$/, '重新启动分支'],
    [/^GET \/branches\/(.+)\/activity-logs$/, '查看分支系统日志'],
    [/^POST \/branches\/(.+)\/set-default$/, '设为默认分支'],
    [/^POST \/branches\/(.+)\/reset$/, '重置分支状态'],
    [/^GET \/branches\/(.+)\/logs$/, '查看操作日志'],
    [/^POST \/branches\/(.+)\/container-logs$/, '查看容器日志'],
    [/^POST \/branches\/(.+)\/container-env$/, '查看容器环境变量'],
    [/^POST \/branches\/(.+)\/container-exec$/, '容器内执行命令'],
    [/^GET \/branches\/(.+)\/git-log$/, '查看 Git 提交历史'],
    [/^PUT \/env\/(.+)$/, '设置环境变量'],
    [/^DELETE \/env\/(.+)$/, '删除环境变量'],
    [/^PUT \/routing-rules\/(.+)$/, '更新路由规则'],
    [/^DELETE \/routing-rules\/(.+)$/, '删除路由规则'],
    [/^PUT \/build-profiles\/(.+)$/, '更新构建配置'],
    [/^DELETE \/build-profiles\/(.+)$/, '删除构建配置'],
    [/^PUT \/build-profiles\/(.+)\/deploy-mode$/, '切换部署模式'],
    [/^POST \/build-profiles\/(.+)\/hot-reload$/, '切换热更新'],
    [/^POST \/branches\/(.+)\/force-rebuild\/(.+)$/, '强制干净重建'],
    [/^POST \/branches\/(.+)\/verify-runtime\/(.+)$/, '运行时字节码核验'],
    [/^POST \/infra\/(.+)\/start$/, '启动基础设施'],
    [/^POST \/infra\/(.+)\/stop$/, '停止基础设施'],
    [/^POST \/infra\/(.+)\/restart$/, '重启基础设施'],
    [/^GET \/infra\/(.+)\/logs$/, '查看基础设施日志'],
    [/^GET \/infra\/(.+)\/health$/, '基础设施健康检查'],
    [/^PUT \/infra\/(.+)$/, '更新基础设施'],
    [/^DELETE \/infra\/(.+)$/, '删除基础设施'],
    [/^GET \/infra\/(.+)\/backup$/, '下载数据库备份'],
    [/^POST \/infra\/(.+)\/restore$/, '恢复数据库'],
    [/^GET \/infra\/(.+)\/backup-history$/, '查看备份历史'],
    [/^POST \/infra\/(.+)\/query$/, '查询数据库'],
    [/^GET \/infra\/(.+)\/schema$/, '查看数据库结构'],
    [/^POST \/infra\/(.+)\/init-sql$/, '执行初始化 SQL'],
    [/^POST \/branches\/(.+)\/resources\/(.+)\/data\/init-sql$/, '执行分支资源初始化 SQL'],
    [/^DELETE \/ai\/sessions\/(.+)$/, '撤销 AI 会话'],
    [/^POST \/ai\/approve\/(.+)$/, '批准 AI 连接'],
    [/^POST \/ai\/reject\/(.+)$/, '拒绝 AI 连接'],
    [/^GET \/ai\/request-status\/(.+)$/, '查询 AI 配对状态'],
    [/^GET \/bridge\/state\/(.+)$/, '读取页面状态'],
    [/^POST \/bridge\/command\/(.+)$/, 'AI 操作页面'],
    [/^GET \/bridge\/check\/(.+)$/, '检查 Bridge 连接'],
    [/^GET \/bridge\/navigate-requests\/(.+)$/, '查看导航请求'],
    [/^POST \/bridge\/navigate-requests\/(.+)\/dismiss$/, '忽略导航请求'],
    [/^GET \/bridge\/handshake-requests\/(.+)$/, '查看 Bridge 握手请求'],
    [/^POST \/bridge\/handshake-requests\/(.+)\/approve$/, '批准 Bridge 握手'],
    [/^POST \/bridge\/handshake-requests\/(.+)\/reject$/, '拒绝 Bridge 握手'],
    [/^GET \/bridge\/handshake-status\/(.+)$/, '查询 Bridge 握手状态'],
    // 项目 (CRUD)
    [/^PUT \/projects\/(.+)\/paused$/, '暂停/恢复项目'],
    [/^GET \/projects\/(.+)\/agent-keys$/, '列出项目 Agent Keys'],
    [/^POST \/projects\/(.+)\/agent-keys$/, '创建项目 Agent Key'],
    [/^DELETE \/projects\/(.+)\/agent-keys\/(.+)$/, '删除项目 Agent Key'],
    // 项目级 Agent 会话
    [/^GET \/projects\/[^/]+\/agent-requests$/, '列出 Agent 请求'],
    [/^GET \/projects\/[^/]+\/agent-sessions\/[^/]+\/stream$/, '订阅 Agent 会话事件流'],
    [/^GET \/projects\/[^/]+\/agent-sessions\/[^/]+\/logs$/, '查看 Agent 会话日志'],
    [/^POST \/projects\/[^/]+\/agent-sessions\/[^/]+\/stop$/, '停止 Agent 会话'],
    [/^POST \/projects\/[^/]+\/agent-sessions\/[^/]+\/messages$/, '发送 Agent 会话消息'],
    [/^GET \/projects\/[^/]+\/agent-sessions\/[^/]+$/, '查看 Agent 会话详情'],
    [/^POST \/projects\/[^/]+\/agent-sessions$/, '创建项目 Agent 会话'],
    [/^POST \/projects\/(.+)\/github\/link$/, '关联 GitHub 仓库'],
    [/^DELETE \/projects\/(.+)\/github\/link$/, '解除 GitHub 关联'],
    [/^POST \/projects\/(.+)\/clone$/, '克隆代码'],
    [/^GET \/projects\/(.+)\/storage$/, '获取项目存储'],
    [/^GET \/projects\/(.+)$/, '查询项目'],
    [/^PUT \/projects\/(.+)$/, '更新项目'],
    [/^DELETE \/projects\/(.+)$/, '删除项目'],
    // 待导入项目
    [/^GET \/pending-imports\/(.+)$/, '查询待导入项目'],
    [/^POST \/pending-imports\/(.+)\/approve$/, '批准导入'],
    [/^POST \/pending-imports\/(.+)\/reject$/, '拒绝导入'],
    [/^POST \/projects\/[^/]+\/access-requests$/, '发起授权申请'],
    [/^GET \/projects\/[^/]+\/access-requests\/[^/]+$/, '轮询授权结果'],
    [/^POST \/access-requests\/[^/]+\/approve$/, '批准授权申请'],
    [/^POST \/access-requests\/[^/]+\/reject$/, '拒绝授权申请'],
    // 项目虚拟 cds-compose.yml
    [/^GET \/projects\/(.+)\/compose\.yml$/, '下载项目配置'],
    [/^GET \/projects\/(.+)\/compose$/, '获取项目配置'],
    [/^PUT \/projects\/(.+)\/compose$/, '保存项目配置'],
    // 项目基础设施重新同步
    [/^GET \/projects\/(.+)\/infra\/resync\/sources$/, '列出同步配置来源'],
    [/^POST \/projects\/(.+)\/infra\/resync\/preview$/, '预览基础设施同步'],
    [/^POST \/projects\/(.+)\/infra\/resync\/execute$/, '执行基础设施同步'],
    [/^POST \/projects\/(.+)\/infra-presets$/, '应用基建预设'],
    // 分支扩展
    [/^GET \/branches\/stream$/, '订阅分支状态流'],
    [/^POST \/branches\/(.+)\/checkout\/(.+)$/, '检出 Commit'],
    [/^POST \/branches\/(.+)\/preview-port$/, '设置预览端口'],
    [/^POST \/branches\/(.+)\/unpin$/, '取消分支置顶'],
    [/^POST \/branches\/(.+)\/smoke$/, '分支冒烟测试'],
    [/^GET \/branches\/(.+)\/subdomain-aliases$/, '列出分支域名别名'],
    [/^PUT \/branches\/(.+)\/subdomain-aliases$/, '设置分支域名别名'],
    [/^GET \/branches\/(.+)\/profile-overrides$/, '获取构建覆写'],
    [/^PUT \/branches\/(.+)\/profile-overrides\/(.+)$/, '更新构建覆写'],
    [/^DELETE \/branches\/(.+)\/profile-overrides\/(.+)$/, '删除构建覆写'],
    [/^GET \/branches\/(.+)\/container-logs-stream\/(.+)$/, '流式查看容器日志'],
    // F9 (2026-05-02): 单分支详情。
    // Codex review fix(PR #522)— 用 `[^/]+` 而非 `(.+)`,regex 本身就 segment-safe,
    // 不会贪婪吞掉子路径(如 /logs / /git-log)。即使未来 sub-route patterns 顺序错位,
    // 也不会被本 pattern 误命中 → "查看分支详情" 标签只在真单段 id 时使用。
    [/^GET \/branches\/[^/]+$/, '查看分支详情'],
    [/^GET \/branches\/[^/]+\/effective-env$/, '查看生效环境变量'],
    [/^GET \/branches\/[^/]+\/effective-env\/reveal$/, '查看密钥明文'],
    [/^GET \/branches\/[^/]+\/metrics$/, '查看分支指标'],
    [/^GET \/branches\/[^/]+\/failure-diagnosis$/, '诊断失败原因'],
    // 构建 Profile 扩展
    [/^PUT \/build-profiles\/(.+)\/deploy-mode$/, '切换部署模式'],
    // 调度器操作
    [/^POST \/scheduler\/pin\/(.+)$/, '固定节点'],
    [/^POST \/scheduler\/unpin\/(.+)$/, '取消固定节点'],
    [/^POST \/scheduler\/cool\/(.+)$/, '冷却节点'],
    [/^GET \/executors\/(.+)$/, '查看执行器详情'],
    [/^DELETE \/executors\/(.+)$/, '移除执行器'],
    [/^POST \/executors\/(.+)\/heartbeat$/, '执行器心跳'],
    [/^POST \/executors\/(.+)\/drain$/, '排空执行器'],
    [/^POST \/executors\/dispatch\/(.+)$/, '调度分支执行器'],
    // 全局 Agent Key
    [/^DELETE \/global-agent-keys\/(.+)$/, '删除全局 Agent Key'],
    // 数据迁移
    [/^GET \/data-migrations\/(.+)\/log$/, '查看迁移日志'],
    [/^PUT \/data-migrations\/(.+)$/, '更新数据迁移'],
    [/^POST \/data-migrations\/(.+)\/execute$/, '执行数据迁移'],
    [/^DELETE \/data-migrations\/(.+)$/, '删除数据迁移'],
    [/^PUT \/data-migrations\/peers\/(.+)$/, '更新迁移伙伴'],
    [/^DELETE \/data-migrations\/peers\/(.+)$/, '删除迁移伙伴'],
    [/^POST \/data-migrations\/peers\/(.+)\/list-databases$/, '列出伙伴数据库'],
    [/^POST \/data-migrations\/peers\/(.+)\/list-collections$/, '列出伙伴集合'],
    [/^POST \/data-migrations\/peers\/(.+)\/test$/, '测试伙伴连接'],
    // 握手
    [/^POST \/handshake-requests\/(.+)\/approve$/, '批准握手请求'],
    [/^POST \/handshake-requests\/(.+)\/reject$/, '拒绝握手请求'],
    [/^POST \/navigate-requests\/(.+)\/dismiss$/, '忽略导航请求'],
    // GitHub
    [/^GET \/github\/installations\/(.+)\/repos$/, '列出安装下的仓库'],
    // 包管理器探测
    [/^GET \/detect-pm\/(.+)$/, '探测包管理器'],
    // 工作空间
    [/^GET \/workspaces\/(.+)\/members$/, '列出工作空间成员'],
    [/^POST \/workspaces\/(.+)\/members$/, '添加工作空间成员'],
    [/^PATCH \/workspaces\/(.+)\/members\/(.+)$/, '更新成员角色'],
    [/^DELETE \/workspaces\/(.+)\/members\/(.+)$/, '移除工作空间成员'],
    [/^GET \/workspaces\/(.+)\/invites$/, '列出工作空间邀请'],
    [/^POST \/workspaces\/(.+)\/invites$/, '创建工作空间邀请'],
    [/^DELETE \/workspaces\/(.+)\/invites\/(.+)$/, '撤销工作空间邀请'],
    [/^GET \/workspaces\/(.+)$/, '查询工作空间'],
  ];

  for (const [regex, label] of patterns) {
    if (regex.test(key)) return label;
  }

  return '';
}

const activityClients = new Set<express.Response>();
let activitySeq = 0;
export function nextActivitySeq(): number { return ++activitySeq; }
const activityBuffer: ActivityEvent[] = []; // ring buffer, keep last 200
const ACTIVITY_BUFFER_MAX = 200;

export function broadcastActivity(event: ActivityEvent) {
  activityBuffer.push(event);
  if (activityBuffer.length > ACTIVITY_BUFFER_MAX) activityBuffer.shift();
  const data = JSON.stringify(event);
  for (const client of activityClients) {
    try { client.write(`data: ${data}\n\n`); } catch { activityClients.delete(client); }
  }
}

// ── AI Pairing (router-style dynamic auth) ──
interface AiPairingRequest {
  id: string;
  agentName: string;
  purpose: string;
  createdAt: string;
  /** IP address of the requesting agent */
  ip: string;
}

interface ApprovedAiSession {
  id: string;
  agentName: string;
  token: string;
  approvedAt: string;
  /** Sessions expire after 24h by default */
  expiresAt: string;
}

const pendingAiRequests = new Map<string, AiPairingRequest>();
const approvedAiSessions = new Map<string, ApprovedAiSession>();
const aiPairingClients = new Set<express.Response>();

function broadcastAiPairing(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of aiPairingClients) {
    try { client.write(msg); } catch { aiPairingClients.delete(client); }
  }
}

/**
 * 被动授权的「发起申请 / 轮询结果」两个端点是 public(免密)—— 见
 * routes/access-requests.ts 顶部说明:agent 无任何预置凭据也要能发起。两种 auth
 * 模式(basic / github)的网关都必须放行这两条,否则 github 模式下 agent 会 401、
 * 整个特性走不通。集中在这里,避免两处网关各写一份导致漂移。
 */
function isPublicAccessRequestRoute(method: string, path: string): boolean {
  if (method === 'POST' && /^\/api\/projects\/[^/]+\/access-requests$/.test(path)) return true;
  if (method === 'GET' && /^\/api\/projects\/[^/]+\/access-requests\/[^/]+$/.test(path)) return true;
  return false;
}

/** Check if a request is from an approved AI session */
function resolveAiSession(req: express.Request, stateService?: StateService): ApprovedAiSession | null {
  // Static mode: CDS_AI_ACCESS_KEY (canonical) 或 legacy AI_ACCESS_KEY 二者命中其一即放行；
  // dashboard customEnv 里的 AI_ACCESS_KEY 字段是用户在 UI 上配的另一个层面，
  // 字段名维持 AI_ACCESS_KEY 不动（用户可见，改名会破坏现有表单存档）。
  //
  // CDS-CLI-005 兼容：除了规范 header `x-ai-access-key`，还接受用户常误用的
  // `ai-access-key`（无 x- 前缀）和 `Authorization: Bearer <key>`。Express
  // 会把 header 名规范化为小写，所以这里只需要小写比较。
  const headerKey = (req.headers['x-ai-access-key'] as string | undefined)
    || (req.headers['ai-access-key'] as string | undefined)
    || (() => {
        const auth = req.headers['authorization'] as string | undefined;
        if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
        return undefined;
      })();
  if (headerKey) {
    const processKey = process.env.CDS_AI_ACCESS_KEY || process.env.AI_ACCESS_KEY;
    const customKey = stateService?.getCustomEnv()?.['AI_ACCESS_KEY'];
    if ((processKey && headerKey === processKey) || (customKey && headerKey === customKey)) {
      return { id: 'static', agentName: 'AI (static key)', token: headerKey, approvedAt: '', expiresAt: '' };
    }
    // MAP/CDS system connection long token: only allow it on Bridge routes.
    // This token is the user-approved, long-lived authorization used by MAP
    // after /api/cds-system/connections/authorize, so it must be able to drive
    // Page Agent Bridge without granting broad CDS admin access.
    if (stateService && req.path.startsWith('/api/bridge/')) {
      const hash = crypto.createHash('sha256').update(headerKey).digest('hex');
      const connection = stateService.findActiveCdsConnectionByLongTokenHash(hash);
      if (connection && connection.scopes.includes('instance:read')) {
        stateService.updateCdsConnection(connection.id, { lastUsedAt: new Date().toISOString() });
        return {
          id: `cds-connection:${connection.id}`,
          agentName: `MAP (${connection.partnerName || connection.partnerId || connection.id})`,
          token: headerKey,
          approvedAt: connection.activatedAt || connection.createdAt,
          expiresAt: connection.longTokenExpiresAt || '',
        };
      }
    }
    // Project-scoped Agent Key (cdsp_<slugHead>_<suffix>). Matches the
    // per-project store seeded via POST /api/projects/:id/agent-keys;
    // returns a synthetic session AND stamps req.cdsProjectKey so the
    // project-scoped routes can enforce "this key can only touch its
    // own project" (see assertProjectAccess in routes/projects.ts).
    if (stateService && headerKey.startsWith('cdsp_')) {
      const match = stateService.findAgentKeyForAuth(headerKey);
      if (match) {
        stateService.touchAgentKeyLastUsed(match.projectId, match.keyId);
        (req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } })
          .cdsProjectKey = match;
        return {
          id: `projkey:${match.keyId}`,
          agentName: `AI (project key ${match.projectId})`,
          token: headerKey,
          approvedAt: '',
          expiresAt: '',
        };
      }
    }
    // Global (bootstrap-equivalent) Agent Key (cdsg_<suffix>). Behaves
    // like the static AI_ACCESS_KEY: no project scoping, free to hit
    // POST /api/projects and cross-project routes. The UI must warn
    // the user before issuing one (see agent-key-modal.js bootstrap
    // confirmation). NOT stamping cdsProjectKey on purpose.
    if (stateService && headerKey.startsWith('cdsg_')) {
      const match = stateService.findGlobalAgentKeyForAuth(headerKey);
      if (match) {
        stateService.touchGlobalAgentKeyLastUsed(match.keyId);
        return {
          id: `globalkey:${match.keyId}`,
          agentName: `AI (global key ${match.keyId})`,
          token: headerKey,
          approvedAt: '',
          expiresAt: '',
        };
      }
    }
  }

  // Dynamic mode: approved pairing token
  const aiToken = req.headers['x-cds-ai-token'] as string | undefined;
  if (aiToken) {
    for (const session of approvedAiSessions.values()) {
      if (session.token === aiToken && new Date(session.expiresAt) > new Date()) {
        return session;
      }
    }
  }
  return null;
}

export function createServer(deps: ServerDeps): express.Express {
  const app = express();
  const scheduledJobService = new ScheduledJobService({
    stateService: deps.stateService,
    shell: deps.shell,
    config: { masterPort: deps.config.masterPort, repoRoot: deps.config.repoRoot },
  });
  scheduledJobService.start();
  app.set('etag', false);            // Disable ETag — prevents 304 on API polling (CDS is a dev tool, caching is misleading)
  // `/_cds/api/*` is the control-plane passthrough path used by preview
  // pages and the dashboard when `/api/*` might be claimed by a branch app.
  // The forwarder already strips `/_cds`; direct master traffic must do the
  // same before body parsing/routing, otherwise Express falls through to the
  // React SPA and returns HTML for an API request.
  app.use((req, _res, next) => {
    const url = req.url || '';
    if (url === '/_cds/api' || url.startsWith('/_cds/api/')) {
      req.url = url.slice('/_cds'.length) || '/api';
    }
    next();
  });
  // `verify` is called with the raw buffer before body-parser parses it.
  // We stash the bytes on req.rawBody so the GitHub webhook route can
  // HMAC-verify the exact payload GitHub signed (re-serialized JSON
  // would produce a different hash and fail signature checks).
  // 全局 JSON body 解析器（默认上限 100kb）。/api/reports 例外：验收报告正文
  // 可达数 MB（HTML/Markdown 粘贴），其路由自带 12mb 的 json/text/multipart 解析器，
  // 故这里跳过 /api/reports，避免大报告在全局 100kb 解析器处被 413 拦掉（修复 PR #865
  // codex P2「大粘贴报告绕不过全局 JSON 解析器」）。rawBody 仅签名校验类路由需要，
  // /api/reports 不需要。
  const globalJsonParser = express.json({
    verify: (req, _res, buf) => {
      (req as { rawBody?: Buffer }).rawBody = buf;
    },
  });
  app.use((req, res, next) => {
    if (req.path === '/api/reports' || req.path.startsWith('/api/reports/')) return next();
    return globalJsonParser(req, res, next);
  });

  // ── Liveness / readiness probe (public, no auth) ──
  // Used by:
  //   1. Dockerfile HEALTHCHECK
  //   2. Nginx upstream health check
  //   3. systemd WatchdogSec (future)
  //   4. Load balancer active health probes
  //   5. exec_cds.sh restart — post-start self-probe that fails the deploy
  //      if any user-facing route is broken (catches the "process is up but
  //      /project-list returns 404" class of regression).
  //
  // Returns 200 when ALL of these are healthy:
  //   - state file readable
  //   - Docker socket reachable
  //   - the React SPA can be served from `web/dist/index.html`. Legacy
  //     static pages are no longer a runtime fallback; if the React build is
  //     missing, user-facing dashboard routes should be considered unhealthy.
  //   - critical SPA routes are registered on the Express router (catches
  //     regressions where a refactor accidentally drops the route handler).
  //   - (optional, when ?probe=routes) internal HTTP probe of the listening
  //     port confirms each critical route returns 200 + text/html.
  //
  // Returns 503 with the failing checks JSON-encoded so upstream knows
  // exactly what's wrong without having to SSH in.
  // See doc/design.cds.resilience.md Phase 2 + .claude/rules/cds-first-verification.md.
  //
  app.get('/healthz', async (req, res) => {
    // ?lightweight=1 跳过所有 shell + fs check,只回最轻的 200 ok,
    // 给监控/forwarder 探活用,避免 docker / fs 调用拖慢心跳。
    if (req.query.lightweight === '1') {
      res.json({
        ok: true,
        port: deps.config.masterPort,
      });
      return;
    }

    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    let overallOk = true;

    // Check 1: state readable — plus 暴露 backing store kind 到 detail
    // 供"Mongo 模式是否真正生效"这类无认证诊断。不泄漏 URI/credentials。
    try {
      const state = deps.stateService.getState();
      const backing = deps.stateService.getBackingStore();
      checks.state = {
        ok: true,
        detail: `branches=${Object.keys(state.branches).length}, backend=${backing.kind}`,
      };
    } catch (err) {
      checks.state = { ok: false, detail: (err as Error).message };
      overallOk = false;
    }

    // Check 2: docker reachable (use a lightweight `docker version --format` call)
    try {
      const result = await deps.shell.exec('docker version --format "{{.Server.Version}}"', { timeout: 3000 });
      checks.docker = {
        ok: result.exitCode === 0,
        detail: result.exitCode === 0 ? result.stdout.trim() : result.stderr.trim(),
      };
      if (result.exitCode !== 0) overallOk = false;
    } catch (err) {
      checks.docker = { ok: false, detail: (err as Error).message };
      overallOk = false;
    }

    // Check 3: React SPA assets present — file-system level. Catches the
    // case where a self-update pulled new dashboard code without rebuilding,
    // or a docker volume mount points at the wrong path.
    const reactIndex = path.resolve(__dirname, '..', 'web', 'dist', 'index.html');
    const reactExists = fs.existsSync(reactIndex);
    checks.reactDist = reactExists
      ? { ok: true, detail: reactIndex }
      : { ok: false, detail: `missing ${reactIndex}` };
    if (!reactExists) {
      checks.spaServable = {
        ok: false,
        detail: 'React dist missing — dashboard routes will 404',
      };
      overallOk = false;
    } else {
      checks.spaServable = { ok: true };
    }

    // Check 4: critical SPA routes are registered on the Express router.
    // The React catch-all owns all non-API dashboard paths, so a wildcard
    // handler is enough to prove deep links can reach the SPA shell.
    const registeredPaths = collectRegisteredPaths(app);
    const expectedSpaPaths = ['/project-list', '/branch-list', '/cds-settings', '/task-schedule'];
    const missingRoutes = expectedSpaPaths.filter((p) => {
      // Either an exact match, or a wildcard ('*') is registered (the SPA fallback)
      return !registeredPaths.has(p) && !registeredPaths.has('*');
    });
    if (missingRoutes.length > 0) {
      checks.routesRegistered = {
        ok: false,
        detail: `missing handlers for ${missingRoutes.join(', ')} — installSpaFallback() may not have been called`,
      };
      overallOk = false;
    } else {
      checks.routesRegistered = {
        ok: true,
        detail: `${expectedSpaPaths.length}/${expectedSpaPaths.length} critical routes registered`,
      };
    }

    // Check 5: optional deep HTTP probe — exercise each critical route the
    // same way nginx does. Skipped by default (single /healthz roundtrip
    // should be cheap) but exec_cds.sh restart passes ?probe=routes to
    // catch middleware-order bugs and content-type regressions.
    if (req.query.probe === 'routes' || req.query.probe === '1') {
      const port = deps.config.masterPort;
      const probed = await Promise.all(
        expectedSpaPaths.map((p) => probeRouteHttp(port, p)),
      );
      const probeDetail: Record<string, { ok: boolean; status: number; contentType: string; detail?: string }> = {};
      let probeOk = true;
      for (const r of probed) {
        probeDetail[r.path] = {
          ok: r.ok,
          status: r.status,
          contentType: r.contentType,
          detail: r.detail,
        };
        if (!r.ok) probeOk = false;
      }
      checks.routesHttp = probeOk
        ? { ok: true, detail: `probed ${expectedSpaPaths.length} routes, all 200 + html` }
        : { ok: false, detail: JSON.stringify(probeDetail) };
      if (!probeOk) overallOk = false;
    }

    res.status(overallOk ? 200 : 503).json({
      ok: overallOk,
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Host stats (public, no auth) — real-time host memory + CPU ──
  //
  // Used by the Dashboard footer widget for a "pulse" display of the machine
  // beneath CDS. Separate from /api/branches `capacity` field which only
  // knows container count, not host memory/CPU load.
  //
  // Returned fields:
  //   mem.totalMB       — os.totalmem() / 1024 / 1024
  //   mem.freeMB        — os.freemem() / 1024 / 1024 (NOT "available" — kernel-specific)
  //   mem.usedPercent   — (total - free) / total × 100
  //   cpu.cores         — os.cpus().length
  //   cpu.loadAvg1      — 1-minute load average (unix only; 0 on Windows)
  //   cpu.loadPercent   — loadAvg1 / cores × 100 (rough "how busy is the CPU")
  //   uptimeSeconds     — os.uptime()
  //
  // Polled by the frontend every 5s. Cheap enough to not need caching.
  // See doc/design.cds.resilience.md §八.
  app.get('/api/host-stats', (_req, res) => {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = totalBytes - freeBytes;
    const totalMB = Math.round(totalBytes / (1024 * 1024));
    const freeMB = Math.round(freeBytes / (1024 * 1024));
    const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;

    const cores = os.cpus().length || 1;
    const loadAvg = os.loadavg(); // [1m, 5m, 15m] — 0 on Windows
    const loadPercent = Math.round((loadAvg[0] / cores) * 100);

    res.json({
      mem: {
        totalMB,
        freeMB,
        usedPercent,
      },
      cpu: {
        cores,
        loadAvg1: Number(loadAvg[0].toFixed(2)),
        loadAvg5: Number(loadAvg[1].toFixed(2)),
        loadAvg15: Number(loadAvg[2].toFixed(2)),
        loadPercent,
      },
      uptimeSeconds: Math.round(os.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // Assign a request id before auth so 401/403/400 responses are also
  // traceable from browser Network details and systemd logs.
  app.use('/api', (req, res, next) => {
    const existing = String(req.headers['x-cds-request-id'] || '').trim();
    const requestId = existing || createRequestId();
    (req as any).cdsRequestId = requestId;
    res.locals.cdsRequestId = requestId;
    if (!res.getHeader('X-CDS-Request-Id')) {
      res.setHeader('X-CDS-Request-Id', requestId);
    }
    if (!res.getHeader('X-Cds-Cli-Latest')) {
      const latestCdsCliVersion = readBundledCdsCliVersion(deps.config.repoRoot);
      if (latestCdsCliVersion) {
        res.setHeader('X-Cds-Cli-Latest', latestCdsCliVersion);
      }
    }
    res.once('finish', () => {
      if (res.statusCode < 400) return;
      if ((res.locals as { cdsActivityLogged?: boolean }).cdsActivityLogged) return;
      // eslint-disable-next-line no-console
      console.warn('[api] request failed before activity middleware', {
        requestId,
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        remoteAddr: (req.headers['cf-connecting-ip'] as string)
          || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
          || req.ip
          || req.socket?.remoteAddress,
        referer: req.headers['referer'] || req.headers['origin'],
        userAgent: req.headers['user-agent'],
      });
    });
    next();
  });

  // Persistent HTTP log for master/dashboard requests. This intentionally
  // writes one Mongo document per request, never an array inside cds_state.
  app.use((req, res, next) => {
    const requestId =
      (req as any).cdsRequestId
      || String(req.headers['x-cds-request-id'] || '').trim()
      || createRequestId();
    (req as any).cdsRequestId = requestId;
    res.locals.cdsRequestId = requestId;
    if (!res.getHeader('X-CDS-Request-Id')) {
      res.setHeader('X-CDS-Request-Id', requestId);
    }

    const start = Date.now();
    const requestKind = classifyHttpRequestKind({
      layer: 'master',
      method: req.method || 'GET',
      path: req.originalUrl || req.url || '/',
      headers: req.headers,
    });
    const activeRequestId = deps.httpLogStore?.beginActive?.({
      layer: 'master',
      requestKind,
      requestId,
      method: req.method || 'GET',
      protocol: String(req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0] || undefined,
      host: String(req.headers.host || ''),
      path: req.originalUrl || req.url || '/',
      remoteAddr: getRemoteAddr(req),
      request: {
        headers: redactHeaders(req.headers),
      },
    });
    let activeCompleted = false;
    let activeCleanupTimer: ReturnType<typeof setTimeout> | null = null;
    const completeActiveRequest = () => {
      if (activeCompleted || !activeRequestId) return;
      activeCompleted = true;
      if (activeCleanupTimer) {
        clearTimeout(activeCleanupTimer);
        activeCleanupTimer = null;
      }
      deps.httpLogStore?.completeActive?.(activeRequestId);
    };
    const scheduleActiveCleanup = () => {
      if (activeCompleted || !activeRequestId || activeCleanupTimer) return;
      activeCleanupTimer = setTimeout(completeActiveRequest, 60_000);
      activeCleanupTimer.unref?.();
    };
    const requestCapture = createBodyCapture(undefined, req.headers['content-type']);
    req.on('data', (chunk: Buffer | string) => requestCapture.onChunk(chunk));
    const responseCapture = createBodyCapture();
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    (res as any).write = function (chunk: unknown, ...args: unknown[]) {
      if (chunk != null) responseCapture.onChunk(chunk as Buffer | string);
      return origWrite(chunk as never, ...(args as never[]));
    };
    (res as any).end = function (chunk?: unknown, ...args: unknown[]) {
      if (chunk != null) responseCapture.onChunk(chunk as Buffer | string);
      if (!res.headersSent) {
        const dur = Math.max(0, Date.now() - start);
        const existing = res.getHeader('Server-Timing');
        const value = `app;dur=${dur}`;
        res.setHeader('Server-Timing', existing ? `${existing}, ${value}` : value);
      }
      return origEnd(chunk as never, ...(args as never[]));
    };

    res.once('finish', () => {
      completeActiveRequest();
      const status = res.statusCode || 0;
      const capturedReqBody = requestCapture.snapshot(req.headers['content-type']);
      const parsedReqBody = bodyPreviewFromUnknown(req.body, req.headers['content-type']);
      const reqBody = capturedReqBody.bodyBytes > 0 ? capturedReqBody : parsedReqBody;
      const responseHeaders = redactHeaders(res.getHeaders() as Record<string, unknown>);
      const respBody = responseCapture.snapshot(res.getHeader('content-type'));
      deps.httpLogStore?.record({
        layer: 'master',
        requestKind,
        requestId,
        method: req.method || 'GET',
        protocol: String(req.headers['x-forwarded-proto'] || req.protocol || '').split(',')[0] || undefined,
        host: String(req.headers.host || ''),
        path: req.originalUrl || req.url || '/',
        status,
        durationMs: Date.now() - start,
        outcome: status >= 500 ? 'server-error' : status >= 400 ? 'client-error' : 'ok',
        remoteAddr: (req.headers['cf-connecting-ip'] as string)
          || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
          || req.ip
          || req.socket?.remoteAddress,
        request: {
          headers: redactHeaders(req.headers),
          ...reqBody,
        },
        response: {
          headers: responseHeaders,
          ...respBody,
        },
      });
    });
    res.once('close', scheduleActiveCleanup);
    next();
  });

  app.post('/api/client-events', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
    const type = shortText(body.type, 80) || 'client-event';
    const message = shortText(body.message) || 'CDS dashboard client event';
    const pathValue = shortText(body.path, 300);
    deps.serverEventLogStore?.record({
      category: 'system',
      severity: type === 'render-error' ? 'error' : 'warn',
      source: 'dashboard-client',
      action: `app.frontend.${type}`,
      message,
      requestId: (res.locals as { cdsRequestId?: string }).cdsRequestId || (req as any).cdsRequestId || null,
      error: {
        message,
      },
      details: {
        path: pathValue,
        userAgent: shortText(body.userAgent, 300),
        timestamp: shortText(body.timestamp, 80),
        stack: shortText(body.stack, 3000),
        componentStack: shortText(body.componentStack, 3000),
      },
    });
    res.status(202).json({ ok: true });
  });

  // ── Switch domain middleware (before auth) ──
  const switchDomain = deps.config.switchDomain?.toLowerCase();
  if (switchDomain) {
    app.use((req, res, next) => {
      const host = (req.headers.host || '').split(':')[0].toLowerCase();
      if (host === switchDomain) {
        deps.proxyService.handleSwitchFromExpress(req, res);
        return;
      }
      next();
    });
  }

  // ── Auth middleware ──
  //
  // CDS_AUTH_MODE selects the authentication strategy:
  //   - 'disabled' (default): no auth, dashboard open to anyone
  //   - 'basic':    legacy CDS_USERNAME/CDS_PASSWORD cookie auth
  //   - 'github':   GitHub OAuth via /api/auth/github/* routes (P2)
  //
  // Backward compatibility: if CDS_AUTH_MODE is unset and the legacy
  // CDS_USERNAME + CDS_PASSWORD env vars are present, default to 'basic'
  // so existing deployments keep working without an explicit toggle.
  // See doc/design.cds.multi-project.md section 七.
  const cdsUser = process.env.CDS_USERNAME;
  const cdsPass = process.env.CDS_PASSWORD;
  const rawAuthMode = (process.env.CDS_AUTH_MODE || '').toLowerCase();
  const authMode: 'disabled' | 'basic' | 'github' =
    rawAuthMode === 'github' ? 'github' :
    rawAuthMode === 'basic' ? 'basic' :
    rawAuthMode === 'disabled' ? 'disabled' :
    (cdsUser && cdsPass) ? 'basic' : 'disabled';
  const authEnabled = authMode === 'basic';
  const validToken = authEnabled ? makeToken(cdsUser!, cdsPass!) : '';

  // ── AI pairing endpoints (before auth, some are public) ──
  // POST /api/ai/request-access — AI agent requests pairing (public)
  app.post('/api/ai/request-access', (req, res) => {
    const { agentName, purpose } = req.body || {};
    if (!agentName) { res.status(400).json({ error: 'agentName is required' }); return; }

    const id = crypto.randomBytes(8).toString('hex');
    const request: AiPairingRequest = {
      id,
      agentName: String(agentName).slice(0, 100),
      purpose: String(purpose || '').slice(0, 500),
      createdAt: new Date().toISOString(),
      ip: (req.headers['cf-connecting-ip'] as string) ||
          (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          (req.headers['x-real-ip'] as string) ||
          req.ip || req.socket.remoteAddress || 'unknown',
    };
    pendingAiRequests.set(id, request);

    // Notify dashboard via SSE
    broadcastAiPairing('new-request', request);
    console.log(`  [AI Pairing] New request: ${agentName} (${id})`);

    // Auto-expire after 5 minutes if not approved
    setTimeout(() => {
      if (pendingAiRequests.has(id)) {
        pendingAiRequests.delete(id);
        broadcastAiPairing('request-expired', { id });
      }
    }, 5 * 60 * 1000);

    res.json({ requestId: id, message: '配对请求已发送，请在 CDS Dashboard 中批准', expiresIn: 300 });
  });

  // GET /api/ai/request-status/:id — AI agent polls for approval status (public)
  app.get('/api/ai/request-status/:id', (req, res) => {
    const { id } = req.params;
    if (pendingAiRequests.has(id)) {
      res.json({ status: 'pending' });
      return;
    }
    // Check if approved
    const session = approvedAiSessions.get(id);
    if (session) {
      res.json({ status: 'approved', token: session.token, expiresAt: session.expiresAt });
      return;
    }
    res.json({ status: 'expired_or_rejected' });
  });

  // ── GitHub OAuth mode (P2) ──
  //
  // When CDS is started with CDS_AUTH_MODE=github, this block wires up
  // the OAuth routes and mounts a session-gate middleware. The middleware
  // redirects unauthenticated HTML requests to /login and rejects
  // unauthenticated API requests with 401. See:
  //   - cds/src/services/auth-service.ts
  //   - cds/src/middleware/github-auth.ts
  //   - doc/design.cds.multi-project.md section 七
  //   - doc/plan.cds.multi-project-phases.md P2
  //
  // P2 uses an in-memory AuthStore; P3 will swap it out for a MongoDB
  // implementation behind the same interface, no consumer changes required.
  if (authMode === 'github') {
    const ghClientId = process.env.CDS_GITHUB_CLIENT_ID;
    const ghClientSecret = process.env.CDS_GITHUB_CLIENT_SECRET;
    if (!ghClientId || !ghClientSecret) {
      throw new Error(
        'CDS_AUTH_MODE=github requires CDS_GITHUB_CLIENT_ID and CDS_GITHUB_CLIENT_SECRET to be set',
      );
    }
    const allowedOrgs = (process.env.CDS_ALLOWED_ORGS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const publicBaseUrl =
      process.env.CDS_PUBLIC_BASE_URL || `http://localhost:${deps.config.masterPort}`;
    const cookieSecure = publicBaseUrl.startsWith('https://');

    // FU-02: use the pre-initialised mongo backend when provided by index.ts,
    // otherwise fall back to the in-process memory store (default / test).
    const authStore: AuthStore = deps.authStore ?? new MemoryAuthStore();
    const githubClient = new GitHubOAuthClient({
      clientId: ghClientId,
      clientSecret: ghClientSecret,
    });
    const authService = new AuthService({
      store: authStore,
      github: githubClient,
      config: { allowedOrgs },
    });

    app.use(
      '/api',
      createAuthRouter({
        authService,
        publicBaseUrl,
        cookieSecure,
      }),
    );

    // P5: workspace management API (requires github auth mode + valid session)
    const workspaceService = new WorkspaceService({
      store: authStore,
      github: githubClient,
    });
    app.use('/api/workspaces', createWorkspacesRouter({ workspaceService }));

    // resolveAgentKey 让 cdsp_/cdsg_/静态 AI key 在 github 模式下与人类会话同等
    // 放行（cookie 优先，无会话才认 key），并为 cdsp_ 戳 req.cdsProjectKey，使
    // /api/reports 等按项目作用域生效（PR #865 Codex P2，用户确认"都兼得"）。
    app.use(createGithubAuthMiddleware({
      authService,
      resolveAgentKey: (req) => resolveAiSession(req, deps.stateService),
    }));

    // Local username + password routes. Public endpoints (login / bootstrap)
    // are whitelisted in github-auth.ts PUBLIC_PATHS so they pass the gate;
    // authed endpoints (change-password / users / activity) read req.cdsUser
    // attached by the gate above — hence mounted AFTER the middleware.
    // 仅在持久化(mongo)后端开放首启 bootstrap：易失(memory)后端重启即清空，公开
    // bootstrap 会在每次重启后重新开放，github 模式下首个访客即可自封 system owner
    // （PR #865 Codex P1）。
    const bootstrapAllowed = !(authStore instanceof MemoryAuthStore);
    app.use('/api', createAuthLocalRouter({ authService, cookieSecure, bootstrapAllowed }));

    // Expose the authService so downstream routers can record user activity
    // at high-value touchpoints (deploy / stop / publish / report) when a
    // session user is in scope. Optional — readers must null-check.
    app.locals.cdsAuthService = authService;

    console.log(
      `  Auth: github mode (allowedOrgs: ${allowedOrgs.join(',') || '(any GitHub login allowed)'})`,
    );
  }

  if (authEnabled) {
    app.post('/api/login', (req, res) => {
      const { username, password } = req.body || {};
      if (username === cdsUser && password === cdsPass) {
        res.setHeader('Set-Cookie', `cds_token=${validToken}; Path=/; Max-Age=${30 * 86400}; SameSite=Lax; HttpOnly`);
        res.json({ success: true });
      } else {
        res.status(401).json({ error: '用户名或密码错误' });
      }
    });

    app.post('/api/logout', (_req, res) => {
      res.setHeader('Set-Cookie', 'cds_token=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly');
      res.json({ success: true });
    });

    app.use((req, res, next) => {
      if (req.path === '/') return next();
      if (req.path === '/login' || req.path === '/login.html' || req.path === '/api/login' || req.path === '/api/logout') return next();
      // basic 模式下本地账号路由(github 模式才挂载)未注册：放行让其落到 404，
      // 登录页据 404 回退到 /api/login，保住单用户 basic 部署仍可登录(修复 PR #865
      // codex P1「basic-auth 登录回退被 401 截断」)。
      if (req.path === '/api/auth/login' || req.path === '/api/auth/bootstrap' || req.path === '/api/auth/bootstrap-status') return next();
      if (req.path.startsWith('/api/ai/request-access') || req.path.startsWith('/api/ai/request-status/')) return next();
      // 被动授权:免密发起/轮询授权申请(github 模式同样放行,否则 agent 401)。
      if (isPublicAccessRequestRoute(req.method, req.path)) return next();
      if (req.path === '/api/cds-system/connections/authorize'
        || req.path === '/api/cds-system/connections/token'
        || req.path === '/api/cds-system/connections/accept') return next();
      // GitHub webhook is public — it's authenticated by HMAC signature
      // verification inside the handler, not by the cookie/token middleware.
      if (req.method === 'POST' && req.path === '/api/github/webhook') return next();
      // E6 验收报告匿名分享：`/r/:token` 由 token 自鉴权（不可枚举随机串），公开只读。
      if (req.method === 'GET' && /^\/r\/[^/]+$/.test(req.path)) return next();
      // 验收报告图片资源：name 为内容寻址 sha256+扩展名（不可枚举），公开只读，
      // 供跨源（如 MAP 知识库）渲染报告时直接加载正文里的截图。
      if (req.method === 'GET' && req.path.startsWith('/api/reports/assets/')) return next();
      // WS3 MAP-KBTP peer-sync 协议端点：由配对码 / HMAC 自鉴权（路由内校验），放行登录网关。
      // 放行整个 /api/peer-sync/ 前缀（admin 除外）——含 MAP 发起方探测的 handshake/confirm、
      // finalize、cancel 等子路径，必须落到 peer-sync 路由（CDS 是单阶段 peer，confirm/finalize
      // 返回 404 让 MAP 识别为 legacy peer 继续配对），而不是被登录网关拦成 401——401 会使 MAP 的
      // legacy 判定（依赖 404，见 prd-api AdminPeerNodesController）失效而取消配对。协议端点各自
      // 在路由内做配对码 / HMAC 鉴权；`/api/peer-sync/admin/*` 不放行，管理端点仍需 CDS 登录。
      if (req.path.startsWith('/api/peer-sync/') && !req.path.startsWith('/api/peer-sync/admin/')) return next();
      if (/\.(css|js|ico|png|svg|woff2?)$/i.test(req.path)) return next();
      // Allow internal requests from widget proxy (/_cds/ → master)
      if (req.headers['x-cds-internal'] === '1') {
        const remoteIp = req.socket.remoteAddress || '';
        const isLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
        const url = req.url || '';
        const reqMethodUpper = (req.method || 'GET').toUpperCase();

        // ── SECURITY U/V (2026-05-10): resolve source project from preview host ──
        //
        // The /_cds proxy injects `x-cds-source-host` carrying the original
        // preview host (e.g. `main-prd-agent.miduo.org`). We strip the
        // configured root domain and find the project whose `slug` is the
        // longest suffix of the remaining label. The result is stashed on
        // `req._cdsSourceProject` for downstream:
        //   - bug U: per-deploy scope check (project A widget can't deploy B)
        //   - bug V: response-body filter on /api/branches and /api/projects
        //     (project A widget only sees its own services, not B/C's)
        //
        // If we cannot resolve a source project (host header missing, bad
        // suffix), the bypass falls back to "deny new endpoints, keep
        // pre-fix behavior on existing ones" — never silently widen scope.
        const sourceHost = String(req.headers['x-cds-source-host'] || '').toLowerCase();
        const explicitSourceProjectId = String(req.headers['x-cds-source-project-id'] || '').trim();
        const explicitSourceBranchId = String(req.headers['x-cds-source-branch-id'] || '').trim();
        let sourceProjectId: string | null = null;
        let sourceProjectSlug: string | null = null;
        if (explicitSourceProjectId) {
          const project = deps.stateService.getProject(explicitSourceProjectId);
          if (project) {
            sourceProjectId = project.id;
            sourceProjectSlug = project.slug || project.id;
          }
        }
        if (!sourceProjectId && explicitSourceBranchId) {
          const branch = deps.stateService.getBranch(explicitSourceBranchId);
          const branchProjectId = branch?.projectId || (branch ? 'default' : null);
          const project = branchProjectId ? deps.stateService.getProject(branchProjectId) : null;
          if (project) {
            sourceProjectId = project.id;
            sourceProjectSlug = project.slug || project.id;
          }
        }
        if (sourceHost) {
          const hostNoPort = sourceHost.split(':')[0];
          // Strip any of the configured root domains. We don't have direct
          // access to proxy.config.rootDomains here, but the host always ends
          // in a known suffix that the proxy already validated upstream — we
          // just need the label portion before `.miduo.org` / `.example.com`.
          // Strategy: try every project's slug; pick the one that is either
          // exactly `hostNoPort` after stripping `.<something>`, or appears
          // as `-<slug>.<root>` suffix. We match by trying the longest slug
          // first against the full hostNoPort string.
          const projects = deps.stateService.getProjects();
          // Sort by slug length descending so multi-word slugs win over
          // their prefixes (e.g. `prd-agent` over `prd`).
          const sortedSlugs = [...projects]
            .filter((p) => p.slug)
            .sort((a, b) => b.slug.length - a.slug.length);
          if (!sourceProjectId) {
            for (const p of sortedSlugs) {
              // Match `-<slug>.` (preview v3) or `<slug>.` (single-segment host)
              // anywhere in the hostNoPort. We want the slug to be a complete
              // dash-bounded token immediately before the first `.` (root).
              const dotIdx = hostNoPort.indexOf('.');
              const before = dotIdx >= 0 ? hostNoPort.slice(0, dotIdx) : hostNoPort;
              if (before === p.slug || before.endsWith('-' + p.slug)) {
                sourceProjectId = p.id;
                sourceProjectSlug = p.slug;
                break;
              }
            }
          }
        }
        (req as any)._cdsSourceProject = { projectId: sourceProjectId, projectSlug: sourceProjectSlug };

        // Hard deny — even loopback GET is rejected on these endpoints
        const DENY: RegExp[] = [
          /\/effective-env\/reveal/,
          /\/container-exec/,
          /\/factory-reset/,
          /\/self-update/,
          /\/storage-mode\/switch/,
          /\/cleanup(\?|$)/,
          /\/cleanup-orphans/,
          /\/cleanup-cross-project-services/,
          /\/prune-stale-branches/,
          /\/api\/env/,            // global/project env read+write (incl. reveal)
          /\/api\/projects\/[^/]+\/agent-keys/,
          /\/api\/global-agent-keys/,
          /\/api\/cluster\/(issue-token|join|strategy)/,
          /\/api\/cds-system\/connections\/(issue|accept)/,
          /\/api\/import-and-init/,
          /\/api\/import-config/,
          /\/api\/snapshots\/[^/]+\/rollback/,
        ];
        // GET allowlist — what the widget actually needs
        const ALLOW_GET: RegExp[] = [
          /^\/api\/branches(\?|$)/,
          /^\/api\/branches\/[^/]+(\?|$)/,
          /^\/api\/branches\/[^/]+\/(metrics|profile-overrides|effective-env)(\?|$)/,
          /^\/api\/branches\/stream/,
          /^\/api\/build-profiles(\?|$)/,
          /^\/api\/projects(\?|$)/,
          /^\/api\/projects\/[^/]+(\?|$)/,
          /^\/api\/activity-stream/,
          /^\/api\/config(\?|$)/,
          /^\/api\/me(\?|$)/,
          /^\/api\/auth\/status/,
          /^\/api\/cli-version/,
          /^\/api\/check-updates/,
          /^\/api\/bridge\/(check|navigate-requests|handshake-requests)/,
        ];
        // POST allowlist — widget log panel / bridge
        //
        // SECURITY U (2026-05-10): /api/branches/:id/deploy and
        // /api/branches/:id/deploy/:profile are back in this list so a
        // widget can "one-click redeploy" its OWN branch — but every match
        // is then gated by a per-request check that branch.projectId ===
        // source project resolved from the preview host. Cross-project
        // deploys (project A's widget asking for project B's branch) get
        // 403 forbidden_cross_project_deploy. cdscli flows are unaffected
        // because they don't carry x-cds-internal at all (they hit cookie
        // / X-AI-Access-Key auth instead).
        //
        // Historical context: PR #577 (P0.5) pulled these out entirely
        // because the bypass had no way to enforce ownership. Now that
        // resolveSourceProject + per-branch projectId check are in place,
        // we re-allow with a real scope guard.
        const ALLOW_POST: RegExp[] = [
          /^\/api\/branches\/[^/]+\/container-logs(\?|$)/,
          /^\/api\/branches\/[^/]+\/deploy(\?|$)/,
          /^\/api\/branches\/[^/]+\/deploy\/[^/]+/,
          /^\/api\/branches\/[^/]+\/stop(\?|$)/,
          /^\/api\/bridge\/(heartbeat|result|end-session|dismiss|approve|reject)/,
        ];
        const ALLOW_PUT: RegExp[] = [
          /^\/api\/build-profiles\/[^/]+\/deploy-mode/,
        ];
        const ALLOW_DELETE: RegExp[] = [
          /^\/api\/branches\/[^/]+(\?|$)/,
        ];

        const denied = DENY.some((re) => re.test(url));
        const allowedByMethod =
          (reqMethodUpper === 'GET' && ALLOW_GET.some((re) => re.test(url))) ||
          (reqMethodUpper === 'POST' && ALLOW_POST.some((re) => re.test(url))) ||
          (reqMethodUpper === 'PUT' && ALLOW_PUT.some((re) => re.test(url))) ||
          (reqMethodUpper === 'DELETE' && ALLOW_DELETE.some((re) => re.test(url)));

        if (!isLoopback || denied || !allowedByMethod) {
          res.statusCode = 403;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            error: 'forbidden_internal_bypass',
            reason: !isLoopback ? 'non-loopback' : (denied ? 'deny-listed' : 'not-allowlisted'),
            url: url.replace(/\?.*/, ''),
            method: reqMethodUpper,
          }));
          console.warn('[security] x-cds-internal bypass denied', { remoteIp, method: reqMethodUpper, url });
          return;
        }

        // ── SECURITY AG/AH/AI: unified scope guard ──
        //
        // Catch-all replacement for the previous case-by-case deploy check.
        // Any path that carries a `<branchId>` or `<profileId>` is auto-
        // matched and verified to belong to the source project. This way a
        // newly added branch/profile-scoped widget endpoint is automatically
        // safe — we never need to remember to add a manual scope check.
        //
        // Patterns (by URL shape — we don't care about HTTP method):
        //   /api/branches/<branchId>/...                  → branch
        //   /api/branches/<branchId>                      → branch
        //   /api/bridge/<action>/<branchId>               → branch (check, navigate-requests, handshake-requests, state, command)
        //   /api/build-profiles/<profileId>/...           → profile
        //   /api/build-profiles/<profileId>               → profile
        //
        // Body-only branchId (POST /api/bridge/result) is also checked by
        // peeking at req.body.branchId once express.json has populated it.
        //
        // Endpoints exempt from this guard (no <id> in path, no projectId on
        // the resource, or list endpoints already filtered above):
        //   /api/branches            (list, filtered by branchesListRe)
        //   /api/build-profiles      (list, filtered by buildProfilesListRe)
        //   /api/bridge/heartbeat    (widget→server, server has no concept of project)
        //   /api/bridge/start-session, /api/bridge/end-session (branchId in body — TODO body guard)
        //   /api/bridge/handshake-requests/<reqId>/{approve,reject}
        //   /api/bridge/navigate-requests/<reqId>/dismiss
        //     (the trailing <reqId> here is NOT a branchId — it's an opaque request id;
        //      a reqId→branch lookup follow-up is tracked but not implemented yet)
        const SCOPED_BRANCH_RE: RegExp[] = [
          /^\/api\/branches\/([^/?#]+)(?:[/?]|$)/,
          // /api/bridge/<action>/<branchId> — only the actions whose 2nd segment IS a branchId.
          // approve/reject/dismiss take a reqId there, not a branchId — so we exclude them.
          /^\/api\/bridge\/(?:check|navigate-requests|handshake-requests|state|command)\/([^/?#]+)(?:[/?]|$)/,
        ];
        const SCOPED_PROFILE_RE: RegExp[] = [
          /^\/api\/build-profiles\/([^/?#]+)(?:[/?]|$)/,
        ];

        type GuardResult = { ok: true } | { ok: false; status: number; reason: string; extra?: Record<string, unknown> };

        const guardScopedRequest = (): GuardResult => {
          const pathOnly = url.replace(/\?.*/, '');

          for (const re of SCOPED_BRANCH_RE) {
            const m = re.exec(pathOnly);
            if (m) {
              const branchId = m[1];
              const branch = deps.stateService.getBranch(branchId);
              if (!branch) {
                // Let the route handler return 404 (don't pre-leak).
                return { ok: true };
              }
              const branchProjectId = branch.projectId || 'default';
              if (!sourceProjectId || branchProjectId !== sourceProjectId) {
                return {
                  ok: false,
                  status: 403,
                  reason: !sourceProjectId ? 'source-project-unresolved' : 'forbidden_cross_project_branch',
                  extra: { sourceProjectId, branchProjectId, branchId },
                };
              }
              return { ok: true };
            }
          }

          for (const re of SCOPED_PROFILE_RE) {
            const m = re.exec(pathOnly);
            if (m) {
              const profileId = m[1];
              const profile = deps.stateService.getBuildProfile(profileId);
              if (!profile) {
                return { ok: true };
              }
              const profileProjectId = profile.projectId || 'default';
              if (!sourceProjectId || profileProjectId !== sourceProjectId) {
                return {
                  ok: false,
                  status: 403,
                  reason: !sourceProjectId ? 'source-project-unresolved' : 'forbidden_cross_project_profile',
                  extra: { sourceProjectId, profileProjectId, profileId },
                };
              }
              return { ok: true };
            }
          }

          // POST /api/bridge/result — branchId is in the JSON body, not the path.
          // express.json middleware has already parsed req.body before this
          // middleware runs (json parser is registered earlier in the chain).
          if (reqMethodUpper === 'POST' && /^\/api\/bridge\/result(?:\?|$)/.test(pathOnly)) {
            const bodyBranchId = (req.body && typeof req.body === 'object')
              ? (req.body as Record<string, unknown>).branchId
              : undefined;
            if (typeof bodyBranchId === 'string' && bodyBranchId.length > 0) {
              const branch = deps.stateService.getBranch(bodyBranchId);
              if (branch) {
                const branchProjectId = branch.projectId || 'default';
                if (!sourceProjectId || branchProjectId !== sourceProjectId) {
                  return {
                    ok: false,
                    status: 403,
                    reason: !sourceProjectId ? 'source-project-unresolved' : 'forbidden_cross_project_branch',
                    extra: { sourceProjectId, branchProjectId, branchId: bodyBranchId, via: 'body' },
                  };
                }
              }
            }
          }

          return { ok: true };
        };

        const guardResult = guardScopedRequest();
        if (!guardResult.ok) {
          res.statusCode = guardResult.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            error: guardResult.reason,
            ...(guardResult.extra || {}),
          }));
          console.warn('[security] unified scope guard blocked', {
            remoteIp, method: reqMethodUpper, url,
            ...(guardResult.extra || {}),
          });
          return;
        }

        // ── SECURITY V: response-body filter for branches/projects GET ──
        //
        // The widget should only see entries for its own project. We wrap
        // res.json so that handlers downstream can produce the full list
        // unmodified, then we redact what doesn't belong to the source
        // project before flushing to the wire. Detail GETs for foreign
        // entries are converted to 403 instead of leaking shape/metadata.
        if (reqMethodUpper === 'GET' && sourceProjectId) {
          const pathOnly = url.replace(/\?.*/, '');
          const branchesListRe = /^\/api\/branches$/;
          const branchDetailRe = /^\/api\/branches\/([^/]+)$/;
          const projectsListRe = /^\/api\/projects$/;
          const projectDetailRe = /^\/api\/projects\/([^/]+)$/;
          const buildProfilesListRe = /^\/api\/build-profiles$/;

          const wrap = (filterFn: (body: any) => any) => {
            const origJson = res.json.bind(res);
            (res as any).json = (body: any) => {
              try {
                return origJson(filterFn(body));
              } catch {
                return origJson(body);
              }
            };
          };

          // Accept both project id and slug as valid identifiers for the
          // current source project — a widget loaded from
          // main-mdimp.miduo.org resolves sourceProjectId=<hash> + slug=mdimp,
          // but the widget script may request /api/projects/<slug>.
          // Without slug acceptance the bypass filter would 403 the widget's
          // own project (Bug AD: GET /api/projects/<slug> rejected).
          const matchesSourceProject = (id: string | null | undefined): boolean => {
            if (!id) return false;
            return id === sourceProjectId || id === sourceProjectSlug;
          };

          if (branchesListRe.test(pathOnly)) {
            wrap((body) => {
              if (!body || typeof body !== 'object') return body;
              const arr = Array.isArray(body.branches) ? body.branches : null;
              if (!arr) return body;
              const filtered = arr.filter((b: any) => {
                const pid = b?.projectId || 'default';
                return pid === sourceProjectId;
              });
              return { ...body, branches: filtered };
            });
          } else if (branchDetailRe.test(pathOnly)) {
            const m = branchDetailRe.exec(pathOnly)!;
            const branch = deps.stateService.getBranch(m[1]);
            const bpid = branch?.projectId || (branch ? 'default' : null);
            if (branch && bpid !== sourceProjectId) {
              res.statusCode = 403;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({
                error: 'forbidden_cross_project_branch',
                sourceProjectId,
                branchProjectId: bpid,
              }));
              return;
            }
          } else if (projectsListRe.test(pathOnly)) {
            wrap((body) => {
              if (!body || typeof body !== 'object') return body;
              const arr = Array.isArray(body.projects) ? body.projects : null;
              if (!arr) return body;
              const filtered = arr.filter((p: any) => p?.id === sourceProjectId);
              return { ...body, projects: filtered, total: filtered.length };
            });
          } else if (projectDetailRe.test(pathOnly)) {
            const m = projectDetailRe.exec(pathOnly)!;
            if (!matchesSourceProject(m[1])) {
              res.statusCode = 403;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({
                error: 'forbidden_cross_project_view',
                sourceProjectId,
                requestedProjectId: m[1],
              }));
              return;
            }
          } else if (buildProfilesListRe.test(pathOnly)) {
            // Bug AB (2026-05-10): the widget浮窗 lists "其他项目 service"
            // because `/api/build-profiles` returns the global table for
            // every project. Filter the response body so a widget loaded
            // under preview host main-prd-agent only sees profiles whose
            // projectId matches its own project. Legacy profiles without
            // an explicit projectId are treated as 'default' and only
            // surface for the legacy default project.
            wrap((body) => {
              if (!body || typeof body !== 'object') return body;
              const arr = Array.isArray(body.profiles) ? body.profiles : null;
              if (!arr) return body;
              const filtered = arr.filter((p: any) => {
                const pid = p?.projectId || 'default';
                return pid === sourceProjectId;
              });
              return { ...body, profiles: filtered };
            });
          }
        }

        return next();
      }

      // ── Cluster peer-to-peer endpoints ──
      //
      // These routes authenticate with X-Bootstrap-Token or X-Executor-Token
      // inside the route handler (see scheduler/routes.ts). The cookie-based
      // auth middleware doesn't know about those tokens, and would otherwise
      // reject all cross-node calls with 401 — which is exactly the bug that
      // broke `./exec_cds.sh connect` and the Dashboard's "加入集群" button.
      //
      // We bypass cookie auth for these specific method+path combinations
      // ONLY WHEN a cluster token header is present. This way a Dashboard
      // user (cookie-authenticated, no cluster token) still goes through
      // normal cookie auth — which is required so the Dashboard's
      // "踢出" button can call DELETE /api/executors/:id without hitting
      // the verifyPermanentToken wall downstream.
      //
      // The bypass is tightly scoped — GET /api/executors (list) and
      // /api/cluster/* (dashboard UI) still go through cookie auth.
      //
      // NOTE: local variable is `reqPath` (not `path`) because `path` is
      // already imported as the Node module at the top of this file.
      const reqMethod = req.method;
      const reqPath = req.path;
      const hasClusterToken =
        req.headers['x-bootstrap-token'] !== undefined ||
        req.headers['x-executor-token'] !== undefined;
      if (hasClusterToken) {
        if (reqMethod === 'POST' && reqPath === '/api/executors/register') return next();
        if (reqMethod === 'POST' && /^\/api\/executors\/[^/]+\/heartbeat$/.test(reqPath)) return next();
        if (reqMethod === 'DELETE' && /^\/api\/executors\/[^/]+$/.test(reqPath)) return next();
        if (reqMethod === 'POST' && /^\/api\/executors\/[^/]+\/drain$/.test(reqPath)) return next();
      }

      // MAP/CDS pairing long-token endpoint. The route itself validates that
      // the Bearer ct_ token belongs to the requested shared-service project.
      if (
        reqMethod === 'GET' &&
        /^\/api\/projects\/[^/]+\/instances$/.test(reqPath) &&
        /^Bearer\s+ct_/i.test(String(req.headers['authorization'] || ''))
      ) {
        return next();
      }
      if (
        (
          (reqMethod === 'GET' && /^\/api\/projects\/[^/]+\/runtime-capacity$/.test(reqPath)) ||
          (reqMethod === 'POST' && /^\/api\/projects\/[^/]+\/runtime-capacity\/reconcile$/.test(reqPath))
        ) &&
        /^Bearer\s+ct_/i.test(String(req.headers['authorization'] || ''))
      ) {
        return next();
      }
      if (
        /^\/api\/projects\/[^/]+\/agent-sessions(?:\/.*)?$/.test(reqPath) &&
        /^Bearer\s+ct_/i.test(String(req.headers['authorization'] || ''))
      ) {
        return next();
      }

      // 被动授权 — 发起/轮询授权申请的两个端点是 public(免密)。
      //
      // 这是「最短路径」的代价:agent 没有任何预置凭据也要能发起申请,否则又
      // 退回到「先给 agent 发钥匙」的前置步骤。免密的爆炸半径被严格限制:
      //   - 发起只能创建一条 pending 申请(路由内按项目限量防刷),不读不写不签发;
      //   - 轮询要 pollToken(发起时一次性返回给发起方),拿不到票据就取不走密钥;
      //   - 真正的密钥签发 100% 由用户在右下角亲手点批准。
      // 故这两个路径无条件放行;真正危险的 approve/reject/list 仍走下方鉴权。
      if (isPublicAccessRequestRoute(reqMethod, reqPath)) return next();

      // Check human cookie auth
      const cookieToken = parseCookie(req.headers.cookie || '', 'cds_token');
      const headerToken = req.headers['x-cds-token'] as string | undefined;
      const token = cookieToken || headerToken;
      if (token === validToken) {
        // SECURITY P1 (2026-05-09): stamp a marker so secret-reveal handlers
        // can distinguish human cookie auth (admin-equivalent on this single-
        // tenant CDS) from machine credentials. Static AI_ACCESS_KEY and
        // global cdsg_ keys deliberately do NOT set this — see reveal /
        // customEnv masking in routes/branches.ts and routes/projects.ts.
        (req as any)._cdsCookieAuth = true;
        return next();
      }

      // Check AI session auth
      const aiSession = resolveAiSession(req, deps.stateService);
      if (aiSession) {
        (req as any)._aiSession = aiSession;
        return next();
      }

      if (req.path.startsWith('/api/')) {
        // CDS-CLI-005：让用户/Agent 一眼看清正确的 header 名。历史上反复出现
        // 的错误是用 `ai-access-key`（无 X- 前缀）→ Express 大小写不敏感命中
        // 不到 `x-ai-access-key` → 401 但提示"未登录"，AI 不知道哪里错。
        // 现在 alias 已兼容（见 resolveAiSession），但仍给出明确 hint，避免
        // 旧版客户端在 token 真不对时盲猜。
        const hasAnyKeyHeader =
          !!req.headers['x-ai-access-key'] ||
          !!req.headers['ai-access-key'] ||
          !!req.headers['x-cds-ai-token'] ||
          !!req.headers['authorization'];
        res.status(401).json({
          error: 'unauthorized',
          message: hasAnyKeyHeader
            ? '提供的访问凭据无效或已过期，CDS 拒绝该请求。'
            : '未登录或缺少访问凭据。',
          hint:
            '请在请求头中提供 X-AI-Access-Key（首选） 或 Authorization: Bearer <key>。' +
            '注意 header 名必须含 X- 前缀（兼容别名 ai-access-key / Authorization Bearer，' +
            '但不接受 access-key / cds-key 等其他变体）。',
          acceptedHeaders: [
            'X-AI-Access-Key',
            'Authorization: Bearer <key>',
            'ai-access-key (alias, 不推荐)',
          ],
        });
      } else {
        const target = req.originalUrl || req.url || '/project-list';
        res.redirect(302, `/login?redirect=${encodeURIComponent(target)}`);
      }
    });

    console.log(`  Auth: enabled (user: ${cdsUser})`);
  } else if (authMode === 'disabled') {
    console.warn(
      '  Auth warning: disabled — set CDS_AUTH_MODE=github (+ CDS_GITHUB_CLIENT_ID/SECRET/ALLOWED_ORGS) or CDS_USERNAME/CDS_PASSWORD to enable login',
    );
  }

  if (authMode !== 'github') {
    app.get('/api/me', (_req, res) => {
      const username = authMode === 'basic' ? cdsUser : 'anonymous';
      res.json({
        username,
        user: username,
        authMode,
        authEnabled: authMode !== 'disabled',
      });
    });
  }

  app.get('/api/auth/status', (_req, res) => {
    res.json({
      mode: authMode,
      enabled: authMode !== 'disabled',
      logoutEndpoint: authMode === 'github' ? '/api/auth/logout' : authMode === 'basic' ? '/api/logout' : null,
      user: authMode === 'basic' ? { username: cdsUser } : null,
    });
  });

  // Always stamp req.cdsProjectKey for any request that carries a
  // project-scoped Agent Key, regardless of auth mode. The auth
  // middleware above already does this when enabled; this fallback
  // ensures the enforcement hook (assertProjectAccess in
  // routes/projects.ts) sees the scope even when cookie auth is
  // disabled. Cheap no-op when the header is absent or the key is
  // malformed.
  app.use((req, _res, next) => {
    // CDS-CLI-005：同时支持 `X-AI-Access-Key` / `ai-access-key` / Bearer。
    const h = (req.headers['x-ai-access-key'] as string | undefined)
      || (req.headers['ai-access-key'] as string | undefined)
      || (() => {
          const auth = req.headers['authorization'] as string | undefined;
          if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
          return undefined;
        })();
    if (h && h.startsWith('cdsp_') && !(req as unknown as { cdsProjectKey?: unknown }).cdsProjectKey) {
      const match = deps.stateService.findAgentKeyForAuth(h);
      if (match) {
        deps.stateService.touchAgentKeyLastUsed(match.projectId, match.keyId);
        (req as unknown as { cdsProjectKey?: { projectId: string; keyId: string } })
          .cdsProjectKey = match;
      }
    }
    next();
  });

  // ── /api/self-status: 注册在 auth middleware 之后 + 所有 /api router 之前 ──
  //
  // 用户反复反馈:「点更新后看不出真的更新了没」「/api/self-status 一直 400」。
  // 根因是 11+ 个 router 都挂在 /api,任何一个里有 catch-all 或上层 middleware
  // 抢答都会让请求 4xx/5xx,根本到不了我的 handler。所以放在 router 链 *之前*。
  //
  // **但**(Codex PR #524 P2 反馈)不能再像最初那样放在 auth middleware 之前 ——
  // 那会让 currentBranch / headSha / selfUpdateHistory 在 GitHub 或 cookie 鉴权
  // 部署上变成无认证可读,泄露内部 commit 信息。当前位置:auth + agent key 之后,
  // /api router 之前 —— 鉴权生效 + 仍然抢在 router 链前。
  //
  // 这个版本是「轻量同步」版:只读 git HEAD + 自更新历史 + web build sha,**不**做
  // git fetch(慢、可能挂)。完整版(含 fetch + ahead 计算)仍在 branches.ts 里给
  // 「我要主动检查 GitHub 远端」的 case 用,前端可以两个都打。
  app.get('/api/self-status', async (req, res, next) => {
    // ?probe=remote 走完整版(branches.ts 里的 router handler):做 git fetch +
    // 算 ahead 数。Bugbot PR #524 反馈:之前顶层 handler 无条件抢答,即使带
    // ?probe=remote 也走轻量分支,GlobalUpdateBadge 永远拿到 remoteAheadCount=0,
    // "有更新"角标永远不会亮。next() 让请求继续流到 app.use('/api', router)。
    if (req.query.probe === 'remote') {
      return next();
    }
    const repoRoot = deps.config.repoRoot;
    const degradedReasons: string[] = [];
    const safeExec = async (cmd: string, fallback = ''): Promise<string> => {
      try {
        const r = await deps.shell.exec(cmd, { cwd: repoRoot, timeout: 3000 });
        if (r.exitCode !== 0) {
          degradedReasons.push(`${cmd.slice(0, 40)} exit=${r.exitCode}`);
          return fallback;
        }
        return r.stdout.trim();
      } catch (err) {
        degradedReasons.push(`${cmd.slice(0, 40)}: ${(err as Error).message}`);
        return fallback;
      }
    };
    try {
      const currentBranch = await safeExec('git rev-parse --abbrev-ref HEAD');
      const headSha = await safeExec('git rev-parse --short HEAD');
      const headIso = await safeExec('git log -1 --format=%cI HEAD');

      let history: ReturnType<typeof deps.stateService.getSelfUpdateHistory> = [];
      try {
        history = deps.stateService.getSelfUpdateHistory(20);
      } catch (err) {
        degradedReasons.push(`getSelfUpdateHistory: ${(err as Error).message}`);
      }

      // web bundle SHA — exec_cds.sh 的 build_web 成功后写到 cds/web/dist/.build-sha
      // 文件不在 = build 失败 / dist 缺失 = 用户看到的 UI 是上次成功 build 的 bundle
      let webBuildSha = '';
      let webBuildError = ''; // build_web 失败时 exec_cds.sh 会写 .build-error 标记
      try {
        const shaFile = path.resolve(repoRoot, 'cds', 'web', 'dist', '.build-sha');
        if (fs.existsSync(shaFile)) {
          webBuildSha = fs.readFileSync(shaFile, 'utf8').trim();
        }
        const errFile = path.resolve(repoRoot, 'cds', 'web', 'dist', '.build-error');
        if (fs.existsSync(errFile)) {
          webBuildError = fs.readFileSync(errFile, 'utf8').trim().slice(0, 2000);
        }
      } catch (err) {
        degradedReasons.push(`webBuildSha: ${(err as Error).message}`);
      }
      const bundleFreshness = await computeBundleFreshness({
        repoRoot,
        shell: deps.shell,
        headSha,
        bundleSha: webBuildSha,
        buildError: webBuildError,
      });
      if (bundleFreshness.staleReason === 'diff-failed' || bundleFreshness.staleReason === 'invalid-sha') {
        degradedReasons.push(`bundleFreshness: ${bundleFreshness.detail || bundleFreshness.staleReason}`);
      }
      const pidStartedAt = (globalThis as unknown as { __CDS_PROCESS_STARTED_AT?: string }).__CDS_PROCESS_STARTED_AT || null;
      const lastUpdate = history[0] || null;
      // 与 branches.ts computeSelfStatusSnapshot 的判定保持一致：重启"已确认" =
      // 当前进程的启动时刻晚于本次更新的开始时刻（pidStartedAt >= update.ts）。
      // web-only 更新无需重启 → not_required，不再因 pidStartedAt 恒真而误报 completed。
      const updateMs = lastUpdate?.ts ? Date.parse(lastUpdate.ts) : Number.NaN;
      const pidMs = pidStartedAt ? Date.parse(pidStartedAt) : Number.NaN;
      const restartStatus =
        lastUpdate?.status === 'success' && lastUpdate.updateMode !== 'web-only'
          ? (Number.isFinite(pidMs) && Number.isFinite(updateMs) && pidMs >= updateMs ? 'completed' : 'incomplete')
          : lastUpdate?.status === 'deferred'
            ? 'pending'
            : 'not_required';

      res.json({
        currentBranch,
        headSha,
        headIso,
        // 顶层版不调 git fetch — 远端检查留给 /api/self-status?probe=remote(详见 branches.ts)
        fetchOk: false,
        fetchError: 'top-level lightweight version — call /api/self-status?probe=remote for ahead-check',
        remoteAheadCount: 0,
        localAheadCount: 0,
        remoteAheadSubjects: [],
        runningPid: process.pid,
        pidStartedAt,
        restartStatus,
        lastSelfUpdate: lastUpdate,
        selfUpdateHistory: history,
        webBuildSha,
        webBuildError,
        bundleStale: bundleFreshness.bundleStale,
        bundleFreshness,
        degraded: degradedReasons.length > 0 ? { reasons: degradedReasons } : null,
      });
    } catch (err) {
      // 兜底:即使前面所有 try/catch 都崩,也返 200 让前端不至于显示 "400 banner"。
      res.json({
        currentBranch: '',
        headSha: '',
        headIso: '',
        fetchOk: false,
        fetchError: '',
        remoteAheadCount: 0,
        localAheadCount: 0,
        remoteAheadSubjects: [],
        runningPid: process.pid,
        pidStartedAt: (globalThis as unknown as { __CDS_PROCESS_STARTED_AT?: string }).__CDS_PROCESS_STARTED_AT || null,
        restartStatus: 'not_required',
        lastSelfUpdate: null,
        selfUpdateHistory: [],
        webBuildSha: '',
        webBuildError: '',
        bundleStale: false,
        degraded: { reasons: [`top-level handler caught: ${(err as Error).message}`] },
      });
    }
  });

  // ── AI pairing management (requires auth) ──
  // GET /api/ai/pending — list pending pairing requests
  app.get('/api/ai/pending', (_req, res) => {
    res.json({ requests: Array.from(pendingAiRequests.values()) });
  });

  // POST /api/ai/approve/:id — approve a pairing request
  app.post('/api/ai/approve/:id', (req, res) => {
    const { id } = req.params;
    const request = pendingAiRequests.get(id);
    if (!request) { res.status(404).json({ error: '请求不存在或已过期' }); return; }

    pendingAiRequests.delete(id);
    const token = crypto.randomBytes(32).toString('hex');
    const session: ApprovedAiSession = {
      id,
      agentName: request.agentName,
      token,
      approvedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
    };
    approvedAiSessions.set(id, session);

    broadcastAiPairing('request-approved', { id, agentName: request.agentName });
    broadcastActivity({
      id: ++activitySeq, ts: new Date().toISOString(),
      method: 'AI', path: `批准 ${request.agentName} 连接`,
      status: 200, duration: 0, source: 'user',
    });
    console.log(`  [AI Pairing] Approved: ${request.agentName} (${id}), expires in 24h`);

    res.json({ success: true, session: { id, agentName: session.agentName, expiresAt: session.expiresAt } });
  });

  // POST /api/ai/reject/:id — reject a pairing request
  app.post('/api/ai/reject/:id', (req, res) => {
    const { id } = req.params;
    if (!pendingAiRequests.has(id)) { res.status(404).json({ error: '请求不存在或已过期' }); return; }
    pendingAiRequests.delete(id);
    broadcastAiPairing('request-rejected', { id });
    res.json({ success: true });
  });

  // GET /api/ai/sessions — list active AI sessions
  app.get('/api/ai/sessions', (_req, res) => {
    const now = new Date();
    const active = Array.from(approvedAiSessions.values())
      .filter(s => new Date(s.expiresAt) > now)
      .map(s => ({ id: s.id, agentName: s.agentName, approvedAt: s.approvedAt, expiresAt: s.expiresAt }));
    res.json({ sessions: active });
  });

  // DELETE /api/ai/sessions/:id — revoke an AI session
  app.delete('/api/ai/sessions/:id', (req, res) => {
    approvedAiSessions.delete(req.params.id);
    res.json({ success: true });
  });

  // GET /api/ai/pairing-stream — SSE for dashboard to receive pairing notifications
  app.get('/api/ai/pairing-stream', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });
    aiPairingClients.add(res);
    // Send existing pending requests
    for (const req of pendingAiRequests.values()) {
      res.write(`event: new-request\ndata: ${JSON.stringify(req)}\n\n`);
    }
    // Keepalive heartbeat every 30s to prevent Cloudflare 524 timeout
    const heartbeat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { clearInterval(heartbeat); }
    }, 30_000);
    _req.on('close', () => { aiPairingClients.delete(res); clearInterval(heartbeat); });
  });

  // ── State stream SSE endpoint (server-authority push) ──
  // Pushes full branch state on every save(), so frontend never needs to poll.
  const stateClients = new Set<express.Response>();
  let stateSeq = 0;

  app.get('/api/state-stream', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });
    stateClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { clearInterval(heartbeat); }
    }, 30_000);
    _req.on('close', () => { stateClients.delete(res); clearInterval(heartbeat); });
  });

  // ── Broadcast helpers exposed to index.ts for cluster state changes ──
  //
  // `broadcastState()` is called automatically on every stateService.save()
  // AND manually from the cluster hot-upgrade path when in-memory config
  // changes (mode flip) without a state.json write. Other modules reach it
  // via the exported `broadcastClusterChange()` below.
  //
  // 性能（2026-06-22）：原本 onSave 每次都同步 `JSON.stringify(整个 state)`
  // （含全部分支 + 部署日志）。构建期间 deploy-log 每追加一行就 save() 一次，
  // 一秒内能触发几十次全量序列化，把单线程事件循环钉死 → 仪表盘和所有 /api/*
  // 在构建期间集体卡死（用户反复反馈的"阻塞"根因之一）。
  // 这里把广播改成"前沿即时 + 尾沿合并"节流：突发写入时最多每
  // BROADCAST_MIN_INTERVAL_MS 序列化一次，并保证突发结束后一定补发最终态。
  // SSE 客户端在 200ms 内收敛到最新状态，肉眼无感，但事件循环不再被烤糊。
  const BROADCAST_MIN_INTERVAL_MS = 200;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let broadcastPending = false;
  let lastBroadcastAt = 0;

  function broadcastState(): void {
    if (stateClients.size === 0) return;
    const sinceLast = Date.now() - lastBroadcastAt;
    // 前沿：距上次广播已超过最小间隔且没有挂起的定时器 → 立即发，单次变更零延迟。
    if (!broadcastTimer && sinceLast >= BROADCAST_MIN_INTERVAL_MS) {
      doBroadcastState();
      return;
    }
    // 冷却期内：标记脏 + 安排一次尾沿补发，把突发期的中间态合并掉。
    broadcastPending = true;
    if (!broadcastTimer) {
      const wait = Math.max(0, BROADCAST_MIN_INTERVAL_MS - sinceLast);
      broadcastTimer = setTimeout(() => {
        broadcastTimer = null;
        if (broadcastPending) {
          broadcastPending = false;
          doBroadcastState();
        }
      }, wait);
      broadcastTimer.unref?.();
    }
  }

  function doBroadcastState(): void {
    if (stateClients.size === 0) return;
    lastBroadcastAt = Date.now();
    const state = deps.stateService.getState();

    // ── Populate embedded master's runningContainers from local state ──
    //
    // Embedded master doesn't heartbeat to itself, so node.runningContainers
    // is always undefined for the master. But we need an accurate count
    // for the cluster capacity math — otherwise the popover shows "master:
    // 0/186 containers" even while 14 containers are running locally.
    //
    // Walk local branches, sum up services with status=running where the
    // branch isn't explicitly dispatched to a remote executor, and stamp
    // that count on the embedded master entry right before serialization.
    if (deps.registry) {
      const execs = state.executors || {};
      for (const node of Object.values(execs)) {
        if (node.role !== 'embedded') continue;
        let localRunning = 0;
        for (const b of Object.values(state.branches || {})) {
          // Skip branches owned by a remote executor — they're counted
          // via that executor's own heartbeat.
          if (b.executorId && !b.executorId.startsWith('master-')) continue;
          for (const svc of Object.values(b.services || {})) {
            if (svc?.status === 'running') localRunning++;
          }
        }
        node.runningContainers = localRunning;
      }
    }

    // Include executors + mode + capacity so the Dashboard can react to
    // cluster changes without extra polls. `cdsMode` is read from the
    // live config (which may have been hot-switched by onFirstRegister).
    //
    // `schedulerEnabled` echoes the runtime flag so the capacity popover's
    // toggle stays in sync across browser tabs after a PUT /api/scheduler/enabled
    // call (otherwise tab B would still show the old state until reload).
    const data = JSON.stringify({
      seq: ++stateSeq,
      branches: Object.values(state.branches),
      defaultBranch: state.defaultBranch,
      // Cluster state — frontend uses these to update header + branch
      // placement + cluster modal without needing another /api/config call.
      mode: deps.config.mode,
      executors: Object.values(state.executors || {}),
      capacity: deps.registry ? deps.registry.getTotalCapacity() : null,
      schedulerEnabled: deps.schedulerService ? deps.schedulerService.isEnabled() : false,
    });
    for (const client of stateClients) {
      try { client.write(`data: ${data}\n\n`); } catch { stateClients.delete(client); }
    }
  }
  (app as unknown as { broadcastState?: () => void }).broadcastState = broadcastState;

  deps.stateService.onSave(broadcastState);

  // ── Activity stream SSE endpoint ──
  app.get('/api/activity-stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });
    activityClients.add(res);
    // Send buffered history
    const afterSeq = parseInt(req.query.afterSeq as string) || 0;
    for (const event of activityBuffer) {
      if (event.id > afterSeq) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
    const heartbeat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { clearInterval(heartbeat); }
    }, 30_000);
    req.on('close', () => { activityClients.delete(res); clearInterval(heartbeat); });
  });

  // ── Proxy log (全局转发日志) ──
  //
  // 顶部诊断面板用。排查「页面正常但 API 502 没日志」时：
  //   GET /api/proxy-log        一次性拿最近 500 条环形缓冲
  //   GET /api/proxy-log/stream SSE 实时订阅
  //
  // 为什么独立于 activity-stream：activity 只记 CDS 自己的 /api/* 调用，
  // 转发层（worker port）的 502 / upstream-error / no-branch-match 不在里面，
  // 这些才是「服务器日志为空」时用户最需要看到的。
  const proxyLogClients = new Set<express.Response>();
  deps.proxyService.setOnProxyLog((evt) => {
    const payload = `data: ${JSON.stringify(evt)}\n\n`;
    for (const client of proxyLogClients) {
      try { client.write(payload); } catch { proxyLogClients.delete(client); }
    }
  });
  app.get('/api/proxy-log', (req, res) => {
    const all = deps.proxyService.getProxyLog();
    const afterSeq = parseInt(req.query.afterSeq as string) || 0;
    const events = afterSeq > 0 ? all.filter(e => e.id > afterSeq) : all;
    const order = req.query.order === 'asc' ? 'asc' : 'desc';
    const ordered = afterSeq > 0 || order === 'asc' ? events : [...events].reverse();
    res.json({ events: ordered, total: all.length, maxId: all.length > 0 ? all[all.length - 1].id : 0 });
  });
  app.get('/api/proxy-log/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close' });
    proxyLogClients.add(res);
    const afterSeq = parseInt(req.query.afterSeq as string) || 0;
    for (const evt of deps.proxyService.getProxyLog()) {
      if (evt.id > afterSeq) res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
    const heartbeat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { clearInterval(heartbeat); }
    }, 30_000);
    req.on('close', () => { proxyLogClients.delete(res); clearInterval(heartbeat); });
  });

  app.get('/api/http-logs', async (req, res) => {
    const reader = deps.httpLogStore?.findRecent;
    if (!reader) {
      res.json({ logs: [], total: 0, message: 'HTTP 持久化日志未启用；请配置 CDS_MONGO_URI，且不要设置 CDS_HTTP_LOGS_ENABLED=0。' });
      return;
    }
    const limit = Number.parseInt(String(req.query.limit || '200'), 10) || 200;
    const minStatus = Number.parseInt(String(req.query.minStatus || ''), 10) || undefined;
    const requestId = typeof req.query.requestId === 'string' ? req.query.requestId : undefined;
    const host = typeof req.query.host === 'string' ? req.query.host : undefined;
    const method = typeof req.query.method === 'string' ? req.query.method : undefined;
    const pathContains = typeof req.query.pathContains === 'string'
      ? req.query.pathContains
      : (typeof req.query.path === 'string' ? req.query.path : undefined);
    const branchId = typeof req.query.branchId === 'string' ? req.query.branchId : undefined;
    const profileId = typeof req.query.profileId === 'string' ? req.query.profileId : undefined;
    const requestKind = parseHttpRequestKindValue(req.query.requestKind);
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    const until = typeof req.query.until === 'string' ? req.query.until : undefined;
    const minDurationRaw = typeof req.query.minDurationMs === 'string' ? Number.parseInt(req.query.minDurationMs, 10) : undefined;
    const minDurationMs = Number.isFinite(minDurationRaw) ? minDurationRaw : undefined;
    const sortRaw = typeof req.query.sort === 'string' ? req.query.sort : undefined;
    const sort = sortRaw === 'duration' ? 'duration' : 'recent';
    const layerRaw = typeof req.query.layer === 'string' ? req.query.layer : undefined;
    const layer = layerRaw === 'master' || layerRaw === 'master-proxy' || layerRaw === 'forwarder'
      ? layerRaw
      : undefined;
    const logs = await reader.call(deps.httpLogStore, {
      limit,
      requestId,
      host,
      layer,
      minStatus,
      method,
      pathContains,
      branchId,
      profileId,
      requestKind,
      since,
      until,
      minDurationMs,
      sort,
    });
    res.json({ logs, total: logs.length });
  });

  app.get('/api/http-logs/active', async (req, res) => {
    const reader = deps.httpLogStore?.findActive;
    if (!reader) {
      res.json({
        ok: false,
        disabled: true,
        active: [],
        total: 0,
        message: 'HTTP active 请求表未启用；当前日志 sink 不支持 findActive。',
      });
      return;
    }
    const limit = Number.parseInt(String(req.query.limit || '200'), 10) || 200;
    const minAgeRaw = typeof req.query.minAgeMs === 'string' ? Number.parseInt(req.query.minAgeMs, 10) : undefined;
    const minAgeMs = Number.isFinite(minAgeRaw) ? minAgeRaw : undefined;
    const sortRaw = typeof req.query.sort === 'string' ? req.query.sort : undefined;
    const filter: HttpActiveRequestFilter = {
      limit,
      requestId: typeof req.query.requestId === 'string' ? req.query.requestId : undefined,
      host: typeof req.query.host === 'string' ? req.query.host : undefined,
      layer: parseHttpLogLayer(req.query.layer),
      method: typeof req.query.method === 'string' ? req.query.method : undefined,
      pathContains: typeof req.query.pathContains === 'string'
        ? req.query.pathContains
        : (typeof req.query.path === 'string' ? req.query.path : undefined),
      branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
      profileId: typeof req.query.profileId === 'string' ? req.query.profileId : undefined,
      requestKind: parseHttpRequestKindValue(req.query.requestKind),
      minAgeMs,
      sort: sortRaw === 'started' ? 'started' : 'age',
    };
    const active = await collectActiveHttpRequests(deps.httpLogStore, filter, {
      excludeRequestId: String(res.locals.cdsRequestId || ''),
    });
    res.json({
      ok: true,
      disabled: false,
      active,
      total: active.length,
      generatedAt: new Date().toISOString(),
    });
  });

  app.get('/api/http-logs/slow', async (req, res) => {
    const reader = deps.httpLogStore?.findRecent;
    if (!reader) {
      res.json({
        ok: false,
        disabled: true,
        sampleSize: 0,
        total: 0,
        endpoints: [],
        message: 'HTTP 持久化日志未启用；请配置 CDS_MONGO_URI，且不要设置 CDS_HTTP_LOGS_ENABLED=0。',
      });
      return;
    }
    const sampleRaw = Number.parseInt(String(req.query.sample || req.query.limit || '1000'), 10) || 1000;
    const sample = Math.max(1, Math.min(sampleRaw, 5000));
    const topRaw = Number.parseInt(String(req.query.top || '20'), 10) || 20;
    const top = Math.max(1, Math.min(topRaw, 100));
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    if (since && Number.isNaN(Date.parse(since))) {
      res.status(400).json({ error: 'invalid_since', message: 'since must be an ISO timestamp' });
      return;
    }
    const until = typeof req.query.until === 'string' ? req.query.until : undefined;
    if (until && Number.isNaN(Date.parse(until))) {
      res.status(400).json({ error: 'invalid_until', message: 'until must be an ISO timestamp' });
      return;
    }
    const includeNoise = req.query.includeNoise === '1' || req.query.includeNoise === 'true';
    const layerRaw = typeof req.query.layer === 'string' ? req.query.layer : undefined;
    const layer = layerRaw === 'master' || layerRaw === 'master-proxy' || layerRaw === 'forwarder'
      ? layerRaw
      : undefined;
    const minDurationRaw = typeof req.query.minDurationMs === 'string' ? Number.parseInt(req.query.minDurationMs, 10) : undefined;
    const minDurationMs = Number.isFinite(minDurationRaw) ? minDurationRaw : undefined;
    const sort = req.query.sort === 'recent' ? 'recent' : 'duration';
    const rawLogs = await reader.call(deps.httpLogStore, {
      limit: sample,
      since,
      until,
      layer,
      method: typeof req.query.method === 'string' ? req.query.method : undefined,
      minStatus: typeof req.query.minStatus === 'string' ? Number.parseInt(req.query.minStatus, 10) || undefined : undefined,
      minDurationMs,
      requestKind: parseHttpRequestKindValue(req.query.requestKind),
      pathContains: typeof req.query.pathContains === 'string'
        ? req.query.pathContains
        : (typeof req.query.path === 'string' ? req.query.path : undefined),
      sort,
    });
    const logs = includeNoise ? rawLogs : rawLogs.filter((log) => !isNoiseHttpLog(log));
    const endpoints = summarizeSlowHttpLogs(logs).slice(0, top);
    res.json({
      ok: true,
      disabled: false,
      includeNoise,
      sort,
      sampleSize: rawLogs.length,
      filteredSampleSize: logs.length,
      noiseExcludedCount: rawLogs.length - logs.length,
      total: endpoints.length,
      window: {
        newest: rawLogs[0]?.ts || null,
        oldest: rawLogs[rawLogs.length - 1]?.ts || null,
      },
      endpoints,
    });
  });

  app.get('/api/perf/overview', async (req, res) => {
    const reader = deps.httpLogStore?.findRecent;
    if (!reader) {
      res.json({
        ok: false,
        disabled: true,
        message: 'HTTP 持久化日志未启用；请配置 CDS_MONGO_URI，且不要设置 CDS_HTTP_LOGS_ENABLED=0。',
      });
      return;
    }
    const sampleRaw = Number.parseInt(String(req.query.sample || req.query.limit || '1000'), 10) || 1000;
    const sample = Math.max(1, Math.min(sampleRaw, 5000));
    const topRaw = Number.parseInt(String(req.query.top || '10'), 10) || 10;
    const top = Math.max(1, Math.min(topRaw, 50));
    const recentLogs = await reader.call(deps.httpLogStore, { limit: sample, sort: 'recent' });
    const durationLogs = await reader.call(deps.httpLogStore, { limit: sample, sort: 'duration' });
    const active = await collectActiveHttpRequests(deps.httpLogStore, { limit: 200, sort: 'age' }, {
      excludeRequestId: String(res.locals.cdsRequestId || ''),
    });
    const logs = recentLogs;
    const normalLogs = logs.filter((log) => !isNoiseHttpLog(log));
    const noiseLogs = logs.filter(isNoiseHttpLog);
    const errorLogs = logs.filter((log) => log.status >= 500);
    const durationNormalLogs = durationLogs.filter((log) => !isNoiseHttpLog(log));
    const recentSelfUpdateTimings = deps.stateService.getSelfUpdateHistory(20).map((record) => ({
      ts: record.ts,
      branch: record.branch,
      fromSha: record.fromSha,
      toSha: record.toSha,
      status: record.status,
      durationMs: record.durationMs,
      totalElapsedMs: record.totalElapsedMs,
      updateMode: record.updateMode,
      timings: record.timings,
      error: record.error,
    }));
    res.json({
      ok: true,
      disabled: false,
      sampleSize: logs.length,
      durationSampleSize: durationLogs.length,
      noiseCount: noiseLogs.length,
      window: {
        newest: logs[0]?.ts || null,
        oldest: logs[logs.length - 1]?.ts || null,
      },
      slowEndpoints: summarizeSlowHttpLogs(durationNormalLogs).slice(0, top),
      slowByKind: {
        userTraffic: summarizeSlowHttpLogs(filterHttpLogsByKind(durationNormalLogs, 'user-traffic')).slice(0, top),
        controlPlane: summarizeSlowHttpLogs(filterHttpLogsByKind(durationNormalLogs, 'control-plane')).slice(0, top),
        deploy: summarizeSlowHttpLogs(filterHttpLogsByKind(durationLogs, 'deploy')).slice(0, top),
        containerOp: summarizeSlowHttpLogs(filterHttpLogsByKind(durationLogs, 'container-op')).slice(0, top),
        polling: summarizeSlowHttpLogs(filterHttpLogsByKind(durationLogs, 'polling')).slice(0, top),
        sse: summarizeSlowHttpLogs(filterHttpLogsByKind(durationLogs, 'sse')).slice(0, top),
      },
      activeRequests: active,
      activeSummary: summarizeActiveHttpRequests(active),
      frequentEndpoints: summarizeFrequentHttpLogs(normalLogs).slice(0, top),
      errorEndpoints: summarizeSlowHttpLogs(errorLogs).slice(0, top),
      noiseEndpoints: summarizeFrequentHttpLogs(noiseLogs).slice(0, top),
      recentSelfUpdateTimings,
    });
  });

  app.get('/api/server-events', async (req, res) => {
    const reader = deps.serverEventLogStore?.findRecent;
    if (!reader) {
      res.json({
        ok: false,
        disabled: true,
        events: [],
        total: 0,
        message: '服务器事件日志未启用；请配置 CDS_MONGO_URI，且不要设置 CDS_SERVER_EVENT_LOGS_ENABLED=0。',
      });
      return;
    }
    const limitRaw = Number.parseInt(String(req.query.limit || '200'), 10) || 200;
    const limit = Math.max(1, Math.min(limitRaw, 1000));
    const since = typeof req.query.since === 'string' ? req.query.since : undefined;
    if (since && Number.isNaN(Date.parse(since))) {
      res.status(400).json({ error: 'invalid_since', message: 'since must be an ISO timestamp' });
      return;
    }
    const categoryRaw = typeof req.query.category === 'string' ? req.query.category : undefined;
    const category = categoryRaw === 'container' || categoryRaw === 'docker' || categoryRaw === 'system'
      ? categoryRaw as ServerEventCategory
      : undefined;
    const severityRaw = typeof req.query.severity === 'string' ? req.query.severity : undefined;
    const severity = severityRaw === 'info' || severityRaw === 'warn' || severityRaw === 'error'
      ? severityRaw as ServerEventSeverity
      : undefined;
    const minSeverityRaw = typeof req.query.minSeverity === 'string' ? req.query.minSeverity : undefined;
    const minSeverity = minSeverityRaw === 'info' || minSeverityRaw === 'warn' || minSeverityRaw === 'error'
      ? minSeverityRaw as ServerEventSeverity
      : undefined;
    const events = await reader.call(deps.serverEventLogStore, {
      limit,
      category,
      severity,
      minSeverity,
      source: typeof req.query.source === 'string' ? req.query.source : undefined,
      action: typeof req.query.action === 'string' ? req.query.action : undefined,
      containerName: typeof req.query.containerName === 'string' ? req.query.containerName : undefined,
      branchId: typeof req.query.branchId === 'string' ? req.query.branchId : undefined,
      profileId: typeof req.query.profileId === 'string' ? req.query.profileId : undefined,
      projectId: typeof req.query.projectId === 'string' ? req.query.projectId : undefined,
      requestId: typeof req.query.requestId === 'string' ? req.query.requestId : undefined,
      operationId: typeof req.query.operationId === 'string' ? req.query.operationId : undefined,
      operationKind: typeof req.query.operationKind === 'string' ? req.query.operationKind : undefined,
      operationTrigger: typeof req.query.operationTrigger === 'string' ? req.query.operationTrigger : undefined,
      operationActor: typeof req.query.operationActor === 'string' ? req.query.operationActor : undefined,
      operationSource: typeof req.query.operationSource === 'string' ? req.query.operationSource : undefined,
      commitSha: typeof req.query.commitSha === 'string' ? req.query.commitSha : undefined,
      since,
    });
    res.json({ ok: true, disabled: false, events, total: events.length });
  });

  // ── Durable control-plane mutation audit ──
  //
  // Activity stream is a live UI aid; route-specific logs are easy to miss.
  // This middleware records one persistent, queryable audit row for every
  // mutating /api request that can change CDS state or containers.
  app.use('/api', (req, res, next) => {
    if (!shouldAuditApiMutation(req)) return next();
    const start = Date.now();
    const requestId =
      (res.locals as { cdsRequestId?: string }).cdsRequestId
      || (req as any).cdsRequestId
      || crypto.randomUUID().slice(0, 8);
    (req as any).cdsRequestId = requestId;
    (res.locals as { cdsRequestId?: string }).cdsRequestId = requestId;
    res.setHeader('X-CDS-Request-Id', requestId);
    const { branchId, projectId, profileId } = extractApiMutationContext(req, deps);
    const actor = resolveActorFromRequest(req);
    res.on('finish', () => {
      const status = res.statusCode || 200;
      const severity: ServerEventSeverity = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      const fullPath = `/api${req.path}`;
      deps.serverEventLogStore?.record({
        category: 'system',
        severity,
        source: 'api-mutation',
        action: 'api.request.completed',
        message: `${req.method.toUpperCase()} ${fullPath} -> ${status}`,
        projectId,
        branchId,
        profileId,
        status: String(status),
        requestId,
        details: {
          method: req.method.toUpperCase(),
          path: fullPath,
          originalUrl: req.originalUrl,
          status,
          durationMs: Date.now() - start,
          actor,
          trigger: req.headers['x-cds-trigger'] || req.headers['x-github-event'] || null,
          remoteAddr: getRemoteAddr(req),
          userAgent: req.headers['user-agent'] || null,
          referer: req.headers['referer'] || req.headers['origin'] || null,
          contentLength: req.headers['content-length'] || null,
        },
      });
    });
    next();
  });

  // ── API activity tracking middleware (before routes, after auth) ──
  app.use('/api', (req, res, next) => {
    // Skip SSE streams and static
    if (req.path === '/activity-stream' || req.path === '/ai/pairing-stream' || req.path === '/state-stream') return next();
    // Skip dashboard auto-poll requests (X-CDS-Poll: true) — they are noise
    const isPoll = req.headers['x-cds-poll'] === 'true';
    if (isPoll) return next();
    // Skip Bridge internal polling and results — internal communication, not user-facing
    if (req.path.startsWith('/bridge/heartbeat') || req.path.startsWith('/bridge/navigate-requests/') || req.path.startsWith('/bridge/handshake-requests/') || req.path === '/bridge/result' || req.path.startsWith('/bridge/check/')) return next();

    const start = Date.now();
    const origEnd = res.end.bind(res);
    const aiSession = (req as any)._aiSession as ApprovedAiSession | undefined;
    const requestId =
      (res.locals as { cdsRequestId?: string }).cdsRequestId
      || (req as any).cdsRequestId
      || crypto.randomUUID().slice(0, 8);
    res.setHeader('X-CDS-Request-Id', requestId);

    // Capture request body for detail view (truncate to 500 chars)
    const reqBody = req.body && Object.keys(req.body).length > 0
      ? JSON.stringify(req.body).slice(0, 500)
      : undefined;
    const reqQuery = Object.keys(req.query).length > 0
      ? new URLSearchParams(req.query as Record<string, string>).toString()
      : undefined;

    // Extract branch ID from path for AI occupation tracking
    const branchMatch = req.path.match(/^\/branches\/([^/]+)/);
    const branchId = branchMatch ? branchMatch[1] : undefined;
    // Resolve branch tags for activity display (avoids frontend timing issues)
    const branchTags = branchId ? (deps.stateService.getBranch(branchId)?.tags ?? []) : [];

    const summarizeErrorBody = (chunk: unknown): string | undefined => {
      if ((res.statusCode || 200) < 400) return undefined;
      let text = '';
      if (typeof chunk === 'string') {
        text = chunk;
      } else if (Buffer.isBuffer(chunk)) {
        text = chunk.toString('utf8');
      }
      text = text.trim();
      if (!text) return undefined;
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const parts = ['message', 'detail', 'hint', 'error']
          .map((key) => parsed[key])
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
        if (parts.length > 0) return Array.from(new Set(parts.map((part) => part.trim()))).join(' · ').slice(0, 600);
      } catch {
        // non-JSON error page from proxy/HTML fallback
      }
      return text.replace(/\s+/g, ' ').slice(0, 600);
    };

    (res as any).end = function (...args: any[]) {
      // Routes can opt out of broadcasting to the activity stream by
      // setting `X-CDS-Suppress-Activity: 1`. Used by the GitHub
      // webhook receiver to skip noise events (check_suite,
      // workflow_run, etc.) that fire per push when the App is
      // subscribed to "all events" — otherwise the operator's
      // monitor is drowned out by ignored deliveries.
      if (res.getHeader('X-CDS-Suppress-Activity') === '1') {
        // Strip the internal signalling header before sending to the
        // client — it's a CDS internal, not something the GitHub webhook
        // delivery log needs to show.
        try { res.removeHeader('X-CDS-Suppress-Activity'); } catch { /* ignore */ }
        return origEnd(...args);
      }
      const duration = Date.now() - start;
      const fullPath = `/api${req.path}`;
      // Refine the label for GitHub webhook deliveries so the operator
      // can tell "push" from "check_run" / "issue_comment" / ... at a
      // glance, instead of seeing a homogeneous stream of "GitHub 推送
      // Webhook". The event name is stashed on res.locals by the
      // webhook route after signature verification.
      let label = resolveApiLabel(req.method, fullPath);
      const ghEvent = (res.locals as { cdsGithubEvent?: string }).cdsGithubEvent;
      if (ghEvent && fullPath.endsWith('/github/webhook')) {
        label = `${label} · ${ghEvent}`;
      }
      const event: ActivityEvent = {
        id: ++activitySeq,
        requestId,
        ts: new Date().toISOString(),
        method: req.method,
        path: fullPath,
        status: res.statusCode,
        duration,
        type: 'cds',
        source: aiSession ? 'ai' : 'user',
        agent: aiSession?.agentName,
        label,
        body: reqBody,
        errorSummary: summarizeErrorBody(args[0]),
        query: reqQuery,
        branchId,
        branchTags: branchTags.length ? branchTags : undefined,
        remoteAddr: (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress,
        userAgent: req.headers['user-agent'],
        referer: req.headers['referer'] || req.headers['origin'],
      };
      broadcastActivity(event);
      if (event.status >= 400) {
        (res.locals as { cdsActivityLogged?: boolean }).cdsActivityLogged = true;
        // eslint-disable-next-line no-console
        console.warn('[api] request failed', {
          requestId: event.requestId,
          method: event.method,
          path: event.path,
          query: event.query,
          status: event.status,
          durationMs: event.duration,
          errorSummary: event.errorSummary,
          remoteAddr: event.remoteAddr,
          referer: event.referer,
          userAgent: event.userAgent,
        });
      }
      return origEnd(...args);
    };
    next();
  });

  // API routes
  app.use('/api/bridge', createBridgeRouter({
    bridgeService: deps.bridgeService,
    stateService: deps.stateService,  // PR_C.3: 让 bridge 写 AI 占用计数 / activity log
  }));
  // Multi-project router. P4 Part 2 wires up real create/delete, so the
  // router now needs shell (for docker network commands) and config.
  // See doc/design.cds.multi-project.md.
  app.use('/api', createProjectsRouter({
    stateService: deps.stateService,
    shell: deps.shell,
    config: deps.config,
    legacyProjectName: deps.config.repoRoot ? path.basename(deps.config.repoRoot) : 'prd_agent',
  }));
  // Pending imports — agent-authored CDS compose awaiting operator approval.
  // Mounted at /api so the nested /projects/:id/pending-import path works
  // alongside the rest of the projects router.
  app.use('/api', createPendingImportRouter({ stateService: deps.stateService }));
  app.use('/api', createScheduledJobsRouter({
    stateService: deps.stateService,
    scheduledJobService,
    assertProjectAccess: assertProjectAccess as any,
  }));

  // 被动授权 — agent 免密发起授权申请 + 用户右下角一键批准签发授权密钥。
  // 注意 发起/轮询两个端点的 public 放行在上面的全局认证中间件里(搜 access-requests)。
  app.use('/api', createAccessRequestsRouter({ stateService: deps.stateService, authMode }));
  // 2026-05-29 项目基础设施重新同步(用户反馈:断头应用,缺 yaml resync)
  app.use('/api', createProjectInfraResyncRouter({
    stateService: deps.stateService,
    containerService: deps.containerService,
    serverEventLogStore: deps.serverEventLogStore,
    config: { portStart: deps.config?.portStart, repoRoot: deps.config?.repoRoot ?? process.cwd() },
    assertProjectAccess: assertProjectAccess as any,
  }));
  // 项目虚拟 cds-compose.yml 读写(配置 SSOT，2026-05-29)
  app.use('/api', createProjectComposeRouter({
    stateService: deps.stateService,
    assertProjectAccess: assertProjectAccess as any,
  }));
  // 项目迁移:配置打包复刻 + 数据迁移扫描,把项目移植到另一个 CDS 节点(2026-06-23)
  app.use('/api', createProjectMigrationRouter({
    stateService: deps.stateService,
    assertProjectAccess: assertProjectAccess as any,
    authMode,
  }));
  // 项目存储面板(infra named volume 大小/挂载关系，feature-emerge E7，2026-05-29)
  app.use('/api', createProjectStorageRouter({
    stateService: deps.stateService,
    shell: deps.shell,
    assertProjectAccess: assertProjectAccess as any,
  }));
  // Cache diagnostics / repair / cross-server migration.
  // See routes/cache.ts for why this exists (挂载失效诊断 + 换机器预热).
  app.use('/api', createCacheRouter({ stateService: deps.stateService, shell: deps.shell }));
  // E6 验收报告匿名分享：顶层 `/r/:token` 公开只读（不经登录网关，token 自鉴权）。
  // 在认证白名单里已放行 `/r/`，见上方全局网关。
  app.use('/r', createPublicReportShareRouter({ stateService: deps.stateService }));
  // WS3 MAP-KBTP peer-sync：协议端点（HMAC/配对码鉴权，已在认证白名单放行）+ 管理端点（登录态）。
  app.use('/api/peer-sync', createPeerSyncRouter({ stateService: deps.stateService }));
  app.use('/api/peer-sync', createPeerSyncAdminRouter({ stateService: deps.stateService }));
  // 注：CDS 自托管验收报告的 `/api` 路由挂载推迟到 githubAppClient 创建之后
  // （见下方），以便 E4「验收回写 PR」拿到 GitHub App 客户端。
  // ConfigSnapshot (导入/破坏性操作前自动备份) + DestructiveOperationLog (紧急撤销).
  // 见 routes/snapshots.ts 头部注释。
  app.use('/api', createSnapshotsRouter({ stateService: deps.stateService }));
  // shared-service 远程主机登记（系统级），见 routes/remote-hosts.ts 头部注释。
  app.use('/api', createRemoteHostsRouter({
    stateService: deps.stateService,
    containerService: deps.containerService,
    config: deps.config,
  }));
  app.use('/api', createReleasesRouter({
    stateService: deps.stateService,
  }));
  // CDS 配对连接（系统级），见 routes/cds-system-connections.ts。
  app.use('/api', createCdsSystemConnectionsRouter({
    stateService: deps.stateService,
    config: deps.config,
  }));
  // CDS 网络拓扑（系统级，B'.6），见 routes/cds-system-topology.ts + services/topology-aggregator.ts。
  // 所有 IO（nginx-conf 文件 / forwarder 探测 / admin daemon 探测 / docker discover）
  // 都注入到 aggregator，单测可以全 mock。
  const topologyAggregator = createTopologyAggregator({
    readDomainsConfig: () => {
      const raw = process.env.CDS_ROOT_DOMAINS || '';
      return raw.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
    },
    readProjects: () => {
      // RoutingRule 顶层挂在 CdsState.routingRules,通过 projectId 关联到 project。
      // 聚合时把每个项目附上自己的 rules,aggregator 才能直接消费。
      try {
        const projs = deps.stateService.getProjects?.() || [];
        const rules = deps.stateService.getRoutingRules?.() || [];
        return projs.map(p => ({
          id: p.id,
          routingRules: rules
            .filter(r => r.projectId === p.id)
            .map(r => ({ type: r.type, match: r.match, enabled: r.enabled })),
        }));
      } catch {
        return [];
      }
    },
    readNginxConfText: () => {
      const confPath = path.resolve(
        deps.config.repoRoot || process.cwd(),
        'cds',
        'nginx',
        'cds-active-upstream.conf',
      );
      try {
        return fs.existsSync(confPath) ? fs.readFileSync(confPath, 'utf8') : '';
      } catch {
        return '';
      }
    },
    probeForwarder: async () => {
      // 没接入 fetch 实测前的兜底:用 standby controller 暴露的本地状态可推断,
      // 但更准的实现会走 http.get("http://127.0.0.1:9090/__forwarder/healthz")。
      // 这里给一个不会让网络爆的默认实现 — 失败即 healthy=false。
      try {
        const json = await httpGetJson('http://127.0.0.1:9090/__forwarder/healthz', 1500);
        const obj = json as Record<string, unknown>;
        return {
          healthy: obj.status === 'ok' || obj.status === 'degraded',
          port: 9090,
          routesCount: Number(obj.routesCount) || 0,
          routesHealthState:
            (obj.routesHealthState as 'live' | 'fallback' | 'stale' | 'unknown') ||
            'unknown',
        };
      } catch {
        return { healthy: false, port: 9090, routesCount: 0, routesHealthState: 'unknown' as const };
      }
    },
    probeAdminDaemon: async (port: number) => {
      try {
        const json = await httpGetJson(
          `http://127.0.0.1:${port}/healthz?probe=routes`,
          1000,
        );
        const obj = json as Record<string, unknown>;
        return {
          alive: obj.status === 'ok' || obj.ok === true || obj.alive === true,
          buildSha: typeof obj.buildSha === 'string' ? obj.buildSha : null,
          uptime: typeof obj.uptime === 'number' ? obj.uptime : null,
        };
      } catch {
        return { alive: false, buildSha: null, uptime: null };
      }
    },
    discoverAppContainers: async () => {
      try {
        return (await deps.containerService.discoverAppContainers()) as unknown as Map<
          string,
          { containerName: string; branchId: string; profileId: string; running: boolean; network?: string }
        >;
      } catch {
        return new Map();
      }
    },
    discoverInfraContainers: async () => {
      try {
        return (await deps.containerService.discoverInfraContainers()) as unknown as Map<
          string,
          { containerName: string; serviceId: string; running: boolean }
        >;
      } catch {
        return new Map();
      }
    },
    masterPort: deps.config.masterPort,
  });
  app.use('/api', createCdsSystemTopologyRouter({ aggregator: topologyAggregator }));
  // 基础设施数据备份/恢复（mongodump/mongorestore/redis dump.rdb/tar）
  app.use('/api', createInfraBackupRouter({ stateService: deps.stateService, shell: deps.shell, assertProjectAccess: assertProjectAccess as any }));
  app.use('/api', createInfraDataRouter({ stateService: deps.stateService, shell: deps.shell, assertProjectAccess: assertProjectAccess as any }));
  // 遗留 default 项目迁移（见 legacy-cleanup.ts 头部注释）
  app.use('/api', createLegacyCleanupRouter({
    stateService: deps.stateService,
    shell: deps.shell,
    worktreeBase: deps.config.worktreeBase,
  }));
  // ── GitHub App client (optional) ──
  //
  // Instantiate once and share between the webhook router and the branch
  // router. Absent when CDS_GITHUB_APP_* env vars are not set — both
  // consumers handle `undefined` gracefully (routes return 503, deploys
  // skip check-run creation).
  const githubAppClient = deps.config.githubApp
    ? new GitHubAppClient({
        appId: deps.config.githubApp.appId,
        privateKey: deps.config.githubApp.privateKey,
        appSlug: deps.config.githubApp.appSlug,
      })
    : undefined;

  deps.worktreeService.setGitEnvProvider(async (repoRoot: string) => {
    const auth = await resolveGitAuthEnv({
      repoRoot,
      config: deps.config,
      stateService: deps.stateService,
      githubApp: githubAppClient,
    });
    return auth.env;
  });

  // ── Reconcile orphan check-runs on boot ──
  //
  // self-update / self-force-sync / crash can leave check-runs in
  // `status=in_progress` forever because the finalize() PATCH was
  // interrupted by restart. GitHub's PR Checks panel then shows every
  // commit in "pending / 准备状态" indefinitely even though CDS has
  // long since finished deploying.
  //
  // Walk every branch with a stamped checkRunId and PATCH to
  // conclusion=neutral (grey dot) the ones that aren't currently
  // building. Fire-and-forget so the server boot isn't blocked on
  // GitHub API latency.
  if (githubAppClient) {
    const runner = new CheckRunRunner({
      stateService: deps.stateService,
      githubApp: githubAppClient,
      config: deps.config,
    });
    runner.reconcileOrphans().catch((err: Error) => {
      // eslint-disable-next-line no-console
      console.warn('[check-run] startup reconciliation failed:', err.message);
    });
  }

  // CDS 自托管验收报告（HTML / Markdown）。挂在全局认证网关之后，CDS 登录态即可访问。
  // githubApp 用于 E4「验收回写 PR」（check-run / PR 评论）；未配置时回写端点返回 503。
  app.use('/api', createReportsRouter({ stateService: deps.stateService, githubApp: githubAppClient }));

  app.use('/api', createBranchRouter({
    stateService: deps.stateService,
    worktreeService: deps.worktreeService,
    containerService: deps.containerService,
    shell: deps.shell,
    config: deps.config,
    schedulerService: deps.schedulerService,
    janitorService: deps.janitorService,
    registry: deps.registry,
    getClusterStrategy: deps.getClusterStrategy,
    githubApp: githubAppClient,
    serverEventLogStore: deps.serverEventLogStore,
    branchOperationCoordinator: deps.branchOperationCoordinator,
  }));

  // 2026-05-28: 单一 SSE 通道 + 任务化刷新。
  // 必须挂在 createBranchRouter 之后,因为 cache.init() 在 branches.ts 里执行,
  // cds-events 路由要读已 init 好的 cache。
  app.use('/api', createCdsEventsRouter());

  // 2026-05-28: 运维控制台 — 取代"需要 SSH 上服务器"的运维操作。
  // 提供 nginx reload / 配置 dump / shell 等高级操作的 UI 一键执行入口。
  // 所有 op 走 access key 鉴权 + 服务端注册表(不接受任意命令),destructive 需 confirm。
  app.use('/api', createOperatorConsoleRouter({
    stateService: deps.stateService,
    shell: deps.shell,
    repoRoot: deps.config.repoRoot,
    serverEventLogStore: deps.serverEventLogStore,
  }));

  // ── GitHub App webhook + linking endpoints (P6) ──
  //
  // POST /api/github/webhook is public-facing (GitHub hits it) but
  // protected by HMAC signature verification inside the route handler.
  // The GET /api/github/app + /installations + /projects/:id/github/link
  // endpoints go through the normal auth middleware (cookie or AI key).
  // When githubApp isn't configured, /github/webhook returns 503 and the
  // other endpoints return 503 — the frontend hides the integration UI.
  app.use('/api', createGithubWebhookRouter({
    stateService: deps.stateService,
    worktreeService: deps.worktreeService,
    shell: deps.shell,
    config: deps.config,
    githubApp: githubAppClient,
    serverEventLogStore: deps.serverEventLogStore,
  }));

  // P4 Part 18 (D.3): storage-mode management endpoints. Requires the
  // shared storageModeContext which index.ts populates during
  // initStateService(). Absent in pre-D.3 tests that spin up the
  // server without a real storage context — the router is optional.
  if (deps.storageModeContext && deps.stateFile) {
    app.use('/api', createStorageModeRouter({
      stateService: deps.stateService,
      stateFile: deps.stateFile,
      repoRoot: deps.config.repoRoot,
      context: deps.storageModeContext,
    }));
  }

  // Customisable PR preview comment template (GET/PUT/preview). The
  // Settings panel "评论模板" tab talks to this router; the webhook
  // path (postOrUpdatePrComment) reads state back via StateService,
  // not through HTTP — the router is purely for admin editing.
  app.use('/api', createCommentTemplateRouter({
    stateService: deps.stateService,
    config: deps.config,
  }));

  // P4 Part 18 (Phase E): GitHub OAuth Device Flow router.
  //
  // The router is always mounted so the frontend can hit /status +
  // get { configured: false } when CDS_GITHUB_CLIENT_ID is unset
  // and gracefully hide the Sign-in button. When configured, the
  // full Device Flow + repo listing is available.
  //
  // We instantiate a SEPARATE GitHubOAuthClient here (vs the one
  // used for CDS session auth) because Device Flow only needs the
  // client_id — no secret. This lets setups that don't use GitHub
  // for CDS login still offer the repo picker.
  {
    // P4 Part 18 (Phase E): instantiate a Device-Flow-only GitHub
    // OAuth client. Reuses the same GitHubOAuthClient class already
    // imported at the top of this file — device flow methods only
    // need client_id, so an empty client_secret is fine here.
    const ghClientId = process.env.CDS_GITHUB_CLIENT_ID;
    const deviceClient = ghClientId
      ? new GitHubOAuthClient({
          clientId: ghClientId,
          clientSecret: process.env.CDS_GITHUB_CLIENT_SECRET || '',
        })
      : null;
    app.use('/api', createGithubOAuthRouter({
      stateService: deps.stateService,
      githubClient: deviceClient,
    }));
  }

  // NOTE: The SPA fallback (`app.get('*', ...)`) is intentionally NOT
  // registered here. Routes mounted later in `index.ts` (scheduler, cluster,
  // etc.) would otherwise be shadowed by the catch-all, because Express
  // traverses middleware in registration order. Call `installSpaFallback()`
  // once all dynamic routes have been mounted.

  // Log AI access key status
  if (process.env.CDS_AI_ACCESS_KEY) {
    console.log('  AI Access: static key configured (CDS_AI_ACCESS_KEY)');
  } else if (process.env.AI_ACCESS_KEY) {
    console.log('  AI Access: static key configured (legacy AI_ACCESS_KEY — 建议改名为 CDS_AI_ACCESS_KEY)');
  }
  console.log('  AI Pairing: enabled (POST /api/ai/request-access)');

  return app;
}

/**
 * Install the dashboard static-file serving and the SPA catch-all fallback.
 *
 * Must be called AFTER all `/api/*` routes have been mounted on the app
 * (including scheduler and cluster routers added from `index.ts`), because
 * `app.get('*', ...)` is a greedy handler that will intercept any unmatched
 * GET request in registration order. Installing it too early was the cause
 * of `/api/cluster/status` returning HTML instead of JSON in production —
 * the catch-all fired before the cluster router got a chance to match.
 *
 * See commit that moved this out of `createServer()` for the regression
 * details.
 */
/**
 * 审计所有已挂载的 /api/* 路由是否都有中文 label。
 *
 * 背景：Activity Monitor 左侧要展示"中文动作名 + URL"帮助用户看懂 AI 在干啥，
 * 而 label 由 `resolveApiLabel()` 的 staticMap + patterns 数组集中维护。
 * 新增路由如果漏改这里，用户端就只能看到裸 URL（如 `api/me`），
 * 规则 #cds-api-label-coverage 明确要求每条 /api/* 必须有 label。
 *
 * 做法：启动后扫一遍 `app._router.stack`，把 express 注册的每条 layer 展开成
 * `METHOD /path`，塞进 `resolveApiLabel()`，返回空串就打警告。开发环境立刻可见，
 * 生产环境通过日志暴露。
 *
 * 不做的事：
 *  - 不阻断启动（避免小问题把整个服务弄挂）
 *  - 不覆盖 :param 的具体值（因为 staticMap 和 patterns 就是按参数模式匹配的）
 *  - 忽略 /api 以外的路由（SPA、静态资源）
 */
export function auditApiLabels(app: express.Express): string[] {
  const missing: string[] = [];
  // express 的路由表结构：app._router.stack -> [layer, layer ...]
  // 一条 route layer 长这样：{ route: { path, methods: {get:true,...} } }
  // 一条子 router layer：{ name: 'router', handle: { stack: [...] }, regexp }
  //   regexp 来自 app.use('/api', router) 的前缀，需要把 /api/... 还原
  type Layer = {
    route?: { path: string | string[]; methods: Record<string, boolean> };
    name?: string;
    handle?: { stack?: Layer[] };
    regexp?: RegExp;
  };
  const router = (app as unknown as { _router?: { stack: Layer[] } })._router;
  if (!router?.stack) return missing;

  const extractPrefix = (re: RegExp): string => {
    // express mount prefix 的 regexp 例如 /^\/api\/?(?=\/|$)/i — 抠出字符串段
    const src = re.source
      .replace(/^\^/, '')
      .replace(/\\\//g, '/')
      .replace(/\?\(\?=.*$/, '')
      .replace(/\$$/, '')
      .replace(/\/\?$/, '');
    return src.startsWith('/') ? src : '';
  };

  const walk = (layers: Layer[], prefix: string) => {
    for (const layer of layers) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths) {
          // 只关心 /api/* 下的业务路由，不审计 SPA、/healthz 等
          const full = (prefix + p).replace(/\/+/g, '/');
          if (!full.startsWith('/api/') && full !== '/api') continue;
          for (const m of Object.keys(layer.route.methods)) {
            const method = m.toUpperCase();
            const label = resolveApiLabel(method, full);
            if (!label) missing.push(`${method} ${full}`);
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack && layer.regexp) {
        const sub = extractPrefix(layer.regexp);
        walk(layer.handle.stack, prefix + sub);
      }
    }
  };

  walk(router.stack, '');

  if (missing.length > 0) {
    console.warn(
      `[api-label] ${missing.length} 个 /api/* 路由没有中文 label（在 resolveApiLabel 的 staticMap/patterns 补上即可）:`,
    );
    for (const m of missing) console.warn(`  · ${m}`);
    console.warn(
      '[api-label] 详见 cds/CLAUDE.md「API label 全量覆盖」规则。',
    );
  }
  return missing;
}

export function installSpaFallback(
  app: express.Express,
  _legacyDirOverride?: string,
  reactDistOverride?: string,
  _migratedRoutes?: readonly string[],
): void {
  const reactDist = reactDistOverride || path.resolve(__dirname, '..', 'web', 'dist');

  // 在 SPA 兜底挂载前做一次 label 覆盖审计。SPA 的 `app.get('*')` 会吃掉
  // 后续所有路由，所以必须在这里做扫描。缺 label 的路由打 warning，但不阻断启动。
  auditApiLabels(app);

  // ── React app (cds/web/dist/) ──
  // React Router is the dashboard authority. Every non-API HTML route is
  // served from the Vite bundle; old .html filenames are kept only as
  // explicit redirects below. There is no legacy static-page fallback.
  const reactIndex = path.join(reactDist, 'index.html');
  if (fs.existsSync(reactIndex)) {
    // ── Static assets (content-hashed, immutable) ──
    // Vite emits content-hashed filenames under /assets, so every file is
    // immutable and safe to cache for a year. We also compress text assets
    // (JS/CSS/SVG/JSON) on the fly with the built-in zlib — no extra npm
    // dependency (which would break the host's `pnpm install --frozen-lockfile`)
    // — and memoize the compressed buffer: these files never change, so each is
    // compressed exactly once. This cuts the dashboard bundle transfer from
    // ~199KB to ~60KB. SSE / streaming routes are never served from here, so
    // there is no streaming-compat risk. Fonts/images fall through to sendFile
    // verbatim (already compressed). Cache-Control here is `immutable` without
    // `no-cache`; note the host nginx still appends `no-cache` via add_header
    // until exec_cds.sh's template fix is reloaded (see render_nginx()).
    const assetsDir = path.join(reactDist, 'assets');
    const ASSET_COMPRESS_CACHE = new Map<string, Buffer>();
    // Bound the in-memory compressed-asset cache. Each zero-downtime web rebuild
    // emits new content-hashed filenames while the daemon does NOT restart, so
    // without eviction old entries would accumulate forever across deploys.
    // Cap by entry count AND total bytes; evict oldest (Map keeps insertion order).
    const ASSET_COMPRESS_CACHE_MAX_ENTRIES = 256;
    const ASSET_COMPRESS_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB
    let assetCompressCacheBytes = 0;
    const rememberCompressed = (key: string, buf: Buffer): void => {
      ASSET_COMPRESS_CACHE.set(key, buf);
      assetCompressCacheBytes += buf.length;
      while (
        ASSET_COMPRESS_CACHE.size > ASSET_COMPRESS_CACHE_MAX_ENTRIES ||
        assetCompressCacheBytes > ASSET_COMPRESS_CACHE_MAX_BYTES
      ) {
        const oldest = ASSET_COMPRESS_CACHE.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const evicted = ASSET_COMPRESS_CACHE.get(oldest);
        ASSET_COMPRESS_CACHE.delete(oldest);
        if (evicted) assetCompressCacheBytes -= evicted.length;
      }
    };
    const ASSET_TEXT_MIME: Record<string, string> = {
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.json': 'application/json; charset=utf-8',
      '.map': 'application/json; charset=utf-8',
    };
    app.get('/assets/*', (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      let rel: string;
      try {
        rel = decodeURIComponent(req.path.slice('/assets/'.length));
      } catch {
        return next();
      }
      const filePath = path.join(assetsDir, rel);
      // Path-traversal guard: resolved path must stay inside assetsDir.
      if (!filePath.startsWith(assetsDir + path.sep)) return next();
      let isFile = false;
      try {
        isFile = fs.statSync(filePath).isFile();
      } catch {
        return next();
      }
      if (!isFile) return next();

      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Vary', 'Accept-Encoding');

      const ext = path.extname(filePath).toLowerCase();
      const mime = ASSET_TEXT_MIME[ext];
      // Non-text (fonts/images): already compressed, serve verbatim.
      if (!mime) {
        return res.sendFile(filePath, { maxAge: '1y', immutable: true });
      }

      // 解析 Accept-Encoding 的 q 值,尊重显式禁用(如 `br;q=0` / `gzip;q=0`),
      // 不能只看 token 是否出现就发对应压缩(Codex #741 P2)。`*` 作为兜底权重。
      const accept = String(req.headers['accept-encoding'] || '').toLowerCase();
      const encQ = new Map<string, number>();
      for (const part of accept.split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        const [tokRaw, ...params] = seg.split(';');
        const tok = tokRaw.trim();
        if (!tok) continue;
        let q = 1;
        for (const p of params) {
          const m = p.trim().match(/^q=([0-9.]+)$/);
          if (m) q = Number.parseFloat(m[1]);
        }
        encQ.set(tok, Number.isFinite(q) ? q : 0);
      }
      const starQ = encQ.has('*') ? encQ.get('*')! : undefined;
      const qOf = (t: string): number => (encQ.has(t) ? encQ.get(t)! : (starQ ?? 0));
      const encoding = qOf('br') > 0 ? 'br' : qOf('gzip') > 0 ? 'gzip' : 'identity';
      res.setHeader('Content-Type', mime);

      if (encoding === 'identity') {
        return res.sendFile(filePath, { maxAge: '1y', immutable: true });
      }

      const cacheKey = `${filePath}:${encoding}`;
      let body = ASSET_COMPRESS_CACHE.get(cacheKey);
      if (!body) {
        try {
          const raw = fs.readFileSync(filePath);
          body =
            encoding === 'br'
              ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
              : zlib.gzipSync(raw, { level: 6 });
          rememberCompressed(cacheKey, body);
        } catch {
          return res.sendFile(filePath, { maxAge: '1y', immutable: true });
        }
      }
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', String(body.length));
      if (req.method === 'HEAD') return res.end();
      res.end(body);
    });
    // favicon and any other root-level files that Vite emits next to index.html
    app.use(
      express.static(reactDist, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
          }
        },
      })
    );
    app.get('*', (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api/')) return next();
      const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      if (req.path === '/projects.html') return res.redirect(301, '/project-list' + qs);
      if (req.path === '/index.html') return res.redirect(301, '/branch-list' + qs);
      if (req.path === '/cds-settings.html') return res.redirect(301, '/cds-settings' + qs);
      if (req.path === '/login.html') return res.redirect(301, '/login' + qs);
      if (req.path === '/login-gh.html') return res.redirect(302, '/login' + qs);
      if (req.path === '/settings.html') {
        const project = typeof req.query.project === 'string' ? req.query.project.trim() : '';
        return project
          ? res.redirect(301, `/settings/${encodeURIComponent(project)}`)
          : res.redirect(302, '/project-list');
      }
      if (req.path === '/settings') return res.redirect(302, '/project-list');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.sendFile(reactIndex);
    });
  } else {
    console.warn(
      '[cds-web] cds/web/dist/index.html not found; dashboard routes will not be served. Run `cd cds/web && pnpm build` before starting CDS.'
    );
  }
  // Final defense-in-depth:any unhandled /api/* path lands here as a
  // proper JSON 404. Keeps the contract "API endpoints always return JSON
  // (never HTML)" — which the frontend's apiRequest depends on for sane
  // error handling. Without this, missing routes 500 with HTML bodies.
  app.use('/api', (req, res) => {
    res.status(404).json({
      error: 'not_found',
      method: req.method,
      path: req.path,
      message: `Unknown API endpoint: ${req.method} /api${req.path}`,
    });
  });
}

function parseCookie(cookieStr: string, name: string): string | undefined {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}
