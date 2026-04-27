import express from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBranchRouter } from './routes/branches.js';
import { createBridgeRouter } from './routes/bridge.js';
import { createProjectsRouter } from './routes/projects.js';
import { createPendingImportRouter } from './routes/pending-import.js';
import { createCacheRouter } from './routes/cache.js';
import { createSnapshotsRouter } from './routes/snapshots.js';
import { createInfraBackupRouter } from './routes/infra-backup.js';
import { createLegacyCleanupRouter } from './routes/legacy-cleanup.js';
import { createStorageModeRouter, type StorageModeContext } from './routes/storage-mode.js';
import { createCommentTemplateRouter } from './routes/comment-template.js';
import { createGithubOAuthRouter } from './routes/github-oauth.js';
import { createGithubWebhookRouter } from './routes/github-webhook.js';
import { GitHubAppClient } from './services/github-app-client.js';
import { CheckRunRunner } from './services/check-run-runner.js';
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
    'POST /build-profiles/bulk-set-modes': '批量设置部署命令',
    'GET /export-config': '导出配置',
    'GET /cache/status': '查看缓存状态',
    'POST /cache/repair': '修复缓存挂载',
    'GET /cache/export': '导出缓存包',
    'POST /cache/import': '导入缓存包',
    'POST /cache/purge': '清空缓存目录',
    'GET /proxy-log': '查看转发日志',
    'GET /proxy-log/stream': '订阅转发日志流',
    'GET /config-snapshots': '列出配置快照',
    'POST /config-snapshots': '手动保存配置快照',
    'GET /destructive-ops': '列出破坏性操作',
    'GET /legacy-cleanup/status': '查看 default 遗留状态',
    'POST /legacy-cleanup/rename-default': '迁移 default 项目',
    'POST /legacy-cleanup/cleanup-residual': '清理 default 残留',
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
    // 用户 / 系统基础信息
    'GET /me': '获取当前用户',
    'GET /status': '获取系统状态',
    'GET /healthz': '健康检查',
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
    'GET /pending-imports': '列出待导入项目',
    'POST /projects/:id/pending-import': '提交待导入配置',
    'GET /projects/:id/activity-logs': '获取项目活动日志',
    // 调度 / 集群
    'GET /scheduler/state': '获取调度器状态',
    'PUT /scheduler/enabled': '启停调度器',
    'GET /strategy': '获取调度策略',
    'PUT /strategy': '更新调度策略',
    'GET /connections': '查看集群连接',
    'POST /heartbeat': '集群心跳',
    'POST /join': '加入集群',
    'POST /leave': '离开集群',
    'POST /issue-token': '签发集群令牌',
    'POST /result': '上报任务结果',
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
    'POST /self-force-sync': '自更新强制同步',
    'POST /accept-invite': '接受邀请',
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
    [/^GET \/config-snapshots\/(.+)$/, '查看配置快照详情'],
    [/^POST \/config-snapshots\/(.+)\/rollback$/, '回滚到配置快照'],
    [/^DELETE \/config-snapshots\/(.+)$/, '删除配置快照'],
    [/^POST \/destructive-ops\/(.+)\/undo$/, '撤销破坏性操作'],
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
    [/^DELETE \/ai\/sessions\/(.+)$/, '撤销 AI 会话'],
    [/^POST \/ai\/approve\/(.+)$/, '批准 AI 连接'],
    [/^POST \/ai\/reject\/(.+)$/, '拒绝 AI 连接'],
    [/^GET \/bridge\/state\/(.+)$/, '读取页面状态'],
    [/^POST \/bridge\/command\/(.+)$/, 'AI 操作页面'],
    [/^GET \/bridge\/navigate-requests\/(.+)$/, '查看导航请求'],
    // 项目 (CRUD)
    [/^GET \/projects\/(.+)\/agent-keys$/, '列出项目 Agent Keys'],
    [/^POST \/projects\/(.+)\/agent-keys$/, '创建项目 Agent Key'],
    [/^DELETE \/projects\/(.+)\/agent-keys\/(.+)$/, '删除项目 Agent Key'],
    [/^POST \/projects\/(.+)\/github\/link$/, '关联 GitHub 仓库'],
    [/^DELETE \/projects\/(.+)\/github\/link$/, '解除 GitHub 关联'],
    [/^POST \/projects\/(.+)\/clone$/, '克隆代码'],
    [/^GET \/projects\/(.+)$/, '查询项目'],
    [/^PUT \/projects\/(.+)$/, '更新项目'],
    [/^DELETE \/projects\/(.+)$/, '删除项目'],
    // 待导入项目
    [/^GET \/pending-imports\/(.+)$/, '查询待导入项目'],
    [/^POST \/pending-imports\/(.+)\/approve$/, '批准导入'],
    [/^POST \/pending-imports\/(.+)\/reject$/, '拒绝导入'],
    // 分支扩展
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
    // 构建 Profile 扩展
    [/^PUT \/build-profiles\/(.+)\/deploy-mode$/, '切换部署模式'],
    // 调度器操作
    [/^POST \/scheduler\/pin\/(.+)$/, '固定节点'],
    [/^POST \/scheduler\/unpin\/(.+)$/, '取消固定节点'],
    [/^POST \/scheduler\/cool\/(.+)$/, '冷却节点'],
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

/** Check if a request is from an approved AI session */
function resolveAiSession(req: express.Request, stateService?: StateService): ApprovedAiSession | null {
  // Static mode: CDS_AI_ACCESS_KEY (canonical) 或 legacy AI_ACCESS_KEY 二者命中其一即放行；
  // dashboard customEnv 里的 AI_ACCESS_KEY 字段是用户在 UI 上配的另一个层面，
  // 字段名维持 AI_ACCESS_KEY 不动（用户可见，改名会破坏现有表单存档）。
  const headerKey = req.headers['x-ai-access-key'] as string | undefined;
  if (headerKey) {
    const processKey = process.env.CDS_AI_ACCESS_KEY || process.env.AI_ACCESS_KEY;
    const customKey = stateService?.getCustomEnv()?.['AI_ACCESS_KEY'];
    if ((processKey && headerKey === processKey) || (customKey && headerKey === customKey)) {
      return { id: 'static', agentName: 'AI (static key)', token: headerKey, approvedAt: '', expiresAt: '' };
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
  app.set('etag', false);            // Disable ETag — prevents 304 on API polling (CDS is a dev tool, caching is misleading)
  // `verify` is called with the raw buffer before body-parser parses it.
  // We stash the bytes on req.rawBody so the GitHub webhook route can
  // HMAC-verify the exact payload GitHub signed (re-serialized JSON
  // would produce a different hash and fail signature checks).
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as { rawBody?: Buffer }).rawBody = buf;
    },
  }));

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
      // GitHub webhook is public — it's authenticated by HMAC signature
      // verification inside the handler, not by the cookie/token middleware.
      if (req.method === 'POST' && req.path === '/api/github/webhook') return next();
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

  // Always stamp req.cdsProjectKey for any request that carries a
  // project-scoped Agent Key, regardless of auth mode. The auth
  // middleware above already does this when enabled; this fallback
  // ensures the enforcement hook (assertProjectAccess in
  // routes/projects.ts) sees the scope even when cookie auth is
  // disabled. Cheap no-op when the header is absent or the key is
  // malformed.
  app.use((req, _res, next) => {
    const h = req.headers['x-ai-access-key'] as string | undefined;
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

  // ── Proxy log (全局转发日志) ──
  //
  // 顶部 🔍 面板用。排查「页面正常但 API 502 没日志」时：
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
    res.json({ events, total: all.length, maxId: all.length > 0 ? all[all.length - 1].id : 0 });
  });
  app.get('/api/proxy-log/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
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
  app.use('/api/bridge', createBridgeRouter({
    bridgeService: deps.bridgeService,
    stateService: deps.stateService,  // PR_C.3: 让 bridge 写 AI 占用计数 / activity log
  }));
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
  // Cache diagnostics / repair / cross-server migration.
  // See routes/cache.ts for why this exists (挂载失效诊断 + 换机器预热).
  app.use('/api', createCacheRouter({ stateService: deps.stateService, shell: deps.shell }));
  // ConfigSnapshot (导入/破坏性操作前自动备份) + DestructiveOperationLog (紧急撤销).
  // 见 routes/snapshots.ts 头部注释。
  app.use('/api', createSnapshotsRouter({ stateService: deps.stateService }));
  // 基础设施数据备份/恢复（mongodump/mongorestore/redis dump.rdb/tar）
  app.use('/api', createInfraBackupRouter({ stateService: deps.stateService, shell: deps.shell }));
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

  app.use('/api', createBranchRouter({
    stateService: deps.stateService,
    worktreeService: deps.worktreeService,
    containerService: deps.containerService,
    shell: deps.shell,
    config: deps.config,
    schedulerService: deps.schedulerService,
    registry: deps.registry,
    getClusterStrategy: deps.getClusterStrategy,
    githubApp: githubAppClient,
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

export function installSpaFallback(app: express.Express, webDir?: string): void {
  const dir = webDir || path.resolve(__dirname, '..', 'web');
  // 在 SPA 兜底挂载前做一次 label 覆盖审计。SPA 的 `app.get('*')` 会吃掉
  // 后续所有路由，所以必须在这里做扫描。缺 label 的路由打 warning，但不阻断启动。
  auditApiLabels(app);

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
