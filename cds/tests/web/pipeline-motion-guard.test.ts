/**
 * 首页紧凑条动效的接线守卫（2026-09-14 随 B 稿重写）。
 *
 * 这套动效有一个特别糟糕的失效方式：**它坏掉的时候不报错，只是少了一半画面**。
 * 入场动画都是 `from{opacity:0}` / `from{transform:scaleX(0)}`，一旦某个类名拼错、
 * keyframes 改名、或者有人把 animation 从 no-preference 媒体块里挪出去，结果不是
 * 「没动效」，而是「元素永远停在 opacity:0 / scaleX(0)」——整块空白，编译过、
 * 类型过、测试全绿。这正是 predicate-and-wiring-discipline 形状 8（把不成立的证据
 * 当证据）与形状 2（链路只建一半）在 CSS 上的形态。
 *
 * 上一版守的是厂房剖面的 SCENE_CSS。厂房整体换成紧凑条之后那个锚点没了，
 * 但它防的坏法一件都没少，只是换了文件与类名，所以是重写不是删除。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const src = readFileSync(resolve(__dirname, '../..', 'web/src/pages/reports/CompactStrip.tsx'), 'utf8');

/** 取出 STRIP_CSS 模板字符串的内容（文档注释里也提到 hsl()/animation，不能一起扫）。 */
const css = (() => {
  const m = src.match(/export const STRIP_CSS = `([\s\S]*?)\n`;/);
  expect(m, 'STRIP_CSS 模板字符串没找到——改了名字就得来更新这条守卫').not.toBeNull();
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
  .replace(/\/\*[\s\S]*?\*\//g, '');

describe('紧凑条动效：keyframes 两头都要接上', () => {
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
    expect(defined.length).toBeGreaterThan(0);
    for (const name of defined) {
      expect(used.has(name), `@keyframes ${name} 没有任何规则引用它`).toBe(true);
    }
  });
});

describe('紧凑条动效：不动的那一档必须是完整画面', () => {
  it('所有 animation 声明都在 no-preference 媒体块内', () => {
    expect(baseCss).not.toMatch(/animation:/);
  });

  it('基础样式不写 opacity:0 / transform —— 基础态就是终态', () => {
    // 动画全是 from{opacity:0} / from{transform:scale*(0)}。基础样式里再写一次，
    // 就等于 reduce 用户（以及动画没触发的任何情况）永远看不到那个元素。
    expect(baseCss).not.toMatch(/opacity\s*:\s*0(\D|$)/);
    expect(baseCss).not.toMatch(/(^|[;{\s])transform\s*:/);
  });

  it('每条入场动画都带 backwards，延迟期间不会先闪一下', () => {
    const decls = motionBlock.match(/animation:[^;]+;/g) ?? [];
    expect(decls.length).toBeGreaterThan(0);
    for (const d of decls) {
      if (/infinite/.test(d)) continue; // 常驻的那一条没有延迟，不需要 backwards
      expect(d, `这条动画没写 backwards：${d.trim()}`).toMatch(/backwards/);
    }
  });
});

describe('紧凑条动效：动的每个选择器都得有基础规则', () => {
  // 只建一半的典型：媒体块里给 `.rial span` 写了动画（拼错），基础样式里没有这条，
  // 于是动画挂在一个不存在的元素上——没人动、也没人报错。
  const animated = [...motionBlock.matchAll(/\.cs\[data-play="1"\] \.([a-z-]+)/g)].map((m) => m[1]);

  it('媒体块里确实点名了若干元素', () => {
    expect(new Set(animated).size).toBeGreaterThanOrEqual(3);
  });

  it.each([...new Set(animated)])('.%s 在基础样式里有规则', (cls) => {
    expect(baseCss, `媒体块给 .${cls} 写了动画，但基础样式里没有这个类——多半是拼错了`).toMatch(
      new RegExp(`\\.cs \\.${cls}[\\s,{:.]`),
    );
  });

  // className 有三种写法（字面量 / 三元 / 模板串），把值都摘出来再按「类名 token」比对；
  // 只认其中一种写法，就会把真的挂上了的类误判成没挂（形状 1：判据比范围窄）。
  const classText = [
    ...src.replace(css, '').matchAll(/className=(\{[\s\S]{0,200}?\}|"[^"]*")/g),
  ]
    .map((m) => m[1])
    .join(' | ');

  it.each([...new Set(animated)])('.%s 在 JSX 里真的被挂上了', (cls) => {
    expect(classText, `CSS 给 .${cls} 写了动画，但 JSX 里没有任何元素挂它`).toMatch(
      new RegExp(`(^|[\\s'"\`])${cls}([\\s'"\`]|$)`),
    );
  });
});

describe('紧凑条动效：开关必须同源', () => {
  it('CSS 的 data-play 与容器上写入的属性是同一个', () => {
    expect(motionBlock).toMatch(/\[data-play="1"\]/);
    expect(src).toMatch(/data-play=\{play \? '1' : '0'\}/);
  });

  it('播放信号沿着 Provider 传给数字，不是就地写死 true', () => {
    // 早期把 const play = useContext(PlayCtx) 临时改成 const play = true 调试过，
    // 那样数字会在挂载瞬间就开始跑，滚到视口里时早已停住——动效等于没有。
    expect(src).toMatch(/const play = useContext\(PlayCtx\)/);
    expect(src).toMatch(/<PlayCtx\.Provider value=\{play\}>/);
  });

  it('数字计数在拿不到播放信号时显示的是真值，不是 0', () => {
    // CountText 的初值必须是 n；写成 useState(0) 会在 play 没来时把 0 当数据显示。
    expect(src).toMatch(/const \[v, setV\] = useState\(n\)/);
  });

  it('进不了视口也有兜底放行，数字不会永远停在 0', () => {
    expect(src).toMatch(/setTimeout\(/);
  });
});
