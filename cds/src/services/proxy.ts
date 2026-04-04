import http from 'node:http';
import zlib from 'node:zlib';
import type { RoutingRule, BranchEntry, CdsConfig, BuildProfile } from '../types.js';
import { StateService } from './state.js';
import type { WorktreeService } from './worktree.js';
import { buildWidgetScript } from '../widget-script.js';

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

  constructor(
    private readonly stateService: StateService,
    private readonly config?: CdsConfig,
  ) {}

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

  /**
   * Handle switch-domain requests from Express (master server).
   * Express req/res are compatible with http.IncomingMessage/ServerResponse.
   */
  handleSwitchFromExpress(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.handleSwitchRequest(req, res);
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
   * Returns the branch slug extracted from the subdomain, or null.
   */
  private extractPreviewBranch(host: string): string | null {
    const previewDomain = this.config?.previewDomain;
    if (!previewDomain) return null;
    const h = host.split(':')[0].toLowerCase();
    const suffix = `.${previewDomain.toLowerCase()}`;
    if (h.endsWith(suffix) && h.length > suffix.length) {
      return h.slice(0, -suffix.length);
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
      res.writeHead(502, { 'Content-Type': 'application/json' });
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
    const state = this.stateService.getState();
    const branch = state.branches[branchSlug];

    // Branch doesn't exist or isn't running — trigger auto-build or show loading
    if (!branch || (branch.status !== 'running' && branch.status !== 'starting')) {
      if (this.onAutoBuild) {
        this.onAutoBuild(branchRef, req, res);
        return;
      }
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `Branch "${branchSlug}" is not running.`,
        status: branch?.status || 'not-found',
        hint: branch?.status === 'building' ? 'Build in progress, please wait...' : 'Branch will be auto-built on next request.',
      }));
      return;
    }

    // Branch-level starting: all services still initializing
    if (branch.status === 'starting') {
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

    // Service-level starting: branch is "running" (some services up) but
    // the specific service for this request is still initializing.
    // Show loading page instead of proxying to a half-ready server
    // (prevents CSS MIME type errors from Vite returning HTML before ready).
    if (profileId) {
      const svc = branch.services[profileId];
      if (svc && svc.status === 'starting') {
        this.serveStartingPage(res, branchSlug, branch, profileId);
        return;
      }
    }

    const upstream = this.resolveUpstream(branchSlug, profileId);

    if (!upstream) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No upstream available for branch "${branchSlug}"` }));
      return;
    }

    console.log(`[proxy] ${req.method} ${req.url} → ${upstream} (branch=${branchSlug}, profile=${profileId || 'default'})`);
    this.proxyRequest(req, res, upstream, { branchId: branchSlug, branchName: branchRef, trackAccess: true, profileId });
  }

  /**
   * Serve a loading page when a branch or service is in 'starting' state.
   * Auto-refreshes every 2 seconds until the service is ready.
   */
  private serveStartingPage(res: http.ServerResponse, branchSlug: string, branch: BranchEntry, waitingProfileId?: string): void {
    const services = Object.values(branch.services);
    const serviceRows = services.map(svc => {
      const icon = svc.status === 'running' ? '✓' : svc.status === 'starting' ? '◌' : svc.status === 'error' ? '✗' : '·';
      const color = svc.status === 'running' ? '#3fb950' : svc.status === 'starting' ? '#58a6ff' : svc.status === 'error' ? '#f85149' : '#8b949e';
      const label = waitingProfileId === svc.profileId ? `${svc.profileId} (等待就绪...)` : svc.profileId;
      return `<div class="svc"><span style="color:${color}">${icon}</span> ${label}</div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>启动中 — ${branchSlug}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{max-width:420px;width:100%;padding:32px;background:#161b22;border:1px solid #30363d;border-radius:12px;text-align:center}
.spinner{width:28px;height:28px;border:3px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
h2{font-size:16px;font-weight:600;color:#f0f6fc;margin-bottom:8px}
.branch{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;color:#58a6ff;background:#21262d;padding:4px 8px;border-radius:4px;margin-bottom:20px;display:inline-block;word-break:break-all}
.services{display:flex;flex-direction:column;gap:6px;margin-bottom:16px;text-align:left}
.svc{font-size:13px;padding:6px 10px;background:#0d1117;border:1px solid #21262d;border-radius:6px;font-family:ui-monospace,monospace}
.hint{font-size:12px;color:#8b949e}
</style>
</head><body>
<div class="card">
  <div class="spinner"></div>
  <h2>服务正在启动中</h2>
  <div class="branch">${branchSlug}</div>
  <div class="services">${serviceRows}</div>
  <div class="hint">页面将在服务就绪后自动刷新...</div>
</div>
<script>setTimeout(function(){location.reload()},2000)</script>
</body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store' });
    res.end(html);
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

    // If not found locally, try remote (full path first, then last segment, then slug matching)
    if (!matchedSlug && this.worktreeService) {
      const remoteBranch = await this.worktreeService.findBranchBySuffix(fullPath)
        || (fullPath !== lastSegment ? await this.worktreeService.findBranchBySuffix(lastSegment) : null)
        || await this.worktreeService.findBranchBySlug(fullPath)
        || (fullPath !== lastSegment ? await this.worktreeService.findBranchBySlug(lastSegment) : null);
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
    if (branchCtx?.trackAccess && this.onAccess) {
      const onAccessCb = this.onAccess;
      const method = clientReq.method || 'GET';
      const reqPath = clientReq.url || '/';
      const branchId = branchCtx.branchId;
      const profileId = branchCtx.profileId;
      clientRes.on('finish', () => {
        onAccessCb(branchId, method, reqPath, clientRes.statusCode, Date.now() - proxyStart, profileId);
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

    proxyReq.on('error', (err) => {
      console.error(`[proxy] upstream error: ${err.message} → ${upstream}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: `Upstream error: ${err.message}` }));
      }
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

    const state = this.stateService.getState();
    const branch = state.branches[branchSlug];
    if (!branch || branch.status !== 'running') {
      socket.destroy();
      return;
    }

    const profileId = this.detectProfileFromRequest(req, branch);
    const upstream = this.resolveUpstream(branchSlug, profileId);
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
