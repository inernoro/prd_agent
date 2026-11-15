import { getLogReturnTarget, getLogTaskContext, withLogTaskContext } from './logNavigation';

type ProviderOrigin = 'upstream-provider' | 'provider-detail';
/** Return pointers are finite task identities, never user-supplied destination URLs. */
export type ProviderCollectionContext = { query: string; filter: string; page: number; focus: string; selected: string; publicQuery: string; publicPage: number; publicFocus: string };
const VIEW_KEYS = ['ownedQuery', 'ownedFilter', 'ownedPage', 'ownedFocus', 'ownedSelected', 'publicQuery', 'publicPage', 'publicFocus'] as const;
function bounded(params: URLSearchParams, key: string) { const value = params.get(key) || ''; return value.length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : ''; }
function pageNumber(value: string) { return /^[1-9]\d{0,4}$/.test(value) ? Number(value) : 1; }
export function providerCollectionContext(params: URLSearchParams): ProviderCollectionContext {
  const filter = bounded(params, 'ownedFilter');
  return { query: bounded(params, 'ownedQuery'), filter: ['registered', 'unregistered'].includes(filter) ? filter : '', page: pageNumber(params.get('ownedPage') || ''), focus: bounded(params, 'ownedFocus'), selected: bounded(params, 'ownedSelected'), publicQuery: bounded(params, 'publicQuery'), publicPage: pageNumber(params.get('publicPage') || ''), publicFocus: bounded(params, 'publicFocus') };
}
function writeCollection(query: URLSearchParams, state: Partial<ProviderCollectionContext>) {
  const values = { ownedQuery: state.query, ownedFilter: state.filter, ownedPage: state.page && state.page > 1 ? String(state.page) : '', ownedFocus: state.focus, ownedSelected: state.selected, publicQuery: state.publicQuery, publicPage: state.publicPage && state.publicPage > 1 ? String(state.publicPage) : '', publicFocus: state.publicFocus };
  for (const key of VIEW_KEYS) if (values[key]) query.set(key, values[key]!);
}
export function providerModelDetailHref(identity: { modelId?: string; model?: string; platformId?: string }, origin: ProviderOrigin, collection: Partial<ProviderCollectionContext> = {}, source?: URLSearchParams) {
  const query = new URLSearchParams();
  for (const key of ['modelId', 'model', 'platformId'] as const) if (identity[key]) query.set(key, identity[key]!);
  if (identity.platformId) { query.set('returnKind', origin); query.set('returnProviderId', identity.platformId); writeCollection(query, { ...collection, focus: identity.modelId || collection.focus }); }
  return source?.has('context') ? withLogTaskContext('/models/view', query, getLogTaskContext(source.toString())) : `/models/view?${query}`;
}
export function entityBackTarget(params: URLSearchParams): { href: string; label: string } {
  const kind = params.get('returnKind');
  const providerId = params.get('returnProviderId')?.trim();
  if (providerId && providerId.length <= 256 && !/[\u0000-\u001f]/.test(providerId)) {
    if (kind === 'upstream-provider') { const query = new URLSearchParams({ view: 'provider', providerId }); writeCollection(query, providerCollectionContext(params)); return { href: `/platforms?${query}`, label: '返回已接入模型' }; }
    if (kind === 'provider-detail') { const query = new URLSearchParams({ id: providerId }); writeCollection(query, providerCollectionContext(params)); return { href: params.has('context') ? withLogTaskContext('/platforms/view', query, getLogTaskContext(params.toString())) : `/platforms/view?${query}`, label: '返回供应方详情' }; }
  }
  // Entity identity requestType/model parameters are not the originating log filters.
  if (params.has('context')) return getLogReturnTarget(getLogTaskContext(params.toString()));
  return { href: '/logs', label: '返回请求记录' };
}

export function callerCandidateDetailHref(item: { id: string; appCallerCode: string; requestType: string }, origin: URLSearchParams) {
  const query = new URLSearchParams({ id: item.id, code: item.appCallerCode, requestType: item.requestType });
  return origin.has('context') ? withLogTaskContext('/app-callers/view', query, getLogTaskContext(origin.toString())) : `/app-callers/view?${query}`;
}
