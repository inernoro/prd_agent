import { describe, expect, it } from 'vitest';
import { allPermissions, getPermissionsByMenu, menuList } from '../authzMenuMapping';

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
});
