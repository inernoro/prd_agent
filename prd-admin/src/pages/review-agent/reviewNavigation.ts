import { useAuthStore } from '@/stores/authStore';

/** 只拥有旧评审权限的账号仍可使用原入口；同时拥有产品管理权限时走新菜单。 */
export function reviewNavigationForPermissions(permissions: string[]) {
  const inProductManagement = permissions.includes('product-agent.use') || permissions.includes('super');
  const reviewBase = inProductManagement ? '/product-agent/review' : '/review-agent';
  const assessmentBase = inProductManagement ? '/product-agent/requirements/assessments' : '/review-agent/assessments';

  return {
    inProductManagement,
    reviewHome: inProductManagement ? '/product-agent?section=review' : '/review-agent',
    requirementHome: inProductManagement ? '/product-agent?section=requirements' : '/review-agent',
    submit: `${reviewBase}/submit`,
    submission: (id: string) => `${reviewBase}/submissions/${id}`,
    all: `${reviewBase}/all`,
    assessments: assessmentBase,
    assessment: (id: string) => `${assessmentBase}/${id}`,
  };
}

export function useReviewNavigation() {
  const permissions = useAuthStore((state) => state.permissions ?? []);
  return reviewNavigationForPermissions(permissions);
}
