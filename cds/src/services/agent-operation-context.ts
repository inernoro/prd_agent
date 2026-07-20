import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { maskSecrets } from './secret-masker.js';
import type { AgentOperatorIdentitySummary } from '../types.js';

type HeaderValue = string | string[] | undefined;

interface RequestLike {
  headers?: Record<string, HeaderValue>;
  cdsRequestId?: string;
  cdsOperationId?: string;
  cdsAgentIdentity?: AgentOperatorIdentitySummary;
  res?: {
    headersSent?: boolean;
    setHeader?: (name: string, value: string) => unknown;
  };
}

export interface AgentOperationContext {
  requestId: string;
  operationId: string;
  identity: AgentOperatorIdentitySummary;
}

const storage = new AsyncLocalStorage<AgentOperationContext>();
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

const HEADER_FIELDS = {
  agentSessionId: { header: 'x-cds-agent-session-id', max: 128, pattern: SAFE_ID },
  threadId: { header: 'x-codex-thread-id', max: 128, pattern: SAFE_ID },
  turnId: { header: 'x-codex-turn-id', max: 128, pattern: SAFE_ID },
  skillName: { header: 'x-cds-skill-name', max: 80, pattern: SAFE_ID },
  skillVersion: { header: 'x-cds-skill-version', max: 40, pattern: SAFE_VERSION },
} as const;

function firstHeader(headers: Record<string, HeaderValue>, name: string): string | undefined {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function validIdentifier(value: string | undefined, max: number, pattern: RegExp): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > max || CONTROL_CHAR.test(normalized) || !pattern.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function validReason(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 300 || CONTROL_CHAR.test(normalized)) return undefined;
  return maskSecrets(normalized, { mask: true });
}

export function parseAgentOperatorIdentity(headers: Record<string, HeaderValue> = {}): AgentOperatorIdentitySummary {
  const declared: Partial<Record<keyof typeof HEADER_FIELDS, string>> = {};
  const invalidFields: string[] = [];

  for (const [field, config] of Object.entries(HEADER_FIELDS) as Array<
    [keyof typeof HEADER_FIELDS, (typeof HEADER_FIELDS)[keyof typeof HEADER_FIELDS]]
  >) {
    const raw = firstHeader(headers, config.header);
    if (raw === undefined) continue;
    const value = validIdentifier(raw, config.max, config.pattern);
    if (value) declared[field] = value;
    else invalidFields.push(field);
  }

  const rawReason = firstHeader(headers, 'x-cds-operation-reason');
  const operationReason = validReason(rawReason);
  if (rawReason !== undefined && !operationReason) invalidFields.push('operationReason');

  const hasDeclaration = Object.keys(declared).length > 0 || operationReason !== undefined;
  return {
    identityVersion: hasDeclaration ? 1 : 0,
    confidence: hasDeclaration ? 'declared' : 'legacy',
    ...declared,
    operationReason,
    invalidFields: invalidFields.length > 0 ? invalidFields : undefined,
  };
}

function correlationId(value: string | undefined, prefix: 'req' | 'op'): string {
  return validIdentifier(value, 128, SAFE_ID) || `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function establishAgentOperationContext(req: unknown): AgentOperationContext {
  const request = (req && typeof req === 'object' ? req : {}) as RequestLike;
  const existingIdentity = request.cdsAgentIdentity;
  const existingOperationId = request.cdsOperationId;
  const requestId = correlationId(
    request.cdsRequestId || firstHeader(request.headers || {}, 'x-cds-request-id'),
    'req',
  );
  // The service owns operation identifiers. A caller-provided header must not
  // turn a legacy or merely declared identity into trusted audit correlation.
  const operationId = correlationId(existingOperationId, 'op');
  const identity = existingIdentity || parseAgentOperatorIdentity(request.headers || {});
  const context = { requestId, operationId, identity };

  request.cdsRequestId = requestId;
  request.cdsOperationId = operationId;
  request.cdsAgentIdentity = identity;
  // Some long-running branch workflows resolve the actor again after SSE has
  // already flushed headers. Keep correlation in context without throwing.
  if (request.res && !request.res.headersSent) {
    request.res.setHeader?.('X-CDS-Request-Id', requestId);
    request.res.setHeader?.('X-CDS-Operation-Id', operationId);
  }

  // Express 的 mutation audit 在调用 resolveActorFromRequest 后同步 next()；
  // 后续 route、finish listener 与后台 Promise 会继承这条 async chain。
  if (request.res) storage.enterWith(context);
  return context;
}

export function getAgentOperationContext(): AgentOperationContext | undefined {
  return storage.getStore();
}

export function runWithAgentOperationContext<T>(context: AgentOperationContext, callback: () => T): T {
  return storage.run(context, callback);
}
