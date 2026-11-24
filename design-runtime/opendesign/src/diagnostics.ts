// 搬迁自 cds/src/services/agent-workspace-session-runtime.ts（第 1 阶段：只改归属、不改行为）。
// 第 4 阶段删除 CDS 旧实现之前，两边的判据必须保持逐字一致；改这里要同步改那边，反之亦然。
import { AgentWorkspaceRuntimeError } from './errors.js';
import { maskSecrets } from './secret-masker.js';

const MAX_RUNTIME_DIAGNOSTIC_BYTES = 2 * 1024;

export function runtimeDiagnosticPreview(value: string, excludedValues: string[]): string {
  let safe = value.replaceAll('\0', '');
  for (const excluded of excludedValues) {
    if (excluded) safe = safe.split(excluded).join('***[masked]***');
  }
  safe = maskSecrets(safe, { mask: true });
  const bytes = Buffer.from(safe, 'utf8');
  if (bytes.length <= MAX_RUNTIME_DIAGNOSTIC_BYTES) return safe;

  const suffix = `\n[cds runtime diagnostic truncated: original ${bytes.length} bytes]`;
  const textBudget = Math.max(0, MAX_RUNTIME_DIAGNOSTIC_BYTES - Buffer.byteLength(suffix, 'utf8'));
  let preview = bytes.subarray(0, textBudget).toString('utf8');
  while (Buffer.byteLength(preview, 'utf8') > textBudget) preview = preview.slice(0, -1);
  return `${preview}${suffix}`;
}

/**
 * 把 OpenDesign 的 SSE 事件流（`id:` / `event:` / `data:` 帧）压成一份有界摘要：
 * 各类事件计数、agent 事件的类型计数、用到的工具名与它们碰过的路径、最后一段模型文本、
 * 错误信息、stdout/stderr 尾巴。只做统计与截尾，不做判断——判断留给读的人。
 */
/**
 * 对摘要里的每个字符串叶子做脱敏与截断，结构原样保留。不做 JSON 往返：
 * 截断会切在字符串中间、脱敏会改字节，再 parse 必炸——第一版就是这么把真失败顶替掉的。
 */
export function redactDigestLeaves(value: unknown, secrets: Array<string | undefined>, depth = 0): unknown {
  const excluded = secrets.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return runtimeDiagnosticPreview(value, excluded).slice(0, 1_500);
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => redactDigestLeaves(item, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[key.slice(0, 80)] = redactDigestLeaves(item, secrets, depth + 1);
    }
    return out;
  }
  return value;
}

export function summarizeRunEventStream(raw: string): Record<string, unknown> {
  const records: Array<{ event: string; data: unknown }> = [];
  for (const frame of raw.split(/\n\n+/)) {
    let event = '';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (!event || dataLines.length === 0) continue;
    try {
      records.push({ event, data: JSON.parse(dataLines.join('\n')) });
    } catch {
      records.push({ event, data: { unparsed: dataLines.join('\n').slice(0, 200) } });
    }
  }
  const eventCounts: Record<string, number> = {};
  const agentTypeCounts: Record<string, number> = {};
  const toolNames: Record<string, number> = {};
  const touchedPaths = new Set<string>();
  const errors: string[] = [];
  let textTail = '';
  let stdoutTail = '';
  let stderrTail = '';
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  for (const { event, data } of records) {
    eventCounts[event] = (eventCounts[event] || 0) + 1;
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    if (event === 'agent') {
      const type = str(record.type) || 'unknown';
      agentTypeCounts[type] = (agentTypeCounts[type] || 0) + 1;
      if (type === 'text_delta') textTail = (textTail + str(record.delta)).slice(-1_200);
      if (type === 'tool_use' || type === 'tool_result' || type === 'artifact') {
        const name = str(record.name) || str(record.tool) || str(record.toolName) || type;
        toolNames[name] = (toolNames[name] || 0) + 1;
        const input = record.input && typeof record.input === 'object' ? (record.input as Record<string, unknown>) : {};
        for (const candidate of [record.path, input.file_path, input.path, input.filePath]) {
          const value = str(candidate);
          if (value) touchedPaths.add(value.slice(0, 200));
        }
      }
      if (type === 'error') errors.push(str(record.message).slice(0, 300));
    } else if (event === 'error') {
      errors.push((str(record.message) || str(record.error) || JSON.stringify(record)).slice(0, 300));
    } else if (event === 'stdout') {
      stdoutTail = (stdoutTail + str(record.chunk)).slice(-600);
    } else if (event === 'stderr') {
      stderrTail = (stderrTail + str(record.chunk)).slice(-600);
    }
  }
  return {
    eventCount: records.length,
    eventCounts,
    agentTypeCounts,
    toolNames,
    touchedPaths: [...touchedPaths].slice(0, 30),
    errors: errors.slice(0, 10),
    textTail,
    stdoutTail,
    stderrTail,
  };
}

/**
 * 输出预检兜底分支的诊断摘要。诊断是预检容器的 stdout+stderr，可能很长、可能带凭据，
 * 也可能整个是空的（进程被超时杀掉时就什么都没有）。三条规矩：
 * 压成一行、有界截断、空的时候明说空，不拿一句像模像样的话去顶替「不知道」。
 */
export function summarizeOutputPreflightDiagnostic(diagnostic: string): string {
  const flattened = diagnostic.replace(/\s+/g, ' ').trim();
  if (!flattened) return 'the preflight produced no diagnostic output (it was most likely killed by the 30s timeout)';
  const limit = 400;
  // 报错通常写在最后，截尾比截头有用。
  return flattened.length <= limit ? flattened : `...${flattened.slice(-limit)}`;
}

// ---- 以下搬迁自 cds/src/routes/remote-hosts.ts（toAgentWorkspaceRuntimeError / sanitizeAgentWorkspaceRuntimeError /
// redactAgentRuntimeValue）：错误事件出服务之前统一脱敏，本次任务的两张票据逐字遮掉，
// 字段名像凭据的一律遮掉，Bearer 与 key=value 形态的凭据一律遮掉。

export interface SanitizedRuntimeError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

const AGENT_CREDENTIAL_FIELD_PATTERN = /(authorization|api[-_]?key|token|secret|password|credential)/i;

function redactAgentRuntimeValue(value: unknown, secrets: string[], key = '', depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (AGENT_CREDENTIAL_FIELD_PATTERN.test(key)) return '***[masked]***';
  if (typeof value === 'string') {
    let redacted = secrets.reduce(
      (current, secret) => current.split(secret).join('***[masked]***'),
      value,
    );
    redacted = redacted.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer ***[masked]***');
    redacted = redacted.replace(
      /((?:authorization|api[-_]?key|token|secret|password|credential)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1***[masked]***',
    );
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactAgentRuntimeValue(entry, secrets, '', depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactAgentRuntimeValue(entryValue, secrets, entryKey, depth + 1),
      ]),
    );
  }
  return value;
}

export function sanitizeRuntimeError(
  error: unknown,
  credentials: Array<string | null | undefined>,
): SanitizedRuntimeError {
  const runtimeError: SanitizedRuntimeError = error instanceof AgentWorkspaceRuntimeError
    ? {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details ? { details: error.details } : {}),
      }
    : {
        code: 'agent_workspace_runtime_failed',
        message: error instanceof Error ? error.message : 'Agent workspace runtime failed',
        retryable: false,
      };
  const secrets = credentials
    .filter((credential): credential is string => typeof credential === 'string' && credential.length > 0)
    .sort((left, right) => right.length - left.length);
  return redactAgentRuntimeValue(runtimeError, secrets) as SanitizedRuntimeError;
}
