import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  planSourceDownload,
  describeDownloadResult,
  describeDownloadFailure,
  sanitizeFileBaseName,
  extensionOf,
  SOURCE_PROXY_MAX_BYTES,
  SOURCE_DOWNLOADABLE_MAX_BYTES,
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
   * 超过代理上限的单文件站，按下去必然失败（Codex 第二轮 P2）。
   *
   * 取正文那条路由读满 2MB 就断，而托管上传允许到 500MB——两个数字差两个量级。
   * 与其让用户点一次换一个后端报错，不如在按下之前就判出来并说清替代路径。
   */
  it('入口文件超过代理上限：不宣称能下，直接说清并给替代路径', () => {
    const plan = planSourceDownload({
      title: '巨型单页', entryFile: 'index.html', fileCount: 1,
      entrySize: SOURCE_PROXY_MAX_BYTES + 1,
    });
    expect(plan.kind).toBe('unavailable');
    if (plan.kind !== 'unavailable') throw new Error('unreachable');
    expect(plan.reason).toContain('2MB');
    expect(plan.reason, '只说不行不够，要给下一步').toContain('新窗口打开');
  });

  /**
   * 边界上两个数量的**量纲不一样**（Codex 第七轮 P2）。
   *
   * `entrySize` 是存进对象存储的字节，后端 `maxBytes` 量的是 CDN 服务出来的字节，中间隔着
   * CDN 注入的遥测。所以「恰好压线」不是安全的——它取回来必然超，点一次必然失败。
   * 判据因此改用 `SOURCE_DOWNLOADABLE_MAX_BYTES`（代理上限减去注入余量）。
   */
  it('恰好压在代理上限上的，取回时会被注入撑破，要拦', () => {
    expect(planSourceDownload({
      title: 't', entryFile: 'index.html', fileCount: 1, entrySize: SOURCE_PROXY_MAX_BYTES,
    }).kind, '存储 2MB + CDN 注入 = 必然超代理上限').toBe('unavailable');
  });

  it('余量之内的照常能下，不因为留余量就把好站点误伤掉', () => {
    expect(planSourceDownload({
      title: 't', entryFile: 'index.html', fileCount: 1, entrySize: SOURCE_DOWNLOADABLE_MAX_BYTES,
    }).kind).toBe('html');
    expect(planSourceDownload({
      title: 't', entryFile: 'index.html', fileCount: 1, entrySize: SOURCE_DOWNLOADABLE_MAX_BYTES + 1,
    }).kind).toBe('unavailable');
  });

  it('余量必须为正且小于代理上限（写反了会把所有站点都拦掉）', () => {
    expect(SOURCE_DOWNLOADABLE_MAX_BYTES).toBeGreaterThan(0);
    expect(SOURCE_DOWNLOADABLE_MAX_BYTES).toBeLessThan(SOURCE_PROXY_MAX_BYTES);
  });

  /**
   * 判据认的是**入口文件自己**的大小，与站点有几个文件无关。
   *
   * 上一版拿 totalSize 近似，只好写成「只对单文件站判」；那个特例又把「多文件站里入口
   * 本身超 2MB」漏掉了（Codex 第四轮 P2）。换成后端给的 entrySize 之后，两种站点同一条判据。
   */
  it('多文件站里入口自己超限，同样要拦', () => {
    expect(planSourceDownload({
      title: 't', entryFile: 'index.html', fileCount: 30, entrySize: SOURCE_PROXY_MAX_BYTES + 1,
    }).kind).toBe('unavailable');
  });

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
   * 落盘前必须剥掉 CDN 在传输途中注入的遥测（Codex 第五轮 P2）。
   *
   * 取正文走的是托管域名对外服务的那一份，而托管域名前面挂着 CDN，它会往每一份 HTML 里
   * 塞一条 cloudflareinsights 的 beacon（previewHtml.ts 的 stripInjectedTelemetry 就是为它
   * 写的，2026-08-25 每日验收抓到过：自己传的 200 字节纯 HTML 取回来 9336 字节）。
   * 那段脚本不是分享者写的，跟着下载文件跑出去就是一条第三方请求。
   *
   * 预览已经剥了，下载没剥 = 同一件事两个口径（形状 3）。这里钉的是「共用同一个判据」，
   * 不是「文案里有没有 beacon 几个字」——真去删掉那个调用，这条会红。
   */
  it('落盘前剥掉传输途中注入的遥测，与预览共用同一判据', () => {
    expect(page).toMatch(/saveTextAsFile\(\s*stripInjectedTelemetry\(/);
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

/**
 * 失败文案必须是人话（external-cause-first）。
 *
 * Codex 第二轮 P2：后端那条路由的报错是协议口径的（`站点内容读取失败（HTTP 404）`），
 * 原样端给访客等于把「这什么意思、我该怎么办」的推导工作转嫁给他。
 */
describe('失败文案', () => {
  it('超限：说清为什么 + 去哪儿', () => {
    const out = describeDownloadFailure('站点入口文件超过 2MB，不支持读取');
    expect(out.text).toContain('新窗口打开');
    expect(out.text).not.toContain('2MB，不支持读取');
  });

  it('404：说的是「文件不在了」，不是一个 HTTP 码', () => {
    const out = describeDownloadFailure('站点内容读取失败（HTTP 404）');
    expect(out.text).toContain('分享者');
    expect(out.text).not.toMatch(/HTTP\s*404/);
  });

  /**
   * 认得出来的错误**不带**原始报错。
   *
   * 读者是分享链接的外部访客，不是运维：受控文案已经说清了怎么回事，再摆一句
   * `HTTP 404` 增量为零（Codex 第四轮 P2）。认不出来的那一档反过来——见下一条。
   */
  it('认得出来的错误不把 HTTP 细节带给访客', () => {
    expect(describeDownloadFailure('站点内容读取失败（HTTP 404）').detail).toBeUndefined();
    expect(describeDownloadFailure('站点内容读取失败（HTTP 502）').detail).toBeUndefined();
    expect(describeDownloadFailure('站点入口文件超过 2MB，不支持读取').detail).toBeUndefined();
  });

  it('认不出来时保留原文——那是访客唯一能转述给分享者的线索', () => {
    const out = describeDownloadFailure('something weird');
    expect(out.text).toContain('稍后再试');
    expect(out.detail).toBe('something weird');
  });

  it('后端没给 message 时不渲染空附注', () => {
    expect(describeDownloadFailure(undefined).detail).toBeUndefined();
    expect(describeDownloadFailure('   ').detail).toBeUndefined();
  });

  it('每条规则都要有真实样本命中，不留永不生效的死规则', () => {
    // 覆盖守卫：三条规则各自对应一句后端真实会返回的文案
    const samples = [
      '站点入口文件超过 2MB，不支持读取',
      '站点内容读取失败（HTTP 404）',
      '站点内容读取失败（HTTP 502）',
    ];
    const texts = new Set(samples.map((s) => describeDownloadFailure(s).text));
    expect(texts.size, '有规则没被任何样本命中，或两条规则产出了同一句话').toBe(3);
  });
});

describe('代理上限必须与后端一致', () => {
  it('SOURCE_PROXY_MAX_BYTES 跟得上后端的 maxBytes', () => {
    const controller = readFileSync(
      new URL('../../../../prd-api/src/PrdAgent.Api/Controllers/Api/WebPagesController.cs', import.meta.url),
      'utf8',
    );
    const m = /const long maxBytes\s*=\s*([0-9]+)L?\s*\*\s*1024\s*\*\s*1024/.exec(controller);
    expect(m, '后端那个上限改写法了，判据要跟着改').not.toBeNull();
    expect(SOURCE_PROXY_MAX_BYTES).toBe(Number(m![1]) * 1024 * 1024);
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
