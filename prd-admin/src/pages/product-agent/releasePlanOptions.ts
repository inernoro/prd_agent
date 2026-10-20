import type { ProductInitiation } from './types';

export function filterReleasePlans(plans: ProductInitiation[], productId: string, versionType: string) {
  return plans.filter((plan) => plan.status === 'approved' && Boolean(plan.tCode)
    && (!productId || plan.productId === productId) && (!versionType || plan.versionType === versionType));
}
