#!/usr/bin/env node
/**
 * 教程深链契约守卫。
 *
 * 2026-07-29 Codex review 抓到三处同源问题，都发生在「控制台把自己的路由交给 MAP 解析」
 * 这条链上，且都只有在真实同源部署（控制台挂 /llmgw/）才暴露：
 *   1. 传了未削 basename 的 pathname → MAP 逐段比对必然不匹配 → 每页都「没有找到关联教程」；
 *   2. 章节塞进 `entry`（那是 Mongo 文档 id，不是教程 sourceId），且会被解析结果覆盖；
 *   3. 站内回落 `/learn` 用裸 <a>，basename 下会跳去 MAP 的 /learn。
 *
 * 这三条都测不到「行为」——llmgw/web 没有单测运行器，且它们依赖 router basename 与
 * 跨应用参数约定。所以钉成源码契约：谁把它们改回去，build 就红。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf-8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

const failures = [];
const must = (cond, message) => { if (!cond) failures.push(message); };

const nav = strip(read('src/lib/mapNavigation.ts'));
must(
  /tutorialRoute['"],\s*stripConsoleBase\(/.test(nav),
  'mapNavigation: tutorialRoute 必须先过 stripConsoleBase —— 否则同源部署下每页都「没有找到关联教程」',
);
must(
  nav.includes("tutorialSourceId"),
  'mapNavigation: 章节必须用 tutorialSourceId 独立参数传递，不能塞进 entry（entry 是 Mongo 文档 id，且会被解析结果覆盖）',
);
must(
  !/searchParams\.set\(['"]entry['"]/.test(nav),
  'mapNavigation: 不得再往 entry 里写教程 sourceId',
);

const shell = strip(read('src/components/PageShell.tsx'));
must(
  /<Link[^>]*to="\/learn"/.test(shell),
  'PageShell: 站内学习中心回落必须走 router Link —— 裸 <a href="/learn"> 在 basename=/llmgw 下会跳到 MAP 的 /learn',
);
must(
  !/resolveTutorialHref\(window\.location\.pathname/.test(shell),
  'PageShell: 教程深链要用 router 的 location（已按 basename 削过），不要用 window.location.pathname',
);

if (failures.length > 0) {
  console.error('教程深链契约守卫未通过：');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`教程深链契约守卫通过：${5} 条断言。`);
