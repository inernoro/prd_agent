import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBranchRouter } from './routes/branches.js';
import { createBridgeRouter } from './routes/bridge.js';
import type { StateService } from './services/state.js';
import type { WorktreeService } from './services/worktree.js';
import type { ContainerService } from './services/container.js';
import type { ProxyService } from './services/proxy.js';
import type { BridgeService } from './services/bridge.js';
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
    [/^POST \/bridge\/command\/(.+)$/, '下发 Bridge 指令'],
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
  const cdsUser = process.env.CDS_USERNAME;
  const cdsPass = process.env.CDS_PASSWORD;
  const authEnabled = !!(cdsUser && cdsPass);
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
  } else {
    console.warn('  ⚠ Auth: disabled — CDS_USERNAME / CDS_PASSWORD not set, dashboard is open to anyone!');
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

  // When state changes, broadcast to all connected clients
  deps.stateService.onSave(() => {
    if (stateClients.size === 0) return;
    const state = deps.stateService.getState();
    const data = JSON.stringify({
      seq: ++stateSeq,
      branches: Object.values(state.branches),
      defaultBranch: state.defaultBranch,
    });
    for (const client of stateClients) {
      try { client.write(`data: ${data}\n\n`); } catch { stateClients.delete(client); }
    }
  });

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
  app.use('/api', createBranchRouter(deps));

  // Dashboard static files
  app.use(express.static(webDir));

  // SPA fallback — skip WebSocket upgrade requests (handled by http.Server 'upgrade' event)
  app.get('*', (req, res) => {
    if (req.headers.upgrade) return;
    res.sendFile(path.join(webDir, 'index.html'));
  });

  // Log AI access key status
  if (process.env.AI_ACCESS_KEY) {
    console.log('  AI Access: static key configured (AI_ACCESS_KEY)');
  }
  console.log('  AI Pairing: enabled (POST /api/ai/request-access)');

  return app;
}

function parseCookie(cookieStr: string, name: string): string | undefined {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}
