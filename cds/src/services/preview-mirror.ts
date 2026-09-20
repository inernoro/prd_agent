/**
 * 预览实例数据镜像（CDS 托管 CDS，2026-09-16）。
 *
 * 病根：子 CDS 是全新空库，之前靠一份 2026-09-09 抓的静态形状快照当演示数据——它只有
 * 项目名、分支名和相对时间，没有服务、没有状态，于是每条分支落库都是 idle 加空服务，
 * 分支详情的关系卡、总览、部署页全是空态（用户 2026-09-16：「希望数据方面能拷贝真实
 * 环境下的 CDS，而不是全都是停止状态」）。
 *
 * 做法：父实例在部署 CDS 预览实例分支时，把自己的数据脱敏后写成一个 JSON 文件放进
 * 子实例的 worktree（`<worktree>/.cds/preview-mirror.json`，与子实例的 state.json 同目录，
 * 已 gitignore）；子实例每次启动按这个文件播种。三条底线：
 *
 *   1. **只读**：所有镜像数据带 `mirror: { capturedAt, source }`，UI 标「镜像 · 采集于」，
 *      动作按钮维持禁用（子实例本来就没有容器）。
 *   2. **不带凭据**：子实例不打父实例 API，纯文件单向；文件里 env 一律脱敏——
 *      敏感 key 与含内联凭据的值只留形状（URL 保留 scheme 与主机名，让服务关系图的
 *      基础设施连线还画得出来），Agent Key / 凭据 / 授权表这些集合根本不进文件。
 *   3. **不冒充**：状态按采集时刻原样搬，但每处都能看出「这是采集时刻的状态，本实例上
 *      没有容器」；运行中容器近 30 分钟的指标点位以「距采集时刻多少秒」存，子实例回放时
 *      锚到当下，和静态快照的相对时间是同一个思路。
 *
 * 父实例侧只写文件不改自己的任何状态；子实例侧的播种是幂等的：同一份镜像（capturedAt
 * 相同）重复启动不重写，新镜像整体替换旧镜像播下的条目，镜像里消失的条目一并删掉。
 */
import fs from 'node:fs';
import { profileHostsPreviewInstance } from './preview-instance.js';
import path from 'node:path';
import type {
  AcceptanceReportMeta,
  BranchEntry,
  BuildProfile,
  DeploymentRun,
  OperationLog,
  PreviewMirrorTag,
  Project,
} from '../types.js';
import type { StateService } from './state.js';
import { isSensitiveKey, looksLikeSecretBearingValue, looksLikeUrlWithCredentials, maskSecrets } from './secret-masker.js';
import { queryContainerSeries, type SeriesPoint, type SeriesResult } from './container-metrics-history.js';

export const PREVIEW_MIRROR_VERSION = 1;
export const PREVIEW_MIRROR_FILE = 'preview-mirror.json';
export const PREVIEW_MIRROR_SOURCE = 'parent-cds' as const;
/** 每条分支最多带几条部署 run / 活动日志进镜像。 */
const MAX_RUNS_PER_BRANCH = 3;
const MAX_LOGS_PER_BRANCH = 3;
/** 运行中容器的指标窗口与点数。 */
const METRICS_WINDOW_SEC = 30 * 60;
const METRICS_POINTS = 120;

export type { PreviewMirrorTag };

export interface MirrorMetricPoint {
  /** 距采集时刻多少秒（正数，越大越早） */
  o: number;
  c: number | null;
  m: number | null;
  rx: number | null;
  tx: number | null;
  rd: number | null;
  wr: number | null;
}

export interface PreviewMirrorFile {
  version: typeof PREVIEW_MIRROR_VERSION;
  capturedAt: string;
  source: { kind: typeof PREVIEW_MIRROR_SOURCE; label: string };
  projects: Project[];
  buildProfiles: BuildProfile[];
  branches: BranchEntry[];
  deploymentRuns: DeploymentRun[];
  reports: AcceptanceReportMeta[];
  logs: Record<string, OperationLog[]>;
  /** 容器名 → 指标点位 */
  metrics: Record<string, MirrorMetricPoint[]>;
}

/* ------------------------------------------------------------------ 脱敏 */

/**
 * env 脱敏：敏感 key 或看着像带凭据的值只留形状。
 * `scheme://user:pass@host/...` 保留 scheme 与主机名（服务关系图靠主机名推基础设施连线），
 * 其余敏感值一律 `***`。不敏感的值原样保留（前缀、端口、开关这类才是图和面板要读的）。
 */
export function redactEnvForMirror(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return env;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const value = typeof v === 'string' ? v : String(v ?? '');
    if (looksLikeUrlWithCredentials(value)) {
      out[k] = value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1***:***@');
    } else if (isSensitiveKey(k) || looksLikeSecretBearingValue(value)) {
      out[k] = '***';
    } else {
      out[k] = value;
    }
  }
  return out;
}

/**
 * 字符串里内联的凭据：`scheme://user:pass@host` 与 `--password=xxx` / `TOKEN=xxx` 这类参数。
 * command / entrypoint / 事件文案都可能带；子实例不跑容器，把它们抹掉不损失任何功能。
 */
function redactStringForMirror(value: string): string {
  // 先过通用打码，再归一 URL 里的凭据：通用打码会把 user:pass 写成 `***:***[masked]***`，
  // 自检认的形状是 `***:***@`，顺序反了自检就会把自己打的码当成泄露
  return maskSecrets(value)
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s"'@/]+:[^\s"'@/]+@/gi, '$1***:***@')
      // 只有用户名段的 URL 凭据（https://ghp_xxx@github.com/…，GitHub PAT 就是这么放的；Codex P1）
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s"'@/:]+@/gi, '$1***@')
      // 参数里的凭据：--api-token=xxx / --password xxx / TOKEN=xxx（等号、冒号、空格三种写法）
      .replace(/(\b[a-z][a-z0-9_-]*(?:token|password|passwd|pwd|secret|api[-_]?key|access[-_]?key|private[-_]?key)\s*[=:]\s*)[^\s"']+/gi, '$1***')
      .replace(/(--?[a-z][a-z0-9-]*(?:token|password|passwd|pwd|secret|key)\s+)[^\s"'-][^\s"']*/gi, '$1***');
}

/**
 * 深度脱敏：构建配置不止顶层 `env` 一处能放凭据——`deployModes[*].env`、`managedBuild.*`、
 * `command` / `entrypoint` 都可能带（Codex P1）。镜像文件落在未合并分支的 worktree 里，
 * 那条分支读得到，所以不能靠「拷一份再改 env」，要逐字段走一遍：
 *   - 任何一层的 `env` 对象走 redactEnvForMirror；
 *   - 敏感 key 下的字符串一律 `***`；
 *   - 其余字符串抹掉内联凭据（URL 里的 user:pass、参数里的 password= / token=）。
 */
export function deepRedactForMirror<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepRedactForMirror(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'env' && v && typeof v === 'object' && !Array.isArray(v)) out[k] = redactEnvForMirror(v as Record<string, string>);
      else if (typeof v === 'string' && isSensitiveKey(k)) out[k] = '***';
      else out[k] = deepRedactForMirror(v);
    }
    return out as T;
  }
  if (typeof value === 'string') return redactStringForMirror(value) as T;
  return value;
}

function redactProfile(profile: BuildProfile): BuildProfile {
  return deepRedactForMirror(profile);
}

const PROJECT_KEYS: ReadonlyArray<keyof Project> = [
  'id', 'slug', 'name', 'aliasName', 'aliasSlug', 'description', 'kind', 'deliveryMode',
  'inheritGlobalEnv', 'infraIsolation', 'resourceChipDisplay', 'gitRepoUrl', 'gitDefaultBranch',
  'cloneStatus', 'dockerNetwork', 'createdAt', 'updatedAt',
];

/**
 * 项目按白名单拷：凭据 / 授权 / Agent Key / 状态页 token 这些字段根本不进镜像。
 * 白名单里的字符串照样过深度脱敏——`gitRepoUrl` 可以被存成 `https://ghp_xxx@host/repo.git`
 * 这种带 PAT 的形式（Codex P1），白名单只管「哪些字段」，管不了「字段里装了什么」。
 */
function redactProject(project: Project, tag: PreviewMirrorTag): Project {
  const out: Partial<Project> = {};
  for (const k of PROJECT_KEYS) {
    const v = project[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  if (project.managedProfiles) out.managedProfiles = project.managedProfiles.map(redactProfile);
  return { ...deepRedactForMirror(out as Project), mirror: tag };
}

/** 分支：标量字段全拷，嵌套结构逐个处理，重的 / 带 env 的 / 副本集的不带或脱敏。 */
function redactBranch(branch: BranchEntry, tag: PreviewMirrorTag): BranchEntry {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(branch)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  out.worktreePath = `/preview-mirror/${branch.id}`;
  out.services = Object.fromEntries(
    Object.entries(branch.services || {}).map(([pid, svc]) => {
      const { buildLog: _buildLog, ...rest } = svc as typeof svc & { buildLog?: string };
      return [pid, rest];
    }),
  );
  for (const k of ['tags', 'subdomainAliases', 'customDomains'] as const) {
    if (Array.isArray(branch[k])) out[k] = [...(branch[k] as string[])];
  }
  if (branch.profileOverrides) {
    out.profileOverrides = Object.fromEntries(
      Object.entries(branch.profileOverrides).map(([pid, ov]) => [pid, { ...ov, env: redactEnvForMirror(ov.env) }]),
    );
  }
  if (branch.extraProfiles) out.extraProfiles = branch.extraProfiles.map(redactProfile);
  if (branch.heatState) out.heatState = branch.heatState;
  // 执行器 / 副本集 / 副本库快照：子实例没有这些能力，带过去只会让面板去查不存在的东西
  delete out.executorId;
  out.mirror = tag;
  return out as unknown as BranchEntry;
}

function redactRun(run: DeploymentRun): DeploymentRun {
  // 事件流里可能夹着构建输出：过一遍通用打码，再只留最近 40 条
  const events = (run.events || []).slice(-40).map((e) => ({
    ...e,
    message: typeof (e as { message?: string }).message === 'string' ? maskSecrets((e as { message?: string }).message) : (e as { message?: string }).message,
  }));
  return { ...run, events } as DeploymentRun;
}

function redactLog(log: OperationLog): OperationLog {
  return {
    ...log,
    events: (log.events || []).slice(-40).map((e) => ({
      ...e,
      log: e.log ? maskSecrets(e.log) : e.log,
      chunk: e.chunk ? maskSecrets(e.chunk) : e.chunk,
      title: e.title ? maskSecrets(e.title) : e.title,
    })),
    containerLogSnapshots: undefined,
  };
}

/* ------------------------------------------------------------------ 父实例：导出 */

export interface BuildPreviewMirrorOptions {
  /** 父实例算出来的真实预览入口（列表接口同一套算法），子实例自己算不出父实例的域名 */
  previewFor?: (branch: BranchEntry) => { url: string; urls: string[] } | undefined;
  /** 提交标题（父实例 worktree 里 git log 出来的），可选 */
  subjectFor?: (branch: BranchEntry) => string | undefined;
  /** 镜像来源的人话标签（写进项目描述 / 分支备注），如「生产 CDS」 */
  sourceLabel?: string;
  nowMs?: number;
}

export function buildPreviewMirror(state: StateService, opts: BuildPreviewMirrorOptions = {}): PreviewMirrorFile {
  const nowMs = opts.nowMs ?? Date.now();
  const capturedAt = new Date(nowMs).toISOString();
  const label = opts.sourceLabel || '父实例';
  const base: PreviewMirrorTag = { capturedAt, source: PREVIEW_MIRROR_SOURCE };

  // 不搬预览实例自己（cds-self 项目）：子实例里再出现一层「CDS 托管 CDS」的分支只会绕晕人
  const projects = state.getProjects().filter((p) => !isHostingProject(state, p.id));
  const projectIds = new Set(projects.map((p) => p.id));
  const branches = state.getAllBranches().filter((b) => projectIds.has(b.projectId));

  const runs: DeploymentRun[] = [];
  const logs: Record<string, OperationLog[]> = {};
  const metrics: Record<string, MirrorMetricPoint[]> = {};
  const mirroredBranches = branches.map((b) => {
    const preview = opts.previewFor?.(b);
    const tag: PreviewMirrorTag = { ...base, previewUrl: preview?.url, previewUrls: preview?.urls, subject: opts.subjectFor?.(b) };
    for (const run of state.getDeploymentRuns({ branchId: b.id }).slice(0, MAX_RUNS_PER_BRANCH)) runs.push(deepRedactForMirror(redactRun(run)));
    const branchLogs = state.getLogs(b.id).slice(-MAX_LOGS_PER_BRANCH).map((l) => deepRedactForMirror(redactLog(l)));
    if (branchLogs.length) logs[b.id] = branchLogs;
    return deepRedactForMirror(redactBranch(b, tag));
  });

  const runningContainers = branches.flatMap((b) => Object.values(b.services || {}).filter((s) => s.status === 'running').map((s) => s.containerName));
  if (runningContainers.length > 0) {
    const series = queryContainerSeries({ containers: runningContainers, after: -METRICS_WINDOW_SEC, points: METRICS_POINTS }, nowMs);
    for (const [container, points] of Object.entries(series.series)) {
      const packed = points
        .map((p, i) => ({ o: Math.max(0, Math.round((series.before - series.timestamps[i]) / 1000)), c: p.cpuPercent, m: p.memUsedBytes, rx: p.rxRate, tx: p.txRate, rd: p.readRate, wr: p.writeRate }))
        .filter((p) => p.c !== null || p.m !== null);
      if (packed.length) metrics[container] = packed;
    }
  }

  const reports = state.listAcceptanceReports(null)
    .filter((r) => !r.projectId || projectIds.has(r.projectId))
    .map((r) => ({ ...r, shareToken: null, objectKey: null, storage: undefined }));

  return {
    version: PREVIEW_MIRROR_VERSION,
    capturedAt,
    source: { kind: PREVIEW_MIRROR_SOURCE, label },
    projects: projects.map((p) => redactProject(p, base)),
    buildProfiles: state.getBuildProfiles().filter((p) => projectIds.has(p.projectId)).map(redactProfile),
    branches: mirroredBranches,
    deploymentRuns: runs,
    reports,
    logs,
    metrics,
  };
}

/**
 * 「这个项目是不是用来托管 CDS 预览实例的」：任一构建配置声明了 CDS_PREVIEW_INSTANCE。
 * 判据与部署侧同一个谓词（profileHostsPreviewInstance）：那边看的是构建配置 env 与项目级 env 合并后的值，
 * 这里若只看构建配置 env，CDS_PREVIEW_INSTANCE 写在项目环境变量里时就会把托管项目自己也导进镜像（Codex P2）。
 */
export function isHostingProject(state: StateService, projectId: string): boolean {
  const projectEnv = state.getCustomEnv(projectId);
  return state.getBuildProfiles().some((p) => p.projectId === projectId && profileHostsPreviewInstance(p, projectEnv));
}

/** 写进子实例的 worktree（与它的 state.json 同目录）。返回写入路径。 */
export function writePreviewMirror(worktreePath: string, mirror: PreviewMirrorFile): string {
  const dir = path.join(worktreePath, '.cds');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, PREVIEW_MIRROR_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mirror), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** 镜像文件里不许出现的东西：这条守卫给测试和导出后自检共用。 */
export function findMirrorLeaks(mirror: PreviewMirrorFile): string[] {
  const text = JSON.stringify(mirror);
  const leaks: string[] = [];
  if (/"(agentKeys|globalAgentKeys|principals|userCredentials|projectGrants|customEnv|githubCredentialUserId|statusPageToken)"\s*:/.test(text)) leaks.push('carries-credential-collections');
  // URL 的 userinfo 段无论 user:pass 还是只有 user（PAT 形式）都算凭据；自己打的码（***:***@ / ***@）先剥掉
  const stripped = text.replace(/:\/\/\*\*\*(?::\*\*\*)?@/g, '://');
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s"@/]+@/i.test(stripped)) leaks.push('url-with-inline-credentials');
  return leaks;
}

/* ------------------------------------------------------------------ 子实例：读取与回放 */

export function readPreviewMirror(repoRoot: string): PreviewMirrorFile | null {
  const file = path.join(repoRoot, '.cds', PREVIEW_MIRROR_FILE);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as PreviewMirrorFile;
  if (parsed?.version !== PREVIEW_MIRROR_VERSION || !Array.isArray(parsed.projects)) {
    throw new Error(`preview-mirror.json 版本不认识（version=${String(parsed?.version)}）`);
  }
  return parsed;
}

/** 已装入内存的镜像：指标点位给序列端点回放，摘要给 /api/instance-mode 与页面提示。 */
export interface LoadedPreviewMirrorSummary {
  capturedAt: string;
  label: string;
  projects: number;
  branches: number;
  runningBranches: number;
  containersWithMetrics: number;
}
let loadedMetrics: Record<string, MirrorMetricPoint[]> = {};
let loadedSummary: LoadedPreviewMirrorSummary | null = null;

export function registerLoadedPreviewMirror(mirror: PreviewMirrorFile): LoadedPreviewMirrorSummary {
  loadedMetrics = mirror.metrics || {};
  loadedSummary = {
    capturedAt: mirror.capturedAt,
    label: mirror.source?.label || '父实例',
    projects: mirror.projects.length,
    branches: mirror.branches.length,
    runningBranches: mirror.branches.filter((b) => b.status === 'running').length,
    containersWithMetrics: Object.keys(loadedMetrics).length,
  };
  return loadedSummary;
}

export function loadedPreviewMirrorSummary(): LoadedPreviewMirrorSummary | null {
  return loadedSummary;
}

/** 测试用：清掉进程内装入的镜像。 */
export function __resetLoadedPreviewMirror(): void {
  loadedMetrics = {};
  loadedSummary = null;
}

/**
 * 把镜像点位锚到「当下」回放成序列端点的返回形状。
 *
 * 镜像里存的是「距采集时刻多少秒」，这里把它换算成 `now - offset`，于是不管子实例什么
 * 时候被打开，曲线都落在窗口里——和静态快照把相对天数换算成绝对时刻是同一个思路。
 * 没有任何一个容器有镜像点位时返回 null，让调用方走原路（真实存储里也没有，会是空图）。
 */
export function replayPreviewMirrorSeries(
  containers: string[],
  query: { after: number; before?: number; points?: number },
  nowMs: number = Date.now(),
): SeriesResult | null {
  const hit = containers.filter((c) => (loadedMetrics[c]?.length ?? 0) > 0);
  if (hit.length === 0) return null;
  const before = query.before && query.before > 0 ? query.before : nowMs;
  const after = query.after > 0 ? query.after : before + query.after * 1000;
  const asked = Math.max(1, Math.min(1000, query.points ?? 120));
  const span = Math.max(1, before - after);
  // 分辨率不细于镜像点位自己的间隔（与真实存储同一条规矩：桶宽至少是观测节奏的 1.5 倍），
  // 否则 120 个 15s 桶去接 60s 一个的点位，隔三桶空一桶，面积图被切成细条（实机截图抓到）。
  const spacingMs = (() => {
    const gaps: number[] = [];
    for (const c of hit) {
      const os = loadedMetrics[c].map((p) => p.o).sort((x, y) => x - y);
      for (let i = 1; i < os.length; i++) gaps.push((os[i] - os[i - 1]) * 1000);
    }
    if (gaps.length === 0) return 0;
    gaps.sort((x, y) => x - y);
    return gaps[Math.floor(gaps.length / 2)];
  })();
  const step = Math.max(1000, Math.floor(span / asked), Math.round(spacingMs * 1.5));
  const timestamps: number[] = [];
  for (let t = after + step; t <= before; t += step) timestamps.push(t);
  if (timestamps.length === 0) timestamps.push(before);

  const series: Record<string, SeriesPoint[]> = {};
  for (const c of containers) {
    const pts = loadedMetrics[c] ?? [];
    // 镜像点位本身已经是父实例按 60s 桶降采样过的，再按桶「落进去才算」会因对齐抖动隔一桶漏一桶，
    // 面积图被切成一根根 8px 的细条（实机截图抓到）。所以按「离桶心最近、且不超过 1.5 个桶宽」取，
    // 桶心两侧都有点就取平均；真的隔太远才是 null（采集断档，与真实存储口径一致）。
    const stamped = pts.map((p) => ({ at: nowMs - p.o * 1000, p })).sort((x, y) => x.at - y.at);
    series[c] = timestamps.map((ts) => {
      const center = ts - step / 2;
      let near = stamped.filter((x) => Math.abs(x.at - center) <= step / 2).map((x) => x.p);
      if (near.length === 0) {
        const best = stamped.reduce<{ d: number; p: MirrorMetricPoint } | null>((acc, x) => {
          const d = Math.abs(x.at - center);
          return d <= step && (!acc || d < acc.d) ? { d, p: x.p } : acc;
        }, null);
        near = best ? [best.p] : [];
      }
      const inBucket = near;
      const avg = (pick: (p: MirrorMetricPoint) => number | null): number | null => {
        const vals = inBucket.map(pick).filter((v): v is number => typeof v === 'number');
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      };
      return { ts, cpuPercent: avg((p) => p.c), memUsedBytes: avg((p) => p.m), rxRate: avg((p) => p.rx), txRate: avg((p) => p.tx), readRate: avg((p) => p.rd), writeRate: avg((p) => p.wr) };
    });
  }
  return { after, before, timestamps, groupSeconds: Math.round(step / 1000), group: 'average', series };
}
