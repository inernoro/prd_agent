import { describe, expect, it } from 'vitest';
import { entryForKey } from './useSitePreviewHtml';

/**
 * 发布换掉 siteUrl 之后，state 里还装着上一条的正文（effect 在渲染之后才跑）。
 * 调用方拿它当「有没有正文」的判据去闩渲染路径，就会按旧正文闩成 srcDoc；等新键取回来
 * 发现走不了 srcDoc，iframe 的 src 与 srcDoc 同时为空——白屏，本该退回的直链再也走不到
 * （Codex P2，2026-09-16）。
 */
describe('预览正文只认当前这个键', () => {
  it('键对得上就原样交出', () => {
    expect(entryForKey({ key: 'site-1::/a?v=1', srcDoc: '<html>新</html>', error: null }, 'site-1::/a?v=1'))
      .toEqual({ srcDoc: '<html>新</html>', error: null });
  });

  it('发布后换了键，上一条的正文一律不交出', () => {
    expect(entryForKey({ key: 'site-1::/a?v=1', srcDoc: '<html>旧</html>', error: null }, 'site-1::/a?v=2'))
      .toEqual({ srcDoc: null, error: null });
  });

  it('上一条的错误同样不跟着新键走', () => {
    expect(entryForKey({ key: 'site-1::/a?v=1', srcDoc: null, error: '取不回' }, 'site-1::/a?v=2'))
      .toEqual({ srcDoc: null, error: null });
  });

  it('站点为空时键是空串，只有同为空串的条目算数', () => {
    expect(entryForKey({ key: '', srcDoc: null, error: null }, '')).toEqual({ srcDoc: null, error: null });
    expect(entryForKey({ key: 'site-1::/a?v=1', srcDoc: '<html/>', error: null }, ''))
      .toEqual({ srcDoc: null, error: null });
  });
});
