import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasFetchableHtml, canUseSrcDocPreview, preserveSrcDocFragmentLinks, withPreviewBase } from './previewHtml';

/**
 * 「这个站点走 srcDoc 还是直链」的判据。
 *
 * 事故（2026-08-25 用户反馈「概率不显示内容」）：Markdown 包装站被这条判据一刀切排除，
 * 于是永远拿不回原文、只能走直链 iframe —— 而直链正是那条「Chrome 只绘制空白」的路径。
 * 表现是标题栏正常、下面一片白；普通 HTML 站因为走 srcDoc 反而好好的，
 * 所以看上去像「有的能开有的不能开」。
 */
const site = (over: Partial<Parameters<typeof hasFetchableHtml>[0]> = {}) => ({
  siteUrl: 'https://host.example/u/abc/index.html',
  entryFile: 'index.html',
  ...over,
});

describe('站点正文可取回判据', () => {
  it('Markdown 包装站可以取回正文（壳子就是服务端渲染好的完整 HTML）', () => {
    expect(hasFetchableHtml(site({ wrappedAssetType: 'markdown' }))).toBe(true);
  });

  it('PDF / 视频包装站不取（壳子里没有正文，且必须以托管域名为源加载同目录资产）', () => {
    expect(hasFetchableHtml(site({ wrappedAssetType: 'pdf' }))).toBe(false);
    expect(hasFetchableHtml(site({ wrappedAssetType: 'video' }))).toBe(false);
    expect(hasFetchableHtml(site({ pdfAssetUrl: 'https://host.example/u/abc/a.pdf' }))).toBe(false);
  });

  it('将来新增的包装形态默认不取（default-deny，不靠「忘了排除」放行）', () => {
    expect(hasFetchableHtml(site({ wrappedAssetType: 'audio' }))).toBe(false);
  });

  it('普通 HTML 站照常取', () => {
    expect(hasFetchableHtml(site())).toBe(true);
    expect(hasFetchableHtml(site({ entryFile: 'main.htm' }))).toBe(true);
  });

  it('入口不是 HTML 就不取', () => {
    expect(hasFetchableHtml(site({ siteUrl: 'https://host.example/u/abc/a.pdf', entryFile: 'a.pdf' }))).toBe(false);
  });

  // 前后端各有一份同样的白名单：两边不同步时，前端会去问一个后端仍然拒绝的接口，
  // 用户看到的是「取不回正文」的角标而不是正文。这条守卫盯住那份名单本身。
  it('后端的可读包装类型名单与前端一致', () => {
    const controller = fs.readFileSync(
      path.join(__dirname, '../../../../prd-api/src/PrdAgent.Api/Controllers/Api/WebPagesController.cs'),
      'utf8',
    );
    const at = controller.indexOf('SrcDocReadableWrappers');
    expect(at, '后端名单改名了，守卫要同步').toBeGreaterThan(-1);
    const decl = controller.slice(at, at + 260);
    expect(decl).toContain('"markdown"');
    expect(decl).not.toContain('"pdf"');
    expect(decl).not.toContain('"video"');
  });
});

describe('srcDoc 安全判据（模块脚本一律退回直链）', () => {
  it('自包含的 Markdown 壳子可以走 srcDoc', () => {
    expect(canUseSrcDocPreview('<!DOCTYPE html><html><head><style>body{margin:0}</style></head><body><h1>标题</h1></body></html>')).toBe(true);
  });

  it('任何 type=module 的脚本都退回直链（三种引号写法都要认）', () => {
    expect(canUseSrcDocPreview('<script type="module" src="/a.js"></script>')).toBe(false);
    expect(canUseSrcDocPreview("<script type='module'>import './a.js'</script>")).toBe(false);
    expect(canUseSrcDocPreview('<script type=module src=/a.js></script>')).toBe(false);
  });
});

describe('CDN 注入的遥测脚本', () => {
  // 托管域名前面的 CDN 会往每份 HTML 里塞一条 type=module 的 beacon。
  // 它不是用户内容，却让 canUseSrcDocPreview 一律判否 —— 每个站点都被踢到会白屏的直链路径。
  const beacon = '<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js/v4513226?token=x"></script>';
  const page = `<!DOCTYPE html><html><body><h1>正文</h1>${beacon}</body></html>`;

  it('带 beacon 的普通页面仍然可以走 srcDoc', () => {
    expect(canUseSrcDocPreview(page)).toBe(true);
  });

  it('页面自己的 module 脚本照旧退回直链（不能被这条豁免带跑）', () => {
    expect(canUseSrcDocPreview(`${page}<script type="module" src="./app.js"></script>`)).toBe(false);
  });

  it('注入 base 时把 beacon 一并剥掉，别在访客控制台刷 CORS 报错', () => {
    const out = withPreviewBase(page, 'https://host.example/u/abc/index.html');
    expect(out).not.toContain('cloudflareinsights.com');
    expect(out).toContain('<h1>正文</h1>');
  });

  it('不做「凡是跨域 module 一律剥」——那种页面可能真靠 CDN 上的 ESM 依赖跑', () => {
    const esm = '<script type="module" src="https://esm.sh/vue@3"></script>';
    expect(canUseSrcDocPreview(`<html><body>${esm}</body></html>`)).toBe(false);
  });
});

describe('srcDoc 页内锚点', () => {
  it('注入 base 后纯片段链接仍停留在当前 srcDoc，不请求对象存储目录', () => {
    const out = withPreviewBase(
      '<html><head></head><body><a href="#risk">风险</a><section id="risk">正文</section></body></html>',
      'https://storage.example/data/web-hosting/sites/site-1/index.html',
    );

    expect(out).toContain('<base href="https://storage.example/data/web-hosting/sites/site-1/">');
    expect(out).toContain('href="about:srcdoc#risk"');
    expect(out).not.toContain('href="#risk"');
  });

  it('只改 a 与 area 的纯片段，不改资源引用、相对页面和外链', () => {
    const html = [
      '<a href=#top>顶部</a>',
      "<area href='#map'>",
      '<use href="#icon"></use>',
      '<a href="./detail.html#part">详情</a>',
      '<a href="https://example.test/#part">外链</a>',
    ].join('');
    const out = preserveSrcDocFragmentLinks(html);

    expect(out).toContain('href="about:srcdoc#top"');
    expect(out).toContain('href="about:srcdoc#map"');
    expect(out).toContain('<use href="#icon"></use>');
    expect(out).toContain('href="./detail.html#part"');
    expect(out).toContain('href="https://example.test/#part"');
  });

  it('页面自带绝对 base 时同样保护纯片段链接', () => {
    const out = withPreviewBase(
      '<html><head><base href="https://cdn.example/assets/"></head><body><a href="#summary">摘要</a></body></html>',
      'https://storage.example/site/index.html',
    );

    expect(out).toContain('<base href="https://cdn.example/assets/">');
    expect(out).toContain('href="about:srcdoc#summary"');
  });

  it('忽略 data-href 等同名后缀属性，只改真正的 href', () => {
    const out = preserveSrcDocFragmentLinks(
      `<a data-note=" href='#quoted-fake'" data-href="#tracking" aria-label="章节" href="#section">正文</a>`,
    );

    expect(out).toContain(`data-note=" href='#quoted-fake'"`);
    expect(out).toContain('data-href="#tracking"');
    expect(out).toContain('href="about:srcdoc#section"');
    expect(out).not.toContain('data-href="about:srcdoc#tracking"');
  });
});
