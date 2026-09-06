import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS } from '../toolboxStore';

describe('移动端网页托管入口', () => {
  it('在百宝箱注册真实网页托管路由与权限', () => {
    const entry = BUILTIN_TOOLS.find((item) => item.id === 'builtin-web-pages');

    expect(entry).toMatchObject({
      name: '网页托管',
      kind: 'tool',
      routePath: '/web-pages',
      permission: 'web-pages.read',
    });
  });
});
