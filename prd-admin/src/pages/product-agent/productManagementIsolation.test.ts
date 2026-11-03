import { describe, expect, it } from 'vitest';
import { NAV_REGISTRY } from '@/app/navRegistry';
import { getPermissionsByMenu, menuList } from '@/lib/authzMenuMapping';
import panel from './ProductPermissionsPanel.tsx?raw';
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

  it('产品权限编辑只管理产品权限，不接管原评审权限', () => {
    expect(panel).toContain('permissions.includes(PRODUCT_MAP_ADMIN)');
    expect(panel).not.toContain('updateSystemRole');
    expect(panel).toContain('独立评审智能体仍在原权限管理中配置。');
  });

  it('产品历史兼容类型不引入原评审名下的新登记接口', () => {
    expect(client).not.toContain('/api/review-agent');
    expect(client).not.toContain('apiRequest');
    expect(client).toContain('export interface VersionRegistration');
  });
});
