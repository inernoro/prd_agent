import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 发布控制台（`/release-console`）的**接线守卫**。
 *
 * 这一页新写的每一条线，删掉之后都不会红：路由没注册它只是访问不到、
 * previewUrl 传空串照样能发布（只是产物地址丢了）、SSE 少订一个事件页面照样
 * 有东西显示。这正是 predicate-and-wiring-discipline 的「形状 2：链路只建到
 * 一半」，必须用源码守卫钉住。
 *
 * 判据一律窗口化（只在那一段函数体 / JSX 里断言），不做全文 toContain——
 * 全文断言会被同名的注释、类型、import 喂饱，删掉真正的调用照样通过（假绿）。
 */

const WEB = path.resolve(process.cwd(), '../cds/web/src');

function read(relative: string): string {
  return fs.readFileSync(path.join(WEB, relative), 'utf8');
}

/** 取一个箭头函数/函数的函数体（跳过参数列表后配平大括号）。 */
function bodyAfter(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start, `源码里找不到 ${marker}`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start + marker.length);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${marker} 的函数体没有闭合`);
}

const PAGE = read('pages/ReleaseConsolePage.tsx');
const APP = read('App.tsx');
const SHELL = read('components/layout/AppShell.tsx');
const CENTER = read('pages/ReleaseCenterPage.tsx');
const CSS = read('index.css');

describe('发布控制台 · 路由与入口接线', () => {
  it('路由已注册在控制台外壳内（不注册就等于这一页不存在）', () => {
    expect(APP).toContain("import('@/pages/ReleaseConsolePage')");
    expect(APP).toMatch(/<Route path="\/release-console" element=\{<ReleaseConsolePage \/>\} \/>/);
    // 必须落在 ConsoleLayout 那组里，否则没有侧栏/命令面板，跟其它控制台页不是一个东西。
    const framed = APP.slice(APP.indexOf('<Route element={<ConsoleLayout />}>'), APP.indexOf('<Route path="*"'));
    expect(framed).toContain('/release-console');
  });

  it('导航高亮跟发布中心归同一项，进这一页侧栏不会失焦', () => {
    const fn = bodyAfter(SHELL, 'function activeNavKeyFor');
    expect(fn).toContain("pathname.startsWith('/release-console')");
    expect(fn).toMatch(/release-console'\)\)\s*return\s*'release-center'/);
  });

  /** 用户 2026-08-13：「肯定是要新版的」——左栏落地页必须是控制台，不是发布中心。 */
  it('左栏导航落地到发布控制台，发布中心退居管理面', () => {
    const rail = SHELL.slice(SHELL.indexOf('to="/release-console"'), SHELL.indexOf('<span>Releases</span>'));
    expect(rail, '左栏 Releases 应指向 /release-console').toContain('preloadReleaseConsolePage');
    expect(SHELL).not.toContain('to="/release-center"');
    // 接入 Agent 的语境识别要认得新落地页，否则在它上面退化成 general
    expect(read('lib/agent-onboarding.ts')).toContain("startsWith('/release-console')");
  });

  /**
   * 发布中心 → 发布控制台的跳转契约（2026-08-14 按设计稿重构后）。
   * 三个参数都在 consoleHref 一处拼：project 必带，target 让控制台落地即选中，
   * intent=rollback 让它知道用户是来退版本的。散成三处拼字符串必然漂移。
   */
  it('发布中心跳过来时带项目、目标与意图，且只有一处拼参数', () => {
    expect(CENTER).toContain("const consoleHref = (targetId?: string, intent?: 'rollback')");
    expect(CENTER).toContain("params.set('project', projectId)");
    expect(CENTER).toContain("params.set('target', targetId)");
    expect(CENTER).toContain("params.set('intent', intent)");
    expect(CENTER).toContain('/release-console?');
    // 矩阵行上的执行动作必须走这一处，不许另拼一条 URL
    expect(CENTER).toContain('navigate(consoleHref(envId,');
    // 模板字面量只许出现一次——就是 consoleHref 自己那一处
    expect(CENTER.match(/\/release-console\?\$\{/g) || [], '不许在别处再拼一遍 URL').toHaveLength(1);
  });

  /** 控制台这一侧要接住：target 落地即选中，intent 只提示不代替二次确认。 */
  it('控制台读 target 与 intent，回滚仍要走确认', () => {
    expect(PAGE).toContain("useState(params.get('target') || '')");
    expect(PAGE).toContain("useState(params.get('intent') || '')");
    expect(PAGE).toContain("arrivedIntent === 'rollback' && row");
    // 带个 query 就直接退线上版本，那是把危险动作降级成一条链接
    const strip = PAGE.slice(PAGE.indexOf("arrivedIntent === 'rollback' && row"), PAGE.indexOf('{blockedByOther'));
    expect(strip).not.toContain('rollbackRun(');
    // 用户手动切目标后也要写回 URL，否则刷新跳回默认目标
    expect(PAGE).toContain("next.set('target', targetId)");
  });
});

describe('发布控制台 · 数据接线', () => {
  /**
   * 最容易静默退化的一条：previewUrl 传空串，发布照样 202，只是产物地址没了，
   * 部署脚本里的 CDS_PREVIEW_URL 变成空。所以钉死「取自 resolveReleaseSourceUrls」
   * 而不是字面量。
   */
  it('发布来源地址取自后端下发的 previewUrl（SSOT），不是空串也不是前端拼的', () => {
    expect(PAGE).toContain("import { resolveReleaseSourceUrls } from '@/lib/releaseDialogAddress'");
    expect(PAGE).toContain('resolveReleaseSourceUrls({ branch })');
    const start = bodyAfter(PAGE, 'const startRelease = async ()');
    expect(start).toContain('previewUrl }');
    expect(start).not.toContain("previewUrl: ''");
    const preflight = bodyAfter(PAGE, 'const passesPreflight = async ()');
    expect(preflight).toContain('previewUrl }');
    expect(preflight).not.toContain("previewUrl: ''");
    // 前端自己 slugify 预览域名是 CLAUDE.md §11 明令禁止的
    expect(PAGE).not.toContain('.miduo.org');
  });

  it('三个 SSE 事件都订了：少订 release.log 就只剩转圈，少订 status 就永远不结束', () => {
    const effect = PAGE.slice(PAGE.indexOf('new EventSource'), PAGE.indexOf('useEffect(() => {\n    if (following'));
    expect(effect).toContain("addEventListener('snapshot'");
    expect(effect).toContain("addEventListener('release.log'");
    expect(effect).toContain("addEventListener('release.status'");
    // 断线续传：afterSeq 必须带上最后一条 seq，否则重连会把已有日志再灌一遍
    expect(effect).toContain('afterSeq=${logs.at(-1)?.seq || 0}');
    expect(effect).toContain('source.close()');
  });

  it('只有终态才回源刷 center，中间态刷等于把 SSE 的省流优势还回去', () => {
    const effect = PAGE.slice(PAGE.indexOf("addEventListener('release.status'"), PAGE.indexOf('return () => source.close()'));
    expect(effect).toContain('isReleaseTerminal(data.run.status)) void loadCenter()');
  });

  it('Agent 现场文本走共享的 buildReleaseAgentTask，这一页不另起一套措辞', () => {
    expect(PAGE).toContain("import { buildReleaseAgentTask } from '@/lib/releaseAgentTask'");
    const fn = bodyAfter(PAGE, 'const agentTask = ()');
    expect(fn).toContain('buildReleaseAgentTask({');
    // 判据分裂守卫（形状 3）：页面里不许再拼一遍那几个段落标题
    expect(fn).not.toContain('要求');
    expect(fn).not.toContain('门禁');
  });
});

describe('发布控制台 · 并发口径不许对后端撒谎', () => {
  /**
   * 设计稿写「同一时间只允许一处发布」，后端 assertTargetFree 保证的是**按目标**
   * 互斥。页面可以额外收紧到跨目标，但必须说清哪一道是服务端保证、哪一道是 UI 策略，
   * 否则用户会以为服务端拦得住并发，而实际上另一台机器同时发别的目标是允许的。
   */
  it('跨目标锁写明了是本页策略，服务端只保证同目标不并发', () => {
    expect(PAGE).toContain('服务端保证同一目标不并发');
    expect(PAGE).toContain('409');
    expect(PAGE).toContain('跨目标这一道是本页额外收的口');
    // 判据本身：blockedByOther 必须是「别的目标在跑」，不是「有任何 run 在跑」
    expect(PAGE).toContain('liveRun.targetId !== row.target.id');
  });

  it('发布配置只读，改配置指回发布中心，不开第二处写入口', () => {
    const sheet = PAGE.slice(PAGE.indexOf("sheet === 'pipeline'"), PAGE.indexOf("sheet === 'agent'"));
    expect(sheet).toContain('href="/release-center"');
    expect(sheet).not.toContain('<input');
    expect(sheet).not.toContain("method: 'POST'");
  });

  /**
   * 受保护环境两段式确认。第一下只换按钮文案，第二下才真发——
   * 若哪天有人把 isProtected 那一岔删掉，正式环境就变成一点就发。
   */
  it('受保护环境要点两下才真发', () => {
    expect(PAGE).toContain("row?.target.isCanonical && row.target.environment === 'production'");
    expect(PAGE).toContain('if (isProtected && !awaitingConfirm) { setConfirmTargetId(row.target.id); return; }');
    expect(PAGE).toContain('确认发布到 ');
  });
});

describe('发布控制台 · 对齐设计稿的组件', () => {
  /**
   * 「点了之后就卡住没后续」是用户提需求时的原话，卡住条就是它的答复。
   * 这条守卫盯的是「它还在页面上」——删掉后页面照样编译、照样跑，只是抱怨原样复现。
   */
  it('卡住条在，并给出取证与中止两个出口', () => {
    expect(PAGE).toContain('import { detectStall');
    expect(PAGE).toContain('{stall.stalled ? (');
    const strip = PAGE.slice(PAGE.indexOf('{stall.stalled ? ('), PAGE.indexOf('终态结论条'));
    expect(strip).toContain('秒没有新输出了');
    expect(strip).toContain("setSheet('agent')");
    expect(strip).toContain('cancelRun()');
  });

  it('终态给结论条，失败挂重发、成功可回滚', () => {
    const strip = PAGE.slice(PAGE.indexOf('{shown && !running ? ('), PAGE.indexOf('{preflight ? ('));
    expect(strip).toContain('diagnosis?.headline');
    expect(strip).toContain('retryRun(shown)');
    expect(strip).toContain('rollbackRun(shown)');
  });

  it('步骤条带真实命令与真实耗时，未执行的给短横不编预估值', () => {
    expect(PAGE).toContain('resolveStepDetails(shown');
    const list = PAGE.slice(PAGE.indexOf('{progress.steps.map((step)'), PAGE.indexOf('{progress.degraded ?'));
    // 断言的是「条件与渲染都用这个取值」，不只是「这串字符出现过」——
    // 只改条件、留着内层引用的改法，宽判据抓不到（红绿闭环时验出来的）。
    expect(list).toContain('{stepDetails.get(step.id)?.command ? (');
    expect(list).toContain('{stepDetails.get(step.id)?.command}');
    expect(list).toContain("typeof stepDetails.get(step.id)?.durationMs === 'number'");
    expect(list).toContain(": '-'");
  });

  it('环境按后端下发的分组渲染，落后数来自 commitPosition', () => {
    expect(PAGE).toContain("from '@/lib/releaseEnvironments'");
    expect(PAGE).toContain('buildEnvironmentSections(center?.environments, rows)');
    expect(PAGE).toContain('item.commitPosition?.behindCount');
    // 后端 environment 枚举只有 production/staging/other —— 不许造一个 customer 分组
    expect(PAGE).not.toContain("=== 'customer'");
  });

  /** demo 自己修掉的结构问题：配置类不塞 348px 窄栏。别把它再犯回来。 */
  it('流水线与 Agent 走全屏浮层，不塞回右侧窄栏', () => {
    expect(PAGE).toContain("type SheetKind = 'pipeline' | 'agent' | null");
    expect(PAGE).toContain("type RailPane = 'history' | 'failed'");
    expect(PAGE).not.toContain("pane === 'config'");
    const sheetFn = PAGE.slice(PAGE.indexOf('function Sheet('), PAGE.indexOf('export function ReleaseConsolePage'));
    expect(sheetFn).toContain('fixed inset-0');
    expect(sheetFn).toContain("aria-modal=\"true\"");
    // Esc 关闭：全屏浮层没有键盘出口是无障碍缺陷
    expect(sheetFn).toContain("event.key === 'Escape'");
  });

  /**
   * 生产真数据抓到的两条，都是「编译通过、stub 看不出来」的那种：
   * 1. 分支下拉整列空白——真实 /api/branches 的展示名字段是 branch，不是 name；
   * 2. 默认环境落到一个已停用的临时目标上——rows[0] 不是选中判据。
   */
  it('分支展示名用 branch 字段，且不自建 BranchOption 类型', () => {
    expect(PAGE).toContain('{item.branch}');
    expect(PAGE).not.toMatch(/interface BranchOption\s*\{/);
    expect(PAGE).toContain("import type { BranchOption, CenterResponse");
  });

  it('选中环境走 resolveSelectedTargetId，不用 rows[0] 兜底', () => {
    expect(PAGE).toContain('resolveSelectedTargetId(envSections, targetId)');
    // loadCenter 里也不许自己挑第一行
    const load = bodyAfter(PAGE, 'const loadCenter = useCallback(async ()');
    expect(load).not.toContain('res.rows[0]');
  });

  it('历史记录每条自带行内操作，不用先选中再去别处找按钮', () => {
    const rail = PAGE.slice(PAGE.indexOf('const list = pane ==='), PAGE.indexOf('══ 浮层：发布流水线'));
    expect(rail).toContain('看日志');
    expect(rail).toContain('重发这一版');
    expect(rail).toContain('回滚到此版本');
    expect(rail).toContain('retryRun(item)');
    expect(rail).toContain('rollbackRun(item)');
  });
});

/**
 * 英文字形。用户原话「你的字体 low 爆了」，对照物是分支卡的分支名；
 * 2026-08-15 进一步要求「把分支名的字体作为 CDS 的默认英文字体，
 * 现在整个站都是像素点」。
 *
 * 根因是一个真实缺陷而不只是审美：body 首选 `Inter`、Tailwind 的 font-mono
 * 首选 `JetBrains Mono`，而这两个字体**仓库从来没有加载过**——没有 @font-face、
 * 没有 CDN link、没有 @fontsource 依赖。于是英文字形在每台机器上各凭兜底，
 * 用户看到的像素点就是他那台机器的兜底字体。
 *
 * 现在全站英文只有一个来源 `--cds-font-latin`（系统自带的 UI 等宽栈，
 * 一定装得到、一定带 hinting）。下面三条把它钉死。
 */
describe('发布控制台 · 英文字形与分支卡同源', () => {
  it('标识符字形是唯一一份定义，分支名与新页面共用', () => {
    // 同一条规则里同时挂两个选择器 = SSOT；抄成两份迟早漂移
    expect(CSS).toMatch(/\.cds-ident,\s*\n\s*\.cds-branch-name\s*\{/);
    expect(CSS).toContain('font-family: var(--cds-font-latin)');
    expect(CSS).toContain('letter-spacing: -0.015em');
  });

  it('全站英文字形只有一个来源：body 与标识符共用 --cds-font-latin', () => {
    // token 只定义一次
    expect((CSS.match(/--cds-font-latin:/g) || []).length).toBe(1);
    // body 用它（英文），CJK 落到后面的中文栈
    expect(CSS).toContain('font-family: var(--cds-font-latin), var(--cds-font-cjk);');
    // 不许再出现第二份手写栈——那正是「分支名一种字、正文另一种字」的来源
    expect(CSS).not.toMatch(/font-family:\s*(ui-monospace|'Inter')/);
  });

  /**
   * 声明了却没加载的字体是这次事故的根因：它不会报错，只会让每台机器
   * 各自兜底，于是「我这边看着好好的」和「用户说有像素点」同时成立。
   * 除非仓库真的打包了字体文件，否则不许在字体栈里点名任何非系统字体。
   */
  it('不许再点名仓库没有加载的字体（Inter / JetBrains Mono）', () => {
    const tailwind = fs.readFileSync(path.resolve(process.cwd(), '../cds/web/tailwind.config.js'), 'utf8');
    // 先剥注释再判：注释里解释「为什么不用 Inter」的那段话本身含 Inter 字样，
    // 不剥的话判据读到的是自己的注释，永远红（形状 6：读的不是生效的那个值）。
    const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const cssCode = strip(CSS);
    expect(cssCode, '若真要用自带字体，请先加 @font-face 再放进字体栈').not.toMatch(/@font-face\s*\{/);
    for (const [name, source] of [['index.css', cssCode], ['tailwind.config.js', strip(tailwind)]] as const) {
      expect(source, `${name} 点名了未加载的 Inter`).not.toContain('Inter');
      expect(source, `${name} 点名了未加载的 JetBrains Mono`).not.toContain('JetBrains Mono');
    }
  });

  it('页面不用 Tailwind 的 font-mono —— 那个栈把没打包的 JetBrains Mono 排在第一位', () => {
    expect(PAGE).not.toContain('font-mono');
    expect(PAGE).toContain('cds-ident');
  });

  /**
   * 字号下限 10px。原本卡在 11px——那是 2026-08-13「字体 low 爆了」之后自己定的，
   * 当时页面上确实有一片 10/10.5 的碎字。参考稿 f8d4af4b 的角标与元信息行就是
   * 10 / 10.5px 等宽，用户 08-14 明确要求照它做，所以下限跟着参考稿走。
   * 10px 以下仍然不行：等宽字到那个尺寸笔画会糊。
   */
  it('没有 10px 以下的字号：等宽字再小笔画会糊', () => {
    const tooSmall = [...PAGE.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n < 10);
    expect(tooSmall, `这些字号太小: ${tooSmall.join(', ')}`).toEqual([]);
  });

  /**
   * 分区标题按参考稿走终端风：11px 等宽 + 0.14em 字距。
   * 曾经改成过房内惯例（text-xs font-semibold uppercase tracking-normal），
   * 用户 08-14 的原话是「严格对照参考稿，不要自己创意」——改回来。
   * 而且必须是**唯一一份定义**（SectionLabel），四处各写各的就会漂移。
   */
  it('分区标题照参考稿的终端风，且只有一份定义', () => {
    expect(PAGE).toContain("className=\"cds-ident text-[11px] uppercase tracking-[0.14em] text-muted-foreground\"");
    // 除 SectionLabel 自身外，不许再有第二处手写同款标题样式
    expect(PAGE.match(/tracking-\[0\.14em\]/g) || []).toHaveLength(1);
    for (const label of ['PROJECTS', 'ENVIRONMENTS', 'Pipeline', 'Live output']) {
      expect(PAGE, `${label} 应当走 SectionLabel`).toContain(`<SectionLabel>${label}</SectionLabel>`);
    }
  });

  it('日志区不用 break-all —— 它会把正常英文单词从中间劈开', () => {
    const log = PAGE.slice(PAGE.indexOf('ref={logRef}'), PAGE.indexOf('LOG_TONE_CLASS[logLineTone') + 200);
    expect(log).toContain('break-words');
    expect(log).not.toContain('break-all');
  });

  /**
   * 实时输出是终端，不是一块同色文本。参考稿里命令行提亮、成功行绿、错误行红，
   * 左边固定一列时间——扫一眼就知道跑到哪、哪步炸了。着色判据只看真实内容
   * （后端给的 level + `$ ` 前缀），不猜。
   */
  it('日志按语义着色，时间单独成列', () => {
    expect(PAGE).toContain('LOG_TONE_CLASS[logLineTone(log.level, log.message)]');
    expect(PAGE).toContain('text-muted-foreground/60">{formatClock(log.at)}');
    // 别再把 `[时间] LEVEL 正文` 拼成一整行塞进 pre
    expect(PAGE).not.toContain('log.level.toUpperCase()');
  });
});

describe('发布控制台 · 窄屏与主题纪律', () => {
  it('桌面三栏、窄屏自然流（desktop-fill 必须配 mobile-flow 兜底）', () => {
    // 列宽照参考稿走（见下一条），这里只管「窄屏自然流 + 桌面才交给各栏内滚」这个契约，
    // 别把两件事写死在同一个字符串里——改一下列宽就要连带改这条，久了就没人敢动。
    expect(PAGE).toMatch(
      /flex h-full min-h-0 flex-col overflow-y-auto max-xl:gap-4 max-xl:p-4 xl:grid xl:grid-cols-\[[^\]]+\]/,
    );
    expect(PAGE).toContain('xl:overflow-hidden');
  });

  /**
   * 三栏在 xl（1280）才接管，不是 lg（1024）。
   *
   * 参考稿 f8d4af4b 的列宽是在宽画布上量的：两侧固定列一共吃掉 600-700px，
   * 1024 宽下中栏只剩 278px——流水线卡 232 之后给实时输出留 32px，一格都读不了。
   * 实测过才发现：三栏这个结构本身就要 ~1280 才成立，硬塞进 lg 只是换一种坏。
   * 1024-1280 用自然流（各块竖排、自身限高滚动），到 xl 才切回固定外壳三栏。
   */
  it('三栏在 xl 才接管，lg 段仍走自然流', () => {
    expect(PAGE).toContain('xl:grid-cols-[240px_minmax(0,1fr)_300px]');
    expect(PAGE).toContain('2xl:grid-cols-[288px_minmax(0,1fr)_380px]');
    // lg 段不许再出现任何三栏/内滚开关，否则 1024 又会被塞回去
    expect(PAGE).not.toMatch(/(?<![a-z0-9-])lg:/);
  });

  /**
   * 中栏不许给 min-width。写过 `minmax(560px,1fr)`，实测 1024 宽下三栏总最小
   * 1260px 超出可用的 878px，grid 到 982 就结束、右栏一路画到 1364——历史记录
   * 那一整栏被切掉 382px（1280 下仍切 126px），而外层 overflow-hidden 让它
   * 既不报横向滚动也看不出来。固定列 + 无下界的 1fr 才不会溢出。
   */
  it('中栏不设 min-width —— 那会把右栏挤出画布并被裁掉', () => {
    expect(PAGE).not.toMatch(/grid-cols-\[[^\]]*minmax\(\d+px,\s*1fr\)/);
  });

  /**
   * 实时输出的卡头带按钮，而卡片是 overflow-hidden——超宽会被直接裁掉
   * （实测 scrollWidth 291 / clientWidth 244，「交给智能体」半个按钮消失在卡外）。
   * 宽度不够必须换行，不许裁。流水线卡头照参考稿只有一个标签，无此风险。
   */
  it('实时输出卡头可换行，不会把按钮裁在卡片外', () => {
    const head = PAGE.slice(PAGE.indexOf('<SectionLabel>Live output</SectionLabel>') - 400, PAGE.indexOf('<SectionLabel>Live output</SectionLabel>'));
    expect(head).toContain('flex-wrap');
  });

  /**
   * 窄屏顺序：状态在最前。用户来这一页第一眼要看的是「现在成没成」，
   * 按 DOM 顺序（左栏在前）会把状态卡压到第一屏之外——正是「点了之后就卡住
   * 没后续」这个抱怨的成因。桌面不受影响，order 只在 max-xl 生效。
   */
  it('窄屏把状态排到第一位，项目与记录退到后面', () => {
    expect(PAGE).toContain('max-xl:order-1');
    expect(PAGE).toContain('max-xl:order-2');
    expect(PAGE).toContain('max-xl:order-3');
    const mainAt = PAGE.indexOf('max-xl:order-1');
    const asideAt = PAGE.indexOf('max-xl:order-2');
    // order-1 必须挂在 <main> 上：挂错元素时这条会红
    expect(PAGE.slice(PAGE.lastIndexOf('<', mainAt), mainAt)).toContain('main');
    expect(PAGE.slice(PAGE.lastIndexOf('<', asideAt), asideAt)).toContain('aside');
  });

  it('颜色一律走 token，没有写死的暗色底或浅色字', () => {
    // cds-theme-tokens.md 最高原则：白天主题下不许出现暗色字面量
    expect(PAGE).not.toMatch(/#(0a0a0f|0b0b10|1f1d2b|0f1419|e8e8ec|cbd5e1)/i);
    // 新栈 token 是 HSL 三元组，裸 var() 会让整条属性静默失效
    expect(PAGE).not.toMatch(/:\s*var\(--surface-/);
    expect(PAGE).toContain('hsl(var(--surface-sunken))');
  });
});

/**
 * 窄屏（< xl）整页是自然流：外壳 `h-full ... overflow-y-auto` 是个有界滚动容器，
 * 三块作为 flex item 默认 `shrink: 1`，会被压到比内容矮——而它们的 overflow-hidden
 * 只在 xl 生效，于是内容直接溢出、画在下一块上面。390px 实测：PROJECTS、
 * ENVIRONMENTS、历史发布三张卡互相叠印，读都读不了（cds 的 mobile-layout-fallback
 * 第一条讲的就是这个）。窄屏必须 shrink-0，让外壳去滚。
 */
describe('发布控制台 · 窄屏不许叠印', () => {
  it('三栏在窄屏都是 shrink-0，靠外壳滚动而不是被压扁', () => {
    for (const order of ['max-xl:order-1', 'max-xl:order-2', 'max-xl:order-3']) {
      const at = PAGE.indexOf(order);
      expect(at, `${order} 不见了`).toBeGreaterThan(-1);
      const cls = PAGE.slice(PAGE.lastIndexOf('className="', at), PAGE.indexOf('"', at));
      expect(cls, `${order} 那一块窄屏会被压扁并叠印，需要 max-xl:shrink-0`).toContain('max-xl:shrink-0');
    }
  });
});

/**
 * 状态条必须能在一行里放下（参考稿如此）。最容易把它顶成两行的是发布按钮的文案：
 * 写成「发布到 {目标名}」时，目标名一长就换行，banner 从 106px 涨到 164px——
 * 那正是用户说的「头大」。目标名副标题里已经有了。
 */
describe('发布控制台 · 状态条不许被按钮文案顶高', () => {
  it('发布按钮是短词，不把目标名塞进按钮', () => {
    expect(PAGE).not.toContain('`发布到 ${row.target.name}`');
    // 文案改由 buildConsoleStance 统一给（历史态要说「重新发布这一版」）。
    // 断言的是「短」这个行为，不是某一段三元表达式的字面存在：
    // 钉字面量会让下一个人改文案时被迫改测试，或者干脆把测试注释掉。
    expect(PAGE).toContain('stance.primaryLabel');
    const stance = fs.readFileSync(
      path.resolve(process.cwd(), '../cds/web/src/lib/releaseConsoleState.ts'),
      'utf8',
    );
    for (const label of stance.match(/primaryLabel: '[^']+'/g) || []) {
      const text = label.replace(/^primaryLabel: '|'$/g, '');
      expect(text.length, `按钮文案「${text}」太长，会把状态条顶成两行`).toBeLessThanOrEqual(8);
    }
    // 二次确认那一下例外：要人看清发到哪
    expect(PAGE).toContain('`确认发布到 ${row?.target.name}`');
  });
});

/**
 * 状态条一行的宽度预算（实测 1600 宽：内容行 764px）。
 *
 * 换行判据用的是各项的**假想主尺寸**（flex-basis，中段被 min-width 兜住），
 * 不是 grow 之后的结果——所以中段写 basis-0 也救不了：只要
 * 52(图标) + 18 + 中段 min-width + 18 + 操作组 > 764 就换行，实测差 16px。
 * 这条守卫钉住两个预算值，改大任意一个都要重新量。
 */
describe('发布控制台 · 状态条一行的宽度预算', () => {
  it('中段 min-width 留得下操作组，且版本选择不在操作组里', () => {
    expect(PAGE).toContain('min-w-[340px] flex-1 basis-0');
    const STACK_MIN = 340;
    const ICON = 52;
    const GAP = 18;
    // 操作组只有三个按钮：发布 + 试跑 + 中止 + 两个 8px 间隔
    const GROUP = 120 + 72 + 90 + 8 * 2;
    expect(ICON + GAP + STACK_MIN + GAP + GROUP, '1600 宽下内容行只有 764px').toBeLessThanOrEqual(764);
  });

  /**
   * 版本选择必须在标题行，不在操作组。放进操作组时那一行要装「选择 + 三个按钮」
   * 约 480px，中段只剩 194px——进度条被压成一小截，而参考稿的进度条横贯整个中段。
   */
  it('版本选择在标题行，进度条才横贯中段', () => {
    const titleRow = PAGE.slice(PAGE.indexOf('flex flex-wrap items-baseline gap-x-3'), PAGE.indexOf('overflow-hidden rounded bg-[hsl(var(--surface-sunken))]'));
    expect(titleRow, '版本选择应当在标题行里').toContain('aria-label="要发布的版本"');
    const group = PAGE.slice(PAGE.indexOf('[&_button]:h-10'), PAGE.indexOf('试跑'));
    expect(group, '操作组里不该再有版本选择').not.toContain('aria-label="要发布的版本"');
  });
});

/**
 * 节奏（用户 2026-08-14：「demo 的节奏性很足，而我们的节奏性差很多」）。
 *
 * 参考稿跑起来时有三处在动：进度条流动的斜纹、状态图标的呼吸光晕、日志一行行落下。
 * 首版只搬了静态版式——一根实心条 + 一个转圈图标，于是「在动」看着像「卡着」。
 * 三条都只在进行中出现，终态一律静止：动效是用来表达「还在跑」的。
 */
describe('发布控制台 · 节奏', () => {
  it('进度条跑动时是流动斜纹，终态静止', () => {
    expect(CSS).toContain('.cds-progress-fill--running');
    expect(CSS).toContain('@keyframes cds-progress-flow');
    expect(CSS).toContain('background-size: 40px 40px');
    // 只有 running 才挂 --running，终态不许一直流
    expect(PAGE).toContain("${running ? 'cds-progress-fill--running' : ''}");
  });

  it('状态图标进行中呼吸，终态静止', () => {
    expect(CSS).toContain('@keyframes cds-status-pulse');
    expect(PAGE).toContain("${running ? 'cds-status-pulse' : ''}");
  });

  it('日志新行是落下来的，不是整块突然变长', () => {
    expect(CSS).toContain('@keyframes cds-log-line-in');
    expect(PAGE).toContain('className="cds-log-line flex gap-2.5"');
  });

  it('正在跑的那一步说出来，不只靠一个转圈图标', () => {
    const list = PAGE.slice(PAGE.indexOf('{progress.steps.map((step)'), PAGE.indexOf('{progress.degraded ?'));
    expect(list).toContain("step.state === 'running' ? (");
    expect(list).toContain('运行中');
    expect(list).toContain('transition-colors duration-200');
  });

  /** 三条动效都必须能被系统偏好关掉——这是本仓库对「克制动效」的一贯要求。 */
  it('三条动效都走 prefers-reduced-motion 兜底', () => {
    const block = CSS.slice(CSS.indexOf('.cds-progress-fill {'));
    const reduce = block.slice(block.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const cls of ['.cds-progress-fill--running', '.cds-status-pulse', '.cds-log-line']) {
      expect(reduce.slice(0, 400), `${cls} 应当在 reduced-motion 里被关掉`).toContain(cls);
    }
  });
});

/**
 * 发布前检查并进发布，不再是一个并列按钮（用户 2026-08-14：「干脆合并，不让单独
 * 试跑，让软件根据情况自动做决定」）。后端 startRelease 本来就会先跑一遍
 * （release-service 的 resolvePreflight，不过就抛错），单独摆个按钮既多一步，
 * 又让人以为不点就不检查。
 */
describe('发布控制台 · 发布前检查是发布的第一步', () => {
  it('没有单独的试跑按钮，检查在 startRelease 里先跑', () => {
    const group = PAGE.slice(PAGE.indexOf('flex w-full flex-wrap items-center justify-end'), PAGE.indexOf('</section>'));
    expect(group, '操作组里不该再有试跑按钮').not.toContain('试跑');
    const start = bodyAfter(PAGE, 'const startRelease = async ()');
    expect(start, '发布前必须先过检查').toContain('if (!(await passesPreflight())) return;');
  });

  /** 检查全过时不弹结果面板——它已经继续往下发了，一屏绿勾是噪音。 */
  it('检查全过不打扰，只有被拦下才摊开原因', () => {
    const fn = bodyAfter(PAGE, 'const passesPreflight = async ()');
    expect(fn).toContain("check.blocking && check.status === 'fail'");
    expect(fn).toContain('setPreflight(blocking.length > 0 ? res : null)');
    expect(PAGE).toContain('发布前检查未通过，已停在发布前');
  });

  /**
   * 按钮顺序：开始永远在最右，中止只在跑的时候出现（用户定）。
   * 中止常驻时是一个 90% 时间都点不了的灰按钮，占位又没用。
   */
  it('开始在最右，中止只在进行中出现', () => {
    const group = PAGE.slice(PAGE.indexOf('flex w-full flex-wrap items-center justify-end'), PAGE.indexOf('</section>'));
    const cancelAt = group.indexOf('中止');
    // 主按钮的文案已收进 buildConsoleStance，锚点换成它的渲染点，
    // 不再依赖「开始发布」这个字面量出现在页面里。
    const startAt = group.indexOf('stance.primaryLabel');
    expect(cancelAt, '中止按钮应当存在').toBeGreaterThanOrEqual(0);
    expect(startAt, '主发布按钮应当存在').toBeGreaterThanOrEqual(0);
    expect(cancelAt, '中止应当在开始之前（即更靠左）').toBeLessThan(startAt);
    expect(group).toContain('{running ? (');
    expect(group).toContain('justify-end');
  });
});

/**
 * 满铺的两栏不许有圆角。`.cds-surface-*` 自带 --radius，贴边时读作
 * 「圆角矩形硬怼在视口边上」——用户 2026-08-14 圈的就是这个（实测 radius 10px）。
 * 要么全都贴边不带角，要么全都留距离带角；不许一半一半。
 */
describe('发布控制台 · 贴边的栏不带圆角', () => {
  it('左右两栏在桌面档 rounded-none，窄屏浮起来时才给圆角', () => {
    for (const order of ['max-xl:order-2', 'max-xl:order-3']) {
      const at = PAGE.indexOf(order);
      const cls = PAGE.slice(PAGE.lastIndexOf('className="', at), PAGE.indexOf('"', at));
      expect(cls, `${order} 那一栏贴边时不许有圆角`).toContain('xl:rounded-none');
      expect(cls, `${order} 那一栏窄屏浮起来时要有圆角`).toContain('max-xl:rounded-[14px]');
    }
  });

  /** 满铺页自己不滚，留着 scrollbar-gutter 会让右栏差 10px 贴不到边。 */
  it('满铺页不给滚动条留位', () => {
    expect(CSS).toContain('.cds-main:has(> .cds-workspace--bleed)');
    expect(CSS).toMatch(/\.cds-main:has\(> \.cds-workspace--bleed\) \{[\s\S]{0,80}scrollbar-gutter: auto/);
  });
});
