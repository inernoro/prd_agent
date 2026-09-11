/**
 * 首页厂房动效的接线守卫（2026-09-11）。
 *
 * 这套动效有一个特别糟糕的失效方式：**它坏掉的时候不报错，只是少了一半画面**。
 * 入场动画都是 `from{opacity:0}`，一旦某个类名拼错、keyframes 改名、或者有人
 * 把 animation 从 no-preference 媒体块里挪出去，结果不是「没动效」，而是
 * 「元素永远停在 opacity:0」——整块空白，编译过、类型过、测试全绿。
 * 这正是 predicate-and-wiring-discipline 形状 8（把不成立的证据当证据）与
 * 形状 2（链路只建一半）在 CSS 上的形态。
 *
 * 所以这里守四件事，每一件都对应一种已经能预见的坏法：
 *   1. animation 引用的 keyframes 必须存在，且定义了的 keyframes 必须有人用；
 *   2. 所有 animation 声明必须待在 prefers-reduced-motion: no-preference 里
 *      （守 reduce 用户，也守「动画没跑时画面仍然完整」这条兜底）；
 *   3. 基础样式（媒体块之外）不许出现 opacity:0 / transform / animation
 *      ——基础态必须就是终态；
 *   4. CSS 里定义的每个动画类都要在 JSX 里被真的挂上去，反之亦然。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const src = readFileSync(resolve(__dirname, '../..', 'web/src/pages/reports/PipelinePanel.tsx'), 'utf8');

/** 取出 SCENE_CSS 模板字符串的内容。 */
const css = (() => {
  const m = src.match(/const SCENE_CSS = `([\s\S]*?)\n`;/);
  expect(m, 'SCENE_CSS 模板字符串没找到——改了名字就得来更新这条守卫').not.toBeNull();
  return m![1];
})();

/** 把 no-preference 媒体块整段切出来，剩下的就是基础样式。 */
const motionBlock = (() => {
  const i = css.indexOf('@media (prefers-reduced-motion: no-preference){');
  expect(i, '动效没有关在 prefers-reduced-motion: no-preference 媒体块里').toBeGreaterThan(-1);
  // 媒体块到第一个单独成行的 '}' 为止（块内规则都带缩进，收尾的 } 顶格）。
  const rest = css.slice(i);
  const end = rest.indexOf('\n}');
  expect(end, '媒体块没有收尾的 }').toBeGreaterThan(-1);
  return rest.slice(0, end + 2);
})();

// 基础样式 = 去掉媒体块，再去掉所有 @keyframes 定义。
// keyframes 里写 opacity:0 / transform 是它的本职，不该被下面那两条断言算作违规。
const baseCss = css
  .replace(motionBlock, '')
  .replace(/@keyframes[\s\S]*?\n?\}/g, '')
  // 注释里照抄了 opacity:0 这几个字（就在说明为什么不许写），不剥掉会自己把自己判红。
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('厂房动效：keyframes 两头都要接上', () => {
  it('animation 引用的 keyframes 都有定义', () => {
    const used = [...css.matchAll(/animation:\s*([a-z-]+)/g)].map((m) => m[1]);
    const defined = new Set([...css.matchAll(/@keyframes\s+([a-z-]+)/g)].map((m) => m[1]));
    expect(used.length, '一条 animation 都没有——动效被删光了？').toBeGreaterThan(0);
    for (const name of used) {
      expect(defined.has(name), `animation 用了 ${name}，但没有对应的 @keyframes`).toBe(true);
    }
  });

  it('定义的 keyframes 都有人用（没有孤儿）', () => {
    const used = new Set([...css.matchAll(/animation:\s*([a-z-]+)/g)].map((m) => m[1]));
    const defined = [...css.matchAll(/@keyframes\s+([a-z-]+)/g)].map((m) => m[1]);
    for (const name of defined) {
      expect(used.has(name), `@keyframes ${name} 没有任何规则引用它`).toBe(true);
    }
  });
});

describe('厂房动效：不动的那一档必须是完整画面', () => {
  it('所有 animation 声明都在 no-preference 媒体块内', () => {
    expect(baseCss).not.toMatch(/animation:/);
  });

  it('基础样式不写 opacity:0 / transform —— 基础态就是终态', () => {
    // 动画全是 from{opacity:0}。基础样式里再写一次 opacity:0，
    // 就等于 reduce 用户（以及动画没触发的任何情况）永远看不到那个元素。
    expect(baseCss).not.toMatch(/opacity\s*:\s*0(\D|$)/);
    expect(baseCss).not.toMatch(/(^|[;{\s])transform\s*:/);
  });

  it('每条入场动画都带 backwards，延迟期间不会先闪一下', () => {
    const lines = motionBlock.split('\n').filter((l) => /animation:/.test(l));
    for (const line of lines) {
      if (/infinite/.test(line)) continue; // 常驻的那一条没有延迟，不需要 backwards
      expect(line, `这条动画没写 backwards：${line.trim()}`).toMatch(/backwards/);
    }
  });
});

describe('厂房动效：类名两头都要挂上', () => {
  const cssClasses = new Set([...css.matchAll(/\.(pp-(?!root|scene)[a-z-]+)/g)].map((m) => m[1]));
  // JSX 里的类名散落在 className 字符串与模板字符串里，统一按词扫；
  // SVG pattern 的 id 也叫 pp-*（pp-rib / pp-nodata），按 id= 声明把它们摘掉。
  const patternIds = new Set([...src.matchAll(/id="(pp-[a-z-]+)"/g)].map((m) => m[1]));
  const jsxClasses = new Set(
    [...src.replace(css, '').matchAll(/\b(pp-(?!root|scene)[a-z-]+)\b/g)]
      .map((m) => m[1])
      .filter((c) => !patternIds.has(c)),
  );

  it('CSS 里定义的动画类都在 JSX 里被挂上了', () => {
    expect(cssClasses.size).toBeGreaterThan(0);
    for (const c of cssClasses) {
      expect(jsxClasses.has(c), `CSS 定义了 .${c}，但 JSX 里没有任何元素挂它`).toBe(true);
    }
  });

  it('JSX 里挂的动画类都在 CSS 里有规则', () => {
    for (const c of jsxClasses) {
      if (c.startsWith('pp-crate-in') || /-in$/.test(c) || c === 'pp-roll') continue; // keyframes 名字不是类名
      expect(cssClasses.has(c), `JSX 挂了 ${c}，但 CSS 里没有这条规则——动效静默不生效`).toBe(true);
    }
  });
});

describe('厂房动效：开关必须同源', () => {
  it('CSS 的 data-play 与 Card 上写入的属性是同一个', () => {
    expect(motionBlock).toMatch(/\[data-play="1"\]/);
    expect(src).toMatch(/data-play=\{play \? '1' : '0'\}/);
  });

  it('数字计数在拿不到播放信号时显示的是真值，不是 0', () => {
    // CountText 的初值必须是 n；写成 useState(0) 会在 play 没来时把 0 当数据显示。
    expect(src).toMatch(/const \[v, setV\] = useState\(n\)/);
  });
});
