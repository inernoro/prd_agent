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

const app = strip(read('src/App.tsx'));
must(
  /useEffect\(\(\)\s*=>\s*\{\s*void getHealth\(\);/.test(app),
  'App: 挂载时必须取一次 /gw/healthz 的 mapHomeUrl —— 只靠 LoginPage / HomePage 会让 SSO 直落页与书签入口拿不到权威地址',
);

const onboarding = strip(read('src/lib/onboarding.ts'));
must(
  !onboarding.includes('getLogsSummary'),
  'onboarding: 「有没有跑过请求」不得用 /logs/summary —— 该端点不分页，会把整段区间全量 materialize',
);
must(
  /key:\s*keys\.activePrefix\s*!==\s*null/.test(onboarding),
  'onboarding: 「签一把密钥」要看可用密钥（activePrefix），不是历史总数',
);

must(
  /useSyncExternalStore\(/.test(nav),
  'mapNavigation: 权威 MAP 地址必须是可订阅的 —— 只改模块变量不会让已挂载的链接重算，'
  + 'healthz 在首屏之后回来时它们会整个挂载期指着兜底算出的错地址',
);

for (const [file, label] of [
  ['src/components/ConsoleLayout.tsx', 'ConsoleLayout'],
  ['src/components/PageShell.tsx', 'PageShell'],
  ['src/pages/LoginPage.tsx', 'LoginPage'],
  ['src/pages/MapSsoPage.tsx', 'MapSsoPage'],
]) {
  must(
    strip(read(file)).includes('usePlatformMapHome()'),
    `${label}: 在渲染期算 MAP 地址 / 教程深链的组件必须订阅 usePlatformMapHome，否则权威地址到达时不会重算`,
  );
}

must(
  /status === 'active'/.test(onboarding),
  'onboarding: 团队/成员必须只数 active —— Quickstart 按 active 过滤并会挡住签发，按总数判定会让清单先消失、下一步却做不了',
);
must(
  !onboarding.includes('getLogs') && /everUsed/.test(onboarding),
  'onboarding: 「跑通首条请求」要取密钥的 lastUsedAt（持久事实），不能查请求日志 —— 日志默认只留 90 天，过期后会把已上手的租户打回未完成',
);

must(
  /item\.enabled && \(!item\.expiresAt/.test(onboarding),
  'onboarding: 「可用密钥」必须排除已过期的 —— 网关对 enabled-but-expired 同样拒签，'
  + '只看 enabled 会亮出一把认证不过的前缀',
);

const quickstart = strip(read('src/pages/QuickstartPage.tsx'));
must(
  (quickstart.match(/invalidateOnboardingCache\(/g) || []).length >= 3,
  'QuickstartPage: 签密钥与两种测试成功路径都要失效新人清单缓存（清单是派生态，不失效就一直显示未完成）',
);

if (failures.length > 0) {
  console.error('教程深链契约守卫未通过：');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`教程深链契约守卫通过：17 条断言。`);
