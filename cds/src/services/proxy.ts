import http from 'node:http';
import zlib from 'node:zlib';
import type { RoutingRule, BranchEntry, CdsConfig, BuildProfile } from '../types.js';
import { StateService } from './state.js';
import type { WorktreeService } from './worktree.js';
import type { SchedulerService } from './scheduler.js';
import { buildWidgetScript } from '../widget-script.js';

/**
 * 代理转发事件 —— 每一次经过 worker port 的请求都会生成一条。
 * 用户通过顶部「🔍 转发日志」面板查看，专门用于排查：
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
  /** Ring buffer of recent proxy events for the global log panel (顶部 🔍). */
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
   * Look up a branch entry by the slug extracted from a preview subdomain.
   *
   * The bare slug (e.g. `claude-fix-foo`) lookup works for legacy projects
   * where branch entry id == slug. After PR #498's auto-build refactor,
   * non-legacy projects store entries under canonical id `${projectSlug}-${slug}`
   * (e.g. `prd-agent-claude-fix-foo`) — a bare slug lookup misses these and
   * the proxy used to fire auto-build on every reload, recreating containers
   * indefinitely. This helper falls back to a suffix match on the canonical
   * id so `<slug>.<root>` resolves to the project-scoped entry.
   *
   * Returns the entry or undefined; ambiguous matches (multiple projects own
   * the same branch name) prefer an exact id match before suffix matching.
   */
  private resolveBranchEntry(slug: string): BranchEntry | undefined {
    const state = this.stateService.getState();
    const direct = state.branches[slug];
    if (direct) return direct;
    // Canonical id fallback: try `${project.slug}-${slug}` for each known
    // project. Iterating projects (not arbitrary suffix matching) keeps the
    // lookup deterministic when two projects own a same-named branch:
    // `feature-x.miduo.org` resolves to the first project that has an entry
    // there, and never accidentally lands on `proj-other-feature-x`
    // (project `proj` + branch `other/feature-x`) which a naive
    // `endsWith('-feature-x')` would.
    const projects = this.stateService.getProjects?.() ?? [];
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

    // ── /_cds/api/* — passthrough to CDS Dashboard API (master port) ──
    // Allows widgets embedded in proxied apps to call CDS API without CORS issues.
    if (url.startsWith('/_cds/')) {
      // Rewrite path: /_cds/api/branches → /api/branches
      req.url = url.slice(5); // strip "/_cds" prefix
      // Add internal header to bypass auth on master — this request comes
      // from a widget embedded in a proxied app, not an external caller.
      req.headers['x-cds-internal'] = '1';
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
      const acceptsHtml = (req.headers.accept || '').toLowerCase().includes('text/html');
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

    // Branch doesn't exist or is in a non-loading, non-running state — trigger
    // auto-build (if configured) or fall back to loading page / 503.
    if (!branch || (branch.status !== 'running' && !LOADING_BRANCH_STATUSES.has(branch.status))) {
      if (this.onAutoBuild) {
        this.onAutoBuild(branchRef, req, res);
        return;
      }
      // No auto-build — still prefer the friendly loading page over a 503 JSON
      // so returning users see something recognizable while they figure out
      // how to restart the branch.
      if (branch) {
        this.serveStartingPage(res, branchSlug, branch);
        return;
      }
      // No branch, no auto-build (executor-only mode or mis-configured proxy):
      // serve a minimal 404 HTML for browsers, JSON for API clients. Avoids the
      // Chrome "HTTP ERROR 400/503" blank screen when users land on a
      // subdomain for a deleted branch.
      const acceptsHtml = (req.headers.accept || '').toLowerCase().includes('text/html');
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

    // Branch-level loading: container creating / building / restarting
    if (LOADING_BRANCH_STATUSES.has(branch.status)) {
      this.serveStartingPage(res, branchSlug, branch);
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
        this.serveStartingPage(res, branchSlug, branch, profileId);
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
      this.serveStartingPage(res, branchSlug, branch, profileId);
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

  /**
   * Serve a loading page when a branch or service is not yet ready.
   * Covers starting / building / restarting / unknown states — any time the
   * upstream container isn't guaranteed to answer cleanly. Auto-refreshes
   * every 2 seconds so the user lands on the real app the moment it is ready.
   *
   * Returns HTTP 503 with Retry-After so Cloudflare + crawlers know this is a
   * transient state (not a cache-forever 200), while browsers still render
   * the HTML body. See .claude/rules/cds-auto-deploy.md.
   */
  private serveStartingPage(res: http.ServerResponse, branchSlug: string, branch: BranchEntry, waitingProfileId?: string): void {
    const services = Object.values(branch.services);
    const stageLabel = (s: string): string => {
      switch (s) {
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
    const iconFor = (s: string): string => {
      if (s === 'running') return '✓';
      if (s === 'error') return '✗';
      if (s === 'building' || s === 'starting' || s === 'restarting') return '◌';
      return '·';
    };
    const colorFor = (s: string): string => {
      if (s === 'running') return '#3fb950';
      if (s === 'error') return '#f85149';
      if (s === 'building' || s === 'starting' || s === 'restarting') return '#58a6ff';
      return '#8b949e';
    };
    const serviceRows = services.length > 0
      ? services.map(svc => {
          const base = `${svc.profileId} · ${stageLabel(svc.status)}`;
          const label = waitingProfileId === svc.profileId ? `${base}（等待此服务就绪）` : base;
          return `<div class="svc"><span style="color:${colorFor(svc.status)}">${iconFor(svc.status)}</span> ${label}</div>`;
        }).join('')
      : `<div class="svc"><span style="color:#8b949e">·</span> 服务尚未创建</div>`;

    const branchLabel = stageLabel(branch.status);
    const errorNote = branch.status === 'error' && branch.errorMessage
      ? `<div class="err">${this.escapeHtml(branch.errorMessage).slice(0, 400)}</div>`
      : '';
    const heading = branch.status === 'error'
      ? '部署失败，请查看日志'
      : branch.status === 'restarting'
        ? '服务正在热重启'
        : branch.status === 'building'
          ? '服务正在构建'
          : '服务正在启动中';

    const html = `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading} — ${branchSlug}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{max-width:460px;width:100%;padding:32px;background:#161b22;border:1px solid #30363d;border-radius:12px;text-align:center}
.spinner{width:28px;height:28px;border:3px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
h2{font-size:16px;font-weight:600;color:#f0f6fc;margin-bottom:8px}
.branch{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;color:#58a6ff;background:#21262d;padding:4px 8px;border-radius:4px;margin-bottom:8px;display:inline-block;word-break:break-all}
.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb55;margin-bottom:20px}
.services{display:flex;flex-direction:column;gap:6px;margin-bottom:16px;text-align:left}
.svc{font-size:13px;padding:6px 10px;background:#0d1117;border:1px solid #21262d;border-radius:6px;font-family:ui-monospace,monospace}
.hint{font-size:12px;color:#8b949e}
.err{font-size:12px;color:#f85149;background:#2a0d11;border:1px solid #5a1d1d;border-radius:6px;padding:8px;margin-bottom:12px;font-family:ui-monospace,monospace;text-align:left;max-height:120px;overflow:auto}
</style>
</head><body>
<div class="card">
  <div class="spinner"></div>
  <h2>${heading}</h2>
  <div class="branch">${branchSlug}</div>
  <div class="tag">分支状态：${branchLabel}</div>
  ${errorNote}
  <div class="services">${serviceRows}</div>
  <div class="hint">页面将在服务就绪后自动刷新…</div>
</div>
<script>setTimeout(function(){location.reload()},2000)</script>
</body></html>`;

    // Retry-After tells Cloudflare + bots this is transient. 2 matches the
    // client-side setTimeout so caches don't outlive our poll interval.
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
  <div class="emoji">🪦</div>
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
      const acceptsHtml = (clientReq.headers.accept || '').toLowerCase().includes('text/html');
      if (isConnLevel && acceptsHtml && branchCtx) {
        const state = this.stateService.getState();
        const branch = state.branches[branchCtx.branchId];
        if (branch) {
          this.serveStartingPage(clientRes, branchCtx.branchId, branch, branchCtx.profileId);
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
