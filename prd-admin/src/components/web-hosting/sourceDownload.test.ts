import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  planSourceDownload,
  sanitizeFileBaseName,
  extensionOf,
  OFFLINE_EXPORT_MAX_BYTES,
} from './sourceDownload';

describe('源文件形态判定', () => {
  it('单文件 HTML 站：下载离线版', () => {
    const plan = planSourceDownload({ title: '拜耳 · 业务员邀请', entryFile: 'index.html', fileCount: 1 });
    expect(plan).toEqual({
      kind: 'html',
      fileName: '拜耳 · 业务员邀请.html',
      fileCount: 1,
    });
  });

  /**
   * 多文件站此前只能下到入口那一份（取正文代理只取入口），图片样式全丢，只好标 partial 再补一句说明。
   * 现在走离线打包，样式、脚本、图片都内嵌进一个文件——「只下到一部分」这一档不再存在，
   * 真漏了哪几处由服务端在响应头里逐条报（见 offlineExport.test.ts）。
   */
  it('多文件站：同样下载离线版，不再是「只有入口那一份」', () => {
    const plan = planSourceDownload({ title: '诊断报告', entryFile: 'index.html', fileCount: 9 });
    expect(plan.kind).toBe('html');
    expect(plan).not.toHaveProperty('partial');
  });

  /**
   * PDF 这一档只能「打开」，不能「下载」——而且必须在**类型上**就说清楚。
   *
   * Codex 第一轮 P2：原先它返回 `kind: 'asset'` 且带一个 fileName，界面却只是
   * window.open，fileName 从头到尾没被用过，于是「下载源文件」这个按钮对 PDF 站名不副实。
   * 真要落盘就得 fetch 到 Blob，而托管域名的 CORS 是逐个域名配的白名单——生产在里面、
   * 分支预览域名不在（2026-09-20 实测），做出来就是「生产能用、预览不能用」。
   * 所以这一档老实叫 open，且**不带 fileName**：算了却用不上的值就是下一次误解的起点。
   */
  it('PDF 包装站：只能在新窗口打开，不带 fileName', () => {
    const plan = planSourceDownload({
      title: '宝洁中国全域粉销实践',
      entryFile: 'index.html',
      fileCount: 2,
      wrappedAssetType: 'pdf',
      pdfAssetUrl: 'https://i.example.net/data/x/宝洁.pdf?v=123',
    });
    expect(plan).toEqual({ kind: 'open', url: 'https://i.example.net/data/x/宝洁.pdf?v=123' });
    expect(plan).not.toHaveProperty('fileName');
  });

  it('视频包装站：拿不到就说拿不到，不给一个点了会报错的按钮', () => {
    const plan = planSourceDownload({ title: '演示录屏', wrappedAssetType: 'video', fileCount: 2 });
    expect(plan.kind).toBe('unavailable');
    if (plan.kind !== 'unavailable') throw new Error('unreachable');
    expect(plan.reason).toContain('视频');
  });

  /**
   * 入口文件**自己**就超过离线打包上限的，内嵌之后只会更大，按下去必然失败——按之前就说清并给替代路径。
   */
  it('入口文件超过打包上限：不宣称能下，直接说清并给替代路径', () => {
    const plan = planSourceDownload({
      title: '巨型单页', entryFile: 'index.html', fileCount: 1,
      entrySize: OFFLINE_EXPORT_MAX_BYTES + 1,
    });
    expect(plan.kind).toBe('unavailable');
    if (plan.kind !== 'unavailable') throw new Error('unreachable');
    expect(plan.reason).toContain('20MB');
    expect(plan.reason, '只说不行不够，要给下一步').toContain('新窗口打开');
  });

  it('入口恰好压线的照常能下（上限量的是打包产物，压线的入口交给服务端判）', () => {
    expect(planSourceDownload({
      title: 't', entryFile: 'index.html', fileCount: 1, entrySize: OFFLINE_EXPORT_MAX_BYTES,
    }).kind).toBe('html');
  });

  /**
   * 判据只认入口自己的大小，与站点有几个文件、总共多大无关：目录里躺着一个没被引用的大视频，
   * 不该把整站拦掉——引用了什么只有服务端量得准。
   */
  it('入口不大就不拦，哪怕整站几百 MB（判据只认入口那一份）', () => {
    expect(planSourceDownload({
      title: 't', entryFile: 'index.html', fileCount: 30, entrySize: 50 * 1024,
    }).kind).toBe('html');
  });

  it('后端给不出入口大小（0）时不拦——不凭一个不知道的数拦掉本来下得动的站点', () => {
    expect(planSourceDownload({ title: 't', entryFile: 'index.html', fileCount: 1 }).kind).toBe('html');
  });

  /**
   * 判据分裂守卫（predicate-and-wiring-discipline 形状 3）。
   *
   * 「哪些包装类型的壳子本身就是正文、能打离线包」这件事，后端 HostedSiteService 的
   * IsRevisionReadableWrapper 是 SSOT（离线打包服务直接调它）。前端另抄一份是为了在按下去之前
   * 就判出可用性，抄错的后果是：按钮看着能点，点了拿回一个 400。所以这里拿后端源码当判据，
   * 后端放行了新类型而前端忘了跟，这条会红。
   */
  it('可读包装类型必须与后端 IsRevisionReadableWrapper 一致', () => {
    const service = readFileSync(
      new URL('../../../../prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteService.cs', import.meta.url),
      'utf8',
    );
    const exporter = readFileSync(
      new URL('../../../../prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteOfflineExportService.cs', import.meta.url),
      'utf8',
    );
    expect(exporter, '离线打包必须复用这条判据，不许自己另写一份').toContain('HostedSiteService.IsRevisionReadableWrapper(');
    const block = /IsRevisionReadableWrapper\(string\? wrappedAssetType\) =>([\s\S]{0,300}?);/.exec(service);
    expect(block, '后端那条判据不见了，判据要跟着改').not.toBeNull();
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

  it('下载走离线打包端点，落盘经共用 hook 的同源 Blob 出口', () => {
    expect(page).toContain('planSourceDownload');
    expect(page).toContain('downloadShareOfflineHtml');
    expect(page).toContain('useOfflineExport');
    const hook = readFileSync(new URL('./useOfflineExport.ts', import.meta.url), 'utf8');
    expect(hook).toContain('saveBlobAsFile(file.blob, file.fileName)');
  });

  /**
   * 取不到源文件时，原因必须在**交互之前**就看得见，且不靠一个假的可点控件送达。
   *
   * 这个点来回过三轮，三轮各错一处，值得逐条记着：
   * 1. 最初：按钮看着能用，点下去才说「取不到」，触屏连 title 都露不出来（Codex 轮一 P2）。
   * 2. 改成「干脆不渲染按钮」：`reason` 就再没人看得到——算出来却送不到眼前（形状 2）。
   * 3. 改成可点的 `aria-disabled`：宣称不可用、却必须点它才肯说为什么。屏读用户被告知
   *    不可用会跳过，视觉用户看到禁用光标也会跳过，键盘激活还与宣称的状态矛盾（轮六 P2）。
   *
   * 三轮都在「这个按钮该是什么状态」里打转。定版把原因**搬出按钮**：unavailable 一档
   * 说明条常驻（交互前可见、屏读可达、不需要点），按钮不渲染——于是那个自相矛盾的控件
   * 不再需要存在。两边都钉住：少了哪一边都会红。
   */
  it('unavailable 一档不渲染按钮，原因在交互前就常驻可见', () => {
    expect(page).toMatch(/isAuthenticated && downloadPlan\.kind !== 'unavailable' &&/);
    expect(page).toMatch(/downloadPlan\.kind === 'unavailable'\s*\?\s*\{ text: downloadPlan\.reason/);
    // 不许退回「灰着但可点」：那正是轮六指出的自相矛盾。
    expect(page, "aria-disabled 的可点控件：宣称不可用却要点了才说原因").
      not.toMatch(/aria-disabled=\{downloadPlan\.kind === 'unavailable'/);
    // 也不许退回原生 disabled 把这一档钉死成一个哑控件。
    expect(page).not.toMatch(/(?<!aria-)disabled=\{[^}]*downloadPlan\.kind === 'unavailable'/);
    // 常驻那条不给关闭按钮——关掉就又看不见了，等于回到第 2 版。
    expect(page).toMatch(/visibleNote\.dismissible && \(/);
  });

  /**
   * 下载不许退回取正文代理（Codex 第五轮 P2 那条遥测问题的根治）。
   *
   * 取正文代理读的是托管域名经 CDN 服务出来的那一份：CDN 往每份 HTML 里塞一条 cloudflareinsights
   * beacon，那段脚本不是分享者写的，此前只好在落盘前剥掉；而且它只取入口一个文件、上限 2MB。
   * 离线打包从对象存储按文件清单读原字节，不经 CDN——剥遥测这一步随之不再需要。
   * 这里钉的是「下载那段逻辑里不再出现取正文代理」：谁把下载退回代理，这条会红。
   */
  it('下载那段逻辑不再走取正文代理', () => {
    const start = page.indexOf('const handleDownloadSource');
    const end = page.indexOf('const fetchShare', start);
    expect(start).toBeGreaterThan(0);
    const block = page.slice(start, end);
    expect(block).not.toContain('getShareSiteContent');
    expect(block).toContain('downloadShareOfflineHtml');
  });

  it('打包中的进度以文字常驻在说明条里（手机上按钮只剩图标）', () => {
    expect(page).toMatch(/downloading\s*\?\s*\{ text: `\$\{offlineExportLabel\}/);
  });

  it('PDF 一档的按钮文案是「打开」不是「下载」', () => {
    // 它做的就是 window.open，文案必须跟着实情走，不宣称一个做不到的动作
    expect(page).toMatch(/downloadPlan\.kind === 'open' \? '打开源文件'/);
  });

  /**
   * 判据是**结构性**的，不是「有没有某几个字」。
   *
   * 第一版写成「不许出现 href=siteUrl 且带 download」的正则，撤回修复试红时它没红：
   * `a.href=site.siteUrl; a.download=name;` 分成两句赋值就绕过去了（形状 1，判据比该管的窄）。
   * 改成钉「这个文件里根本不许自己造下载」——落盘动作只许经 saveBlobAsFile 一个出口，
   * 那里已经规定了「内容从同源拿、Blob 落盘」。绕过它就必须先把这条守卫改掉，改不掉就得红。
   */
  it('页面里不许自己手搓下载，落盘只许经 saveBlobAsFile', () => {
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

describe('打包上限必须与后端一致', () => {
  it('OFFLINE_EXPORT_MAX_BYTES 跟得上后端 HostedSiteHtmlInliner.DefaultMaxOutputBytes', () => {
    const inliner = readFileSync(
      new URL('../../../../prd-api/src/PrdAgent.Infrastructure/Services/HostedSiteHtmlInliner.cs', import.meta.url),
      'utf8',
    );
    const m = /DefaultMaxOutputBytes\s*=\s*([0-9]+)L?\s*\*\s*1024\s*\*\s*1024/.exec(inliner);
    expect(m, '后端那个上限改写法了，判据要跟着改').not.toBeNull();
    expect(OFFLINE_EXPORT_MAX_BYTES).toBe(Number(m![1]) * 1024 * 1024);
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
