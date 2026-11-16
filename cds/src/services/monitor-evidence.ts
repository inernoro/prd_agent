import { isSensitiveKey, maskSecrets } from './secret-masker.js';
import type { UptimeSample } from './uptime-metrics.js';
import type { MonitorObservation } from '../types.js';

/** Evidence is a bounded diagnostic excerpt, never a dump of upstream secrets. */
function sensitivePath(path: string): boolean {
  return path.split(/[.\[\]\/\s-]+/).some(key => isSensitiveKey(key) || /^(cookie|setcookie)$/i.test(key)) || /set-cookie/i.test(path);
}
export function diagnosticValue(value: unknown): unknown {
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > 5) return '[层级已截断]';
    if (typeof item === 'string') {
      if (/^\s*[\[{]/.test(item)) { try { return JSON.stringify(walk(JSON.parse(item), depth + 1)); } catch { /* unstructured text */ } }
      // 判据失败说明会拼入原始JSON。只检测敏感键并隐藏整句，不解析自由文本片段。
      if ([...item.matchAll(/"([^"\\]+)"\s*:/g)].some(([, key]) => sensitivePath(key))) return '[含敏感 JSON 字段的非结构化内容已隐藏]';
      return maskSecrets(item, { mask: true }).replace(/https?:\/\/[^\s<>\"']+/gi, url => diagnosticUrl(url)).slice(0, 1024);
    }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
    if (Array.isArray(item)) return item.slice(0, 20).map(child => walk(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).slice(0, 30).map(([key, child]) => [key.slice(0, 100), sensitivePath(key) ? '[已脱敏]' : walk(child, depth + 1)]));
    return undefined;
  };
  const safe = walk(value, 0), serialized = JSON.stringify(safe);
  if (serialized && Buffer.byteLength(serialized) > 4096) return { truncated: true, note: '摘录超过4KB，只展示已脱敏预览', preview: serialized.slice(0, 500) };
  return safe;
}

export function diagnosticUrl(raw: string): string {
  try {
    const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol)) return '[非 HTTP(S) 地址已隐藏]'; url.username = ''; url.password = ''; url.hash = '';
    // Query values may contain opaque credentials or personal identifiers.
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[已脱敏]');
    return maskSecrets(url.href, { mask: true }).slice(0, 1024);
  } catch { return '[地址不可用]'; }
}

function diagnosticText(value: unknown): string {
  const safe = diagnosticValue(value);
  return typeof safe === 'string' ? safe : JSON.stringify(safe) ?? '';
}

export function publicMonitorObservation(observation: MonitorObservation): MonitorObservation {
  let requestBody: string | undefined;
  if (observation.requestBody) {
    try { requestBody = JSON.stringify(diagnosticValue(JSON.parse(observation.requestBody))); }
    catch { requestBody = '[非结构化请求正文未展示]'; }
  }
  let artifact: string | undefined;
  if (observation.artifactUrl) {
    try { const url = new URL(observation.artifactUrl); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search) artifact = diagnosticUrl(url.href); } catch { /* invalid or protected artifact */ }
  }
  return {
    at: observation.at, ok: observation.ok, elapsedMs: observation.elapsedMs,
    code: observation.code, sampleCount: observation.sampleCount,
    err: observation.err ? observation.results.some(result => sensitivePath(result.path)) ? '部分判据涉及敏感字段，请核对脱敏判据结果' : diagnosticText(observation.err) : undefined,
    requestBody,
    results: observation.results.slice(0, 30).map(result => ({ ...result,
      actual: sensitivePath(result.path) ? '[已脱敏]' : result.actual === undefined ? undefined : diagnosticText(result.actual),
      expected: sensitivePath(result.path) ? '[已脱敏]' : result.expected === undefined ? undefined : diagnosticText(result.expected),
      err: result.err === undefined ? undefined : sensitivePath(result.path) ? '[已脱敏]' : diagnosticText(result.err),
    })),
    // Upstream MCP evidence is already a fixed-schema, redacted receipt; do not include tool content.
    upstreamCalls: observation.upstreamCalls?.slice(0, 20).map(call => ({ ...call, endpoint: diagnosticUrl(call.endpoint), snapshot: diagnosticValue(call.snapshot) as Record<string, unknown> | undefined })),
    ...(artifact ? { artifactUrl: artifact } : observation.artifactUrl ? { artifactProtected: true } : {}),
  };
}

/** Public samples contain only the declared diagnostic schema, including sanitized receipts. */
export function publicUptimeSample(sample: UptimeSample): UptimeSample {
  const legacy = (sample as UptimeSample & { observation?: MonitorObservation }).observation;
  const sensitiveFailure = legacy?.results?.some(result => sensitivePath(result.path));
  const exchange = sample.exchange;
  const measurementActual = sample.measurement ? diagnosticValue(sample.measurement.actual) : undefined;
  return {
    t: sample.t, up: sample.up, ms: sample.ms,
    ...(sample.noData === undefined ? {} : { noData: sample.noData }),
    ...(sample.code === undefined ? {} : { code: sample.code }),
    ...(sample.err === undefined ? {} : { err: sensitiveFailure ? '部分判据涉及敏感字段，请核对脱敏观测结果' : diagnosticText(sample.err) }),
    ...(sample.finding === undefined ? {} : { finding: diagnosticText(sample.finding) }),
    ...(sample.measurement ? { measurement: { ...sample.measurement, actual: (measurementActual !== null && typeof measurementActual === 'object' ? JSON.stringify(measurementActual) : measurementActual) as typeof sample.measurement.actual } } : {}),
    ...(exchange ? { exchange: {
      request: { method: /^[A-Z]{3,8}$/.test(exchange.request.method) ? exchange.request.method : '未知', url: diagnosticUrl(exchange.request.url) },
      ...(exchange.response ? { response: {
        status: Number.isFinite(exchange.response.status) ? exchange.response.status : 0,
        contentType: diagnosticText(exchange.response.contentType || '').slice(0, 100),
        ...(exchange.response.excerpt === undefined ? {} : { excerpt: diagnosticValue(exchange.response.excerpt) }),
      } } : {}),
      note: diagnosticText(exchange.note).slice(0, 300),
    } } : {}),
  };
}
