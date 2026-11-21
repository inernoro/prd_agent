import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ProjectRevisionStore } from './project-revision-store.js';
import { normalizePlanningPreviewPath } from '../shared/engineering-planning-links.js';

export type PreviewAccessPerson = { id: string; username: string; name: string; owner: boolean };
export type PreviewAccessClient = {
  id: string; secret: string; callback: string; commit: string; projectId: string; branchId: string;
  projectName: string; branchName: string; pullRequest: number; origin: string; path: string;
};
export type PreviewAccessRequest = {
  id: string; projectId: string; branchId: string; clientId: string; subject: string; name: string;
  createdAt: string; note: string; returnPath?: string;
};
export type PreviewAccessCommit = { projectId: string; revision: number; request: PreviewAccessRequest };
type Ticket = { person: PreviewAccessPerson; client: PreviewAccessClient; state: string; expires: number };
const codePattern = /^[\w-]{32,128}$/;
const clientIdPattern = /^[A-Za-z0-9_-]{8,160}$/;
const hash = (value: string) => createHash('sha256').update(value).digest();
const ttl = 5 * 60_000;

export function previewReturnPath(input: unknown, root = '/') {
  if (typeof input !== 'string' || /%(?:2f|5c|2e|25)|(^|\/)\.{1,2}(?:\/|[?#]|$)/i.test(input)) return undefined;
  const path = normalizePlanningPreviewPath(input);
  if (!path || /^(?:\/_cds)?\/(?:api|auth)(?:[/?#]|$)|^\/login(?:[/?#]|$)/i.test(path)) return undefined;
  const namespace = root === '/' ? '/' : root.replace(/\/$/, '');
  const pathname = new URL(path, 'https://cds.invalid').pathname;
  return namespace === '/' || pathname === namespace || pathname.startsWith(namespace + '/') ? path : undefined;
}

export function previewPolicyReturnUrl(config: {
  enabled: boolean; providerId?: string; clientId?: string; authorizationUrl?: string;
}) {
  if (!config.enabled || config.providerId !== 'cds-preview' || !config.clientId || !clientIdPattern.test(config.clientId)
    || !config.authorizationUrl) return undefined;
  let authority: URL;
  try { authority = new URL(config.authorizationUrl); } catch { return undefined; }
  if (authority.pathname !== '/preview/authorize' || authority.username || authority.password || authority.search || authority.hash
    || (authority.protocol !== 'https:' && !(authority.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(authority.hostname)))) return undefined;
  const link = new URL('/preview-access', authority);
  link.searchParams.set('client', config.clientId);
  return link.href;
}

export class PlanningPreviewAccess {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly deps: {
    resolve: (clientId: string) => Promise<PreviewAccessClient | undefined>;
    allowed: (person: PreviewAccessPerson, projectId: string) => Promise<boolean>;
    store: ProjectRevisionStore<PreviewAccessCommit>;
    now?: () => number;
  }) {}

  client(value: unknown) {
    return typeof value === 'string' && clientIdPattern.test(value)
      ? this.deps.resolve(value) : Promise.resolve(undefined);
  }
  allowed(person: PreviewAccessPerson, projectId: string) {
    return this.deps.allowed(person, projectId);
  }
  private now() { return (this.deps.now ?? Date.now)(); }

  async issue(client: PreviewAccessClient, person: PreviewAccessPerson, state: unknown, redirect: unknown) {
    if (typeof state !== 'string' || !codePattern.test(state) || redirect !== client.callback
      || !await this.deps.allowed(person, client.projectId)) return undefined;
    const now = this.now();
    for (const [value, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(value);
    if (this.tickets.size >= 4096) return undefined;
    const code = randomBytes(32).toString('base64url');
    this.tickets.set(code, { person, client, state, expires: now + ttl });
    const callback = new URL(client.callback);
    callback.hash = new URLSearchParams({ code, state }).toString();
    return callback.href;
  }

  async consume(input: Record<string, unknown>) {
    if (input.grant_type !== 'urn:cds:params:oauth:grant-type:ticket' || typeof input.code !== 'string'
      || !codePattern.test(input.code) || typeof input.client_secret !== 'string' || input.client_secret.length > 256) return undefined;
    const token = input.code;
    const ticket = this.tickets.get(token);
    if (!ticket || this.now() >= ticket.expires || input.state !== ticket.state || input.client_id !== ticket.client.id
      || input.redirect_uri !== ticket.client.callback || !timingSafeEqual(hash(input.client_secret), hash(ticket.client.secret))) return undefined;
    const client = await this.client(ticket.client.id);
    if (!client || client.commit !== ticket.client.commit || client.callback !== ticket.client.callback || client.origin !== ticket.client.origin
      || client.projectId !== ticket.client.projectId || client.branchId !== ticket.client.branchId
      || !timingSafeEqual(hash(client.secret), hash(ticket.client.secret))
      || !await this.deps.allowed(ticket.person, client.projectId)) return undefined;
    if (this.now() >= ticket.expires || !this.tickets.delete(token)) return undefined;
    return { subject: ticket.person.id, username: ticket.person.username, displayName: ticket.person.name };
  }

  async requests(projectId: string) {
    return (await this.deps.store.read(projectId, 0)).map(row => row.request);
  }

  async findRequest(projectIds: string[], id: unknown, person: PreviewAccessPerson) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(id)) return undefined;
    const lists = await Promise.all(projectIds.map(projectId => this.requests(projectId)));
    return lists.flat().find(row => row.id === id && row.subject === person.id);
  }

  async notices(projectIds: string[], person: PreviewAccessPerson) {
    const lists = await Promise.all(projectIds.map(projectId => this.requests(projectId)));
    const rows = lists.flat().filter(row => person.owner || row.subject === person.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const clients = new Map<string, Promise<PreviewAccessClient | undefined>>();
    const statuses = await Promise.all(rows.map(async row => {
      const applicant = { id: row.subject, username: row.name, name: row.name, owner: false };
      const allowed = await this.allowed(applicant, row.projectId);
      if (allowed === person.owner) return undefined;
      let resolved = clients.get(row.clientId);
      if (!resolved) {
        resolved = this.client(row.clientId);
        clients.set(row.clientId, resolved);
      }
      const client = await resolved;
      if (!client || client.projectId !== row.projectId || client.branchId !== row.branchId) return undefined;
      return { id: row.id, project: client.projectName };
    }));
    const available = statuses.flatMap(row => row ? [row] : []);
    return person.owner ? { pending: available.length, approved: [] } : { pending: 0, approved: available.slice(0, 50) };
  }

  async request(client: PreviewAccessClient, person: PreviewAccessPerson, note: string, path = client.path) {
    if (await this.deps.allowed(person, client.projectId)) return undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const rows = await this.deps.store.read(client.projectId, 0);
      const prior = rows.map(row => row.request).find(row => row.clientId === client.id && row.subject === person.id);
      if (prior) return prior;
      const request: PreviewAccessRequest = { id: randomBytes(18).toString('base64url'), projectId: client.projectId, branchId: client.branchId,
        clientId: client.id, subject: person.id, name: person.name, createdAt: new Date(this.now()).toISOString(), note,
        returnPath: previewReturnPath(path) };
      if (await this.deps.store.append({ projectId: client.projectId, revision: (rows.at(-1)?.revision ?? 0) + 1, request })) return request;
    }
    throw new Error('preview access request contention');
  }
}

export function resolvePreviewClientSettings(branchEnv: Record<string, string>, preview: Pick<PreviewAccessClient, 'origin'>, parentUrl: string) {
  const id = branchEnv.CDS_PREVIEW_SSO_CLIENT_ID, secret = branchEnv.CDS_PREVIEW_SSO_CLIENT_SECRET;
  let parent: URL;
  try { parent = new URL(parentUrl); } catch { return undefined; }
  if (!id || !clientIdPattern.test(id) || !secret || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)
    || !/^(?:1|true|yes|on)$/i.test(branchEnv.CDS_PREVIEW_SSO_ENABLED ?? '') || branchEnv.CDS_PREVIEW_SSO_PROVIDER_ID !== 'cds-preview'
    || branchEnv.CDS_PREVIEW_PUBLIC_BASE_URL?.replace(/\/$/, '') !== preview.origin || parent.origin === preview.origin
    || branchEnv.CDS_PREVIEW_SSO_AUTHORIZATION_URL !== new URL('/preview/authorize', parent).href
    || branchEnv.CDS_PREVIEW_SSO_TOKEN_URL !== new URL('/api/auth/preview/token', parent).href) return undefined;
  return { id, secret, callback: new URL('/auth/sso', preview.origin).href };
}
