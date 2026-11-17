import { describe, expect, it } from 'vitest';
import { NAV_REGISTRY } from '@/app/navRegistry';
import { getPermissionsByMenu, menuList } from '@/lib/authzMenuMapping';
import client from '@/services/real/productVersionRegistry.ts?raw';

describe('产品管理与既有评审智能体隔离', () => {
  it('保留评审智能体独立导航和原权限定义', () => {
    const review = NAV_REGISTRY.find((entry) => entry.path === '/review-agent');
    expect(review?.permission).toBe('review-agent.use');
    expect(review?.nav).toMatchObject({
      label: '产品评审智能体', shortLabel: '评审', section: 'toolbox', appKey: 'review-agent',
    });
    expect(menuList.find((entry) => entry.appKey === 'review-agent')).toEqual({
      appKey: 'review-agent', label: '产品评审智能体', icon: 'ClipboardCheck',
      permissions: ['review-agent.use', 'review-agent.view-all', 'review-agent.manage'],
    });
    expect(getPermissionsByMenu('review-agent').map((entry) => entry.key))
      .toEqual(['review-agent.use', 'review-agent.view-all', 'review-agent.manage']);
  });

  it('产品管理入口可见且子页面不再依赖产品角色', () => {
    const routes = NAV_REGISTRY.filter((entry) => entry.path === '/product-agent' || entry.path.startsWith('/product-agent/'));
    expect(routes).not.toHaveLength(0);
    expect(routes.every((entry) => entry.permission === undefined)).toBe(true);
  });

  it('产品历史兼容类型不引入原评审名下的新登记接口', () => {
    expect(client).not.toContain('/api/review-agent');
    expect(client).not.toContain('apiRequest');
    expect(client).toContain('export interface VersionRegistration');
  });
});
