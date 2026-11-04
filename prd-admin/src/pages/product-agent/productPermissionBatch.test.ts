import { describe, expect, it } from 'vitest';
import type { AdminUser } from '@/types/admin';
import type { AdminUserAuthzSnapshot } from '@/services/contracts/authz';
import { hasPermissionEditConflict, hasUnrestrictedPermissions, loadAllPermissionUsers, permissionCheckboxValue } from './productPermissionBatch';
import { mergePermissionOverrides } from './productPermissionEditing';
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
  it('勾选显示角色和个人例外的实际权限，而不是选人状态', () => {
    expect(permissionCheckboxValue(baseline, [], 'product-agent.use')).toBe(true);
    expect(permissionCheckboxValue({ ...baseline, permAllow: [] }, ['product-agent.use'], 'product-agent.use')).toBe(true);
    expect(permissionCheckboxValue({ ...baseline, permDeny: ['product-agent.use'] }, ['product-agent.use'], 'product-agent.use')).toBe(false);
    expect(permissionCheckboxValue(baseline, [], 'review-agent.use')).toBe(false);
  });
  it('勾选保存清除该项禁止并授予权限，其他权限不变', () => {
    const result = mergePermissionOverrides({ ...baseline, permDeny: ['product-agent.use', 'assets.write'] }, { 'product-agent.use': 'allow' });
    expect(result.permAllow).toEqual(['logs.read', 'product-agent.use']);
    expect(result.permDeny).toEqual(['assets.write']);
  });
  it('取消勾选保存移除该项权限，即使原角色授予也不误显示为已取消', () => {
    const result = mergePermissionOverrides(baseline, { 'product-agent.use': 'deny' });
    expect(permissionCheckboxValue({ ...baseline, permAllow: result.permAllow ?? [], permDeny: result.permDeny ?? [] }, ['product-agent.use'], 'product-agent.use')).toBe(false);
  });
  it('超级权限显示勾选并由系统维护，不假装可取消', () => {
    expect(hasUnrestrictedPermissions(baseline, ['super'])).toBe(true);
    expect(permissionCheckboxValue(baseline, ['super'], 'review-agent.use')).toBe(true);
    expect(hasUnrestrictedPermissions({ ...baseline, permAllow: ['super'] }, [])).toBe(true);
    expect(hasUnrestrictedPermissions({ ...baseline, permDeny: ['super'] }, ['super'])).toBe(false);
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
  it('权限复选框直接形成保存草稿，不再选择人员或授权模式', () => {
    expect(people).not.toContain('<select');
    expect(people).not.toContain('selectedIds');
    expect(people).not.toContain('对选中人员设置');
    expect(people).toContain('stage(editableIds, definition.key, event.target.checked)');
    expect(people).toContain("checked ? 'allow' : 'deny'");
    expect(people).toContain('mergePermissionOverrides(latest.data, changes[id])');
    expect(people).toContain('hasPermissionEditConflict(snapshots[id], latest.data');
    expect(people).toContain('失败项仍保留待修改状态');
    expect(people).toContain('if (!alive()) break;');
  });
});
