/**
 * 验收报告主页的聚合（2026-09-08，验收报告主页重做 · 方向 A「结论优先」）。
 *
 * 纯函数：输入报告元数据 + 分支墓碑（合并记录）+ 时间窗，输出主页四段所需的一切。
 * 不碰磁盘、不读正文，路由层只负责取数与鉴权。规则来源：
 *   - doc/rule.acceptance.map-enterprise.md §4.1.2 标题合同 `{前缀} · {对象} · {日期}`、
 *     §7.0 决策读者首屏（产品失败与验收失败分开）、§7.1 Verdict 语义分层
 *   - doc/guide.acceptance.report-evidence.md §4 失败首屏红标、颜色契约
 *   - .claude/rules/conclusion-before-numbers.md 第一屏是挂着数字的判断句；建议句相同的卡片合并
 *   - doc/debt.acceptance-center-cds.md「验收报告重复归档」：通过率分母必须只计每个目标的最新版
 */
import type { AcceptanceReportMeta, BranchTombstone } from '../types.js';

export type OverviewVerdict = 'pass' | 'conditional' | 'fail';

/** 标题合同的九类前缀（§4.1.2）。不在此列的标题归「其他」。 */
export const REPORT_KINDS = [
  '功能验收', '每日验收', 'PR验收', 'Commit验收', '分支验收', '缺陷复测', '视觉回归', '发布验收', '规范演练',
] as const;
export type ReportKind = (typeof REPORT_KINDS)[number] | '其他';

export interface ParsedReportTitle {
  kind: ReportKind;
  /** 重点对象（标题中段）；无法解析时为整个标题。 */
  target: string;
  /** 目标日期 YYYY-MM-DD；无法解析时为 null。 */
  targetDate: string | null;
}

export interface OverviewReportRef {
  id: string;
  title: string;
  kind: ReportKind;
  target: string;
  targetDate: string | null;
  verdict: OverviewVerdict | null;
  tier: string | null;
  defectCounts: Record<string, number> | null;
  projectId: string | null;
  branch: string | null;
  commitSha: string | null;
  prNumber: number | null;
  createdAt: string;
  shared: boolean;
  /** 同一验收目标的第几版（1 = 唯一或最早）；只在折叠后的最新版上有意义。 */
  version: number;
  /** 被本版取代的早期版本 id（按创建时间升序）。 */
  supersedes: string[];
}

export interface OverviewCluster {
  id: string;
  /** conflict：同一对象在窗口内既有未通过又有有条件的最新版结论。 */
  verdict: 'fail' | 'conditional' | 'conflict';
  target: string;
  projectId: string | null;
  kinds: ReportKind[];
  count: number;
  reportIds: string[];
  latestReportId: string;
  latestCreatedAt: string;
  defectCounts: Record<string, number>;
  /** 该对象连续多少个时间窗（含本窗）都有未通过；只对 fail/conflict 计算。 */
  streakWindows: number;
}

export interface OverviewDay {
  date: string;
  reports: Array<{ id: string; verdict: OverviewVerdict | null }>;
  /** 当天最差结论；无报告为 null。 */
  worst: OverviewVerdict | null;
}

export type MergeCoverageStatus = 'verified' | 'conditional' | 'failed' | 'unverified';

export interface OverviewMergeItem {
  branch: string;
  projectId: string;
  prNumber: number | null;
  prUrl: string | null;
  mergeCommitSha: string | null;
  mergedAt: string;
  status: MergeCoverageStatus;
  reportIds: string[];
}

export interface ReportsOverview {
  window: { from: string; to: string; days: number; previousFrom: string };
  headline: {
    /** §7.0 三个固定开头之一。 */
    status: 'broken' | 'ok' | 'untested';
    statusLabel: '有功能坏了' | '可以正常使用' | '这次没测出来';
    sentence: string;
    supports: Array<{ kind: 'new' | 'coverage' | 'decision'; text: string; anchor: 'clusters' | 'coverage' | 'ledger' }>;
  };
  releaseGate: {
    state: 'blocked' | 'open' | 'unknown';
    reason: string;
    latest: OverviewReportRef | null;
    lastPass: OverviewReportRef | null;
  };
  totals: {
    archived: number;
    folded: number;
    counted: number;
    pass: number;
    conditional: number;
    fail: number;
    undetermined: number;
    previous: { counted: number; pass: number; conditional: number; fail: number };
  };
  passRate: {
    kind: ReportKind;
    numerator: number;
    denominator: number;
    rate: number | null;
    previous: { numerator: number; denominator: number; rate: number | null };
  };
  kinds: Array<{ kind: ReportKind; count: number }>;
  clusters: OverviewCluster[];
  daily: OverviewDay[];
  mergeCoverage: {
    items: OverviewMergeItem[];
    counts: Record<MergeCoverageStatus, number>;
  };
  /** 全时段折叠后的最新版报告（台账用，带版本与取代关系），按创建时间倒序。 */
  reports: OverviewReportRef[];
  /**
   * 被取代的早期版本（折叠掉的那些），同样带服务端解析出的 kind/target/targetDate。
   *
   * 为什么必须返回：台账「展开被取代版本」时这些行也要落进九类页签。前端只有
   * `reports` 时查不到它们的 kind，会整批掉进「其他」——页签计数虚高、点真实类目
   * 又看不到它们（2026-09-09 富数据验收实测）。标题解析是服务端 SSOT，
   * 前端不得自己再实现一份（predicate-and-wiring-discipline 形状 3）。
   */
  supersededReports: OverviewReportRef[];
}

const TITLE_RE = /^(\S+?)\s*[·・]\s*(.+?)\s*[·・]\s*(\d{4}-\d{2}-\d{2})\s*$/;

export function parseReportTitle(title: string): ParsedReportTitle {
  const m = TITLE_RE.exec(title.trim());
  if (!m) return { kind: '其他', target: title.trim(), targetDate: null };
  const prefix = m[1];
  const kind: ReportKind = (REPORT_KINDS as readonly string[]).includes(prefix) ? (prefix as ReportKind) : '其他';
  return { kind, target: kind === '其他' ? title.trim() : m[2].trim(), targetDate: m[3] };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 用调用方时区偏移把 ISO 时间落到 YYYY-MM-DD。offsetMinutes 与 Date#getTimezoneOffset 同号。 */
export function localDateOf(iso: string, offsetMinutes: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 10);
  return new Date(t - offsetMinutes * 60 * 1000).toISOString().slice(0, 10);
}

function verdictRank(v: OverviewVerdict | null): number {
  return v === 'fail' ? 3 : v === 'conditional' ? 2 : v === 'pass' ? 1 : 0;
}

function sumDefects(list: Array<Record<string, number> | null | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of list) {
    if (!d) continue;
    for (const [k, v] of Object.entries(d)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const key = k.toLowerCase();
      out[key] = (out[key] ?? 0) + v;
    }
  }
  return out;
}

function blockingDefects(d: Record<string, number> | null | undefined): number {
  if (!d) return 0;
  return (d.p0 ?? d.P0 ?? 0) + (d.p1 ?? d.P1 ?? 0);
}

function identityKey(r: AcceptanceReportMeta, parsed: ParsedReportTitle): string {
  return [r.projectId || '', parsed.kind, parsed.target, parsed.targetDate || ''].join('|');
}

function toRef(r: AcceptanceReportMeta, parsed: ParsedReportTitle, version: number, supersedes: string[]): OverviewReportRef {
  return {
    id: r.id,
    title: r.title,
    kind: parsed.kind,
    target: parsed.target,
    targetDate: parsed.targetDate,
    verdict: r.verdict ?? null,
    tier: r.tier ?? null,
    defectCounts: r.defectCounts ?? null,
    projectId: r.projectId ?? null,
    branch: r.branch ?? null,
    commitSha: r.commitSha ?? null,
    prNumber: r.prNumber ?? null,
    createdAt: r.createdAt,
    shared: Boolean(r.shareToken),
    version,
    supersedes,
  };
}

/**
 * 按身份键折叠：同一（项目 · 前缀 · 对象 · 目标日）只保留创建最晚的一版。
 * 这就是债务台账里「通过率只计每个身份的最新版」的落地；早期版本记进 supersedes。
 */
export function foldReportVersions(reports: AcceptanceReportMeta[]): { latest: OverviewReportRef[]; superseded: OverviewReportRef[]; folded: number } {
  const groups = new Map<string, AcceptanceReportMeta[]>();
  for (const r of reports) {
    const key = identityKey(r, parseReportTitle(r.title));
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const latest: OverviewReportRef[] = [];
  const superseded: OverviewReportRef[] = [];
  let folded = 0;
  for (const g of groups.values()) {
    g.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = g[g.length - 1];
    const parsed = parseReportTitle(last.title);
    latest.push(toRef(last, parsed, g.length, g.slice(0, -1).map((x) => x.id)));
    g.slice(0, -1).forEach((old, i) => superseded.push(toRef(old, parseReportTitle(old.title), i + 1, [])));
    folded += g.length - 1;
  }
  latest.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  superseded.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { latest, superseded, folded };
}

function inWindow(iso: string, from: number, to: number): boolean {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= from && t < to;
}

function countVerdicts(list: OverviewReportRef[]): { counted: number; pass: number; conditional: number; fail: number; undetermined: number } {
  let pass = 0; let conditional = 0; let fail = 0; let undetermined = 0;
  for (const r of list) {
    if (r.verdict === 'pass') pass += 1;
    else if (r.verdict === 'conditional') conditional += 1;
    else if (r.verdict === 'fail') fail += 1;
    else undetermined += 1;
  }
  return { counted: list.length, pass, conditional, fail, undetermined };
}

function passRateOf(list: OverviewReportRef[], kind: ReportKind): { numerator: number; denominator: number; rate: number | null } {
  const pool = list.filter((r) => r.kind === kind && r.verdict);
  const numerator = pool.filter((r) => r.verdict === 'pass').length;
  const denominator = pool.length;
  return { numerator, denominator, rate: denominator ? numerator / denominator : null };
}

function buildClusters(windowReports: OverviewReportRef[], allLatest: OverviewReportRef[], windowDays: number, toMs: number): OverviewCluster[] {
  const groups = new Map<string, OverviewReportRef[]>();
  for (const r of windowReports) {
    if (r.verdict !== 'fail' && r.verdict !== 'conditional') continue;
    const key = `${r.projectId || ''}|${r.target}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const clusters: OverviewCluster[] = [];
  for (const [key, g] of groups) {
    g.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const fails = g.filter((r) => r.verdict === 'fail');
    const conds = g.filter((r) => r.verdict === 'conditional');
    // 同一对象、同一目标日既有未通过又有有条件 → 口径冲突（记录自己打架，不是产品坏了）。
    const conflict = fails.length > 0 && conds.length > 0
      && fails.some((f) => conds.some((c) => c.targetDate && c.targetDate === f.targetDate));
    const verdict: OverviewCluster['verdict'] = conflict ? 'conflict' : fails.length > 0 ? 'fail' : 'conditional';
    const target = g[0].target;
    const projectId = g[0].projectId;
    // 连续多少个窗口有未通过：往前逐窗看同对象的最新版里有没有 fail。
    let streak = 0;
    if (verdict !== 'conditional') {
      const windowMs = windowDays * DAY_MS;
      for (let i = 0; i < 12; i += 1) {
        const from = toMs - (i + 1) * windowMs;
        const to = toMs - i * windowMs;
        const hit = allLatest.some((r) => r.verdict === 'fail' && r.target === target && (r.projectId || null) === projectId && inWindow(r.createdAt, from, to));
        if (!hit) break;
        streak += 1;
      }
    }
    clusters.push({
      id: key,
      verdict,
      target,
      projectId,
      kinds: Array.from(new Set(g.map((r) => r.kind))),
      count: g.length,
      reportIds: g.map((r) => r.id),
      latestReportId: g[0].id,
      latestCreatedAt: g[0].createdAt,
      defectCounts: sumDefects(g.map((r) => r.defectCounts)),
      streakWindows: streak,
    });
  }
  const order = { fail: 0, conflict: 1, conditional: 2 } as const;
  clusters.sort((a, b) => order[a.verdict] - order[b.verdict] || b.count - a.count || b.latestCreatedAt.localeCompare(a.latestCreatedAt));
  return clusters;
}

function buildDaily(latest: OverviewReportRef[], toMs: number, days: number, tzOffsetMinutes: number): OverviewDay[] {
  const byDate = new Map<string, OverviewReportRef[]>();
  for (const r of latest) {
    if (r.kind !== '每日验收') continue;
    const d = localDateOf(r.createdAt, tzOffsetMinutes);
    const g = byDate.get(d);
    if (g) g.push(r);
    else byDate.set(d, [r]);
  }
  const out: OverviewDay[] = [];
  const endDate = localDateOf(new Date(toMs - 1).toISOString(), tzOffsetMinutes);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(endMs - i * DAY_MS).toISOString().slice(0, 10);
    const reports = (byDate.get(date) ?? []).map((r) => ({ id: r.id, verdict: r.verdict }));
    let worst: OverviewVerdict | null = null;
    for (const r of reports) if (verdictRank(r.verdict) > verdictRank(worst)) worst = r.verdict;
    out.push({ date, reports, worst });
  }
  return out;
}

function buildMergeCoverage(tombstones: BranchTombstone[], latest: OverviewReportRef[], fromMs: number, toMs: number, projectId: string | null): ReportsOverview['mergeCoverage'] {
  const items: OverviewMergeItem[] = [];
  for (const t of tombstones) {
    if (t.reason !== 'merged') continue;
    if (projectId && t.projectId !== projectId) continue;
    if (!inWindow(t.removedAt, fromMs, toMs)) continue;
    const matched = latest.filter((r) => {
      if ((r.projectId || null) !== t.projectId) return false;
      if (t.prNumber != null && r.prNumber === t.prNumber) return true;
      if (t.mergeCommitSha && r.commitSha && (t.mergeCommitSha.startsWith(r.commitSha) || r.commitSha.startsWith(t.mergeCommitSha))) return true;
      return Boolean(r.branch && r.branch === t.branch);
    });
    let status: MergeCoverageStatus = 'unverified';
    if (matched.length) {
      matched.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const v = matched[0].verdict;
      status = v === 'pass' ? 'verified' : v === 'fail' ? 'failed' : v === 'conditional' ? 'conditional' : 'unverified';
    }
    items.push({
      branch: t.branch,
      projectId: t.projectId,
      prNumber: t.prNumber ?? null,
      prUrl: t.prUrl ?? null,
      mergeCommitSha: t.mergeCommitSha ?? null,
      mergedAt: t.removedAt,
      status,
      reportIds: matched.map((r) => r.id),
    });
  }
  items.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  const counts: Record<MergeCoverageStatus, number> = { verified: 0, conditional: 0, failed: 0, unverified: 0 };
  for (const it of items) counts[it.status] += 1;
  return { items, counts };
}

function fmtDate(iso: string): string {
  return iso.slice(5, 10);
}

export interface BuildOverviewOptions {
  /** 窗口结束（不含）；默认现在。 */
  to?: Date;
  /** 窗口天数；默认 7。 */
  days?: number;
  /** 调用方时区偏移（Date#getTimezoneOffset 同号）；默认 0。 */
  tzOffsetMinutes?: number;
  /** 通过率统计的报告类型；默认功能验收。 */
  passRateKind?: ReportKind;
  /** 每日验收连续性看多少天；默认 14。 */
  dailyDays?: number;
  /** 项目作用域（合并记录按此过滤）；null = 全部。 */
  projectId?: string | null;
}

export function buildReportsOverview(
  reports: AcceptanceReportMeta[],
  tombstones: BranchTombstone[],
  options: BuildOverviewOptions = {},
): ReportsOverview {
  const days = Math.max(1, Math.min(90, options.days ?? 7));
  const toMs = (options.to ?? new Date()).getTime();
  const fromMs = toMs - days * DAY_MS;
  const prevFromMs = fromMs - days * DAY_MS;
  const tz = options.tzOffsetMinutes ?? 0;
  const passRateKind = options.passRateKind ?? '功能验收';

  const { latest: allLatest, superseded: allSuperseded, folded: foldedAll } = foldReportVersions(reports);
  const windowReports = allLatest.filter((r) => inWindow(r.createdAt, fromMs, toMs));
  const prevReports = allLatest.filter((r) => inWindow(r.createdAt, prevFromMs, fromMs));
  const archivedInWindow = reports.filter((r) => inWindow(r.createdAt, fromMs, toMs)).length;
  const foldedInWindow = archivedInWindow - windowReports.length;
  void foldedAll;

  const counts = countVerdicts(windowReports);
  const prevCounts = countVerdicts(prevReports);
  const passRate = passRateOf(windowReports, passRateKind);
  const prevPassRate = passRateOf(prevReports, passRateKind);

  const kindCounts = new Map<ReportKind, number>();
  for (const r of windowReports) kindCounts.set(r.kind, (kindCounts.get(r.kind) ?? 0) + 1);
  const kinds = Array.from(kindCounts, ([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);

  const clusters = buildClusters(windowReports, allLatest, days, toMs);
  const daily = buildDaily(allLatest, toMs, Math.max(1, Math.min(90, options.dailyDays ?? 14)), tz);
  const mergeCoverage = buildMergeCoverage(tombstones, allLatest, fromMs, toMs, options.projectId ?? null);

  // 发布闸：只看最近一次「发布验收」的最新版结论。
  const releaseReports = allLatest.filter((r) => r.kind === '发布验收' && r.verdict);
  const latestRelease = releaseReports[0] ?? null;
  const lastPassRelease = releaseReports.find((r) => r.verdict === 'pass') ?? null;
  let gateState: ReportsOverview['releaseGate']['state'] = 'unknown';
  let gateReason = '还没有任何发布验收报告，发布前先跑一次「发布验收」。';
  if (latestRelease) {
    if (latestRelease.verdict === 'pass') {
      gateState = 'open';
      gateReason = `最近一次发布验收 ${fmtDate(latestRelease.createdAt)} 通过。`;
    } else {
      gateState = 'blocked';
      const b = blockingDefects(latestRelease.defectCounts);
      gateReason = `最近一次发布验收 ${fmtDate(latestRelease.createdAt)} ${latestRelease.verdict === 'fail' ? '未通过' : '有条件通过'}`
        + (b ? `，阻断缺陷 ${b} 个` : '')
        + (lastPassRelease ? `；上一次通过是 ${fmtDate(lastPassRelease.createdAt)}。` : '；此前没有通过记录。');
    }
  }

  // 首屏状态（§7.0）：产品失败与验收失败分开。
  const failsWithBlocking = windowReports.filter((r) => r.verdict === 'fail' && (r.defectCounts == null || blockingDefects(r.defectCounts) > 0));
  const failsWithoutDefects = windowReports.filter((r) => r.verdict === 'fail' && r.defectCounts != null && blockingDefects(r.defectCounts) === 0);
  let status: ReportsOverview['headline']['status'];
  if (failsWithBlocking.length > 0) status = 'broken';
  else if (windowReports.length === 0 || failsWithoutDefects.length > 0) status = 'untested';
  else status = 'ok';
  const statusLabel = status === 'broken' ? '有功能坏了' : status === 'ok' ? '可以正常使用' : '这次没测出来';

  const top = clusters.find((c) => c.verdict === 'fail' || c.verdict === 'conflict');
  let sentence: string;
  if (windowReports.length === 0) {
    sentence = `最近 ${days} 天没有归档任何验收报告，无法判断产品状态。`;
  } else if (counts.fail > 0 && top) {
    const same = top.count > 1 ? `里有 ${top.count} 份指向同一处：${top.target}` : `：${top.target}`;
    const streak = top.streakWindows > 1 ? `，连续第 ${top.streakWindows} 个时间窗未通过` : '';
    sentence = `${counts.fail} 份未通过${same}${streak}。`;
  } else if (counts.fail > 0) {
    sentence = `${counts.fail} 份未通过，分散在不同对象上。`;
  } else if (counts.conditional > 0) {
    sentence = `${counts.counted} 份验收没有发现阻断；${counts.conditional} 份有条件通过，条件都在待决清单里。`;
  } else {
    sentence = `${counts.counted} 份验收全部通过，没有发现阻断。`;
  }

  const supports: ReportsOverview['headline']['supports'] = [];
  const newFail = clusters.find((c) => c.verdict === 'fail' && c.streakWindows <= 1 && c !== top);
  if (newFail) {
    supports.push({ kind: 'new', anchor: 'clusters', text: `${newFail.target} 本窗新出现 ${newFail.count} 份未通过，之后没有复测。` });
  }
  const gapDays = daily.filter((d) => d.reports.length === 0).length;
  const unverified = mergeCoverage.counts.unverified;
  const coverageBits: string[] = [];
  if (unverified > 0) coverageBits.push(`合并的 ${mergeCoverage.items.length} 条分支里 ${unverified} 条零验收`);
  if (gapDays > 0) coverageBits.push(`${daily.length} 天里 ${gapDays} 天没有每日验收`);
  if (coverageBits.length) supports.push({ kind: 'coverage', anchor: 'coverage', text: `${coverageBits.join('；')}。这是证据空白，不是产品缺陷。` });
  if (gateState === 'blocked') {
    supports.push({ kind: 'decision', anchor: 'ledger', text: `发布闸是红的：${gateReason}` });
  } else if (top && top.streakWindows > 1) {
    supports.push({ kind: 'decision', anchor: 'clusters', text: `${top.target} 已连续 ${top.streakWindows} 个时间窗未通过，需要指定负责人拆成单点逐点验。` });
  }

  return {
    window: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      days,
      previousFrom: new Date(prevFromMs).toISOString(),
    },
    headline: { status, statusLabel, sentence, supports },
    releaseGate: { state: gateState, reason: gateReason, latest: latestRelease, lastPass: lastPassRelease },
    totals: {
      archived: archivedInWindow,
      folded: foldedInWindow,
      counted: counts.counted,
      pass: counts.pass,
      conditional: counts.conditional,
      fail: counts.fail,
      undetermined: counts.undetermined,
      previous: { counted: prevCounts.counted, pass: prevCounts.pass, conditional: prevCounts.conditional, fail: prevCounts.fail },
    },
    passRate: { kind: passRateKind, ...passRate, previous: prevPassRate },
    kinds,
    clusters,
    daily,
    mergeCoverage,
    reports: allLatest,
    supersededReports: allSuperseded,
  };
}
