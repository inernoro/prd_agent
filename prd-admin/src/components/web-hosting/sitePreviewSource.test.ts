import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSitePreviewSource, supportsNativePdfViewer } from './sitePreviewSource';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 判据要看代码不看散文：文件里有大段注释在描述反模式，不剥会匹配到自己的说明文字 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

describe('resolveSitePreviewSource', () => {
  const html = { siteUrl: 'https://cfi.example.org/s/a/index.html', pdfAssetUrl: undefined };
  const pdf = { siteUrl: 'https://cfi.example.org/s/b/index.html', pdfAssetUrl: 'https://cfi.example.org/s/b/x.pdf?v=1' };

  it('普通站点恒走入口 URL', () => {
    for (const nativePdfViewer of [true, false]) {
      expect(resolveSitePreviewSource(html, { nativePdfViewer })).toEqual({
        src: html.siteUrl,
        usingNativePdfViewer: false,
      });
    }
  });

  it('能用原生阅读器时，PDF 包装站绕开壳子直连 PDF', () => {
    expect(resolveSitePreviewSource(pdf, { nativePdfViewer: true })).toEqual({
      src: pdf.pdfAssetUrl,
      usingNativePdfViewer: true,
    });
  });

  /**
   * 移动端 Safari / 微信 WebView 在 iframe 里渲染不了 PDF，绕开壳子等于白屏。
   * 这一条把「桌面的修复不能顺手套到移动端」钉死。
   */
  it('不能用原生阅读器时，PDF 站必须留在壳子上', () => {
    expect(resolveSitePreviewSource(pdf, { nativePdfViewer: false })).toEqual({
      src: pdf.siteUrl,
      usingNativePdfViewer: false,
    });
  });
});

/**
 * 站内大预览的 PDF 接线守卫。
 *
 * 后端 TryBuildPdfAssetUrl 专门为「绕开壳子」算出了 pdfAssetUrl，但站内预览弹窗
 * 从来没读过它——建了一半的接线，删掉不会有任何测试变红
 * （predicate-and-wiring-discipline 形状 2）。症状是 PDF 站大预览永久空白：
 * 壳子从 cdn.jsdelivr.net 取 PDF.js，该域名在部分网络里是**挂起**而不是快速失败，
 * 于是 script.onerror 永不触发、壳子自己的降级分支永远走不到。
 */
describe('站内大预览的 PDF 接线', () => {
  const source = stripComments(fs.readFileSync(path.join(HERE, 'SitePreviewModal.tsx'), 'utf8'));

  it('iframe 的 src 来自共享判定源，而不是直接写 site.siteUrl', () => {
    expect(source).toContain('resolveSitePreviewSource');
    expect(source).not.toMatch(/src=\{\s*site\.siteUrl\s*\}/);
  });

  /**
   * 第一版只断言「调用了判定源」，于是漏掉了真正致命的一环：判定源收到的 pdfAssetUrl
   * 恒为 undefined（那个字段只挂在 SharedSiteInfo 上，站内列表根本不下发），
   * 整条修复空转，而这条源码扫描守卫照样全绿。
   *
   * 传输面现在由**类型系统**兜底：SitePreviewSourceInput.pdfAssetUrl 是必填属性，
   * HostedSite 少了它就编译不过。这里再钉一道，防止有人把它改回可选。
   */
  it('判定源的 pdfAssetUrl 必须是必填属性，可选会让「数据没送到」静默通过', () => {
    const helper = stripComments(fs.readFileSync(path.join(HERE, 'sitePreviewSource.ts'), 'utf8'));
    expect(helper).toMatch(/pdfAssetUrl:\s*string\s*\|\s*undefined/);
    expect(helper).not.toMatch(/pdfAssetUrl\?:/);
  });

  it('后端把 pdfAssetUrl 下发给了站内列表用的 HostedSite', () => {
    const types = stripComments(fs.readFileSync(path.join(HERE, '../../services/real/webPages.ts'), 'utf8'));
    const hostedSite = types.match(/export interface HostedSite\b[\s\S]*?\n}/);
    expect(hostedSite).not.toBeNull();
    expect(hostedSite![0]).toContain('pdfAssetUrl');
  });

  /**
   * 能不能用原生 PDF 阅读器是**运行环境**决定的，不是弹窗尺寸决定的。
   * 写死 true 会让移动端 WebView 拿到裸 PDF 直接白屏——正是壳子存在的理由。
   */
  it('原生阅读器可用性接的是能力信号，不是写死的 true、也不是视口宽度', () => {
    expect(source).toContain('supportsNativePdfViewer');
    expect(source).not.toMatch(/nativePdfViewer:\s*true/);
    // 768px 断点会把 iPad / 横屏手机 / 平板 WebView 一并算成桌面，它们照样白屏
    expect(source).not.toContain('useIsMobile');
  });
});

/**
 * 能力探测本身的判据。宽度不是能力——这一族用例把「换个等价场景就翻转」的窄判据钉死。
 */
describe('supportsNativePdfViewer', () => {
  it('浏览器自称有内置 PDF 阅读器才算有', () => {
    expect(supportsNativePdfViewer({ pdfViewerEnabled: true })).toBe(true);
  });

  it('自称没有就是没有', () => {
    expect(supportsNativePdfViewer({ pdfViewerEnabled: false })).toBe(false);
  });

  it('拿不到这个信号时保守当作没有——走壳子最多多依赖一次 CDN，走错方向是彻底白屏', () => {
    expect(supportsNativePdfViewer({})).toBe(false);
    expect(supportsNativePdfViewer({ pdfViewerEnabled: undefined })).toBe(false);
  });
});

/**
 * 提问设置的入口守卫。
 *
 * AskConfigDrawer 第一版只接进了大预览顶栏的齿轮，站点卡「更多设置」菜单没有入口——
 * 用户在列表里翻遍菜单也找不到提问配置，功能等于没上线（同样是形状 2）。
 */
describe('提问设置入口', () => {
  const page = stripComments(fs.readFileSync(path.join(HERE, '../../pages/WebPagesPage.tsx'), 'utf8'));

  it('站点卡「更多设置」菜单能直达提问设置', () => {
    expect(page).toContain('AskConfigDrawer');
    // 两种卡片形态（网格卡 + 列表行）都要有，漏一种就有一半用户找不到
    expect(page.match(/label:\s*'提问设置'/g) ?? []).toHaveLength(2);
  });
});
