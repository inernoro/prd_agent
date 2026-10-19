import { describe, expect, it } from 'vitest';
import { allPermissions, getPermissionsByMenu, menuList } from '../authzMenuMapping';
import { NAV_REGISTRY } from '@/app/navRegistry';

describe('产品管理评审菜单权限', () => {
  it('分别列出产品管理入口与评审子菜单的可分配权限', () => {
    expect(menuList.find((menu) => menu.appKey === 'product-agent')?.permissions)
      .toContain('product-agent.use');
    expect(menuList.find((menu) => menu.appKey === 'review-agent')?.permissions)
      .toEqual(expect.arrayContaining(['review-agent.use', 'review-agent.view-all', 'review-agent.manage', 'review-agent.appeal-review']));
    expect(getPermissionsByMenu('review-agent').map((permission) => permission.key))
      .toContain('review-agent.use');
  });

  it('权限说明明确评审菜单还需要产品管理入口权限', () => {
    expect(allPermissions.find((permission) => permission.key === 'review-agent.use')?.description)
      .toContain('产品管理 - 进入');
  });

  it('版本申领可独立授权，但产品管理其它页面不随之开放', () => {
    expect(getPermissionsByMenu('product-agent').map((permission) => permission.key))
      .toContain('product-agent.version-apply');
    expect(allPermissions.find((permission) => permission.key === 'product-agent.version-apply')?.description)
      .toContain('不开放其它产品管理页面');
    for (const path of ['/product-agent', '/product-agent/p/:productId', '/product-agent/p/:productId/:kind/:id']) {
      expect(NAV_REGISTRY.find((route) => route.path === path)?.permission)
        .toEqual(['product-agent.use', 'product-agent.version-apply']);
    }
    expect(NAV_REGISTRY.find((route) => route.path === '/product-agent/p/:productId/knowledge/:entryId')?.permission)
      .toBe('product-agent.use');
  });
});
