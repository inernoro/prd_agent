// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPermissionsByMenu, menuList } from '@/lib/authzMenuMapping';
import { PermissionPopover } from './PermissionPopover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('基础语音权限分配', () => {
  it('权限矩阵分组提供读、生成、配置三项可分别分配的权限', () => {
    const permissions = getPermissionsByMenu('mcp-speech');
    expect(permissions.map(({ key, category }) => ({ key, category }))).toEqual([
      { key: 'mcp-speech.read', category: 'read' },
      { key: 'mcp-speech.generate', category: 'write' },
      { key: 'mcp-speech.manage', category: 'manage' },
    ]);
  });

  it('管理员给只读角色勾选生成权限时不附带平台配置权限', async () => {
    const menu = menuList.find((item) => item.appKey === 'mcp-speech')!;
    const saved = vi.fn();
    await act(async () => root.render(<PermissionPopover open onOpenChange={() => {}} roleName="配音使用者"
      menuLabel={menu.label} menuPermissions={menu.permissions} currentPermissions={['mcp-speech.read']} onSave={saved} />));
    const fields = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(fields).toHaveLength(3);
    expect(fields.map((input) => input.checked)).toEqual([true, false, false]);
    await act(async () => fields[1].click());
    expect(fields[2].checked).toBe(false);
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('保存'))!;
    await act(async () => save.click());
    expect(saved).toHaveBeenCalledWith(['mcp-speech.read', 'mcp-speech.generate']);
  });
});
