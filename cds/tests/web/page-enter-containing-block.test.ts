/**
 * 守卫：`.cds-page-enter` 不许用 forwards / both 填充。
 *
 * 背景（2026-08-05 真实事故）：`.cds-page-enter` 挂在 `.cds-main` 上
 * （`cds/web/src/components/layout/AppShell.tsx`），而 `.cds-main` 同时是页面滚动
 * 容器（`overflow-y: auto`）。这条动画 animates `transform`，一旦用 forwards 语义
 * 填充，动画结束后元素仍处于填充态，Chrome 据此把 `.cds-main` 当成
 * `position: fixed` 的**包含块** —— main 里所有 fixed 浮层（分支详情抽屉等）不再
 * 钉在视口上，而是跟着内容滚动并被 overflow 裁掉。用户表现：往下滚之后侧边栏
 * 只剩下半截。
 *
 * 为什么必须要守卫：keyframes 的 to 帧是 `transform: none`，孤立读代码完全看不出
 * 问题（"动画结束后又没有 transform"），tsc / build / 通读全都发现不了，只有真在
 * 滚动容器里滚一次才暴露。把 `backwards` 改回 `both` 不会让任何其它测试变红。
 *
 * 同源事故：topbar 的 backdrop-filter 抢走包含块，导致全屏 backdrop 只盖住顶栏
 * （Bugbot #741，见 AppShell.tsx 的 portal 注释）。
 *
 * 相关规则：`.claude/rules/predicate-and-wiring-discipline.md`（改动删掉后测试仍
 * 全绿 = 需要一条守卫）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CSS_PATH = path.resolve(__dirname, '../../web/src/index.css');
const APP_SHELL_PATH = path.resolve(__dirname, '../../web/src/components/layout/AppShell.tsx');

/** 取 `.cds-page-enter { ... }` 规则体（跳过 @media 里的 reduced-motion 覆盖）。 */
function readPageEnterRule(css: string): string {
  // 只认顶层声明块：reduced-motion 覆盖写的是 `animation: none`，不参与本判定
  const matches = [...css.matchAll(/\.cds-page-enter\s*\{([^}]*)\}/g)].map((m) => m[1]);
  const withAnimation = matches.filter((body) => /animation\s*:/.test(body) && !/animation\s*:\s*none/.test(body));
  return withAnimation.join('\n');
}

describe('.cds-page-enter 不得成为 fixed 的包含块', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');

  it('规则存在且声明了 animation（否则本守卫在空转）', () => {
    const rule = readPageEnterRule(css);
    expect(rule, '.cds-page-enter 的 animation 声明找不到了，守卫失效，请同步更新本测试').not.toBe('');
  });

  it('animation 简写不得使用 forwards / both 填充', () => {
    const rule = readPageEnterRule(css);
    // both / forwards 会让 transform 动画在结束后仍处于填充态 → 生成包含块
    expect(rule).not.toMatch(/animation:[^;]*\bboth\b/);
    expect(rule).not.toMatch(/animation:[^;]*\bforwards\b/);
    expect(rule).not.toMatch(/animation-fill-mode\s*:\s*(both|forwards)/);
  });

  it('animates transform 时必须显式声明 backwards（不能省略成默认 none 而丢掉入场首帧）', () => {
    const keyframes = css.match(/@keyframes\s+cds-page-enter\s*\{[\s\S]*?\n\s*\}\s*\n/);
    expect(keyframes, '@keyframes cds-page-enter 找不到了，守卫失效').not.toBeNull();
    const animatesTransform = /transform\s*:/.test(keyframes![0]);
    if (!animatesTransform) return; // 已改成纯 opacity 动画，包含块问题不复存在
    expect(readPageEnterRule(css)).toMatch(/animation:[^;]*\bbackwards\b/);
  });

  it('前提未变：.cds-page-enter 仍挂在 .cds-main 上，且 .cds-main 仍是滚动容器', () => {
    // 前提一旦变了（比如动画挪到内层 wrapper），本守卫的理由消失，应重新评估而不是留着空转
    const shell = fs.readFileSync(APP_SHELL_PATH, 'utf8');
    expect(shell).toMatch(/cds-main cds-page-enter/);
    // 注意：`.cds-main {` 在文件里出现多次（还有 `.cds-app-shell .cds-main` 这条
    // 只管网格定位的规则）。只取第一条会匹配到网格规则、判据永远为假——必须扫全部
    // 同名规则再看有没有哪一条真的声明了滚动。
    const mainRules = [...css.matchAll(/\.cds-main\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(mainRules.length, '.cds-main 规则找不到了').toBeGreaterThan(0);
    const scrolls = mainRules.some((body) => /overflow-y\s*:\s*auto/.test(body));
    expect(scrolls, '.cds-main 不再是滚动容器，本守卫的前提已变，请重新评估').toBe(true);
  });
});
