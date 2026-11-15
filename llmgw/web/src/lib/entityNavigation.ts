import { getLogReturnTarget, getLogTaskContext } from './logNavigation';

type ProviderOrigin = 'upstream-provider' | 'provider-detail';
/** Return pointers are finite task identities, never user-supplied destination URLs. */
export function providerModelDetailHref(identity: { modelId?: string; model?: string; platformId?: string }, origin: ProviderOrigin) {
  const query = new URLSearchParams();
  for (const key of ['modelId', 'model', 'platformId'] as const) if (identity[key]) query.set(key, identity[key]!);
  if (identity.platformId) { query.set('returnKind', origin); query.set('returnProviderId', identity.platformId); }
  return `/models/view?${query}`;
}
export function entityBackTarget(params: URLSearchParams): { href: string; label: string } {
  const kind = params.get('returnKind');
  const providerId = params.get('returnProviderId')?.trim();
  if (providerId && providerId.length <= 256 && !/[\u0000-\u001f]/.test(providerId)) {
    if (kind === 'upstream-provider') return { href: `/platforms?${new URLSearchParams({ view: 'provider', providerId })}`, label: '返回已接入模型' };
    if (kind === 'provider-detail') return { href: `/platforms/view?${new URLSearchParams({ id: providerId })}`, label: '返回供应方详情' };
  }
  // Entity identity requestType/model parameters are not the originating log filters.
  if (params.has('context')) return getLogReturnTarget(getLogTaskContext(params.toString()));
  return { href: '/logs', label: '返回请求记录' };
}
