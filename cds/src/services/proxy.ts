import http from 'node:http';
import zlib from 'node:zlib';
import type { RoutingRule, BranchEntry, CdsConfig, BuildProfile } from '../types.js';
import { StateService } from './state.js';
import type { WorktreeService } from './worktree.js';
import type { SchedulerService } from './scheduler.js';
import { buildWidgetScript } from '../widget-script.js';
import { computePreviewSlug, previewProjectSlugCandidates } from './preview-slug.js';
import { classifyDeployRuntime } from './deploy-runtime.js';
import { computeWaitTiming } from './wait-timing.js';
import type { DeployDurationMode } from '../types.js';
import {
  classifyHttpRequestKind,
  createBodyCapture,
  isBinaryContentType,
  createRequestId,
  redactHeaders,
  type HttpLogSink,
} from './http-log-store.js';

/**
 * 代理转发事件 —— 每一次经过 worker port 的请求都会生成一条。
 * 用户通过顶部「转发日志」面板查看，专门用于排查：
 *   - 502 但服务器日志为空 → outcome=upstream-error + code=ECONNREFUSED
 *   - 接口无法启动报 502 但页面正常 → branchSlug/profileId 帮定位是哪个服务
 *   - 路由未命中（某个域名没配 routing rule）→ outcome=no-branch-match
 */
export interface ProxyLogEvent {
  id: number;
  ts: string;
  method: string;
  host: string;
  url: string;
  /** 匹配到的 branch slug；未命中时为 null */
  branchSlug: string | null;
  /** 匹配到的 profile id；未识别时为 null */
  profileId: string | null;
  /** 解析出的上游 URL；未解析到为 null */
  upstream: string | null;
  /** 返回给客户端的最终状态码 */
  status: number;
  /** ProxyService 处理全过程耗时（ms） */
  durationMs: number;
  /**
   * 结果分类，供前端染色 / 过滤：
   *   ok — 转发成功 (2xx/3xx)
   *   client-error — 客户端错误 (4xx)
   *   upstream-error — 上游连接/超时类错误 (触发 502)
   *   no-branch-match — 请求进来但 routing rule / 默认分支都没命中
   *   branch-not-running — 分支存在但容器没跑，已降级到 loading/起始页
   *   timeout — 上游长时间无响应
   */
  outcome: 'ok' | 'client-error' | 'upstream-error' | 'no-branch-match' | 'branch-not-running' | 'timeout';
  /** 上游错误码（ECONNREFUSED / ETIMEDOUT 等），便于一眼定位 */
  errorCode?: string;
  errorMessage?: string;
  /** 人类可读的一句诊断（前端直接显示） */
  hint?: string;
}

const PROXY_LOG_BUFFER_MAX = 500;

/**
 * ProxyService — the core of CDS worker port.
 * Routes incoming HTTP requests to the correct branch service
 * based on routing rules (header, domain, pattern matching).
 */
export class ProxyService {
  /** Callback: resolve a branch slug to its upstream URL, or null */
  private resolveUpstream: ((branchId: string, profileId?: string) => string | null) | null = null;
  /** Callback: trigger auto-build for a branch that isn't running yet */
  private onAutoBuild: ((branchSlug: string, req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null;
  /**
   * Callback: render the "branch gone" page (merged / abandoned / generic) for a
   * branch that has a tombstone. Used when a PR-closed branch is NOT auto-deleted
   * by the repo — the stopped BranchEntry lingers, so routeToBranch would otherwise
   * serve the generic stopped-status page and never reach serveBranchGonePage.
   */
  private onBranchGone: ((branchSlug: string, req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null;
  /**
   * Callback: revive a scheduler-cooled branch on preview access (lightweight
   * `docker restart` of preserved containers, no rebuild). Wired only when
   * preview auto-wake is enabled. Must flip branch.status to a loading state
   * synchronously (before its first await) so the waiting page rendered right
   * after firing shows progress instead of the cooled diagnostic page.
   * See .claude/rules/cds-auto-deploy.md + index.ts setOnReviveCooled wiring.
   */
  private onReviveCooled: ((branchSlug: string) => Promise<void>) | null = null;
  /** Slugs with an auto-wake in flight — dedupes concurrent navigation hits. */
  private readonly revivingSlugs = new Set<string>();
  /**
   * #1 重启中断分支按需自愈：访问到一个「被 CDS 重启中断」的 error 分支时触发一次重部署。
   * 与 onReviveCooled 互补 —— 那个 docker restart 复用旧容器（cooled），这个走完整重部署
   * （中断分支容器可能根本没建好）。demand-driven（只恢复用户真正访问的分支）+ 去重，
   * 不复活「每 5min 全量补发」的重试风暴。
   */
  private onRecoverInterrupted: ((branchSlug: string) => Promise<void>) | null = null;
  private readonly recoveringSlugs = new Set<string>();
  /** Callback: notify dashboard of web access events */
  private onAccess: ((branchId: string, method: string, path: string, status: number, duration: number, profileId?: string) => void) | null = null;
  /** Optional worktree service for remote branch lookups */
  private worktreeService: WorktreeService | null = null;
  /** Optional scheduler for warm-pool touch tracking */
  private scheduler: SchedulerService | null = null;
  /** Ring buffer of recent proxy events for the global log panel. */
  private proxyLogBuffer: ProxyLogEvent[] = [];
  private proxyLogSeq = 0;
  private onProxyLog: ((evt: ProxyLogEvent) => void) | null = null;
  private httpLogStore: HttpLogSink | null = null;

  constructor(
    private readonly stateService: StateService,
    private readonly config?: CdsConfig,
  ) {}

  /**
   * Attach the warm-pool scheduler. When set, every successful route to a
   * HOT branch calls scheduler.touch() to refresh LRU ordering.
   * See doc/design.cds.resilience.md §四.4.
   */
  setScheduler(s: SchedulerService): void {
    this.scheduler = s;
  }

  setResolveUpstream(fn: (branchId: string, profileId?: string) => string | null): void {
    this.resolveUpstream = fn;
  }

  setOnAutoBuild(fn: (branchSlug: string, req: http.IncomingMessage, res: http.ServerResponse) => void): void {
    this.onAutoBuild = fn;
  }

  setOnBranchGone(fn: (branchSlug: string, req: http.IncomingMessage, res: http.ServerResponse) => void): void {
    this.onBranchGone = fn;
  }

  setOnReviveCooled(fn: (branchSlug: string) => Promise<void>): void {
    this.onReviveCooled = fn;
  }

  setOnRecoverInterrupted(fn: (branchSlug: string) => Promise<void>): void {
    this.onRecoverInterrupted = fn;
  }

  setOnAccess(fn: (branchId: string, method: string, path: string, status: number, duration: number, profileId?: string) => void): void {
    this.onAccess = fn;
  }

  setWorktreeService(wt: WorktreeService): void {
    this.worktreeService = wt;
  }

  /** Subscribe to live proxy events (for the SSE endpoint). */
  setOnProxyLog(fn: ((evt: ProxyLogEvent) => void) | null): void {
    this.onProxyLog = fn;
  }

  setHttpLogStore(store: HttpLogSink | null): void {
    this.httpLogStore = store;
  }

  /** Snapshot of the ring buffer — used by `GET /api/proxy-log`. */
  getProxyLog(): ProxyLogEvent[] {
    return this.proxyLogBuffer.slice();
  }

  /**
   * Record a single proxy event. Call at each decision point that ends the
   * request's lifecycle (no-branch-match, branch-not-running, upstream-error,
   * normal-finish). Emits to `onProxyLog` callback for SSE fan-out.
   */
  private recordProxyEvent(partial: Omit<ProxyLogEvent, 'id' | 'ts'>): void {
    const evt: ProxyLogEvent = {
      id: ++this.proxyLogSeq,
      ts: new Date().toISOString(),
      ...partial,
    };
    this.proxyLogBuffer.push(evt);
    if (this.proxyLogBuffer.length > PROXY_LOG_BUFFER_MAX) {
      this.proxyLogBuffer.shift();
    }
    if (this.onProxyLog) {
      try { this.onProxyLog(evt); } catch { /* listener errors must not crash proxy */ }
    }
  }

  /**
   * Handle switch-domain requests from Express (master server).
   * Express req/res are compatible with http.IncomingMessage/ServerResponse.
   */
  handleSwitchFromExpress(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.handleSwitchRequest(req, res);
  }

  /**
   * Resolve a branch entry from the slug extracted out of a preview subdomain.
   *
   * 三档查询，顺序固定（详见 cds/src/services/preview-slug.ts 头部 v1/v2/v3
   * 演化注释）：
   *
   *   ① v3 前向匹配（首选）：遍历每个 entry，按它的 (branch, projectSlug)
   *      算 computePreviewSlug；等于输入 slug 就命中。无歧义、最权威。
   *      v3 是 generator 唯一产出格式，所有新链接走这条。
   *
   *   ② v1 兼容：state.branches[slug] 直查。覆盖 legacy 项目（entry id
   *      就是裸 slug）+ 用户外发的 v1 老链接（如 `claude-fix-foo.miduo.org`）。
   *
   *   ③ v2 兼容：state.branches[`${project.slug}-${slug}`] 拼接尝试。
   *      覆盖 ceb2c01～本次改造之间外发的 v2 链接
   *      （如 `prd-agent-claude-fix-foo.miduo.org`）。
   *
   * 三档都 miss 才返回 undefined（→ proxy 走 auto-build）。优先 v3 是
   * 关键：避免 v3 应该命中的请求被 v1/v2 旧规则误抢。
   */
  private resolveBranchEntry(slug: string): BranchEntry | undefined {
    const state = this.stateService.getState();
    const projects = this.stateService.getProjects?.() ?? [];
    const projectById = new Map(projects.map((p) => [p.id, p]));

    // ① v3 前向匹配
    const previewMatches: BranchEntry[] = [];
    for (const entry of Object.values(state.branches)) {
      if (!entry.branch) continue;
      const project = entry.projectId ? projectById.get(entry.projectId) : undefined;
      for (const projectSlug of previewProjectSlugCandidates(project, entry.projectId)) {
        if (computePreviewSlug(entry.branch, projectSlug) === slug) {
          previewMatches.push(entry);
          break;
        }
      }
    }
    if (previewMatches.length > 0) {
      return previewMatches.sort((a, b) => this.comparePreviewCandidates(a, b))[0];
    }

    // ② v1 兼容：裸 slug 直查
    const direct = state.branches[slug];
    if (direct) return direct;

    // ③ v2 兼容：${project.slug}-${slug} 拼接
    for (const project of projects) {
      if (!project.slug || project.legacyFlag) continue;
      const candidate = state.branches[`${project.slug}-${slug}`];
      if (candidate) return candidate;
    }
    return undefined;
  }

  private comparePreviewCandidates(a: BranchEntry, b: BranchEntry): number {
    const score = (entry: BranchEntry): number => {
      const status = String(entry.status || '');
      if (status === 'running') return 5;
      if (status === 'starting' || status === 'building' || status === 'restarting') return 4;
      if (status === 'error') return 2;
      return 1;
    };
    const scoreDelta = score(b) - score(a);
    if (scoreDelta !== 0) return scoreDelta;
    const timeValue = (entry: BranchEntry): number => {
      const raw = entry.lastReadyAt || entry.lastDeployAt || entry.lastDeployDispatchAt || entry.lastPushAt || entry.createdAt;
      const parsed = raw ? Date.parse(raw) : 0;
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return timeValue(b) - timeValue(a);
  }

  /**
   * Resolve which branch should handle a request.
   * Returns the ORIGINAL branch name (not slugified) to preserve "/" and casing.
   */
  resolveBranch(req: http.IncomingMessage): string | null {
    const state = this.stateService.getState();
    const rules = state.routingRules.filter(r => r.enabled);

    // Check X-Branch header first (highest implicit priority)
    const xBranch = req.headers['x-branch'] as string | undefined;
    if (xBranch) return xBranch;

    // Check cds_branch cookie — return as-is (original branch name with "/" and casing)
    const cookieBranch = this.parseCookie(req.headers.cookie || '', 'cds_branch');
    if (cookieBranch) return cookieBranch;

    const host = req.headers.host || '';

    // Evaluate rules by priority
    for (const rule of rules) {
      const matched = this.matchRule(rule, host, req.url || '/');
      if (matched) return matched;
    }

    // Fallback to default branch
    return state.defaultBranch;
  }

  /**
   * Match a single routing rule against the request.
   * Returns the resolved branch slug, or null if no match.
   */
  matchRule(rule: RoutingRule, host: string, url: string): string | null {
    const pattern = rule.match;

    switch (rule.type) {
      case 'header':
        // X-Branch header routing is handled globally in resolveBranch() before rules are evaluated.
        // Rules with type 'header' are no-ops in matchRule — they exist only as data markers.
        return null;

      case 'domain': {
        // Match against host header
        // Support {{wildcard}} patterns: {{agent_*}} matches "agent-xxx.domain.com"
        const regexStr = this.patternToRegex(pattern);
        const match = host.match(new RegExp(regexStr, 'i'));
        if (match) {
          return this.resolveBranchFromMatch(rule.branch, match);
        }
        return null;
      }

      case 'pattern': {
        // Match against URL path
        const regexStr = this.patternToRegex(pattern);
        const match = url.match(new RegExp(regexStr, 'i'));
        if (match) {
          return this.resolveBranchFromMatch(rule.branch, match);
        }
        return null;
      }

      default:
        return null;
    }
  }

  /**
   * Convert a CDS pattern (with {{wildcards}}) to a regex string.
   *
   * Examples:
   *   "{{agent_*}}.domain.com"  → "(agent[^.]*)\\.domain\\.com"
   *   "{{feature_*}}"          → "(feature[^.]*)"
   *   "preview-{{*}}"          → "preview-([^.]*)"
   */
  patternToRegex(pattern: string): string {
    // Extract placeholders first, replace with sentinel tokens
    const placeholders: string[] = [];
    let result = pattern.replace(/\{\{([^}]+)\}\}/g, (_m, inner: string) => {
      placeholders.push(inner);
      return `\x00${placeholders.length - 1}\x00`;
    });
    // Escape regex special chars in the non-placeholder parts
    result = result.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Restore placeholders and convert to regex capture groups
    result = result.replace(/\x00(\d+)\x00/g, (_m, idx: string) => {
      const inner = placeholders[parseInt(idx, 10)];
      // Convert wildcard * to [^.]* (matches until dot for domain safety)
      // Also convert underscores in pattern prefix to match hyphens (feature_ matches feature-)
      const regexInner = inner
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // escape special chars in prefix
        .replace(/\\\*/g, '[^.]*')                  // wildcard
        .replace(/_/g, '[_-]');                      // underscore matches hyphen too
      return `(${regexInner})`;
    });
    return `^${result}$`;
  }

  /**
   * Resolve branch target from a match result.
   * If rule.branch contains $1, $2, etc., substitute from match groups.
   * Otherwise use rule.branch as-is.
   */
  private resolveBranchFromMatch(branchTemplate: string, match: RegExpMatchArray): string {
    let result = branchTemplate;
    for (let i = 1; i < match.length; i++) {
      result = result.replace(`$${i}`, match[i] || '');
    }
    return StateService.slugify(result);
  }

  /**
   * Check if the host matches the configured switch domain.
   */
  private isSwitchDomain(host: string): boolean {
    const switchDomain = this.config?.switchDomain;
    if (!switchDomain) return false;
    const h = host.split(':')[0].toLowerCase();
    return h === switchDomain.toLowerCase();
  }

  /**
   * Check if the host is a preview subdomain (e.g., <slug>.preview.example.com).
   * Returns the branch slug to route to, or null if this isn't a preview host.
   *
   * Resolution order:
   *   1. Extract the label (everything before the rootDomain suffix)
   *   2. Check if any branch owns this label as a `subdomainAliases` entry —
   *      if yes, return that branch's id (case-insensitive)
   *   3. Otherwise, return the label itself and let the caller treat it as a
   *      direct slug lookup (legacy behavior, preserves multi-label support
   *      for anyone using `foo.bar.example.com` style setups)
   *
   * Aliases always win over slug lookups: if a branch has `demo` as an alias,
   * `demo.example.com` routes to that branch even if another branch happens
   * to have the slug "demo".
   */
  private extractPreviewBranch(host: string): string | null {
    const h = host.split(':')[0].toLowerCase();
    const rootDomains = this.config?.rootDomains?.length
      ? this.config.rootDomains
      : (this.config?.previewDomain ? [this.config.previewDomain] : []);

    for (const rootDomain of rootDomains) {
      const suffix = `.${rootDomain.toLowerCase()}`;
      if (h.endsWith(suffix) && h.length > suffix.length) {
        const label = h.slice(0, -suffix.length);
        // First check: does this label match any branch's custom alias?
        // Aliases are single DNS labels (enforced at write time), so this
        // only kicks in for leaf labels like `demo` in `demo.example.com`.
        const aliasHit = this.stateService.findBranchByAlias(label);
        if (aliasHit) return aliasHit;
        // Fallback: treat the label as a branch slug directly (legacy).
        return label;
      }
    }
    return null;
  }

  /**
   * Handle an incoming request on the worker port.
   * Routes to the correct branch or triggers auto-build.
   */
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers.host || '';
    const url = req.url || '/';
    const handleStart = Date.now();

    if (url.startsWith('/_cds/waiting-status')) {
      this.serveWaitingStatus(req, res);
      return;
    }

    // ── /_cds/api/* — passthrough to CDS Dashboard API (master port) ──
    // Allows widgets embedded in proxied apps to call CDS API without CORS issues.
    if (url.startsWith('/_cds/')) {
      const previewSlug = this.extractPreviewBranch(host);
      const sourceEntry = previewSlug ? this.resolveBranchEntry(previewSlug) : undefined;
      // Rewrite path: /_cds/api/branches → /api/branches
      req.url = url.slice(5); // strip "/_cds" prefix
      // Add internal header to bypass auth on master — this request comes
      // from a widget embedded in a proxied app, not an external caller.
      req.headers['x-cds-internal'] = '1';
      // SECURITY U/V (2026-05-10): pin the original preview host so the master
      // bypass middleware can resolve which project this widget belongs to.
      // Without this the master sees `host: 127.0.0.1:9900` (rewritten by
      // proxyRequest) and cannot enforce single-project scope, so any widget
      // could enumerate / deploy ANY project's branches via the bypass.
      // See cds/src/server.ts resolveSourceProject for consumption.
      if (host) req.headers['x-cds-source-host'] = host;
      if (sourceEntry?.projectId) req.headers['x-cds-source-project-id'] = sourceEntry.projectId;
      if (sourceEntry?.id) req.headers['x-cds-source-branch-id'] = sourceEntry.id;
      const masterPort = this.config?.masterPort || 9900;
      this.proxyRequest(req, res, `http://127.0.0.1:${masterPort}`);
      return;
    }

    // ── Switch domain: switch.example.com/<prefix>/<suffix> ──
    if (this.isSwitchDomain(host)) {
      this.handleSwitchRequest(req, res);
      return;
    }

    // ── Preview subdomain: <slug>.preview.example.com ──
    // Each branch gets its own subdomain — no cookies needed, fully independent
    const previewSlug = this.extractPreviewBranch(host);
    if (previewSlug) {
      this.routeToBranch(previewSlug, previewSlug, req, res);
      return;
    }

    // /_switch/<branch> — set cds_branch cookie and redirect to /
    const switchMatch = url.match(/^\/_switch\/(.+?)(?:\?.*)?$/);
    if (switchMatch) {
      const branch = decodeURIComponent(switchMatch[1]);
      const slug = StateService.slugify(branch);
      res.writeHead(302, {
        'Set-Cookie': `cds_branch=${encodeURIComponent(branch)}; Path=/; SameSite=Lax`,
        Location: '/',
        'Content-Type': 'text/plain',
      });
      res.end(`Switched to branch: ${slug}`);
      return;
    }

    // /_clear_branch — remove cds_branch cookie
    if (url === '/_clear_branch') {
      res.writeHead(302, {
        'Set-Cookie': 'cds_branch=; Path=/; Max-Age=0',
        Location: '/',
        'Content-Type': 'text/plain',
      });
      res.end('Branch cookie cleared');
      return;
    }

    const branchRef = this.resolveBranch(req);

    if (!branchRef) {
      // No routing rule matched and no default branch set. Historically returned
      // 502 JSON which rendered as Chrome's raw "HTTP ERROR" page for browsers.
      // Prefer a 404 HTML for browser requests so the tab isn't blank.
      const acceptsHtml = this.isHtmlNavigationRequest(req);
      this.recordProxyEvent({
        method: req.method || 'GET', host, url,
        branchSlug: null, profileId: null, upstream: null,
        status: 404, durationMs: Date.now() - handleStart,
        outcome: 'no-branch-match',
        hint: 'Host 头未命中任何 routing rule，也没配默认分支。检查「路由规则」或 cds_branch cookie。',
      });
      if (acceptsHtml) {
        // Truncate host so a client sending a 4KB Host header can't bloat the
        // HTML body. DNS labels cap at 253 chars total; we allow 120 for safety.
        const hostDisplay = (req.headers.host || '(no host)').slice(0, 120);
        this.serveBranchGoneFallback(res, hostDisplay);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No branch matched. Set X-Branch header or configure routing rules.' }));
      return;
    }

    // branchRef may be original name (e.g. "claude/fix-login-password-issue-CQBMO")
    // State keys are always slugified (e.g. "claude-fix-login-password-issue-cqbmo")
    const branchSlug = StateService.slugify(branchRef);
    this.routeToBranch(branchSlug, branchRef, req, res);
  }

  /**
   * Route a request to a specific branch (by slug).
   * Used by both normal routing and preview subdomain routing.
   */
  private routeToBranch(branchSlug: string, branchRef: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    // Use canonical-id fallback so subdomain hits on non-legacy projects
    // (entries stored as `${projectSlug}-${slug}`) match the bare-slug
    // request without falling through to auto-build on every reload.
    const branch = this.resolveBranchEntry(branchSlug);

    // Loading states — serve friendly waiting page instead of 502/503 so
    // users never see a raw Cloudflare gateway error during build/restart.
    // See `.claude/rules/cds-auto-deploy.md` + doc/design.cds.resilience.md.
    const LOADING_BRANCH_STATUSES: ReadonlySet<string> = new Set([
      'starting', 'building', 'restarting',
    ]);

    // Branch doesn't exist — trigger auto-build (if configured).
    // Existing branches with a terminal/non-running state must not be rebuilt
    // by a passive preview-page visit. Showing their status page keeps the
    // failure source visible and avoids a confusing deploy loop.
    if (!branch) {
      if (this.onAutoBuild) {
        this.onAutoBuild(branchRef, req, res);
        return;
      }
      // No auto-build — still prefer the friendly loading page over a 503 JSON
      // so returning users see something recognizable while they figure out
      // how to restart the branch.
      if (branch) {
        this.serveStartingPageV2(res, branchSlug, branch);
        return;
      }
      // No branch, no auto-build (executor-only mode or mis-configured proxy):
      // serve a minimal 404 HTML for browsers, JSON for API clients. Avoids the
      // Chrome "HTTP ERROR 400/503" blank screen when users land on a
      // subdomain for a deleted branch.
      const acceptsHtml = this.isHtmlNavigationRequest(req);
      if (acceptsHtml) {
        this.serveBranchGoneFallback(res, branchSlug);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Branch "${branchSlug}" not found.`,
        status: 'not-found',
      }));
      return;
    }

    if (branch.status !== 'running' && !LOADING_BRANCH_STATUSES.has(branch.status)) {
      // 墓碑优先：PR 合并/关闭后分支若**未被自动删除**（仓库保留 PR 分支），停止的
      // BranchEntry 仍在，否则会落到下面的泛化「分支已停止」状态页，永远走不到
      // serveBranchGonePage。先查墓碑：命中则与「分支已删除」走同一套合并/放弃页。
      // fail-safe：无墓碑（绝大多数停止分支）则一切照旧；只拦真实 HTML 导航（asset/
      // API 请求继续走状态页，避免把 gone HTML 当成 CSS/JS 返回）。墓碑命中也意味着
      // 不该 auto-wake/恢复一个已合并/已放弃的分支，故置于这些副作用之前直接返回。
      // 按 branchSlug（host label，标准 v3 预览即 previewSlug 主键）**和** branch.id 两路查，
      // 因为墓碑以 previewSlug 为键、branchId 仅作兜底，二者可能都不等于对方（Bugbot）。
      // 命中后转发墓碑自身的 previewSlug（map 主键）给 gone 页，保证它再查必命中。
      const tomb = this.stateService.findRemovedBranchByIdentifier(branchSlug)
        ?? this.stateService.findRemovedBranchByIdentifier(branch.id);
      // 分支名复用：同名分支在旧 PR 合并/放弃后被重建时，旧墓碑仍留在 removedBranches。
      // 仅当墓碑确实**晚于**当前这个 incarnation 的活动时间才分流，否则重建的分支（极速版下
      // idle 等 CI）会被误导到旧的合并/放弃页（Codex P2）。incarnation 基准取 createdAt /
      // lastPushAt / lastDeployAt 最近者；墓碑早于它 = 属于上一代分支 = 陈旧，照常走状态页。
      const liveSince = Math.max(
        Date.parse(branch.createdAt || '') || 0,
        Date.parse(branch.lastPushAt || '') || 0,
        Date.parse(branch.lastDeployAt || '') || 0,
      );
      const tombAt = tomb ? (Date.parse(tomb.removedAt || '') || 0) : 0;
      if (this.onBranchGone && this.isHtmlNavigationRequest(req) && tomb && tombAt >= liveSince) {
        this.onBranchGone(tomb.previewSlug || branch.id, req, res);
        return;
      }
      // Auto-wake: a branch put to sleep by the scheduler (containers preserved,
      // not removed) is revived on a real page navigation via a cheap
      // `docker restart`, so users don't hit a dead-end "go redeploy manually"
      // page just because it idled out. Strictly scoped to scheduler-cooled
      // branches — errored / crashed / user-stopped / deleted branches keep the
      // diagnostic page (no passive deploy loops). Only top-level HTML
      // navigation triggers it (asset/bot/prefetch requests do not), and the
      // revive flips status synchronously so serveBranchStatusResponse below
      // renders the live waiting page instead of the cooled dead-end.
      // Pass the resolved entry id (branch.id) — NOT branchSlug — because for
      // non-legacy/v3 projects the entry lives under a canonical id like
      // `${projectSlug}-${slug}` while branchSlug is the bare preview label.
      // The revive callback does stateService.getBranch(id), so the wrong key
      // would silently no-op (same reason resolveUpstream/scheduler.touch below
      // use branch.id).
      // Restrict the wake to real GET navigations: isHtmlNavigationRequest also
      // accepts HEAD and a missing Accept header, so uptime monitors / link
      // checkers doing `HEAD /` against a preview host must not restart cooled
      // containers (they aren't a user actually opening the page).
      const isGetNavigation = (req.method || 'GET').toUpperCase() === 'GET';
      // Only auto-wake on a PREVIEW host. The waiting page polls
      // /_cds/waiting-status, which resolves the branch solely via
      // extractPreviewBranch(host); for non-preview routing (X-Branch / cookie /
      // routing rule / default branch) that poll can't resolve the branch, so
      // the page would spin forever and never reload after the restart. Gate on
      // the exact same resolution the poll uses, so a wake always implies a
      // pollable waiting page. Non-preview routings keep the diagnostic page.
      const isPreviewHost = this.extractPreviewBranch(req.headers.host || '') !== null;
      // Require a POSITIVE browser-navigation signal (see hasBrowserNavSignal):
      // isHtmlNavigationRequest treats a missing Accept header as HTML, so a
      // bare `GET /` health probe / link checker would otherwise restart cooled
      // containers and defeat scheduler cooling.
      if (
        isGetNavigation
        && isPreviewHost
        && this.hasBrowserNavSignal(req)
        && this.isHtmlNavigationRequest(req)
        && this.shouldAutoWakeCooled(branch)
      ) {
        this.triggerCooledWake(branch.id);
      }
      // #1 重启中断分支按需自愈：被 CDS self-update/崩溃重启打断的 error 分支（含「重启中断」
      // 标记），同样在预览 host + 真实浏览器导航时触发一次完整重部署（去重）。恢复回调同步把
      // status 翻到 loading 再 save，紧接着的 serveBranchStatusResponse 等待页即显示「正在恢复」。
      if (
        isGetNavigation
        && isPreviewHost
        && this.hasBrowserNavSignal(req)
        && this.isHtmlNavigationRequest(req)
        && this.shouldRecoverInterrupted(branch)
      ) {
        this.triggerInterruptedRecovery(branch.id);
      }
      this.serveBranchStatusResponse(req, res, branchSlug, branch);
      return;
    }

    // Branch-level loading: container creating / building / restarting
    if (LOADING_BRANCH_STATUSES.has(branch.status)) {
      this.serveBranchStatusResponse(req, res, branchSlug, branch);
      return;
    }

    // Find the upstream URL for this branch
    if (!this.resolveUpstream) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy not configured' }));
      return;
    }

    const profileId = this.detectProfileFromRequest(req, branch);

    // Service-level loading: branch is "running" (some services up) but
    // the specific service for this request is still initializing.
    // Show loading page instead of proxying to a half-ready server
    // (prevents CSS MIME type errors from Vite returning HTML before ready).
    if (profileId) {
      const svc = branch.services[profileId];
      if (svc && (svc.status === 'starting' || svc.status === 'building' || svc.status === 'restarting')) {
        this.serveBranchStatusResponse(req, res, branchSlug, branch, profileId);
        return;
      }
    }

    // Pass the resolved entry id (may differ from `branchSlug` when the
    // entry lives under a project-scoped canonical id) so resolveUpstream's
    // own `getBranch(id)` lookup hits the right record.
    const upstream = this.resolveUpstream(branch.id, profileId);

    if (!upstream) {
      // No upstream URL resolvable means the browser cannot ever reach the
      // intended app from this request. It is not a recoverable waiting state.
      if (this.isHtmlNavigationRequest(req)) {
        this.serveDeployErrorLightPillarPage(
          res,
          this.displayBranchName(branchSlug, branch),
          profileId
            ? `服务 "${profileId}" 当前没有可代理的运行入口。请回到 CDS 控制台检查容器状态、端口分配与最近停止原因。`
            : '当前分支没有可代理的运行入口。请回到 CDS 控制台检查容器状态、端口分配与最近停止原因。',
          {
            heading: '预览入口不可达',
            description: 'CDS 找到了该分支记录，但当前请求没有可用的上游运行环境。这不是等待会自动完成的状态，请回到控制台处理后重新部署。',
          },
        );
        return;
      }
      this.servePreviewUnavailableResource(req, res, branchSlug, branch, profileId);
      return;
    }

    if (process.env.CDS_PROXY_ACCESS_LOG === '1') {
      console.log(`[proxy] ${req.method} ${req.url} → ${upstream} (branch=${branch.id}, profile=${profileId || 'default'})`);
    }
    // Update warm-pool LRU ordering. Throttling for access-event broadcasts
    // is handled separately via setOnAccess; scheduler.touch is cheap (single
    // save) and correctness depends on every request refreshing lastAccessedAt.
    if (this.scheduler) {
      try { this.scheduler.touch(branch.id); } catch { /* ignore */ }
    }
    this.proxyRequest(req, res, upstream, { branchId: branch.id, branchName: branchRef, trackAccess: true, profileId });
  }

  private serveBranchStatusResponse(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    branchSlug: string,
    branch: BranchEntry,
    waitingProfileId?: string,
  ): void {
    if (this.isHtmlNavigationRequest(req)) {
      this.serveStartingPageV2(res, branchSlug, branch, waitingProfileId);
      return;
    }
    this.servePreviewUnavailableResource(req, res, branchSlug, branch, waitingProfileId);
  }

  private isHtmlNavigationRequest(req: http.IncomingMessage): boolean {
    const method = (req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return false;

    const url = req.url || '/';
    if (this.isStaticAssetRequest(url)) return false;

    const dest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
    if (dest && dest !== 'document' && dest !== 'iframe' && dest !== 'empty') return false;

    const acceptHeader = req.headers.accept;
    if (!acceptHeader) return true;
    const accept = String(acceptHeader).toLowerCase();
    return accept.includes('text/html');
  }

  private isStaticAssetRequest(url: string): boolean {
    let pathname = url;
    try {
      pathname = new URL(url, 'http://cds.local').pathname;
    } catch {
      pathname = url.split('?')[0] || '/';
    }
    const lower = pathname.toLowerCase();
    if (
      lower.startsWith('/@vite/')
      || lower === '/@vite/client'
      || lower.startsWith('/node_modules/')
      || lower.startsWith('/__vite')
    ) {
      return true;
    }
    return /\.(?:js|mjs|cjs|jsx|ts|tsx|css|map|json|wasm|png|jpe?g|gif|webp|svg|ico|avif|woff2?|ttf|otf|eot|mp4|webm|mp3|wav)$/i.test(lower);
  }

  private servePreviewUnavailableResource(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    branchSlug: string,
    branch: BranchEntry,
    waitingProfileId?: string,
  ): void {
    const url = req.url || '/';
    let pathname = url;
    try {
      pathname = new URL(url, 'http://cds.local').pathname;
    } catch {
      pathname = url.split('?')[0] || '/';
    }
    const lower = pathname.toLowerCase();
    const status = branch.status || 'unknown';
    const profileNote = waitingProfileId ? `, service=${waitingProfileId}` : '';
    const message = `CDS preview is not ready: branch=${branchSlug}, status=${status}${profileNote}`;
    const headers: Record<string, string> = {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Retry-After': '2',
    };

    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || lower.endsWith('.jsx') || lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.startsWith('/@vite') || lower.startsWith('/node_modules/')) {
      headers['Content-Type'] = 'application/javascript; charset=utf-8';
      res.writeHead(503, headers);
      if ((req.method || 'GET').toUpperCase() === 'HEAD') {
        res.end();
        return;
      }
      res.end(`throw new Error(${JSON.stringify(message)});\n`);
      return;
    }

    if (lower.endsWith('.css')) {
      headers['Content-Type'] = 'text/css; charset=utf-8';
      res.writeHead(503, headers);
      res.end((req.method || 'GET').toUpperCase() === 'HEAD' ? undefined : `/* ${message} */\n`);
      return;
    }

    if (lower.endsWith('.json') || lower.startsWith('/api/')) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      res.writeHead(503, headers);
      res.end((req.method || 'GET').toUpperCase() === 'HEAD' ? undefined : JSON.stringify({ error: message, status: 'preview-not-ready' }));
      return;
    }

    headers['Content-Type'] = 'text/plain; charset=utf-8';
    res.writeHead(503, headers);
    res.end((req.method || 'GET').toUpperCase() === 'HEAD' ? undefined : message);
  }

  private displayBranchName(branchSlug: string, branch?: BranchEntry): string {
    const actualBranch = branch?.branch?.trim();
    return actualBranch || branchSlug;
  }

  private estimateServiceProgress(service: BranchEntry['services'][string]): {
    percent: number;
    confidence: 'low' | 'medium' | 'high';
    matchedLog: boolean;
  } {
    const status = service.status;
    if (status === 'running') return { percent: 100, confidence: 'high', matchedLog: true };
    if (status === 'error') return { percent: 100, confidence: 'high', matchedLog: true };
    if (status === 'stopping' || status === 'stopped') return { percent: 6, confidence: 'medium', matchedLog: false };
    if (status === 'starting' || status === 'restarting') return { percent: 86, confidence: 'high', matchedLog: true };
    if (status === 'idle') return { percent: 4, confidence: 'low', matchedLog: false };

    const log = `${service.buildLog || ''}\n${service.errorMessage || ''}`.toLowerCase();
    const matchers: Array<{ percent: number; confidence: 'medium' | 'high'; re: RegExp }> = [
      { percent: 94, confidence: 'high', re: /(accepting connections|returned 200|listening on|server ready|ready in|health check passed|就绪探测通过|运行于\s*:?\d+)/ },
      { percent: 78, confidence: 'high', re: /(built in|compiled successfully|successfully built|writing image sha|exporting layers|naming to|发布到|publish\/|publish succeeded)/ },
      { percent: 58, confidence: 'medium', re: /(vite build|dotnet publish|npm run build|pnpm run build|yarn build|docker build|buildx|building image|构建镜像)/ },
      { percent: 40, confidence: 'medium', re: /(npm ci|pnpm install|yarn install|dotnet restore|determining projects to restore|restored .*\.csproj|pip install|go mod download|apt-get|安装依赖)/ },
      { percent: 20, confidence: 'medium', re: /(git clone|git fetch|checkout|pulling|拉取代码|worktree)/ },
    ];
    const matched = matchers.find((item) => item.re.test(log));
    if (matched) {
      return { percent: matched.percent, confidence: matched.confidence, matchedLog: true };
    }
    return { percent: status === 'building' ? 24 : 12, confidence: 'low', matchedLog: false };
  }

  private estimateWaitingProgress(branch: BranchEntry | undefined, waitingProfileId?: string): {
    percent: number;
    confidence: 'low' | 'medium' | 'high';
    label: string;
    reason: string;
  } {
    if (!branch) {
      return { percent: 0, confidence: 'low', label: '等待分支状态', reason: '尚未读取到 CDS 分支状态' };
    }
    if (branch.status === 'running' && (!waitingProfileId || branch.services?.[waitingProfileId]?.status === 'running')) {
      return { percent: 100, confidence: 'high', label: '已就绪', reason: '目标服务已进入 running' };
    }
    if (branch.status === 'error') {
      return { percent: 100, confidence: 'high', label: '已失败', reason: 'CDS 已给出失败状态' };
    }

    const services = Object.values(branch.services || {});
    if (services.length === 0) {
      return { percent: 8, confidence: 'low', label: '等待创建服务', reason: '分支存在，但服务尚未登记' };
    }

    const estimates = services.map((service) => this.estimateServiceProgress(service));
    const average = estimates.reduce((sum, item) => sum + item.percent, 0) / estimates.length;
    const waitingEstimate = waitingProfileId && branch.services?.[waitingProfileId]
      ? this.estimateServiceProgress(branch.services[waitingProfileId])
      : null;
    const weighted = waitingEstimate
      ? waitingEstimate.percent * 0.62 + average * 0.38
      : average;

    const createdAtMs = Date.parse(branch.createdAt || '');
    const elapsedSec = Number.isFinite(createdAtMs) ? Math.max(0, (Date.now() - createdAtMs) / 1000) : 0;
    const timeCurve = Math.min(72, 12 + Math.sqrt(elapsedSec) * 5.4);
    const rawPercent = estimates.some((item) => item.matchedLog)
      ? weighted
      : Math.max(weighted, timeCurve);
    const percent = Math.max(1, Math.min(99, Math.round(rawPercent)));

    const high = estimates.filter((item) => item.confidence === 'high').length;
    const medium = estimates.filter((item) => item.confidence === 'medium').length;
    const confidence: 'low' | 'medium' | 'high' = high > 0
      ? 'high'
      : medium > 0
        ? 'medium'
        : 'low';
    const label = branch.status === 'building'
      ? '预计构建进度'
      : branch.status === 'starting' || branch.status === 'restarting'
        ? '预计启动进度'
        : '预计处理进度';
    const reason = estimates.some((item) => item.matchedLog)
      ? `基于 ${services.length} 个服务状态与构建日志估算`
      : `基于 ${services.length} 个服务状态与运行时长估算`;

    return { percent, confidence, label, reason };
  }

  /**
   * 推断"本次 deploy/build 真正开始的时间"。
   *
   * 首选：分支上钉的 lastDeployStartedAt —— 在 status 切到 building 的那一刻打戳，
   *      是在途构建唯一可靠的起点。在途构建的 op-log 直到 finalize 才落库，期间
   *      getLogs() 只剩上一轮已完成的部署，若以历史 op-log 兜底会算成几小时/几天
   *      误判 overdue（修复 PR #865 Codex P2）。仅当分支处于在途态（building/
   *      starting/restarting）才优先它，避免 running 后还指向上一次构建起点。
   * 其次：当前正在跑（status==='running'）的 build/run/auto-build op-log 的 startedAt。
   * 退而求其次：最新一条 op-log 的 startedAt（可能刚结束但页面还没切走）。
   * 最终兜底：branch.createdAt（对 re-deploy 已过期，故仅在无任何来源时用）。
   */
  private resolveDeployStartedAtMs(branch: BranchEntry): number | null {
    const parse = (s?: string): number | null => {
      if (!s) return null;
      const ms = Date.parse(s);
      return Number.isFinite(ms) ? ms : null;
    };
    // 分支上钉的本轮 deploy 起点。每个部署起点（多服务/单服务/远端执行器）都会
    // 在 status 切到 building 时刷新它，所以它永远等于"最近一次部署的开始时刻"。
    const stamped = parse(branch.lastDeployStartedAt);
    // 0) 在途构建：op-log 此刻还没落库，stamped 是唯一可靠起点。
    const interim = branch.status === 'building' || branch.status === 'starting' || branch.status === 'restarting';
    if (interim && stamped != null) return stamped;

    let logs: import('../types.js').OperationLog[] = [];
    try {
      logs = this.stateService.getLogs?.(branch.id) || [];
    } catch {
      logs = [];
    }
    const deployTypes = new Set(['build', 'run', 'auto-build']);
    // 1) 最新的"正在跑"的部署 op-log
    let running: import('../types.js').OperationLog | null = null;
    let newest: import('../types.js').OperationLog | null = null;
    for (const log of logs) {
      if (!deployTypes.has(log.type)) continue;
      const startedMs = parse(log.startedAt);
      if (startedMs == null) continue;
      if (!newest || startedMs > (parse(newest.startedAt) ?? -Infinity)) newest = log;
      if (log.status === 'running') {
        if (!running || startedMs > (parse(running.startedAt) ?? -Infinity)) running = log;
      }
    }
    const pickedMs = parse((running || newest)?.startedAt);
    // 2) stamped 不旧于最新 op-log 时优先它 —— 覆盖单服务重部署：该路径只把
    //    svc.status 置 building、分支 status 未必翻 building（interim 检测漏接），
    //    但 lastDeployStartedAt 已刷新，且必然 >= 上一轮已完成 op-log 的 startedAt，
    //    故能盖过陈旧日志，不再误算几小时（修复 PR #865 Bugbot「单服务部署 ETA 偏斜」）。
    if (stamped != null && (pickedMs == null || stamped >= pickedMs)) return stamped;
    if (pickedMs != null) return pickedMs;
    // 3) 最终兜底：分支创建时间（对 re-deploy 偏旧，仅在无任何来源时用）
    return stamped ?? parse(branch.createdAt);
  }

  /**
   * 选择历史耗时桶的模式（release vs source）。
   *
   * 真相来源 = 正在跑/等待的服务实际钉的 deployedMode；构建中往往还没钉
   * （undefined）→ 默认 source（热加载，预览最常见场景，与 classifyDeployRuntime
   * 对空 modeId 的归类一致）。选中桶无样本但另一桶有样本时回退到另一桶，
   * 并按回退后的桶标注 mode，保证有数可用又不张冠李戴。
   */
  private resolveWaitTimingMode(
    branch: BranchEntry,
    waitingProfileId?: string,
  ): { mode: DeployDurationMode; estimate: { medianMs: number | null; samples: number } } {
    const svc = waitingProfileId ? branch.services?.[waitingProfileId] : undefined;
    const deployedMode = svc?.deployedMode;
    // 优先用容器已戳的运行模式；服务还没就绪(pending release 重建中)时 deployedMode
    // 未戳，退化用"配置的目标 deploy mode"（profileOverride > profile.activeDeployMode）
    // 判定，避免把正在重建的发布版误判成热加载、用错样本桶（修复 PR #865 codex P2
    // 「pending 发布用源码 ETA」）。拿不到目标模式才兜底 source。
    let modeSource = deployedMode;
    if (modeSource === undefined || modeSource === '') {
      // 仅限本分支所属项目的 profile——CDS 是多项目实例，getBuildProfiles() 返回
      // 全实例所有项目的 profile，全量会让别的项目的发布版 profile 串改本分支 ETA。
      // 用 canonical 的 getBuildProfilesForProject（内部按 (projectId||'default') 归一），
      // 并把分支 projectId 同样归一，避免 undefined vs 'default' 不匹配导致过滤为空、
      // 误退化成 source（修复 PR #865 Bugbot「foreign profiles」+「filter mismatch」）。
      const projectProfiles = this.stateService.getBuildProfilesForProject(branch.projectId || 'default');
      const targetModeFor = (pid: string): string | undefined =>
        branch.profileOverrides?.[pid]?.activeDeployMode
        ?? projectProfiles.find((p) => p.id === pid)?.activeDeployMode;
      if (waitingProfileId) {
        modeSource = targetModeFor(waitingProfileId);
      } else {
        // 整分支等待：本项目任一 profile 目标是发布版 → 按发布版估。
        const ids = Object.keys(branch.services || {});
        const scanIds = ids.length ? ids : projectProfiles.map((p) => p.id);
        const anyRelease = scanIds
          .some((pid) => { const m = targetModeFor(pid); return m ? classifyDeployRuntime(m) === 'release' : false; });
        modeSource = anyRelease ? 'release' : undefined;
      }
    }
    const preferred: DeployDurationMode =
      modeSource !== undefined && modeSource !== ''
        ? classifyDeployRuntime(modeSource)
        : 'source';
    const full = this.stateService.getBranchDeployEstimate(branch.projectId);
    const buckets: Record<DeployDurationMode, { medianMs: number | null; samples: number }> = {
      release: { medianMs: full.releaseMedianMs, samples: full.releaseSamples },
      source: { medianMs: full.sourceMedianMs, samples: full.sourceSamples },
    };
    // 只用首选模式的样本桶，绝不跨模式回退。跨模式（用另一模式的中位）会张冠李戴：
    // 用户在等发布版重建却拿到热加载的短 ETA（发布版通常慢得多），正是首次发布版
    // 重建最容易误导的场景。首选桶无样本就返回 0 样本，等待页据此显示"正在积累
    // 历史数据，暂无预计"，宁可不给也不给错（no-rootless-tree，修复 PR #865 Codex P2
    // 「Keep release waits on the release estimate bucket」）。
    return { mode: preferred, estimate: buckets[preferred] };
  }

  private serveWaitingStatus(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers.host || '';
    const previewSlug = this.extractPreviewBranch(host) || '';
    const branch = previewSlug ? this.resolveBranchEntry(previewSlug) : undefined;
    const url = new URL(req.url || '/_cds/waiting-status', 'http://cds.local');
    const waitingProfileId = url.searchParams.get('profile') || undefined;
    const services = branch ? Object.values(branch.services || {}) : [];
    const waitingService = waitingProfileId && branch ? branch.services?.[waitingProfileId] : undefined;
    const ready = Boolean(branch && branch.status === 'running' && (!waitingProfileId || waitingService?.status === 'running'));
    // 极速版「等待 CI 镜像」也算 loading：分支生命周期 status 仍是 idle（容器没起），但
    // CI 完成后 CDS 会自动拉取部署 —— 等待页必须把它当加载态，否则 poll 会因 loading===false
    // 连续 3 拍后把访客 reload 到「未运行 / 请手动重新部署」诊断页（其实根本不用手动）。
    const loading = Boolean(branch && (branch.status === 'building' || branch.status === 'starting' || branch.status === 'restarting' || branch.ciImageStatus === 'waiting' || waitingService?.status === 'building' || waitingService?.status === 'starting' || waitingService?.status === 'restarting'));
    const displayBranch = this.displayBranchName(previewSlug, branch);

    let timing: (ReturnType<typeof computeWaitTiming> & { mode: DeployDurationMode }) | null = null;
    if (branch) {
      const { mode, estimate } = this.resolveWaitTimingMode(branch, waitingProfileId);
      const computed = computeWaitTiming({
        status: branch.status,
        deployStartedAtMs: this.resolveDeployStartedAtMs(branch),
        nowMs: Date.now(),
        estimate,
      });
      timing = { ...computed, mode };
    }

    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(JSON.stringify({
      ok: true,
      ready,
      loading,
      branch: displayBranch,
      branchSlug: previewSlug,
      displayBranch,
      status: branch?.status || 'not-found',
      waitingProfileId: waitingProfileId || null,
      progress: this.estimateWaitingProgress(branch, waitingProfileId),
      timing,
      buildMode: timing?.mode || null,
      modeLabel: timing ? (timing.mode === 'release' ? '极速版' : '源码') : null,
      branchPanelUrl: branch && this.dashboardBaseUrl()
        ? `${this.dashboardBaseUrl()}/branch-panel/${branch.id}`
        : null,
      prUrl: branch && branch.githubRepoFullName && branch.githubPrNumber
        ? `https://github.com/${branch.githubRepoFullName}/pull/${branch.githubPrNumber}`
        : null,
      prLabel: branch?.githubPrNumber ? `PR #${branch.githubPrNumber}` : null,
      services: services.map((svc) => ({
        profileId: svc.profileId,
        status: svc.status,
      })),
      errorMessage: branch?.errorMessage || null,
    }));
  }

  private isRecoverablePreviewStatus(status: string | undefined): boolean {
    return status === 'building' || status === 'starting' || status === 'restarting';
  }

  private failureCopyForBranch(branch: BranchEntry): { heading: string; description: string; detail?: string } | null {
    const status = String(branch.status || '');
    if (this.isRecoverablePreviewStatus(status) || status === 'running') return null;
    // 极速版「等待 CI 镜像」不是失败态：push 后 CDS 在等 GitHub Actions 把该 commit 的预构建
    // 镜像推到 ghcr，完成后会自动拉取部署。此窗口 status 仍是 idle，但绝不能落到下面的
    // 「未运行 / 请手动重新部署」诊断页（误导用户去手动操作）。返回 null → 走 serveStartingPageV2
    // 的等待页（「预览环境准备中 · 极速版正在拉取分支」+ 自动刷新）。
    if (branch.ciImageStatus === 'waiting') return null;
    // 极速版 CI 构建失败（conclusion 非 success / 看门狗等待超时）：这才是需要人工介入的终态，
    // 给出明确的 CI 归因 + 下一步（切回源码编译或重跑 CI），而不是泛化的「未运行」。
    if (branch.ciImageStatus === 'failed') {
      return {
        heading: '极速版镜像未就绪',
        description: '该分支为极速版（CI 预构建镜像）模式，但本次 commit 的镜像构建未成功或等待超时，因此没有可用的运行环境。可在分支详情切回源码编译，或重跑 GitHub Actions 构建后重新部署。',
        detail: branch.ciImageError || branch.errorMessage || branch.lastStopReason,
      };
    }
    if (status === 'idle' || status === 'stopping') {
      return {
        heading: '分支当前未运行',
        description: '该分支当前没有可用的预览运行环境。预览访问不会自动重新部署，请回到 CDS 控制台确认日志后手动重新部署。',
        detail: branch.errorMessage || branch.lastStopReason,
      };
    }
    if (status === 'error') {
      return {
        heading: '分支部署出现异常',
        description: '该分支已经进入 CDS，但部署过程失败、服务异常，或当前没有可用的运行环境。请回到控制台检查分支状态、容器日志和最近停止原因。',
        detail: branch.errorMessage || branch.lastStopReason,
      };
    }
    return {
      heading: '预览入口不可达',
      description: 'CDS 找到了该分支记录，但当前状态无法到达真实页面。这不是等待会自动完成的状态，请回到控制台处理后重新部署。',
      detail: branch.errorMessage || branch.lastStopReason,
    };
  }

  /**
   * Is this branch eligible for preview auto-wake? Only branches the scheduler
   * cooled (idle/stopped with lastStopSource='scheduler') and that still have
   * preserved service containers to restart. Everything else (errored, crashed,
   * OOM, user-stopped, deleted, or no built services) is left to its diagnostic
   * page so a passive visit can never restart a broken or intentionally-stopped
   * branch.
   */
  /**
   * Stricter than isHtmlNavigationRequest: require a POSITIVE browser-navigation
   * signal before auto-waking a cooled container. isHtmlNavigationRequest treats
   * a missing Accept header as HTML, so a bare `GET /` from a health probe / link
   * checker would otherwise restart containers and defeat scheduler cooling.
   * Real browser navigations always send `Accept: text/html` (and modern ones
   * `Sec-Fetch-Mode: navigate` / `Sec-Fetch-Dest: document`).
   */
  private hasBrowserNavSignal(req: http.IncomingMessage): boolean {
    // Prefetch / prerender / link-preview fetches carry Accept: text/html but
    // are NOT an actual visit — waking a cooled container for them defeats
    // scheduler cooling. Reject them before accepting any HTML signal.
    // Covers Chrome (Sec-Purpose: prefetch;prerender / Purpose: prefetch),
    // Firefox (X-Moz: prefetch), and legacy X-Purpose: preview/prefetch.
    const secPurpose = String(req.headers['sec-purpose'] || '').toLowerCase();
    if (secPurpose.includes('prefetch') || secPurpose.includes('prerender')) return false;
    const purpose = String(req.headers['purpose'] || '').toLowerCase();
    if (purpose.includes('prefetch')) return false;
    const xPurpose = String(req.headers['x-purpose'] || '').toLowerCase();
    if (xPurpose.includes('prefetch') || xPurpose.includes('preview')) return false;
    const xMoz = String(req.headers['x-moz'] || '').toLowerCase();
    if (xMoz.includes('prefetch')) return false;

    const accept = String(req.headers['accept'] || '').toLowerCase();
    if (accept.includes('text/html')) return true;
    const mode = String(req.headers['sec-fetch-mode'] || '').toLowerCase();
    if (mode === 'navigate') return true;
    const dest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
    if (dest === 'document') return true;
    return false;
  }

  private shouldAutoWakeCooled(branch: BranchEntry): boolean {
    if (!this.onReviveCooled) return false;
    if (branch.lastStopSource !== 'scheduler') return false;
    if (branch.status !== 'idle') return false;
    // Executor-owned (remote) branches can't be revived by a local docker
    // restart — a resolved local deploy clears executorId, so a truthy value
    // means a remote executor (present or temporarily absent). The index.ts
    // revive callback double-guards this.
    if (branch.executorId) return false;
    return Object.keys(branch.services || {}).length > 0;
  }

  /**
   * Fire the wake callback for a cooled branch, deduped per slug. Called
   * synchronously so the callback can flip branch.status to a loading state
   * (before its first await); the waiting page rendered immediately after this
   * returns then reflects that progress. On lease conflict (a deploy/cool is
   * already running) the callback rejects without flipping status, and the
   * branch's diagnostic page shows as before — that other operation owns it.
   */
  /**
   * #1 该分支是否「被 CDS 重启中断」可按需自愈？只认这个**已知瞬态、重跑安全**的原因
   * （CDS self-update / 崩溃重启打断了在途部署），不碰真正的构建失败 / 崩溃 / 用户停止。
   * 远端执行器分支不在本机重部署范围（executorId 真值 = 远端）。
   */
  private shouldRecoverInterrupted(branch: BranchEntry): boolean {
    if (!this.onRecoverInterrupted) return false;
    if (branch.status !== 'error') return false;
    if (branch.executorId) return false;
    if (Object.keys(branch.services || {}).length === 0) return false;
    const marker = '重启中断';
    if (typeof branch.errorMessage === 'string' && branch.errorMessage.includes(marker)) return true;
    for (const svc of Object.values(branch.services || {})) {
      if (typeof svc?.errorMessage === 'string' && svc.errorMessage.includes(marker)) return true;
    }
    return false;
  }

  /** 触发一次中断恢复重部署，按 slug 去重（并发导航不重复打）。 */
  private triggerInterruptedRecovery(slug: string): void {
    if (!this.onRecoverInterrupted || this.recoveringSlugs.has(slug)) return;
    this.recoveringSlugs.add(slug);
    let pending: Promise<void>;
    try {
      pending = this.onRecoverInterrupted(slug);
    } catch (err) {
      this.recoveringSlugs.delete(slug);
      console.error(`[proxy] interrupted-recovery threw for "${slug}": ${(err as Error).message}`);
      return;
    }
    pending
      .catch((err) => {
        console.error(`[proxy] interrupted-recovery failed for "${slug}": ${(err as Error).message}`);
      })
      .finally(() => {
        // 留一小段去重窗口，避免重部署刚把 status 翻 building 前的并发导航重复打。
        setTimeout(() => this.recoveringSlugs.delete(slug), 5000);
      });
  }

  private triggerCooledWake(slug: string): void {
    if (!this.onReviveCooled || this.revivingSlugs.has(slug)) return;
    this.revivingSlugs.add(slug);
    let pending: Promise<void>;
    try {
      pending = this.onReviveCooled(slug);
    } catch (err) {
      this.revivingSlugs.delete(slug);
      console.error(`[proxy] auto-wake threw for "${slug}": ${(err as Error).message}`);
      return;
    }
    pending
      .catch((err) => {
        console.error(`[proxy] auto-wake failed for "${slug}": ${(err as Error).message}`);
      })
      .finally(() => {
        this.revivingSlugs.delete(slug);
      });
  }

  private failureCopyForService(service: BranchEntry['services'][string] | undefined, profileId: string): { heading: string; description: string; detail?: string } | null {
    const status = String(service?.status || '');
    if (!service || this.isRecoverablePreviewStatus(status) || status === 'running') return null;
    if (status === 'idle' || status === 'stopped' || status === 'stopping') {
      return {
        heading: '服务当前未运行',
        description: `目标服务 "${profileId}" 当前没有可用容器。预览访问不会自动启动它，请回到 CDS 控制台检查停止原因后手动重新部署。`,
        detail: service.errorMessage,
      };
    }
    if (status === 'error') {
      return {
        heading: '服务部署出现异常',
        description: `目标服务 "${profileId}" 已进入失败状态，无法到达真实页面。请回到控制台查看容器日志、构建日志和最近停止原因。`,
        detail: service.errorMessage,
      };
    }
    return {
      heading: '预览入口不可达',
      description: `目标服务 "${profileId}" 当前状态无法到达真实页面。这不是等待会自动完成的状态，请回到控制台处理后重新部署。`,
      detail: service.errorMessage,
    };
  }

  private serveDeployErrorLightPillarPage(
    res: http.ServerResponse,
    displayBranch: string,
    errorMessage?: string,
    opts: { heading?: string; description?: string } = {},
  ): void {
    const safeBranch = this.escapeHtml(displayBranch);
    const safeHeading = this.escapeHtml(opts.heading || '分支部署出现异常');
    const safeDescription = this.escapeHtml(opts.description || '该分支已经进入 CDS，但部署过程失败、服务异常，或当前没有可用的运行环境。请回到控制台检查分支状态、容器日志和最近停止原因。');
    const safeError = errorMessage ? this.escapeHtml(errorMessage).slice(0, 420) : '';
    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeHeading} · ${safeBranch}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{color-scheme:dark;--bg:#050407;--text:#f7f5ff;--muted:rgba(245,242,255,.62);--panel:rgba(255,255,255,.035);--line:rgba(255,255,255,.12);--danger:#fca5a5}
html,body{min-height:100%}
body{min-height:100vh;overflow:hidden;background:var(--bg);color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body::before{content:"";position:fixed;inset:0;background:radial-gradient(760px 560px at 58% 48%,rgba(82,39,255,.2),transparent 66%),linear-gradient(90deg,rgba(5,4,7,.92),rgba(5,4,7,.22),rgba(5,4,7,.82));z-index:1;pointer-events:none}
body::after{content:"";position:fixed;inset:0;z-index:1;pointer-events:none;opacity:.28;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:84px 84px;mask-image:radial-gradient(circle at 52% 48%,#000 0%,transparent 72%)}
.light-pillar{position:fixed;inset:0;z-index:0;width:100%;height:100%;display:block;mix-blend-mode:screen}
.light-pillar.is-static{background:linear-gradient(100deg,transparent 18%,rgba(82,39,255,.38) 46%,rgba(255,159,252,.36) 54%,transparent 82%);filter:blur(18px)}
.shell{position:relative;z-index:2;min-height:100vh;display:grid;align-items:center;padding:clamp(34px,7vw,96px)}
.content{max-width:720px;text-shadow:0 20px 80px rgba(0,0,0,.72)}
.eyebrow{display:inline-flex;align-items:center;gap:10px;margin-bottom:28px;color:var(--muted);font:600 11px/1 "JetBrains Mono","SFMono-Regular",monospace;letter-spacing:.28em;text-transform:uppercase}
.eyebrow::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--danger);box-shadow:0 0 18px var(--danger);animation:pulse 1.7s ease-in-out infinite}
h1{font-size:clamp(42px,5.5vw,78px);line-height:.96;letter-spacing:0;margin-bottom:22px}
.desc{max-width:620px;color:var(--muted);font-size:clamp(15px,1.35vw,20px);line-height:1.75;margin-bottom:24px}
.chip{display:inline-flex;max-width:min(720px,88vw);align-items:center;border:1px solid var(--line);border-radius:999px;background:var(--panel);backdrop-filter:blur(12px);padding:10px 15px;color:var(--danger);font:600 13px/1.5 "JetBrains Mono","SFMono-Regular",monospace;word-break:break-all}
.err{margin-top:18px;max-width:680px;border-left:2px solid rgba(252,165,165,.5);padding:8px 0 8px 14px;color:rgba(252,165,165,.86);font:12px/1.7 "JetBrains Mono","SFMono-Regular",monospace}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
.btn{border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--text);padding:10px 16px;text-decoration:none;font-size:13px;font-weight:700}
.hint{margin-top:28px;color:var(--muted);font-size:12px}
@keyframes pulse{0%,100%{transform:scale(.76);opacity:.62}50%{transform:scale(1.24);opacity:1}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important}}
</style></head><body>
<canvas class="light-pillar" id="light-pillar" aria-hidden="true"></canvas>
<main class="shell">
  <section class="content">
    <div class="eyebrow">CDS Preview Failed</div>
    <h1>${safeHeading}</h1>
    <p class="desc">${safeDescription}</p>
    <div class="chip">${safeBranch}</div>
    ${safeError ? `<div class="err">${safeError}</div>` : ''}
    <div class="actions">
      <a class="btn" href="${this.dashboardBaseUrl()}/project-list">返回 CDS 控制台</a>
      <a class="btn" href="${this.dashboardBaseUrl()}/cds-settings#loading-pages">查看加载页预览</a>
    </div>
    <div class="hint">CDS 会优先保留可诊断信息，避免把访问者带到空白或浏览器原生错误页。</div>
  </section>
</main>
<script id="light-pillar-vertex" type="x-shader/x-vertex">
attribute vec2 aPosition;
varying vec2 vUv;
void main(){vUv=(aPosition+1.0)*0.5;gl_Position=vec4(aPosition,0.0,1.0);}
</script>
<script id="light-pillar-fragment" type="x-shader/x-fragment">
precision highp float;
uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uTopColor;
uniform vec3 uBottomColor;
uniform float uIntensity;
uniform float uGlowAmount;
uniform float uPillarWidth;
uniform float uPillarHeight;
uniform float uNoiseIntensity;
uniform float uRotCos;
uniform float uRotSin;
uniform float uPillarRotCos;
uniform float uPillarRotSin;
uniform float uWaveSin;
uniform float uWaveCos;
varying vec2 vUv;
const float STEP_MULT=1.0;
const int MAX_ITER=80;
const int WAVE_ITER=4;
vec3 tanh3(vec3 x){
  vec3 e2x=exp(2.0*x);
  return (e2x-1.0)/(e2x+1.0);
}
void main(){
  vec2 uv=(vUv*2.0-1.0)*vec2(uResolution.x/uResolution.y,1.0);
  uv=vec2(uPillarRotCos*uv.x-uPillarRotSin*uv.y,uPillarRotSin*uv.x+uPillarRotCos*uv.y);
  vec3 ro=vec3(0.0,0.0,-10.0);
  vec3 rd=normalize(vec3(uv,1.0));
  vec3 col=vec3(0.0);
  float t=0.1;
  for(int i=0;i<MAX_ITER;i++){
    vec3 p=ro+rd*t;
    p.xz=vec2(uRotCos*p.x-uRotSin*p.z,uRotSin*p.x+uRotCos*p.z);
    vec3 q=p;
    q.y=p.y*uPillarHeight+uTime;
    float freq=1.0;
    float amp=1.0;
    for(int j=0;j<WAVE_ITER;j++){
      q.xz=vec2(uWaveCos*q.x-uWaveSin*q.z,uWaveSin*q.x+uWaveCos*q.z);
      q+=cos(q.zxy*freq-uTime*float(j)*2.0)*amp;
      freq*=2.0;
      amp*=0.5;
    }
    float d=length(cos(q.xz))-0.2;
    float bound=length(p.xz)-uPillarWidth;
    float k=4.0;
    float h=max(k-abs(d-bound),0.0);
    d=max(d,bound)+h*h*0.0625/k;
    d=abs(d)*0.15+0.01;
    float grad=clamp((15.0-p.y)/30.0,0.0,1.0);
    col+=mix(uBottomColor,uTopColor,grad)/d;
    t+=d*STEP_MULT;
    if(t>50.0)break;
  }
  float widthNorm=uPillarWidth/3.0;
  col=tanh3(col*uGlowAmount/widthNorm);
  col-=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)/15.0*uNoiseIntensity;
  gl_FragColor=vec4(col*uIntensity,1.0);
}
</script>
<script>
(function(){
  var canvas=document.getElementById('light-pillar');
  if(!canvas)return;
  var reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var gl=canvas.getContext('webgl',{alpha:true,antialias:false,depth:false,stencil:false});
  if(!gl){canvas.className='light-pillar is-static';return;}
  function source(id){var n=document.getElementById(id);return n?n.textContent:'';}
  function shader(type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){throw new Error(gl.getShaderInfoLog(s)||'shader failed');}return s;}
  function hex(v){var r=String(v).replace('#','');var n=parseInt(r.length===3?r.replace(/(.)/g,'$1$1'):r,16);return [(n>>16&255)/255,(n>>8&255)/255,(n&255)/255];}
  var program;
  try{
    program=gl.createProgram();
    gl.attachShader(program,shader(gl.VERTEX_SHADER,source('light-pillar-vertex')));
    gl.attachShader(program,shader(gl.FRAGMENT_SHADER,source('light-pillar-fragment')));
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'link failed');
  }catch(e){canvas.className='light-pillar is-static';return;}
  gl.useProgram(program);
  var buffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  var pos=gl.getAttribLocation(program,'aPosition');
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos,2,gl.FLOAT,false,0,0);
  var loc={};
  ['uTime','uResolution','uTopColor','uBottomColor','uIntensity','uGlowAmount','uPillarWidth','uPillarHeight','uNoiseIntensity','uRotCos','uRotSin','uPillarRotCos','uPillarRotSin','uWaveSin','uWaveCos'].forEach(function(name){loc[name]=gl.getUniformLocation(program,name);});
  var top=hex('#5227FF');
  var bottom=hex('#FF9FFC');
  var pillarRot=25*Math.PI/180;
  gl.uniform3f(loc.uTopColor,top[0],top[1],top[2]);
  gl.uniform3f(loc.uBottomColor,bottom[0],bottom[1],bottom[2]);
  gl.uniform1f(loc.uIntensity,1);
  gl.uniform1f(loc.uGlowAmount,.002);
  gl.uniform1f(loc.uPillarWidth,3);
  gl.uniform1f(loc.uPillarHeight,.4);
  gl.uniform1f(loc.uNoiseIntensity,.5);
  gl.uniform1f(loc.uPillarRotCos,Math.cos(pillarRot));
  gl.uniform1f(loc.uPillarRotSin,Math.sin(pillarRot));
  gl.uniform1f(loc.uWaveSin,Math.sin(.4));
  gl.uniform1f(loc.uWaveCos,Math.cos(.4));
  function resize(){
    var d=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.floor(window.innerWidth*d));
    canvas.height=Math.max(1,Math.floor(window.innerHeight*d));
    canvas.style.width='100%';
    canvas.style.height='100%';
    gl.viewport(0,0,canvas.width,canvas.height);
    gl.uniform2f(loc.uResolution,canvas.width,canvas.height);
  }
  function draw(t){
    var time=reduced?0:t*.001*.3;
    gl.clearColor(0,0,0,0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(loc.uTime,time);
    gl.uniform1f(loc.uRotCos,Math.cos(time*.3));
    gl.uniform1f(loc.uRotSin,Math.sin(time*.3));
    gl.drawArrays(gl.TRIANGLES,0,6);
    requestAnimationFrame(draw);
  }
  resize();
  window.addEventListener('resize',resize);
  requestAnimationFrame(draw);
}());
</script>
</body></html>`;

    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Retry-After': '2',
    });
    res.end(html);
  }

  serveStartingPageV2(res: http.ServerResponse, branchSlug: string, branch: BranchEntry, waitingProfileId?: string): void {
    const services = Object.values(branch.services);
    const displayBranch = this.displayBranchName(branchSlug, branch);
    const waitingService = waitingProfileId ? branch.services?.[waitingProfileId] : undefined;
    const serviceFailure = waitingProfileId ? this.failureCopyForService(waitingService, waitingProfileId) : null;
    const branchFailure = this.failureCopyForBranch(branch);
    const failureCopy = branchFailure || serviceFailure;
    if (failureCopy) {
      this.serveDeployErrorLightPillarPage(res, displayBranch, failureCopy.detail, {
        heading: failureCopy.heading,
        description: failureCopy.description,
      });
      return;
    }
    const progress = this.estimateWaitingProgress(branch, waitingProfileId);
    const safeBranch = this.escapeHtml(displayBranch);
    const safeProgressLabel = this.escapeHtml(progress.label);
    const safeProgressReason = this.escapeHtml(progress.reason);
    const safeProgressConfidence = this.escapeHtml(progress.confidence === 'high' ? '高' : progress.confidence === 'medium' ? '中' : '低');
    const safeWaitingProfile = waitingProfileId ? this.escapeHtml(waitingProfileId) : '';
    const branchStatus = String(branch.status);
    const stageLabel = (status: string): string => {
      switch (status) {
        case 'building': return '构建中';
        case 'starting': return '启动中';
        case 'restarting': return '重启中';
        case 'running': return '已就绪';
        case 'error': return '失败';
        case 'stopping': return '停止中';
        case 'stopped': return '已停止';
        default: return '待命';
      }
    };
    const colorFor = (status: string): string => {
      if (status === 'running') return '#f8fafc';
      if (status === 'error') return '#fca5a5';
      if (status === 'building' || status === 'starting' || status === 'restarting') return '#dbe4ee';
      return '#6b7280';
    };
    const serviceRows = services.length > 0
      ? services.map((svc) => {
          const safeProfileId = this.escapeHtml(svc.profileId);
          const base = `${safeProfileId} · ${stageLabel(svc.status)}`;
          const label = waitingProfileId === svc.profileId ? `${base}（正在等待此服务就绪）` : base;
          return `<div class="svc" data-profile="${safeProfileId}"><span class="svc-dot" style="--svc-color:${colorFor(svc.status)}">●</span><span>${label}</span></div>`;
        }).join('')
      : `<div class="svc"><span class="svc-dot" style="--svc-color:#6b7280">●</span><span>服务尚未创建</span></div>`;

    // 极速版「等待 CI 镜像」：status 仍是 idle，但这是会自动完成的加载态（CI 构建完成后
    // CDS 自动拉取部署），必须开自动刷新、用「准备中」文案，绝不能显示「未运行 / 手动重部署」。
    const ciWaiting = branch.ciImageStatus === 'waiting';
    const branchLabel = ciWaiting ? '准备中' : stageLabel(branchStatus);
    // 构建模式（极速版 = CI 预构建镜像直接部署 / 源码 = 拉代码热加载编译）+ 分支/PR 直达链接，
    // 让等待页一眼知道「这是哪种构建、对应哪个分支与 PR」，不必猜。
    const { mode: buildMode } = this.resolveWaitTimingMode(branch, waitingProfileId);
    const safeModeLabel = this.escapeHtml(buildMode === 'release' ? '极速版' : '源码');
    const dashBase = this.dashboardBaseUrl();
    const branchPanelUrl = dashBase ? `${dashBase}/branch-panel/${encodeURIComponent(branch.id)}` : '';
    const prNum = branch.githubPrNumber;
    const prUrl = branch.githubRepoFullName && prNum
      ? `https://github.com/${branch.githubRepoFullName}/pull/${prNum}`
      : '';
    const safeBranchPanelUrl = this.escapeHtml(branchPanelUrl);
    const safePrUrl = this.escapeHtml(prUrl);
    const safePrLabel = this.escapeHtml(prNum ? `PR #${prNum}` : 'PR');
    const shouldAutoRefresh = ciWaiting || branchStatus === 'building' || branchStatus === 'starting' || branchStatus === 'restarting';
    const heading = ciWaiting
        ? '预览环境准备中'
      : branchStatus === 'stopped' || branchStatus === 'idle'
        ? '分支当前未运行'
      : branch.status === 'restarting'
        ? '分支环境正在热重启'
        : branch.status === 'building'
          ? '分支环境正在构建'
          : '分支正在刷新中';
    const subheading = ciWaiting
        ? '极速版正在拉取分支镜像，CI 构建完成后会自动部署，无需手动操作，请稍候。'
      : branchStatus === 'stopped' || branchStatus === 'idle'
        ? '预览访问不会自动重新部署。请回到 CDS 控制台确认日志后手动重新部署。'
      : waitingProfileId
        ? `CDS 正在等待服务 ${safeWaitingProfile} 完成启动，稳定后会自动切换到真实页面。`
        : 'CDS 正在同步当前分支的运行状态，服务稳定后会自动打开。';

    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading} · ${safeBranch}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
	:root{color-scheme:dark;--muted:rgba(245,242,255,.62);--text:#f7f5ff;--error:#fca5a5;--accent:#ffffff;--accent-two:#9f5050;--sync:#22c55e}
	html,body{min-height:100%}
	body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#120f17;color:var(--text);min-height:100vh;overflow:hidden}
	.magic-rings-bg{position:fixed;inset:0;width:100%;height:100%;display:block;z-index:0;background:#120f17}
	body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(780px 560px at 50% 50%,rgba(255,255,255,.08),transparent 54%),linear-gradient(90deg,rgba(18,15,23,.9),rgba(18,15,23,.34) 48%,rgba(18,15,23,.86));z-index:1}
	.shell{position:relative;z-index:2;min-height:100vh;width:100%;padding:clamp(32px,7vw,92px);display:grid;align-items:center;grid-template-columns:minmax(280px,780px) minmax(0,1fr)}
	.content{max-width:780px;text-shadow:0 2px 30px rgba(0,0,0,.72)}
	.eyebrow{display:inline-flex;align-items:center;gap:10px;margin-bottom:28px;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:#ded8ef;font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace}
	.eyebrow::before{content:"";width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 16px rgba(255,255,255,.72);animation:pulse 1.8s ease-in-out infinite}
h1{font-size:clamp(42px,5.6vw,82px);line-height:.96;letter-spacing:0;margin-bottom:22px;max-width:100%}
.shiny-text{display:inline-block;color:rgba(247,245,255,.78);background:linear-gradient(120deg,rgba(247,245,255,.76) 0%,rgba(247,245,255,.76) 38%,#fff 48%,rgba(255,255,255,.96) 52%,rgba(247,245,255,.76) 62%,rgba(247,245,255,.76) 100%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:shiny-text 3.2s linear infinite;text-shadow:none}
.subtitle{max-width:580px;font-size:clamp(15px,1.45vw,20px);line-height:1.75;color:var(--muted);margin-bottom:28px}
.meta{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:28px}
.chip{position:relative;overflow:hidden;display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.035);backdrop-filter:blur(10px);font-size:12px;color:#dde3ea}
.chip::after{content:"";position:absolute;inset:-60% auto -60% -40%;width:42%;background:linear-gradient(90deg,transparent,rgba(245,242,255,.18),transparent);transform:skewX(-18deg);animation:glint 3.6s ease-in-out infinite}
.branch{font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace;word-break:break-all}
.chip.mode{color:#cbd5e1}
a.chip.link{cursor:pointer;text-decoration:none;color:#dde3ea;transition:border-color .2s ease,background .2s ease}
a.chip.link:hover{border-color:rgba(255,255,255,.32);background:rgba(255,255,255,.07)}
.services{display:flex;flex-direction:column;gap:12px;margin:0 0 28px;max-width:620px}
	.svc{position:relative;overflow:hidden;display:flex;align-items:center;gap:12px;padding:13px 0;border-top:1px solid rgba(245,242,255,.13);font-size:15px;line-height:1.5}
.svc::after{content:"";position:absolute;left:-35%;top:0;bottom:0;width:34%;background:linear-gradient(90deg,transparent,rgba(245,242,255,.14),transparent);transform:skewX(-18deg);animation:svc-glint 3.2s ease-in-out infinite}
.svc:nth-child(2)::after{animation-delay:.42s}
.svc:nth-child(3)::after{animation-delay:.84s}
.svc-dot{width:8px;height:8px;flex:0 0 8px;border-radius:50%;color:transparent;background:var(--svc-color);box-shadow:0 0 14px var(--svc-color);animation:svc-pulse 1.55s ease-in-out infinite}
.svc:nth-child(2) .svc-dot{animation-delay:.22s}
.svc:nth-child(3) .svc-dot{animation-delay:.44s}
.estimate{width:min(620px,100%);margin:-8px 0 28px;padding:15px 16px;border:1px solid rgba(245,242,255,.12);border-radius:18px;background:rgba(255,255,255,.035);backdrop-filter:blur(12px)}
.estimate-top{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:10px;font-size:12px;color:rgba(245,242,255,.7)}
.estimate-top strong{font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace;font-size:15px;color:#f8fafc}
.estimate-track{height:5px;border-radius:999px;background:rgba(255,255,255,.1);overflow:hidden}
.estimate-bar{display:block;height:100%;width:0;border-radius:inherit;background:linear-gradient(90deg,#ffffff,#aeb4bd);box-shadow:0 0 18px rgba(255,255,255,.22);transition:width .45s ease}
.estimate-time{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-top:12px}
.estimate-time-main{font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace;font-size:15px;font-weight:700;color:#f8fafc;letter-spacing:.01em}
.estimate-time-sub{font-size:11px;color:rgba(245,242,255,.52)}
.estimate-meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;font-size:11px;color:rgba(245,242,255,.52)}
.estimate-meta span{display:inline-flex;align-items:center}
.cds-tip{width:min(620px,100%);margin:-8px 0 28px;color:rgba(245,242,255,.54);font-size:12px;line-height:1.65}
.cds-tip strong{color:rgba(245,242,255,.82);font-weight:700}
.err{margin:0 0 22px;padding:0 0 14px;border-bottom:1px solid rgba(252,165,165,.28);color:var(--error);font-size:13px;line-height:1.7;font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace;max-height:160px;overflow:auto}
.hint{display:flex;align-items:center;gap:18px;font-size:12px;color:var(--muted)}
.hint strong{color:#f5f7fa;font-weight:600}
.note{display:inline-flex;align-items:center;gap:8px;letter-spacing:.12em;text-transform:uppercase;font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace;font-size:11px;color:rgba(255,255,255,.48)}
.note::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--sync);box-shadow:0 0 16px rgba(34,197,94,.72);animation:svc-pulse 1.55s ease-in-out infinite}
.magic-rings-bg.is-static{background:radial-gradient(circle at 50% 50%,rgba(255,255,255,.22),transparent 12%,rgba(174,180,189,.16) 24%,transparent 42%),#120f17;animation:fallback-pulse 3.45s ease-in-out infinite}
@keyframes pulse{0%,100%{transform:scale(.96);opacity:.74}50%{transform:scale(1.04);opacity:1}}
@keyframes svc-pulse{0%,100%{transform:scale(.78);opacity:.58;filter:saturate(.9)}50%{transform:scale(1.28);opacity:1;filter:saturate(1.4)}}
@keyframes svc-glint{0%,32%{transform:translateX(0) skewX(-18deg);opacity:0}48%{opacity:1}72%,100%{transform:translateX(420%) skewX(-18deg);opacity:0}}
@keyframes glint{0%,38%{transform:translateX(0) skewX(-18deg);opacity:0}54%{opacity:1}78%,100%{transform:translateX(420%) skewX(-18deg);opacity:0}}
@keyframes fallback-pulse{0%,100%{filter:saturate(.9) brightness(.8)}50%{filter:saturate(1.2) brightness(1.1)}}
@keyframes shiny-text{0%{background-position:120% 0}100%{background-position:-120% 0}}
@media (max-width:760px){.shell{padding:28px;display:flex;align-items:flex-end}.content{width:100%}h1{font-size:44px}.subtitle{font-size:14px}.hint{align-items:flex-start;flex-direction:column}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important}}
</style>
</head><body>
<canvas class="magic-rings-bg" id="magic-rings" aria-hidden="true"></canvas>
<main class="shell">
  <section class="content">
    <div class="eyebrow">CDS Waiting Room</div>
    <h1><span class="${shouldAutoRefresh ? 'shiny-text' : ''}" data-role="heading">${heading}</span></h1>
    <p class="subtitle" data-role="subheading">${subheading}</p>
    <div class="meta">
      <span class="chip branch" data-role="branch-name">${safeBranch}</span>
      <span class="chip" data-role="branch-status">分支状态 · ${branchLabel}</span>
      <span class="chip mode" data-role="build-mode">构建模式 · ${safeModeLabel}</span>
      <a class="chip link" data-role="branch-link" href="${safeBranchPanelUrl}" target="_blank" rel="noopener"${branchPanelUrl ? '' : ' hidden'}>查看分支</a>
      <a class="chip link" data-role="pr-link" href="${safePrUrl}" target="_blank" rel="noopener"${prUrl ? '' : ' hidden'}>${safePrLabel}</a>
    </div>
    <div class="services" data-role="services">${serviceRows}</div>
    <div class="estimate" data-role="progress-estimate">
      <div class="estimate-top">
        <span data-role="progress-label">${safeProgressLabel}</span>
        <strong data-role="progress-percent">${progress.percent.toFixed(2)}%</strong>
      </div>
      <div class="estimate-track"><span class="estimate-bar" data-role="progress-bar" style="width:${progress.percent}%"></span></div>
      <div class="estimate-time" data-role="wait-timing" hidden>
        <span class="estimate-time-main" data-role="wait-timing-main"></span>
        <span class="estimate-time-sub" data-role="wait-timing-sub"></span>
      </div>
      <div class="estimate-meta">
        <span data-role="progress-confidence">置信度 ${safeProgressConfidence}</span>
        <span data-role="progress-reason">${safeProgressReason}</span>
      </div>
    </div>
    <p class="cds-tip"><strong>CDS 小提示：</strong><span data-role="cds-tip-text">构建完成后还会等待服务健康检查稳定，再切入真实页面。</span></p>
    <div class="hint">
      <span><strong>后台同步</strong> 每 2 秒检查一次服务状态，就绪后再进入真实页面。</span>
      <span class="note">CDS Live Sync</span>
    </div>
  </section>
</main>
<script id="magic-rings-vertex" type="x-shader/x-vertex">
attribute vec2 aPosition;
void main(){gl_Position=vec4(aPosition,0.0,1.0);}
</script>
<script id="magic-rings-fragment" type="x-shader/x-fragment">
precision highp float;
uniform float uTime,uAttenuation,uLineThickness;
uniform float uBaseRadius,uRadiusStep,uScaleRate;
uniform float uOpacity,uNoiseAmount,uRotation,uRingGap;
uniform float uFadeIn,uFadeOut;
uniform float uMouseInfluence,uHoverAmount,uHoverScale,uParallax,uBurst;
uniform vec2 uResolution,uMouse;
uniform vec3 uColor,uColorTwo;
uniform int uRingCount;
const float HP=1.5707963;
const float CYCLE=3.45;
float fade(float t){return t<uFadeIn?smoothstep(0.0,uFadeIn,t):1.0-smoothstep(uFadeOut,CYCLE-0.2,t);}
float ring(vec2 p,float ri,float cut,float t0,float px){
  float t=mod(uTime+t0,CYCLE);
  float r=ri+t/CYCLE*uScaleRate;
  float d=abs(length(p)-r);
  float a=atan(abs(p.y),abs(p.x))/HP;
  float th=max(1.0-a,0.5)*px*uLineThickness;
  float h=(1.0-smoothstep(th,th*1.5,d))+1.0;
  d+=pow(cut*a,3.0)*r;
  return h*exp(-uAttenuation*d)*fade(t);
}
void main(){
  float px=1.0/min(uResolution.x,uResolution.y);
  vec2 p=(gl_FragCoord.xy-0.5*uResolution.xy)*px;
  float cr=cos(uRotation),sr=sin(uRotation);
  p=mat2(cr,-sr,sr,cr)*p;
  p-=uMouse*uMouseInfluence;
  float sc=mix(1.0,uHoverScale,uHoverAmount)+uBurst*0.3;
  p/=sc;
  vec3 c=vec3(0.0);
  float rcf=max(float(uRingCount)-1.0,1.0);
  for(int i=0;i<10;i++){
    if(i>=uRingCount)break;
    float fi=float(i);
    vec2 pr=p-fi*uParallax*uMouse;
    vec3 rc=mix(uColor,uColorTwo,fi/rcf);
    c=mix(c,rc,vec3(ring(pr,uBaseRadius+fi*uRadiusStep,pow(uRingGap,fi),i==0?0.0:2.95*fi,px)));
  }
  c*=1.0+uBurst*2.0;
  float n=fract(sin(dot(gl_FragCoord.xy+uTime*100.0,vec2(12.9898,78.233)))*43758.5453);
  c+=(n-0.5)*uNoiseAmount;
  gl_FragColor=vec4(c,max(c.r,max(c.g,c.b))*uOpacity);
}
</script>
	<script>
(function(){
  var canvas=document.getElementById('magic-rings');
  if(!canvas) return;
  var reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var gl=canvas.getContext('webgl',{alpha:true,antialias:false});
  if(!gl){
    canvas.className='magic-rings-bg is-static';
    return;
  }
  function source(id){var node=document.getElementById(id);return node?node.textContent:'';}
  function shader(type,src){var s=gl.createShader(type);gl.shaderSource(s,src);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){throw new Error(gl.getShaderInfoLog(s)||'shader compile failed');}return s;}
  function hex(hexColor){var raw=String(hexColor).replace('#','');var n=parseInt(raw.length===3?raw.replace(/(.)/g,'$1$1'):raw,16);return [(n>>16&255)/255,(n>>8&255)/255,(n&255)/255];}
  var program;
  try{
    program=gl.createProgram();
    gl.attachShader(program,shader(gl.VERTEX_SHADER,source('magic-rings-vertex')));
    gl.attachShader(program,shader(gl.FRAGMENT_SHADER,source('magic-rings-fragment')));
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program)||'program link failed');
  }catch(err){
    canvas.className='magic-rings-bg is-static';
    return;
  }
  var buffer=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
  gl.useProgram(program);
  var position=gl.getAttribLocation(program,'aPosition');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  var loc={};
  ['uTime','uAttenuation','uLineThickness','uBaseRadius','uRadiusStep','uScaleRate','uOpacity','uNoiseAmount','uRotation','uRingGap','uFadeIn','uFadeOut','uMouseInfluence','uHoverAmount','uHoverScale','uParallax','uBurst','uResolution','uMouse','uColor','uColorTwo','uRingCount'].forEach(function(name){loc[name]=gl.getUniformLocation(program,name);});
  var color=hex('#f8fafc');
  var colorTwo=hex('#aeb4bd');
  gl.uniform1f(loc.uAttenuation,10);
  gl.uniform1f(loc.uLineThickness,2);
  gl.uniform1f(loc.uBaseRadius,.35);
  gl.uniform1f(loc.uRadiusStep,.1);
  gl.uniform1f(loc.uScaleRate,.1);
  gl.uniform1f(loc.uOpacity,1);
  gl.uniform1f(loc.uNoiseAmount,.1);
  gl.uniform1f(loc.uRotation,0);
  gl.uniform1f(loc.uRingGap,1.5);
  gl.uniform1f(loc.uFadeIn,.7);
  gl.uniform1f(loc.uFadeOut,.5);
  gl.uniform1f(loc.uMouseInfluence,0);
  gl.uniform1f(loc.uHoverAmount,0);
  gl.uniform1f(loc.uHoverScale,1.2);
  gl.uniform1f(loc.uParallax,.05);
  gl.uniform1f(loc.uBurst,0);
  gl.uniform3f(loc.uColor,color[0],color[1],color[2]);
  gl.uniform3f(loc.uColorTwo,colorTwo[0],colorTwo[1],colorTwo[2]);
  gl.uniform1i(loc.uRingCount,6);
  function resize(){
    var d=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.floor(window.innerWidth*d));
    canvas.height=Math.max(1,Math.floor(window.innerHeight*d));
    canvas.style.width='100%';
    canvas.style.height='100%';
    gl.viewport(0,0,canvas.width,canvas.height);
    gl.uniform2f(loc.uResolution,canvas.width,canvas.height);
  }
  function draw(t){
    gl.clearColor(0,0,0,0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(loc.uTime,reduced?0:t*.001);
    gl.uniform2f(loc.uMouse,0,0);
    gl.drawArrays(gl.TRIANGLES,0,6);
    requestAnimationFrame(draw);
  }
  resize();
  window.addEventListener('resize',resize);
  requestAnimationFrame(draw);
}());
${shouldAutoRefresh ? `;(function(){
  var statusUrl='/_cds/waiting-status${waitingProfileId ? `?profile=${encodeURIComponent(waitingProfileId)}` : ''}';
  var labels={building:'构建中',starting:'启动中',restarting:'重启中',running:'已就绪',error:'失败',stopping:'停止中',stopped:'已停止',idle:'准备中'};
  var colors={running:'#f8fafc',error:'#fca5a5',building:'#dbe4ee',starting:'#dbe4ee',restarting:'#dbe4ee',stopping:'#6b7280',stopped:'#6b7280',idle:'#6b7280'};
  var waitingProfile=${JSON.stringify(waitingProfileId || '')};
  var tips=[
    'CDS 会把拉代码、构建镜像、启动服务和健康检查归并为一个等待状态。',
    '百分比是根据服务状态、构建日志关键词和运行时长估算，服务未 ready 前不会显示 100%。',
    '内部 upstream 或 forwarder 窗口期不会直接暴露给用户，只会继续显示分支环境正在构建。',
    '若进入失败页，CDS 会保留最近日志摘要，方便复制给大模型或重新部署。'
  ];
  var tipIndex=0;
  function renderTip(){
    var tip=document.querySelector('[data-role="cds-tip-text"]');
    if(tip)tip.textContent=tips[tipIndex++%tips.length];
  }
  function label(status){return labels[status]||'待命';}
  function serviceText(svc){
    var base=svc.profileId+' · '+label(svc.status);
    return waitingProfile&&waitingProfile===svc.profileId?base+'（正在等待此服务就绪）':base;
  }
  function renderServices(services){
    var root=document.querySelector('[data-role="services"]');
    if(!root||!Array.isArray(services)||services.length===0)return;
    root.innerHTML='';
    services.forEach(function(svc){
      var row=document.createElement('div');
      row.className='svc';
      row.setAttribute('data-profile',svc.profileId);
      var dot=document.createElement('span');
      dot.className='svc-dot';
      dot.style.setProperty('--svc-color',colors[svc.status]||'#6b7280');
      dot.textContent='●';
      var text=document.createElement('span');
      text.textContent=serviceText(svc);
      row.appendChild(dot);
      row.appendChild(text);
      root.appendChild(row);
    });
  }
  // 百分比状态：display 是当前显示值（两位小数、单调不回退），server 是服务端状态/日志估算，
  // 时间目标由 elapsed/median 推出。tickPct 每 200ms 把 display 平滑逼近 max(server,时间目标)，
  // 让数字始终在动；未 ready 前封顶 99.99%（守住"ready 前不显示 100%"）。
  var pct={display:0,server:0,ready:false};
  (function(){var el=document.querySelector('[data-role="progress-percent"]');var v=el?parseFloat(el.textContent):0;pct.display=pct.server=(isNaN(v)?0:v);})();
  // 进度百分比：时间连续驱动，小数位一直在跳。
  // 有历史耗时(median)时：以服务端日志/状态估算 server 作锚点(下限)，随 ETA 推进(frac=已用/中位)
  // 平滑爬向 99.99——所以即使 server 卡在某个整数，百分比的小数位仍随秒推进而连续变化，用户看得见在动。
  // 旧实现 target=max(server,timePct) 会被 server 整数封住、小数冻在 .00（用户实测反馈）。
  function tickPct(){
    var target;
    if(timingState&&timingState.medianMs){
      var elapsed=timingState.baseElapsedMs+(Date.now()-timingState.syncedAt);
      if(elapsed<0)elapsed=0;
      var frac=elapsed/timingState.medianMs; if(frac>1)frac=1; // 0..1，按 ETA 推进
      var base=Math.min(pct.server,99.99);                      // 服务端估算作下限锚点
      // 随时间从 base 连续爬向 99.99；若纯时间比例已超过 base(构建比平时久)则用时间比例继续推。
      target=Math.max(base+(99.99-base)*frac, frac*100);
    }else{
      target=pct.server;                                        // 无历史样本：只展示状态估算，不编造时间
    }
    if(!pct.ready)target=Math.min(99.99,target);
    if(target<pct.display)target=pct.display;                   // 单调不回退
    pct.display=target;
    var percentEl=document.querySelector('[data-role="progress-percent"]');
    var bar=document.querySelector('[data-role="progress-bar"]');
    var shown=pct.display.toFixed(2);
    if(percentEl)percentEl.textContent=shown+'%';
    if(bar)bar.style.width=shown+'%';
  }
  function renderProgress(progress){
    if(!progress)return;
    pct.server=Math.max(0,Math.min(100,Number(progress.percent)||0));
    var label=document.querySelector('[data-role="progress-label"]');
    var confidence=document.querySelector('[data-role="progress-confidence"]');
    var reason=document.querySelector('[data-role="progress-reason"]');
    var confidenceText=progress.confidence==='high'?'高':progress.confidence==='medium'?'中':'低';
    if(label)label.textContent=progress.label||'预计处理进度';
    if(confidence)confidence.textContent='置信度 '+confidenceText;
    if(reason)reason.textContent=progress.reason||'基于当前状态估算';
    // 百分比文本/进度条由 tickPct 平滑驱动（两位小数 + 按预估时间倒推），这里只更新锚点。
  }
  // 时间渲染：服务端轮询给 elapsedMs/medianMs，本地 1s ticker 让"已等待"平滑跳秒。
  var timingState=null; // { baseElapsedMs, medianMs, samples, overdue, syncedAt }
  function clock(ms){
    var sec=Math.max(0,Math.round((Number(ms)||0)/1000));
    var h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;
    function p(n){return n<10?'0'+n:''+n;}
    return h>0?h+':'+p(m)+':'+p(s):p(m)+':'+p(s);
  }
  function renderTiming(){
    var wrap=document.querySelector('[data-role="wait-timing"]');
    if(!wrap)return;
    if(!timingState){wrap.hidden=true;return;}
    var main=document.querySelector('[data-role="wait-timing-main"]');
    var sub=document.querySelector('[data-role="wait-timing-sub"]');
    var elapsedMs=timingState.baseElapsedMs+(Date.now()-timingState.syncedAt);
    if(elapsedMs<0)elapsedMs=0;
    var ee=clock(elapsedMs);
    var samples=Number(timingState.samples)||0;
    var median=timingState.medianMs;
    var mainText='',subText='';
    if(samples>0&&median!=null){
      if(timingState.overdue||elapsedMs>median){
        mainText='已等待 '+ee+' · 通常约 '+clock(median)+' 完成，本次稍久，仍在继续';
        subText='';
      }else{
        var remainingMs=Math.max(0,median-elapsedMs);
        mainText='已等待 '+ee+' · 预计还需约 '+clock(remainingMs);
        var modeLabel=timingState.mode==='release'?'发布版':timingState.mode==='source'?'热加载':'';
        subText='（基于本项目最近 '+samples+' 次'+modeLabel+'构建的中位耗时，非单分支）';
      }
    }else{
      mainText='已等待 '+ee+' · 正在积累历史耗时数据，暂无预计';
      subText='';
    }
    if(main)main.textContent=mainText;
    if(sub){sub.textContent=subText;sub.hidden=!subText;}
    wrap.hidden=false;
  }
  function applyTiming(timing){
    if(!timing||typeof timing!=='object'){timingState=null;renderTiming();return;}
    timingState={
      baseElapsedMs:Math.max(0,Number(timing.elapsedMs)||0),
      medianMs:(timing.estimateMedianMs==null?null:Number(timing.estimateMedianMs)),
      samples:Number(timing.estimateSamples)||0,
      mode:(timing.mode||''),
      overdue:!!timing.overdue,
      syncedAt:Date.now()
    };
    renderTiming();
  }
  function setLink(sel,url,text){
    var el=document.querySelector(sel);if(!el)return;
    if(url){el.setAttribute('href',url);if(text)el.textContent=text;el.hidden=false;}
    else{el.hidden=true;}
  }
  var notLoadingStreak=0; // 连续"非加载态"轮询计数，用于从容应对推送瞬间的 stopped 抖动
  function poll(){
    fetch(statusUrl,{cache:'no-store',headers:{Accept:'application/json'}})
      .then(function(res){return res.ok?res.json():null;})
      .then(function(data){
        if(!data)return;
        if(data.ready){pct.ready=true;location.reload();return;}
        // 从容应对"触发构建瞬间的分支已停止"抖动：刚推送/重部署时分支可能瞬时报
        // stopped/idle，但很快自愈复活。不要第一拍就把访客弹到吓人的失败页——连续
        // 多拍仍是非加载态，才认定真的终止并 reload 到诊断页。期间显示"正在恢复"安抚。
        // （仅分支级等待；profile 级等待保持原地更新，单个失败服务不应触发整页跳转。）
        if(data.loading===false && !waitingProfile){
          notLoadingStreak++;
          if(notLoadingStreak<3){
            var calmEl=document.querySelector('[data-role="branch-status"]');
            if(calmEl)calmEl.textContent='分支状态 · 正在恢复';
            return;
          }
          location.reload();return;
        }
        notLoadingStreak=0;
        var statusEl=document.querySelector('[data-role="branch-status"]');
        if(statusEl)statusEl.textContent='分支状态 · '+label(data.status);
        var branchEl=document.querySelector('[data-role="branch-name"]');
        if(branchEl&&data.displayBranch)branchEl.textContent=data.displayBranch;
        if(data.modeLabel){var modeEl=document.querySelector('[data-role="build-mode"]');if(modeEl)modeEl.textContent='构建模式 · '+data.modeLabel;}
        setLink('[data-role="branch-link"]',data.branchPanelUrl,'查看分支');
        setLink('[data-role="pr-link"]',data.prUrl,data.prLabel||'PR');
        renderProgress(data.progress);
        applyTiming(data.timing);
        renderServices(data.services);
      })
      .catch(function(){});
  }
  window.setInterval(poll,2000);
  window.setInterval(renderTip,4200);
  window.setInterval(renderTiming,1000);
  window.setInterval(tickPct,200);
  window.setTimeout(poll,400);
  renderTip();
  tickPct();
}())` : ''}
</script>
</body></html>`;

    res.writeHead(503, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Retry-After': '2',
    });
    res.end(html);
  }

  /**
   * Minimal "branch gone" fallback page for the rare case where no auto-build
   * hook is wired (executor-only mode, mis-configured proxy). The richer page
   * with live-branch suggestions lives in index.ts `serveBranchGonePage` — it
   * needs state + config access that the pure proxy layer deliberately avoids.
   */
  private serveBranchGoneFallback(res: http.ServerResponse, slug: string): void {
    const safe = this.escapeHtml(slug);
    const html = `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>启动失败 — ${safe}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
	:root{color-scheme:dark;--muted:rgba(245,242,255,.62);--text:#f7f5ff;--danger:#fca5a5;--sync:#22c55e}
	html,body{min-height:100%}
	body{font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#120f17;color:var(--text);min-height:100vh;overflow:hidden}
	.shape-grid-bg{position:fixed;inset:0;width:100%;height:100%;display:block;z-index:0;background:#120f17}
	body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(900px 620px at 52% 46%,rgba(255,255,255,.08),transparent 36%,rgba(18,15,23,.82) 100%),linear-gradient(90deg,rgba(18,15,23,.88),rgba(18,15,23,.2) 48%,rgba(18,15,23,.82));z-index:1}
	.shell{position:relative;z-index:2;min-height:100vh;width:100%;padding:clamp(32px,7vw,92px);display:grid;align-items:center;grid-template-columns:minmax(280px,780px) minmax(0,1fr)}
	.content{max-width:780px;text-shadow:0 2px 30px rgba(0,0,0,.72)}
	.eyebrow{display:inline-flex;align-items:center;gap:10px;margin-bottom:28px;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:#ded8ef;font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace}
	.eyebrow::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--danger);box-shadow:0 0 16px var(--danger);animation:pulse 1.8s ease-in-out infinite}
	h1{font-size:clamp(42px,5.6vw,82px);line-height:.96;letter-spacing:0;margin-bottom:22px;max-width:100%}
	.shiny-text{display:inline-block;background:linear-gradient(120deg,rgba(247,245,255,.76) 0%,rgba(247,245,255,.76) 38%,#fff 48%,rgba(255,255,255,.96) 52%,rgba(247,245,255,.76) 62%,rgba(247,245,255,.76) 100%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:shiny-text 3.2s linear infinite;text-shadow:none}
	.desc{max-width:600px;color:var(--muted);font-size:clamp(15px,1.35vw,20px);line-height:1.75;margin-bottom:28px}
	.chip{position:relative;overflow:hidden;display:inline-flex;max-width:min(720px,88vw);align-items:center;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(255,255,255,.035);backdrop-filter:blur(12px);padding:10px 15px;color:#dde3ea;font:600 13px/1.5 "JetBrains Mono","SFMono-Regular",monospace;word-break:break-all}
	.chip::after{content:"";position:absolute;inset:-60% auto -60% -40%;width:42%;background:linear-gradient(90deg,transparent,rgba(245,242,255,.18),transparent);transform:skewX(-18deg);animation:glint 3.6s ease-in-out infinite}
	.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}
	.btn{border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(255,255,255,.035);color:var(--text);padding:10px 16px;text-decoration:none;font-size:13px;font-weight:700}
	.hint{display:flex;align-items:center;gap:18px;margin-top:28px;font-size:12px;color:var(--muted)}
	.hint strong{color:#f5f7fa;font-weight:600}
	.note{display:inline-flex;align-items:center;gap:8px;letter-spacing:.12em;text-transform:uppercase;font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace;font-size:11px;color:rgba(255,255,255,.48)}
	.note::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--sync);box-shadow:0 0 16px rgba(34,197,94,.72);animation:pulse 1.55s ease-in-out infinite}
	.shape-grid-bg.is-static{background:repeating-linear-gradient(30deg,rgba(255,255,255,.075) 0 1px,transparent 1px 34px),#120f17;animation:fallback-pulse 3.45s ease-in-out infinite}
	@keyframes pulse{0%,100%{transform:scale(.86);opacity:.64}50%{transform:scale(1.18);opacity:1}}
	@keyframes glint{0%,38%{transform:translateX(0) skewX(-18deg);opacity:0}54%{opacity:1}78%,100%{transform:translateX(420%) skewX(-18deg);opacity:0}}
	@keyframes fallback-pulse{0%,100%{filter:saturate(.9) brightness(.8)}50%{filter:saturate(1.2) brightness(1.1)}}
	@keyframes shiny-text{0%{background-position:120% 0}100%{background-position:-120% 0}}
	@media (max-width:760px){.shell{padding:28px;display:flex;align-items:flex-end}.content{width:100%}h1{font-size:44px}.hint{align-items:flex-start;flex-direction:column}}
	@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important}}
</style></head><body>
<canvas class="shape-grid-bg" id="shape-grid" aria-hidden="true"></canvas>
<main class="shell">
  <section class="content">
    <div class="eyebrow">CDS Preview Failed</div>
    <h1><span class="shiny-text">启动失败</span></h1>
    <p class="desc">该分支在此 CDS 实例上未注册，无法自动恢复。请确认分支名称，或回到 CDS 控制台重新部署。</p>
    <div class="chip">${safe}</div>
    <div class="actions">
      <a class="btn" href="${this.dashboardBaseUrl()}/project-list">返回 CDS 控制台</a>
      <a class="btn" href="${this.dashboardBaseUrl()}/cds-settings#loading-pages">查看加载页预览</a>
    </div>
    <div class="hint">
      <span><strong>CDS 已停止自动恢复</strong> 避免错误分支被动访问后反复部署。</span>
      <span class="note">CDS Diagnostic Mode</span>
    </div>
  </section>
</main>
<script>
(function(){
  var canvas=document.getElementById('shape-grid');
  if(!canvas)return;
  var ctx=canvas.getContext('2d');
  if(!ctx){canvas.className='shape-grid-bg is-static';return;}
  var speed=0.39,size=34,offset={x:0,y:0},hexHoriz=size*1.5,hexVert=size*Math.sqrt(3);
  function resize(){var d=Math.min(window.devicePixelRatio||1,2);canvas.width=Math.max(1,Math.floor(window.innerWidth*d));canvas.height=Math.max(1,Math.floor(window.innerHeight*d));canvas.style.width='100%';canvas.style.height='100%';ctx.setTransform(d,0,0,d,0,0)}
  function drawHex(cx,cy,r){ctx.beginPath();for(var i=0;i<6;i+=1){var a=Math.PI/3*i,x=cx+r*Math.cos(a),y=cy+r*Math.sin(a);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.closePath()}
  function draw(){var w=canvas.offsetWidth,h=canvas.offsetHeight;ctx.clearRect(0,0,w,h);offset.x=(offset.x-speed+hexHoriz*2)%(hexHoriz*2);offset.y=(offset.y-speed+hexVert)%hexVert;var colShift=Math.floor(offset.x/hexHoriz),ox=((offset.x%hexHoriz)+hexHoriz)%hexHoriz,oy=((offset.y%hexVert)+hexVert)%hexVert,cols=Math.ceil(w/hexHoriz)+3,rows=Math.ceil(h/hexVert)+3;ctx.lineWidth=1;ctx.strokeStyle='rgba(255,255,255,0.09)';for(var col=-2;col<cols;col+=1){for(var row=-2;row<rows;row+=1){var cx=col*hexHoriz+ox,cy=row*hexVert+((col+colShift)%2!==0?hexVert/2:0)+oy;drawHex(cx,cy,size);ctx.stroke()}}requestAnimationFrame(draw)}
  resize();window.addEventListener('resize',resize);requestAnimationFrame(draw);
}());
</script>
</body></html>`;
    res.writeHead(404, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(html);
  }

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => {
      switch (c) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        default: return '&#39;';
      }
    });
  }

  /**
   * Absolute base URL of the CDS dashboard host (e.g. "https://cds.miduo.org").
   *
   * These diagnostic pages are served on the *preview* subdomain
   * (`<slug>.miduo.org`), so a relative href like `/project-list` would resolve
   * against the preview host and land nowhere. The dashboard lives on a
   * different host (dashboardDomain / mainDomain), so the "返回 CDS 控制台" /
   * "查看加载页预览" links must be absolute. Same source of truth as
   * index.ts `serveBranchGonePage` (dashboardDomain || mainDomain).
   * Returns '' when no domain is configured, falling back to relative links.
   */
  private dashboardBaseUrl(): string {
    const domain = this.config?.dashboardDomain || this.config?.mainDomain;
    return domain ? `https://${domain}` : '';
  }

  /**
   * Handle requests from the switch domain.
   *
   * This is purely a branch-switching operation:
   * - No path → 301 redirect to main domain (default branch)
   * - Has path → suffix-match to a branch, set cookie, 301 to main domain
   * - No match → friendly 404 page
   */
  private async handleSwitchRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const mainDomain = this.config?.mainDomain;
    // Detect protocol from reverse proxy headers, default to https
    const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || 'https';
    const mainUrl = mainDomain ? `${proto}://${mainDomain}` : null;
    const url = req.url || '/';
    const pathParts = url.replace(/\?.*$/, '').split('/').filter(Boolean);

    // No mainDomain configured → show error
    if (!mainUrl) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('MAIN_DOMAIN 未配置，无法跳转。请在 CDS 中设置 MAIN_DOMAIN 环境变量。');
      return;
    }

    // No path → redirect to main domain (default branch)
    if (pathParts.length === 0) {
      res.writeHead(301, { Location: mainUrl, 'Content-Type': 'text/plain' });
      res.end('Redirecting to main domain...');
      return;
    }

    // Use full path as branch identifier (e.g. "claude/fix-login-password-issue-CQBMO")
    const fullPath = pathParts.join('/');
    const lastSegment = pathParts[pathParts.length - 1];
    const state = this.stateService.getState();
    const branchSlugs = Object.keys(state.branches);

    // Try full path first, then last segment as fallback
    let matchedSlug = this.suffixMatchBranch(fullPath, branchSlugs);
    if (!matchedSlug && fullPath !== lastSegment) {
      matchedSlug = this.suffixMatchBranch(lastSegment, branchSlugs);
    }

    // Resolve original branch name from state (preserve "/" and casing)
    let originalBranch = matchedSlug ? state.branches[matchedSlug]?.branch : null;

    // If not found locally, try remote (full path first, then last segment, then slug matching).
    // P4 Part 18 (G1.2): proxy auto-resolution stays on the legacy
    // single config.repoRoot. Multi-project subdomain routing would
    // require the proxy to iterate every project's repo, which is a
    // separate design exercise. For now new projects must be deployed
    // explicitly via POST /branches rather than auto-discovered here.
    if (!matchedSlug && this.worktreeService) {
      const proxyRepoRoot = this.config?.repoRoot || '';
      const remoteBranch = await this.worktreeService.findBranchBySuffix(proxyRepoRoot, fullPath)
        || (fullPath !== lastSegment ? await this.worktreeService.findBranchBySuffix(proxyRepoRoot, lastSegment) : null)
        || await this.worktreeService.findBranchBySlug(proxyRepoRoot, fullPath)
        || (fullPath !== lastSegment ? await this.worktreeService.findBranchBySlug(proxyRepoRoot, lastSegment) : null);
      if (remoteBranch) {
        matchedSlug = StateService.slugify(remoteBranch);
        originalBranch = remoteBranch;  // keep original name like "claude/fix-login-password-issue-CQBMO"
      }
    }

    // No match → friendly 404
    if (!matchedSlug) {
      this.serveSwitchNotFound(res, fullPath);
      return;
    }

    // Cookie stores the ORIGINAL branch name (with "/" and casing preserved)
    // so the worker can find it in git when auto-building
    const cookieValue = originalBranch || matchedSlug;
    console.log(`[switch] "${fullPath}" → branch "${cookieValue}" (slug: ${matchedSlug}), redirecting to ${mainUrl}`);
    res.writeHead(301, {
      'Set-Cookie': `cds_branch=${encodeURIComponent(cookieValue)}; Path=/; SameSite=Lax; Domain=${mainDomain}`,
      Location: mainUrl,
      'Content-Type': 'text/plain',
    });
    res.end(`Switched to branch: ${cookieValue}`);
  }

  /**
   * Suffix match: find a branch whose slug ends with the given suffix.
   * Returns the first matching branch slug, or null.
   */
  suffixMatchBranch(suffix: string, branchSlugs: string[]): string | null {
    const normalizedSuffix = StateService.slugify(suffix);

    // Exact match first
    if (branchSlugs.includes(normalizedSuffix)) return normalizedSuffix;

    // Suffix match (slug ends with the suffix)
    for (const slug of branchSlugs) {
      if (slug.endsWith(`-${normalizedSuffix}`) || slug.endsWith(`/${normalizedSuffix}`)) {
        return slug;
      }
    }
    return null;
  }

  /**
   * Friendly 404 page when no branch matches the suffix.
   */
  private serveSwitchNotFound(res: http.ServerResponse, suffix: string): void {
    const switchDomain = this.config?.switchDomain || 'switch domain';
    const state = this.stateService.getState();
    const branches = Object.keys(state.branches);
    const listHtml = branches.length > 0
      ? '<div class="hint-title">已注册的分支：</div>' + branches.map(slug =>
        `<a href="/${slug}" class="item">${slug}</a>`
      ).join('')
      : '';

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>分支未找到 — ${suffix}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
  .card { max-width: 480px; width: 100%; padding: 32px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; text-align: center; }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h2 { font-size: 18px; margin-bottom: 8px; color: #f0f6fc; }
  .suffix { color: #f85149; font-family: monospace; font-size: 15px; word-break: break-all; margin-bottom: 12px; }
  .desc { font-size: 13px; color: #8b949e; margin-bottom: 20px; line-height: 1.5; }
  code { background: #21262d; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #c9d1d9; }
  .hint-title { font-size: 12px; color: #8b949e; margin-bottom: 8px; text-align: left; }
  .item { display: block; padding: 6px 10px; background: #0d1117; border: 1px solid #21262d; border-radius: 4px; text-decoration: none; color: #58a6ff; font-size: 12px; font-family: monospace; margin-bottom: 4px; text-align: left; transition: border-color 0.15s; }
  .item:hover { border-color: #58a6ff; }
</style>
</head><body>
<div class="card">
  <div class="icon">404</div>
  <h2>分支未找到</h2>
  <div class="suffix">${suffix}</div>
  <div class="desc">在本地和远程仓库中均未找到匹配此后缀的分支。<br>请确认分支名称是否正确。</div>
  <div class="desc">用法：<code>${switchDomain}/分支名后缀</code></div>
  ${listHtml}
</div>
</body></html>`;

    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * Detect which build profile should handle the request based on URL path.
   * For example: /api/* goes to backend profile, everything else to frontend.
   */
  private detectProfileFromRequest(req: http.IncomingMessage, branch: BranchEntry): string | undefined {
    const url = req.url || '/';
    const profileIds = Object.keys(branch.services);

    // Phase 1: Check explicit pathPrefixes on build profiles (config-driven routing).
    // Use the branch's EFFECTIVE profiles (project profiles + branch-local extraProfiles), not the
    // global getBuildProfiles() — otherwise a branch-local extra service's pathPrefixes (now persisted
    // by PUT /extra-services) is invisible to the proxy and its traffic falls through to convention/
    // default routing, leaving the extra service unreachable (Codex P2 "Route branch-local path
    // prefixes in the proxy"). Effective-profiles is also project-scoped, avoiding cross-project id mixups.
    const profiles = this.stateService.getEffectiveProfilesForBranch(branch);
    // Sort: longer prefixes first (most specific match wins)
    const profilesWithRoutes = profiles
      .filter(p => p.pathPrefixes && p.pathPrefixes.length > 0 && profileIds.includes(p.id))
      .sort((a, b) => {
        const maxA = Math.max(...(a.pathPrefixes || []).map(s => s.length));
        const maxB = Math.max(...(b.pathPrefixes || []).map(s => s.length));
        return maxB - maxA;
      });

    for (const profile of profilesWithRoutes) {
      if (profile.pathPrefixes!.some(prefix => url.startsWith(prefix))) {
        return profile.id;
      }
    }

    // Phase 2: Convention-based fallback (backward compatible)
    if (url.startsWith('/api/')) {
      const apiProfile = profileIds.find(id => id.includes('api') || id.includes('backend'));
      if (apiProfile) return apiProfile;
    }

    const webProfile = profileIds.find(id => id.includes('web') || id.includes('frontend') || id.includes('admin'));
    if (webProfile) return webProfile;

    // Fallback to first profile
    return profileIds[0];
  }

  /**
   * Proxy an HTTP request to an upstream URL.
   * Simple implementation using Node.js http module.
   */
  private proxyRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    upstream: string,
    branchCtx?: { branchId: string; branchName: string; trackAccess?: boolean; profileId?: string },
  ): void {
    const proxyStart = Date.now();
    const requestId = String(clientReq.headers['x-cds-request-id'] || '').trim() || createRequestId();
    clientReq.headers['x-cds-request-id'] = requestId;
    if (typeof clientRes.setHeader === 'function') {
      clientRes.setHeader('X-CDS-Request-Id', requestId);
    }
    const requestCapture = createBodyCapture(undefined, clientReq.headers['content-type']);
    if (typeof clientReq.on === 'function') {
      clientReq.on('data', (chunk: Buffer | string) => requestCapture.onChunk(chunk));
    }
    const requestKind = classifyHttpRequestKind({
      layer: 'master-proxy',
      method: clientReq.method || 'GET',
      path: clientReq.url || '/',
      headers: clientReq.headers,
    });
    const activeRequestId = this.httpLogStore?.beginActive?.({
      layer: 'master-proxy',
      requestKind,
      requestId,
      method: clientReq.method || 'GET',
      protocol: String(clientReq.headers['x-forwarded-proto'] || 'http').split(',')[0],
      host: String(clientReq.headers.host || ''),
      path: clientReq.url || '/',
      remoteAddr: (clientReq.headers['cf-connecting-ip'] as string)
        || (clientReq.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
        || clientReq.socket?.remoteAddress,
      branchId: branchCtx?.branchId ?? null,
      profileId: branchCtx?.profileId ?? null,
      upstream,
      request: {
        headers: redactHeaders(clientReq.headers),
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
      this.httpLogStore?.completeActive?.(activeRequestId);
    };
    const scheduleActiveCleanup = () => {
      if (activeCompleted || !activeRequestId || activeCleanupTimer) return;
      activeCleanupTimer = setTimeout(completeActiveRequest, 60_000);
      activeCleanupTimer.unref?.();
    };
    if (typeof clientRes.once === 'function') {
      clientRes.once('close', scheduleActiveCleanup);
    } else if (typeof clientRes.on === 'function') {
      clientRes.on('close', scheduleActiveCleanup);
    }
    const logHttp = (
      status: number,
      response: { bodyPreview?: string; bodyBytes?: number } = {},
      outcome?: 'ok' | 'client-error' | 'server-error' | 'upstream-error' | 'timeout',
      error?: { code?: string; message?: string },
    ) => {
      completeActiveRequest();
      this.httpLogStore?.record({
        layer: 'master-proxy',
        requestKind,
        requestId,
        method: clientReq.method || 'GET',
        protocol: String(clientReq.headers['x-forwarded-proto'] || 'http').split(',')[0],
        host: String(clientReq.headers.host || ''),
        path: clientReq.url || '/',
        status,
        durationMs: Date.now() - proxyStart,
        outcome: outcome || (status >= 500 ? 'server-error' : status >= 400 ? 'client-error' : 'ok'),
        remoteAddr: (clientReq.headers['cf-connecting-ip'] as string)
          || (clientReq.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
          || clientReq.socket?.remoteAddress,
        branchId: branchCtx?.branchId ?? null,
        profileId: branchCtx?.profileId ?? null,
        upstream,
        request: {
          headers: redactHeaders(clientReq.headers),
          ...requestCapture.snapshot(clientReq.headers['content-type']),
        },
        response: {
          headers: redactHeaders(clientRes.getHeaders() as Record<string, unknown>),
          ...response,
        },
        error,
      });
    };
    const url = new URL(upstream);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: clientReq.url,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
        'x-cds-request-id': requestId,
        host: `${url.hostname}:${url.port}`,
      },
    };

    // NOTE: Do NOT strip accept-encoding here. We handle decompression on the
    // response side only for HTML responses that need widget injection.
    // Non-HTML resources (JS/CSS/images) keep compression intact.

    // Track web access for activity monitor
    // accessLogged prevents double-emitting when the error handler fires first
    // and then clientRes.on('finish') also fires for the synthetic response.
    let accessLogged = false;
    if (branchCtx?.trackAccess && this.onAccess) {
      const onAccessCb = this.onAccess;
      const method = clientReq.method || 'GET';
      const reqPath = clientReq.url || '/';
      const branchId = branchCtx.branchId;
      const profileId = branchCtx.profileId;
      clientRes.on('finish', () => {
        if (!accessLogged) {
          accessLogged = true;
          onAccessCb(branchId, method, reqPath, clientRes.statusCode, Date.now() - proxyStart, profileId);
        }
      });
    }

    // 代理日志：请求完结时记一条，outcome 基于 status 分类
    // proxyLogRecorded 防止 upstream-error 分支手动记录后，finish 又记一条重复的
    //
    // 有些测试 double 不带 .on；用 typeof 兜住，避免生产代码被测试 mock 拖垮。
    let proxyLogRecorded = false;
    if (typeof clientRes.on === 'function') {
      clientRes.on('finish', () => {
        if (proxyLogRecorded) return;
        proxyLogRecorded = true;
        const status = clientRes.statusCode;
        let outcome: ProxyLogEvent['outcome'] = 'ok';
        if (status >= 500) outcome = 'upstream-error';
        else if (status >= 400) outcome = 'client-error';
        this.recordProxyEvent({
          method: clientReq.method || 'GET',
          host: clientReq.headers.host || '',
          url: clientReq.url || '/',
          branchSlug: branchCtx?.branchId ?? null,
          profileId: branchCtx?.profileId ?? null,
          upstream,
          status,
          durationMs: Date.now() - proxyStart,
          outcome,
        });
      });
    }

    const proxyReq = http.request(options, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      // When routing via cookie (same URL serves different branches), prevent
      // browser disk-cache from mixing assets across branch switches.
      if (clientReq.headers.cookie?.includes('cds_branch')) {
        headers['cache-control'] = 'no-store, must-revalidate';
        headers['vary'] = 'Cookie';
      }
      if (branchCtx && this.isStaticAssetRequest(clientReq.url || '/')) {
        headers['cache-control'] = 'no-cache, must-revalidate';
      }

      // ── Widget injection: only for HTML 200 responses with branch context ──
      const contentType = proxyRes.headers['content-type'] || '';
      const statusCode = proxyRes.statusCode || 200;
      const isHtml = contentType.includes('text/html') && branchCtx && statusCode >= 200 && statusCode < 300;

      if (isHtml) {
        // Buffer the HTML response, decompress if needed, inject widget before </body>
        const encoding = (proxyRes.headers['content-encoding'] || '').toLowerCase();
        let stream: NodeJS.ReadableStream = proxyRes;

        // Decompress if upstream sent compressed HTML
        if (encoding === 'gzip') {
          stream = proxyRes.pipe(zlib.createGunzip());
        } else if (encoding === 'br') {
          stream = proxyRes.pipe(zlib.createBrotliDecompress());
        } else if (encoding === 'deflate') {
          stream = proxyRes.pipe(zlib.createInflate());
        }

        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf-8');
          const responseForLog = {
            bodyPreview: body.slice(0, 8 * 1024),
            bodyBytes: Buffer.byteLength(body, 'utf8'),
          };
          // 版本信息（sha + 极速/源码）并入既有 CDS widget（左下角那个），不再单开角标——
          // 一处足矣（用户 2026-06-24 反馈「两个为何不合并」）。sha 取 githubCommitSha，
          // 模式取该 profile 容器实际钉的 deployedMode（回退到源码时如实显示「源码」）。
          const entry = this.stateService.getState().branches[branchCtx.branchId];
          const svcMode = branchCtx.profileId
            ? entry?.services?.[branchCtx.profileId]?.deployedMode
            : undefined;
          const anyMode = svcMode
            ?? Object.values(entry?.services ?? {}).find((s) => s?.deployedMode)?.deployedMode;
          // 部署类型只分两类给用户看：极速（CI 预构建镜像）/ 发布（源码编译产出的发布版）。
          const modeLabel = anyMode
            ? (/express|prebuilt/i.test(anyMode) ? '极速' : '发布')
            : '';
          // 徽章 sha 跟随实际部署模式（Codex/Bugbot）：
          //  - 极速（CI 预构建镜像）：用 ciTargetSha —— 镜像 tag 按它解析，docs-only push 只动
          //    githubCommitSha、不动 ciTargetSha，显 ciTargetSha 才是容器实际跑的镜像 commit。
          //  - 发布（源码编译，含极速版缺镜像自动回退）：容器是从 worktree 编译的，跑的就是
          //    githubCommitSha，**不能**显 ciTargetSha（那是个根本没在跑的镜像 commit）。
          const badgeSha = (modeLabel === '极速'
            ? (entry?.ciTargetSha || entry?.githubCommitSha)
            : (entry?.githubCommitSha || entry?.ciTargetSha)) || '';
          const widget = buildWidgetScript(
            branchCtx.branchId,
            branchCtx.branchName,
            badgeSha,
            modeLabel,
          );

          // Inject before </body> if present, otherwise append
          const idx = body.lastIndexOf('</body>');
          if (idx !== -1) {
            body = body.slice(0, idx) + widget + body.slice(idx);
          } else {
            body += widget;
          }

          // Remove encoding headers (we decoded), recalculate content-length
          delete headers['content-encoding'];
          delete headers['transfer-encoding'];
          headers['content-length'] = String(Buffer.byteLength(body, 'utf-8'));
          clientRes.writeHead(statusCode, headers);
          clientRes.end(body);
          logHttp(statusCode, responseForLog);
        });
        stream.on('error', () => {
          // Decompression failed — passthrough original response without injection
          if (!clientRes.headersSent) {
            clientRes.writeHead(statusCode, proxyRes.headers);
            clientRes.end();
          }
          logHttp(statusCode, {}, 'upstream-error', { message: 'html decompression failed' });
        });
      } else {
        // Non-HTML or non-2xx: passthrough as-is (compressed, chunked, etc.)
        clientRes.writeHead(statusCode, headers);
        const reqUrl = clientReq.url || '/';
        const shouldLogApiFailure = statusCode >= 400 && (reqUrl.startsWith('/api/') || reqUrl.startsWith('/_cds/api/'));
        let bodyBytes = 0;
        const previewChunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          bodyBytes += buf.length;
          const captured = previewChunks.reduce((n, part) => n + part.length, 0);
          if (captured < 8 * 1024) previewChunks.push(buf.subarray(0, 8 * 1024 - captured));
        });
        proxyRes.on('end', () => {
          const bodyPreview = isBinaryContentType(contentType)
            ? ''
            : Buffer.concat(previewChunks).toString('utf8').replace(/\0/g, '').trim();
          if (shouldLogApiFailure) {
            console.warn(
              `[proxy] api upstream ${statusCode}: ${clientReq.method || 'GET'} ${reqUrl} → ${upstream} (host=${clientReq.headers.host || ''}, branch=${branchCtx?.branchId || 'unknown'}, requestId=${String(proxyRes.headers['x-cds-request-id'] || clientReq.headers['x-cds-request-id'] || '-')}, bytes=${bodyBytes}, contentType=${String(contentType || '-')})${bodyPreview ? ` body="${bodyPreview.slice(0, 240)}"` : ' emptyBody=true'}`,
            );
          }
          logHttp(statusCode, { bodyPreview: bodyPreview || undefined, bodyBytes });
        });
        proxyRes.pipe(clientRes, { end: true });
      }
    });

    proxyReq.on('error', (err: NodeJS.ErrnoException) => {
      console.error(`[proxy] upstream error: ${err.message} → ${upstream}`);
      logHttp(502, {}, err.code === 'ETIMEDOUT' ? 'timeout' : 'upstream-error', {
        code: err.code,
        message: err.message,
      });
      // 转发日志：明确记录上游错误类型，方便用户看到"502 但服务器无日志"时的真实原因
      const codeHintMap: Record<string, string> = {
        ECONNREFUSED: '上游端口未监听 — 容器可能还没启动完，或服务崩溃了。查 container logs。',
        ECONNRESET: '上游主动断开 — 服务启动中退出、被 stop/kill、或真实 OOM。以容器事件里的 OOMKilled/kernel OOM 为准。',
        ETIMEDOUT: '上游不响应 — 可能卡在启动（例如 restore 还没跑完），或进程 hang 住。',
        EHOSTUNREACH: 'Docker 网络不通 — 容器 IP 失效或跨 network 没配好。',
        ENOTFOUND: 'DNS 无法解析 upstream host — 检查 routing rule 里的 host 是否拼错。',
      };
      if (!proxyLogRecorded) {
        proxyLogRecorded = true;
        this.recordProxyEvent({
          method: clientReq.method || 'GET',
          host: clientReq.headers.host || '',
          url: clientReq.url || '/',
          branchSlug: branchCtx?.branchId ?? null,
          profileId: branchCtx?.profileId ?? null,
          upstream,
          status: 502,
          durationMs: Date.now() - proxyStart,
          outcome: 'upstream-error',
          errorCode: err.code || 'UNKNOWN',
          errorMessage: err.message,
          hint: codeHintMap[err.code || ''] || '上游异常，查 container logs 看具体原因。',
        });
      }
      // Emit activity event immediately so the failure appears in Activity Monitor.
      // We do this here rather than relying on clientRes.on('finish') because the
      // synthetic response we send (loading page or 502) would show status 200/502
      // from the finish event — emitting 502 here better reflects what happened.
      if (branchCtx?.trackAccess && this.onAccess && !accessLogged) {
        accessLogged = true;
        this.onAccess(
          branchCtx.branchId,
          clientReq.method || 'GET',
          clientReq.url || '/',
          502,
          Date.now() - proxyStart,
          branchCtx.profileId,
        );
      }
      if (clientRes.headersSent) return;

      // Connection-level errors to the upstream container (not yet listening,
      // briefly unreachable during hot-restart, or port bound but dropping) —
      // serve the loading page instead of a 502 JSON so the user sees a
      // refreshing "服务正在启动中" card rather than a Cloudflare gateway
      // error. HTML requests only; API/XHR/fetch callers still get 502 JSON
      // so their clients can handle the failure mode explicitly.
      const isConnLevel = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND'].includes(err.code || '');
      const acceptsHtml = this.isHtmlNavigationRequest(clientReq);
      if (isConnLevel && acceptsHtml && branchCtx) {
        const state = this.stateService.getState();
        const branch = state.branches[branchCtx.branchId];
        if (branch) {
          this.serveBranchStatusResponse(clientReq, clientRes, branchCtx.branchId, branch, branchCtx.profileId);
          return;
        }
      }

      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: `Upstream error: ${err.message}`, code: err.code || 'UNKNOWN' }));
    });

    clientReq.pipe(proxyReq, { end: true });
  }

  /**
   * Parse a cookie value from a cookie header string.
   */
  private parseCookie(cookieStr: string, name: string): string | undefined {
    const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : undefined;
  }

  /**
   * Handle WebSocket upgrade for the worker proxy.
   */
  handleUpgrade(req: http.IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    // Try preview subdomain first, then normal branch resolution
    const host = req.headers.host || '';
    const previewSlug = this.extractPreviewBranch(host);
    const branchSlug = previewSlug || (() => {
      const ref = this.resolveBranch(req);
      return ref ? StateService.slugify(ref) : null;
    })();

    if (!branchSlug || !this.resolveUpstream) {
      socket.destroy();
      return;
    }

    // Same canonical-id fallback as routeToBranch: subdomain hits on
    // non-legacy projects must resolve to `${projectSlug}-${slug}` entries.
    const branch = this.resolveBranchEntry(branchSlug);
    if (!branch || branch.status !== 'running') {
      socket.destroy();
      return;
    }

    const profileId = this.detectProfileFromRequest(req, branch);
    const upstream = this.resolveUpstream(branch.id, profileId);
    if (!upstream) {
      socket.destroy();
      return;
    }

    // Proxy WebSocket upgrade
    const url = new URL(upstream);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: req.url,
      method: 'GET',
      headers: {
        ...req.headers,
        host: `${url.hostname}:${url.port}`,
      },
    };

    const proxyReq = http.request(options);
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      // Forward the actual 101 response from upstream (includes Sec-WebSocket-Accept, etc.)
      // Without these headers, the client's WebSocket handshake validation will fail.
      let rawResponse = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        rawResponse += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
      }
      rawResponse += '\r\n';
      socket.write(rawResponse);
      if (proxyHead.length > 0) socket.write(proxyHead);
      if (head.length > 0) proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxyReq.on('error', () => socket.destroy());
    socket.on('error', () => proxyReq.destroy());
    proxyReq.end();
  }
}
