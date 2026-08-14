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

  it('发布中心有进这一页的入口，并把当前项目带过去', () => {
    expect(CENTER).toContain('/release-console?project=');
    expect(CENTER).toContain('encodeURIComponent(projectId)');
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
    const preflight = bodyAfter(PAGE, 'const runPreflight = async ()');
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
 * 英文字形。用户原话「你的字体 low 爆了」，对照物是分支卡的分支名。
 * 差距是三件事叠出来的：字号（10px vs 17px）、字重（400 vs 600）、
 * 字距（撑开 0.14em vs 收紧 0.015em），外加字体栈根本不是同一个。
 * 这几条删掉之后页面照样跑，所以必须钉住。
 */
describe('发布控制台 · 英文字形与分支卡同源', () => {
  it('标识符字形是唯一一份定义，分支名与新页面共用', () => {
    // 同一条规则里同时挂两个选择器 = SSOT；抄成两份迟早漂移
    expect(CSS).toMatch(/\.cds-ident,\s*\n\s*\.cds-branch-name\s*\{/);
    expect(CSS).toContain('font-family: ui-monospace, SFMono-Regular, Menlo, monospace');
    expect(CSS).toContain('letter-spacing: -0.015em');
  });

  it('页面不用 Tailwind 的 font-mono —— 那个栈把没打包的 JetBrains Mono 排在第一位', () => {
    expect(PAGE).not.toContain('font-mono');
    expect(PAGE).toContain('cds-ident');
  });

  it('没有 11px 以下的字号：等宽字在 10px 下笔画会糊', () => {
    const tooSmall = [...PAGE.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n < 11);
    expect(tooSmall, `这些字号太小: ${tooSmall.join(', ')}`).toEqual([]);
  });

  it('分区标题走 CDS 房内惯例，不用 demo 的终端风宽字距', () => {
    expect(PAGE).toContain('text-xs font-semibold uppercase tracking-normal text-muted-foreground');
    expect(PAGE).not.toContain('tracking-[0.14em]');
  });

  it('日志区不用 break-all —— 它会把正常英文单词从中间劈开', () => {
    const log = PAGE.slice(PAGE.indexOf('ref={logRef}'), PAGE.indexOf('shownLogs.length === 0'));
    expect(log).toContain('break-words');
    expect(log).not.toContain('break-all');
  });
});

describe('发布控制台 · 窄屏与主题纪律', () => {
  it('桌面三栏、窄屏自然流（desktop-fill 必须配 mobile-flow 兜底）', () => {
    // 列宽照参考稿走（见下一条），这里只管「窄屏自然流 + 桌面才交给各栏内滚」这个契约，
    // 别把两件事写死在同一个字符串里——改一下列宽就要连带改这条，久了就没人敢动。
    expect(PAGE).toMatch(
      /flex h-full min-h-0 flex-col gap-4 overflow-y-auto lg:grid lg:grid-cols-\[[^\]]+\]/,
    );
    expect(PAGE).toContain('lg:overflow-hidden');
  });

  /**
   * 列宽取自参考稿 f8d4af4b 的实测值。用户 2026-08-13 的原话是「你应该按照
   * 参考稿的设定，包括宽度」——首版自己拍了 264/348，看着就是不对味。
   * 中栏给 560px 下界，是为了不让实时输出在中等宽度被两侧挤成细条。
   */
  it('三栏列宽照参考稿，不自己拍脑袋', () => {
    expect(PAGE).toContain('lg:grid-cols-[288px_minmax(560px,1fr)_380px]');
  });

  /**
   * 窄屏顺序：状态在最前。用户来这一页第一眼要看的是「现在成没成」，
   * 按 DOM 顺序（左栏在前）会把状态卡压到第一屏之外——正是「点了之后就卡住
   * 没后续」这个抱怨的成因。桌面不受影响，order 只在 max-lg 生效。
   */
  it('窄屏把状态排到第一位，项目与记录退到后面', () => {
    expect(PAGE).toContain('max-lg:order-1 lg:overflow-hidden');
    expect(PAGE).toContain('max-lg:order-2');
    expect(PAGE).toContain('max-lg:order-3');
    const mainAt = PAGE.indexOf('max-lg:order-1');
    const asideAt = PAGE.indexOf('max-lg:order-2');
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
