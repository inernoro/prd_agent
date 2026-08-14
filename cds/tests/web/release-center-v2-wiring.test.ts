import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 发布中心 v2 的**接线守卫**。
 *
 * 后端 `GET /api/releases/center` 已经把 commitRail / environments / commitMeta /
 * commitPosition / promotion / 每目标 dora / availability24h 全部下发；这些字段
 * 一旦在前端断掉一层（少传一个 prop、少渲染一个组件），页面照样编译、照样有东西、
 * 全量测试照样绿——只是那块信息**静默消失**。这正是 predicate-and-wiring-discipline
 * 里「形状 2：链路只建到一半」，必须用源码守卫钉住。
 *
 * 判据一律**窗口化**（只在那一段 JSX / 那个函数体里断言），不做全文 toContain：
 * 全文断言会被同名的定义、注释、类型声明喂饱，删掉真正的调用照样通过（假绿）。
 */

const WEB = path.resolve(process.cwd(), '../cds/web/src');

function read(relative: string): string {
  return fs.readFileSync(path.join(WEB, relative), 'utf8');
}

/** 取一段 JSX 元素的完整文本（从 `<Name` 到与之配平的 `>`），用于 prop 断言。 */
function jsxElement(source: string, name: string): string {
  const start = source.indexOf(`<${name}`);
  expect(start, `源码里找不到 <${name}> 的使用`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`<${name}> 的属性列表没有闭合`);
}

/**
 * 取一个函数体（从签名到配平的 `}`），用于「这个调用真的在这个函数里」的断言。
 *
 * 必须先跳过参数列表：本仓库的组件全用解构参数（`function X({ a, b }: Props)`），
 * 直接找第一个 `{` 会取到解构块，配平后拿到的是一段参数名，断言必然假红。
 */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `源码里找不到函数 ${signature}`).toBeGreaterThanOrEqual(0);
  const parenStart = source.indexOf('(', start);
  let parens = 0;
  let afterParams = -1;
  for (let i = parenStart; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') {
      parens -= 1;
      if (parens === 0) { afterParams = i + 1; break; }
    }
  }
  expect(afterParams, `函数 ${signature} 的参数列表没有闭合`).toBeGreaterThan(0);
  const open = source.indexOf('{', afterParams);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`函数 ${signature} 没有闭合`);
}

const page = read('pages/ReleaseCenterPage.tsx');
const sidebar = read('pages/release-center/EnvironmentSidebar.tsx');
const overview = read('pages/release-center/OverviewTab.tsx');
const timeline = read('pages/release-center/ReleaseTimeline.tsx');
const diagnosis = read('pages/release-center/FailureDiagnosis.tsx');
const health = read('pages/release-center/HealthTab.tsx');
const config = read('pages/release-center/ConfigTab.tsx');
const startDialog = read('pages/release-center/StartReleaseDialog.tsx');
const branchList = read('pages/BranchListPage.tsx');

describe('发布中心 v2 · 后端字段必须真的接到屏幕上', () => {
  it('commitRail → 顶部流水轴（可见性判定 + 真的渲染）', () => {
    expect(page).toContain('railIsVisible(rail)');
    const element = jsxElement(page, 'CommitRail');
    expect(element).toContain('rail={rail}');
    expect(element).toContain('markers={railMarkers}');
    expect(element).toContain('selectedPosition={selectedRow?.commitPosition}');
  });

  it('environments → 左栏环境分组（前端不再自己归一 environment）', () => {
    expect(page).toContain('buildEnvironmentSections(center?.environments, rows)');
    const element = jsxElement(page, 'EnvironmentSidebar');
    expect(element).toContain('sections={sections}');
    // 前端一旦自己按 environment 字段归一，就会与后端 release-environment.ts 判据分裂。
    expect(page).not.toContain("target.environment ?? 'production'");
    expect(sidebar).not.toContain("environment || 'production'");
  });

  it('commitPosition → 左栏那句「落后 main N 个提交」', () => {
    expect(sidebar).toContain('describeCommitPosition(row.commitPosition, branch)');
    expect(functionBody(overview, 'export function OverviewTab('))
      .toContain('describeCommitPosition(row.commitPosition, branch)');
  });

  it('commitMeta → 时间线上的提交说明（缺席时只显示 short sha，不拿别的字段顶替）', () => {
    expect(jsxElement(page, 'OverviewTab')).toContain('commitMeta={commitMeta}');
    expect(jsxElement(page, 'ReleaseTimeline')).toContain('commitMeta={commitMeta}');
    expect(timeline).toContain('commitMeta[run.commitSha]');
    expect(timeline).toContain("meta?.subject || `提交 ${run.commitSha.slice(0, 12)}`");
  });

  it('promotion → 提升按钮，且走 expectedCommitSha 钳制而不是「发分支最新版」', () => {
    expect(functionBody(overview, 'export function OverviewTab(')).toContain('row.promotion');
    const promote = functionBody(page, 'const startPromotion = async');
    expect(promote).toContain('row.promotion.releaseId');
    expect(promote).toContain('expectedCommitSha: row.promotion.commitSha');
    // 钳制必须真的进请求体，否则分支已前进时会静默发出另一个版本。
    expect(functionBody(startDialog, 'const start = async')).toContain('expectedCommitSha: intent.expectedCommitSha');
  });

  it('每目标 dora → 概览第三格；没有它时说「样本不足」而不是渲染 0', () => {
    const body = functionBody(overview, 'export function OverviewTab(');
    expect(body).toContain('row.dora');
    expect(body).toContain('样本不足');
    expect(body).not.toMatch(/changeFailure\.ratio\s*\|\|\s*0/);
  });

  it('availability24h → 健康页与概览健康格；未监测不许显示成 0%', () => {
    expect(health).toContain('health?.availability24h');
    expect(functionBody(overview, 'export function OverviewTab(')).toContain('row.health?.availability24h');
    const shared = read('pages/release-center/shared.tsx');
    expect(functionBody(shared, 'export function formatAvailability(')).toContain("'未监测'");
  });

  it('失败判据 → 诊断视图真的调用了提取器，而不是只丢一段 stderr', () => {
    expect(functionBody(diagnosis, 'export function FailureDiagnosis(')).toContain('diagnoseReleaseFailure(run.logs');
    // 失败行必须能就地展开诊断（不再要求用户跳一次页面）。
    expect(timeline).toContain('<FailureDiagnosis');
    expect(timeline).toContain('看失败原因');
  });

  /**
   * 止血三条的接线守卫（2026-08-12）。判据层已经在 releaseDiagnosis 里有单测，
   * 但「结论位有没有兜底截断」「影响面有没有真的渲染出来」「归并后的分组有没有
   * 接进两个日志区块」这三件事删掉之后，页面照样编译、单测照样绿——正是形状 2，
   * 必须在源码层钉住。
   */
  it('结论位恒为一句话：line-clamp 兜底还在', () => {
    const body = functionBody(diagnosis, 'export function FailureDiagnosis(');
    expect(body).toMatch(/line-clamp-2[^>]*>\{diagnosis\.headline\}/);
  });

  it('影响面单独成行，且只在能被数据证明时出现', () => {
    const body = functionBody(diagnosis, 'export function FailureDiagnosis(');
    expect(body).toContain('生产未受影响');
    expect(body).toContain('productionUntouched && row');
    // 结论不许拍脑袋：仍由「目标当前版本 ≠ 本次版本」推出来
    expect(diagnosis).toContain("row?.currentCommit !== run.commitSha");
    // 别又退回元信息行末尾那句灰色小字
    expect(body).not.toContain('未切换到本次版本`');
  });

  it('归并后的分组接进了 error 与噪音两个区块，且压掉多少要说出来', () => {
    const body = functionBody(diagnosis, 'export function FailureDiagnosis(');
    expect(body).toContain('diagnosis.errorGroups');
    expect(body).toContain('diagnosis.noiseGroups');
    expect(body.match(/<LogGroupList/g) || []).toHaveLength(2);
    expect(functionBody(diagnosis, 'function describeGroups(')).toContain('归并');
  });

  it('发布脚本原文只在配置页签，不回到首屏', () => {
    expect(config).toContain('发布脚本原文');
    expect(config).toContain('deployScriptLines(row)');
    // 概览页只给一句话摘要 + 去配置页的链接。
    const body = functionBody(overview, 'export function OverviewTab(');
    expect(body).toContain('去配置页看完整脚本');
    expect(body).not.toContain('deployScriptLines(');
  });
});

describe('发布中心 v2 · 变更历史的字段形状要跨层对齐', () => {
  const evidence = read('pages/release-center/EvidenceTab.tsx');
  const types = read('pages/release-center/types.ts');
  const backend = fs.readFileSync(
    path.resolve(process.cwd(), '../cds/src/services/release-target-history.ts'),
    'utf8',
  );

  it('前端类型跟着后端 ReleaseTargetChange 走，不自己发明 summary/fields', () => {
    // 后端明细在 changes[]（白名单字段的 before/after），不是一个 summary 字符串。
    expect(backend).toMatch(/changes:\s*ReleaseTargetFieldChange\[\]/);
    expect(types).toMatch(/changes:\s*ReleaseTargetFieldChange\[\]/);
    expect(types).toContain("kind: 'created' | 'updated' | 'archived'");
    // 接错形状的后果是这一栏永远只显示「配置更新」四个字，且不会有任何东西变红。
    expect(types).not.toMatch(/summary\?:\s*string/);
  });

  it('明细逐条渲染 before → after，不是只写一句「配置更新」', () => {
    expect(evidence).toContain('change.changes');
    expect(evidence).toContain('field.label');
    expect(evidence).toContain('field.before');
    expect(evidence).toContain('field.after');
  });
});

describe('发布中心 v2 · 就地发布不许再把人踢走', () => {
  it('「发布新版本」开的是本页抽屉，不是跳去分支列表', () => {
    expect(page).toContain('setReleaseIntent({ row: selectedRow })');
    expect(jsxElement(page, 'StartReleaseDialog')).toContain('intent={releaseIntent}');
    // 旧版是 <Link to={`/branch-list?project=...`}>立即发布</Link>。
    expect(page).not.toContain('/branch-list?project=');
  });

  it('抽屉自己跑发布前检查 + 开始发布，两个端点都在', () => {
    expect(startDialog).toContain('/preflight');
    expect(startDialog).toContain('/runs');
    // 有阻断项就不许发：canStart 必须看 blocking。
    expect(startDialog).toContain('blocking.length === 0');
  });
});

describe('发布中心 v2 · 预览地址推导只有一份', () => {
  it('两个入口都从 @/lib/previewUrl 取，不各留一份拷贝', () => {
    expect(startDialog).toContain("from '@/lib/previewUrl'");
    expect(branchList).toContain("from '@/lib/previewUrl'");
    // BranchListPage 里那份本地实现必须已经删掉，否则两处会漂移。
    expect(branchList).not.toContain('function multiPreviewUrl(');
    expect(branchList).not.toContain('function simplePreviewUrl(');
    expect(branchList).not.toContain('function hostWithPort(');
  });
});

describe('发布中心 v2 · 布局纪律', () => {
  it('桌面 fill 配移动端 flow 兜底（< lg 自然流 + 限高滚动）', () => {
    // 整页竖滚，桌面端也一样。
    //
    // 这里原本要求 `overflow-y-auto lg:overflow-hidden`（桌面锁死整页、只让各窗格内滚）。
    // 2026-08-13 用户反馈「红色框框部分无法向上拖动，好像被焊死了一样，上半部分偏高偏大，
    // 想低头看看人家的裤子什么颜色，怎么都看不到」——锁死整页正是那个「焊死」。
    // 顶部标题块与版本流水轴必须能被推上去，所以桌面端不再 lg:overflow-hidden。
    expect(page).toContain('flex min-h-0 flex-col gap-4 overflow-y-auto');
    const shell = page.slice(page.indexOf('flex min-h-0 flex-col gap-4 overflow-y-auto'), page.indexOf('<header'));
    expect(shell, '外层不许再 lg:overflow-hidden——那会把顶部永久钉在首屏').not.toContain('lg:overflow-hidden');
    // 主从：手机单列自然堆叠（flex-1 / min-h-0 一律收进 lg:，否则在无界高度里塌成 0），
    // lg 起才回到网格。整页可滚之后主区不能再靠 min-h-0 取高（那会塌成内容高），
    // 改为 min-h-[560px] 给个下界，短内容时也不会缩成矮条。
    expect(page).toContain('flex flex-col gap-4 lg:grid lg:min-h-[560px] lg:flex-1 lg:grid-cols-[288px_minmax(0,1fr)]');
    // 左栏手机限高 + 自身滚动，lg 解除限高改为填满整列。
    expect(sidebar).toContain('max-h-[46vh]');
    expect(sidebar).toContain('lg:h-full lg:max-h-none');
    // 产物区手机给最小高度并随页面竖滚，lg 起才 flex-1 填满 + 自身滚动。
    expect(page).toContain('min-h-[320px] p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto');
  });

  it('颜色只走 token 或双主题变体，没有暗色字面量兜底', () => {
    const sources = [page, sidebar, overview, timeline, diagnosis, health, config, startDialog];
    for (const source of sources) {
      expect(source).not.toMatch(/#0[a-f0-9]{5}\b/i);
      expect(source).not.toMatch(/var\(--[a-z-]+,\s*#/i);
    }
  });
});
