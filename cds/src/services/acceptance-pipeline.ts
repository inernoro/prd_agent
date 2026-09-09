/**
 * 验收流水线总览（2026-09-09，验收报告首页第二次重做）。
 *
 * 需求来源：首页服务的是老板 / 观察者 / 架构师，他们要「纵观全局和流水线」——
 * 不动手处理单条待办，所以首页不该是待办队列，也不该是某一份报告结论的放大。
 *
 * 「流水线」在 CDS 里有确定形状：改动（分支）→ 部署预览 → 跑验收 → 出结论 → 合并主干。
 * 对这三类读者真正有信息量的不是每一环的数，而是**环与环之间的落差**，也就是漏在哪：
 *
 *   - 部署了没人验          → 验收没跟上开发
 *   - 合并了从来没验过      → 最危险的一种漏
 *   - 验了没过还是合并了    → 门形同虚设
 *   - 报告没记它验的是谁    → 证据永远挂不上，归档流程的缺口
 *
 * 曾经还有第五种「报告对不上任何分支」，已删除：拿主实例真实数据核过，
 * 153 份对不上的报告里 152 份点名的分支根本已经不在 CDS 上（现存只有 71 条分支）。
 * CDS 不保留几个月前的分支，对不上是常态而非异常——把它当漏点名，等于首页
 * 喊一次狼，以后真的漏出现时没人再信。它现在只作背景数 staleReports。
 *
 * 「全局」的粒度是项目：一行一个项目，跨项目汇总在最上面。
 *
 * 时间不再是主轴（老板看的是「现在什么状态」，不是「最近 7 天归档了几份」；
 * 而且按窗切会切断流转——上周提的 PR 这周才验，两头都不算数）。
 * 所以口径是「当前在途 + 最近完成」，天数只当筛选。
 *
 * 纯函数：不碰磁盘、不读正文。判定口径与 acceptance-overview 共用同一个 matchesChange。
 */
import type { AcceptanceReportMeta, BranchEntry, BranchTombstone, Project } from '../types.js';
import {
  REPORT_KINDS, foldReportVersions, matchesChange, parseReportTitle,
  type OverviewReportRef, type OverviewVerdict, type ReportKind,
} from './acceptance-overview.js';

/** 一个改动单元在流水线上走到了哪一环。 */
export type ChangeStage = 'created' | 'deployed' | 'accepted' | 'merged';

export interface PipelineChange {
  /** 分支名（改动单元的身份）。 */
  branch: string;
  projectId: string;
  /** 活跃分支的 CDS id；已合并/已删的分支没有。 */
  branchId: string | null;
  prNumber: number | null;
  commitSha: string | null;
  /** 是否还在途（活跃分支）；false = 已从 CDS 上撤下（合并或放弃）。 */
  inFlight: boolean;
  deployed: boolean;
  merged: boolean;
  mergedAt: string | null;
  /** 匹配到的报告（折叠后的最新版），按创建时间倒序。 */
  reportIds: string[];
  /** 最新一份匹配报告的结论；无报告为 null。 */
  verdict: OverviewVerdict | null;
  stage: ChangeStage;
}

export type LeakKind =
  | 'deployed-not-accepted'
  | 'merged-not-accepted'
  | 'merged-while-failing'
  /** 报告根本没记 branch / commit / PR，注定挂不上任何改动——归档流程的真缺口。 */
  | 'report-missing-change-key';

export interface PipelineLeak {
  kind: LeakKind;
  /** 命中的改动单元分支名；report-missing-change-key 时是报告标题。 */
  subject: string;
  projectId: string;
  reportIds: string[];
}

export interface PipelineFunnel {
  /** 改动单元总数（在途 + 最近完成）。 */
  changes: number;
  deployed: number;
  accepted: number;
  merged: number;
  /** 结论分档：不给百分比（分母失真且规范未定义），只给三档计数。 */
  pass: number;
  conditional: number;
  fail: number;
  /** 有报告但结论字段为空。 */
  undetermined: number;
}

export interface PipelineProjectRow {
  projectId: string;
  projectName: string;
  funnel: PipelineFunnel;
  leaks: Record<LeakKind, number>;
  /** 一次都没跑过的验收类型（九类前缀里缺哪些）。 */
  missingKinds: ReportKind[];
  /**
   * 记了标识、却挂不到任何现存改动的报告数——它验的分支已被 CDS 回收。
   *
   * 这**不是漏**，是常态：主实例上 153 份这样的报告里，152 份点名的分支根本
   * 不在现存的 71 条分支里。首页把它当漏点名 = 喊一次狼，以后没人再信。
   */
  staleReports: number;
  /** 在途改动数（还挂在 CDS 上的分支）。 */
  inFlight: number;
  /** 最近一次有动静的时间（部署 / 归档 / 合并里最晚的一个）。 */
  lastActivityAt: string | null;
  /** 该项目是否接了 GitHub——没接就永远没有合并记录，不能算成「漏」。 */
  githubLinked: boolean;
}

export interface PipelineOverview {
  generatedAt: string;
  /** 「最近完成」回看多少天；null = 不限。 */
  recentDays: number | null;
  total: PipelineFunnel;
  totalLeaks: Record<LeakKind, number>;
  projects: PipelineProjectRow[];
  /** 对应改动已回收、无法核对的报告总数；是背景说明，不是漏。 */
  staleReports: number;
  /** 全局漏点明细，按严重度排序，供第一屏点名。 */
  leaks: PipelineLeak[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function emptyFunnel(): PipelineFunnel {
  return { changes: 0, deployed: 0, accepted: 0, merged: 0, pass: 0, conditional: 0, fail: 0, undetermined: 0 };
}

function emptyLeaks(): Record<LeakKind, number> {
  return {
    'deployed-not-accepted': 0, 'merged-not-accepted': 0, 'merged-while-failing': 0,
    'report-missing-change-key': 0,
  };
}

/** 报告有没有记下它验的是哪个改动。三样全空就是没记。 */
function hasChangeKey(r: OverviewReportRef): boolean {
  return Boolean(r.branch || r.commitSha || r.prNumber != null);
}

/** 分支是否真的部署过：有服务实例，或有过一次部署完成时间。 */
function branchDeployed(b: BranchEntry): boolean {
  return Object.keys(b.services || {}).length > 0 || Boolean(b.lastDeployAt);
}

function latest(list: OverviewReportRef[]): OverviewReportRef | null {
  return list.length ? list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : null;
}

export interface BuildPipelineOptions {
  /** 「最近完成」回看天数；不给则不限。 */
  recentDays?: number | null;
  now?: Date;
}

export function buildPipelineOverview(
  projects: Project[],
  branches: BranchEntry[],
  tombstones: BranchTombstone[],
  reports: AcceptanceReportMeta[],
  options: BuildPipelineOptions = {},
): PipelineOverview {
  const nowMs = (options.now ?? new Date()).getTime();
  const recentDays = options.recentDays ?? null;
  const mergedFloorMs = recentDays != null ? nowMs - recentDays * DAY_MS : null;

  // 报告先折叠：同一验收目标只计最新一版，否则重复归档会把「验过」这一环撑大。
  const { latest: refs } = foldReportVersions(reports);

  const rows: PipelineProjectRow[] = [];
  const allLeaks: PipelineLeak[] = [];
  const total = emptyFunnel();
  const totalLeaks = emptyLeaks();
  const claimedReportIds = new Set<string>();

  for (const project of projects) {
    const pid = project.id;
    const projectRefs = refs.filter((r) => (r.projectId || null) === pid);
    const projectBranches = branches.filter((b) => b.projectId === pid);
    const projectTombs = tombstones.filter(
      (t) => t.projectId === pid
        && (mergedFloorMs == null || (Date.parse(t.removedAt || '') || 0) >= mergedFloorMs),
    );

    // 改动单元 = 在途分支 ∪ 最近撤下的分支（墓碑）。同名以在途那条为准。
    const changes = new Map<string, PipelineChange>();
    for (const b of projectBranches) {
      changes.set(b.branch, {
        branch: b.branch,
        projectId: pid,
        branchId: b.id,
        prNumber: b.githubPrNumber ?? null,
        commitSha: b.githubCommitSha ?? null,
        inFlight: true,
        deployed: branchDeployed(b),
        merged: false,
        mergedAt: null,
        reportIds: [],
        verdict: null,
        stage: 'created',
      });
    }
    for (const t of projectTombs) {
      const merged = t.reason === 'merged';
      const existing = changes.get(t.branch);
      if (existing) {
        existing.merged = existing.merged || merged;
        existing.mergedAt = merged ? (t.removedAt || null) : existing.mergedAt;
        if (existing.prNumber == null) existing.prNumber = t.prNumber ?? null;
        if (!existing.commitSha) existing.commitSha = t.mergeCommitSha ?? null;
        continue;
      }
      changes.set(t.branch, {
        branch: t.branch,
        projectId: pid,
        branchId: t.branchId ?? null,
        prNumber: t.prNumber ?? null,
        commitSha: t.mergeCommitSha ?? null,
        inFlight: false,
        // 墓碑意味着它曾经有过预览子域，即部署过。
        deployed: true,
        merged,
        mergedAt: merged ? (t.removedAt || null) : null,
        reportIds: [],
        verdict: null,
        stage: 'created',
      });
    }

    const funnel = emptyFunnel();
    const leaks = emptyLeaks();
    let lastActivityAt: string | null = null;
    const touch = (iso: string | null | undefined): void => {
      if (!iso) return;
      if (!lastActivityAt || iso > lastActivityAt) lastActivityAt = iso;
    };
    for (const b of projectBranches) touch(b.lastDeployAt || b.createdAt);

    for (const c of changes.values()) {
      const matched = projectRefs.filter((r) => matchesChange(r, c));
      for (const r of matched) claimedReportIds.add(r.id);
      c.reportIds = matched.map((r) => r.id);
      const head = latest(matched);
      c.verdict = head?.verdict ?? null;
      c.stage = c.merged ? 'merged' : matched.length ? 'accepted' : c.deployed ? 'deployed' : 'created';
      touch(c.mergedAt);
      touch(head?.createdAt);

      funnel.changes += 1;
      if (c.deployed) funnel.deployed += 1;
      if (matched.length) funnel.accepted += 1;
      if (c.merged) funnel.merged += 1;
      if (matched.length) {
        if (c.verdict === 'pass') funnel.pass += 1;
        else if (c.verdict === 'conditional') funnel.conditional += 1;
        else if (c.verdict === 'fail') funnel.fail += 1;
        else funnel.undetermined += 1;
      }

      // 落差判定。注意：没接 GitHub 的项目永远没有墓碑，
      // 「合并了没验」不成立，不能把「查不到」算成「漏」。
      if (c.deployed && !matched.length && !c.merged) {
        leaks['deployed-not-accepted'] += 1;
        allLeaks.push({ kind: 'deployed-not-accepted', subject: c.branch, projectId: pid, reportIds: [] });
      }
      if (c.merged && !matched.length) {
        leaks['merged-not-accepted'] += 1;
        allLeaks.push({ kind: 'merged-not-accepted', subject: c.branch, projectId: pid, reportIds: [] });
      }
      if (c.merged && c.verdict === 'fail') {
        leaks['merged-while-failing'] += 1;
        allLeaks.push({ kind: 'merged-while-failing', subject: c.branch, projectId: pid, reportIds: c.reportIds });
      }
    }

    // 挂不上任何已知改动单元的报告分两种，只有第一种算漏：
    //   1. 三个标识全空   → 归档流程真缺口，这份报告永远挂不上任何改动
    //   2. 记了标识但对不上 → 它验的分支已被 CDS 回收，无从核对，只作背景数
    let staleReports = 0;
    for (const r of projectRefs) {
      if (claimedReportIds.has(r.id)) continue;
      if (!hasChangeKey(r)) {
        leaks['report-missing-change-key'] += 1;
        allLeaks.push({ kind: 'report-missing-change-key', subject: r.title, projectId: pid, reportIds: [r.id] });
        touch(r.createdAt);
        continue;
      }
      staleReports += 1;
    }

    const seenKinds = new Set(projectRefs.map((r) => parseReportTitle(r.title).kind));
    const missingKinds = REPORT_KINDS.filter((k) => !seenKinds.has(k));

    for (const key of Object.keys(funnel) as Array<keyof PipelineFunnel>) total[key] += funnel[key];
    for (const key of Object.keys(leaks) as LeakKind[]) totalLeaks[key] += leaks[key];

    rows.push({
      projectId: pid,
      projectName: project.name || project.slug || pid,
      funnel,
      leaks,
      missingKinds: [...missingKinds],
      staleReports,
      inFlight: [...changes.values()].filter((c) => c.inFlight).length,
      lastActivityAt,
      githubLinked: Boolean(project.githubRepoFullName),
    });
  }

  // 漏点按严重度排：合并了没验 > 验了没过还合并 > 部署了没验 > 报告没记标识。
  const severity: Record<LeakKind, number> = {
    'merged-not-accepted': 0, 'merged-while-failing': 1, 'deployed-not-accepted': 2,
    'report-missing-change-key': 3,
  };
  allLeaks.sort((a, b) => severity[a.kind] - severity[b.kind] || a.subject.localeCompare(b.subject));

  rows.sort((a, b) => {
    const la = Object.values(a.leaks).reduce((n, v) => n + v, 0);
    const lb = Object.values(b.leaks).reduce((n, v) => n + v, 0);
    return lb - la || b.funnel.fail - a.funnel.fail || b.funnel.changes - a.funnel.changes;
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    recentDays,
    total,
    totalLeaks,
    projects: rows,
    staleReports: rows.reduce((n, r) => n + r.staleReports, 0),
    leaks: allLeaks,
  };
}
