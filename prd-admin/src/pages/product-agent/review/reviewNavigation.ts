/** 仅供产品管理视图使用，不按账号权限重写独立智能体导航。 */
export const PRODUCT_REVIEW_NAVIGATION = {
  inProductManagement: true,
  reviewHome: '/product-agent?section=review',
  requirementHome: '/product-agent?section=requirements',
  submit: '/product-agent/review/submit',
  submission: (id: string) => `/product-agent/review/submissions/${encodeURIComponent(id)}`,
  all: '/product-agent/review/all',
  assessments: '/product-agent/requirements/assessments',
  assessment: (id: string) => `/product-agent/requirements/assessments/${encodeURIComponent(id)}`,
};

export function useReviewNavigation() {
  return PRODUCT_REVIEW_NAVIGATION;
}
