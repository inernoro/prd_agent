import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const page = readFileSync(
  new URL('../../pages/WebPagesPage.tsx', import.meta.url), 'utf8');
const service = readFileSync(
  new URL('../../services/real/webPages.ts', import.meta.url), 'utf8');

/**
 * 「中止」这颗按钮必须真的能中止**它当前所在的那条路径**。
 *
 * 它此前只调 `xhrRef.current?.abort()`，而重传走的是 `fetch`，`xhrRef` 恒为 null——
 * 按下去只是把进度屏藏起来，请求照跑、站点照换，用户却被告知「已中止」。
 * 之前这颗按钮在重传时不可见所以没暴露；进度屏对重传放行之后它就成了一个会说谎的控件。
 *
 * 这几条删掉之后没有任何用例会红（按钮照样渲染、照样能点），所以需要守卫钉住。
 */
describe('重传的中止', () => {
  it('服务层接受 AbortSignal 并透传给 fetch', () => {
    expect(service).toMatch(/reuploadSite\([\s\S]{0,200}?signal\?: AbortSignal/);
    expect(service).toMatch(/fetch\(url, \{[^}]*signal[^}]*\}\)/);
  });

  it('中止被翻成 ABORTED，而不是报成一次失败', () => {
    expect(service).toContain("e.name === 'AbortError'");
    expect(service).toContain("code: 'ABORTED'");
  });

  it('页面把 signal 传进去了', () => {
    expect(page).toMatch(/reuploadSite\([\s\S]{0,160}?abortRef\.current\.signal/);
  });

  it('中止按钮两条路径的手柄都调，不能只调一个', () => {
    const handler = page.slice(
      page.indexOf('xhrRef.current?.abort();') - 400,
      page.indexOf('xhrRef.current?.abort();') + 200);
    expect(handler).toContain('xhrRef.current?.abort();');
    expect(handler).toContain('abortRef.current?.abort();');
  });

  it('每次提交都重开一个 controller，用过的不能复用', () => {
    // 复用已 abort 的 controller 会让下一次重传一开始就被中止
    expect(page).toContain('abortRef.current = new AbortController();');
  });

  it('中止之后不许继续往下改元信息', () => {
    // 否则「已中止」之后站点还是被换掉、标题还是被改了
    expect(page).toContain("res.error?.code !== 'ABORTED'");
  });
});
