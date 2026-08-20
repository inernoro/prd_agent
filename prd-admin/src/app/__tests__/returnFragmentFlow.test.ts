import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * 授权码只走 fragment 这件事，入口和出口都要堵住。
 *
 * 上一版只堵了入口（不让 fragment 进 `?returnUrl=`），却在 LoginPage 的 render 期
 * 就把它还原成真 fragment，然后同一个值既喂给本地跳转、又喂给 buildSsoHref——
 * 于是授权码照样被拼进外部 SSO 的 query，一路进第三方。
 *
 * 这两条钉的是「哪个形态用在哪」，源码扫描是唯一手段：本仓库前端没有 jsdom，
 * 起不了 Router，而这个不变量删掉之后所有既有测试仍然全绿。
 */
describe('还原出来的 fragment 不许离开本地跳转', () => {
  const source = readFileSync(new URL('../../pages/LoginPage.tsx', import.meta.url), 'utf8');

  it('给 SSO 的是带 fragRef 的那份，不是还原后的', () => {
    expect(source).toContain('returnUrl={returnUrlWithRef}');
    // 还原后的值只能出现在 navigate 里。
    expect(source).not.toMatch(/returnUrl=\{resolveReturnUrl\(\)\}/);
  });

  it('还原只发生在跳转那一刻，不在 render 里', () => {
    // takeReturnFragment 是「取走并删除」：StrictMode 会故意重复执行 render 与
    // useMemo，放在 render 里第一次就把它消费掉，留下的那次拿到空值。
    expect(source).toContain('const resolveReturnUrl = useCallback(');
    expect(source).not.toMatch(/const returnUrl = useMemo\(/);
    expect(source).toContain('navigate(resolveReturnUrl()');
  });
});
