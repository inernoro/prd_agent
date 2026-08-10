import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 网页托管预览的两条接线守卫。
 *
 * 这两件事都属于「删掉之后测试仍然全绿、只有用户会发现」的类别，所以必须有守卫盯着
 * （.claude/rules/predicate-and-wiring-discipline.md 形状 1 判据太窄 / 形状 2 链路只建一半）：
 *
 *  1. 预览页取回网页原文必须走**服务端同源代理**。托管内容在独立域名且不返回
 *     Access-Control-Allow-Origin，浏览器侧 fetch(site.siteUrl) 一律被 CORS 拦掉，
 *     catch 里静默降级 → srcDoc 分支永远拿不到内容 → 退回「Chrome 里只绘制空白」的直链 iframe。
 *     这条兜底曾经写了却从未生效过。
 *
 *  2. 「iframe 的 load 事件没来」不等于「站点坏了」。load 要等所有子资源结算，而托管页普遍
 *     外链三方字体，在部分网络里挂起而非快速失败——正文早已绘制，load 永远不来。旧实现按超时
 *     判 errored，把错误遮罩盖在已经渲染好的页面上，用户看到的就是「无法预览」。
 */

/**
 * 「禁止出现某写法」这类断言必须扫**代码**而不是注释——否则解释这条规则的注释本身
 * 就会把守卫弄红，逼后来人删掉解释。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const shareViewSource = readFileSync(new URL('./ShareViewPage.tsx', import.meta.url), 'utf8');
const shareViewCode = stripComments(shareViewSource);
const previewModalSource = readFileSync(
  new URL('../components/web-hosting/SitePreviewModal.tsx', import.meta.url),
  'utf8',
);
const previewModalCode = stripComments(previewModalSource);
const sitePreviewSource = readFileSync(
  new URL('../components/SitePreview.tsx', import.meta.url),
  'utf8',
);
const sitePreviewCode = stripComments(sitePreviewSource);

describe('分享预览页取回网页原文走同源代理', () => {
  it('调用服务端代理 getShareSiteContent 取原文', () => {
    expect(
      shareViewSource.includes('getShareSiteContent('),
      '预览页必须调 getShareSiteContent（服务端同源代理）取回入口 HTML',
    ).toBe(true);
  });

  it('不再用浏览器直接跨域 fetch 托管地址', () => {
    // fetch(site.siteUrl ...) / fetch(siteUrl ...) 都算回退到被 CORS 拦掉的老路
    const rawCrossOriginFetch = /fetch\(\s*(site\.)?siteUrl\b/;
    expect(
      rawCrossOriginFetch.test(shareViewCode),
      '禁止改回浏览器直接 fetch(site.siteUrl)：托管域名无 CORS 头，会让 srcDoc 兜底重新变成死代码',
    ).toBe(false);
  });

  it('取不回原文时把原因显式告诉用户，不静默吞掉', () => {
    expect(shareViewSource).toContain('setEmbeddedHtmlError');
    expect(shareViewSource).toContain('embeddedHtmlError &&');
  });
});

describe('加载慢不等于加载失败', () => {
  it('大预览弹窗只在 iframe onError 时判失败，不由定时器推断', () => {
    // setErrored(true) 只允许出现一次，且必须挂在 onError 上
    const errorSetCount = (previewModalCode.match(/setErrored\(true\)/g) ?? []).length;
    expect(errorSetCount, 'setErrored(true) 只应出现在 onError 分支').toBe(1);

    const onErrorBlock = previewModalCode.slice(
      previewModalCode.indexOf('onError={'),
      previewModalCode.indexOf('sandbox='),
    );
    expect(
      onErrorBlock.includes('setErrored(true)'),
      '唯一一处 setErrored(true) 必须来自 iframe 的 onError',
    ).toBe(true);
  });

  it('大预览弹窗的超时只产出「较慢」提示，不产出「失败」文案', () => {
    expect(previewModalCode).toContain('setSlow(true)');
    expect(
      previewModalCode.includes('站点加载超时或失败'),
      '超时不得再被描述成失败——页面此时多半已经渲染出来了',
    ).toBe(false);
  });

  it('卡片缩略图不再把「是否显示」只押在 load 事件上', () => {
    expect(
      sitePreviewCode.includes('const visible = inView && (loaded || revealed)'),
      '缩略图必须在首绘窗口到点后淡入，否则外链字体挂起时会永久停在地球占位符',
    ).toBe(true);
    expect(
      sitePreviewCode.includes('opacity: inView && loaded ? 1 : 0'),
      '禁止把 iframe 的显示与否只绑在 loaded 上',
    ).toBe(false);
  });
});
