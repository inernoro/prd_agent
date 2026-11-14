import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoginEnvironmentNotice } from './LoginPage';

describe('登录环境说明', () => {
  it('在登录前说明账号、密码和锁定范围，并提供不携带凭据的主入口', () => {
    const html = renderToStaticMarkup(<LoginEnvironmentNotice environment={{ isolatedAccountStore: true, primaryLoginUrl: 'https://main.example.test/login' }} />);
    expect(html).toContain('隔离验收环境');
    expect(html).toContain('账号、密码和登录锁定状态不与主入口互通');
    expect(html).toContain('href="https://main.example.test/login"');
    expect(html).toContain('返回主入口登录');
  });

  it.each([undefined, null, { isolatedAccountStore: false, primaryLoginUrl: 'https://main.example.test/' }])('未明确声明隔离时不猜测数据范围：%s', (environment) => {
    expect(renderToStaticMarkup(<LoginEnvironmentNotice environment={environment} />)).toBe('');
  });

  it.each(['javascript:alert(1)', 'http://main.example.test/', 'https://name:secret@main.example.test/', 'https://main.example.test/?token=secret', 'https://main.example.test/#secret', 'not-a-url', undefined])('主入口无效时保留说明但不显示跳转：%s', (primaryLoginUrl) => {
    const html = renderToStaticMarkup(<LoginEnvironmentNotice environment={{ isolatedAccountStore: true, primaryLoginUrl }} />);
    expect(html).toContain('隔离验收环境');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('secret');
  });
});
