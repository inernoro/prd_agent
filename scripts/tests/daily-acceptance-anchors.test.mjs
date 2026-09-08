import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readScoped } from '../smoke/lib/scoped-text.mjs';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const script = read('scripts/smoke/daily-acceptance.mjs');
const navRegistry = read('prd-admin/src/app/navRegistry.tsx');

/** 从脚本里把 PAGES 的 anchor 逐条抠出来（只读源码，不执行——它会起浏览器）。 */
function anchors() {
  const block = script.slice(script.indexOf('const PAGES = ['), script.indexOf('const results = ['));
  return [...block.matchAll(/anchor:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** navRegistry 里所有导航项的 label —— 这些字在左侧栏常驻渲染，路由渲不渲染都在。 */
function navLabels() {
  return new Set([...navRegistry.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1]));
}

test('每日验收的锚点不许与外壳导航重名', () => {
  // 实际栽过：/web-pages 的锚点写「网页托管」，而 navRegistry 里这一项的 label 逐字相同。
  // checkPageAlive 在整个 body 上找，于是这条路由**渲不渲染都命中**——判据形同虚设，
  // 而它恰恰是为了防「页面白屏但报告全绿」才加的。
  //
  // 这条守卫是机械交叉核对：以后有人换锚点、或给导航加同名项，立刻会红。
  const labels = navLabels();
  assert.ok(labels.size > 5, `navRegistry 只解析出 ${labels.size} 个 label，解析多半失效了`);

  const found = anchors();
  assert.ok(found.length >= 5, `只解析出 ${found.length} 条锚点，解析多半失效了`);

  const clash = found.filter((a) => labels.has(a));
  assert.deepEqual(clash, [], `这些锚点与左侧导航重名，路由不渲染也会命中：${clash.join(', ')}`);
});

test('文本形态不许退到像素证据判绿', () => {
  // 像素兜底是给 PDF / 视频这类插件渲染的包装站留的（innerText 本来就是空的）。
  // 用在文本形态上，一张彩色的 HTTP 200 占位页、客户端错误页、别人的文档都能凑够 8 种颜色，
  // 于是「内容没了」被判成健康——正是这条验收要防的形态。
  assert.ok(/textual:\s*true/.test(script), 'FORMS 里没有声明文本形态');
  assert.ok(
    /const pixelOk\s*=\s*!form\.textual/.test(script),
    '像素兜底没有排除文本形态',
  );
  // 声明为文本形态的条数必须与真的带 marker 的条数一致，别漏标
  const textual = (script.match(/textual:\s*true/g) || []).length;
  const markers = (script.match(/marker:\s*'/g) || []).length;
  assert.equal(textual, markers, '有形态带了 marker 却没标 textual（或反过来）');
});

test('声明了 scope 的路由，锚点与字数都只看那一块', () => {
  // 外壳（导航 + 告警条）本身上百字，在 body 上数字数等于路由渲不渲染都够。
  assert.ok(/scope:\s*'\[data-acceptance-scope=/.test(script), '没有任何路由声明取证范围');
  assert.ok(/readScoped/.test(script), 'checkPageAlive 没有按 scope 取文本');
  // 取文本的实现已经搬进 lib/scoped-text.mjs（为了能被上面那条守卫真的执行）。
  // 这里只确认主脚本确实用的是那一份，别再长出第二份实现（形状 3：判据分裂）。
  assert.ok(
    /from '\.\/lib\/scoped-text\.mjs'/.test(script),
    '主脚本没有引用共享的取证实现',
  );
  assert.ok(
    !/const readScoped\s*=/.test(script),
    '主脚本里又长出了一份本地 readScoped —— 判据会和共享实现漂移',
  );
  // 标记必须真的存在于页面里，否则 scope 恒为 null（那会让判据静默退化）
  const page = read('prd-admin/src/pages/WebPagesPage.tsx');
  assert.ok(/data-acceptance-scope="web-pages"/.test(page), '页面上没有这个取证范围标记');
});

test('取证函数必须能在浏览器里独立求值（真执行，不是扫源码）', () => {
  // 复刻 page.evaluate 的真实机制：它把函数 **toString 成源码** 送进浏览器再求值，
  // 所以模块作用域/闭包一律不跟过去。这里用 new Function 在一个没有闭包的上下文里
  // 按同样的方式重建再执行 —— 柯里化写法在这一步就会原样炸出 ReferenceError，
  // 正是 2026-08-29 f3dcff1 在线上的形态。
  //
  // 这比扫 `page.evaluate(readScoped, [` 这种字面拼写强在两头：
  // 行为对了就不会因为改写法误红，行为坏了也不会因为源码里还留着那串字而漏绿。
  const rebuilt = new Function(`return (${readScoped.toString()})`)();

  const run = (text, args, selHit = true) => {
    const root = { innerText: text };
    const prev = Object.getOwnPropertyDescriptor(globalThis, 'document');
    globalThis.document = { body: root, querySelector: () => (selHit ? root : null) };
    try {
      return rebuilt(args);
    } finally {
      if (prev) Object.defineProperty(globalThis, 'document', prev);
      else delete globalThis.document;
    }
  };

  // 不声明 scope：读整页，空白全部压掉后计字
  assert.deepEqual(run('  你好   世界 ', [null, null]), { chars: 4, hit: false });
  // 锚点命中要穿过空白（页面上的字常被标签断开）
  assert.deepEqual(run('你 好\n世界', [null, '你好世界']), { chars: 4, hit: true });
  // 声明了 scope 就只看那一块 —— 这正是闭包版拿不到 sel 而炸掉的那条路径
  assert.deepEqual(run('局部文字', ['[data-acceptance-scope="web-pages"]', '局部']), { chars: 4, hit: true });
  // scope 选不中要返回 null，让调用方知道判据没生效，而不是悄悄退回整页
  assert.equal(run('整页文字', ['[data-missing]', '整页'], false), null);
});

test('页面取证失败也必须把 page 关掉', () => {
  // 漏关的页会一直攥着隧道连接，于是「一条用例坏」滚成「后面每条都 goto 超时」，
  // 真正红的原因被彻底盖住 —— 2026-08-29 那次就是这么把 5 条红读成 6 条的。
  const fn = script.slice(script.indexOf('async function checkPageAlive'), script.indexOf('// ── 主流程 ──'));
  assert.ok(/finally\s*\{[\s\S]*?page\.close\(\)/.test(fn), 'checkPageAlive 没有在 finally 里关页');
  assert.ok(/try\s*\{[\s\S]*?page\.goto\(/.test(fn), 'goto 在 try 之外：它超时同样会漏页');
});
