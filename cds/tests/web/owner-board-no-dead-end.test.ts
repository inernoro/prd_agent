/*
 * 守卫：第一屏不许把功能藏进「先选项目」后面。
 *
 * 2026-09-11 角色化人类验收现场：自检端点与公开面板两块都写着
 * `{scope.projectId ? <块/> : null}`，而默认视图是「全部项目」——
 * 于是后端工程师想插自检端点、对外 PM 想开状态页，两个角色**同时**
 * 在冷启动的第一屏撞上死胡同：页面上没有那两块，也没有一句话说该怎么办。
 *
 * 这类洞编译过、测试绿、通读也挑不出（predicate-and-wiring-discipline 形状 2：
 * 条件渲染是一种静默的功能消失）。所以判据只能是结构性的：
 * **`scope.projectId` 的三元表达式，否定分支一律不许是 `null`。**
 *
 * 这条守卫刻意不断言任何提示文案的字面，改文案不该让它红（形状 4a）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE = fileURLToPath(new URL('../../web/src/pages/status/OwnerBoard.tsx', import.meta.url));

/** 去掉注释，免得注释里提到的写法把扫描带偏。 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('第一屏不许有「默认视图下功能凭空消失」的分支', () => {
  const code = codeOf(readFileSync(SOURCE, 'utf8'));

  it('scope.projectId 的三元表达式，否定分支不许是 null', () => {
    // 正则在这里不够用：非贪婪的 `: null` 会越过本块，撞上块内别的三元
    // （第一版就是这么误报的）。所以按括号配平找到本三元真正的否定分支。
    const dead: string[] = [];
    for (const match of code.matchAll(/scope\.projectId\s*\?\s*/g)) {
      let i = (match.index ?? 0) + match[0].length;
      let depth = 0;
      // 走过肯定分支，停在与它同层的那个 `:`。
      while (i < code.length) {
        const ch = code[i];
        if (ch === '(' || ch === '{' || ch === '[') depth += 1;
        else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
        else if (ch === ':' && depth === 0) break;
        i += 1;
      }
      const otherwise = code.slice(i + 1).trimStart();
      if (otherwise.startsWith('null')) dead.push(code.slice(match.index ?? 0, i).slice(0, 80));
    }
    expect(
      dead,
      '没选项目时把整块渲染成 null，等于这个功能对默认进来的人不存在——给一行说明怎么打开它',
    ).toEqual([]);
  });

  it('两块按项目走的功能都还在这一屏上', () => {
    // 接线守卫：块被整个删掉时也要红，不然上一条只要删代码就能「通过」。
    expect(code).toContain('DiscoveryStrip');
    expect(code).toContain('NeedsProjectRow');
    // NeedsProjectRow 必须真的被用上，而不是定义了没人调（形状 2）。
    const uses = [...code.matchAll(/<NeedsProjectRow/g)];
    expect(uses.length, '自检端点与公开面板两块都要有「先选项目」的占位').toBeGreaterThanOrEqual(2);
  });
});
