import express from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBranchRouter } from './routes/branches.js';
import { createBridgeRouter } from './routes/bridge.js';
import { createProjectsRouter } from './routes/projects.js';
import { createPendingImportRouter } from './routes/pending-import.js';
import { createStorageModeRouter, type StorageModeContext } from './routes/storage-mode.js';
import { createGithubOAuthRouter } from './routes/github-oauth.js';
import { createAuthRouter } from './routes/auth.js';
import { createWorkspacesRouter } from './routes/workspaces.js';
import { MemoryAuthStore } from './infra/auth-store/memory-store.js';
import type { AuthStore } from './infra/auth-store/memory-store.js';
import { GitHubOAuthClient } from './services/github-oauth-client.js';
import { AuthService } from './services/auth-service.js';
import { WorkspaceService } from './services/workspace-service.js';
import { createGithubAuthMiddleware } from './middleware/github-auth.js';
import type { StateService } from './services/state.js';
import type { WorktreeService } from './services/worktree.js';
import type { ContainerService } from './services/container.js';
import type { ProxyService } from './services/proxy.js';
import type { BridgeService } from './services/bridge.js';
import type { SchedulerService } from './services/scheduler.js';
import type { CdsConfig, IShellExecutor } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
}

function makeToken(user: string, pass: string): string {
  return crypto.createHash('sha256').update(`cds:${user}:${pass}`).digest('hex');
}

// ── Activity Stream (SSE broadcast for API operation monitor) ──
export interface ActivityEvent {
  id: number;
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
function resolveApiLabel(method: string, path: string): string {
  // Normalize: remove /api prefix, trim trailing slash
  const p = path.replace(/^\/api/, '').replace(/\/$/, '');

  // Static exact matches
  const staticMap: Record<string, string> = {
    'GET /branches': '获取系统状态信息',
    'POST /branches': '注册新分支',
    'GET /remote-branches': '获取远程分支',
    'GET /build-profiles': '获取构建配置',
    'POST /build-profiles': '创建构建配置',
    'GET /routing-rules': '获取路由规则',
    'POST /routing-rules': '创建路由规则',
    'GET /env': '获取环境变量',
    'PUT /env': '批量设置环境变量',
    'GET /config': '获取全局配置',
    'GET /infra': '获取基础设施列表',
    'GET /infra/discover': '发现基础设施',
    'POST /infra': '添加基础设施',
    'POST /infra/quickstart': '快速初始化基础设施',
    'GET /docker-images': '获取 Docker 镜像',
    'POST /cleanup': '清理已停止容器',
    'POST /cleanup-orphans': '清理孤儿容器',
    'POST /prune-stale-branches': '清理过期分支',
    'POST /factory-reset': '恢复出厂设置',
    'GET /check-updates': '检查远程更新',
    'POST /quickstart': '快速开始配置',
    'GET /mirror': '获取镜像配置',
    'PUT /mirror': '更新镜像配置',
    'POST /import-config': '导入配置',
    'GET /export-config': '导出配置',
    'GET /export-skill': '导出技能配置',
    'POST /import-and-init': '导入并初始化',
    'GET /self-branches': '获取自身分支',
    'POST /self-update': '自我更新',
    'POST /login': '用户登录',
    'POST /logout': '用户登出',
    'GET /ai/pending': '查看待处理 AI 请求',
    'GET /ai/sessions': '查看 AI 会话',
    'POST /ai/request-access': 'AI 请求连接',
    'GET /bridge/connections': '查看 Bridge 连接',
    'POST /bridge/navigate-request': 'AI 请求用户导航',
    'POST /bridge/start-session': 'AI 开始操作页面',
    'POST /bridge/end-session': 'AI 操作完成',
  };

  const key = `${method} ${p}`;
  if (staticMap[key]) return staticMap[key];

  // Dynamic pattern matches (with :id params)
  const patterns: Array<[RegExp, string]> = [
    [/^DELETE \/branches\/(.+)$/, '删除分支'],
    [/^PATCH \/branches\/(.+)$/, '更新分支信息'],
    [/^POST \/branches\/(.+)\/pull$/, '拉取分支代码'],
    [/^POST \/branches\/(.+)\/deploy\/(.+)$/, '部署单服务'],
    [/^POST \/branches\/(.+)\/deploy$/, '全量部署'],
    [/^POST \/branches\/(.+)\/stop$/, '停止分支服务'],
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
    [/^POST \/infra\/(.+)\/start$/, '启动基础设施'],
    [/^POST \/infra\/(.+)\/stop$/, '停止基础设施'],
    [/^POST \/infra\/(.+)\/restart$/, '重启基础设施'],
    [/^GET \/infra\/(.+)\/logs$/, '查看基础设施日志'],
    [/^GET \/infra\/(.+)\/health$/, '基础设施健康检查'],
    [/^PUT \/infra\/(.+)$/, '更新基础设施'],
    [/^DELETE \/infra\/(.+)$/, '删除基础设施'],
    [/^DELETE \/ai\/sessions\/(.+)$/, '撤销 AI 会话'],
    [/^POST \/ai\/approve\/(.+)$/, '批准 AI 连接'],
    [/^POST \/ai\/reject\/(.+)$/, '拒绝 AI 连接'],
    [/^GET \/bridge\/state\/(.+)$/, '读取页面状态'],
    [/^POST \/bridge\/command\/(.+)$/, 'AI 操作页面'],
    [/^GET \/bridge\/navigate-requests\/(.+)$/, '查看导航请求'],
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

/** Check if a request is from an approved AI session */
function resolveAiSession(req: express.Request, stateService?: StateService): ApprovedAiSession | null {
  // Static mode: AI_ACCESS_KEY from process env or custom env (either match accepts)
  const headerKey = req.headers['x-ai-access-key'] as string | undefined;
  if (headerKey) {
    const processKey = process.env.AI_ACCESS_KEY;
    const customKey = stateService?.getCustomEnv()?.['AI_ACCESS_KEY'];
    if ((processKey && headerKey === processKey) || (customKey && headerKey === customKey)) {
      return { id: 'static', agentName: 'AI (static key)', token: headerKey, approvedAt: '', expiresAt: '' };
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
  app.set('etag', false);            // Disable ETag — prevents 304 on API polling (CDS is a dev tool, caching is misleading)
  app.use(express.json());

  const webDir = path.resolve(__dirname, '..', 'web');

  // ── Liveness / readiness probe (public, no auth) ──
  // Used by:
  //   1. Dockerfile HEALTHCHECK
  //   2. Nginx upstream health check
  //   3. systemd WatchdogSec (future)
  //   4. Load balancer active health probes
  //
  // Returns 200 when CDS can read its state file AND reach the Docker socket.
  // Returns 503 on either failure so upstream knows to avoid this instance.
  // See doc/design.cds-resilience.md Phase 2.
  app.get('/healthz', async (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    let overallOk = true;

    // Check 1: state readable
    try {
      const state = deps.stateService.getState();
      checks.state = {
        ok: true,
        detail: `branches=${Object.keys(state.branches).length}`,
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
  // See doc/design.cds-resilience.md §八.
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
  // See doc/design.cds-multi-project.md section 七.
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
  // redirects unauthenticated HTML requests to /login-gh.html and rejects
  // unauthenticated API requests with 401. See:
  //   - cds/src/services/auth-service.ts
  //   - cds/src/middleware/github-auth.ts
  //   - doc/design.cds-multi-project.md section 七
  //   - doc/plan.cds-multi-project-phases.md P2
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

    app.use(createGithubAuthMiddleware({ authService }));

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
      if (req.path === '/login.html' || req.path === '/api/login' || req.path === '/api/logout') return next();
      if (req.path.startsWith('/api/ai/request-access') || req.path.startsWith('/api/ai/request-status/')) return next();
      if (/\.(css|js|ico|png|svg|woff2?)$/i.test(req.path)) return next();
      // Allow internal requests from widget proxy (/_cds/ → master)
      if (req.headers['x-cds-internal'] === '1') return next();

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

      // Check human cookie auth
      const cookieToken = parseCookie(req.headers.cookie || '', 'cds_token');
      const headerToken = req.headers['x-cds-token'] as string | undefined;
      const token = cookieToken || headerToken;
      if (token === validToken) return next();

      // Check AI session auth
      const aiSession = resolveAiSession(req, deps.stateService);
      if (aiSession) {
        (req as any)._aiSession = aiSession;
        return next();
      }

      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: '未登录' });
      } else {
        res.sendFile(path.join(webDir, 'login.html'));
      }
    });

    console.log(`  Auth: enabled (user: ${cdsUser})`);
  } else if (authMode === 'disabled') {
    console.warn(
      '  ⚠ Auth: disabled — set CDS_AUTH_MODE=github (+ CDS_GITHUB_CLIENT_ID/SECRET/ALLOWED_ORGS) or CDS_USERNAME/CDS_PASSWORD to enable login',
    );
  }

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
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
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
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
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
  function broadcastState(): void {
    if (stateClients.size === 0) return;
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
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
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

    (res as any).end = function (...args: any[]) {
      const duration = Date.now() - start;
      const fullPath = `/api${req.path}`;
      const event: ActivityEvent = {
        id: ++activitySeq,
        ts: new Date().toISOString(),
        method: req.method,
        path: fullPath,
        status: res.statusCode,
        duration,
        type: 'cds',
        source: aiSession ? 'ai' : 'user',
        agent: aiSession?.agentName,
        label: resolveApiLabel(req.method, fullPath),
        body: reqBody,
        query: reqQuery,
        branchId,
        branchTags: branchTags.length ? branchTags : undefined,
        remoteAddr: (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress,
        userAgent: req.headers['user-agent'],
        referer: req.headers['referer'] || req.headers['origin'],
      };
      broadcastActivity(event);
      return origEnd(...args);
    };
    next();
  });

  // API routes
  app.use('/api/bridge', createBridgeRouter({ bridgeService: deps.bridgeService }));
  // Multi-project router. P4 Part 2 wires up real create/delete, so the
  // router now needs shell (for docker network commands) and config.
  // See doc/design.cds-multi-project.md.
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
  app.use('/api', createBranchRouter({
    stateService: deps.stateService,
    worktreeService: deps.worktreeService,
    containerService: deps.containerService,
    shell: deps.shell,
    config: deps.config,
    schedulerService: deps.schedulerService,
    registry: deps.registry,
    getClusterStrategy: deps.getClusterStrategy,
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
  if (process.env.AI_ACCESS_KEY) {
    console.log('  AI Access: static key configured (AI_ACCESS_KEY)');
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
export function installSpaFallback(app: express.Express, webDir?: string): void {
  const dir = webDir || path.resolve(__dirname, '..', 'web');

  // Semantic URL routes (preferred, human-readable paths)
  app.get('/project-list', (_req, res) => {
    res.sendFile(path.join(dir, 'project-list.html'));
  });
  app.get('/branch-list', (_req, res) => {
    res.sendFile(path.join(dir, 'index.html'));
  });
  app.get('/branch-panel', (_req, res) => {
    res.sendFile(path.join(dir, 'index.html'));
  });

  // Backward-compat redirects: old .html paths → semantic paths (301 permanent)
  app.get('/projects.html', (req, res) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(301, '/project-list' + qs);
  });
  app.get('/index.html', (req, res) => {
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(301, '/branch-list' + qs);
  });

  // Root redirect → project list
  app.get('/', (_req, res) => {
    res.redirect(302, '/project-list');
  });

  // HTML pages must never be served from cache — JS/CSS are cache-busted via
  // ?t=Date.now() in the HTML itself, but if the HTML is stale the wrong JS
  // version gets loaded. HTTP headers take precedence over meta http-equiv.
  app.use(express.static(dir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(dir, 'index.html'));
  });
}

function parseCookie(cookieStr: string, name: string): string | undefined {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}
