import { randomBytes } from 'node:crypto';
import type { CdsSsoConfig } from '../types.js';
import type { StateService } from './state.js';

const STATE_TTL_MS = 5 * 60 * 1000;
const STATE_STORE_MAX_ENTRIES = 1024;
const STATE_STORE_GC_INTERVAL_MS = 30 * 1000;
const DEFAULT_REDIRECT = '/project-list';
const DEFAULT_TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
const SSO_ENV_KEYS = [
  'CDS_SSO_ENABLED',
  'CDS_SSO_PROVIDER_ID',
  'CDS_SSO_LABEL',
  'CDS_SSO_AUTHORIZATION_URL',
  'CDS_SSO_TOKEN_URL',
  'CDS_SSO_CLIENT_ID',
  'CDS_SSO_CLIENT_SECRET',
  'CDS_SSO_DEFAULT_REDIRECT',
] as const;

export interface TicketSsoIdentity {
  subject: string;
  username: string;
  displayName: string;
  email?: string | null;
}

export interface PublicTicketSsoConfig {
  enabled: boolean;
  providerId: string;
  label: string;
}

interface TicketSsoTokenResponse {
  success?: boolean;
  data?: Partial<TicketSsoIdentity>;
  error?: { message?: string };
}

export class TicketSsoExchangeError extends Error {
  constructor(
    public readonly reason: 'timeout' | 'unavailable',
    cause?: unknown,
  ) {
    super(reason === 'timeout' ? 'SSO_PROVIDER_TIMEOUT' : 'SSO_PROVIDER_UNAVAILABLE', { cause });
    this.name = 'TicketSsoExchangeError';
  }
}

function cleanInternalRedirect(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_REDIRECT;
  const candidate = value.trim();
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return DEFAULT_REDIRECT;
  if (candidate.split(/[?#]/)[0] === '/login' || candidate.split(/[?#]/)[0] === '/auth/sso') {
    return DEFAULT_REDIRECT;
  }
  return candidate;
}

function cleanAbsoluteHttpsUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value.trim());
    const isLocalHttp = url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.protocol !== 'https:' && !isLocalHttp) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

export function normalizeTicketSsoConfig(input: Partial<CdsSsoConfig> | null | undefined): CdsSsoConfig {
  return {
    enabled: input?.enabled === true,
    providerId: String(input?.providerId || 'ticket-sso').trim().slice(0, 64) || 'ticket-sso',
    label: String(input?.label || '使用 SSO 登录').trim().slice(0, 80) || '使用 SSO 登录',
    authorizationUrl: cleanAbsoluteHttpsUrl(input?.authorizationUrl),
    tokenUrl: cleanAbsoluteHttpsUrl(input?.tokenUrl),
    clientId: String(input?.clientId || '').trim().slice(0, 160),
    clientSecret: typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : '',
    defaultRedirect: cleanInternalRedirect(input?.defaultRedirect),
  };
}

export function resolveTicketSsoConfig(stateService: StateService, env: NodeJS.ProcessEnv = process.env): CdsSsoConfig {
  const stored = stateService.getSsoConfig();
  const fromEnv: Partial<CdsSsoConfig> = {
    ...(env.CDS_SSO_ENABLED !== undefined
      ? { enabled: /^(1|true|yes|on)$/i.test(env.CDS_SSO_ENABLED) }
      : {}),
    ...(env.CDS_SSO_PROVIDER_ID !== undefined ? { providerId: env.CDS_SSO_PROVIDER_ID } : {}),
    ...(env.CDS_SSO_LABEL !== undefined ? { label: env.CDS_SSO_LABEL } : {}),
    ...(env.CDS_SSO_AUTHORIZATION_URL !== undefined
      ? { authorizationUrl: env.CDS_SSO_AUTHORIZATION_URL }
      : {}),
    ...(env.CDS_SSO_TOKEN_URL !== undefined ? { tokenUrl: env.CDS_SSO_TOKEN_URL } : {}),
    ...(env.CDS_SSO_CLIENT_ID !== undefined ? { clientId: env.CDS_SSO_CLIENT_ID } : {}),
    ...(env.CDS_SSO_CLIENT_SECRET !== undefined ? { clientSecret: env.CDS_SSO_CLIENT_SECRET } : {}),
    ...(env.CDS_SSO_DEFAULT_REDIRECT !== undefined
      ? { defaultRedirect: env.CDS_SSO_DEFAULT_REDIRECT }
      : {}),
  };
  const hasEnvConfig = Object.keys(fromEnv).length > 0;
  return normalizeTicketSsoConfig(hasEnvConfig ? { ...stored, ...fromEnv } : stored);
}

export function isTicketSsoEnvironmentManaged(env: NodeJS.ProcessEnv = process.env): boolean {
  return SSO_ENV_KEYS.some((key) => env[key] !== undefined);
}

export function publicTicketSsoConfig(config: CdsSsoConfig): PublicTicketSsoConfig {
  const configured = Boolean(
    config.enabled
    && config.authorizationUrl
    && config.tokenUrl
    && config.clientId
    && config.clientSecret,
  );
  return {
    enabled: configured,
    providerId: config.providerId,
    label: config.label,
  };
}

export class TicketSsoStateStore {
  private readonly states = new Map<string, {
    redirect: string | null;
    callbackUrl: string;
    createdAt: number;
  }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly gcIntervalMs: number;
  private readonly now: () => number;
  private nextGcAt = 0;

  constructor(options: {
    ttlMs?: number;
    maxEntries?: number;
    gcIntervalMs?: number;
    now?: () => number;
  } = {}) {
    this.ttlMs = Math.max(1, options.ttlMs ?? STATE_TTL_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? STATE_STORE_MAX_ENTRIES);
    this.gcIntervalMs = Math.max(1, options.gcIntervalMs ?? STATE_STORE_GC_INTERVAL_MS);
    this.now = options.now ?? Date.now;
  }

  issue(redirect: unknown, callbackUrl = ''): { state: string; redirect: string | null } {
    const now = this.now();
    this.gcIfDue(now);
    while (this.states.size >= this.maxEntries) {
      const oldest = this.states.keys().next().value as string | undefined;
      if (!oldest) break;
      this.states.delete(oldest);
    }
    const state = randomBytes(32).toString('base64url');
    const safeRedirect = redirect === undefined || redirect === null || redirect === ''
      ? null
      : cleanInternalRedirect(redirect);
    this.states.set(state, { redirect: safeRedirect, callbackUrl, createdAt: now });
    return { state, redirect: safeRedirect };
  }

  consume(state: unknown): { redirect: string | null; callbackUrl: string } | null {
    if (typeof state !== 'string') return null;
    const now = this.now();
    this.gcIfDue(now);
    const entry = this.states.get(state);
    if (!entry) return null;
    this.states.delete(state);
    if (now - entry.createdAt > this.ttlMs) return null;
    return { redirect: entry.redirect, callbackUrl: entry.callbackUrl };
  }

  private gcIfDue(now: number): void {
    if (now < this.nextGcAt) return;
    this.nextGcAt = now + this.gcIntervalMs;
    for (const [state, entry] of this.states) {
      if (now - entry.createdAt > this.ttlMs) this.states.delete(state);
    }
  }
}

export class TicketSsoSessionStore {
  private readonly sessions = new Map<string, {
    identity: TicketSsoIdentity;
    expiresAt: number;
  }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 12 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  create(identity: TicketSsoIdentity): { token: string; expiresAt: Date } {
    this.gc();
    const token = randomBytes(48).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.sessions.set(token, { identity, expiresAt });
    return { token, expiresAt: new Date(expiresAt) };
  }

  get(token: string | null | undefined): TicketSsoIdentity | null {
    this.gc();
    if (!token) return null;
    const session = this.sessions.get(token);
    return session?.identity || null;
  }

  delete(token: string | null | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private gc(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

export function buildTicketSsoAuthorizationUrl(
  config: CdsSsoConfig,
  callbackUrl: string,
  state: string,
): string {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', callbackUrl);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeTicketSsoCode(
  config: CdsSsoConfig,
  code: unknown,
  callbackUrl: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DEFAULT_TOKEN_EXCHANGE_TIMEOUT_MS,
): Promise<TicketSsoIdentity> {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(code)) {
    throw new Error('SSO_CODE_INVALID');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  let response: Response;
  let payload: TicketSsoTokenResponse | null = null;
  try {
    response = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:cds:params:oauth:grant-type:ticket',
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: callbackUrl,
      }),
      signal: controller.signal,
    });
    try {
      payload = await response.json() as TicketSsoTokenResponse;
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new TicketSsoExchangeError('timeout', error);
      }
    }
  } catch (error) {
    if (error instanceof TicketSsoExchangeError) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new TicketSsoExchangeError('timeout', error);
    }
    throw new TicketSsoExchangeError('unavailable', error);
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 408 || response.status === 504) {
    throw new TicketSsoExchangeError('timeout');
  }
  if (response.status === 429 || response.status >= 500 || (response.ok && payload === null)) {
    throw new TicketSsoExchangeError('unavailable');
  }
  if (!response.ok || payload?.success !== true || !payload.data) {
    throw new Error(payload?.error?.message || `SSO_TOKEN_EXCHANGE_${response.status}`);
  }
  const subject = String(payload.data.subject || '').trim();
  const username = String(payload.data.username || '').trim();
  const displayName = String(payload.data.displayName || username).trim();
  if (!subject || !username) throw new Error('SSO_IDENTITY_INVALID');
  return {
    subject: subject.slice(0, 256),
    username: username.slice(0, 128),
    displayName: displayName.slice(0, 160),
    email: typeof payload.data.email === 'string' ? payload.data.email.slice(0, 320) : null,
  };
}
