import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { hasProductMenu, hasProductReviewPermission, PRODUCT_MENU_KEYS, productRouteMenu } from './productPermissionAccess';
import { readPermissionWorkbook, snapshotWorkbook, writePermissionWorkbook } from './productPermissionWorkbook';
import type { ProductPermissionSnapshot } from '@/services/real/productPermissions';
import { hasEffectivePermission } from '@/lib/permissionAccess';

const metadata: ProductPermissionSnapshot = {
  schemaVersion: 1, revision: 'none', enabled: false,
  menus: PRODUCT_MENU_KEYS.map((key, i) => ({ key, label: ['概览', '产品', '需求', '评审', '功能', '缺陷', '版本', '客户', '知识库', '图谱', '设置'][i], functions: key === 'versions' ? ['product-agent.version-apply'] : [] })),
  functions: { 'product-agent.version-apply': '版本号申领' },
  users: Array.from({ length: 13 }, (_, i) => ({ userId: 'u' + i, username: 'account' + i, displayName: '成员' + i, isMapAdmin: false, menus: ['requirements', 'review', 'versions'], permissions: ['product-agent.version-apply'] })),
};
const bytes = (book: XLSX.WorkBook) => XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
describe('产品权限工作簿', () => {
  it('11菜单分表13人往返，只有需求评审版本和申领被允许', () => {
    const draft = snapshotWorkbook(metadata);
    const result = readPermissionWorkbook(bytes(writePermissionWorkbook(draft, metadata)), metadata);
    expect(result).toEqual(draft);
    expect(result.sheets).toHaveLength(11);
    for (const sheet of result.sheets) { expect(sheet.rows).toHaveLength(13); expect(sheet.rows.every((r) => r.visible)).toBe(['requirements', 'review', 'versions'].includes(sheet.menu)); }
  });
  it.each(['missing', 'extra', 'header', 'blank', 'formula', 'revision'])('拒绝异常文件：%s', (kind) => {
    const book = writePermissionWorkbook(snapshotWorkbook(metadata), metadata);
    if (kind === 'missing') book.SheetNames.pop();
    if (kind === 'extra') XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['x']]), '未知');
    if (kind === 'header') book.Sheets['需求'].A4.v = '错误列';
    if (kind === 'blank') delete book.Sheets['需求'].D5;
    if (kind === 'formula') book.Sheets['需求'].D5.f = '1+0';
    if (kind === 'revision') book.Sheets['需求'].D2.v = 'different';
    expect(() => readPermissionWorkbook(bytes(book), metadata)).toThrow();
  });
});
describe('独立菜单与产品作用域隔离', () => {
  const permissions = ['super', 'product-agent.use', 'product-agent.menu-scoped', ...['requirements', 'review', 'versions'].map((key) => 'product-agent.menu.' + key)];
  it('普通super不能越过产品菜单，但其他应用授权不变', () => {
    for (const key of PRODUCT_MENU_KEYS) expect(hasProductMenu(permissions, key)).toBe(['requirements', 'review', 'versions'].includes(key));
    expect(hasEffectivePermission(permissions, 'product-agent.admin')).toBe(false);
    expect(hasEffectivePermission(permissions, 'other.use')).toBe(true);
    expect(hasProductReviewPermission([...permissions, 'review-agent.manage'], 'review-agent.manage')).toBe(false);
  });
  it('真实MAP管理员全菜单，普通账号不能从产品授权得到独立评审权限', () => {
    for (const key of PRODUCT_MENU_KEYS) expect(hasProductMenu(['product-agent.map-admin'], key)).toBe(true);
    expect(hasProductReviewPermission(permissions, 'review-agent.use')).toBe(true);
    expect(permissions).not.toContain('review-agent.use');
  });
  it.each([
    ['/product-agent', '?section=versions', 'versions'],
    ['/product-agent/review/submissions/id', '', 'review'],
    ['/product-agent/requirements/assessments/id', '', 'requirements'],
    ['/product-agent/p/id/requirement/new', '', 'requirements'],
    ['/product-agent/p/id/release/id', '', 'versions'],
    ['/product-agent/p/id', '?tab=knowledge', 'knowledge'],
    ['/product-agent/p/id', '?tab=unknown', 'unknown'],
  ])('直达页面按真实菜单拦截%s%s', (path, search, menu) => expect(productRouteMenu(path, search)).toBe(menu));
});
