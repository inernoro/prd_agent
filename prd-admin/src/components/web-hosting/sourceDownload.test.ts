import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  planSourceDownload,
  describeDownloadResult,
  sanitizeFileBaseName,
  extensionOf,
} from './sourceDownload';

describe('源文件形态判定', () => {
  it('单文件 HTML 站：下的就是完整的那一份', () => {
    const plan = planSourceDownload({ title: '拜耳 · 业务员邀请', entryFile: 'index.html', fileCount: 1 });
    expect(plan).toEqual({
      kind: 'html',
      fileName: '拜耳 · 业务员邀请.html',
      partial: false,
      fileCount: 1,
    });
    expect(describeDownloadResult(plan)).toBeNull();
  });

  it('多文件站：仍然可下，但必须说清下到的只是入口那一份', () => {
    const plan = planSourceDownload({ title: '诊断报告', entryFile: 'index.html', fileCount: 9 });
    expect(plan.kind).toBe('html');
    if (plan.kind !== 'html') throw new Error('unreachable');
    expect(plan.partial).toBe(true);
    const note = describeDownloadResult(plan);
    // 不许静默：用户手里这份不完整，这件事只能由我们说出来
    expect(note).toContain('9');
    expect(note).toContain('其余 8');
  });

  it('PDF 包装站：源文件是那份 PDF，不是壳子 HTML', () => {
    const plan = planSourceDownload({
      title: '宝洁中国全域粉销实践',
      entryFile: 'index.html',
      fileCount: 2,
      wrappedAssetType: 'pdf',
      pdfAssetUrl: 'https://i.example.net/data/x/宝洁.pdf?v=123',
    });
    expect(plan).toEqual({
      kind: 'asset',
      url: 'https://i.example.net/data/x/宝洁.pdf?v=123',
      fileName: '宝洁中国全域粉销实践.pdf',
    });
  });

  it('视频包装站：拿不到就说拿不到，不给一个点了会报错的按钮', () => {
    const plan = planSourceDownload({ title: '演示录屏', wrappedAssetType: 'video', fileCount: 2 });
    expect(plan.kind).toBe('unavailable');
    if (plan.kind !== 'unavailable') throw new Error('unreachable');
    expect(plan.reason).toContain('视频');
  });

  /**
   * 判据分裂守卫（predicate-and-wiring-discipline 形状 3）。
   *
   * 「哪些包装类型的壳子本身就是正文」这件事，后端 WebPagesController 的
   * SrcDocReadableWrappers 是 SSOT。前端另抄一份是为了在按下去之前就判出可用性，
   * 抄错的后果是：按钮看着能点，点了拿回一个 400。所以这里拿后端源码当判据，
   * 后端放行了新类型而前端忘了跟，这条会红。
   */
  it('可读包装类型必须与后端 SrcDocReadableWrappers 一致', () => {
    const controller = readFileSync(
      new URL('../../../../prd-api/src/PrdAgent.Api/Controllers/Api/WebPagesController.cs', import.meta.url),
      'utf8',
    );
    const block = /SrcDocReadableWrappers\s*=\s*[\s\S]{0,200}?\{([^}]*)\}/.exec(controller);
    expect(block, '后端那份名单不见了，判据要跟着改').not.toBeNull();
    const backendWrappers = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
    expect(backendWrappers.length).toBeGreaterThan(0);

    for (const wrapper of backendWrappers) {
      const plan = planSourceDownload({ title: 't', entryFile: 'index.html', fileCount: 1, wrappedAssetType: wrapper });
      expect(plan.kind, `后端放行了 ${wrapper}，前端却判成不可下载`).toBe('html');
    }
  });
});

/**
 * 接线守卫（predicate-and-wiring-discipline 形状 2）。
 *
 * 2026-09-18 的真实事故：一份 599KB 的托管 HTML 发给客户后，对方在某 App 的内置浏览器里
 * 打开，弹出「Download：(null) File Size：599KB」。响应头实测是 text/html、没有
 * Content-Disposition——弹窗来自那个 WebView 对**跨域 HTML 文档请求**的下载拦截。
 *
 * 所以「下载源文件」绝不能退化成给托管直链挂 a[download]：托管内容在独立域名，跨域的
 * download 属性会被浏览器忽略、退化成导航打开那份 HTML——正好是踩中同一个坑的写法。
 * 这条接线删掉之后不会有任何单测变红（它藏在一个 onClick 里），所以在这里按源码守住。
 */
describe('下载源文件的取法', () => {
  const page = readFileSync(new URL('../../pages/ShareViewPage.tsx', import.meta.url), 'utf8');

  it('正文走服务端同源代理 + Blob 落盘', () => {
    expect(page).toContain('planSourceDownload');
    expect(page).toContain('saveTextAsFile');
    // 取正文用的是已有的同源代理端点，不另开一套
    expect(page).toContain('getShareSiteContent');
  });

  /**
   * 判据是**结构性**的，不是「有没有某几个字」。
   *
   * 第一版写成「不许出现 href=siteUrl 且带 download」的正则，撤回修复试红时它没红：
   * `a.href=site.siteUrl; a.download=name;` 分成两句赋值就绕过去了（形状 1，判据比该管的窄）。
   * 改成钉「这个文件里根本不许自己造下载」——落盘动作只许经 saveTextAsFile 一个出口，
   * 那里已经规定了「内容从同源拿、Blob 落盘」。绕过它就必须先把这条守卫改掉，改不掉就得红。
   */
  it('页面里不许自己手搓下载，落盘只许经 saveTextAsFile', () => {
    const codeOnly = page
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');
    expect(codeOnly, "自己 createElement('a') 造下载：跨域 download 会被忽略、退化成导航打开").
      not.toMatch(/createElement\(\s*['"]a['"]\s*\)/);
    expect(codeOnly, '直接给元素赋 download，绕过了统一出口').not.toMatch(/\.download\s*=/);
    expect(codeOnly, 'JSX 上的 download 属性同理').not.toMatch(/\sdownload(=|\s|\/?>)/);
  });
});

describe('文件名清洗', () => {
  it('把落不了盘的字符换掉', () => {
    expect(sanitizeFileBaseName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });

  it('标题全是空白时退回兜底名，不产出一个只有扩展名的文件', () => {
    expect(sanitizeFileBaseName('   ')).toBe('page');
    expect(sanitizeFileBaseName(undefined)).toBe('page');
    expect(planSourceDownload({ entryFile: 'index.html' }).kind).toBe('html');
    const plan = planSourceDownload({ title: '  ', entryFile: 'index.html' });
    if (plan.kind !== 'html') throw new Error('unreachable');
    expect(plan.fileName).toBe('page.html');
  });

  it('末尾的点要去掉——Windows 会连扩展名一起吞掉', () => {
    expect(sanitizeFileBaseName('方案 v2...')).toBe('方案 v2');
  });

  it('超长标题截断，但不至于把扩展名挤没', () => {
    expect(sanitizeFileBaseName('长'.repeat(200)).length).toBe(80);
  });
});

describe('扩展名提取', () => {
  it('带 query 与 hash 的 URL 也能取对', () => {
    expect(extensionOf('https://x.net/a/b.pdf?v=1#p=2')).toBe('.pdf');
  });

  it('入口是 .htm 就用 .htm，不强行改成 .html', () => {
    const plan = planSourceDownload({ title: 't', entryFile: 'index.htm', fileCount: 1 });
    if (plan.kind !== 'html') throw new Error('unreachable');
    expect(plan.fileName).toBe('t.htm');
  });

  it('没有扩展名或扩展名不像扩展名时给空串', () => {
    expect(extensionOf('https://x.net/a/b')).toBe('');
    expect(extensionOf('a.')).toBe('');
    expect(extensionOf('.bashrc')).toBe('');
    expect(extensionOf('x.this-is-not-an-ext')).toBe('');
    expect(extensionOf(undefined)).toBe('');
  });
});
