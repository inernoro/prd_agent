import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

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

/** prd-admin/src 全量源码文本 —— 用来核对锚点指向的文案是不是还活着。 */
function sourceText() {
  const root = new URL('../../prd-admin/src/', import.meta.url);
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const u = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
      if (e.isDirectory()) walk(u);
      else if (/\.(tsx?|ts)$/.test(e.name)) out.push(readFileSync(u, 'utf8'));
    }
  };
  walk(root);
  return out.join('\n');
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

test('每条锚点都必须真的存在于前端源码里', () => {
  // 实际栽过：/visual-agent 的锚点写「AI 驱动的设计助手」，而那句文案在改版里被换成了
  // 「今天做什么图？」。页面渲染得好好的（695 字、真实项目列表都在），判据却天天红。
  // 假红几次之后没人再看这份报告——比没有判据更糟。
  //
  // 上一条守卫只查「锚点会不会与导航重名」（恒绿的假绿），这条查反方向：
  // 锚点在源码里找不到 = 它指向的文案已经不存在了，当场变红，而不是等例程红给人看。
  const src = sourceText();
  const missing = anchors().filter((a) => !src.includes(a));
  assert.deepEqual(missing, [], `这些锚点在 prd-admin/src 里已经找不到，多半是文案改版后忘了同步：${missing.join(', ')}`);
});

test('scope 必须走参数传进浏览器，不许靠闭包', () => {
  // 实际栽过：readScoped 写成 `(sel) => (n) => {...}`，靠闭包拿 sel。
  // 但 page.evaluate 会把函数**序列化**后丢进浏览器执行，闭包一律不跟过去，
  // 于是浏览器里 sel 未定义，每次 evaluate 直接抛 ReferenceError。
  // 四条页面判据全部变成「异常」而不是「有没有字」——而上一条守卫只断言
  // 「readScoped 这个名字还在、那行 const root 还在」，两条都成立，于是守卫全绿。
  assert.ok(
    /const readScoped = \(\{ sel, n \}\) =>/.test(script),
    'readScoped 不是「解构一个参数对象」的形状，闭包里的 scope 传不进浏览器',
  );
  assert.ok(
    !/page\.evaluate\(readScoped\(/.test(script),
    'readScoped 被当成柯里化函数调用了（page.evaluate(readScoped(...))），闭包不会跟进浏览器',
  );
  assert.ok(
    /page\.evaluate\(readScoped, \{ sel:/.test(script),
    'scope 没有作为参数传给 page.evaluate',
  );
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
  assert.ok(
    /const root = sel \? document\.querySelector\(sel\) : document\.body;/.test(script),
    'scope 的解析方式变了，判据该跟着改',
  );
  // 标记必须真的存在于页面里，否则 scope 恒为 null（那会让判据静默退化）
  const page = read('prd-admin/src/pages/WebPagesPage.tsx');
  assert.ok(/data-acceptance-scope="web-pages"/.test(page), '页面上没有这个取证范围标记');
});
