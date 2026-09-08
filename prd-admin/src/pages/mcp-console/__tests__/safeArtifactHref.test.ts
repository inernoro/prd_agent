import { describe, it, expect } from 'vitest';
import { safeArtifactHref } from '../artifactHref';

/**
 * 调用记录里那颗「打开」按钮的 href 来自**登记表里的动态接口** —— 谁登记的谁决定它是什么。
 *
 * React 18 不会可靠地拦住 `javascript:` 与 `data:text/html,`，所以这层判据是最后一道：
 * 它一松，「点开智能体刚做出来的东西」就变成点开对方塞进来的一段脚本。
 * 后端落库前也拦同一件事，但库里还躺着那道闸之前写下的记录。
 */
describe('safeArtifactHref', () => {
  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example.com/x',
    'mailto:a@b.c',
    '',
    null,
    undefined,
  ])('拒掉危险或看不出协议的地址：%s', (url) => {
    expect(safeArtifactHref(url as string | null | undefined)).toBeNull();
  });

  it.each([
    ['/web-pages?site=abc', '/web-pages?site=abc'],
    ['https://x.example.com/a.png', 'https://x.example.com/a.png'],
    ['http://x.example.com/a.png', 'http://x.example.com/a.png'],
    ['  /document-store?entry=1  ', '/document-store?entry=1'],
  ])('放行站内路由与 http/https：%s', (input, expected) => {
    expect(safeArtifactHref(input)).toBe(expected);
  });
});
