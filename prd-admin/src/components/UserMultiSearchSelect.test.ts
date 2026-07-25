import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./UserMultiSearchSelect.tsx', import.meta.url)),
  'utf8',
);

describe('UserMultiSearchSelect 用户目录权限回归', () => {
  it('使用仅需登录的目录检索接口，不再依赖管理员用户接口', () => {
    expect(source).toContain("import { searchDirectoryUsers } from '@/services';");
    expect(source).toContain('searchDirectoryUsers(keyword, 50)');
    expect(source).not.toContain('getUsers({ page: 1, pageSize: 200 })');
  });

  it('目录请求失败时显示错误状态，不伪装成零个可用用户', () => {
    expect(source).toContain('用户列表加载失败，请重新打开后重试');
    expect(source).toContain('setSearchFailed(true)');
  });
});
