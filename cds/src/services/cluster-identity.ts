import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { StateService } from './state.js';
import type { ServerEventLogSink } from './server-event-log-store.js';
import { createExternalResponseAudit } from './standby-response-audit.js';
import { installClusterIdentity, type ClusterIdentityContext } from './cluster-identity-context.js';
import { isAuthenticatedHuman } from './human-auth.js';
import type { Project } from '../types.js';

interface Member { nodeId: string; url: string; tokenHash: string; projects: Record<string, string> }
export type ClusterIdentityConfig = {
  version: 1; clusterId: string; nodeId: string;
} & ({ role: 'authority'; members: Member[] }
  | { role: 'member'; authorityNodeId: string; authorityUrl: string; nodeToken: string; projects: Record<string, string> });

const credentialHeaders = ['cookie', 'x-ai-access-key', 'ai-access-key', 'authorization', 'x-cds-ai-token', 'x-cds-token'];
const cookieNames = ['cds_token', 'cds_gh_session', 'cds_sso_session'];
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
class ClusterIdentityValidationError extends Error {
  constructor(readonly code: string) { super(code); }
}

function origin(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid cluster URL');
  return url.origin;
}
function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value); }
function localReturn(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u0020]/.test(value) ? value : '/project-list';
}
export function clusterProjectRepository(project: Project | undefined): string | null {
  if (!project) return null;
  const raw = project.gitRepoUrl || (project.githubRepoFullName ? `https://github.com/${project.githubRepoFullName}` : '');
  if (!raw) return null;
  const scp = /^git@([^:]+):(.+)$/.exec(raw);
  try {
    const url = scp ? new URL(`ssh://${scp[1]}/${scp[2]}`) : new URL(raw);
    const repository = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return url.hostname.toLowerCase() + '/' + (url.hostname.toLowerCase() === 'github.com' ? repository.toLowerCase() : repository);
  } catch { return null; }
}
function mappings(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('missing project bindings');
  const entries = Object.entries(value);
  if (entries.length > 1000 || entries.some(([a, b]) => !validId(a) || !validId(b))
    || new Set(entries.map(([, b]) => b)).size !== entries.length) throw new Error('invalid project bindings');
  return Object.fromEntries(entries) as Record<string, string>;
}
export function parseClusterIdentityConfig(value: unknown): ClusterIdentityConfig {
  const v = value as ClusterIdentityConfig;
  if (!v || v.version !== 1 || !validId(v.clusterId) || !validId(v.nodeId)) throw new Error('invalid cluster identity');
  if (v.role === 'authority') {
    if (!Array.isArray(v.members) || v.members.length > 20) throw new Error('invalid members');
    const nodes = new Set([v.nodeId]), urls = new Set<string>();
    const members = v.members.map(m => {
      if (!validId(m.nodeId) || !/^[a-f0-9]{64}$/.test(m.tokenHash)) throw new Error('invalid member identity');
      const url = origin(m.url);
      if (nodes.has(m.nodeId) || urls.has(url)) throw new Error('duplicate member');
      nodes.add(m.nodeId); urls.add(url);
      return { nodeId: m.nodeId, url, tokenHash: m.tokenHash, projects: mappings(m.projects) };
    });
    return { version: 1, role: v.role, clusterId: v.clusterId, nodeId: v.nodeId, members };
  }
  if (v.role !== 'member' || !validId(v.authorityNodeId) || v.authorityNodeId === v.nodeId
    || typeof v.nodeToken !== 'string' || !/^[a-zA-Z0-9_-]{43,128}$/.test(v.nodeToken)) throw new Error('invalid authority');
  return { version: 1, role: v.role, clusterId: v.clusterId, nodeId: v.nodeId,
    authorityNodeId: v.authorityNodeId, authorityUrl: origin(v.authorityUrl), nodeToken: v.nodeToken, projects: mappings(v.projects) };
}

function failure(res: Response, code: string, status = 503): void {
  res.status(status).json({ error: code, message: status === 401
    ? '集群授权未通过，请从主 CDS 登录或检查原有授权。'
    : '暂时无法确认集群统一授权，请稍后重试或联系系统所有者检查主备连接。' });
}
export function clusterAuthorityPath(pathname: string): boolean {
  pathname = pathname.replace(/\/+$/, '').toLowerCase();
  return /^\/api\/(?:auth(?:\/|$)|me$|login$|logout$|identity(?:\/|$)|credentials\/self-check$|ai(?:\/|$)|access-requests(?:\/|$)|bootstrap-access-requests(?:\/|$)|global-agent-keys(?:\/|$))/.test(pathname)
    || /^\/api\/projects\/[^/]+\/(?:agent-keys|access-status|access-requests)(?:\/|$)/.test(pathname);
}

/** Every request uses the authority's current decision. No stale local-key fallback. */
export class ClusterIdentityService {
  private config: ClusterIdentityConfig | undefined;
  private readonly file: string;
  private lastVerifiedAt: string | null = null;
  private lastErrorAt: string | null = null;
  private readonly memberSeen = new Map<string, string>();
  private readonly tickets = new Map<string, { nodeId: string; cookie: string; expires: number; returnTo: string }>();

  constructor(repoRoot: string, private readonly state: StateService, private readonly sink?: ServerEventLogSink | null) {
    this.file = path.join(repoRoot, '.cds', 'cluster-identity.json');
    // A broken membership must fail startup, never silently become independent.
    if (fs.existsSync(this.file)) this.config = parseClusterIdentityConfig(JSON.parse(fs.readFileSync(this.file, 'utf8')));
  }
  getConfig() { return this.config; }
  configure(value: unknown): void {
    const config = parseClusterIdentityConfig(value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.file);
      this.config = config;
      this.lastVerifiedAt = null; this.lastErrorAt = null;
    } finally { fs.rmSync(temp, { force: true }); }
  }
  status() {
    const c = this.config;
    if (!c) return { enabled: false, state: 'independent' };
    return { enabled: true, clusterId: c.clusterId, nodeId: c.nodeId, role: c.role,
      authorityNodeId: c.role === 'authority' ? c.nodeId : c.authorityNodeId,
      authorityUrl: c.role === 'member' ? c.authorityUrl : null,
      state: c.role === 'authority' ? 'authority' : this.lastVerifiedAt && !this.lastErrorAt ? 'synchronized' : 'unverified',
      lastVerifiedAt: this.lastVerifiedAt, lastErrorAt: this.lastErrorAt,
      validation: 'live-per-request', independentAuthorization: false,
      ...(c.role === 'authority' ? { members: c.members.map(({ tokenHash: _, ...m }) => ({ ...m,
        lastVerifiedAt: this.memberSeen.get(m.nodeId) ?? null,
        state: Date.now() - Date.parse(this.memberSeen.get(m.nodeId) || '') < 60_000 ? 'synchronized' : 'unverified' })) } : { projects: c.projects }) };
  }
  memberOf(req: Request): Member | undefined {
    const c = this.config;
    if (c?.role !== 'authority' || req.headers['x-cds-cluster-id'] !== c.clusterId) return;
    const token = req.headers['x-cds-cluster-token'];
    if (typeof token !== 'string' || token.length > 128) return;
    const hash = createHash('sha256').update(token).digest();
    const member = c.members.find(m => m.nodeId === req.headers['x-cds-cluster-node']
      && timingSafeEqual(Buffer.from(m.tokenHash, 'hex'), hash));
    if (member) this.memberSeen.set(member.nodeId, new Date().toISOString());
    return member;
  }
  /** Verify the primary also knows this exact binding before applying any scope. */
  mapContext(raw: ClusterIdentityContext & { projects: Record<string, string>; projectRepositories: Record<string, string | null> }, reconfigure = false): ClusterIdentityContext {
    const c = this.config;
    const owner = raw?.user?.isSystemOwner === true || raw?.aiSession?.id === 'static';
    const identityValid = raw && ((raw.user?.status === 'active' && typeof raw.user.id === 'string' && typeof raw.user.isSystemOwner === 'boolean')
      || (typeof raw.aiSession?.id === 'string' && !!raw.aiSession.id));
    const scopeValid = (!raw?.aiSession?.id.startsWith('projkey:') || !!raw.projectKey)
      && (!raw?.aiSession?.id.startsWith('globalkey:') || !!raw.access)
      && (!raw?.aiSession?.id.startsWith('principal:') || !!raw.principal);
    if (c?.role !== 'member' || raw.clusterId !== c.clusterId || raw.authorityNodeId !== c.authorityNodeId
      || raw.nodeId !== c.nodeId || !identityValid || !scopeValid
      || (!(reconfigure && owner) && JSON.stringify(Object.entries(raw.projects || {}).sort()) !== JSON.stringify(Object.entries(c.projects).sort()))) {
      throw new ClusterIdentityValidationError('cluster_identity_mismatch');
    }
    if (reconfigure && owner) return { clusterId: raw.clusterId, nodeId: raw.nodeId, authorityNodeId: raw.authorityNodeId,
      user: raw.user, session: raw.session, basicHuman: raw.basicHuman, aiSession: raw.aiSession };
    const mapId = (id: string): string => {
      const local = c.projects[id];
      const project = this.state.getProject(local);
      const repository = clusterProjectRepository(project);
      if (!local || !project || !(id in (raw.projectRepositories || {})) || raw.projectRepositories[id] !== repository
        || (!repository && id !== project.id)) throw new ClusterIdentityValidationError('cluster_project_binding_mismatch');
      return local;
    };
    for (const id of Object.keys(c.projects)) mapId(id);
    return { ...raw,
      ...(raw.projectKey ? { projectKey: { ...raw.projectKey, projectId: mapId(raw.projectKey.projectId) } } : {}),
      ...(raw.humanProjects ? { humanProjects: raw.humanProjects.filter(id => c.projects[id] && this.state.getProject(c.projects[id])).map(mapId) } : {}),
      ...(raw.principalProjects ? { principalProjects: raw.principalProjects.filter(id => c.projects[id] && this.state.getProject(c.projects[id])).map(mapId) } : {}),
      ...(raw.access ? { access: { ...raw.access, access: { ...raw.access.access,
        projects: raw.access.access.projects === 'all' ? 'all' : raw.access.access.projects.filter(id => c.projects[id]).map(mapId) } } } : {}),
    };
  }
  private async call(req: Request, pathname: string, body?: unknown, method = 'POST', streamTo?: Response) {
    const c = this.config;
    if (c?.role !== 'member') throw new Error('not a member');
    const headers: Record<string, string> = { 'x-cds-cluster-id': c.clusterId, 'x-cds-cluster-node': c.nodeId,
      'x-cds-cluster-token': c.nodeToken, 'accept': 'application/json' };
    for (const key of credentialHeaders) if (typeof req.headers[key] === 'string') headers[key] = req.headers[key] as string;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const audit = createExternalResponseAudit(this.sink, { projectId: '_cluster', remoteProjectId: '_cluster', policy: 'cluster-identity', dryRun: false,
      businessRequestId: (req as Request & { cdsRequestId?: string }).cdsRequestId },
      { source: 'cluster-identity', action: 'cluster.identity.response', message: '集群身份响应' });
    audit.assertAvailable();
    const started = Date.now();
    let response: globalThis.Response | undefined, text = '', json: unknown, parseState = 'no-response', decision = 'unavailable';
    const secrets = [c.nodeToken, ...credentialHeaders.map(k => String(req.headers[k] || ''))];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const stop = () => controller.abort();
    if (streamTo) streamTo.once('close', stop);
    try {
      response = await fetch(c.authorityUrl + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual', signal: controller.signal });
      if (streamTo && response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
        clearTimeout(timer);
        await audit.record({ peerId: c.authorityNodeId, url: c.authorityUrl + pathname, method,
          startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, timeoutMs: TIMEOUT_MS,
          responseReceived: true, httpStatus: response.status, contentType: response.headers.get('content-type'),
          upstreamRequestId: response.headers.get('x-cds-request-id'), parseState: 'json',
          json: { status: 'stream-open' }, localDecision: 'success', secrets });
        streamTo.status(response.status).setHeader('Content-Type', 'text/event-stream');
        streamTo.setHeader('Cache-Control', 'no-cache'); streamTo.flushHeaders();
        parseState = 'sse'; decision = 'success';
        if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) streamTo.write(chunk);
        streamTo.end();
        return { status: response.status, json: null, text: '', cookies: [], location: null };
      }
      const chunks: Uint8Array[] = []; let size = 0;
      if (response.body) for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > MAX_REPLY_BYTES) throw new Error('identity response too large');
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks).toString('utf8'); parseState = 'invalid-json';
      try { json = JSON.parse(text); parseState = 'json'; } catch { /* safe audit below */ }
      decision = response.ok ? 'success' : 'rejected';
      return { status: response.status, json, text, cookies: response.headers.getSetCookie(), location: response.headers.get('location') };
    } finally {
      clearTimeout(timer);
      if (streamTo) streamTo.removeListener('close', stop);
      await audit.record({ peerId: c.authorityNodeId, url: c.authorityUrl + pathname.split('?')[0], method,
        startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, timeoutMs: TIMEOUT_MS,
        responseReceived: !!response, httpStatus: response?.status ?? null, contentType: response?.headers.get('content-type') ?? null,
        upstreamRequestId: response?.headers.get('x-cds-request-id') ?? null, text,
        // Never audit credential exchange replies, even if an upstream adds a new secret field.
        json: { status: response?.status ?? null, code: (json as { error?: string })?.error, decision },
        parseState, localDecision: decision, secrets });
    }
  }
  private translated(value: unknown, toAuthority: boolean, key = '', depth = 0): unknown {
    const c = this.config;
    if (c?.role !== 'member') return value;
    if (depth > 20) throw new Error('identity payload too deep');
    const ids = toAuthority ? Object.fromEntries(Object.entries(c.projects).map(([a, b]) => [b, a])) : c.projects;
    if (typeof value === 'string' && ['projectId', 'projectIds', 'projects'].includes(key)) {
      if (!ids[value] && toAuthority) throw new Error('project has no cluster binding');
      return ids[value] || value;
    }
    if (Array.isArray(value)) return value.map(v => this.translated(v, toAuthority, key, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.translated(v, toAuthority, k, depth + 1)]));
    return value;
  }
  private authorityPath(req: Request): string {
    const url = new URL(req.url, 'http://cluster.local');
    const c = this.config;
    if (c?.role !== 'member') throw new Error('not a member');
    url.pathname = url.pathname.replace(/(\/api\/projects\/)([^/]+)/i, (_, prefix: string, id: string) => {
      const source = Object.entries(c.projects).find(([, local]) => local === decodeURIComponent(id))?.[0];
      if (!source) throw new Error('project has no cluster binding');
      return prefix + encodeURIComponent(source);
    });
    for (const name of ['project', 'projectId']) if (url.searchParams.has(name)) {
      url.searchParams.set(name, this.translated(url.searchParams.get(name), true, 'projectId') as string);
    }
    return url.pathname + url.search;
  }
  private copyCookies(res: Response, cookies: string[]): void {
    const safe = cookies.filter(cookie => cookieNames.some(n => cookie.startsWith(n + '=')))
      .map(cookie => cookie.replace(/;\s*Domain=[^;]*/gi, ''));
    if (safe.length) res.setHeader('Set-Cookie', safe);
  }
  async middleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const c = this.config;
    if (c?.role !== 'member') { next(); return; }
    const pathname = req.path.replace(/\/+$/, '').toLowerCase();
    if (pathname === '/api/projects' && req.method === 'POST') {
      res.status(409).json({ error: 'cluster_authority_required', message: '请在主 CDS 创建项目，再绑定到集群成员；集群成员不会独立签发项目授权。', authorityUrl: c.authorityUrl }); return;
    }
    // Authentication diagnostics and management always reach the same source.
    if (clusterAuthorityPath(req.path)) {
      res.locals.cdsSuppressRequestBodyLog = true;
      res.setHeader('Cache-Control', 'no-store');
      try {
        const reply = await this.call(req, this.authorityPath(req), ['GET', 'HEAD'].includes(req.method) ? undefined : this.translated(req.body, true), req.method,
          pathname === '/api/ai/pairing-stream' ? res : undefined);
        if (res.headersSent) return;
        this.copyCookies(res, reply.cookies);
        if (reply.location) {
          // OAuth/SSO logins use the authority's registered callback, followed by the cluster handoff.
          res.redirect(reply.status, new URL(reply.location, c.authorityUrl).href); return;
        }
        res.status(reply.status).json(this.translated(reply.json ?? { error: 'cluster_identity_invalid_response' }, false));
      } catch { this.lastErrorAt = new Date().toISOString(); if (res.headersSent) res.end(); else failure(res, 'cluster_identity_unavailable'); }
      return;
    }
    if (pathname === '/login' || pathname === '/login.html') {
      const returnTo = localReturn(req.query.redirect);
      res.redirect(302, `${c.authorityUrl}/api/cluster/identity/login?node=${encodeURIComponent(c.nodeId)}&returnTo=${encodeURIComponent(returnTo)}`); return;
    }
    if (pathname === '/api/cluster/identity/callback') {
      res.locals.cdsSuppressRequestBodyLog = true;
      res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
      try {
        const ticket = req.query.ticket;
        if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) { failure(res, 'cluster_ticket_invalid', 401); return; }
        const reply = await this.call(req, '/api/cluster/identity/exchange', { ticket });
        if (reply.status !== 200) { failure(res, 'cluster_ticket_invalid', 401); return; }
        this.copyCookies(res, reply.cookies);
        const target = (reply.json as { returnTo?: string })?.returnTo;
        res.redirect(302, localReturn(target));
      } catch { failure(res, 'cluster_identity_unavailable'); }
      return;
    }
    next();
  }
  async authenticate(req: Request, res: Response): Promise<boolean> {
    if (this.config?.role !== 'member') return false;
    try {
      const reply = await this.call(req, '/api/cluster/identity/resolve', { method: req.method, path: req.url });
      if (reply.status !== 200) { failure(res, 'cluster_identity_rejected', reply.status === 401 ? 401 : 503); return true; }
      installClusterIdentity(req, this.mapContext(reply.json as Parameters<ClusterIdentityService['mapContext']>[0],
        req.path.replace(/\/+$/, '').toLowerCase() === '/api/cluster/identity/config'));
      this.copyCookies(res, reply.cookies);
      this.lastVerifiedAt = new Date().toISOString(); this.lastErrorAt = null;
      return false;
    } catch (error) {
      this.lastErrorAt = new Date().toISOString();
      const code = error instanceof ClusterIdentityValidationError ? error.code : 'cluster_identity_unavailable';
      try {
        await this.sink?.recordImmediate?.({ category: 'system', severity: 'warn', source: 'cluster-identity', action: 'cluster.identity.validation-rejected',
          message: '集群身份本地校验拒绝', requestId: (req as Request & { cdsRequestId?: string }).cdsRequestId,
          details: { clusterId: this.config?.clusterId, nodeId: this.config?.nodeId, code } });
      } catch { console.warn('[cluster-identity] 本地校验拒绝记录未能持久化'); }
      failure(res, code); return true;
    }
  }
  login(req: Request, res: Response): void {
    const c = this.config;
    const member = c?.role === 'authority' ? c.members.find(m => m.nodeId === req.query.node) : undefined;
    if (!member || !isAuthenticatedHuman(req)) { failure(res, 'cluster_login_rejected', 401); return; }
    const now = Date.now();
    for (const [id, t] of this.tickets) if (t.expires < now) this.tickets.delete(id);
    if (this.tickets.size > 1000) { failure(res, 'cluster_login_busy'); return; }
    const ticket = randomBytes(32).toString('hex');
    const returnTo = localReturn(req.query.returnTo);
    const cookie = (req.headers.cookie || '').split(';').filter(s => cookieNames.some(n => s.trim().startsWith(n + '='))).join(';');
    this.tickets.set(createHash('sha256').update(ticket).digest('hex'), { nodeId: member.nodeId, cookie, expires: now + 60_000, returnTo });
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, `${member.url}/api/cluster/identity/callback?ticket=${ticket}`);
  }
  exchange(req: Request, res: Response): void {
    const member = this.memberOf(req);
    const token = req.body?.ticket;
    if (!member || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) { failure(res, 'cluster_ticket_invalid', 401); return; }
    const key = createHash('sha256').update(token).digest('hex');
    const ticket = this.tickets.get(key);
    if (!ticket || ticket.nodeId !== member.nodeId || ticket.expires < Date.now()) { failure(res, 'cluster_ticket_invalid', 401); return; }
    this.tickets.delete(key);
    res.setHeader('Set-Cookie', ticket.cookie.split(';').filter(Boolean).map(cookie => `${cookie.trim()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`));
    res.setHeader('Cache-Control', 'no-store'); res.json({ returnTo: ticket.returnTo });
  }
}
