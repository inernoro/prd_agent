/**
 * 验收对象那一格胶囊的守卫（2026-09-14）。
 *
 * 用户看到的现象是「字体溢出」：分支名换行了，胶囊的背景没跟着长高，第二行掉到
 * 框外面。根因是 `h-[22px]` 写死了高度，而这一格的内容是长标识
 * （`claude/knowledge-base-github-sync-76rjsp`），在 300px 宽的格子里必然换行。
 *
 * 这个洞不报错、类型过、测试也过——只有真的有人打开那一页、并且恰好有一条长
 * 分支名，才看得见。同一串 class 当时还抄了三份（分支 / commit / PR），
 * 所以它天然是「改一处忘两处」。
 *
 * 本文件守两件事：高度不许写死、三处不许再各抄一份。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const src = readFileSync(resolve(__dirname, '../..', 'web/src/pages/ReportsPage.tsx'), 'utf8');

/** 只取组件定义那一段，别把调用处和别处的 class 串混进来。 */
const chip = (() => {
  const i = src.indexOf('function ChangeKeyChip(');
  expect(i, '找不到 ChangeKeyChip —— 改了名字就得来更新这条守卫').toBeGreaterThan(-1);
  const rest = src.slice(i);
  const end = rest.indexOf('\n}\n');
  return rest.slice(0, end);
})();

describe('胶囊高度不许写死', () => {
  it('用 min-h 而不是 h', () => {
    expect(chip, '写死高度的胶囊装不下换行的分支名，第二行会掉到背景外').toMatch(/min-h-\[/);
    // h-[22px] 这种固定高度不许再出现在胶囊上。
    // 注意 min-h-[1.375rem] 里也含 "h-[1.375rem]"，得把 min- 前缀排掉，否则这条守卫
    // 会把正确写法判红（第一版就是这么误判的）。px 与 rem 两种单位都要认。
    expect(chip).not.toMatch(/(?<!min-)\bh-\[[\d.]+(?:px|rem)\]/);
  });

  it('长文本断得掉，且断在连字符而不是词中间', () => {
    // 没有断行设置的话，一串没有空格的长标识会整体溢出格子。
    // 用 break-words 而不是 break-all：实测 break-all 断在词中间（`...sync-7` / `6rjsp`），
    // break-words 断在连字符（`...sync-` / `76rjsp`），后者好读，且极端长 token 照样能断。
    expect(chip).toMatch(/break-words/);
    expect(chip, 'break-all 会把标识断在词中间').not.toMatch(/break-all/);
  });

  it('图标不许被压扁', () => {
    // 文本换行时图标若可收缩，会被挤成一条线。
    expect(chip).toMatch(/shrink-0/);
  });

  it('不许截断——分支名的区分度全在尾巴上', () => {
    // ...-76rjsp 与 ...-t57jzo 只差尾巴，截掉这一列就认不出是哪条分支了。
    // 这是有意的取舍，写成守卫免得后来人图整齐把它改成 truncate。
    expect(chip).not.toMatch(/\btruncate\b/);
    expect(chip).not.toMatch(/text-ellipsis/);
  });
});

describe('三处共用一个组件，不许各抄一份', () => {
  const cell = (() => {
    // 锚点认内容不认宽度：原来写死 w-[300px]，2026-09-15 全站换 rem 之后当场失效；
    // 放宽成 w-[任意单位] 又不唯一（同一文件里别的格子也是这个形状，会锚错格）。
    // 这一格的身份是「装 ChangeKeyChip 的那一格」，就按它找。
    const k = src.indexOf('<ChangeKeyChip');
    expect(k, '找不到验收对象那一格').toBeGreaterThan(-1);
    const i = src.lastIndexOf('<td', k);
    return src.slice(i, src.indexOf('</td>', k));
  })();

  it('分支 / commit / PR 三处都走 ChangeKeyChip', () => {
    expect([...cell.matchAll(/<ChangeKeyChip\b/g)]).toHaveLength(3);
  });

  it('那一格里没有再内联一串胶囊 class', () => {
    // 抄第四份就是下一次「改一处忘三处」的起点。
    expect(cell, '这一格里又出现了内联的胶囊样式').not.toMatch(/inline-flex[^"]*rounded[^"]*border/);
  });

  it('这一格里不再有写死高度的胶囊残留', () => {
    // 只扫这一格：文件别处也有定高的 inline-flex，但它们内部配了 truncate，
    // 不换行就不会溢出，是对的。扫全文件会把那些一起误伤。
    expect(cell).not.toMatch(/inline-flex h-\[[\d.]+(?:px|rem)\]/);
  });
});
