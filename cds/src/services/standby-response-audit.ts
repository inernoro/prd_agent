import { randomUUID, createHash } from 'node:crypto';
import { isSensitiveKey, maskSecrets } from './secret-masker.js';
import type { ServerEventLogSink } from './server-event-log-store.js';

const SNAPSHOT_BYTES = 4096;
const SAFE_TEXT_KEYS = /^(code|message|reason|error|status|type|detail|event)$/i;
const SAFE_FIELD_NAMES = /^(code|message|reason|error|status|type|detail|details|event|ok|success|data|branch|branches|protocolVersion|capabilities|configHash|secretKeyHash|repository|defaultBranch|id|name|projectId|commitSha|githubCommitSha)$/i;
const PRIVATE_KEYS = /password|token|cookie|authorization|secret|credential|signature|email|phone|document|prompt|content|payload|body/i;

function safeText(value: string, secrets: string[]): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return maskSecrets(text, { mask: true })
    .replace(/\b(password|token|secret|api[_ -]?key|cookie)\s*(?:is|:|=)\s*["']?[^\s,"';]+/gi, '$1=[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b\+?\d[\d ()-]{8,}\d\b/g, '[phone]')
    .replace(/([?&](?:[^=\s]*(?:key|token|secret|password|signature)[^=\s]*)=)[^&\s]+/gi, '$1[redacted]');
}

function safeValue(value: unknown, secrets: string[], key = '', depth = 0, limits = { truncated: false }): unknown {
  if (PRIVATE_KEYS.test(key) || isSensitiveKey(key)) return '[redacted]';
  if (depth > 6) { limits.truncated = true; return '[depth omitted]'; }
  if (typeof value === 'string') {
    if (/^(commitSha|githubCommitSha|configHash)$/i.test(key) && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) {
      return secrets.includes(value) ? '[redacted]' : value;
    }
    if (/^(id|name|projectId)$/i.test(key)) {
      const identifier = safeText(value, secrets);
      return /^[a-z0-9_./:-]{1,128}$/i.test(identifier) ? identifier : '[identifier omitted]';
    }
    if (!SAFE_TEXT_KEYS.test(key)) return '[text omitted]';
    const text = safeText(value, secrets); if (text.length > 1024) limits.truncated = true;
    return text.slice(0, 1024);
  }
  if (Array.isArray(value)) { if (value.length > 20) limits.truncated = true; return value.slice(0, 20).map(item => safeValue(item, secrets, key, depth + 1, limits)); }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => Number(SAFE_TEXT_KEYS.test(b)) - Number(SAFE_TEXT_KEYS.test(a)));
    if (entries.length > 40) limits.truncated = true;
    return Object.fromEntries(entries.slice(0, 40).map(([name, item], index) => [SAFE_FIELD_NAMES.test(name) ? name : `other-field-${index}`, safeValue(item, secrets, name, depth + 1, limits)]));
  }
  return value === null || SAFE_TEXT_KEYS.test(key) || /^(ok|success|protocolVersion|secretKeyCount)$/i.test(key) ? value : '[value omitted]';
}

export interface StandbyResponseFacts {
  peerId: string;
  url: string;
  method: string;
  startedAt: string;
  durationMs: number;
  timeoutMs: number;
  responseReceived: boolean;
  httpStatus: number | null;
  contentType: string | null;
  upstreamRequestId: string | null;
  text?: string;
  json?: unknown;
  parseState: string;
  localDecision: string;
  error?: string;
  secrets: string[];
}

/** Existing project-scoped event store and its retention/query path; no new public log store. */
export function createStandbyResponseAudit(sink: ServerEventLogSink | null | undefined, scope: {
  projectId: string; remoteProjectId: string; policy: string; dryRun: boolean; configUpdatedAt?: string;
}) {
  const operationId = randomUUID();
  let attempt = 0;
  return {
    operationId,
    remoteProjectId: scope.remoteProjectId,
    assertAvailable() {
      if (!sink?.recordImmediate || !sink.findRecent) throw new Error('备用站持久响应审计不可用，未发出本次远端请求');
    },
    async record(facts: StandbyResponseFacts) {
      if (!sink?.recordImmediate || !sink.findRecent) throw new Error('备用站持久响应审计不可用');
      const requestId = `${operationId}:${++attempt}`;
      let target = '[invalid peer URL omitted]';
      try { const url = new URL(facts.url); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; target = url.toString(); }
      catch { /* A malformed request still needs a durable no-response record. */ }
      const text = facts.text ?? '';
      const limits = { truncated: false };
      let snapshot: string;
      if (facts.parseState === 'json' || facts.parseState === 'invalid-fingerprint') snapshot = JSON.stringify(safeValue(facts.json, facts.secrets, '', 0, limits));
      else if (facts.parseState === 'sse') {
        const terminal: string[] = []; let event = '', omitted = 0, omittedTerminal = 0;
        for (const line of text.split('\n')) {
          if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
          if (!line.startsWith('data:')) continue;
          if (!['error', 'complete', 'done'].includes(event)) { omitted++; continue; }
          let data: string;
          try { data = JSON.stringify(safeValue(JSON.parse(line.slice(5)), facts.secrets, '', 0, limits)); }
          catch { data = '[unparseable omitted]'; }
          const dataBytes = Buffer.from(data);
          if (dataBytes.length > 1536) { limits.truncated = true; data = dataBytes.subarray(0, 1536).toString('utf8').replace(/\uFFFD$/, ''); }
          terminal.push(`event: ${event}\ndata: ${data}`);
          if (terminal.length > 2) { terminal.shift(); omittedTerminal++; limits.truncated = true; }
        }
        snapshot = `non-terminal messages omitted: ${omitted}; older terminal messages omitted: ${omittedTerminal}\n${terminal.join('\n')}`;
      }
      else snapshot = text ? '[unstructured response omitted; status, content type, bytes and hash retained]' : '';
      const bytes = Buffer.from(snapshot);
      const truncated = limits.truncated || bytes.length > SNAPSHOT_BYTES || Buffer.byteLength(text) > SNAPSHOT_BYTES;
      const upstreamRequestId = facts.upstreamRequestId ? safeText(facts.upstreamRequestId, facts.secrets) : '';
      const mediaType = facts.contentType?.split(';')[0].trim() || '';
      const details = {
        ...scope, attempt, method: facts.method, target, peerId: facts.peerId,
        startedAt: facts.startedAt, endedAt: new Date().toISOString(), durationMs: facts.durationMs,
        timeoutMs: facts.timeoutMs, snapshotLimitBytes: SNAPSHOT_BYTES,
        responseReceived: facts.responseReceived, httpStatus: facts.httpStatus, contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mediaType) ? mediaType : null,
        upstreamRequestId: /^[a-z0-9_.:-]{1,128}$/i.test(upstreamRequestId) ? upstreamRequestId : null,
        originalBytes: facts.text === undefined ? null : Buffer.byteLength(text),
        snapshot: bytes.subarray(0, SNAPSHOT_BYTES).toString('utf8').replace(/\uFFFD$/, ''), truncated,
        omissionReason: facts.parseState === 'body-read-failed' ? 'response body interrupted before complete read; partial body not retained'
          : truncated ? 'bounded redacted snapshot; large/unknown text fields omitted' : 'credentials, personal and non-diagnostic text omitted',
        parseState: facts.parseState, localDecision: facts.localDecision,
        responseSha256: text ? createHash('sha256').update(text).digest('hex') : null,
        error: facts.error ? safeText(facts.error, facts.secrets).slice(0, 512) : null,
      };
      try {
        await sink.recordImmediate({ category: 'system', severity: facts.localDecision === 'success' ? 'info' : 'warn',
          source: 'standby-response-audit', action: 'standby.peer.response', message: '备用站远端响应证据',
          projectId: scope.projectId, requestId, operationId, details });
        // Some optional sinks silently no-op before initialization; never attest persistence then.
        const saved = await sink.findRecent({ projectId: scope.projectId, requestId, limit: 1 });
        if (!saved.some(row => row.requestId === requestId && row.projectId === scope.projectId)) throw new Error('审计回读未找到记录');
      } catch {
        throw new Error('备用站响应审计持久化失败；远端结果可能已产生，禁止自动重试，请核对本次现场');
      }
    },
  };
}

export type StandbyResponseAudit = ReturnType<typeof createStandbyResponseAudit>;
