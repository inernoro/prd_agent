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

must(
  onboarding.includes('STEP_WRITE_CAPABILITIES') && /team: \['organizationWrite'\]/.test(onboarding),
  'onboarding: 「去完成」必须按每步需要的写权限判定 —— organization 页只要 logsRead，'
  + 'developer / viewer 到得了却做不了，光看页面可达会给出死链',
);
must(
  /request: \['appCallerWrite', 'serviceKeyWrite'\]/.test(onboarding),
  'onboarding: 「跑通首条请求」要照抄 Quickstart 的 canCreateAccess（appCallerWrite + serviceKeyWrite）'
  + ' —— 不满足时测试按钮压根不渲染，给 CTA 就是死链',
);
must(
  // 必须锚在 actionable 的表达式上：窗口放宽到 200 字符会把下面那行 `readable: readableOf[id],`
  // 一起吃进来，于是删掉 actionable 里的那一项也不会变红（不会因正确原因失败的守卫）。
  onboarding.includes('&& readableOf[id]'),
  'onboarding: 读不到判定源的步骤不得标成 actionable（done 恒 false，给 CTA 等于让人点一个不知道做完没有的动作）',
);

must(
  /canReadOrganization = canUseCapability\(tenant\?\.role, 'organizationWrite'\)/.test(onboarding),
  'onboarding: 组织事实的可读性要按「能读到全貌」判 —— /gw/organization 对 owner/admin 之外'
  + '按 teamIds 收窄，拿局部视图数成员会把已配好的租户判成没拉成员',
);

must(
  /const key = `\$\{kind\}::\$\{tenantId\}::\$\{identity\}`/.test(onboarding),
  'onboarding: 缓存键必须带登录身份 —— /gw/service-keys 对 developer 按 CreatedByUserId 过滤，'
  + '只按租户做键会让同浏览器换账号后读到上一个人的密钥前缀',
);
must(
  /\}, \[tenantId, identity, canReadOrganization/.test(onboarding)
  && /\}, \[tenantId, identity, canRead, revision\]/.test(onboarding),
  'onboarding: identity 必须进两个 effect 的依赖数组 —— 只进缓存键不够，换账号时 effect 不重跑',
);

must(
  /location\.pathname\.replace\(\/\\\/\+\$\/, ''\) === '\/learn'/.test(shell),
  'PageShell: 在 /learn 上不得渲染指向 /learn 的回落链接 —— 点了什么都不会发生，'
  + '而该页的详细解释已收进深链教程，用户会断在死链上',
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

// 这一条原来断言「抽屉打开时 toast 必须渲染在抽屉内」，因为池详情是 fixed 覆盖层，
// 页面级反馈会被它整块盖住。2026-08-18 改版把详情从 680px 抽屉换成整页分栏之后，
// 覆盖层没有了，危险源本身消失——所以判据改成更强的一条：**这一页不许再出现模态覆盖层**。
// 这样既保住原意（反馈不会被盖住），又能在有人把抽屉加回来时立刻变红，而不是悄悄放行。
const pools = strip(read('src/pages/ModelPoolsPage.tsx'));
must(
  !pools.includes('aria-modal') && !/position:\s*'fixed'/.test(pools),
  'ModelPoolsPage: 池详情不得回到 fixed 模态覆盖层（页面级反馈会被它盖住）；'
  + '如确需覆盖层，必须同时把 toast 渲染进覆盖层内部',
);
must(
  (pools.match(/role="status"/g) || []).length >= 1,
  'ModelPoolsPage: 操作反馈必须有 live region',
);

// 「全部正常」是一句结论，它只能在**真的什么都没筛**时说。带着搜索词或类型筛选时结果为空，
// 说明的是「没搜到」；把后者显示成前者，就是一次没真正执行的检查报了绿灯——
// 这正是模型池这一族故障的形状，不能在前端重演一遍。
must(
  /allClear\s*=[\s\S]{0,320}?query\.trim\(\)\s*===\s*''[\s\S]{0,120}?typeFilter\s*===\s*'all'/.test(pools),
  'ModelPoolsPage: 「全部正常」的判据必须同时排除搜索词与类型筛选，否则会把「没搜到」显示成「一切正常」',
);

// 新成员默认落末位。此前留空会被 toPositiveInt('') 解成 1（抢占第 1 顺位），
// 而输入框占位符写的是 P{末位}——控件暗示的和实际发生的正好相反，且会改线上流量走向。
must(
  /mode\s*===\s*'tail'\s*\?\s*tailPriority/.test(pools) && !/placeholder=\{`P\$\{pool\.models\.length \+ 1\}`\}/.test(pools),
  'ModelPoolsPage: 添加成员的顺位必须默认末位，且不得再出现「留空即抢占第 1 顺位」的输入框',
);

// 上面那条只验「走没走 tail 分支」，不验 tail 算得对不对——第一版就是形状对、值错：
// 末位按成员个数推（length + 1），而后端顺位是 10 步长（补齐建的池是 10/20/30），
// 三个成员算出 4，比 10 还小，「末位·不改现有流量」实际插进第 1 顺位抢走全部流量。
must(
  /function nextTailPriority[\s\S]{0,400}?Math\.max\(acc, m\.priority\)[\s\S]{0,120}?\+ 10/.test(pools),
  'ModelPoolsPage: 末位顺位必须按现有最大顺位 + 10 推算（对齐后端步长），不能按成员个数推',
);
must(
  !/const tailPriority = pool\.models\.length \+ 1/.test(pools)
    && !/第\{pool\.models\.length \+ 1\}顺位/.test(pools),
  'ModelPoolsPage: 末位顺位与按钮文案都不得再用「成员个数 + 1」，那在 10 步长的池上会算成抢占第 1 顺位',
);
// 二次确认要守**算出来的顺位**，不是用户选的模式。只守 'pick' 的话，末位一旦算错，
// 抢流量就绕过确认静默发生——守卫和被守的 bug 同源，等于没守。
must(
  /if \(lead && priority <= lead\.priority\)/.test(pools) && !/mode === 'pick' && lead && priority <= lead\.priority/.test(pools),
  'ModelPoolsPage: 抢占第 1 顺位的二次确认必须按算出来的顺位判定，不能只在「指定顺位」模式下生效',
);

// 恢复接单后成员在后端仍是不可用（只拿到进入半开的资格），UI 必须自己记一笔中间态，
// 否则点完按钮界面纹丝不动，用户只会反复点。
must(
  pools.includes('verifying.has(') && pools.includes("MEMBER_STATUS[isVerifying ? 'verify'"),
  'ModelPoolsPage: 「恢复接单」必须有「验证中」中间态，不能点完之后界面毫无变化',
);
// 同样只验形状不够：中间态只进不出的话，「验证中」会挂一整个会话——真恢复了仍显示
// 验证中，再次失败也点不回「恢复接单」，只能刷新页面。必须有退出路径。
must(
  /setVerifying\([\s\S]{0,200}?next\)/.test(pools) && /next\.delete\(key\)/.test(pools),
  'ModelPoolsPage: 「验证中」必须能退出（成员健康快照变化即出结果），不能只进不出',
);

// 「解析不到」不是「失败」：后端只对指不到上游/模型的成员给 unavailableReason，
// 而调度侧永远不会把真实请求发给这种成员。给它一个「恢复接单」按钮，点下去只翻健康位，
// 界面就永久挂在「验证中」等一个不会来的结果——恰恰是上一条守卫要防的「只进不出」，
// 换了个入口重演。判据必须是「有没有归因」，不是「归因是哪一种」：后者每加一种归因
// 就得改一次，迟早漏掉某一种（形状 1）。
must(
  // 窗口用 [^}] 而不是 [\s\S]{0,N}：后者会越过函数的收尾大括号，一路匹配到 memberNextStep
  // 里同名的字面量，把「判据被掏空」判成绿灯（形状 1：窗口开太宽，判据自己失效）。
  /function memberCanRecover[^}]*!member\.unavailableReason[^}]*\}/.test(pools),
  'ModelPoolsPage: 「能不能恢复」必须只看有没有 unavailableReason，不能按归因种类逐个列举',
);
must(
  /healthStatus === 2 && !isVerifying && memberCanRecover\(member\)/.test(pools),
  'ModelPoolsPage: 解析不到的成员不得出现「恢复接单」——点了也没有请求能到它，界面会永久停在验证中',
);
must(
  /function memberNextStep[^}]*'upstream-disabled'[^}]*'model-disabled'[^}]*'upstream-missing'[^}]*'model-missing'[^}]*\}/.test(pools),
  'ModelPoolsPage: 四种归因必须各有各的下一步，不能沿用「恢复后即可继续承接」这句对谁都不成立的话',
);
// 上一条只证明这套文案**存在**。它有没有被那句提示真的用上，是另一件事——
// 第一版守卫就漏在这里：把提示改回旧的 removable 三元、函数原地不动，守卫照样全绿（形状 2）。
must(
  pools.includes('`${memberFaultPhrase(member)} · ${memberNextStep(member)}`'),
  'ModelPoolsPage: 成员归因提示必须走 memberNextStep，不能在 JSX 里另写一份下一步文案',
);

// 详情/新建这一支不走 PageBody，而 PageShell 与 console-content 都是 overflow:hidden。
// 不自建滚动容器，成员表下半截与「添加成员」会被裁掉、用户够不到。
must(
  /\.mp-detail-main\{[^}]*overflow-y:\s*auto/.test(pools) && /className="mp-detail-main"/.test(pools),
  'ModelPoolsPage: 池详情/新建的内容列必须自建滚动容器，否则折叠线以下的内容够不到',
);

if (failures.length > 0) {
  console.error('教程深链契约守卫未通过：');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}
console.log(`教程深链契约守卫通过：${asserted} 条断言。`);
