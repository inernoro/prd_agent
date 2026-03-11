import http from 'node:http';
import type { RoutingRule, BranchEntry } from '../types.js';
import { StateService } from './state.js';
import type { WorktreeService } from './worktree.js';

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
  /** Optional worktree service for remote branch lookups */
  private worktreeService: WorktreeService | null = null;

  constructor(private readonly stateService: StateService) {}

  setResolveUpstream(fn: (branchId: string, profileId?: string) => string | null): void {
    this.resolveUpstream = fn;
  }

  setOnAutoBuild(fn: (branchSlug: string, req: http.IncomingMessage, res: http.ServerResponse) => void): void {
    this.onAutoBuild = fn;
  }

  setWorktreeService(wt: WorktreeService): void {
    this.worktreeService = wt;
  }

  /**
   * Resolve which branch should handle a request.
   * Returns the branch slug or null if no match.
   */
  resolveBranch(req: http.IncomingMessage): string | null {
    const state = this.stateService.getState();
    const rules = state.routingRules.filter(r => r.enabled);

    // Check X-Branch header first (highest implicit priority)
    const xBranch = req.headers['x-branch'] as string | undefined;
    if (xBranch) {
      const slug = StateService.slugify(xBranch);
      return slug;
    }

    // Check cds_branch cookie (set via /_switch/<branch> URL)
    const cookieBranch = this.parseCookie(req.headers.cookie || '', 'cds_branch');
    if (cookieBranch) {
      return StateService.slugify(cookieBranch);
    }

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
        // Header-based rules are handled by X-Branch above;
        // this is for custom header patterns in the rule itself
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
   * Check if the host is a "switch" domain (e.g., switch.miduo.org).
   * Returns true if the host starts with "switch.".
   */
  private isSwitchDomain(host: string): boolean {
    const h = host.split(':')[0].toLowerCase();
    return h.startsWith('switch.');
  }

  /**
   * Handle an incoming request on the worker port.
   * Routes to the correct branch or triggers auto-build.
   */
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers.host || '';
    const url = req.url || '/';

    // ── Switch domain: switch.miduo.org/<prefix>/<suffix> ──
    // Extract last path segment, suffix-match to a branch, auto-build & proxy
    if (this.isSwitchDomain(host)) {
      this.handleSwitchRequest(req, res);
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

    const branchSlug = this.resolveBranch(req);

    if (!branchSlug) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No branch matched. Set X-Branch header or configure routing rules.' }));
      return;
    }

    const state = this.stateService.getState();
    const branch = state.branches[branchSlug];

    // Branch doesn't exist or isn't running — trigger auto-build
    if (!branch || branch.status !== 'running') {
      if (this.onAutoBuild) {
        this.onAutoBuild(branchSlug, req, res);
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

    // Find the upstream URL for this branch
    if (!this.resolveUpstream) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy not configured' }));
      return;
    }

    // Determine which profile to route to based on URL path
    const profileId = this.detectProfileFromRequest(req, branch);
    const upstream = this.resolveUpstream(branchSlug, profileId);

    if (!upstream) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `No upstream available for branch "${branchSlug}"` }));
      return;
    }

    // Proxy the request
    console.log(`[proxy] ${req.method} ${req.url} → ${upstream} (branch=${branchSlug}, profile=${profileId || 'default'})`);
    this.proxyRequest(req, res, upstream);
  }

  /**
   * Handle requests from switch domain.
   *
   * URL format: switch.miduo.org/<anything>/<suffix>
   * The last path segment is used as a suffix to match against branch names.
   * Once matched, the branch is auto-built if needed, then the request is proxied.
   */
  private async handleSwitchRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';
    const pathParts = url.replace(/\?.*$/, '').split('/').filter(Boolean);

    // Root path — show info page
    if (pathParts.length === 0) {
      this.serveSwitchLanding(res);
      return;
    }

    // Extract the last path segment as the branch suffix
    const suffix = pathParts[pathParts.length - 1].toLowerCase();
    const state = this.stateService.getState();

    // Try suffix match against local branches first
    let matchedSlug = this.suffixMatchBranch(suffix, Object.keys(state.branches));

    if (matchedSlug) {
      const branch = state.branches[matchedSlug];
      if (branch && branch.status === 'running') {
        // Already running — redirect to the worker with a cookie
        this.redirectToWorkerWithCookie(res, matchedSlug);
        return;
      }
    }

    // If not found locally, try suffix match against remote branches
    if (!matchedSlug && this.worktreeService) {
      const remoteBranch = await this.worktreeService.findBranchBySuffix(suffix);
      if (remoteBranch) {
        matchedSlug = StateService.slugify(remoteBranch);
      }
    }

    const slugToUse = matchedSlug || StateService.slugify(suffix);

    if (!this.onAutoBuild) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `未找到匹配 "${suffix}" 的分支` }));
      return;
    }

    // Browser request (text/html) → serve build status page
    const accept = req.headers.accept || '';
    if (accept.includes('text/html')) {
      this.serveSwitchBuildPage(res, slugToUse, suffix);
      return;
    }

    // EventSource / API request → trigger auto-build (SSE stream)
    this.onAutoBuild(slugToUse, req, res);
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
   * Serve a lightweight HTML page that shows build status and auto-redirects.
   */
  private serveSwitchBuildPage(res: http.ServerResponse, branchSlug: string, suffix: string): void {
    const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CDS — 正在准备 ${branchSlug}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { max-width: 480px; width: 90%; padding: 32px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; text-align: center; }
  h2 { font-size: 18px; margin-bottom: 12px; }
  .branch { color: #58a6ff; font-family: monospace; font-size: 14px; word-break: break-all; margin-bottom: 16px; }
  .status { font-size: 14px; color: #8b949e; margin-bottom: 20px; }
  .spinner { width: 32px; height: 32px; border: 3px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .log { font-family: monospace; font-size: 11px; color: #8b949e; text-align: left; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 10px; max-height: 200px; overflow-y: auto; margin-top: 16px; white-space: pre-wrap; word-break: break-all; }
</style>
</head><body>
<div class="card">
  <div class="spinner" id="spinner"></div>
  <h2>正在准备分支环境</h2>
  <div class="branch">${branchSlug}</div>
  <div class="status" id="status">正在查找并构建分支...</div>
  <div class="log" id="log"></div>
</div>
<script>
const es = new EventSource(location.href);
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const spinnerEl = document.getElementById('spinner');
es.addEventListener('step', e => {
  const d = JSON.parse(e.data);
  statusEl.textContent = d.title || d.step;
});
es.addEventListener('log', e => {
  const d = JSON.parse(e.data);
  if (d.chunk) { logEl.textContent += d.chunk; logEl.scrollTop = logEl.scrollHeight; }
});
es.addEventListener('complete', e => {
  es.close();
  spinnerEl.style.borderTopColor = '#3fb950';
  spinnerEl.style.animation = 'none';
  statusEl.textContent = '构建完成，正在跳转...';
  // Redirect to worker with cookie set
  setTimeout(() => { location.reload(); }, 800);
});
es.addEventListener('error', e => {
  try {
    const d = JSON.parse(e.data);
    statusEl.textContent = '构建失败: ' + (d.message || '未知错误');
  } catch { statusEl.textContent = '连接断开'; }
  spinnerEl.style.borderTopColor = '#f85149';
  spinnerEl.style.animation = 'none';
  es.close();
});
</script>
</body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * Redirect to worker with cds_branch cookie so subsequent requests go to the right branch.
   */
  private redirectToWorkerWithCookie(res: http.ServerResponse, branchSlug: string): void {
    res.writeHead(302, {
      'Set-Cookie': `cds_branch=${encodeURIComponent(branchSlug)}; Path=/; SameSite=Lax`,
      Location: '/',
      'Content-Type': 'text/plain',
    });
    res.end(`Switching to branch: ${branchSlug}`);
  }

  /**
   * Landing page for the switch domain root.
   */
  private serveSwitchLanding(res: http.ServerResponse): void {
    const state = this.stateService.getState();
    const branches = Object.entries(state.branches);
    const listHtml = branches.length > 0
      ? branches.map(([slug, b]) =>
        `<a href="/${slug}" class="item"><span class="dot ${b.status}"></span><span>${slug}</span><span class="st">${b.status}</span></a>`
      ).join('')
      : '<div class="empty">暂无分支</div>';

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>CDS Switch</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { max-width: 520px; width: 90%; padding: 28px; background: #161b22; border: 1px solid #30363d; border-radius: 12px; }
  h2 { font-size: 18px; margin-bottom: 6px; }
  .desc { font-size: 13px; color: #8b949e; margin-bottom: 16px; }
  code { background: #21262d; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
  .list { display: flex; flex-direction: column; gap: 4px; }
  .item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #0d1117; border: 1px solid #21262d; border-radius: 6px; text-decoration: none; color: #58a6ff; font-size: 13px; font-family: monospace; transition: border-color 0.15s; }
  .item:hover { border-color: #58a6ff; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .dot.running { background: #3fb950; } .dot.building { background: #d29922; } .dot.idle { background: #484f58; } .dot.error { background: #f85149; } .dot.stopped { background: #484f58; opacity: .5; }
  .st { margin-left: auto; font-size: 11px; color: #8b949e; font-family: sans-serif; }
  .empty { font-size: 13px; color: #484f58; padding: 12px 0; }
</style>
</head><body>
<div class="card">
  <h2>CDS Switch</h2>
  <div class="desc">访问 <code>/分支名后缀</code> 自动匹配并启动分支。例如：<code>/fix-login-issue</code></div>
  <div class="list">${listHtml}</div>
</div>
</body></html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * Detect which build profile should handle the request based on URL path.
   * For example: /api/* goes to backend profile, everything else to frontend.
   */
  private detectProfileFromRequest(req: http.IncomingMessage, branch: BranchEntry): string | undefined {
    const url = req.url || '/';
    const profileIds = Object.keys(branch.services);

    // If there's an "api" profile and request starts with /api/, route there
    if (url.startsWith('/api/')) {
      const apiProfile = profileIds.find(id => id.includes('api') || id.includes('backend'));
      if (apiProfile) return apiProfile;
    }

    // Otherwise route to the first running web/frontend profile, or the first available
    const webProfile = profileIds.find(id => id.includes('web') || id.includes('frontend') || id.includes('admin'));
    if (webProfile) return webProfile;

    // Fallback to first profile
    return profileIds[0];
  }

  /**
   * Proxy an HTTP request to an upstream URL.
   * Simple implementation using Node.js http module.
   */
  private proxyRequest(clientReq: http.IncomingMessage, clientRes: http.ServerResponse, upstream: string): void {
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

    const proxyReq = http.request(options, (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(clientRes, { end: true });
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
    const branchSlug = this.resolveBranch(req);
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
    proxyReq.on('upgrade', (_proxyRes, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `\r\n`,
      );
      if (proxyHead.length > 0) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxyReq.on('error', () => socket.destroy());
    proxyReq.end();
  }
}
