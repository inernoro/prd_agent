import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// 从 harness 源码里把主题探测那个判定函数**取出来真跑**，而不是断言某几行字面存在。
// 断言字面存在只能证明「有人写过这几个字」，证明不了它对透明背景给什么答案
// —— 而这次的缺陷正是「代码看着对、对 rgba(0,0,0,0) 答错」。
const harnessPath = new URL('../../.claude/skills/create-visual-test-to-kb/scripts/harness.mjs', import.meta.url);
const source = readFileSync(harnessPath, 'utf8');

function extractOpaqueTheme() {
  const start = source.indexOf('const opaqueTheme = (el) => {');
  assert.notEqual(start, -1, 'harness 里找不到 opaqueTheme —— 主题探测被改名或删了，这条守卫会静默失效');
  let depth = 0;
  let i = source.indexOf('{', start);
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = source.slice(start, i + 1) + ';';
  // eslint-disable-next-line no-new-func
  return new Function('getComputedStyle', `${body} return opaqueTheme;`);
}

const makeProbe = (backgroundColor) =>
  extractOpaqueTheme()(() => ({ backgroundColor }));

test('完全透明的底色不当成纯黑：浅色页不许被记成 dark', () => {
  // body 背景常是 rgba(0,0,0,0)（看得见的底色其实来自 html 或更外层）。
  // 只看 rgb 三个 0 会判成 dark —— 双主题证据比不量还错。
  assert.equal(makeProbe('rgba(0, 0, 0, 0)')({}), null);
});

test('半透明底色也不作数，往外层找', () => {
  assert.equal(makeProbe('rgba(255, 255, 255, 0.4)')({}), null);
});

test('不透明底色照常量出明暗', () => {
  assert.equal(makeProbe('rgb(9, 9, 11)')({}), 'dark');
  assert.equal(makeProbe('rgb(250, 250, 250)')({}), 'light');
  assert.equal(makeProbe('rgba(9, 9, 11, 1)')({}), 'dark');
});

test('拿不到元素或颜色时返回 null 而不是猜一个', () => {
  assert.equal(makeProbe('rgb(0,0,0)')(null), null);
  assert.equal(makeProbe('')({}), null);
  assert.equal(makeProbe('transparent')({}), null);
});

test('body 透明时会退到 html，两者都不透明不了才退媒体查询', () => {
  // 这一条守的是调用点的接线：只取 body 的话，透明 body 会一路掉到 prefers-color-scheme，
  // 而无头浏览器对那个问题永远答 light。
  assert.match(source, /const measured = opaqueTheme\(document\.body\) \|\| opaqueTheme\(root\);/);
  assert.match(source, /if \(measured\) return measured;/);
});
