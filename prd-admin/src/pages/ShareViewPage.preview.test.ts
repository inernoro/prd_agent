import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canUseSrcDocPreview, shouldMaskDirectPreview, PREVIEW_MASK_TIMEOUT_MS } from './ShareViewPage';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARE_VIEW = path.join(HERE, 'ShareViewPage.tsx');

/**
 * 分享页预览的两条接线守卫 + 一条 srcDoc 适用性判据。
 *
 * 前两条防的是「兜底代码写了却从没生效过」：托管内容在独立域名且不返回
 * Access-Control-Allow-Origin，浏览器侧 fetch 一律被 CORS 拦掉，于是 srcDoc 分支
 * 永远拿不到内容、静默退化成直链 iframe。改回浏览器 fetch 就会让它再次变成死代码。
 */
/**
 * 剥掉注释再判。文件里有大段注释在**描述**这个反模式（"不是浏览器直接 fetch(site.siteUrl)"），
 * 不剥的话守卫会匹配到自己的说明文字而误报——判据要看代码，不看散文。
 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

describe('分享页预览接线', () => {
  const source = stripComments(fs.readFileSync(SHARE_VIEW, 'utf8'));

  it('取回入口 HTML 走服务端同源代理，不是浏览器直接 fetch 托管域名', () => {
    expect(source).toContain('getShareSiteContent');
    // 断言行为而不是字面量：不允许出现「直接 fetch 站点 URL」这种写法
    expect(source).not.toMatch(/fetch\(\s*site\.siteUrl/);
    expect(source).not.toMatch(/fetch\(\s*`?\$?\{?site\.siteUrl/);
  });

  it('加载超时不产生「失败」文案——超时只是慢，不是坏', () => {
    // 超时相关的判定不得把状态置成 errored/失败
    expect(source).not.toMatch(/setErrored\(true\)[^\n]*超时/);
    expect(source).not.toMatch(/超时[^\n]*setErrored\(true\)/);
  });
});

/**
 * srcDoc 适用性判据。
 *
 * 由 PR #1351 的 Codex review 抓出：srcDoc 路径刻意不给 allow-same-origin
 * （否则用户上传的任意 HTML 就拿到 MAP 同源能力），代价是文档处于不透明源。
 * 经典 `<script src>` 跨域不需要 CORS，但 `<script type="module">` 需要——
 * 而托管域名不返回 ACAO。所以打包型 SPA 走 srcDoc 会白屏，必须留在直链 iframe。
 */
describe('canUseSrcDocPreview', () => {
  it('普通单文件页面可以走 srcDoc', () => {
    expect(canUseSrcDocPreview('<html><body><h1>你好</h1></body></html>')).toBe(true);
  });

  it('经典外链脚本仍可走 srcDoc（跨域加载不需要 CORS）', () => {
    expect(canUseSrcDocPreview('<script src="https://cdn.example.com/a.js"></script>')).toBe(true);
  });

  it('内联 module 脚本可以走 srcDoc（没有跨域请求）', () => {
    expect(canUseSrcDocPreview('<script type="module">console.log(1)</script>')).toBe(true);
  });

  it('外链 module 脚本不能走 srcDoc —— 不透明源下会因缺 CORS 被拦成白屏', () => {
    expect(canUseSrcDocPreview('<script type="module" src="/assets/index-abc.js"></script>')).toBe(false);
  });

  it('属性顺序反过来也要认出来', () => {
    expect(canUseSrcDocPreview('<script src="/assets/index.js" type="module"></script>')).toBe(false);
  });

  it('带 crossorigin 等额外属性的 Vite 产物入口也要认出来', () => {
    const vite = '<script type="module" crossorigin src="/assets/index-DkZ1s.js"></script>';
    expect(canUseSrcDocPreview(vite)).toBe(false);
  });

  it('空内容不走 srcDoc', () => {
    expect(canUseSrcDocPreview('')).toBe(false);
  });
});

/**
 * 加载遮罩必须限时让位。
 *
 * 由 PR #1351 第二轮 review 抓出：那层「正在准备预览...」是不透明全屏遮罩，而底下的直链
 * iframe 一直在正常加载。代理慢或不可达时，一个本来能显示的页面会被白屏盖住整个 HTTP 超时——
 * 这正是本 PR 立意要修的毛病（超时不等于坏了，别盖住已经画出来的页面），却在新加的遮罩上
 * 又犯了一次。核心断言：loading 永不结束时，遮罩不能永远盖着。
 */
describe('shouldMaskDirectPreview', () => {
  it('刚开始取原文时遮一下，避免先闪直链再跳 srcDoc 的跳变', () => {
    expect(shouldMaskDirectPreview({ loading: true, hasSrcDoc: false, maskExpired: false })).toBe(true);
  });

  it('短窗口到点后必须让位 —— 即使原文始终没回来', () => {
    expect(shouldMaskDirectPreview({ loading: true, hasSrcDoc: false, maskExpired: true })).toBe(false);
  });

  it('已经拿到 srcDoc 就不再需要遮罩', () => {
    expect(shouldMaskDirectPreview({ loading: true, hasSrcDoc: true, maskExpired: false })).toBe(false);
  });

  it('没在加载就不该有遮罩', () => {
    expect(shouldMaskDirectPreview({ loading: false, hasSrcDoc: false, maskExpired: false })).toBe(false);
  });

  it('遮罩窗口必须短于任何合理的 HTTP 超时，否则等于没限', () => {
    expect(PREVIEW_MASK_TIMEOUT_MS).toBeGreaterThan(0);
    // 5s 是个宽松上界：真实代理超时以十秒计，遮罩必须远早于它让位
    expect(PREVIEW_MASK_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});
