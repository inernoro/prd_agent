/** Finite, refresh-safe task context. Never carries arbitrary return URLs or request bodies. */
export const LOG_FILTER_KEYS = ['model', 'status', 'provider', 'appCallerCode', 'transport', 'requestType', 'operation', 'sourceSystem', 'ingressProtocol', 'modelPolicy', 'releaseCommit', 'runId', 'requestId', 'sessionId', 'modelPoolId', 'serviceKeyId', 'clientCode', 'environment', 'platformId'] as const;
const CONTEXT_KEYS = ['source', 'range', 'from', 'to', 'liveList', 'view', ...LOG_FILTER_KEYS, 'selectedLogId', 'traceReference', 'traceAnchor', 'tracePage'] as const;
export type LogTaskContext = Partial<Record<typeof CONTEXT_KEYS[number], string>>;
function clean(input: URLSearchParams): LogTaskContext {
  const result: LogTaskContext = {};
  for (const key of CONTEXT_KEYS) {
    const value = input.get(key);
    if (value && value.length <= 256 && !/[\u0000-\u001f]/.test(value)) result[key] = value;
  }
  if (result.source !== 'overview' && result.source !== 'logs') delete result.source;
  if (result.range && !['1d', '7d', '30d'].includes(result.range)) delete result.range;
  for (const key of ['from', 'to'] as const) if (result[key] && !Number.isFinite(Date.parse(result[key]!))) delete result[key];
  if (result.liveList !== '1' || !result.from || !result.to) delete result.liveList;
  if (result.view && !['physical', 'sessions'].includes(result.view)) delete result.view;
  if (result.tracePage && !/^[1-9]\d{0,4}$/.test(result.tracePage)) delete result.tracePage;
  return result;
}
export function getLogTaskContext(search: string): LogTaskContext {
  const query = new URLSearchParams(search);
  const raw = query.get('context');
  if (raw) return raw.length <= 8192 ? clean(new URLSearchParams(raw)) : {};
  return { ...clean(query), source: 'logs', selectedLogId: query.get('transaction') || query.get('anchor') || undefined };
}
export function buildLogListHref(context: LogTaskContext = {}, selectedId?: string): string {
  const safe = clean(new URLSearchParams(Object.entries(context).filter(([, value]) => !!value) as [string, string][]));
  const query = new URLSearchParams();
  for (const key of ['range', 'view', ...LOG_FILTER_KEYS] as const) if (safe[key]) query.set(key, safe[key]!);
  if (!safe.liveList || selectedId || safe.selectedLogId) {
    for (const key of ['from', 'to', 'liveList'] as const) if (safe[key]) query.set(key, safe[key]!);
  }
  if (selectedId) query.set('transaction', selectedId);
  if (safe.selectedLogId) query.set('anchor', safe.selectedLogId);
  return `/logs${query.size ? `?${query}` : ''}`;
}
function withContext(path: string, query: URLSearchParams, context: LogTaskContext): string {
  const safe = clean(new URLSearchParams(Object.entries(context).filter(([, value]) => !!value) as [string, string][]));
  if (Object.keys(safe).length) query.set('context', new URLSearchParams(safe as Record<string, string>).toString());
  return `${path}${query.size ? `?${query}` : ''}`;
}
/** Entity destinations carry the same finite task state; never an arbitrary return URL. */
export function withLogTaskContext(path: '/app-callers/view' | '/models/view' | '/platforms/view', query: URLSearchParams, context: LogTaskContext): string {
  if (!['/app-callers/view', '/models/view', '/platforms/view'].includes(path)) throw new Error('Unsupported log task destination');
  return withContext(path, new URLSearchParams(query), context);
}
/** A precise external request lookup opens one task entry; manual list drill-down keeps history. */
export function buildLogRequestHref(requestId: string, options: { view?: 'physical'; context?: LogTaskContext } = {}): string {
  const value = requestId.trim();
  if (!value || value.length > 256 || /[\u0000-\u001f]/.test(value)) return '/logs';
  const query = new URLSearchParams({ requestId: value, openRequest: '1' });
  if (options.view) query.set('view', options.view);
  return withContext('/logs', query, options.context || {});
}
export function buildLogDetailHref(id: string, context: LogTaskContext = {}): string {
  return withContext(`/logs/${encodeURIComponent(id)}`, new URLSearchParams(), context);
}
export function buildLogTraceHref(reference: string, context: LogTaskContext = {}, anchorId?: string, page = 1): string {
  const query = new URLSearchParams({ reference });
  if (anchorId) query.set('anchorId', anchorId);
  if (page > 1) query.set('page', String(page));
  return withContext('/logs/trace', query, context);
}
export function getLogReturnTarget(context: LogTaskContext): { href: string; label: string } {
  if (context.traceReference) return { href: buildLogTraceHref(context.traceReference, { ...context, traceReference: undefined, traceAnchor: undefined, tracePage: undefined }, context.traceAnchor, Number(context.tracePage || 1)), label: '返回调用链' };
  if (context.source === 'overview') {
    const query = new URLSearchParams();
    for (const key of ['range', 'from', 'to'] as const) if (context[key]) query.set(key, context[key]!);
    return { href: `/${query.size ? `?${query}` : ''}`, label: '返回概览' };
  }
  return { href: buildLogListHref(context), label: '返回请求记录' };
}
