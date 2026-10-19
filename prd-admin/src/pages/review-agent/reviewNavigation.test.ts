import { describe, expect, it } from 'vitest';
import { reviewNavigationForPermissions } from './reviewNavigation';

describe('产品管理评审入口', () => {
  it('同时拥有产品管理和评审权限时归入产品管理菜单', () => {
    const paths = reviewNavigationForPermissions(['product-agent.use', 'review-agent.use']);
    expect(paths.reviewHome).toBe('/product-agent?section=review');
    expect(paths.submit).toBe('/product-agent/review/submit');
    expect(paths.submission('s1')).toBe('/product-agent/review/submissions/s1');
    expect(paths.assessments).toBe('/product-agent/requirements/assessments');
    expect(paths.assessment('a1')).toBe('/product-agent/requirements/assessments/a1');
  });

  it('只有旧评审权限时保留全部旧页面路径', () => {
    const paths = reviewNavigationForPermissions(['review-agent.use']);
    expect(paths.reviewHome).toBe('/review-agent');
    expect(paths.submit).toBe('/review-agent/submit');
    expect(paths.submission('s1')).toBe('/review-agent/submissions/s1');
    expect(paths.assessments).toBe('/review-agent/assessments');
    expect(paths.assessment('a1')).toBe('/review-agent/assessments/a1');
  });
});
