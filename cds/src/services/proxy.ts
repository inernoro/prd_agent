import http from 'node:http';
import zlib from 'node:zlib';
import type { RoutingRule, BranchEntry, CdsConfig, BuildProfile } from '../types.js';
import { StateService } from './state.js';
import type { WorktreeService } from './worktree.js';
import type { SchedulerService } from './scheduler.js';
import { buildWidgetScript } from '../widget-script.js';
import { computePreviewSlug } from './preview-slug.js';

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

  constructor(
    private readonly stateService: StateService,
    private readonly config?: CdsConfig,
  ) {}

  /**
   * Attach the warm-pool scheduler. When set, every successful route to a
   * HOT branch calls scheduler.touch() to refresh LRU ordering.
   * See doc/design.cds-resilience.md §四.4.
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
    for (const entry of Object.values(state.branches)) {
      if (!entry.branch) continue;
      const project = entry.projectId ? projectById.get(entry.projectId) : undefined;
      const projectSlug = project?.slug || entry.projectId;
      if (!projectSlug) continue;
      if (computePreviewSlug(entry.branch, projectSlug) === slug) {
        return entry;
      }
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
    // See `.claude/rules/cds-auto-deploy.md` + doc/design.cds-resilience.md.
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
      // No upstream URL resolvable — branch record exists but host port is
      // unallocated / executor lost. Still prefer the waiting page over 502
      // so the user sees the branch context instead of a blank gateway error.
      this.serveBranchStatusResponse(req, res, branchSlug, branch, profileId);
      return;
    }

    console.log(`[proxy] ${req.method} ${req.url} → ${upstream} (branch=${branch.id}, profile=${profileId || 'default'})`);
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

  private serveWaitingStatus(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers.host || '';
    const previewSlug = this.extractPreviewBranch(host) || '';
    const branch = previewSlug ? this.resolveBranchEntry(previewSlug) : undefined;
    const url = new URL(req.url || '/_cds/waiting-status', 'http://cds.local');
    const waitingProfileId = url.searchParams.get('profile') || undefined;
    const services = branch ? Object.values(branch.services || {}) : [];
    const waitingService = waitingProfileId && branch ? branch.services?.[waitingProfileId] : undefined;
    const ready = Boolean(branch && branch.status === 'running' && (!waitingProfileId || waitingService?.status === 'running'));
    const loading = Boolean(branch && (branch.status === 'building' || branch.status === 'starting' || branch.status === 'restarting' || waitingService?.status === 'building' || waitingService?.status === 'starting' || waitingService?.status === 'restarting'));
    const displayBranch = this.displayBranchName(previewSlug, branch);

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
      services: services.map((svc) => ({
        profileId: svc.profileId,
        status: svc.status,
      })),
      errorMessage: branch?.errorMessage || null,
    }));
  }

  serveStartingPageV2(res: http.ServerResponse, branchSlug: string, branch: BranchEntry, waitingProfileId?: string): void {
    const services = Object.values(branch.services);
    const displayBranch = this.displayBranchName(branchSlug, branch);
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

    const branchLabel = stageLabel(branchStatus);
    const shouldAutoRefresh = branchStatus === 'building' || branchStatus === 'starting' || branchStatus === 'restarting';
    const errorNote = branch.status === 'error' && branch.errorMessage
      ? `<div class="err">${this.escapeHtml(branch.errorMessage).slice(0, 400)}</div>`
      : '';
    const heading = branch.status === 'error'
      ? '分支部署出现异常'
      : branchStatus === 'stopped' || branchStatus === 'idle'
        ? '分支当前未运行'
      : branch.status === 'restarting'
        ? '分支环境正在热重启'
        : branch.status === 'building'
          ? '分支环境正在构建'
          : '分支正在刷新中';
    const subheading = branch.status === 'error'
      ? 'CDS 已保留当前状态，请返回控制台查看日志与容器输出。'
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
	.shape-grid-bg{position:fixed;inset:0;width:100%;height:100%;display:block;z-index:0;background:#120f17}
	body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(900px 620px at 52% 46%,rgba(255,255,255,.08),transparent 36%,rgba(18,15,23,.82) 100%),linear-gradient(90deg,rgba(18,15,23,.88),rgba(18,15,23,.2) 48%,rgba(18,15,23,.82));z-index:1}
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
.estimate-bar{display:block;height:100%;width:0;border-radius:inherit;background:linear-gradient(90deg,#ffffff,#9f5050);box-shadow:0 0 18px rgba(255,255,255,.22);transition:width .45s ease}
.estimate-meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;font-size:11px;color:rgba(245,242,255,.52)}
.estimate-meta span{display:inline-flex;align-items:center}
.err{margin:0 0 22px;padding:0 0 14px;border-bottom:1px solid rgba(252,165,165,.28);color:var(--error);font-size:13px;line-height:1.7;font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace;max-height:160px;overflow:auto}
.hint{display:flex;align-items:center;gap:18px;font-size:12px;color:var(--muted)}
.hint strong{color:#f5f7fa;font-weight:600}
.note{display:inline-flex;align-items:center;gap:8px;letter-spacing:.12em;text-transform:uppercase;font-family:"JetBrains Mono","SFMono-Regular",Menlo,monospace;font-size:11px;color:rgba(255,255,255,.48)}
.note::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--sync);box-shadow:0 0 16px rgba(34,197,94,.72);animation:svc-pulse 1.55s ease-in-out infinite}
.shape-grid-bg.is-static{background:repeating-linear-gradient(30deg,rgba(255,255,255,.075) 0 1px,transparent 1px 34px),#120f17;animation:fallback-pulse 3.45s ease-in-out infinite}
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
<canvas class="shape-grid-bg" id="shape-grid" aria-hidden="true" data-speed="0.39" data-size="34" data-shape="hexagon"></canvas>
<main class="shell">
  <section class="content">
    <div class="eyebrow">CDS Waiting Room</div>
    <h1><span class="${shouldAutoRefresh ? 'shiny-text' : ''}" data-role="heading">${heading}</span></h1>
    <p class="subtitle" data-role="subheading">${subheading}</p>
    <div class="meta">
      <span class="chip branch" data-role="branch-name">${safeBranch}</span>
      <span class="chip" data-role="branch-status">分支状态 · ${branchLabel}</span>
    </div>
    ${errorNote}
    <div class="services" data-role="services">${serviceRows}</div>
    <div class="estimate" data-role="progress-estimate">
      <div class="estimate-top">
        <span data-role="progress-label">${safeProgressLabel}</span>
        <strong data-role="progress-percent">${progress.percent}%</strong>
      </div>
      <div class="estimate-track"><span class="estimate-bar" data-role="progress-bar" style="width:${progress.percent}%"></span></div>
      <div class="estimate-meta">
        <span data-role="progress-confidence">置信度 ${safeProgressConfidence}</span>
        <span data-role="progress-reason">${safeProgressReason}</span>
      </div>
    </div>
    <div class="hint">
      <span><strong>后台同步</strong> 每 2 秒检查一次服务状态，就绪后再进入真实页面。</span>
      <span class="note">CDS Live Sync</span>
    </div>
  </section>
</main>
	<script>
(function(){
  var canvas=document.getElementById('shape-grid');
  if(!canvas) return;
  var reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var ctx=canvas.getContext('2d');
  if(!ctx){
    canvas.className='shape-grid-bg is-static';
    return;
  }
  var speed=0.39;
  var size=34;
  var offset={x:0,y:0};
  var hexHoriz=size*1.5;
  var hexVert=size*Math.sqrt(3);
  function resize(){
    var d=Math.min(window.devicePixelRatio||1,2);
    canvas.width=Math.max(1,Math.floor(window.innerWidth*d));
    canvas.height=Math.max(1,Math.floor(window.innerHeight*d));
    canvas.style.width='100%';
    canvas.style.height='100%';
    ctx.setTransform(d,0,0,d,0,0);
  }
  function drawHex(cx,cy,r){
    ctx.beginPath();
    for(var i=0;i<6;i+=1){
      var angle=Math.PI/3*i;
      var x=cx+r*Math.cos(angle);
      var y=cy+r*Math.sin(angle);
      if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
    }
    ctx.closePath();
  }
  function draw(){
    var width=canvas.offsetWidth;
    var height=canvas.offsetHeight;
    ctx.clearRect(0,0,width,height);
    offset.x=(offset.x-(reduced?0:speed)+hexHoriz*2)%(hexHoriz*2);
    offset.y=(offset.y-(reduced?0:speed)+hexVert)%hexVert;
    var colShift=Math.floor(offset.x/hexHoriz);
    var offsetX=((offset.x%hexHoriz)+hexHoriz)%hexHoriz;
    var offsetY=((offset.y%hexVert)+hexVert)%hexVert;
    var cols=Math.ceil(width/hexHoriz)+3;
    var rows=Math.ceil(height/hexVert)+3;
    ctx.lineWidth=1;
    ctx.strokeStyle='rgba(255,255,255,0.09)';
    for(var col=-2;col<cols;col+=1){
      for(var row=-2;row<rows;row+=1){
        var cx=col*hexHoriz+offsetX;
        var cy=row*hexVert+((col+colShift)%2!==0?hexVert/2:0)+offsetY;
        drawHex(cx,cy,size);
        ctx.stroke();
      }
    }
    var gradient=ctx.createRadialGradient(width*0.54,height*0.46,0,width*0.54,height*0.46,Math.sqrt(width*width+height*height)/2);
    gradient.addColorStop(0,'rgba(255,255,255,0.02)');
    gradient.addColorStop(0.5,'rgba(18,15,23,0.14)');
    gradient.addColorStop(1,'rgba(18,15,23,0.72)');
    ctx.fillStyle=gradient;
    ctx.fillRect(0,0,width,height);
    requestAnimationFrame(draw);
  }
  resize();
  window.addEventListener('resize',resize);
  requestAnimationFrame(draw);
}());
${shouldAutoRefresh ? `;(function(){
  var statusUrl='/_cds/waiting-status${waitingProfileId ? `?profile=${encodeURIComponent(waitingProfileId)}` : ''}';
  var labels={building:'构建中',starting:'启动中',restarting:'重启中',running:'已就绪',error:'失败',stopping:'停止中',stopped:'已停止',idle:'待命'};
  var colors={running:'#f8fafc',error:'#fca5a5',building:'#dbe4ee',starting:'#dbe4ee',restarting:'#dbe4ee',stopping:'#6b7280',stopped:'#6b7280',idle:'#6b7280'};
  var waitingProfile=${JSON.stringify(waitingProfileId || '')};
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
  function renderProgress(progress){
    if(!progress)return;
    var percent=Math.max(0,Math.min(100,Number(progress.percent)||0));
    var label=document.querySelector('[data-role="progress-label"]');
    var percentEl=document.querySelector('[data-role="progress-percent"]');
    var bar=document.querySelector('[data-role="progress-bar"]');
    var confidence=document.querySelector('[data-role="progress-confidence"]');
    var reason=document.querySelector('[data-role="progress-reason"]');
    var confidenceText=progress.confidence==='high'?'高':progress.confidence==='medium'?'中':'低';
    if(label)label.textContent=progress.label||'预计处理进度';
    if(percentEl)percentEl.textContent=Math.round(percent)+'%';
    if(bar)bar.style.width=percent+'%';
    if(confidence)confidence.textContent='置信度 '+confidenceText;
    if(reason)reason.textContent=progress.reason||'基于当前状态估算';
  }
  function poll(){
    fetch(statusUrl,{cache:'no-store',headers:{Accept:'application/json'}})
      .then(function(res){return res.ok?res.json():null;})
      .then(function(data){
        if(!data)return;
        if(data.ready){location.reload();return;}
        var statusEl=document.querySelector('[data-role="branch-status"]');
        if(statusEl)statusEl.textContent='分支状态 · '+label(data.status);
        var branchEl=document.querySelector('[data-role="branch-name"]');
        if(branchEl&&data.displayBranch)branchEl.textContent=data.displayBranch;
        renderProgress(data.progress);
        renderServices(data.services);
      })
      .catch(function(){});
  }
  window.setInterval(poll,2000);
  window.setTimeout(poll,400);
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
<title>预览已下线 — ${safe}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{max-width:420px;width:100%;padding:32px;background:#161b22;border:1px solid #30363d;border-radius:12px;text-align:center}
.emoji{font-size:40px;margin-bottom:12px}
h2{font-size:18px;color:#f0f6fc;margin-bottom:8px}
.branch{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;color:#f85149;background:#2a0d11;border:1px solid #5a1d1d;padding:4px 10px;border-radius:4px;margin-bottom:16px;display:inline-block;word-break:break-all}
.desc{font-size:13px;color:#8b949e;line-height:1.6}
</style></head><body>
<div class="card">
  <div class="emoji">OFF</div>
  <h2>预览已下线</h2>
  <div class="branch">${safe}</div>
  <div class="desc">该分支在此 CDS 实例上未注册。<br>请确认分支名称或联系管理员。</div>
</div>
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

    // Phase 1: Check explicit pathPrefixes on build profiles (config-driven routing)
    const profiles = this.stateService.getBuildProfiles();
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
    const url = new URL(upstream);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port,
      path: clientReq.url,
      method: clientReq.method,
      headers: {
        ...clientReq.headers,
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
          const widget = buildWidgetScript(branchCtx.branchId, branchCtx.branchName);

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
        });
        stream.on('error', () => {
          // Decompression failed — passthrough original response without injection
          if (!clientRes.headersSent) {
            clientRes.writeHead(statusCode, proxyRes.headers);
            clientRes.end();
          }
        });
      } else {
        // Non-HTML or non-2xx: passthrough as-is (compressed, chunked, etc.)
        clientRes.writeHead(statusCode, headers);
        proxyRes.pipe(clientRes, { end: true });
      }
    });

    proxyReq.on('error', (err: NodeJS.ErrnoException) => {
      console.error(`[proxy] upstream error: ${err.message} → ${upstream}`);
      // 转发日志：明确记录上游错误类型，方便用户看到"502 但服务器无日志"时的真实原因
      const codeHintMap: Record<string, string> = {
        ECONNREFUSED: '上游端口未监听 — 容器可能还没启动完，或服务崩溃了。查 container logs。',
        ECONNRESET: '上游主动断开 — 服务启动到一半挂了，或进程 OOM 被杀。查容器 dmesg / crash dump。',
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
