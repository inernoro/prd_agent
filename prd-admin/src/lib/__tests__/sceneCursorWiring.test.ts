import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 守卫：演示指针每一拍指向的那个元素，页面上真的存在。
 *
 * 第一版指针是给每一拍手写一对百分比，全程落在空处——因为那些百分比是相对整块
 * 面板量的，而画布上的图活在一个 `lg:right-[444px]` 的子容器里，两套坐标系差着
 * 一整个对话面板的宽度。改成「只说指向谁、落点当场量」之后，坐标漂移不会再发生，
 * 但换来一种新的漂移：**目标名字写错或元素被改名，指针会静默消失**
 * （SceneCursor 量不到就把自己收起来，页面照常渲染、测试照常绿）。
 *
 * 所以两头都断言（`predicate-and-wiring-discipline` 形状 2）：
 *   · 走位表里点名的目标，源码里必须有对应的 `data-cursor-target`；
 *   · 标了 `data-cursor-target` 的元素，必须真的有某一拍在用它，否则就是没接上的线。
 */

const HOME_DIR = path.resolve(__dirname, '../../pages/home');

/**
 * 读各幕源码。**跳过 SceneCursor.tsx 本身**——它是读 `data-cursor-target` 的那一方
 * （querySelector 里带着这个串），不是声明方；混进来会被当成一个假的声明。
 */
function readSceneSources(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'SceneCursor.tsx') continue;
      else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(HOME_DIR);
  return out.join('\n');
}

/**
 * 把 `data-cursor-target` 的值摊平成静态名字。
 * 三种写法：常量 `"doc-title"`、模板 `` {`tile-${tile.id}`} ``、
 * 条件 `{sweep ? 'para-1' : undefined}`。模板的变量部分展开成通配。
 */
function declaredTargets(source: string): { exact: Set<string>; prefixes: string[] } {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  // 花括号形态只吃到**第一个**配平的 `}`，别让它越过属性边界把后面 style 里的字面量也吞进来
  for (const m of source.matchAll(/data-cursor-target=(?:"([^"]+)"|\{((?:[^{}]|\{[^{}]*\})*)\})/g)) {
    if (m[1]) { exact.add(m[1]); continue; }
    const expr = m[2] ?? '';
    for (const lit of expr.matchAll(/'([a-z0-9-]+)'/g)) exact.add(lit[1]);
    for (const tpl of expr.matchAll(/`([a-z0-9-]+)\$\{/g)) prefixes.push(tpl[1]);
  }
  return { exact, prefixes };
}

/** 走位表 / cursorSpot 里点名的目标。 */
function usedTargets(source: string): { exact: Set<string>; prefixes: string[] } {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const m of source.matchAll(/target:\s*(?:'([a-z0-9-]+)'|`([a-z0-9-]+)\$\{)/g)) {
    if (m[1]) exact.add(m[1]);
    else if (m[2]) prefixes.push(m[2]);
  }
  return { exact, prefixes };
}

describe('首页演示指针接线', () => {
  const source = readSceneSources();
  const declared = declaredTargets(source);
  const used = usedTargets(source);

  it('走位表里点名的每个目标，页面上都有对应的 data-cursor-target', () => {
    const missing = [...used.exact].filter(
      (t) => !declared.exact.has(t) && !declared.prefixes.some((p) => t.startsWith(p)),
    );
    const missingPrefix = used.prefixes.filter(
      (p) => !declared.prefixes.includes(p) && ![...declared.exact].some((d) => d.startsWith(p)),
    );
    expect(
      [...missing, ...missingPrefix.map((p) => `${p}*`)],
      '这些目标在走位表里被点名，页面上却没有元素标 data-cursor-target —— '
        + '指针到这一拍会量不到落点、把自己整枚收起来，而且不会有任何报错',
    ).toEqual([]);
  });

  it('标了 data-cursor-target 的元素，都有某一拍在用', () => {
    const orphan = [...declared.exact].filter(
      (d) => !used.exact.has(d) && !used.prefixes.some((p) => d.startsWith(p)),
    );
    expect(
      orphan,
      '这些元素标了 data-cursor-target，但没有任何一拍指向它们 —— '
        + '要么是走位表漏了，要么是这个标记已经没用了，删掉',
    ).toEqual([]);
  });

  it('指针落点只认元素，走位表里不该再出现手写坐标', () => {
    const handWritten = Array.from(
      source.matchAll(/\[B\.[a-z0-9]+\]:\s*\{\s*x:\s*\d/gi),
      (m) => m[0],
    );
    expect(
      handWritten,
      '走位表里出现了手写的 x/y 百分比。指针挂在面板根上，而画布内容活在有偏移的 '
        + '子容器里，两套坐标系对不上——这正是第一版指针全程落在空处的原因。改成 target。',
    ).toEqual([]);
  });
});
