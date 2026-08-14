#!/usr/bin/env node
// 浮层不占位守卫：固定浮层不得在布局里预留净空，全局动作必须挂在导航壳上。
//
// 由来：2026-08-14 用户在请求记录页截图指出「列表被提交 bug 的悬浮组件顶上去了，
// 这个提交 bug 只是一个悬浮组件，不应该占用位置」。实测确认：
//   BugReportDialog 渲染了一个 position:fixed / right:16 / bottom:16 的 FAB；
//   `.lg-console-content` 为躲它写了 `padding: 22px 24px 72px`。
// 于是一个「浮」在内容之上的东西，在全部 19 个页面永久占掉一条 72px 横带，
// 而移动端断点又把 padding 覆盖成 12/16px（浮标照样遮挡）——两头不讨好。
// 正解：全局动作放进导航壳（.lg-sidebar-footer），内容画布之上不放常驻浮标。
// CDS 早于本处做过同一次修正，见 cds/tests/web/bottom-right-overlay-offsets.test.ts。
//
// 三条判据（对应 predicate-and-wiring-discipline 的形状 2/6/7）：
//   1. 浮标不复活：BugReportDialog 里不得再出现 fixed + bottom/right 的定位组合。
//   2. 净空不复活：`.lg-console-content` 的 padding-bottom 不得显著大于其余三边。
//      **取胜出者而非第一条**——该选择器在媒体查询里被 !important 覆盖过多次。
//   3. 入口有接线：侧栏页脚必须真的派发 OPEN_BUG_REPORT_EVENT，
//      否则删掉浮标之后可见入口就整个消失了（只剩快捷键，等于没有）。
//
// 用法：pnpm check:overlay
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const stripComments = (s) => s.replace(/\/\*[^]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

const violations = [];

// ── 判据 1：浮标不复活 ────────────────────────────────────────────────
// 只看 BugReportDialog：它是历史事故的现场。定位属性可能散在一个 style 对象的
// 多行里，所以按「同一个对象字面量」的粒度看，而不是逐行。
{
  const source = stripComments(read('components/BugReportDialog.tsx'));
  for (const match of source.matchAll(/style=\{\{([^]*?)\}\}/g)) {
    const decl = match[1];
    if (!/position:\s*'fixed'/.test(decl)) continue;
    // 全屏遮罩用 inset:0，那是模态本身，合法；被禁的是贴边挂角的常驻浮标。
    if (/\binset:\s*0/.test(decl)) continue;
    if (/\bbottom:/.test(decl) && /\bright:/.test(decl)) {
      violations.push(
        'components/BugReportDialog.tsx  又出现了 position:fixed + bottom + right 的右下角浮标\n'
        + '      ← 全局动作请放进 ConsoleLayout 的 .lg-sidebar-footer，不要浮在内容画布之上',
      );
    }
  }
}

// ── 判据 2：净空不复活 ────────────────────────────────────────────────
// 取 `.lg-console-content` 全部 padding 声明（含媒体查询覆盖），逐条比对四边。
// 只取第一条会漏掉后写覆盖，只取最后一条会漏掉桌面态——所以每一条都判。
{
  // CSS 注释必须先剥：本文件与 theme.css 里都写着「曾经是 82px」这类反面示例，
  // 不剥的话守卫会把说明文字当成活声明抓出来（自己咬自己一口）。
  const css = read('theme.css').replace(/\/\*[^]*?\*\//g, ' ');
  const blocks = [...css.matchAll(/\.lg-console-content[^{}]*\{([^}]*)\}/g)];
  if (blocks.length === 0) {
    violations.push('theme.css  找不到 .lg-console-content 的样式块 ← 守卫失去判据，请更新本脚本');
  }
  for (const block of blocks) {
    const decl = /(?:^|;)\s*padding:\s*([^;!]+)/.exec(block[1]);
    if (!decl) continue;
    const parts = decl[1].trim().split(/\s+/).map((v) => Number.parseFloat(v));
    if (parts.some((v) => Number.isNaN(v))) continue;
    // CSS 简写：1 值四边同；2 值上下/左右；3 值上/左右/下；4 值上/右/下/左。
    const [top, , bottom = parts[0]] = parts.length === 1
      ? [parts[0], parts[0], parts[0]]
      : parts.length === 2
        ? [parts[0], parts[1], parts[0]]
        : [parts[0], parts[1], parts[2]];
    const others = Math.max(top, parts.length >= 2 ? parts[1] : parts[0]);
    if (bottom - others >= 16) {
      violations.push(
        `theme.css  .lg-console-content 的下内边距 ${bottom}px 明显大于其余边（${others}px）\n`
        + '      ← 这是在给固定浮层预留净空。浮层不该占位：把它挂进导航壳，别让 19 个页面替它让路',
      );
    }
  }

  // 页面级的同类补丁（`.lg-xxx-page { padding-bottom: 大值 }`）同样禁止。
  for (const match of css.matchAll(/\.lg-[a-z-]*page[^{}]*\{([^}]*)\}/g)) {
    const hit = /padding-bottom:\s*(\d+(?:\.\d+)?)px/.exec(match[1]);
    if (hit && Number.parseFloat(hit[1]) >= 40) {
      violations.push(
        `theme.css  页面容器写了 padding-bottom: ${hit[1]}px ← 又一处替浮层让位的补丁，删掉浮层而不是加补丁`,
      );
    }
  }
}

// ── 判据 3：入口有接线 ────────────────────────────────────────────────
// 删掉浮标之后，可见入口只剩侧栏页脚这一处。它断了就等于「功能还在、没人找得到」，
// 而这种断线删掉后测试不会红——正是需要一条源码守卫的形状。
{
  const layout = stripComments(read('components/ConsoleLayout.tsx'));
  if (!/className="lg-sidebar-footer"/.test(layout)) {
    violations.push('components/ConsoleLayout.tsx  侧栏页脚 .lg-sidebar-footer 不见了 ← 提交缺陷的唯一可见入口');
  }
  if (!/dispatchEvent\(new Event\(OPEN_BUG_REPORT_EVENT\)\)/.test(layout)) {
    violations.push('components/ConsoleLayout.tsx  侧栏页脚没有派发 OPEN_BUG_REPORT_EVENT ← 按钮点了不会有反应');
  }
  // CSS 注释必须先剥：本文件与 theme.css 里都写着「曾经是 82px」这类反面示例，
  // 不剥的话守卫会把说明文字当成活声明抓出来（自己咬自己一口）。
  const css = read('theme.css').replace(/\/\*[^]*?\*\//g, ' ');
  if (!/\.lg-sidebar-footer\s*\{/.test(css)) {
    violations.push('theme.css  缺少 .lg-sidebar-footer 样式 ← 入口会退化成一个没排版的裸按钮');
  }
}

if (violations.length) {
  console.error('浮层占位守卫未通过：\n');
  for (const violation of violations) console.error('  ' + violation);
  console.error('\n原则：固定浮层不参与布局，就不许让布局替它让位；');
  console.error('      全局动作（提交缺陷、接入 Agent 这类）属于导航壳，不属于内容画布之上。');
  process.exit(1);
}

console.log('浮层占位守卫通过：无右下角常驻浮标，内容区未为浮层预留净空，侧栏入口接线完整。');
