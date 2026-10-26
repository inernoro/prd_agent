import type { ProductInitiation } from './types';

export function filterReleasePlans(plans: ProductInitiation[], productId: string, versionType: string) {
  return plans.filter((plan) => plan.status === 'approved' && /^T\d+\.\d+\.\d+$/i.test(plan.tCode ?? '')
    && (!productId || plan.productId === productId) && (!versionType || plan.versionType === versionType));
}

/** V仅检索T记录本身；名称取T最终保存值，不从Agent文件名或评审历史拼接。 */
export function releasePlanOption(plan: ProductInitiation, productName = '') {
  return { id: plan.id, label: plan.planName, subLabel: plan.tCode ?? '',
    searchExtra: [plan.appName, productName, plan.systemName, plan.ownerName, plan.demandSource,
      plan.requirementDescription, plan.departmentName].filter(Boolean).join(' ') };
}
