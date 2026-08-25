import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasFetchableHtml, canUseSrcDocPreview } from './previewHtml';

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
