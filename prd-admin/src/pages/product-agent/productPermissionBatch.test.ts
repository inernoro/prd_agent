import { describe, expect, it } from 'vitest';
import type { AdminUser } from '@/types/admin';
import type { AdminUserAuthzSnapshot } from '@/services/contracts/authz';
import { hasPermissionEditConflict, loadAllPermissionUsers, toggleVisiblePeople } from './productPermissionBatch';
import people from './ProductPermissionPeople.tsx?raw';

const user = (id: string) => ({ userId: id, username: id, displayName: id, role: 'PM', status: 'Active', createdAt: '' } as AdminUser);
const baseline: AdminUserAuthzSnapshot = {
  userId: 'a', username: 'a', displayName: 'A', role: 'PM', effectiveSystemRoleKey: 'pm',
  permAllow: ['logs.read', 'product-agent.use'], permDeny: [],
};

describe('权限人员批量配置', () => {
  it('读取每页而不是把首批人员当全量', async () => {
    const pages: number[] = [];
    const users = await loadAllPermissionUsers(async (page) => {
      pages.push(page);
      return { items: [user(String(page))], total: 3 };
    }, () => true, () => {});
    expect(pages).toEqual([1, 2, 3]);
    expect(users.map((item) => item.userId)).toEqual(['1', '2', '3']);
  });
  it('目录变化造成重复页时拒绝声称全量完成', async () => {
    await expect(loadAllPermissionUsers(async () => ({ items: [user('a')], total: 2 }), () => true, () => {}))
      .rejects.toThrow('人员目录在读取时发生变化');
  });
  it('取消页面后不再发起下一页', async () => {
    let active = true;
    let calls = 0;
    const users = await loadAllPermissionUsers(async () => {
      calls += 1; active = false;
      return { items: [user('a')], total: 2 };
    }, () => active, () => {});
    expect(calls).toBe(1);
    expect(users).toEqual([]);
  });
  it('搜索全选与取消只改变当前结果，并保留隐藏的选择', () => {
    expect(toggleVisiblePeople(['hidden', 'a'], ['a', 'b'], true)).toEqual(['hidden', 'a', 'b']);
    expect(toggleVisiblePeople(['hidden', 'a', 'b'], ['a', 'b'], false)).toEqual(['hidden']);
  });
  it('仅编辑字段和角色冲突阻止覆盖，其他应用变化不阻止合并', () => {
    expect(hasPermissionEditConflict(baseline, { ...baseline, permAllow: [...baseline.permAllow, 'assets.use'] }, ['product-agent.use'])).toBe(false);
    expect(hasPermissionEditConflict(baseline, { ...baseline, permDeny: ['product-agent.use'] }, ['product-agent.use'])).toBe(true);
    expect(hasPermissionEditConflict(baseline, { ...baseline, effectiveSystemRoleKey: 'admin' }, ['product-agent.use'])).toBe(true);
  });
  it('双重例外的原始变化也属于冲突', () => {
    const both = { ...baseline, permDeny: ['product-agent.use'] };
    expect(hasPermissionEditConflict(both, { ...both, permAllow: ['logs.read'] }, ['product-agent.use'])).toBe(true);
  });
  it('选择不是授权，保存仍重新读取并只合并显式调整，失败草稿保留', () => {
    expect(people).toContain('aria-label="全选当前搜索结果"');
    expect(people).toContain('mergePermissionOverrides(latest.data, changes[id])');
    expect(people).toContain('hasPermissionEditConflict(snapshots[id], latest.data');
    expect(people).toContain('失败项仍保留待修改状态');
    expect(people).toContain('if (!alive()) break;');
  });
});
