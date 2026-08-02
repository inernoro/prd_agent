/**
 * 验收缺陷归因简报（Acceptance Defect Digest）—— 纯计算层。
 *
 * 解决的问题：验收报告一篇一篇归档进 CDS 之后，没有任何地方回答「最近这些验收里，
 * 哪一类缺陷在反复出现、集中在哪个模块、根因结论是什么」。人只能一篇篇点开看，
 * 于是同一类问题连着栽几次也没人发现。
 *
 * 为什么是统计而不是 AI：CDS 进程内**没有**通用大模型通道（全仓无任何模型 HTTP 客户端，
 * 唯一出站路径是 routes/remote-hosts.ts 的 sidecar agent-session，硬门禁在
 * project.kind==='shared-service' + 已部署 claude-sdk sidecar + 有效 Anthropic key，
 * 且形态是会话式 agent 不是批处理补全）。在 CDS 里现造一个模型客户端会同时违反
 * .claude/rules/llm-gateway.md（所有 LLM 调用走 ILlmGateway）与 no-rootless-tree.md。
 * 所以这一层只做**可追溯的确定性统计**：每个数字都能落到具体报告 id。
 * AI 归因该落在 MAP 侧（那边有 ILlmGateway），它消费的正是这里产出的结构化证据。
 *
 * 判据纪律（.claude/rules/predicate-and-wiring-discipline.md）：
 *   - 形状 1（判据太窄）：严重度键在生产端是自由写法 —— cdscli 写小写 `p0`，报告正文
 *     写大写 `P0`，还可能带 markdown 星号或全角空格。归一化必须吃下这些同语义写法，
 *     只认一种写法的判据会静默永不命中。归一化函数是本文件的唯一 SSOT，
 *     路由层与统计层都必须走它，不许各写一份。
 *   - 形状 6（读到的不是生效的值）：一篇报告同时有 defectRows（逐行证据）与
 *     defectCounts（聚合数字）时，两者**不相加**，以 defectRows 为准；否则同一个缺陷
 *     会被数两遍，而两个来源都真实存在、日志里看不出异常。
 */

/** 规范化后的严重度枚举。P0 最重。 */
export type DefectSeverity = 'P0' | 'P1' | 'P2' | 'P3';

export const DEFECT_SEVERITIES: readonly DefectSeverity[] = ['P0', 'P1', 'P2', 'P3'] as const;

/** 一行缺陷证据（来自验收报告正文的「缺陷清单」表）。 */
export interface AcceptanceDefectRow {
  /** 严重度原文（如 `P1` / `p1` / `**P1**`）；归一化交给 normalizeSeverity。 */
  severity?: string | null;
  /** 缺陷编号（如 `D-01`）；可空。 */
  id?: string | null;
  /** 现象/问题描述；可空。 */
  symptom?: string | null;
  /** 页面/路径/模块/位置；聚类维度，可空。 */
  module?: string | null;
}

/** 一行根因证据（来自验收报告正文的「根因链条」表）。 */
export interface AcceptanceRootCauseRow {
  /** 系统原因；可空。 */
  cause?: string | null;
  /** 结论（如 `覆盖缺口` / `产品失败` / `非阻断风险`）；分布统计维度。 */
  conclusion?: string | null;
  /** 关闭动作；可空。 */
  action?: string | null;
}

/**
 * 简报的输入：AcceptanceReportMeta 的结构化子集。
 * 用结构类型而不是直接依赖 types.ts 的完整接口，是为了让单测能只喂需要的字段。
 */
export interface DigestReportInput {
  id: string;
  title: string;
  createdAt: string;
  projectId?: string | null;
  verdict?: 'pass' | 'conditional' | 'fail' | null;
  defectCounts?: Record<string, number> | null;
  defectRows?: AcceptanceDefectRow[] | null;
  rootCauseRows?: AcceptanceRootCauseRow[] | null;
}

/** 一篇报告在某个聚类里的取样（给人看「凭什么算进来」）。 */
export interface DefectClusterSample {
  reportId: string;
  reportTitle: string;
  severity: DefectSeverity;
  symptom: string;
}

/** 按模块聚成的一簇缺陷。 */
export interface DefectCluster {
  /** 归一化后的聚类键（比较用，不展示）。 */
  key: string;
  /** 展示名（该簇第一次出现时的原文写法）。 */
  label: string;
  /** 该簇缺陷行总数。 */
  defectCount: number;
  /** 该簇按严重度拆分。 */
  severityTotals: Record<DefectSeverity, number>;
  /** 该簇里最重的严重度。 */
  worstSeverity: DefectSeverity;
  /** 命中该簇的报告 id（去重，按首次出现顺序）—— 每个数字的追溯锚点。 */
  reportIds: string[];
  /** 最多 3 条样例，供人一眼看清这簇到底是什么问题。 */
  samples: DefectClusterSample[];
}

/** 根因结论的分布。 */
export interface RootCauseTally {
  conclusion: string;
  count: number;
  reportIds: string[];
}

/** verdict 分布（未判定归入 unknown）。 */
export interface VerdictTotals {
  pass: number;
  conditional: number;
  fail: number;
  unknown: number;
}

export interface DefectDigest {
  /** 生成时刻（ISO）。 */
  generatedAt: string;
  /** 统计窗口起点（ISO），未限制窗口时为 null。 */
  since: string | null;
  /** 窗口内报告总数。 */
  reportCount: number;
  /** 其中带逐行缺陷证据（defectRows）的报告数 —— 证据面覆盖率，越低简报越粗。 */
  reportsWithDefectRows: number;
  /** 其中只有聚合 defectCounts、没有逐行证据的报告数。 */
  reportsWithCountsOnly: number;
  /** 严重度总计。 */
  severityTotals: Record<DefectSeverity, number>;
  /** defectCounts 里键名无法归一化到 P0-P3 的计数（如 `blocker`），不进 severityTotals。 */
  unclassifiedDefectCount: number;
  verdictTotals: VerdictTotals;
  /** 按模块聚类，缺陷数降序。 */
  clusters: DefectCluster[];
  /** 根因结论分布，次数降序。 */
  rootCauses: RootCauseTally[];
}

/** 未标注模块的缺陷统一落到这一簇，避免它们凭空消失。 */
export const UNLABELLED_MODULE = '未标注模块';

/** 去掉 markdown 强调符与首尾空白（含全角空格），把单元格压成纯文本。 */
function plain(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[`*_]/g, '')
    .replace(/[　\s]+/g, ' ')
    .trim();
}

/**
 * 严重度归一化 SSOT。
 *
 * 吃下同语义的不同写法：`P0` / `p0` / `**P1**` / ` p 2 ` / 全角空格包裹，
 * 以及夹在长文本里的 `P3 视觉瑕疵`。认不出返回 null（调用方决定算不算数）。
 */
export function normalizeSeverity(raw: unknown): DefectSeverity | null {
  const text = plain(raw);
  if (!text) return null;
  const exact = /^p\s*([0-3])$/i.exec(text);
  if (exact) return `P${exact[1]}` as DefectSeverity;
  const loose = /(?:^|[^a-z0-9])p\s*([0-3])(?![0-9])/i.exec(text);
  return loose ? (`P${loose[1]}` as DefectSeverity) : null;
}

function emptySeverityTotals(): Record<DefectSeverity, number> {
  return { P0: 0, P1: 0, P2: 0, P3: 0 };
}

/** 聚合 defectCounts 的归一化结果。 */
export interface NormalizedDefectCounts {
  counts: Record<DefectSeverity, number>;
  /** 键名归一化不出 P0-P3 的那部分总数（保留而不是丢弃，免得静默吞掉证据）。 */
  unclassified: number;
  /** 是否至少有一个有效数字。 */
  hasAny: boolean;
}

/**
 * 把自由写法的 defectCounts（`{p0:1, P1:2, blocker:1}`）归一化成 P0-P3 桶。
 * 同一个桶的多种写法相加（`{p0:1, P0:2}` → `P0: 3`），负数与非有限数丢弃。
 */
export function normalizeDefectCounts(raw: unknown): NormalizedDefectCounts {
  const counts = emptySeverityTotals();
  let unclassified = 0;
  let hasAny = false;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n) || n <= 0) continue;
      hasAny = true;
      const sev = normalizeSeverity(key);
      if (sev) counts[sev] += n;
      else unclassified += n;
    }
  }
  return { counts, unclassified, hasAny };
}

/** 模块聚类键：大小写、空白、常见分隔符差异不应分裂成两簇。 */
export function normalizeModuleKey(raw: unknown): string {
  const text = plain(raw)
    .replace(/[／]/g, '/')
    .replace(/[·・]/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/^[-–—/,.;:、，。；：]+|[-–—/,.;:、，。；：]+$/g, '')
    .trim();
  return text ? text.toLowerCase() : '';
}

function worstOf(totals: Record<DefectSeverity, number>): DefectSeverity {
  for (const sev of DEFECT_SEVERITIES) {
    if (totals[sev] > 0) return sev;
  }
  return 'P3';
}

const SEVERITY_RANK: Record<DefectSeverity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export interface BuildDigestOptions {
  /** 只统计 createdAt >= since 的报告；不传则不限窗口。 */
  since?: string | null;
  /** 生成时刻，测试可注入以稳定快照。 */
  now?: Date;
  /** 聚类数量上限（默认 12）。 */
  maxClusters?: number;
}

/**
 * 由报告元数据算出缺陷归因简报。
 *
 * 计数口径（写死在这里，别在别处再判一次）：
 *   - 一篇报告有 defectRows → 严重度只数 defectRows，defectCounts 被忽略（防重复计数）。
 *   - 没有 defectRows 但有 defectCounts → 用 defectCounts，且这些缺陷**不参与模块聚类**
 *     （聚合数字里没有模块信息，硬塞进「未标注模块」会让那一簇虚高到没法看）。
 *   - 两者都没有 → 只计入 reportCount 与 verdict 分布。
 */
export function buildDefectDigest(
  reports: readonly DigestReportInput[],
  options: BuildDigestOptions = {},
): DefectDigest {
  const since = options.since ?? null;
  const maxClusters = options.maxClusters ?? 12;
  const inWindow = since ? reports.filter((r) => (r.createdAt || '') >= since) : [...reports];

  const severityTotals = emptySeverityTotals();
  const verdictTotals: VerdictTotals = { pass: 0, conditional: 0, fail: 0, unknown: 0 };
  let unclassifiedDefectCount = 0;
  let reportsWithDefectRows = 0;
  let reportsWithCountsOnly = 0;

  const clusterMap = new Map<string, DefectCluster>();
  const rootCauseMap = new Map<string, RootCauseTally>();

  for (const report of inWindow) {
    const verdict = report.verdict;
    if (verdict === 'pass' || verdict === 'conditional' || verdict === 'fail') verdictTotals[verdict] += 1;
    else verdictTotals.unknown += 1;

    const rows = Array.isArray(report.defectRows) ? report.defectRows : [];
    const usableRows = rows.filter((row) => normalizeSeverity(row?.severity) !== null);

    if (usableRows.length > 0) {
      reportsWithDefectRows += 1;
      for (const row of usableRows) {
        const severity = normalizeSeverity(row.severity) as DefectSeverity;
        severityTotals[severity] += 1;

        const rawLabel = plain(row.module) || UNLABELLED_MODULE;
        const key = normalizeModuleKey(row.module) || UNLABELLED_MODULE;
        let cluster = clusterMap.get(key);
        if (!cluster) {
          cluster = {
            key,
            label: rawLabel,
            defectCount: 0,
            severityTotals: emptySeverityTotals(),
            worstSeverity: 'P3',
            reportIds: [],
            samples: [],
          };
          clusterMap.set(key, cluster);
        }
        cluster.defectCount += 1;
        cluster.severityTotals[severity] += 1;
        if (!cluster.reportIds.includes(report.id)) cluster.reportIds.push(report.id);
        if (cluster.samples.length < 3) {
          cluster.samples.push({
            reportId: report.id,
            reportTitle: report.title,
            severity,
            symptom: plain(row.symptom) || plain(row.id) || '（报告未填写现象）',
          });
        }
      }
    } else {
      const normalized = normalizeDefectCounts(report.defectCounts);
      if (normalized.hasAny) {
        reportsWithCountsOnly += 1;
        for (const sev of DEFECT_SEVERITIES) severityTotals[sev] += normalized.counts[sev];
        unclassifiedDefectCount += normalized.unclassified;
      }
    }

    for (const rc of Array.isArray(report.rootCauseRows) ? report.rootCauseRows : []) {
      const conclusion = plain(rc?.conclusion);
      if (!conclusion) continue;
      let tally = rootCauseMap.get(conclusion);
      if (!tally) {
        tally = { conclusion, count: 0, reportIds: [] };
        rootCauseMap.set(conclusion, tally);
      }
      tally.count += 1;
      if (!tally.reportIds.includes(report.id)) tally.reportIds.push(report.id);
    }
  }

  for (const cluster of clusterMap.values()) cluster.worstSeverity = worstOf(cluster.severityTotals);

  const clusters = [...clusterMap.values()]
    .sort((a, b) => {
      if (b.defectCount !== a.defectCount) return b.defectCount - a.defectCount;
      const rank = SEVERITY_RANK[a.worstSeverity] - SEVERITY_RANK[b.worstSeverity];
      if (rank !== 0) return rank;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .slice(0, maxClusters);

  const rootCauses = [...rootCauseMap.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.conclusion < b.conclusion ? -1 : a.conclusion > b.conclusion ? 1 : 0;
  });

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    since,
    reportCount: inWindow.length,
    reportsWithDefectRows,
    reportsWithCountsOnly,
    severityTotals,
    unclassifiedDefectCount,
    verdictTotals,
    clusters,
    rootCauses,
  };
}
