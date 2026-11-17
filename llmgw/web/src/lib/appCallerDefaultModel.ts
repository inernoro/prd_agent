import type { LogicalModelItem } from './types';

/** Match the enabled/type/identity order used by ModelResolver; this is configuration, not a health probe. */
export function appCallerDefaultModel(models: LogicalModelItem[], caller: string, requestType: string) {
  const candidates = models.filter(model => model.enabled && model.modelType === requestType)
    .sort((a, b) => a.displayOrder - b.displayOrder || a.publicId.localeCompare(b.publicId));
  const selected = candidates.find(model => model.defaultForAppCallerCodes.some(code => code.toLowerCase() === caller.toLowerCase()));
  const model = selected ?? candidates.find(model => model.isDefaultForType);
  const allowed = !model || model.allowedAppCallerCodes.length === 0 || model.allowedAppCallerCodes.some(code => code.toLowerCase() === caller.toLowerCase());
  return { model, source: selected ? 'caller' as const : 'type' as const, allowed };
}

const callerReturnKeys = ['page', 'search', 'status', 'sourceSystem', 'ingressProtocol', 'requestType', 'drift', 'modelPoolId'];
export function callerModelWorkspaceHref(caller: string, requestType: string, returnSearch = '') {
  const params = new URLSearchParams({ caller, requestType });
  const source = new URLSearchParams(returnSearch);
  const safe = new URLSearchParams();
  for (const key of callerReturnKeys) if (source.has(key)) safe.set(key, source.get(key)!);
  if (safe.size) params.set('callerReturn', safe.toString());
  return `/logical-models?${params}`;
}
export function callerWorkspaceReturnHref(caller: string, requestType: string, raw: string) {
  const params = new URLSearchParams({ focus: caller, focusType: requestType });
  const source = new URLSearchParams(raw);
  for (const key of callerReturnKeys) if (source.has(key)) params.set(key, source.get(key)!);
  return `/app-callers?${params}`;
}
