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
let asserted = 0;
const must = (cond, message) => { asserted += 1; if (!cond) failures.push(message); };

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
  /item\.enabled\s*&&\s*\(!item\.expiresAt/.test(onboarding),
  'onboarding: 「可用密钥」必须排除已过期的 —— 网关对 enabled-but-expired 同样拒签，'
  + '只看 enabled 会亮出一把认证不过的前缀',
);

const quickstart = strip(read('src/pages/QuickstartPage.tsx'));
must(
  quickstart.includes('invalidateOnboardingCache(tenant?.id)'),
  'QuickstartPage: 本页签密钥后要失效新人清单缓存（清单是派生态，不失效就一直显示未完成）',
);
must(
  (quickstart.match(/markRequestCompleted\(/g) || []).length >= 2,
  'QuickstartPage: 两种测试成功路径都要走 markRequestCompleted 而非裸失效'
  + '（serving 的 LastUsedAt 是不 await 的后台写，只失效+重拉会抢在它落库之前读到旧值）',
);
must(
  onboarding.includes('REQUEST_COMPLETED_TENANTS.has(tenantId)'),
  'onboarding: 「跑通首条请求」必须叠上本地确证，不能只信可能落后于后台写的 digest',
);

must(
  onboarding.includes('allowsInvocation(item.scopes)') && onboarding.includes("'stream:invoke'"),
  'onboarding: 「可用密钥」必须能发起调用 —— 一把 readiness:read 的探针密钥不该让清单划掉这一步',
);
must(
  /if \(values\.length === 0\) return false;/.test(onboarding),
  'onboarding: scope 空列表必须判为不可用（serving 的 MatchesAny 要求非空，空 = 拒绝）',
);

const theme = read('src/theme.css');
must(
  shell.includes('lg-help-popover--up') && shell.includes('shouldFlipHelpUp('),
  'PageShell: HelpPopover 必须按最近滚动容器量出来后决定向上/向下展开'
  + '（气泡是 absolute，不参与布局，被 overflow 裁掉的部分滚动也够不到）',
);
must(
  theme.includes('.lg-help-popover--up > div'),
  'theme.css: 缺少向上展开的样式，翻转类加了也没有效果（形状 2：链路只建到一半）',
);

// 固定定位抽屉里的失败信息必须留在抽屉内：页面级 alert 渲染在 PageBody，
// 会被抽屉与毛玻璃背板整块盖住，用户只看到表单停止 busy（Codex P2）。
const org = strip(read('src/pages/OrganizationPage.tsx'));
must(
  // 两个抽屉（成员 / 新建租户）各一处，故是 >= 2 —— 只改一个就红。
  (org.match(/\{failure \? <InlineAlert/g) || []).length >= 2,
  'OrganizationPage: 成员抽屉与租户抽屉的失败信息必须各自渲染在抽屉内，不能抛给页面级 alert',
);
must(
  !/onError\(/.test(org),
  'OrganizationPage: 抽屉不得再把失败经 onError 抛给页面（那条 alert 被抽屉盖住）',
);
const usage = strip(read('src/pages/UsagePage.tsx'));
must(
  usage.includes('setImportError(') && usage.includes('{importError ? <InlineAlert'),
  'UsagePage: 账单导入失败必须渲染在导入抽屉内（抽屉 z-index 1100，页面 alert 看不见）',
);

if (failures.length > 0) {
  console.error('教程深链契约守卫未通过：');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`教程深链契约守卫通过：${asserted} 条断言。`);
