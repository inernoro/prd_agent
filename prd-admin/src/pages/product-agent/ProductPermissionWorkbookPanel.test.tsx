// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductPermissionsPanel } from './ProductPermissionsPanel';
import { PRODUCT_MENU_KEYS } from './productPermissionAccess';

const state = vi.hoisted(() => ({ permissions: ['product-agent.map-admin'], isRoot: false, setPermissions: vi.fn() }));
const api = vi.hoisted(() => ({ get: vi.fn(), preview: vi.fn(), commit: vi.fn() }));
vi.mock('@/stores/authStore', () => ({ useAuthStore: Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state }) }));
vi.mock('@/services/real/productPermissions', () => ({
  getProductPermissions: api.get, previewProductPermissions: api.preview, importProductPermissions: api.commit,
  getProductPermissionMe: vi.fn(async () => ({ success: true, data: { permissions: ['product-agent.map-admin'] } })),
}));
vi.mock('@/components/ui/VideoLoader', () => ({ MapSpinner: () => null, MapSectionLoader: () => <span>读取中</span> }));
let host: HTMLDivElement;
let root: Root | undefined;
async function render() {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root?.render(<ProductPermissionsPanel tab="menu" />));
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === text);
  expect(button).toBeDefined(); await act(async () => button?.click());
}
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.clearAllMocks(); });
describe('权限导入真实组件交互', () => {
  it.each([['authz.manage'], ['product-agent.admin'], ['super'], ['product-agent.menu.settings']])('非MAP管理员%s不见导入按钮，也不读取全员目录', async (permission) => {
    state.permissions = [permission]; await render();
    expect(host.textContent).toContain('仅MAP管理员');
    expect(host.querySelector('input[type=file]')).toBeNull(); expect(api.get).not.toHaveBeenCalled();
  });
  it('MAP管理员编辑个人菜单必须先预览，确认后才覆盖', async () => {
    state.permissions = ['product-agent.map-admin'];
    api.get.mockResolvedValue({ success: true, data: { schemaVersion: 1, revision: 'r1', enabled: true,
      menus: PRODUCT_MENU_KEYS.map((key) => ({ key, label: key, functions: [] })), functions: {},
      users: [{ userId: 'u1', username: 'member', displayName: '成员', isMapAdmin: false, menus: ['requirements'], permissions: [] }] } });
    api.preview.mockResolvedValue({ success: true, data: { people: 1, omittedCount: 2, administratorCount: 1, revision: 'r1', changes: [], notice: '未列普通人员将失去产品权限' } });
    api.commit.mockResolvedValue({ success: true, data: { revision: 'r2', people: 1 } });
    await render();
    expect(host.querySelector('input[type=file]')).not.toBeNull();
    const checkbox = host.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    await click('预览并保存修改');
    expect(api.commit).not.toHaveBeenCalled(); expect(host.textContent).toContain('未列普通人员 2 人');
    const book = api.preview.mock.calls[0][0];
    expect(book.expectedRevision).toBe('r1'); expect(book.sheets.find((s: {menu:string}) => s.menu === 'requirements').rows[0].visible).toBe(false);
    await click('确认整本覆盖');
    expect(api.commit).toHaveBeenCalledWith(book); expect(host.textContent).toContain('产品权限已整本覆盖');
    await click('读取最新配置');
    expect(host.querySelector('[aria-label="覆盖导入预览"]')).toBeNull();
    expect(api.get).toHaveBeenCalledTimes(3);
  });
});
