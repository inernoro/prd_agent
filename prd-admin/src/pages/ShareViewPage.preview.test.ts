import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldMaskDirectPreview, PREVIEW_MASK_TIMEOUT_MS } from './ShareViewPage';
// 判据本体已抽到 web-hosting/previewHtml.ts，让缩略图、站内大预览、分享页共用同一份
// （原先只长在分享页里，卡片缩略图另走一套，于是同一个「空白」在列表页复发）。
import { canUseSrcDocPreview, hasFetchableHtml, withPreviewBase } from '@/components/web-hosting/previewHtml';

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

  /**
   * 遮罩让位之后才回来的原文必须丢弃。
   *
   * 由第十六轮 review 抓出：遮罩到点 → 直链 iframe 已经在用户眼前跑起来了；此时代理慢悠悠
   * 回来（最长可到 20s），再把 src 换成 srcDoc，对浏览器就是换一个文档——滚动位置、
   * 表单里敲的字、PPT 翻到第几页全部清零。这条接线删掉之后没有任何单测会红（它藏在 effect
   * 的异步回调里），所以在这里按源码守住：ref 要存在，且必须在写 srcDoc 之前真的拦一道。
   */
  it('迟到的原文要不要丢，判据必须冲着「用户攒了多少状态」去', () => {
    expect(source).toContain('exposedDirectRef');

    // 2026-08-25 这条曾收紧成「遮罩已让位 **且** 直链真的加载过」，用 iframe 的 onLoad 记账。
    // 2026-08-29 第十九轮 review 推翻了后半条：直链白屏时 load 照样触发，两条双双成立，
    // 于是把唯一能救场的原文丢掉——正是这条兜底本来要修的那种页面。
    // 「文档加载完了」证明不了「画出了东西」。这条断言当时钉的就是那个不成立的证据，
    // 改成钉真正的不变量：丢弃要有第二个条件，且那个条件不许再是 load 事件。
    // 2026-08-29 第三十七轮又推翻了半条：按已过时间同样证明不了「直链画出东西没有」，
    // 它只是把一个不成立的证据换成了另一个。真正不可知的是两件事——那一帧跨源读不到，
    // 访客攒了多少状态也看不到。所以判据从「丢不丢」改成「换不换」：时间窗只决定
    // **要不要自动换**，原文一律留着并给出可见出口，由人自己点。
    const guard = source.search(
      /if\s*\(\s*exposedDirectRef\.current\s*&&\s*elapsed\s*>\s*LATE_SWAP_GUARD_MS\s*\)/);
    expect(guard, '自动换的门槛要按已过时间判，不能只看遮罩是否让位').toBeGreaterThan(-1);

    // 这一支必须是「存起来」而不是丢掉——丢掉会让「直链白屏 + 原文迟到」成为永远的白
    const branch = source.slice(guard, guard + 400);
    expect(branch, '迟到分支把原文丢了').toContain('setLateHtml(ready)');

    // 光记下来不用等于没接线：自动换要排在门槛之后
    const apply = source.indexOf('setEmbeddedHtml(ready)');
    expect(apply).toBeGreaterThan(guard);

    // 不许再拿 iframe 的 load 当「已经画出来了」的证据
    expect(source).not.toContain('directLoadedRef');

    // 每次重新取原文都要重置起点，否则第二次进来一开始就被算成迟到
    expect(source).toContain('fetchStartedAtRef.current = Date.now();');
  });

  it('既没有原文也没有入口地址时，页面要说清为什么是空的，而不是摆一个空 iframe', () => {
    // about:blank 的 iframe 在控制台一条错都没有，用户无从判断发生了什么
    expect(source).toContain('!iframeHtml && !site.siteUrl');
    expect(source).toContain('这个站点没有可加载的入口地址');
  });

  it('加载超时不产生「失败」文案——超时只是慢，不是坏', () => {
    // 超时相关的判定不得把状态置成 errored/失败
    expect(source).not.toMatch(/setErrored\(true\)[^\n]*超时/);
    expect(source).not.toMatch(/超时[^\n]*setErrored\(true\)/);
  });

  it('所有者真实预览入口接入同一套网页修改面板，并与提问坞互相让位', () => {
    expect(source).toContain('ShareSiteEditDock');
    expect(source).toContain('isOwner && !site.wrappedAssetType');
    expect(source).toContain('adjacentToAsk={Boolean(token && data.ask?.enabled)}');
    expect(source).toContain("hidden={isFullscreen || showComments || askState !== 'collapsed'}");
    expect(source).toContain('onPublished={handleOwnerSitePublished}');
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

  /**
   * 内联 module 也不走 srcDoc（review 第二轮改判）。
   *
   * 原先按「有没有 src」区分，认为内联 module 不发跨域请求。可
   * `<script type="module">import './app.js'</script>` 里的那条 import 同样是按 CORS
   * 模式发的模块请求，在不透明源下照样被拦、照样白屏。与其继续追着「哪种 module 会发
   * 跨域请求」逐条补（每补一条就是下一次漏判的温床），不如认所有 module。
   */
  it('内联 module 脚本也不走 srcDoc —— 里面的 import 同样按 CORS 模式取', () => {
    expect(canUseSrcDocPreview('<script type="module">console.log(1)</script>')).toBe(false);
    expect(canUseSrcDocPreview(`<script type="module">import './app.js'</script>`)).toBe(false);
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

  /**
   * 属性写法的等价形式必须一视同仁。
   *
   * 第一版判据写成 `type\s*=\s*["']module["']`，硬要求引号存在——而 HTML 允许
   * 不带引号的属性值，`<script type=module src=...>` 完全合法。于是这类页面被判成
   * 「能走 srcDoc」，进去之后模块脚本因缺 CORS 被拦，白屏。
   * 这就是 predicate-and-wiring-discipline 形状 1：语义相同、写法不同 → 判据翻转。
   */
  describe('属性写法的等价形式', () => {
    const moduleForms = [
      '<script type=module src=/assets/app.js></script>',
      "<script type='module' src='/assets/app.js'></script>",
      '<script type="module" src=/assets/app.js></script>',
      '<script type=module src="/assets/app.js"></script>',
      '<script TYPE=MODULE SRC="/assets/app.js"></script>',
      '<script   type = "module"   src = "/assets/app.js" ></script>',
      '<script src=/assets/app.js type=module></script>',
      '<script defer type=module src=/a.js></script>',
      '<script type="module" crossorigin src=/assets/index-DkZ1s.js></script>',
      '<script type=module>console.log(1)</script>',         // 内联 module，同样不放行
    ];

    it.each(moduleForms)('识别为 module，不走 srcDoc：%s', (html) => {
      expect(canUseSrcDocPreview(html)).toBe(false);
    });

    const safeForms = [
      '<script src=/a.js></script>',                         // 经典脚本，跨域不需要 CORS
      '<script type=text/javascript src=/a.js></script>',
      '<script type=modulepreload href=/a.js></script>',     // 不是 module，别误伤
      '<div data-type="module" data-src="/a.js"></div>',     // 压根不是 script 标签
    ];

    it.each(safeForms)('不该误判，仍可走 srcDoc：%s', (html) => {
      expect(canUseSrcDocPreview(html)).toBe(true);
    });
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

/**
 * `<base href>` 必须在 srcDoc 下仍然指向托管域名。
 *
 * 由 PR #1351 第十六轮 Codex review 抓出。相对 base（`./`、`/assets/`）在直链 iframe 里
 * 完全正确——文档 URL 就是托管域名。可一旦把同一份 HTML 注进 srcDoc，文档 URL 变成了
 * MAP 的分享页地址，`./` 于是解析到 `/s/wp/{token}/`，页面的脚本样式全都去 MAP 上找，
 * 一个都取不到，白屏。而上传通道本身会把根相对 href 改写成 `./`，这类页面真实存在。
 *
 * 原实现见到任何 `<base>` 就原样返回（"人家已经有了"），恰好把最需要改写的那一类放过了：
 * 判据比它该管的范围窄，predicate-and-wiring-discipline 形状 1。
 */
describe('withPreviewBase', () => {
  const SITE = 'https://cfi.example.org/data/web-hosting/sites/abc/index.html';
  const DIR = 'https://cfi.example.org/data/web-hosting/sites/abc/';

  it('没有 base 时注入站点目录', () => {
    const out = withPreviewBase('<html><head></head><body>x</body></html>', SITE);
    expect(out).toContain(`<base href="${DIR}">`);
  });

  it('没有 head 时也要注入', () => {
    expect(withPreviewBase('<div>x</div>', SITE)).toContain(`<base href="${DIR}">`);
  });

  it('绝对 base 原样保留 —— 人家指的就是别处，不该改', () => {
    const html = '<head><base href="https://cdn.example.com/app/"></head>';
    expect(withPreviewBase(html, SITE)).toBe(html);
  });

  it('协议相对 base 也算绝对', () => {
    const html = '<head><base href="//cdn.example.com/app/"></head>';
    expect(withPreviewBase(html, SITE)).toBe(html);
  });

  const relativeForms: Array<[string, string]> = [
    ['<head><base href="./"></head>', DIR],
    ["<head><base href='./'></head>", DIR],
    ['<head><base href=./></head>', DIR],
    ['<head><base href="/"></head>', 'https://cfi.example.org/'],
    ['<head><base href="/assets/"></head>', 'https://cfi.example.org/assets/'],
    ['<head><base href="../"></head>', 'https://cfi.example.org/data/web-hosting/sites/'],
    ['<head><BASE HREF="./"></head>', DIR],
    ['<head><base target="_blank" href="./"></head>', DIR],
  ];

  function baseHrefs(html: string): string[] {
    return [...html.matchAll(/<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/gi)]
      .map((m) => m[1] ?? m[2] ?? m[3] ?? '');
  }

  it.each(relativeForms)('相对 base 必须按站点地址重解析：%s', (html, expected) => {
    const out = withPreviewBase(html, SITE);
    // 关键断言：产物里不能再有任何相对 base —— 只要还剩一个，srcDoc 下就会解析到 MAP 自己身上
    const hrefs = baseHrefs(out);
    expect(hrefs).toEqual([expected]);
  });

  /**
   * 有 base 标签但没写 href（review 第二轮抓出）。
   *
   * `<base target="_blank">` 是完全合法的写法。原实现的正则要求 href 必须存在，
   * 匹配不上就走到「有 base 就原样返回」那一支——既不改写也不注入，而注释写的却是
   * 「当作没有，照常注入」：代码与它自己的说明相反。后果是这类页面在 srcDoc 下
   * 所有相对资源都解析到 MAP 的分享页，整页丢样式丢脚本。
   */
  it('有 base 但没写 href：必须补上站点目录，且保留原有属性', () => {
    const out = withPreviewBase('<head><base target="_blank"></head>', SITE);
    expect(baseHrefs(out)).toEqual([DIR]);
    expect(out).toContain('target="_blank"');
    expect(out.match(/<base\b/gi)?.length).toBe(1);
  });

  it('href 为空串也当作没写', () => {
    expect(baseHrefs(withPreviewBase('<head><base href=""></head>', SITE))).toEqual([DIR]);
  });

  it('改写相对 base 时保留同标签上的其它属性', () => {
    const out = withPreviewBase('<head><base target="_blank" href="./"></head>', SITE);
    expect(baseHrefs(out)).toEqual([DIR]);
    expect(out).toContain('target="_blank"');
  });

  it('相对 base 改写后不新增第二个 base 标签', () => {
    const out = withPreviewBase('<head><base href="./"><title>t</title></head>', SITE);
    expect(out.match(/<base\b/gi)?.length).toBe(1);
    // 位置要保持：base 仍在 title 之前（<head> 里的先后顺序会影响它之后的相对 URL）
    expect(out.indexOf('<base')).toBeLessThan(out.indexOf('<title>'));
  });
});

/**
 * 只有「真的有 HTML 正文」的站点才去取原文。
 *
 * 由 review 第二轮（#1356）抓出：PDF / 视频 / Markdown 包装站的入口**也是** index.html，
 * 只有 pdfAssetUrl 会被挡掉；视频与 Markdown 壳子照样发起代理请求，而后端对任何非空
 * wrappedAssetType 一律拒绝。前端把这个预期之内的拒绝当成失败，在一个本来显示正常的
 * 直链预览上盖一条错误角标——用户看到「这页出错了」，其实什么事都没有。
 */
describe('hasFetchableHtml', () => {
  const html = { siteUrl: 'https://cfi.example.org/s/a/index.html', entryFile: 'index.html' };

  it('普通 HTML 站要取正文', () => {
    expect(hasFetchableHtml(html)).toBe(true);
  });

  // 2026-08-25 收紧：不再「一律不取」。Markdown 壳子就是服务端渲染好的完整正文，
  // 它取得回来、也最适合 srcDoc；一刀切排除会让 MD 站永远走直链，那正是白屏那条路。
  // 其余包装类型（含将来新增的）保持默认不取。
  it('Markdown 包装站要取正文', () => {
    expect(hasFetchableHtml({ ...html, wrappedAssetType: 'markdown' })).toBe(true);
  });

  it.each(['pdf', 'video', 'PDF', 'audio'])('壳子里没有正文的包装站不取：%s', (type) => {
    expect(hasFetchableHtml({ ...html, wrappedAssetType: type })).toBe(false);
  });

  it('PDF 直链站不取正文', () => {
    expect(hasFetchableHtml({ ...html, pdfAssetUrl: 'https://cfi.example.org/s/a/x.pdf' })).toBe(false);
  });

  it('入口不是 html 的不取正文', () => {
    expect(hasFetchableHtml({ siteUrl: 'https://cfi.example.org/s/a/main.txt', entryFile: 'main.txt' })).toBe(false);
  });

  it('空 / null 包装类型当普通站处理', () => {
    expect(hasFetchableHtml({ ...html, wrappedAssetType: null })).toBe(true);
    expect(hasFetchableHtml({ ...html, wrappedAssetType: '' })).toBe(true);
  });
});
