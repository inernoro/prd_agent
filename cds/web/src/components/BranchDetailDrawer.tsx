import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Braces, CheckCircle2, Clock, Copy, Database, Eye, EyeOff, ExternalLink, GitBranch, GitPullRequest, HelpCircle, Loader2, Maximize2, Play, PowerOff, RefreshCw, Rocket, RotateCw, Search, Settings, Square, Table2, Terminal, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CdsLogoLoader } from '@/components/brand/CdsMetallicLogo';
import { apiRequest, ApiError } from '@/lib/api';
import { statusClass, statusRailClass } from '@/lib/statusStyle';
import { BranchDetailLoadingSkeleton, ErrorBlock, LoadingBlock } from '@/pages/cds-settings/components';
import { EnvEditor } from '@/pages/cds-settings/EnvEditor';
import { ActiveDeployment } from '@/components/deployment/ActiveDeployment';
import { HistoryRow } from '@/components/deployment/HistoryRow';
import { PreviewActionSplitButton } from '@/components/branch/PreviewActionSplitButton';
import { deriveBranchPhases, type PhaseKey } from '@/lib/deploymentPhases';
import { normalizeContainerLogsForDisplay } from '@/lib/containerLogs';
import {
  buildBranchResources,
  ResourceIcon,
  resourceAccessIcon,
  resourceKindLabel,
  resourceStatusLabel,
  type BranchResource,
  type BranchResourceInfraInput,
  type BranchResourceProfileInput,
} from '@/lib/resources';
import type { PhaseLogState } from '@/components/deployment/PhaseTree';

/*
 * BranchDetailDrawer — right-side slide-in showing the most-used parts
 * of BranchDetailPage without leaving the current page.
 *
 * Why exists: user feedback — "能在一个页面完成的，切勿跳转页面"。
 * Clicking "详情" on a BranchCard now slides this drawer over the
 * branch list grid instead of router-pushing to /branch-panel/<id>.
 *
 * What it loads:
 *   - GET /api/branches/:id              → branch + services
 *   - GET /api/branches/:id/logs         → recent build/run logs (last 5)
 *
 * Escape hatch: header has an external-detail link → /branch-panel/<id> for
 * the dedicated page when the user wants the full set of tabs.
 */

interface ServiceState {
  profileId: string;
  containerName: string;
  hostPort: number;
  status: 'idle' | 'building' | 'starting' | 'running' | 'restarting' | 'stopping' | 'stopped' | 'error';
  errorMessage?: string;
}

interface BranchDetailData {
  id: string;
  projectId: string;
  branch: string;
  status: string;
  previewSlug?: string;
  previewUrl?: string;
  services: Record<string, ServiceState>;
  resources?: BranchResource[];
  createdAt?: string;
  commitSha?: string;
  subject?: string;
  githubRepoFullName?: string;
  githubCommitSha?: string;
  githubPrNumber?: number;
  lastPushAt?: string;
  lastDeployAt?: string;
  lastAccessedAt?: string;
  lastReadyAt?: string;
  /** 2026-05-14: 最近一次停止的时间戳与原因，drawer 顶部用它解释"分支变灰"。 */
  lastStoppedAt?: string;
  lastStopReason?: string;
  lastStopSource?: 'user' | 'scheduler' | 'executor' | 'crash' | 'oom' | 'external' | 'cds' | 'system';
  deployCount?: number;
  pullCount?: number;
  stopCount?: number;
  errorMessage?: string;
  deployRuntime?: {
    kind: 'source' | 'release' | 'mixed';
    label: string;
    title: string;
    pendingPublish?: boolean;
  };
}

interface BuildProfileOverride {
  dockerImage?: string;
  command?: string;
  containerWorkDir?: string;
  containerPort?: number;
  env?: Record<string, string>;
  pathPrefixes?: string[];
  resources?: { memoryMB?: number; cpus?: number };
  activeDeployMode?: string;
  startupSignal?: string;
  notes?: string;
}

interface ProfileRow {
  profileId: string;
  profileName: string;
  baseline: {
    id: string;
    name: string;
    deployModes?: Record<string, { label?: string }>;
    activeDeployMode?: string;
  };
  override?: BuildProfileOverride | null;
  effective?: {
    dockerImage?: string;
    command?: string;
    containerPort?: number;
    pathPrefixes?: string[];
    dependsOn?: string[];
    activeDeployMode?: string;
    deployModes?: Record<string, { label?: string }>;
  };
  hasOverride?: boolean;
}

type ProfileOverridesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; profiles: ProfileRow[] }
  | { status: 'error'; message: string };

interface OperationLogEvent {
  step: string;
  status: string;
  title?: string;
  log?: string;
  timestamp?: string;
  chunk?: string;
  detail?: Record<string, unknown>;
}

interface OperationLog {
  type: string;
  startedAt: string;
  finishedAt?: string;
  runtimeStartedAt?: string;
  containerLogSnapshots?: DeploymentContainerLogSnapshot[];
  status: 'running' | 'completed' | 'error';
  events: OperationLogEvent[];
}

export interface DeploymentContainerLogSnapshot {
  profileId: string;
  containerName: string;
  hostPort?: number;
  status?: string;
  capturedAt: string;
  tailLines: number;
  source: 'deploy-finalize' | 'deploy-error';
  logs: string;
  message?: string;
}

interface ServiceLogsState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  profileId?: string;
  logs?: string;
  message?: string;
}

interface DrawerActivityEvent {
  id?: number;
  requestId?: string;
  ts?: string;
  method?: string;
  path?: string;
  status?: number;
  duration?: number;
  type?: 'cds' | 'web';
  branchId?: string;
  profileId?: string;
  label?: string;
  errorSummary?: string;
}

// 2026-05-18: 分支生命周期系统日志（部署 / 停止 / 崩溃 / 重启 / 回收）。
// 后端 GET /api/branches/:id/activity-logs 返回，已按最新在前排序。
interface BranchActivityLog {
  id: string;
  at: string;
  type: string;
  branchId?: string;
  branchName?: string;
  actor?: string;
  note?: string;
}
type SystemLogsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; logs: BranchActivityLog[] }
  | { status: 'error'; message: string };

interface BuildLogSelection {
  title: string;
  status: string;
  commitSha?: string;
  startedAt?: number | string;
  message?: string;
  lines: string[];
}

interface GithubWebhookDelivery {
  id: string;
  receivedAt: string;
  durationMs: number;
  deliveryId?: string;
  event: string;
  repoFullName?: string;
  ref?: string;
  commitSha?: string;
  commitMessage?: string;
  actor?: string;
  signatureValid: boolean;
  dispatchAction: 'branch-created' | 'deploy' | 'skipped' | 'ignored' | 'error';
  dispatchReason?: string;
  branchId?: string;
  deployDispatched?: boolean;
  deployDispatchError?: string;
  deployDedupSkipped?: boolean;
  selfStatusBroadcast?: boolean;
  payloadSnippet?: string;
  error?: string;
}

export interface BranchDeploymentItem {
  key: string;
  branchId: string;
  branchName: string;
  commitSha?: string;
  kind: 'preview' | 'deploy' | 'pull' | 'stop' | 'create' | 'favorite' | 'reset' | 'delete' | 'rebuild';
  status: 'running' | 'success' | 'error';
  message: string;
  log: string[];
  startedAt: number;
  finishedAt?: number;
  runtimeStartedAt?: number;
  runtimeEndedAt?: number;
  containerLogSnapshots?: DeploymentContainerLogSnapshot[];
  lastStep?: string;
  phase?: string;
  suggestion?: string;
}

type DrawerTab = 'overview' | 'deployments' | 'services' | 'logs' | 'variables' | 'metrics' | 'settings';
export type BranchResourceDetailTab = 'overview' | 'connection' | 'data' | 'backups' | 'variables' | 'metrics' | 'logs' | 'settings';
type ResourceCloneMode = 'empty' | 'clone-main' | 'restore-backup' | 'connect-existing';

interface ResourceExternalAccessInput {
  enabled: boolean;
  ttlMinutes?: number;
  allowlist?: string[];
}

interface ResourceCloneInput {
  mode: ResourceCloneMode;
  backupName?: string;
  backupId?: string;
  targetDatabase?: string;
  connectionString?: string;
  externalConnectionName?: string;
}
// 2026-05-18: 日志页签合一。原本 Webhook 日志 / 日志 / HTTP 三个并列页签
// 用户找不全，合并成单个「日志」页签，内部用 pill 切换：
// 系统日志（生命周期：谁停的/何时/为什么）/ 构建日志 / 容器日志 / Webhook / HTTP。
type LogsMode = 'system' | 'build' | 'container' | 'webhook' | 'http';
const DETAIL_LOG_VIEWPORT_CLASS = 'h-[424px] overflow-auto';
const DETAIL_LOG_EMPTY_CLASS = 'h-[424px] flex items-center px-5 text-sm leading-6 text-muted-foreground';

const drawerTabs: Array<{ key: DrawerTab; label: string; planned?: boolean }> = [
  { key: 'overview', label: '详情' },
  { key: 'deployments', label: '部署' },
  { key: 'services', label: '资源' },
  { key: 'logs', label: '日志' },
  { key: 'variables', label: '变量' },           // 2026-05-04 Phase A 落地
  { key: 'metrics', label: '指标' },             // 2026-05-04 Phase B 落地
  { key: 'settings', label: '设置' },            // 2026-05-04 Phase C 落地
];

// Phase A (2026-05-04):分支生效环境变量
type EnvSource = 'cds-builtin' | 'cds-derived' | 'mirror' | 'global' | 'project' | 'branch';
interface EffectiveEnvVar {
  key: string;
  /**
   * 显示用值。当 isSecret=true 时,后端已经做了 server-side redaction,这里
   * 是 '••••' + 末 4 位的 mask 串,**不**是明文。要拿明文走 reveal 端点
   * (Bugbot PR #524 第三轮反馈:之前明文随列表一起下发,网络面板/截图泄露)。
   */
  value: string;
  source: EnvSource;
  isSecret: boolean;
  /** 真实 value 的字符长度,UI 展示用("21 字符的密钥") */
  valueLength?: number;
}
interface EffectiveEnvResponse {
  branchId: string;
  projectId: string;
  projectSlug: string;
  total: number;
  bySource: Record<EnvSource, number>;
  variables: EffectiveEnvVar[];
}
type EffectiveEnvState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: EffectiveEnvResponse };

// Phase B (2026-05-04):分支指标
interface ContainerStatsResponse {
  name: string;
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  memPercent: number;
  netRxBytes: number;
  netTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
}
interface MetricsResponse {
  branchId: string;
  ts: number;
  runningCount: number;
  totalCount: number;
  services: Array<{
    profileId: string;
    containerName: string;
    status: string;
    stats: ContainerStatsResponse | null;
  }>;
}
type MetricsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: MetricsResponse };

interface ResourceMetricsResponse {
  branchId: string;
  projectId?: string;
  resourceId: string;
  resourceName: string;
  containerName: string | null;
  status: string;
  ts: number;
  stats: ContainerStatsResponse | null;
}
type ResourceMetricsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: ResourceMetricsResponse };

interface ResourceLogsResponse {
  branchId: string;
  projectId?: string;
  resourceId: string;
  resourceName: string;
  containerName: string;
  status: string;
  tail: number;
  masked: boolean;
  logs: string;
}
type ResourceLogsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; data: ResourceLogsResponse };

type TriggerLogsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      deliveries: GithubWebhookDelivery[];
      total: number;
      filteredTotal: number;
      hasMore: boolean;
      loadingMore?: boolean;
    };

// 2026-05-14: webhook 日志分页 — 每页 20 条，懒加载下一页，与 buffer 1000 配合。
const TRIGGER_LOGS_PAGE_SIZE = 20;

/** 5-min ring buffer (60 points × 5s 间隔) per service+metric — UI sparkline 用 */
interface MetricSeries {
  cpu: number[];        // %
  mem: number[];        // % of limit
  rxRate: number[];     // bytes/sec(由两次响应间 delta / dt 算出)
  txRate: number[];     // bytes/sec
}
const METRIC_RING_SIZE = 60;

function DrawerTabButton({
  tab,
  active,
  onClick,
}: {
  tab: { key: DrawerTab; label: string; planned?: boolean };
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`relative inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap px-3 text-sm transition-colors ${
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
      onClick={onClick}
    >
      {tab.label}
      {tab.planned ? <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-[10px] text-muted-foreground">计划</span> : null}
      {active ? <span className="absolute inset-x-2 bottom-0 h-px bg-primary" /> : null}
    </button>
  );
}

function statusLabel(s: string): string {
  return ({
    idle: '未运行', building: '构建中', starting: '启动中', running: '运行中',
    restarting: '重启中', stopping: '停止中', stopped: '已停止', error: '异常',
  } as Record<string, string>)[s] || s;
}

// Bugbot fix(2026-05-04 PR #523):statusClass + statusRailClass 已抽到
// `cds/web/src/lib/statusStyle.ts` 共享模块,见顶部 import。

function deploymentStatusClass(status: BranchDeploymentItem['status']): string {
  if (status === 'running') return 'border-sky-500/30 bg-sky-500/10 text-sky-500';
  if (status === 'success') return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600';
  return 'border-destructive/30 bg-destructive/10 text-destructive';
}

function deploymentKindLabel(kind: BranchDeploymentItem['kind']): string {
  return ({
    preview: '预览部署',
    deploy: '部署',
    pull: '拉取',
    stop: '停止',
    create: '创建分支',
    favorite: '收藏',
    reset: '重置',
    delete: '删除',
    rebuild: '重新生成',
  } as Record<BranchDeploymentItem['kind'], string>)[kind];
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function githubBranchTreeUrl(repoFullName: string, branchName: string): string {
  const encodedBranch = branchName.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `https://github.com/${repoFullName}/tree/${encodedBranch}`;
}

function githubPullRequestUrl(repoFullName: string, prNumber: number): string {
  return `https://github.com/${repoFullName}/pull/${prNumber}`;
}

function deploymentStages(log: string[]): string[] {
  const stages = new Set<string>();
  for (const line of log) {
    if (/代码|clone|checkout|git|pull/i.test(line)) stages.add('代码');
    if (/容器|docker|image|镜像/i.test(line)) stages.add('容器');
    if (/构建|build|install|compile|tsc|npm|pnpm|dotnet/i.test(line)) stages.add('构建');
    if (/运行|启动|run|listen|health/i.test(line)) stages.add('执行');
  }
  return Array.from(stages);
}

function eventText(event: OperationLogEvent): string {
  const detailMessage = event.detail && typeof event.detail.message === 'string'
    ? event.detail.message
    : '';
  const primary = event.title || event.log || event.chunk || detailMessage || event.step;
  const extra = event.title && event.log
    ? event.log
    : event.title && event.chunk
      ? event.chunk
      : event.title && detailMessage
        ? detailMessage
        : '';
  return `[${event.status}] ${primary}${extra ? ` - ${extra}` : ''}`;
}

function logFailureReason(log: OperationLog): string {
  const error = log.events.slice().reverse().find((event) => event.status === 'error' || event.log);
  return error ? eventText(error) : '';
}

function deriveRuntimeStartedAt(log: OperationLog): number | undefined {
  if (log.runtimeStartedAt) {
    const explicit = new Date(log.runtimeStartedAt).getTime();
    if (Number.isFinite(explicit)) return explicit;
  }
  const readyEvents = (log.events || []).filter((event) => {
    if (event.status !== 'done') return false;
    const text = `${event.step || ''} ${event.title || ''}`;
    return text.includes('runtime-ready')
      || text.includes('运行于')
      || text.includes('启动成功')
      || text.includes('已通过就绪探测');
  });
  const lastReady = readyEvents[readyEvents.length - 1];
  if (!lastReady?.timestamp) return undefined;
  const derived = new Date(lastReady.timestamp).getTime();
  return Number.isFinite(derived) ? derived : undefined;
}

function branchFailureReason(branch: BranchDetailData): string {
  if (branch.errorMessage) return branch.errorMessage;
  const failed = Object.values(branch.services || {}).filter((svc) => svc.status === 'error');
  if (failed.length === 0) return '';
  return failed.map((svc) => `${svc.profileId}: ${svc.errorMessage || '启动失败'}`).join('\n');
}

function buildLlmFailurePrompt(
  branch: BranchDetailData,
  failureReason: string,
  diagnostics: Array<{
    profileId: string;
    containerName?: string;
    tailLines: string[];
    errorCategory: string;
    errorHint: string;
    responsibilitySide: 'code' | 'config' | 'cds' | 'unknown';
  }>,
): string {
  const services = Object.values(branch.services || {});
  const lines = [
    '请作为资深工程师分析并修复下面这个 CDS 分支部署/启动失败问题。',
    '要求：先判断是应用代码、配置、依赖、资源还是 CDS 平台问题；给出最小修复步骤；如果需要改代码，请指出应检查的文件、命令和验证方式。',
    '',
    '## 分支上下文',
    `项目ID: ${branch.projectId}`,
    `分支ID: ${branch.id}`,
    `分支名: ${branch.branch}`,
    `状态: ${branch.status}`,
    branch.githubRepoFullName ? `GitHub仓库: ${branch.githubRepoFullName}` : '',
    branch.githubCommitSha ? `GitHub提交: ${branch.githubCommitSha}` : '',
    branch.commitSha ? `当前提交: ${branch.commitSha}` : '',
    branch.lastPushAt ? `最近推送: ${branch.lastPushAt}` : '',
    branch.lastDeployAt ? `最近成功部署: ${branch.lastDeployAt}` : '',
    '',
    '## 失败摘要',
    failureReason || branch.errorMessage || '未提供失败摘要',
    '',
    '## 服务状态',
    ...services.map((svc) => [
      `- ${svc.profileId}`,
      `container=${svc.containerName}`,
      `port=${svc.hostPort}`,
      `status=${svc.status}`,
      svc.errorMessage ? `error=${svc.errorMessage}` : '',
    ].filter(Boolean).join(' · ')),
    '',
    '## CDS 诊断',
    diagnostics.length > 0
      ? diagnostics.map((diag) => [
        `### ${diag.profileId}`,
        diag.containerName ? `container: ${diag.containerName}` : '',
        `category: ${diag.errorCategory}`,
        `side: ${diag.responsibilitySide}`,
        diag.errorHint ? `hint: ${diag.errorHint}` : '',
        diag.tailLines.length > 0 ? 'tail logs:' : '',
        diag.tailLines.slice(-30).join('\n'),
      ].filter(Boolean).join('\n')).join('\n\n')
      : 'CDS 未返回结构化诊断；请基于失败摘要和服务状态分析。',
    '',
    '## 可用排查入口',
    `- GET /api/branches/${encodeURIComponent(branch.id)}/failure-diagnosis`,
    `- GET /api/branches/${encodeURIComponent(branch.id)}/logs`,
    `- POST /api/branches/${encodeURIComponent(branch.id)}/container-logs { "profileId": "<服务ID>" }`,
    `- GET /api/branches/${encodeURIComponent(branch.id)}/activity-logs?limit=100`,
    '',
    '请输出：根因判断、修复方案、验证命令、风险点。',
  ];
  return lines.filter((line) => line !== '').join('\n');
}

function isGenericFailureHint(value: string): boolean {
  return /未识别的错误模式|查看完整日志诊断/i.test(value);
}

function failureKeyLogLines(lines: string[], max = 8): string[] {
  const keywords = [
    /error\b/i,
    /exception\b/i,
    /failed?\b/i,
    /fatal\b/i,
    /denied\b/i,
    /timeout|timed out/i,
    /not found/i,
    /cannot|can't/i,
    /缺少|失败|异常|错误|超时|拒绝|不存在|找不到|无法/,
  ];
  const ignored = [
    /update available/i,
    /packages?: \+/i,
    /progress: resolved/i,
    /all projects are up-to-date/i,
    /lockfile is up to date/i,
    /determining projects to restore/i,
  ];
  const cleaned = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .filter((line) => !ignored.some((pattern) => pattern.test(line)));
  const selected: string[] = [];
  cleaned.forEach((line, index) => {
    if (!keywords.some((pattern) => pattern.test(line))) return;
    for (let offset = -1; offset <= 4; offset += 1) {
      const context = cleaned[index + offset];
      if (context) selected.push(context.trim());
    }
  });
  return Array.from(new Set(selected)).slice(-max);
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Browser permission policies can reject clipboard writes even on HTTPS.
      // Fall through to the textarea path so the recovery button still works.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

const ACTIVE_DEPLOYMENT_TAIL_MS = 60_000;

function legacyLogToDeploymentItem(log: OperationLog, branchId: string): BranchDeploymentItem {
  const events = log.events || [];
  const lines = events.map(eventText);
  const finishedAt = log.finishedAt ? new Date(log.finishedAt).getTime() : undefined;
  const startedAt = log.startedAt ? new Date(log.startedAt).getTime() : Date.now();
  const runtimeStartedAt = deriveRuntimeStartedAt(log);
  const status: BranchDeploymentItem['status'] = log.status === 'completed'
    ? 'success'
    : log.status === 'error'
      ? 'error'
      : 'running';
  const lastStep = events.length > 0 ? eventText(events[events.length - 1]) : log.type;
  const message = logFailureReason(log) || lastStep;
  return {
    key: `legacy-${log.startedAt}-${log.type}`,
    branchId,
    branchName: '',
    kind: 'deploy',
    status,
    message,
    log: lines,
    startedAt,
    finishedAt,
    runtimeStartedAt,
    containerLogSnapshots: log.containerLogSnapshots || [],
    lastStep,
  };
}

/**
 * PreviewUrlChip — running 时显示 production URL,一键复制 + 在新窗口打开。
 * 用户 2026-04-30 反馈:成功后 URL 必须在显眼位置,不能让用户去 Drawer
 * 「部署」tab 才看到。Week 4.8 Round 4b 实现。
 */
function PreviewUrlChip({ url }: { url: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  // 显示用版本:去掉 protocol 前缀,更清爽
  const display = url.replace(/^https?:\/\//, '');
  const copy = () => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="min-w-0 flex-1 truncate font-mono text-xs text-emerald-700 hover:underline dark:text-emerald-400"
        title={url}
      >
        {display}
      </a>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6 shrink-0 px-2 text-xs"
        onClick={copy}
        aria-label="复制预览地址"
      >
        {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? '已复制' : '复制'}
      </Button>
    </div>
  );
}

function pickActiveDeployment(items: BranchDeploymentItem[], now: number): BranchDeploymentItem | null {
  if (items.length === 0) return null;
  const sorted = items.slice().sort((left, right) => right.startedAt - left.startedAt);
  // running 优先
  const running = sorted.find((item) => item.status === 'running');
  if (running) return running;
  // 最近 60s 内结束的最近一条也当作 active
  const recent = sorted.find((item) => {
    if (!item.finishedAt) return false;
    return now - item.finishedAt <= ACTIVE_DEPLOYMENT_TAIL_MS;
  });
  if (recent) return recent;
  // 否则第一条（按时间倒序的最新）
  return sorted[0];
}

export function BranchDetailDrawer({
  branchId,
  projectId,
  open,
  onClose,
  deployments = [],
  activityEvents = [],
  now = Date.now(),
  previewUrl = '',
  branchStatus,
  initialResourceId,
  initialResourceDetailTab,
  onToast,
  onActionComplete,
  onRelease,
}: {
  branchId: string | null;
  projectId: string;
  open: boolean;
  onClose: () => void;
  deployments?: BranchDeploymentItem[];
  activityEvents?: DrawerActivityEvent[];
  now?: number;
  /** 由父页面注入的 toast 函数 — 设置 tab 操作完成后用它反馈结果 */
  onToast?: (message: string) => void;
  /** 操作(deploy/pull/stop/reset/delete)完成后回调,父页面用来重拉 BranchList。
      delete 完成时本组件会自动 onClose,父页面无需特别处理。 */
  onActionComplete?: (action: 'deploy' | 'restart' | 'pull' | 'stop' | 'reset' | 'delete') => void;
  onRelease?: (branchId: string) => void;
  /**
   * Production preview URL precomputed at the caller (so the Drawer
   * doesn't have to load /api/config independently). Empty string =
   * no preview available (eg. running on simple mode without main
   * domain configured). Drawer 仅在 running 时显示 URL chip。
   */
  previewUrl?: string;
  initialResourceId?: string | null;
  initialResourceDetailTab?: BranchResourceDetailTab | null;
  /**
   * Branch status at the time of opening, used to decide whether to
   * actually render the URL chip (only running). The Drawer also has
   * its own `branch.status` after load — this prop covers the gap
   * between drawer-open and load completion.
   */
  branchStatus?: string;
}): JSX.Element | null {
  const [branch, setBranch] = useState<BranchDetailData | null>(null);
  const [logs, setLogs] = useState<OperationLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [headerRefreshing, setHeaderRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<DrawerTab>('deployments');
  // Phase A — Variables tab(2026-05-04)
  const [envState, setEnvState] = useState<EffectiveEnvState>({ status: 'idle' });
  // 已 reveal 的 secret 明文 cache:key → 明文。server-side redaction 之后,
  // 列表响应里 secret 是 '••••' + 末 4 位,真值需要按 key 调 reveal 端点。
  const [revealedValues, setRevealedValues] = useState<Map<string, string>>(new Map());
  const [envQuery, setEnvQuery] = useState('');
  const [branchEnvEditorOpen, setBranchEnvEditorOpen] = useState(false);
  const [systemLogsState, setSystemLogsState] = useState<SystemLogsState>({ status: 'idle' });
  // Phase B — Metrics tab(2026-05-04)
  const [metricsState, setMetricsState] = useState<MetricsState>({ status: 'idle' });
  const [triggerLogsState, setTriggerLogsState] = useState<TriggerLogsState>({ status: 'idle' });
  // 2026-05-14 Codex review P2 修复：loadMore 的 offset 不能从 setState 的
  // updater 里"顺便"读出来（React 会 batch，updater 可能在 fetch 之后才跑，
  // 导致 offset 仍是 0、第二页重复拉第一页并 append 重复 webhook 记录）。
  // 用一个 ref 同步镜像当前已加载条数，loadMore 时同步读取。
  const triggerLogsCountRef = useRef(0);
  // 2026-05-14 Codex review P2：loadMore 的并发守卫不能只靠 setState
  // updater 的 loadingMore（异步提交）。双击在 React commit 前两次都能
  // 过 updater 检查 → 用同一 offset 发两次请求、同页追加两次。这个 ref
  // 同步置位，是真正的去重闸门。
  const triggerLogsLoadMoreInFlightRef = useRef(false);
  const [profileState, setProfileState] = useState<ProfileOverridesState>({ status: 'idle' });
  const [infraServices, setInfraServices] = useState<BranchResourceInfraInput[]>([]);
  const [resourceSnapshot, setResourceSnapshot] = useState<BranchResource[]>([]);
  const [modeSavingProfileId, setModeSavingProfileId] = useState<string | null>(null);
  // ring buffer keyed by profileId,内存级,关抽屉就丢(metrics 是观测,不是审计)
  const [metricSeries, setMetricSeries] = useState<Record<string, MetricSeries>>({});
  // 上次响应快照,用来算 rx/tx 速率(后端只给累计值,前端做 delta/dt)。
  // 必须用 ref 而不是 state:setInterval 在 useEffect [activeTab, branchId]
  // 内创建,只会捕获**首次** loadMetrics 闭包。state 变了之后,新 loadMetrics
  // 永远不会被 interval 调到。结果就是每次 tick 看到 ts=0 / map={},dt=0,
  // rxRate/txRate 永远算成 0。改 ref 后同步可读最新值,不依赖 dep array。
  const lastMetricsTsRef = useRef<number>(0);
  const lastMetricsByServiceRef = useRef<Record<string, ContainerStatsResponse>>({});
  // 当前 mounted branchId 的 ref。Bugbot PR #524 第四轮反馈:用户在 metrics
  // tab 打开时切换分支,之前的 in-flight loadMetrics 请求可能在 branchId 已
  // 切换后才 resolve,把上一个分支的累计 bytes 写进新分支的 ring buffer,
  // 第一笔 delta 算出乱七八糟的网络速率(两个不同容器的累计计数器相减)。
  // 每个请求开始前 capture branchId,resolve 时对 ref.current 一致性校验,
  // 不一致就丢弃(stale response)。
  // 显式 MutableRefObject:不传 null/undefined 联合避开 React 的 RefObject 只读重载
  const branchIdRef = useRef<string>(branchId || '');
  useEffect(() => { branchIdRef.current = branchId || ''; }, [branchId]);
  // Phase C — Settings tab(2026-05-04)
  const [actionBusy, setActionBusy] = useState<{ branchId: string; action: 'deploy' | 'restart' | 'pull' | 'stop' | 'reset' | 'delete' } | null>(null);
  const currentActionBusy = actionBusy?.branchId === branchId ? actionBusy.action : null;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [logsMode, setLogsMode] = useState<LogsMode>('system');
  const [selectedBuildLog, setSelectedBuildLog] = useState<BuildLogSelection | null>(null);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null);
  const [serviceLogs, setServiceLogs] = useState<ServiceLogsState>({ status: 'idle' });
  const [logQuery, setLogQuery] = useState('');
  const logsSectionRef = useRef<HTMLElement | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  // 失败诊断(2026-05-04 UX 优化):分支 status === 'error' 时 lazy-load,显示
  // 错误归类 + 最后 5 行 stderr + 责任归属。
  const [failureDiag, setFailureDiag] = useState<{
    failedServices: Array<{
      profileId: string;
      containerName?: string;
      tailLines: string[];
      errorCategory: string;
      errorHint: string;
      responsibilitySide: 'code' | 'config' | 'cds' | 'unknown';
    }>;
  } | null>(null);
  const [copiedFailurePrompt, setCopiedFailurePrompt] = useState(false);

  const load = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    setError('');
    try {
      // The backend exposes /api/branches?project=<id> (list) but no
      // single-branch endpoint, mirroring how BranchDetailPage loads.
      const [branchesRes, logsRes, profilesRes, infraRes, resourcesRes] = await Promise.all([
        apiRequest<{ branches: BranchDetailData[] }>(`/api/branches?project=${encodeURIComponent(projectId)}&live=false`),
        apiRequest<{ logs: OperationLog[] }>(`/api/branches/${encodeURIComponent(branchId)}/logs`).catch(() => ({ logs: [] })),
        apiRequest<{ profiles: ProfileRow[] }>(`/api/branches/${encodeURIComponent(branchId)}/profile-overrides`)
          .catch((err) => {
            setProfileState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
            return { profiles: [] };
          }),
        apiRequest<{ services: BranchResourceInfraInput[] }>(`/api/infra?project=${encodeURIComponent(projectId)}&live=false`)
          .catch(() => ({ services: [] })),
        apiRequest<{ resources: BranchResource[] }>(`/api/branches/${encodeURIComponent(branchId)}/resources?live=false`)
          .catch(() => ({ resources: [] })),
      ]);
      const found = (branchesRes.branches || []).find((b) => b.id === branchId);
      if (!found) {
        setError('branch_not_found');
        setBranch(null);
      } else {
        setBranch(found);
      }
      setLogs(logsRes.logs || []);
      setProfileState({ status: 'ok', profiles: profilesRes.profiles || [] });
      setInfraServices(infraRes.services || []);
      setResourceSnapshot(resourcesRes.resources || found?.resources || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [branchId, projectId]);

  const loadTriggerLogs = useCallback(async () => {
    if (!branchId) return;
    setTriggerLogsState({ status: 'loading' });
    try {
      const params = new URLSearchParams();
      params.set('limit', String(TRIGGER_LOGS_PAGE_SIZE));
      params.set('offset', '0');
      params.set('branchId', branchId);
      if (branch?.githubRepoFullName) params.set('repoFullName', branch.githubRepoFullName);
      if (branch?.branch) params.set('ref', `refs/heads/${branch.branch}`);
      const raw = await apiRequest<unknown>(
        `/api/cds-system/github/webhook-deliveries?${params.toString()}`,
      );
      if (
        !raw ||
        typeof raw !== 'object' ||
        !Array.isArray((raw as { deliveries?: unknown }).deliveries)
      ) {
        setTriggerLogsState({
          status: 'error',
          message: '后端响应格式异常 — 当前 CDS 可能没有 GitHub webhook 投递日志过滤能力,请先更新 CDS。',
        });
        return;
      }
      const data = raw as {
        deliveries: GithubWebhookDelivery[];
        total?: number;
        filteredTotal?: number;
        hasMore?: boolean;
      };
      const deliveries = data.deliveries || [];
      const filteredTotal = typeof data.filteredTotal === 'number' ? data.filteredTotal : deliveries.length;
      setTriggerLogsState({
        status: 'ok',
        deliveries,
        total: typeof data.total === 'number' ? data.total : deliveries.length,
        filteredTotal,
        hasMore: typeof data.hasMore === 'boolean' ? data.hasMore : deliveries.length < filteredTotal,
      });
    } catch (err) {
      setTriggerLogsState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branch?.branch, branch?.githubRepoFullName, branchId]);

  const loadSystemLogs = useCallback(async () => {
    if (!branchId) return;
    const requestForBranch = branchId;
    setSystemLogsState({ status: 'loading' });
    try {
      const raw = await apiRequest<{ logs?: BranchActivityLog[] }>(
        `/api/branches/${encodeURIComponent(branchId)}/activity-logs?limit=100`,
      );
      // 切到别的分支后，慢响应不得覆盖新分支的时间线（Codex P1）。
      if (branchIdRef.current !== requestForBranch) return;
      setSystemLogsState({ status: 'ok', logs: Array.isArray(raw?.logs) ? raw.logs : [] });
    } catch (err) {
      if (branchIdRef.current !== requestForBranch) return;
      setSystemLogsState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branchId]);

  /**
   * 2026-05-14: 加载下一页 webhook 日志。state 必须已经是 ok，把后端返回的下一段
   * 追加到当前 deliveries 数组（保留时间顺序，最新在前）。
   */
  const loadMoreTriggerLogs = useCallback(async () => {
    if (!branchId) return;
    // 同步读 ref（由下方 useEffect 镜像 deliveries.length），不依赖 setState
    // updater 的执行时机；这才是这次 offset bug 的根因修复。
    const currentOffset = triggerLogsCountRef.current;
    if (currentOffset <= 0) return; // 还没有第一页，loadMore 无意义
    // 同步去重闸门：双击在 React commit loadingMore 前不会两次进入。
    if (triggerLogsLoadMoreInFlightRef.current) return;
    let proceed = true;
    setTriggerLogsState((prev) => {
      if (prev.status !== 'ok' || !prev.hasMore || prev.loadingMore) {
        proceed = false;
        return prev;
      }
      return { ...prev, loadingMore: true };
    });
    if (!proceed) return;
    triggerLogsLoadMoreInFlightRef.current = true;
    try {
      const params = new URLSearchParams();
      params.set('limit', String(TRIGGER_LOGS_PAGE_SIZE));
      params.set('offset', String(currentOffset));
      params.set('branchId', branchId);
      if (branch?.githubRepoFullName) params.set('repoFullName', branch.githubRepoFullName);
      if (branch?.branch) params.set('ref', `refs/heads/${branch.branch}`);
      const raw = await apiRequest<unknown>(
        `/api/cds-system/github/webhook-deliveries?${params.toString()}`,
      );
      const data = raw as {
        deliveries?: GithubWebhookDelivery[];
        total?: number;
        filteredTotal?: number;
        hasMore?: boolean;
      };
      const more = data.deliveries || [];
      setTriggerLogsState((prev) => {
        if (prev.status !== 'ok') return prev;
        const merged = [...prev.deliveries, ...more];
        const filteredTotal = typeof data.filteredTotal === 'number' ? data.filteredTotal : merged.length;
        return {
          status: 'ok',
          deliveries: merged,
          total: typeof data.total === 'number' ? data.total : prev.total,
          filteredTotal,
          hasMore: typeof data.hasMore === 'boolean' ? data.hasMore : merged.length < filteredTotal,
          loadingMore: false,
        };
      });
    } catch (err) {
      // 翻页失败保留前面已加载的部分，仅清掉 loading 旗，避免清掉整个列表。
      setTriggerLogsState((prev) => {
        if (prev.status !== 'ok') return prev;
        return { ...prev, loadingMore: false };
      });
      console.error('[trigger-logs] loadMore failed', err);
    } finally {
      triggerLogsLoadMoreInFlightRef.current = false;
    }
  }, [branch?.branch, branch?.githubRepoFullName, branchId]);

  // 2026-05-14 Codex review P2 修复配套：把 deliveries.length 镜像到 ref，
  // loadMore 时同步读取真实 offset，杜绝 React batch 导致的"重复拉第一页"。
  useEffect(() => {
    triggerLogsCountRef.current =
      triggerLogsState.status === 'ok' ? triggerLogsState.deliveries.length : 0;
  }, [triggerLogsState]);

  // 每个 drawer session 是否已经为"失败分支"自动跳过 tab。避免 branch 多次
  // load 时反复抢用户手动切的 tab。
  const failureAutoSwitchedRef = useRef(false);
  useEffect(() => {
    if (!open || !branchId) return;
    failureAutoSwitchedRef.current = false;
    setActiveTab(initialResourceId ? 'services' : 'deployments');
    setLogsMode('system');
    setSelectedBuildLog(null);
    setSelectedServiceId(null);
    setSelectedResourceId(initialResourceId || null);
    // 2026-05-14 Codex review P2：切到另一分支时必须清空内联容器日志的
    // 用户选择，否则 drawer 复用、且新分支有同名 profileId 时，旧分支选过
    // 的 profile 会粘住，deploymentLogProfileId 不再回退到新分支的
    // errored/running service。
    setSelectedDeploymentLogProfileId(null);
    setServiceLogs({ status: 'idle' });
    setLogQuery('');
    setShowAllHistory(false);
    setEnvState({ status: 'idle' });
    setProfileState({ status: 'loading' });
    setInfraServices([]);
    setResourceSnapshot([]);
    setModeSavingProfileId(null);
    setRevealedValues(new Map());
    setEnvQuery('');
    setBranchEnvEditorOpen(false);
    setMetricsState({ status: 'idle' });
    setTriggerLogsState({ status: 'idle' });
    setCopiedFailurePrompt(false);
    // Codex review P1：切换分支必须重置系统日志状态，否则 status 仍是 'ok'
    // 时 effect 不会重新拉取，UI 会把上一个分支的生命周期事件错挂到新分支。
    setSystemLogsState({ status: 'idle' });
    setMetricSeries({});
    lastMetricsTsRef.current = 0;
    lastMetricsByServiceRef.current = {};
    void load();
  }, [open, branchId, load]);

  useEffect(() => {
    if (!open || !initialResourceId) return;
    setActiveTab('services');
    setSelectedResourceId(initialResourceId);
  }, [open, initialResourceId]);

  // 失败分支默认开"日志"tab + 自动选中失败 service。
  // 用户痛点(2026-05-04):接班看到一个失败分支,drawer 默认"部署"tab(空),
  // 要再切 tab + 选 service 才看到 ERROR 日志。智能默认让 0 click 直接看错误。
  // 仅在每个 drawer session 第一次加载到失败状态时跳一次,之后用户切 tab 我们不抢。
  useEffect(() => {
    if (!open || !branch || failureAutoSwitchedRef.current) return;
    if (branch.status !== 'error') return;
    const failed = Object.values(branch.services || {}).find((s) => s.status === 'error');
    if (!failed?.profileId) return;
    failureAutoSwitchedRef.current = true;
    setActiveTab('logs');
    setLogsMode('container');
    setSelectedServiceId(failed.profileId);
  }, [open, branch]);

  // 失败诊断 lazy-load:status === 'error' 时拉一次。轮询不必要,失败状态稳定。
  useEffect(() => {
    if (!open || !branch || branch.status !== 'error' || !branchId) {
      setFailureDiag(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await apiRequest<{ failedServices?: Array<{
          profileId: string; tailLines?: string[]; errorCategory?: string;
          containerName?: string; errorHint?: string; responsibilitySide?: string;
        }> }>(`/api/branches/${encodeURIComponent(branchId)}/failure-diagnosis`);
        if (cancelled) return;
        setFailureDiag({
          failedServices: (r.failedServices || []).map((s) => ({
            profileId: s.profileId,
            containerName: s.containerName,
            tailLines: s.tailLines || [],
            errorCategory: s.errorCategory || 'unknown',
            errorHint: s.errorHint || '',
            responsibilitySide: (s.responsibilitySide as 'code' | 'config' | 'cds' | 'unknown') || 'unknown',
          })),
        });
      } catch {
        // 旧 CDS 没这个端点,静默不显示诊断面板
      }
    })();
    return () => { cancelled = true; };
  }, [open, branch?.status, branchId]);

  // Phase A — lazy-load effective env when the variables tab is opened.
  // Single fetch per drawer-open + tab-switch, no polling(env doesn't
  // change without an explicit Save in 项目设置)。
  const loadEnv = useCallback(async () => {
    if (!branchId) return;
    setEnvState({ status: 'loading' });
    try {
      const raw = await apiRequest<unknown>(
        `/api/branches/${encodeURIComponent(branchId)}/effective-env`,
      );
      // Defense(2026-05-04):API 可能因为旧版 CDS 没这个 endpoint 而被
      // legacy SPA fallback 当 200 + HTML 返回。apiRequest 解析失败时
      // 把 string 透传给我们,如果直接当对象用 → `.bySource` undefined → 崩。
      // 这里 shape-validate,失败提示用户「CDS 没这个 endpoint,需要更新」。
      if (
        !raw ||
        typeof raw !== 'object' ||
        !('variables' in raw) ||
        !Array.isArray((raw as { variables: unknown }).variables) ||
        !('bySource' in raw)
      ) {
        setEnvState({
          status: 'error',
          message: '后端响应格式异常 — 当前 CDS 可能没有 /api/branches/:id/effective-env 端点,请先 self-update CDS 到最新分支。',
        });
        return;
      }
      setEnvState({ status: 'ok', data: raw as EffectiveEnvResponse });
    } catch (err) {
      setEnvState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branchId]);

  useEffect(() => {
    if (activeTab === 'variables' && envState.status === 'idle') {
      void loadEnv();
    }
  }, [activeTab, envState.status, loadEnv]);

  useEffect(() => {
    if (activeTab !== 'logs' || !branch) return;
    if (logsMode === 'webhook' && triggerLogsState.status === 'idle') {
      void loadTriggerLogs();
    }
    if (logsMode === 'system' && systemLogsState.status === 'idle') {
      void loadSystemLogs();
    }
  }, [activeTab, logsMode, branch, loadTriggerLogs, triggerLogsState.status, loadSystemLogs, systemLogsState.status]);

  // Phase B — Metrics: 5s polling while metrics tab is active.
  // 关闭 tab 或抽屉就停止(useEffect 清理函数)。ring buffer 每点存:
  //   - cpu%(后端瞬时值,直接 push)
  //   - mem%(同上)
  //   - rxRate / txRate(后端给累计 bytes,前端 (curr - prev) / (ts - prevTs))
  // 第一次响应没有 prev,rxRate/txRate 入 0(占位避免锯齿状)。
  const loadMetrics = useCallback(async () => {
    if (!branchId) return;
    const requestForBranch: string = branchId;
    try {
      const raw = await apiRequest<unknown>(
        `/api/branches/${encodeURIComponent(branchId)}/metrics`,
      );
      // 切分支后旧请求可能才 resolve,直接丢弃避免污染新分支 ring buffer
      if (branchIdRef.current !== requestForBranch) return;
      if (
        !raw ||
        typeof raw !== 'object' ||
        !('services' in raw) ||
        !Array.isArray((raw as { services: unknown }).services)
      ) {
        setMetricsState({
          status: 'error',
          message: '后端响应格式异常 — 当前 CDS 可能没有 /api/branches/:id/metrics 端点,请先 self-update CDS 到最新分支。',
        });
        return;
      }
      const data = raw as MetricsResponse;
      setMetricsState({ status: 'ok', data });
      // 算 rate + 推 ring buffer
      const prevTs = lastMetricsTsRef.current;
      const prevByService = lastMetricsByServiceRef.current;
      setMetricSeries((prev) => {
        const next = { ...prev };
        const dt = prevTs > 0 ? (data.ts - prevTs) / 1000 : 0;
        for (const svc of data.services) {
          const series = next[svc.profileId] || { cpu: [], mem: [], rxRate: [], txRate: [] };
          const stats = svc.stats;
          if (!stats) {
            // 容器没在跑,push 0 占位让 sparkline 有连续 60 点
            next[svc.profileId] = pushRing(series, 0, 0, 0, 0);
            continue;
          }
          const lastStats = prevByService[svc.profileId];
          let rxRate = 0;
          let txRate = 0;
          if (lastStats && dt > 0) {
            rxRate = Math.max(0, (stats.netRxBytes - lastStats.netRxBytes) / dt);
            txRate = Math.max(0, (stats.netTxBytes - lastStats.netTxBytes) / dt);
          }
          next[svc.profileId] = pushRing(series, stats.cpuPercent, stats.memPercent, rxRate, txRate);
        }
        return next;
      });
      lastMetricsTsRef.current = data.ts;
      const lastMap: Record<string, ContainerStatsResponse> = {};
      for (const svc of data.services) {
        if (svc.stats) lastMap[svc.profileId] = svc.stats;
      }
      lastMetricsByServiceRef.current = lastMap;
    } catch (err) {
      // 同样保护:切分支后旧请求 reject 不要写到新 state
      if (branchIdRef.current !== requestForBranch) return;
      setMetricsState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [branchId]);

  useEffect(() => {
    if (activeTab !== 'metrics' || !branchId) return;
    // 立即拉一次,然后每 5s 轮询。docker stats 一次 ~300-800ms,5s 周期足够。
    // Bugbot PR #524 第七轮反馈:把 loadMetrics 加入 deps,避免未来给
    // loadMetrics 加新依赖时 setInterval 静默捕获 stale 闭包。loadMetrics 自身
    // 用 useCallback([branchId]) 记忆,branchId 不变时引用稳定 → 不会循环。
    // metricsState.status 只在 idle 时一次性切到 loading,branchIdRef 已防止
    // 切分支后旧 in-flight 请求污染新分支(Round 4 落地)。
    setMetricsState((s) => (s.status === 'idle' ? { status: 'loading' } : s));
    void loadMetrics();
    const timer = window.setInterval(() => void loadMetrics(), 5000);
    return () => window.clearInterval(timer);
  }, [activeTab, branchId, loadMetrics]);

  // Phase C — Settings tab actions(2026-05-04)
  // 直接 reuse 现有 endpoints,不引入新 backend 路径。delete 成功后自动关抽屉,
  // 其它操作完成后重新拉一次 branch 详情(让"运行中"状态及时更新)。
  const runBranchAction = useCallback(async (
    action: 'deploy' | 'restart' | 'pull' | 'stop' | 'reset' | 'delete',
    label: string,
  ): Promise<void> => {
    if (!branchId) return;
    const actionBranchId = branchId;
    setActionBusy({ branchId: actionBranchId, action });
    try {
      const path = `/api/branches/${encodeURIComponent(branchId)}` + (
        action === 'delete' ? '' : `/${action}`
      );
      const method = action === 'delete' ? 'DELETE' : 'POST';
      await apiRequest(path, { method });
      onToast?.(`${label} 已提交`);
      onActionComplete?.(action);
      if (action === 'delete') {
        onClose();
      } else {
        // 立刻重拉详情(deploy/pull 是异步的,状态会变成 building/pulling)
        void load();
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      onToast?.(`${label} 失败:${message}`);
    } finally {
      setActionBusy((current) => (
        current?.branchId === actionBranchId && current.action === action ? null : current
      ));
    }
  }, [branchId, onToast, onActionComplete, onClose, load]);

  const setProfileDeployMode = useCallback(async (profile: ProfileRow, mode: string): Promise<void> => {
    if (!branchId) return;
    setModeSavingProfileId(profile.profileId);
    try {
      const next: BuildProfileOverride = { ...(profile.override || {}) };
      next.activeDeployMode = mode;
      const compacted = compactProfileOverride(next);
      if (!hasProfileOverrideFields(compacted)) {
        await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/profile-overrides/${encodeURIComponent(profile.profileId)}`, {
          method: 'DELETE',
        });
      } else {
        await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/profile-overrides/${encodeURIComponent(profile.profileId)}`, {
          method: 'PUT',
          body: compacted,
        });
      }
      onToast?.('已切换本分支运行模式，正在重新部署本分支');
      await apiRequest(`/api/branches/${encodeURIComponent(branchId)}/deploy`, {
        method: 'POST',
      });
      await load();
      onActionComplete?.('deploy');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      onToast?.(`切换运行模式或重新部署失败:${message}`);
    } finally {
      setModeSavingProfileId(null);
    }
  }, [branchId, load, onActionComplete, onToast]);

  const loadServiceLogs = useCallback(async (profileId: string) => {
    if (!branchId) return;
    setSelectedServiceId(profileId);
    setServiceLogs({ status: 'loading', profileId });
    try {
      const res = await apiRequest<{ logs: string }>(`/api/branches/${encodeURIComponent(branchId)}/container-logs`, {
        method: 'POST',
        body: { profileId },
      });
      setServiceLogs({ status: 'ok', profileId, logs: res.logs || '' });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setServiceLogs({ status: 'error', profileId, message });
    }
  }, [branchId]);

  const refreshCurrentPanel = useCallback(async () => {
    if (!branchId || headerRefreshing) return;
    setHeaderRefreshing(true);
    try {
      await load();
      if (activeTab === 'logs') {
        if (logsMode === 'system') {
          await loadSystemLogs();
        } else if (logsMode === 'webhook') {
          await loadTriggerLogs();
        } else if (logsMode === 'container' && selectedServiceId) {
          await loadServiceLogs(selectedServiceId);
        }
      } else if (activeTab === 'variables') {
        await loadEnv();
      } else if (activeTab === 'metrics') {
        await loadMetrics();
      }
      onToast?.('已刷新当前分支面板');
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      onToast?.(`刷新失败:${message}`);
    } finally {
      setHeaderRefreshing(false);
    }
  }, [
    activeTab,
    branchId,
    headerRefreshing,
    load,
    loadEnv,
    loadMetrics,
    loadServiceLogs,
    loadSystemLogs,
    loadTriggerLogs,
    logsMode,
    onToast,
    selectedServiceId,
  ]);

  const visibleDeployments = useMemo(() => {
    const scoped = deployments.filter((item) => item.branchId === branchId);
    return scoped.sort((left, right) => right.startedAt - left.startedAt);
  }, [branchId, deployments]);

  const combinedDeployments = useMemo<BranchDeploymentItem[]>(() => {
    if (!branchId) return visibleDeployments;
    const legacy = logs
      .slice()
      .reverse()
      .slice(0, 6)
      .map((log) => legacyLogToDeploymentItem(log, branchId));
    const all = [...visibleDeployments, ...legacy];
    const sorted = all.sort((left, right) => right.startedAt - left.startedAt);
    return sorted.map((item, index) => {
      if (!item.runtimeStartedAt) return item;
      const newer = index > 0 ? sorted[index - 1] : null;
      const stoppedAt = branch?.lastStoppedAt ? new Date(branch.lastStoppedAt).getTime() : undefined;
      const runtimeEndedAt = newer?.startedAt && newer.startedAt > item.runtimeStartedAt
        ? newer.startedAt
        : stoppedAt && stoppedAt > item.runtimeStartedAt
          ? stoppedAt
          : undefined;
      return runtimeEndedAt ? { ...item, runtimeEndedAt } : item;
    });
  }, [branch?.lastStoppedAt, branchId, visibleDeployments, logs]);

  const activeDeployment = useMemo(
    () => pickActiveDeployment(combinedDeployments, now),
    [combinedDeployments, now],
  );

  const historyDeployments = useMemo<BranchDeploymentItem[]>(() => {
    if (!activeDeployment) return combinedDeployments;
    return combinedDeployments.filter((item) => item.key !== activeDeployment.key);
  }, [activeDeployment, combinedDeployments]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  const services = branch ? Object.values(branch.services || {}) : [];
  const resourceProfiles = useMemo<BranchResourceProfileInput[]>(() => (
    profileState.status === 'ok'
      ? profileState.profiles.map((profile) => ({
        id: profile.profileId,
        name: profile.profileName,
        dockerImage: profile.effective?.dockerImage,
        command: profile.effective?.command,
        containerPort: profile.effective?.containerPort,
        pathPrefixes: profile.effective?.pathPrefixes,
        dependsOn: profile.effective?.dependsOn,
      }))
      : []
  ), [profileState]);
  const resources = useMemo<BranchResource[]>(() => {
    if (!branch) return [];
    if (resourceSnapshot.length > 0) return resourceSnapshot;
    if (branch.resources && branch.resources.length > 0) return branch.resources;
    return buildBranchResources({
      branchId: branch.id,
      branchName: branch.branch,
      services: branch.services || {},
      profiles: resourceProfiles,
      infraServices,
      previewUrl,
    });
  }, [branch, infraServices, previewUrl, resourceProfiles, resourceSnapshot]);
  const selectedResource = resources.find((resource) => resource.id === selectedResourceId) || resources[0] || null;
  const selectedService = services.find((svc) => svc.profileId === selectedServiceId) || services[0] || null;

  useEffect(() => {
    if (!open || activeTab !== 'services') return;
    if (!initialResourceId || !selectedResource || selectedResource.id !== initialResourceId || selectedResource.source !== 'app') return;
    const raw = selectedResource.raw as ServiceState;
    if (!raw.profileId || serviceLogs.profileId === raw.profileId) return;
    void loadServiceLogs(raw.profileId);
  }, [activeTab, initialResourceId, loadServiceLogs, open, selectedResource?.id, selectedResource?.source, serviceLogs.profileId]);

  const fullPageHref = `/branch-panel/${encodeURIComponent(branchId || '')}?project=${encodeURIComponent(projectId)}`;
  const githubPrHref = branch?.githubRepoFullName && branch.githubPrNumber
    ? githubPullRequestUrl(branch.githubRepoFullName, branch.githubPrNumber)
    : '';
  const githubBranchHref = branch?.githubRepoFullName
    ? githubBranchTreeUrl(branch.githubRepoFullName, branch.branch)
    : '';
  const currentFailureReason = branch ? branchFailureReason(branch) : '';
  const copyFailurePrompt = useCallback(async () => {
    if (!branch) return;
    const text = buildLlmFailurePrompt(branch, currentFailureReason, failureDiag?.failedServices || []);
    try {
      await copyTextToClipboard(text);
      setCopiedFailurePrompt(true);
      window.setTimeout(() => setCopiedFailurePrompt(false), 1800);
    } catch {
      setCopiedFailurePrompt(false);
    }
  }, [branch, currentFailureReason, failureDiag]);
  const visibleActivityEvents = useMemo(() => {
    if (!branch) return [];
    return activityEvents
      .filter((event) => (
        event.type === 'web' &&
        (event.branchId === branch.id || (selectedService?.profileId && event.profileId === selectedService.profileId))
      ))
      .slice(-80)
      .reverse();
  }, [activityEvents, branch, selectedService?.profileId]);

  // Container logs are loaded only when a visible log surface needs them:
  // the active deployment card, container-log tab, service selector,
  // maximize, or refresh. Do not poll in the background.

  // 部署 tab 内联容器日志只在该 tab 可见时读取一次默认服务日志；
  // 不做后台轮询，也不在其它 tab 预取。
  const activeDeploymentPhases = useMemo(() => {
    if (!activeDeployment) return null;
    return deriveBranchPhases(
      activeDeployment.log,
      activeDeployment.status,
      currentFailureReason || activeDeployment.message,
    );
  }, [activeDeployment, currentFailureReason]);

  const failedPhaseKey: PhaseKey | null = useMemo(() => {
    return activeDeploymentPhases?.find((p) => p.status === 'error')?.key ?? null;
  }, [activeDeploymentPhases]);

  /**
   * 2026-05-14: 部署 tab 内联容器日志的多容器选择。null = 让自动逻辑挑（错误/运行中/启动中）。
   * 用户在 tab strip 上点击其他 service 后会写入这里，覆盖自动逻辑。
   */
  const [selectedDeploymentLogProfileId, setSelectedDeploymentLogProfileId] = useState<string | null>(null);
  const autoDeploymentLogProfileId = useMemo(() => {
    if (!services.length) return null;
    const errored = services.find((s) => s.status === 'error');
    const running = services.find((s) => s.status === 'running');
    const starting = services.find((s) => s.status === 'starting');
    return errored?.profileId || running?.profileId || starting?.profileId || services[0].profileId;
  }, [services]);
  const deploymentLogProfileId = useMemo(() => {
    // 用户选过 → 校验该 service 还在；不在了 fallback 自动选择。
    if (selectedDeploymentLogProfileId && services.some((s) => s.profileId === selectedDeploymentLogProfileId)) {
      return selectedDeploymentLogProfileId;
    }
    return autoDeploymentLogProfileId;
  }, [autoDeploymentLogProfileId, selectedDeploymentLogProfileId, services]);

  useEffect(() => {
    if (!open || activeTab !== 'deployments' || !activeDeployment || !deploymentLogProfileId) return;
    if (serviceLogs.profileId === deploymentLogProfileId && serviceLogs.status !== 'idle') return;
    void loadServiceLogs(deploymentLogProfileId);
  }, [
    activeDeployment,
    activeTab,
    deploymentLogProfileId,
    loadServiceLogs,
    open,
    serviceLogs.profileId,
    serviceLogs.status,
  ]);

  /**
   * 2026-05-14: 内联容器日志的 tab strip + 最大化控制。
   * 多于 1 个 service 时 PhaseTree 会渲染 tab 条。最大化 → 跳到 Logs tab 容器模式。
   */
  const inlineContainerLogControls = useMemo(() => {
    if (services.length === 0) return undefined;
    return {
      services: services.map((svc) => ({
        profileId: svc.profileId,
        status: svc.status,
        hostPort: svc.hostPort,
      })),
      selected: deploymentLogProfileId,
      onSelect: (profileId: string) => {
        setSelectedDeploymentLogProfileId(profileId);
        void loadServiceLogs(profileId);
      },
      onMaximize: () => {
        if (deploymentLogProfileId) {
          // 复用 openContainerLogs 的跳转逻辑
          setLogsMode('container');
          setActiveTab('logs');
          void loadServiceLogs(deploymentLogProfileId);
        }
      },
    };
  }, [deploymentLogProfileId, loadServiceLogs, services]);

  const containerLogsByPhase = useMemo<Partial<Record<PhaseKey, PhaseLogState>> | undefined>(() => {
    if (!activeDeployment) return undefined;
    if (!deploymentLogProfileId) return undefined;
    const diagnostic =
      failureDiag?.failedServices.find((item) => item.profileId === deploymentLogProfileId) ||
      failureDiag?.failedServices.find((item) => item.tailLines.length > 0);
    const state: PhaseLogState | null =
      serviceLogs.profileId === deploymentLogProfileId
        ? serviceLogs.status === 'ok'
          ? { status: 'ok', logs: serviceLogs.logs || '' }
          : serviceLogs.status === 'error'
            ? { status: 'error', message: serviceLogs.message }
            : { status: 'loading' }
        : diagnostic && diagnostic.tailLines.length > 0
          ? { status: 'ok', logs: diagnostic.tailLines.join('\n') }
          : null;
    if (!state) return undefined;
    const phaseKeys = new Set((activeDeploymentPhases || []).map((phase) => phase.key));
    const preferredPhase: PhaseKey = failedPhaseKey || 'deploy';
    const targetPhase: PhaseKey = phaseKeys.has(preferredPhase)
      ? preferredPhase
      : phaseKeys.has('deploy')
        ? 'deploy'
        : activeDeploymentPhases?.[0]?.key || 'deploy';
    return { [targetPhase]: state };
  }, [activeDeployment, activeDeploymentPhases, deploymentLogProfileId, failedPhaseKey, failureDiag, serviceLogs]);

  const openBuildLogs = useCallback((selection?: BuildLogSelection) => {
    setSelectedBuildLog(selection || null);
    setLogsMode('build');
    setActiveTab('logs');
  }, []);

  const openDeploymentBuildLogs = useCallback((deployment: BranchDeploymentItem) => {
    openBuildLogs({
      title: `${deployment.branchName} / ${deploymentKindLabel(deployment.kind)}`,
      status: deployment.status,
      commitSha: deployment.commitSha,
      startedAt: deployment.startedAt,
      message: deployment.message,
      lines: deployment.log.length > 0 ? deployment.log : [deployment.lastStep || deployment.message],
    });
  }, [openBuildLogs]);

  const copyDeploymentDiagnosis = useCallback(async (deployment: BranchDeploymentItem) => {
    const lines = [
      `分支：${deployment.branchName || branch?.branch || ''}`,
      `状态：${deployment.status}`,
      deployment.commitSha ? `Commit：${deployment.commitSha.slice(0, 7)}` : '',
      deployment.message ? `摘要：${deployment.message}` : '',
      '',
      ...(deployment.log || []).slice(-40),
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
    } catch {
      // ignore — clipboard 可能在沙箱环境下不可用
    }
  }, [branch]);

  const openContainerLogs = useCallback((profileId?: string) => {
    const target = profileId || selectedService?.profileId;
    setLogsMode('container');
    setActiveTab('logs');
    if (target) {
      void loadServiceLogs(target);
    }
  }, [loadServiceLogs, selectedService?.profileId]);

  const openFailureLogs = useCallback((profileId?: string) => {
    openContainerLogs(profileId);
    window.requestAnimationFrame(() => {
      logsSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [openContainerLogs]);

  useEffect(() => {
    if (!open) return undefined;
    document.body.dataset.cdsBranchDrawerOpen = 'true';
    return () => {
      delete document.body.dataset.cdsBranchDrawerOpen;
    };
  }, [open]);

  if (!open || !branchId) return null;

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="分支详情">
      <button
        type="button"
        className="absolute inset-0 z-0 bg-transparent"
        onClick={onClose}
        aria-label="关闭分支详情"
      />
      <div
        className="cds-branch-detail-drawer cds-drawer-anim relative z-10 ml-auto flex h-full w-full max-w-[min(1240px,calc(100vw-32px))] flex-col border-l border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] shadow-2xl"
        style={{ minHeight: 0 }}
      >
        <header className="cds-branch-detail-header flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 whitespace-nowrap text-sm font-semibold">分支详情</span>
            {branch ? (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span className="min-w-0 truncate whitespace-nowrap font-mono text-xs">{branch.branch}</span>
              </>
            ) : null}
          </div>
          <div className="cds-branch-detail-header-actions flex shrink-0 items-center gap-1">
            {githubPrHref ? (
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="text-violet-600 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-300 dark:hover:text-violet-200"
                title={`打开 GitHub PR #${branch?.githubPrNumber}`}
                aria-label="打开 GitHub PR"
              >
                <a href={githubPrHref} target="_blank" rel="noreferrer">
                  <GitPullRequest />
                </a>
              </Button>
            ) : (
              <Button variant="ghost" size="icon" disabled title="没有关联 GitHub PR" aria-label="没有关联 GitHub PR">
                <GitPullRequest />
              </Button>
            )}
            {githubBranchHref ? (
              <Button
                asChild
                variant="ghost"
                size="icon"
                className="text-sky-600 hover:bg-sky-500/10 hover:text-sky-700 dark:text-sky-300 dark:hover:text-sky-200"
                title="打开 GitHub 分支"
                aria-label="打开 GitHub 分支"
              >
                <a href={githubBranchHref} target="_blank" rel="noreferrer">
                  <GitBranch />
                </a>
              </Button>
            ) : (
              <Button variant="ghost" size="icon" disabled title="没有关联 GitHub 分支" aria-label="没有关联 GitHub 分支">
                <GitBranch />
              </Button>
            )}
            <Button asChild variant="ghost" size="sm" title="打开分支详情页">
              <a href={fullPageHref}>
                <ExternalLink />
                详情页
              </a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refreshCurrentPanel()}
              disabled={headerRefreshing}
              title={headerRefreshing ? '正在刷新当前面板' : '刷新当前面板'}
              aria-label={headerRefreshing ? '正在刷新当前面板' : '刷新当前面板'}
            >
              <RefreshCw className={headerRefreshing ? 'animate-spin' : undefined} />
              {headerRefreshing ? '刷新中' : '刷新'}
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} title="关闭" aria-label="关闭">
              <X />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto pb-24" style={{ overscrollBehavior: 'contain' }}>
          {loading && !branch ? <BranchDetailLoadingSkeleton className="min-h-full" /> : null}
          {error ? <div className="p-5"><ErrorBlock message={error} /></div> : null}
          {branch ? (
            <>
              {branch.status === 'running' && branch.previewUrl ? (
                <div className="mx-5 mt-4 flex flex-col gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                      <Rocket className="h-4 w-4" />
                      应用已上线
                    </div>
                    <a
                      href={branch.previewUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 block min-w-0 truncate font-mono text-xs text-emerald-700/90 hover:underline dark:text-emerald-300"
                    >
                      {branch.previewUrl}
                    </a>
                  </div>
                  <Button asChild size="sm" className="shrink-0 bg-emerald-600 text-white hover:bg-emerald-700">
                    <a href={branch.previewUrl} target="_blank" rel="noreferrer">
                      <ExternalLink />
                      打开预览
                    </a>
                  </Button>
                </div>
              ) : null}
              <section className="border-b border-[hsl(var(--hairline))] px-5 py-4">
                {(() => {
                  const origin = branchOriginInsight(branch);
                  const recoveredRuntimeWithoutDeployLog =
                    branch.status === 'running' && !branch.lastDeployAt && Boolean(branch.lastReadyAt || branch.lastAccessedAt);
                  const displayedDeployCount = Math.max(branch.deployCount || 0, recoveredRuntimeWithoutDeployLog ? 1 : 0);
                  return (
                    <div className="mb-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/55 px-3 py-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className={`rounded border px-2 py-0.5 text-xs font-medium ${origin.className}`}>
                          {origin.label}
                        </span>
                        <span className="min-w-0 truncate text-xs text-muted-foreground">{origin.summary}</span>
                      </div>
                      <div className="mt-1 grid gap-1 text-[11px] leading-5 text-muted-foreground sm:grid-cols-3">
                        <span>
                          最近推送：{formatDeployTimestamp(branch.lastPushAt)}
                        </span>
                        <span>
                          最近部署：{formatDeployTimestamp(
                            branch.lastDeployAt,
                          )}
                        </span>
                        <span>部署次数：{displayedDeployCount}{recoveredRuntimeWithoutDeployLog ? '（运行态恢复）' : ''} · 停止次数：{branch.stopCount || 0}</span>
                      </div>
                      {/*
                        2026-05-14：分支变灰时把"何时停 / 为什么停"亮出来。
                        没有 lastStoppedAt 的老分支显示 - 即可，不破坏 layout。
                      */}
                      {/*
                        2026-05-14 Cursor Bugbot Medium：lastStoppedAt 是历史
                        戳，分支被 stop 后又经 deploy/auto-build/调度器唤醒
                        重新 running 时该戳仍在 → 不能只看 lastStoppedAt
                        就弹"上次停止"，否则正在运行的分支被误报已停止。
                        只在分支当前确实非活跃（非 running/构建/启动中）时显示。
                      */}
                      {branch.lastStoppedAt &&
                      !['running', 'building', 'starting', 'restarting'].includes(branch.status) ? (
                        <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-5 text-amber-800 dark:text-amber-200">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">上次停止</span>
                            <span className="opacity-90">{formatDeployTimestamp(branch.lastStoppedAt)}</span>
                            {branch.lastStopSource ? (
                              <span className="rounded border border-amber-500/40 px-1.5 py-0.5">
                                {branch.lastStopSource === 'user' ? '用户'
                                  : branch.lastStopSource === 'scheduler' ? '调度器'
                                  : branch.lastStopSource === 'executor' ? '执行器'
                                  : branch.lastStopSource === 'cds' ? 'CDS'
                                  : branch.lastStopSource === 'oom' ? 'OOM'
                                  : branch.lastStopSource === 'external' ? '外部'
                                  : branch.lastStopSource === 'crash' ? '崩溃'
                                  : '系统'}
                              </span>
                            ) : null}
                          </div>
                          <div className="opacity-95">{branch.lastStopReason || '原因未记录'}</div>
                        </div>
                      ) : null}
                    </div>
                  );
                })()}
                <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35 px-3 py-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className={`rounded border px-2 py-0.5 text-xs ${statusClass(branch.status)}`}>{statusLabel(branch.status)}</span>
                    {branch.commitSha ? <span className="font-mono text-xs text-muted-foreground">{branch.commitSha.slice(0, 7)}</span> : null}
                    <span className="text-xs text-muted-foreground">服务 {services.filter((svc) => svc.status === 'running').length}/{services.length}</span>
                    {branch.subject ? (
                      <span className="min-w-[220px] flex-1 truncate text-sm leading-6 text-muted-foreground" title={branch.subject}>
                        {branch.subject}
                      </span>
                    ) : null}
                  </div>
                  {/*
                    Production URL chip (Week 4.8 Round 4b, 用户主诉求"运行中
                    绿点旁边没有 URL"):running 时显眼显示 production 域名,
                    hover 出复制按钮,点击在新窗口打开。失败/未运行时不渲染。
                  */}
                  {(branch.status === 'running' || branchStatus === 'running') && previewUrl ? (
                    <PreviewUrlChip url={previewUrl} />
                  ) : null}
                </div>
                {currentFailureReason ? (
                  <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-semibold">最近失败原因</div>
                      <button
                        type="button"
                        onClick={() => void copyFailurePrompt()}
                        className={`inline-flex h-7 items-center gap-1.5 rounded-md border border-destructive/45 bg-destructive/15 px-2 text-[11px] font-semibold text-destructive transition-colors hover:bg-destructive/25 ${
                          copiedFailurePrompt ? '' : 'animate-pulse'
                        }`}
                        title="复制错误上下文和大模型修复提示词"
                      >
                        <Copy className="h-3.5 w-3.5" />
                        {copiedFailurePrompt ? '已复制' : '复制到大模型'}
                      </button>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-destructive/90">{currentFailureReason}</div>
                    {failureDiag && failureDiag.failedServices.length > 0 ? (
                      <div className="mt-2 space-y-2 border-t border-destructive/20 pt-2">
                        {failureDiag.failedServices.map((diag) => {
                          const keyLines = failureKeyLogLines(diag.tailLines);
                          return (
                          <div key={diag.profileId} className="space-y-1.5">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="rounded border border-destructive/40 bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium uppercase">
                                {diag.profileId}
                              </span>
                              <span className="rounded border border-destructive/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                                {diag.errorCategory.replace('-', ' ')}
                              </span>
                              <span className="rounded px-1.5 py-0.5 text-[10px] font-medium" style={{
                                background: diag.responsibilitySide === 'cds' ? 'rgba(245,158,11,0.15)'
                                  : diag.responsibilitySide === 'code' ? 'rgba(239,68,68,0.15)'
                                  : diag.responsibilitySide === 'config' ? 'rgba(59,130,246,0.15)'
                                  : 'rgba(156,163,175,0.15)',
                                color: diag.responsibilitySide === 'cds' ? '#f59e0b'
                                  : diag.responsibilitySide === 'code' ? '#ef4444'
                                  : diag.responsibilitySide === 'config' ? '#3b82f6'
                                  : '#9ca3af',
                              }}>
                                {diag.responsibilitySide === 'cds' ? 'CDS 侧'
                                  : diag.responsibilitySide === 'code' ? '代码侧'
                                  : diag.responsibilitySide === 'config' ? '配置侧'
                                  : '未识别'}
                              </span>
                            </div>
                            {diag.errorHint && !isGenericFailureHint(diag.errorHint) ? (
                              <div className="text-destructive/90">{diag.errorHint}</div>
                            ) : null}
                            {keyLines.length > 0 ? (
                              <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded border border-destructive/20 bg-[hsl(var(--surface-sunken))] px-2 py-1 font-mono text-[10px] leading-4 text-foreground/85">
                                {keyLines.join('\n')}
                              </pre>
                            ) : null}
                          </div>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => {
                            const first = failureDiag.failedServices[0];
                            openFailureLogs(first?.profileId);
                          }}
                          className="inline-flex items-center gap-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/20"
                        >
                          打开容器日志 →
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {/* 未运行 / 已停止但没有错误时,给一句中性的"还没起来 / 已停"
                    提示 + 引导用户走底部「重新部署」。否则截图里只有一个"未运行"
                    chip,既看不到原因也找不到启动入口,体验割裂(用户反馈
                    2026-05-07 "停止的莫名其妙,没有停止原因,也没有启动按钮")。 */}
                {!currentFailureReason && (branch.status === 'idle' || branch.status === 'stopped') ? (
                  <div className="mt-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs leading-5 text-muted-foreground">
                    <div className="font-semibold text-foreground">服务未运行</div>
                    <div className="mt-1">
                      {idleBranchExplanation(branch)}
                    </div>
                  </div>
                ) : null}
              </section>

              <nav className="cds-branch-detail-tabs sticky top-0 z-10 flex gap-1 overflow-x-auto border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-3">
                {drawerTabs.map((tab) => (
                  <DrawerTabButton key={tab.key} tab={tab} active={activeTab === tab.key} onClick={() => setActiveTab(tab.key)} />
                ))}
              </nav>

              <div className="p-5">
                {activeTab === 'deployments' ? (
                  <div className="space-y-4">
                    {!activeDeployment && historyDeployments.length === 0 ? (
                      <section className="cds-surface-raised cds-hairline rounded-md border border-dashed border-[hsl(var(--hairline))] px-4 py-8 text-center text-sm text-muted-foreground">
                        还没有构建记录。点击部署后，构建计划和日志会出现在这里。
                      </section>
                    ) : null}

                    {activeDeployment ? (
                      <ActiveDeployment
                        deployment={activeDeployment}
                        branchErrorMessage={currentFailureReason || undefined}
                        now={now}
                        onOpenLogs={openDeploymentBuildLogs}
                        onCopyDiagnosis={(item) => void copyDeploymentDiagnosis(item)}
                        containerLogsByPhase={containerLogsByPhase}
                        containerLogControls={inlineContainerLogControls}
                      />
                    ) : null}

                    {historyDeployments.length > 0 ? (
                      <section>
                        <header className="mb-2 flex items-center justify-between gap-3 px-1">
                          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            历史 · {historyDeployments.length}
                          </h4>
                          {historyDeployments.length > 5 ? (
                            <button
                              type="button"
                              className="text-xs text-primary hover:underline"
                              onClick={() => setShowAllHistory((value) => !value)}
                            >
                              {showAllHistory ? '收起' : '显示全部'}
                            </button>
                          ) : null}
                        </header>
                        <div className="space-y-2">
                          {(showAllHistory ? historyDeployments : historyDeployments.slice(0, 5)).map((item) => (
                            <HistoryRow
                              key={item.key}
                              deployment={item}
                              onOpenLogs={openDeploymentBuildLogs}
                            />
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </div>
                ) : null}

                {activeTab === 'logs' ? (
                  <section ref={logsSectionRef} className="cds-surface-raised cds-hairline">
                    <header className="border-b border-[hsl(var(--hairline))] px-4 py-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="inline-flex flex-wrap rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] p-1">
                          {([
                            ['system', '系统日志'],
                            ['build', '构建日志'],
                            ['container', '容器日志'],
                            ['webhook', 'Webhook'],
                            ['http', 'HTTP'],
                          ] as Array<[LogsMode, string]>).map(([mode, label]) => (
                            <button
                              key={mode}
                              type="button"
                              className={`h-8 rounded px-3 text-xs transition-colors ${logsMode === mode ? 'bg-[hsl(var(--surface-raised))] text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
                              onClick={() => {
                                if (mode === 'container') { openContainerLogs(); return; }
                                if (mode === 'build') setSelectedBuildLog(null);
                                setLogsMode(mode);
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <div className="flex min-w-0 items-center gap-2">
                          <input
                            className="h-8 w-52 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 text-xs outline-none placeholder:text-muted-foreground focus:border-primary"
                            value={logQuery}
                            onChange={(event) => setLogQuery(event.target.value)}
                            placeholder="Filter logs"
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              if (logsMode === 'system') return void loadSystemLogs();
                              if (logsMode === 'webhook') return void loadTriggerLogs();
                              if (logsMode === 'build' || logsMode === 'http') return void load();
                              if (selectedService) void loadServiceLogs(selectedService.profileId);
                            }}
                          >
                            <RefreshCw />
                            刷新
                          </Button>
                        </div>
                      </div>
                    </header>
                    {logsMode === 'system' ? (
                      <SystemLogsPanel state={systemLogsState} query={logQuery} />
                    ) : logsMode === 'webhook' ? (
                      <TriggerLogsPanel
                        state={triggerLogsState}
                        query={logQuery}
                        branch={branch}
                        onLoadMore={() => void loadMoreTriggerLogs()}
                      />
                    ) : logsMode === 'http' ? (
                      <HttpLogsPanel events={visibleActivityEvents} query={logQuery} />
                    ) : logsMode === 'build' ? (
                      <BuildLogsPanel logs={logs} query={logQuery} selection={selectedBuildLog} />
                    ) : (
                      <>
                        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3">
                          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
                            {(services.length > 0 ? services : []).map((svc) => (
                              <button
                                key={svc.profileId}
                                type="button"
                                className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-md border px-3 text-xs transition-colors ${
                                  selectedService?.profileId === svc.profileId
                                    ? 'border-primary bg-primary/10 text-foreground'
                                    : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 text-muted-foreground hover:text-foreground'
                                }`}
                                onClick={() => openContainerLogs(svc.profileId)}
                              >
                                <span className={`h-1.5 w-1.5 rounded-full ${svc.status === 'running' ? 'bg-emerald-500' : svc.status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40'}`} />
                                {svc.profileId}
                                <span className="font-mono">:{svc.hostPort || '?'}</span>
                              </button>
                            ))}
                          </div>
                          <CopyServiceLogsButton service={selectedService} state={filterServiceLogs(serviceLogs, logQuery)} />
                        </div>
                        <ServiceLogsPanel service={selectedService} state={filterServiceLogs(serviceLogs, logQuery)} />
                      </>
                    )}
                  </section>
                ) : null}

                {activeTab === 'services' ? (
                  <ResourceConsole
                    resources={resources}
                    selectedResource={selectedResource}
                    initialDetailTab={initialResourceDetailTab}
                    serviceLogs={serviceLogs}
                    branchName={branch.branch}
                    onSelect={(resource) => {
                      setSelectedResourceId(resource.id);
                      if (resource.source === 'app') {
                        const raw = resource.raw as ServiceState;
                        void loadServiceLogs(raw.profileId);
                      }
                    }}
                    onOpenLogs={(resource) => {
                      if (resource.source !== 'app') return;
                      const raw = resource.raw as ServiceState;
                      openContainerLogs(raw.profileId);
                    }}
                    onInfraAction={async (resource, action) => {
                      if (resource.source !== 'infra') return;
                      const raw = resource.raw as BranchResourceInfraInput;
                      await apiRequest(`/api/infra/${encodeURIComponent(raw.id)}/${action}?project=${encodeURIComponent(projectId)}`, { method: 'POST' });
                      onToast?.(`${resource.runtime} 已${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}`);
                      void load();
                    }}
                    onExternalAccess={async (resource, input) => {
                      await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}/resources/${encodeURIComponent(resource.id)}/external-access`, {
                        method: 'PUT',
                        body: input,
                      });
                      onToast?.(`${resource.runtime} 外部访问已${input.enabled ? '开启' : '关闭'}`);
                      void load();
                    }}
                    onCreateCloneTask={async (resource, input) => {
                      await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}/resources/${encodeURIComponent(resource.id)}/clone-tasks`, {
                        method: 'POST',
                        body: input,
                      });
                      onToast?.(`${resource.runtime} ${input.mode === 'empty' ? '分支空库' : input.mode === 'connect-existing' ? '外部连接' : '克隆/恢复'}任务已创建`);
                      void load();
                    }}
                    onResetCredentials={async (resource, confirmResourceName) => {
                      await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}/resources/${encodeURIComponent(resource.id)}/credentials/reset`, {
                        method: 'POST',
                        body: { confirmResourceName },
                      });
                      onToast?.(`${resource.runtime} 凭据已重置，依赖应用需要重新部署`);
                      void load();
                    }}
                    onInjectConnection={async (resource) => {
                      const targetResourceIds = resources
                        .filter((item) => item.source === 'app' && (resource.consumers || []).includes(item.serviceName))
                        .map((item) => item.id);
                      await apiRequest(`/api/branches/${encodeURIComponent(branch.id)}/resources/${encodeURIComponent(resource.id)}/inject-connection`, {
                        method: 'POST',
                        body: { targetResourceIds },
                      });
                      onToast?.(`${resource.runtime} 连接变量已注入依赖应用，重新部署后生效`);
                      void load();
                    }}
                    onCopy={async (value) => {
                      await navigator.clipboard.writeText(value);
                      onToast?.('已复制');
                    }}
                  />
                ) : null}

                {activeTab === 'overview' ? (
                  <section className="cds-surface-raised cds-hairline px-5 py-4">
                    <div className="grid gap-3 text-sm">
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">分支</span>
                        <span className="min-w-0 truncate font-mono">{branch.branch}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">提交</span>
                        <span className="font-mono">{branch.commitSha?.slice(0, 7) || '-'}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">状态</span>
                        <span>{statusLabel(branch.status)}</span>
                      </div>
                    </div>
                  </section>
                ) : null}

                {activeTab === 'variables' ? (
                  <VariablesPanel
                    state={envState}
                    revealedValues={revealedValues}
                    onToggleReveal={async (k) => {
                      // 已 revealed → 折叠回 mask;未 revealed → 调端点拉明文
                      if (revealedValues.has(k)) {
                        setRevealedValues((cur) => {
                          const next = new Map(cur);
                          next.delete(k);
                          return next;
                        });
                        return;
                      }
                      if (!branchId) return;
                      try {
                        const r = await apiRequest<{ value: string }>(
                          `/api/branches/${encodeURIComponent(branchId)}/effective-env/reveal?key=${encodeURIComponent(k)}`,
                        );
                        if (r && typeof r.value === 'string') {
                          setRevealedValues((cur) => {
                            const next = new Map(cur);
                            next.set(k, r.value);
                            return next;
                          });
                        }
                      } catch (err) {
                        onToast?.(`显示密钥失败:${err instanceof ApiError ? err.message : String(err)}`);
                      }
                    }}
                    onCopySecret={async (k) => {
                      // 复制 secret:已 revealed 直接用 cache,否则现取 + 复制 +
                      // 不入 cache(用户想"一次性复制"不留显示痕迹)。
                      const cached = revealedValues.get(k);
                      if (cached !== undefined) {
                        await navigator.clipboard.writeText(cached);
                        onToast?.('已复制');
                        return;
                      }
                      if (!branchId) return;
                      try {
                        const r = await apiRequest<{ value: string }>(
                          `/api/branches/${encodeURIComponent(branchId)}/effective-env/reveal?key=${encodeURIComponent(k)}`,
                        );
                        if (r && typeof r.value === 'string') {
                          await navigator.clipboard.writeText(r.value);
                          onToast?.('已复制(未在界面显示)');
                        }
                      } catch (err) {
                        onToast?.(`复制密钥失败:${err instanceof ApiError ? err.message : String(err)}`);
                      }
                    }}
                    query={envQuery}
                    onQuery={setEnvQuery}
                    onRefresh={() => void loadEnv()}
                    branchId={branchId}
                    projectId={projectId}
                    editorOpen={branchEnvEditorOpen}
                    onToggleEditor={() => setBranchEnvEditorOpen((current) => !current)}
                    onEnvChanged={() => void loadEnv()}
                    onToast={(message) => onToast?.(message)}
                  />
                ) : null}

                {activeTab === 'settings' ? (
                  <SettingsPanel
                    branch={branch}
                    projectId={projectId}
                    busy={currentActionBusy}
                    profileState={profileState}
                    modeSavingProfileId={modeSavingProfileId}
                    confirmDelete={confirmDelete}
                    onConfirmDelete={setConfirmDelete}
                    onRunAction={runBranchAction}
                    onSetProfileDeployMode={setProfileDeployMode}
                  />
                ) : null}

                {activeTab === 'metrics' ? (
                  <MetricsPanel
                    state={metricsState}
                    series={metricSeries}
                    onRefresh={() => void loadMetrics()}
                  />
                ) : null}

                <div className="mt-5 text-center text-xs text-muted-foreground">
                  需要修改构建配置 / 环境变量 / 路由？打开
                  <a href={`/settings/${encodeURIComponent(projectId)}`} className="ml-1 text-primary hover:underline">项目设置</a>
                  。需要查看完整日志、Bridge、提交历史？打开
                  <a href={fullPageHref} className="ml-1 text-primary hover:underline">分支详情页</a>
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* Quick action footer。
            未运行 / 已停止 / 异常时把"重新部署"作为主按钮放在 footer flex-1 位,
            "打开分支详情页"降级为 outline 副按钮——以前 footer 里只有"完整页面"
            一个孤零零的橙色大按钮,用户对着停止的分支找不到启动入口
            (2026-05-07 反馈)。 */}
        {branch && activeTab !== 'services' ? (
          <footer className="cds-branch-detail-footer flex items-center gap-2 border-t border-[hsl(var(--hairline))] px-4 py-3">
            {(branch.status === 'idle' || branch.status === 'stopped' || branch.status === 'error') ? (
              <>
                <Button
                  className="cds-branch-detail-footer-primary flex-1"
                  disabled={!!currentActionBusy}
                  title="只把已构建好的容器拉起来（docker restart），不重新拉代码 / 不重建镜像。没有代码变更时用这个，秒级。"
                  onClick={() => void runBranchAction('restart', '重新启动')}
                >
                  {currentActionBusy === 'restart' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                  {currentActionBusy === 'restart' ? '正在重启…' : '重新启动'}
                </Button>
                <Button
                  variant="outline"
                  className="cds-branch-detail-footer-secondary"
                  disabled={!!currentActionBusy}
                  title="拉取最新代码 + 重新构建镜像 + 重启（有代码变更 / 重启失败时用这个，较慢）。"
                  onClick={() => void runBranchAction('deploy', '部署')}
                >
                  {currentActionBusy === 'deploy' ? <Loader2 className="animate-spin" /> : <Play />}
                  {currentActionBusy === 'deploy' ? '正在部署…' : '重新部署'}
                </Button>
                <Button asChild variant="outline" className="cds-branch-detail-footer-secondary">
                  <a href={fullPageHref}>
                    <ExternalLink />
                    详情页
                  </a>
                </Button>
              </>
            ) : (
              <>
                {previewUrl ? (
                  <PreviewActionSplitButton
                    className="flex-[2_1_0]"
                    fill
                    previewHref={previewUrl}
                    previewLabel="打开预览"
                    previewTitle="打开预览页"
                    previewAriaLabel="打开预览页"
                    onRelease={onRelease && branch ? () => onRelease(branch.id) : undefined}
                    releaseDisabled={!onRelease}
                  />
                ) : (
                  <Button className="flex-[2_1_0]" disabled title="当前没有可用预览地址">
                    <Play />
                    等待预览页
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="cds-branch-detail-footer-secondary flex-[1_1_0]"
                  onClick={() => setActiveTab('settings')}
                >
                  <Settings />
                  详细设置
                </Button>
              </>
            )}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

// 保留旧版小卡片实现，供后续可能的页面引用（Week 4.7 抽屉部署 tab
// 已迁移到 ActiveDeployment + HistoryRow，不再渲染本组件）。
export function DeploymentCard({
  deployment,
  now,
  onOpenLogs,
}: {
  deployment: BranchDeploymentItem;
  now: number;
  onOpenLogs: (deployment: BranchDeploymentItem) => void;
}): JSX.Element {
  const stages = deploymentStages(deployment.log);
  const duration = formatDuration((deployment.finishedAt || now) - deployment.startedAt);
  const statusIcon = deployment.status === 'running'
    ? <Loader2 className="h-4 w-4 animate-spin" />
    : deployment.status === 'success'
      ? <CheckCircle2 className="h-4 w-4" />
      : <AlertCircle className="h-4 w-4" />;

  return (
    <div className={`overflow-hidden rounded-md border transition-colors hover:border-primary/45 ${deployment.status === 'error' ? 'border-destructive/35 bg-destructive/5' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/70'}`}>
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[hsl(var(--surface-raised))]/60"
        onClick={() => onOpenLogs(deployment)}
      >
        <span className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${deploymentStatusClass(deployment.status)}`}>
          {statusIcon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{deploymentKindLabel(deployment.kind)}</span>
            {deployment.commitSha ? <span className="font-mono text-xs text-muted-foreground">{deployment.commitSha.slice(0, 7)}</span> : null}
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{deployment.message}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          {duration}
        </span>
      </button>

      <div className="border-t border-[hsl(var(--hairline))] px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {stages.length > 0 ? stages.map((stage) => (
              <span key={stage} className="rounded border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-base))] px-2 py-0.5 text-[11px] text-muted-foreground">
                {stage}
              </span>
            )) : (
              <span className="truncate text-xs text-muted-foreground">{deployment.lastStep || '等待部署事件'}</span>
            )}
          </div>
          <span className="shrink-0 text-xs text-primary">查看日志</span>
        </div>
        {deployment.suggestion ? (
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
            {deployment.suggestion}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function textMatchesQuery(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return text.toLowerCase().includes(q);
}

function filterServiceLogs(state: ServiceLogsState, query: string): ServiceLogsState {
  if (state.status !== 'ok' || !query.trim()) return state;
  const lines = (state.logs || '').split(/\r?\n/).filter((line) => textMatchesQuery(line, query));
  return { ...state, logs: lines.join('\n') };
}

// 2026-05-18: 分支系统日志（生命周期时间线）。每条带时间戳 + 事件类型徽标
// + 触发者 + 原因，最新在前。这是用户排查"分支莫名其妙停止"的主入口：
// 崩溃 / 调度器降温 / janitor 回收 / 用户手动停止 / auto-restart 都会留痕。
function systemLogTypeMeta(type: string): { label: string; cls: string } {
  switch (type) {
    case 'deploy': return { label: '部署', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600' };
    case 'deploy-failed': return { label: '部署失败', cls: 'border-destructive/30 bg-destructive/10 text-destructive' };
    case 'pull': return { label: '拉取', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-600' };
    case 'stop': return { label: '停止', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-600' };
    case 'restart': return { label: '重启', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-600' };
    case 'crash': return { label: '崩溃', cls: 'border-destructive/30 bg-destructive/10 text-destructive' };
    case 'branch-created': return { label: '新建', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600' };
    case 'branch-deleted': return { label: '回收', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-600' };
    default: return { label: type, cls: 'border-border bg-muted text-muted-foreground' };
  }
}

function SystemLogsPanel({ state, query }: { state: SystemLogsState; query: string }): JSX.Element {
  if (state.status === 'loading') return <div className={DETAIL_LOG_EMPTY_CLASS}>加载系统日志…</div>;
  if (state.status === 'error') {
    return <div className={`${DETAIL_LOG_EMPTY_CLASS} text-destructive`}>加载失败：{state.message}</div>;
  }
  if (state.status === 'idle') return <div className={DETAIL_LOG_EMPTY_CLASS}>切换到此页签后加载。</div>;
  const q = query.trim().toLowerCase();
  const rows = (q
    ? state.logs.filter((e) =>
        (e.note || '').toLowerCase().includes(q) ||
        (e.actor || '').toLowerCase().includes(q) ||
        e.type.toLowerCase().includes(q))
    : state.logs);
  if (rows.length === 0) {
    return (
      <div className={DETAIL_LOG_EMPTY_CLASS}>
        {q ? '没有匹配的系统日志。' : '本分支还没有生命周期事件记录。部署 / 停止 / 崩溃 / 回收发生后会在这里显示。'}
      </div>
    );
  }
  return (
    <div className={`${DETAIL_LOG_VIEWPORT_CLASS} divide-y divide-[hsl(var(--hairline))]`}>
      {rows.map((e) => {
        const meta = systemLogTypeMeta(e.type);
        return (
          <div key={e.id} className="px-4 py-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded border px-2 py-0.5 ${meta.cls}`}>{meta.label}</span>
              <span className="text-muted-foreground">{formatDeployTimestamp(e.at)}</span>
              {e.actor ? <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-muted-foreground">{e.actor}</span> : null}
            </div>
            {e.note ? <div className="mt-1.5 leading-5 text-foreground">{e.note}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function dispatchActionLabel(action: GithubWebhookDelivery['dispatchAction']): string {
  switch (action) {
    case 'deploy': return '触发部署';
    case 'branch-created': return '新建分支';
    case 'ignored': return '已忽略';
    case 'skipped': return '已跳过';
    case 'error': return '错误';
    default: return action;
  }
}

function dispatchActionClass(action: GithubWebhookDelivery['dispatchAction']): string {
  switch (action) {
    case 'deploy':
    case 'branch-created':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'error':
      return 'border-destructive/35 bg-destructive/10 text-destructive';
    case 'ignored':
    case 'skipped':
    default:
      return 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground';
  }
}

function triggerLogSearchText(item: GithubWebhookDelivery): string {
  return [
    item.receivedAt,
    item.event,
    item.repoFullName,
    item.ref,
    item.commitSha,
    item.commitMessage,
    item.actor,
    item.branchId,
    item.dispatchAction,
    item.dispatchReason,
    item.deployDispatched ? 'deployDispatched 派发部署' : '',
    item.deployDispatchError,
    item.deployDedupSkipped ? 'deployDedupSkipped 去重跳过' : '',
    item.selfStatusBroadcast ? 'selfStatusBroadcast 左下角更新提示' : '',
    item.error,
  ].filter(Boolean).join(' ');
}

function formatDeployTimestamp(value?: string | null): string {
  if (!value) return '等待首次成功部署';
  const ts = new Date(value).getTime();
  if (!Number.isFinite(ts)) return '等待首次成功部署';
  return new Date(ts).toLocaleString();
}

function branchOriginInsight(branch: BranchDetailData): { label: string; summary: string; className: string } {
  if (branch.githubRepoFullName || branch.githubCommitSha) {
    return {
      label: 'Webhook 关联',
      summary: branch.githubRepoFullName
        ? `最近由 ${branch.githubRepoFullName} 的 GitHub 事件或关联提交驱动`
        : '该分支带有 GitHub 提交元数据，可在 Webhook 日志中追溯触发记录',
      className: 'border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    };
  }
  if ((branch.deployCount || 0) > 0 || (branch.pullCount || 0) > 0 || (branch.stopCount || 0) > 0) {
    return {
      label: '手动操作',
      summary: '该分支没有 GitHub webhook 元数据，通常来自页面按钮、API、CDS CLI 或人工重部署',
      className: 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground',
    };
  }
  return {
    label: '待配置',
    summary: '还没有部署/拉取记录，也没有 webhook 关联。建议先检查项目设置，再执行首次部署',
    className: 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  };
}

function idleBranchExplanation(branch: BranchDetailData): string {
  if ((branch.stopCount || 0) > 0) {
    return '当前没有运行中的容器。该分支存在停止记录（手动停止 / 调度器降温 / 容器崩溃 / janitor 回收 / webhook 触发）——具体"谁停的、何时、为什么"见「日志」页签的「系统日志」。没有代码变更点「重新启动」秒级拉起；要拉新代码重建点「重新部署」。';
  }
  if ((branch.deployCount || 0) === 0) {
    return '当前没有运行中的容器，也没有成功部署记录。派发失败原因见「日志」页签的「Webhook」/「系统日志」；点击下方「重新部署」会拉取当前代码并启动首次部署。';
  }
  return '当前没有运行中的容器。最近成功部署时间以上方「最近部署」为准；停止 / 崩溃 / 回收的来源见「日志」页签的「系统日志」。没有代码变更点「重新启动」，要重建点「重新部署」。';
}

function TriggerLogsPanel({
  state,
  query,
  branch,
  onLoadMore,
}: {
  state: TriggerLogsState;
  query: string;
  branch: BranchDetailData;
  onLoadMore?: () => void;
}): JSX.Element {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className={DETAIL_LOG_EMPTY_CLASS}>
        <LoadingBlock label="加载 Webhook 日志" />
      </div>
    );
  }
  if (state.status === 'error') {
    return <div className={`${DETAIL_LOG_EMPTY_CLASS} items-start py-5`}><ErrorBlock message={state.message} /></div>;
  }

  const rows = state.deliveries.filter((item) => textMatchesQuery(triggerLogSearchText(item), query));
  if (rows.length === 0) {
    const origin = branchOriginInsight(branch);
    return (
      <div className={`${DETAIL_LOG_VIEWPORT_CLASS} space-y-3 px-5 py-8 text-sm leading-6 text-muted-foreground`}>
        <div>
          {query
            ? '没有匹配的 Webhook 日志。'
            : '最近 1000 条 GitHub webhook 投递里没有命中这个分支。'}
        </div>
        {!query ? (
          <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-2 text-xs leading-5">
            <div className="font-medium text-foreground">来源判断：{origin.label}</div>
            <div className="mt-1">{origin.summary}</div>
            <div className="mt-1">
              如果你期望它由 push 自动触发，请到「项目设置 → GitHub」确认仓库已绑定且自动部署开启；
              如果它是手动创建的，切到「部署」或「日志」查看执行状态即可。
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`${DETAIL_LOG_VIEWPORT_CLASS} p-3`}>
      <div className="mb-3 flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
        <span>匹配 {state.filteredTotal}</span>
        <span>全量 {state.total}</span>
      </div>
      <div className="space-y-2">
        {rows.map((item) => {
          const time = item.receivedAt ? new Date(item.receivedAt).toLocaleString() : '-';
          return (
            <div
              key={item.id}
              className={`rounded-md border px-3 py-2 ${
                item.dispatchAction === 'error'
                  ? 'border-destructive/35 bg-destructive/5'
                  : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45'
              }`}
            >
              <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className={`rounded border px-1.5 py-0.5 ${dispatchActionClass(item.dispatchAction)}`}>
                  {dispatchActionLabel(item.dispatchAction)}
                </span>
                <span>{item.event}</span>
                <span>{time}</span>
                <span className="font-mono">{item.durationMs}ms</span>
              </div>

              <div className="grid gap-1.5 text-xs">
                <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                  {item.repoFullName ? <span className="min-w-0 truncate font-mono">{item.repoFullName}</span> : null}
                  {item.ref ? <span className="min-w-0 truncate font-mono text-muted-foreground">{item.ref}</span> : null}
                  {item.commitSha ? <span className="font-mono text-muted-foreground">{item.commitSha.slice(0, 7)}</span> : null}
                  {item.actor ? <span className="text-muted-foreground">@{item.actor}</span> : null}
                </div>

                <div className="flex min-w-0 flex-wrap gap-1.5">
                  <span className={`rounded border px-1.5 py-0.5 ${item.signatureValid ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'border-destructive/35 bg-destructive/10 text-destructive'}`}>
                    验签{item.signatureValid ? '通过' : '失败'}
                  </span>
                  {item.deployDispatched ? (
                    <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">已派发部署</span>
                  ) : null}
                  {item.deployDispatchError ? (
                    <span className="rounded border border-destructive/35 bg-destructive/10 px-1.5 py-0.5 text-destructive">派发失败</span>
                  ) : null}
                  {item.deployDedupSkipped ? (
                    <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-700 dark:text-amber-300">重复触发已去重</span>
                  ) : null}
                  {item.selfStatusBroadcast ? (
                    <span className="rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-sky-700 dark:text-sky-300">左下角更新提示已刷新</span>
                  ) : null}
                  {item.branchId ? <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 font-mono text-muted-foreground">{item.branchId}</span> : null}
                </div>

                {item.dispatchReason ? (
                  <div className="whitespace-pre-wrap break-words text-muted-foreground">{item.dispatchReason}</div>
                ) : null}
                {item.deployDispatchError ? (
                  <div className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">
                    部署未启动：{item.deployDispatchError}
                  </div>
                ) : null}
                {item.commitMessage ? (
                  <div className="line-clamp-2 break-words text-muted-foreground">{item.commitMessage}</div>
                ) : null}
                {item.error ? (
                  <div className="rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-destructive">{item.error}</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {/*
        2026-05-14: 分页加载更多。后端 buffer 上限 1000 条，每页 20。
        用户反复反馈"webhook 看不到历史"——这里给出累计条数 + 加载更多按钮。
      */}
      {state.hasMore || state.loadingMore ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] pt-3 text-xs text-muted-foreground">
          <span>
            已加载 {state.deliveries.length} / {state.filteredTotal} 条匹配（buffer 上限 1000）
          </span>
          <button
            type="button"
            className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-raised))] px-3 py-1 text-xs hover:border-[hsl(var(--hairline-strong))] disabled:opacity-60"
            onClick={() => onLoadMore?.()}
            disabled={!state.hasMore || !!state.loadingMore}
          >
            {state.loadingMore ? '加载中...' : '加载更早 20 条'}
          </button>
        </div>
      ) : state.deliveries.length > 0 ? (
        <div className="mt-3 border-t border-[hsl(var(--hairline))] pt-3 text-xs text-muted-foreground">
          已展示全部 {state.deliveries.length} 条
        </div>
      ) : null}
    </div>
  );
}

function BuildLogsPanel({ logs, query, selection }: { logs: OperationLog[]; query: string; selection: BuildLogSelection | null }): JSX.Element {
  if (selection) {
    const rows = selection.lines
      .map((line, index) => ({ key: `${selection.startedAt || selection.title}-${index}`, text: line }))
      .filter((row) => textMatchesQuery(row.text, query));
    const time = selection.startedAt ? new Date(selection.startedAt).toLocaleString() : '';

    return (
      <div>
        <div className="border-b border-[hsl(var(--hairline))] px-4 py-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={`rounded border px-2 py-0.5 text-xs ${statusClass(selection.status)}`}>{statusLabel(selection.status)}</span>
            <span className="min-w-0 truncate text-sm font-semibold">{selection.title}</span>
            {selection.commitSha ? <span className="font-mono text-xs text-muted-foreground">{selection.commitSha.slice(0, 7)}</span> : null}
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {time ? <span>{time}</span> : null}
            {selection.message ? <span className="min-w-0 truncate">{selection.message}</span> : null}
          </div>
        </div>
        <div className={DETAIL_LOG_VIEWPORT_CLASS}>
          <div className="grid grid-cols-[150px_minmax(0,1fr)] border-b border-[hsl(var(--hairline))] px-4 py-2 text-xs font-medium text-muted-foreground">
            <span>Time</span>
            <span>Message</span>
          </div>
          {rows.length === 0 ? (
            <div className={DETAIL_LOG_EMPTY_CLASS}>{query ? '没有匹配的构建日志。' : '这条部署还没有日志。'}</div>
          ) : (
            <div className="divide-y divide-[hsl(var(--hairline))]">
              {rows.map((row) => (
                <div key={row.key} className="grid grid-cols-[150px_minmax(0,1fr)] gap-3 px-4 py-2 text-xs">
                  <span className="font-mono text-muted-foreground">{time || '-'}</span>
                  <pre className="min-w-0 whitespace-pre-wrap break-words font-mono leading-5 text-muted-foreground">{row.text}</pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const rows = logs
    .slice()
    .reverse()
    .flatMap((log) => {
      const timestamp = log.startedAt ? new Date(log.startedAt).toLocaleString() : '-';
      const events = (log.events || []).slice(-40).reverse();
      if (events.length === 0) {
        const line = `${timestamp} ${log.type} ${log.status}`;
        return textMatchesQuery(line, query) ? [{ key: `${log.startedAt}-${log.type}`, status: log.status, time: timestamp, text: line }] : [];
      }
      return events.map((event, index) => ({
        key: `${log.startedAt}-${log.type}-${event.timestamp || index}-${index}`,
        status: event.status,
        time: event.timestamp ? new Date(event.timestamp).toLocaleString() : timestamp,
        text: `[${event.status}] ${event.title || event.step}${event.log ? ` - ${event.log}` : ''}`,
      })).filter((row) => textMatchesQuery(`${row.time} ${row.text}`, query));
    });

  if (rows.length === 0) {
    return <div className={DETAIL_LOG_EMPTY_CLASS}>{query ? '没有匹配的构建日志。' : '还没有构建记录。'}</div>;
  }

  return (
    <div className={`${DETAIL_LOG_VIEWPORT_CLASS} p-3`}>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.key} className={`rounded-md border px-3 py-2 ${row.status === 'error' ? 'border-destructive/35 bg-destructive/5' : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45'}`}>
            <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className={`rounded border px-1.5 py-0.5 ${statusClass(row.status)}`}>{statusLabel(row.status)}</span>
              <span>{row.time}</span>
            </div>
            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-muted-foreground">{row.text}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

type ResourceAction = 'start' | 'stop' | 'restart';
type ResourcePermissionRole = 'member' | 'developer' | 'admin';
type ResourcePermissionAction =
  | 'resource-restart'
  | 'external-temporary-access'
  | 'external-policy-admin'
  | 'database-clone'
  | 'database-connect-existing'
  | 'backup-create'
  | 'backup-restore'
  | 'credentials-reset'
  | 'connection-inject'
  | 'data-clear'
  | 'data-write'
  | 'resource-delete';

interface ResourcePermissionSummary {
  role: ResourcePermissionRole;
  productionLike: boolean;
  actions: Record<ResourcePermissionAction, {
    allowed: boolean;
    requiredRole: ResourcePermissionRole;
    reason?: string;
  }>;
}

function resourcePermissionAllows(permissions: ResourcePermissionSummary | null, action: ResourcePermissionAction): boolean {
  if (!permissions) return false;
  return permissions.actions[action]?.allowed === true;
}

function resourcePermissionReason(permissions: ResourcePermissionSummary | null, action: ResourcePermissionAction): string {
  if (!permissions) return '权限信息加载中';
  return permissions.actions[action]?.reason || `需要 ${permissions.actions[action]?.requiredRole || 'developer'} 权限`;
}

function resourceInitialDetailTab(
  resource: BranchResource | null,
  requested?: BranchResourceDetailTab | null,
): BranchResourceDetailTab {
  if (!resource || !requested) return 'overview';
  if (resource.kind === 'app' && (requested === 'data' || requested === 'backups')) return 'overview';
  return requested;
}

function ResourceConsole({
  resources,
  selectedResource,
  initialDetailTab,
  serviceLogs,
  branchName,
  onSelect,
  onOpenLogs,
  onInfraAction,
  onExternalAccess,
  onCreateCloneTask,
  onResetCredentials,
  onInjectConnection,
  onCopy,
}: {
  resources: BranchResource[];
  selectedResource: BranchResource | null;
  initialDetailTab?: BranchResourceDetailTab | null;
  serviceLogs: ServiceLogsState;
  branchName: string;
  onSelect: (resource: BranchResource) => void;
  onOpenLogs: (resource: BranchResource) => void;
  onInfraAction: (resource: BranchResource, action: ResourceAction) => Promise<void>;
  onExternalAccess: (resource: BranchResource, input: ResourceExternalAccessInput) => Promise<void>;
  onCreateCloneTask: (resource: BranchResource, input: ResourceCloneInput) => Promise<void>;
  onResetCredentials: (resource: BranchResource, confirmResourceName: string) => Promise<void>;
  onInjectConnection: (resource: BranchResource) => Promise<void>;
  onCopy: (value: string) => Promise<void>;
}): JSX.Element {
  const groups = useMemo(() => {
    const order = ['app', 'database', 'cache', 'queue', 'storage', 'service'] as const;
    return order
      .map((kind) => ({ kind, items: resources.filter((resource) => resource.kind === kind) }))
      .filter((group) => group.items.length > 0);
  }, [resources]);
  const [detailTab, setDetailTab] = useState<BranchResourceDetailTab>(() => resourceInitialDetailTab(selectedResource, initialDetailTab));
  const [resourceMutation, setResourceMutation] = useState<string | null>(null);
  const [permissionState, setPermissionState] = useState<{
    status: 'idle' | 'loading' | 'ok' | 'error';
    resourceId?: string;
    permissions: ResourcePermissionSummary | null;
    message?: string;
  }>({ status: 'idle', permissions: null });

  useEffect(() => {
    setDetailTab(resourceInitialDetailTab(selectedResource, initialDetailTab));
  }, [initialDetailTab, selectedResource?.id]);

  useEffect(() => {
    if (!selectedResource?.branchId) {
      setPermissionState({ status: 'idle', permissions: null });
      return;
    }
    let cancelled = false;
    setPermissionState({ status: 'loading', resourceId: selectedResource.id, permissions: null });
    apiRequest<ResourcePermissionSummary>(
      `/api/branches/${encodeURIComponent(selectedResource.branchId)}/resources/${encodeURIComponent(selectedResource.id)}/permissions`,
    )
      .then((permissions) => {
        if (!cancelled) setPermissionState({ status: 'ok', resourceId: selectedResource.id, permissions });
      })
      .catch((err) => {
        if (!cancelled) {
          setPermissionState({
            status: 'error',
            resourceId: selectedResource.id,
            permissions: null,
            message: err instanceof ApiError ? err.message : String(err),
          });
        }
      });
    return () => { cancelled = true; };
  }, [selectedResource?.branchId, selectedResource?.id]);

  if (resources.length === 0) {
    return (
      <section className="cds-surface-raised cds-hairline px-5 py-8 text-sm text-muted-foreground">
        当前分支还没有资源。先部署分支，CDS 会把应用容器、数据库、缓存和中间件统一展示在这里。
      </section>
    );
  }

  const tabs = selectedResource?.kind === 'app'
    ? [
      ['overview', '概览'],
      ['connection', '连接'],
      ['variables', '变量'],
      ['metrics', '指标'],
      ['logs', '日志'],
      ['settings', '设置'],
    ] as const
    : [
      ['overview', '概览'],
      ['connection', '连接'],
      ['data', '数据'],
      ['backups', '备份'],
      ['variables', '变量'],
      ['metrics', '指标'],
      ['logs', '日志'],
      ['settings', '设置'],
    ] as const;
  const currentPermissions = permissionState.resourceId === selectedResource?.id ? permissionState.permissions : null;
  const canRestartResource = resourcePermissionAllows(currentPermissions, 'resource-restart');

  return (
    <section className="cds-surface-raised cds-hairline overflow-hidden">
      <header className="border-b border-[hsl(var(--hairline))] px-5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">资源（{resources.length}）</h3>
            <p className="mt-1 text-xs text-muted-foreground">先选资源，再在下方完整工作区操作数据、日志、连接和设置。</p>
          </div>
          {selectedResource ? (
            <div className="flex flex-wrap justify-end gap-2">
              <span className="inline-flex h-7 items-center rounded-md border border-[hsl(var(--hairline))] px-2 text-xs text-muted-foreground">
                {permissionState.status === 'loading'
                  ? '权限加载中'
                  : permissionState.status === 'error'
                    ? '权限未知'
                    : `当前角色：${currentPermissions?.role || 'admin'}`}
              </span>
              <span className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs ${statusClass(selectedResource.status)}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${statusRailClass(selectedResource.status)}`} />
                {resourceStatusLabel(selectedResource.status)}
              </span>
            </div>
          ) : null}
        </div>
      </header>

      <div className="border-b border-[hsl(var(--hairline))] px-4 py-3">
        <div className="flex gap-3 overflow-x-auto pb-1">
          {groups.map((group) => (
            <div key={group.kind} className="flex shrink-0 items-center gap-2">
              <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {resourceKindLabel(group.kind)}
              </span>
              {group.items.map((resource) => {
                const active = selectedResource?.id === resource.id;
                return (
                  <button
                    key={resource.id}
                    type="button"
                    className={`inline-flex h-10 min-w-[132px] shrink-0 items-center gap-2 rounded-md border px-2.5 text-left transition-colors ${
                      active
                        ? 'border-primary bg-primary/10 shadow-[0_0_0_1px_hsl(var(--primary)/.35)]'
                        : 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 hover:bg-[hsl(var(--surface-sunken))]'
                    } ${resource.access === 'external' ? 'ring-1 ring-sky-400/30' : ''}`}
                    onClick={() => onSelect(resource)}
                    title={`${resource.displayName}\n${resource.serviceName}`}
                  >
                    <ResourceIcon resource={resource} className="h-5 w-5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold">{resource.runtime}</span>
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">:{resource.port || resource.containerPort || '?'}</span>
                    </span>
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusRailClass(resource.status)}`} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div className="min-h-[620px] min-w-0">
        {selectedResource ? (
          <>
            <div className="flex min-w-0 items-start justify-between gap-3 border-b border-[hsl(var(--hairline))] px-5 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]">
                    <ResourceIcon resource={selectedResource} className="h-6 w-6" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-base font-semibold">{selectedResource.displayName}</div>
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{selectedResource.serviceName}</span>
                      <span>{selectedResource.source === 'infra' ? '依赖资源' : '应用容器'}</span>
                      <span className="inline-flex items-center gap-1">
                        {resourceAccessIcon(selectedResource)}
                        {selectedResource.access === 'external' ? '公网访问' : '内部访问'}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  {selectedResource.source === 'app' ? (
                    <Button type="button" size="sm" variant="outline" onClick={() => onOpenLogs(selectedResource)}>
                      查看日志
                    </Button>
                  ) : (
                    <>
                      <Button type="button" size="sm" variant="outline" disabled={!canRestartResource} title={!canRestartResource ? resourcePermissionReason(currentPermissions, 'resource-restart') : undefined} onClick={() => void onInfraAction(selectedResource, 'start')}>
                        <Play />
                        启动
                      </Button>
                      <Button type="button" size="sm" variant="outline" disabled={!canRestartResource} title={!canRestartResource ? resourcePermissionReason(currentPermissions, 'resource-restart') : undefined} onClick={() => void onInfraAction(selectedResource, 'restart')}>
                        <RefreshCw />
                        重启
                      </Button>
                      <Button type="button" size="sm" variant="outline" disabled={!canRestartResource} title={!canRestartResource ? resourcePermissionReason(currentPermissions, 'resource-restart') : undefined} onClick={() => void onInfraAction(selectedResource, 'stop')}>
                        <Square />
                        停止
                      </Button>
                    </>
                  )}
                </div>
              </div>

              <div className="flex gap-1 overflow-x-auto border-b border-[hsl(var(--hairline))] px-3">
                {tabs.map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`relative h-10 shrink-0 px-3 text-xs transition-colors ${detailTab === key ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                    onClick={() => setDetailTab(key)}
                  >
                    {label}
                    {detailTab === key ? <span className="absolute inset-x-2 bottom-0 h-px bg-primary" /> : null}
                  </button>
                ))}
              </div>

              <div className="p-5">
                {detailTab === 'overview' ? <ResourceOverview resource={selectedResource} branchName={branchName} /> : null}
                {detailTab === 'connection' ? (
                  <ResourceConnection
                    resource={selectedResource}
                    permissions={currentPermissions}
                    externalBusy={resourceMutation === `${selectedResource.id}:external`}
                    resetBusy={resourceMutation === `${selectedResource.id}:credentials`}
                    injectBusy={resourceMutation === `${selectedResource.id}:inject`}
                    onCopy={onCopy}
                    onToggleExternalAccess={async (input) => {
                      setResourceMutation(`${selectedResource.id}:external`);
                      try {
                        await onExternalAccess(selectedResource, input);
                      } finally {
                        setResourceMutation(null);
                      }
                    }}
                    onResetCredentials={async (confirmResourceName) => {
                      setResourceMutation(`${selectedResource.id}:credentials`);
                      try {
                        await onResetCredentials(selectedResource, confirmResourceName);
                      } finally {
                        setResourceMutation(null);
                      }
                    }}
                    onInjectConnection={async () => {
                      setResourceMutation(`${selectedResource.id}:inject`);
                      try {
                        await onInjectConnection(selectedResource);
                      } finally {
                        setResourceMutation(null);
                      }
                    }}
                  />
                ) : null}
                {detailTab === 'data' ? <ResourceDataPanel resource={selectedResource} /> : null}
                {detailTab === 'backups' ? (
                  <ResourceBackupsPanel
                    resource={selectedResource}
                    permissions={currentPermissions}
                    busy={resourceMutation?.startsWith(`${selectedResource.id}:clone:`) || false}
                    onCreateCloneTask={async (input) => {
                      setResourceMutation(`${selectedResource.id}:clone:${input.mode}`);
                      try {
                        await onCreateCloneTask(selectedResource, input);
                      } finally {
                        setResourceMutation(null);
                      }
                    }}
                  />
                ) : null}
                {detailTab === 'variables' ? <ResourceVariablesPanel resource={selectedResource} /> : null}
                {detailTab === 'metrics' ? <ResourceMetricsPanel resource={selectedResource} /> : null}
                {detailTab === 'logs' ? (
                  selectedResource.source === 'app'
                    ? <ServiceLogsPanel service={selectedResource.raw as ServiceState} state={serviceLogs} />
                    : <ResourceLogsPanel resource={selectedResource} />
                ) : null}
                {detailTab === 'settings' ? <ResourceSettingsPanel resource={selectedResource} permissions={currentPermissions} /> : null}
              </div>
            </>
          ) : null}
      </div>
    </section>
  );
}

function ResourceOverview({ resource, branchName }: { resource: BranchResource; branchName: string }): JSX.Element {
  const rows = [
    ['所属分支', branchName],
    ['资源类型', `${resourceKindLabel(resource.kind)} / ${resource.runtime}`],
    ['容器端口', resource.containerPort ? `:${resource.containerPort}` : '-'],
    ['访问端口', resource.port ? `:${resource.port}` : '-'],
    ['访问范围', resource.access === 'external' ? '公网访问' : '内部访问'],
    ['容器', resource.containerName || '-'],
  ];
  return (
    <div className="grid gap-4">
      <div className="grid gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2">
            <span className="text-muted-foreground">{label}</span>
            <span className="min-w-0 truncate font-mono">{value}</span>
          </div>
        ))}
      </div>
      {(resource.dependsOn || []).length > 0 ? (
        <div className="rounded-md border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-xs leading-5 text-sky-700 dark:text-sky-300">
          依赖关系：{resource.displayName} 依赖 {resource.dependsOn.join(', ')}。连接变化后应提示重新部署依赖应用。
        </div>
      ) : null}
      {(resource.consumers || []).length > 0 ? (
        <div className="rounded-md border border-sky-500/25 bg-sky-500/10 px-3 py-2 text-xs leading-5 text-sky-700 dark:text-sky-300">
          被依赖：{resource.consumers.join(', ')} 使用 {resource.displayName}。连接变量变更后建议重新部署这些应用。
        </div>
      ) : null}
      {resource.errorMessage ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
          {resource.errorMessage}
        </div>
      ) : null}
    </div>
  );
}

function ResourceConnection({
  resource,
  permissions,
  externalBusy,
  resetBusy,
  injectBusy,
  onCopy,
  onToggleExternalAccess,
  onResetCredentials,
  onInjectConnection,
}: {
  resource: BranchResource;
  permissions: ResourcePermissionSummary | null;
  externalBusy: boolean;
  resetBusy: boolean;
  injectBusy: boolean;
  onCopy: (value: string) => Promise<void>;
  onToggleExternalAccess: (input: ResourceExternalAccessInput) => Promise<void>;
  onResetCredentials: (confirmResourceName: string) => Promise<void>;
  onInjectConnection: () => Promise<void>;
}): JSX.Element {
  const externalAddress = resource.externalUrl || resource.externalAccess?.address || '';
  const externalEnabled = resource.externalAccess?.enabled || resource.access === 'external';
  const dependentApps = resource.consumers || [];
  const [allowlistDraft, setAllowlistDraft] = useState((resource.externalAccess?.allowlist || []).join('\n'));
  const [ttlDraft, setTtlDraft] = useState(resource.externalAccess?.expiresAt ? '120' : '120');
  const [connectionBusy, setConnectionBusy] = useState<'external' | 'internal' | null>(null);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const canTemporaryExternal = resourcePermissionAllows(permissions, 'external-temporary-access');
  const canResetCredentials = resourcePermissionAllows(permissions, 'credentials-reset');
  const canInjectConnection = resourcePermissionAllows(permissions, 'connection-inject');
  const rows: Array<{
    label: string;
    value: string;
    help?: string;
    connectionScope?: 'external' | 'internal';
    copyLabel?: string;
  }> = [
    { label: '内部地址', value: resource.internalUrl || '-', help: '仅 CDS 容器网络内可达，本地电脑不能直接使用。' },
    {
      label: '外部地址',
      value: externalEnabled ? externalAddress || '未开启' : '未开启公网访问，本地工具不可用',
      help: externalEnabled
        ? '用于本地 redis-cli、DataGrip、RedisInsight 等工具连接。'
        : '需要先在下方临时开启公网 TCP 访问，才能生成本地可用地址。',
    },
    {
      label: '外部连接串（本地工具）',
      value: externalEnabled ? resource.externalAccess?.connectionString || externalAddress || '-' : '未开启公网访问，本地工具不可用',
      connectionScope: externalEnabled && resource.source === 'infra' ? 'external' as const : undefined,
      copyLabel: '复制本地可用',
      help: externalEnabled
        ? '复制后应能在本地 redis-cli、DataGrip、RedisInsight 等工具中使用。'
        : '未开启公网访问时不提供复制，避免复制到本地不可用的内部地址。',
    },
    {
      label: '内部连接串（容器内）',
      value: resource.connectionString || resource.internalUrl || '-',
      connectionScope: resource.source === 'infra' ? 'internal' as const : undefined,
      copyLabel: '复制容器内用',
      help: '只给同一 CDS 网络里的应用容器使用；本地电脑、DataGrip、redis-cli 不能直接使用。',
    },
  ];
  useEffect(() => {
    setAllowlistDraft((resource.externalAccess?.allowlist || []).join('\n'));
    setTtlDraft(resource.externalAccess?.expiresAt ? '120' : '120');
  }, [resource.id, resource.externalAccess?.allowlist, resource.externalAccess?.expiresAt]);
  async function resetCredentials(): Promise<void> {
    const confirmResourceName = window.prompt(`重置会让 ${resource.displayName} 的旧连接失效。请输入资源名确认：${resource.serviceName}`);
    if (!confirmResourceName) return;
    await onResetCredentials(confirmResourceName);
  }
  async function copyConnectionString(scope: 'external' | 'internal'): Promise<void> {
    if (!resource.branchId) return;
    setConnectionBusy(scope);
    setConnectionMessage(null);
    try {
      const res = await apiRequest<{ connectionString: string; expiresAt?: string | null }>(
        `/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/connection-string?scope=${scope}`,
      );
      await onCopy(res.connectionString);
      setConnectionMessage(`${scope === 'external' ? '外部' : '内部'}连接串已复制${res.expiresAt ? `，有效期至 ${res.expiresAt}` : ''}。`);
    } catch (err) {
      setConnectionMessage(err instanceof ApiError ? err.message : String(err));
    } finally {
      setConnectionBusy(null);
    }
  }
  return (
    <div className="space-y-3">
      {rows.map((row) => (
        <div key={row.label} className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 p-3">
          <div className="mb-1 text-xs text-muted-foreground">{row.label}</div>
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{row.value}</code>
            {row.value && row.value !== '-' && row.value !== '未开启' ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={row.connectionScope ? connectionBusy !== null || !canInjectConnection : false}
                title={row.connectionScope && !canInjectConnection ? resourcePermissionReason(permissions, 'connection-inject') : undefined}
                onClick={() => {
                  if (row.connectionScope) {
                    void copyConnectionString(row.connectionScope);
                  } else {
                    void onCopy(row.value);
                  }
                }}
              >
                {row.connectionScope && connectionBusy === row.connectionScope ? <Loader2 className="animate-spin" /> : <Copy />}
                {row.connectionScope ? row.copyLabel || '复制连接串' : '复制'}
              </Button>
            ) : null}
          </div>
          {row.help ? <div className="mt-2 text-[11px] leading-4 text-muted-foreground">{row.help}</div> : null}
        </div>
      ))}
      {connectionMessage ? <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-xs leading-5 text-muted-foreground">{connectionMessage}</div> : null}
      <div className="grid gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold">外部访问控制</div>
            <div className="mt-1">数据库默认保持内部访问；开启公网 TCP 访问时必须填写 IP allowlist、临时有效期和凭据重置记录。</div>
            {resource.externalAccess?.expiresAt ? <div className="mt-1 font-mono">有效期至 {resource.externalAccess.expiresAt}</div> : null}
            {resource.externalAccess?.allowlist && resource.externalAccess.allowlist.length > 0 ? (
              <div className="mt-1 font-mono">
                allowlist: {resource.externalAccess.allowlist.join(', ')}
                {resource.externalAccess.allowlistEnforced ? ' · 网络层已执行' : ' · 等待网络层执行'}
              </div>
            ) : externalEnabled && resource.externalAccess?.kind === 'tcp' ? (
              <div className="mt-1 font-mono">allowlist: 未限制</div>
            ) : null}
            {resource.externalAccess?.proxyContainerName ? (
              <div className="mt-1 font-mono">proxy: {resource.externalAccess.proxyContainerName}</div>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={externalBusy || !canTemporaryExternal}
            title={!canTemporaryExternal ? resourcePermissionReason(permissions, 'external-temporary-access') : undefined}
            onClick={() => {
              const allowlist = allowlistDraft
                .split(/[\n,]/)
                .map((item) => item.trim())
                .filter(Boolean);
              const ttlMinutes = Number(ttlDraft);
              void onToggleExternalAccess({
                enabled: !externalEnabled,
                ttlMinutes: !externalEnabled && Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : undefined,
                allowlist,
              });
            }}
          >
            {externalBusy ? <Loader2 className="animate-spin" /> : externalEnabled ? <PowerOff /> : <ExternalLink />}
            {externalEnabled ? '关闭公网' : '临时开启'}
          </Button>
        </div>
        <div className="grid gap-2 md:grid-cols-[140px_minmax(0,1fr)]">
          <label className="grid gap-1">
            <span className="text-[11px] text-amber-700/80 dark:text-amber-300/80">有效期（分钟）</span>
            <input
              value={ttlDraft}
              onChange={(event) => setTtlDraft(event.target.value)}
              className="h-8 rounded-md border border-amber-500/30 bg-background px-2 font-mono text-xs outline-none focus:border-amber-500"
              inputMode="numeric"
              placeholder="120"
            />
          </label>
          <label className="grid gap-1">
            <span className="text-[11px] text-amber-700/80 dark:text-amber-300/80">IP allowlist（必填，每行一个 IPv4/CIDR）</span>
            <textarea
              value={allowlistDraft}
              onChange={(event) => setAllowlistDraft(event.target.value)}
              className="min-h-[64px] resize-y rounded-md border border-amber-500/30 bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-amber-500"
              placeholder="203.0.113.10/32"
              spellCheck={false}
            />
          </label>
        </div>
      </div>
      {resource.kind === 'database' ? (
        <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-3 text-xs leading-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="font-semibold">连接变量管理</div>
              <div className="mt-1 text-muted-foreground">
                {dependentApps.length > 0
                  ? `依赖应用：${dependentApps.join(', ')}`
                  : '还没有应用声明依赖这个数据库。'}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <Button type="button" size="sm" variant="outline" disabled={resetBusy || !canResetCredentials} title={!canResetCredentials ? resourcePermissionReason(permissions, 'credentials-reset') : undefined} onClick={() => void resetCredentials()}>
                {resetBusy ? <Loader2 className="animate-spin" /> : <RotateCw />}
                重置凭据
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={injectBusy || dependentApps.length === 0 || !canInjectConnection} title={!canInjectConnection ? resourcePermissionReason(permissions, 'connection-inject') : undefined} onClick={() => void onInjectConnection()}>
                {injectBusy ? <Loader2 className="animate-spin" /> : <Rocket />}
                注入依赖应用
              </Button>
            </div>
          </div>
          <div className="text-muted-foreground">
            注入会写入目标应用的分支级配置覆盖；需要重新部署应用后容器才能拿到新的连接变量。
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface DbTableSummary {
  schema?: string;
  name: string;
  fullName?: string;
  type?: string;
}

interface DbQueryResult {
  columns: string[];
  rows: string[][];
  rowCount: number;
}

interface WorkbenchCommandResult {
  ok?: boolean;
  exitCode?: number;
  output?: string;
  error?: string | null;
  truncated?: boolean;
}

type ResourceWorkbenchRuntime = 'sql' | 'document' | 'keyValue' | 'queue' | 'unsupported';
type ResourceWorkbenchRunner = 'sql' | 'mongo' | 'redis-readonly' | 'planned';
type WorkbenchResultMode = 'table' | 'json' | 'output';

interface ResourceWorkbenchAdapter {
  runtime: ResourceWorkbenchRuntime;
  runner: ResourceWorkbenchRunner;
  label: string;
  treeLabel: string;
  consoleLabel: string;
  commandLanguage: 'sql' | 'mongo' | 'redis' | 'rabbitmq' | 'text';
  resultModes: WorkbenchResultMode[];
  defaultCommand: string;
  ready: boolean;
  writeSupported: boolean;
  note: string;
  customPanels: string[];
}

function normalizeWorkbenchRuntime(runtime: string): 'mysql' | 'postgres' | 'sqlserver' | 'mongodb' | 'redis' | 'rabbitmq' | 'unknown' {
  const raw = runtime.toLowerCase();
  if (raw.includes('mysql') || raw.includes('mariadb')) return 'mysql';
  if (raw.includes('postgres')) return 'postgres';
  if (raw.includes('sql server') || raw.includes('mssql') || raw.includes('sqlserver')) return 'sqlserver';
  if (raw.includes('mongo')) return 'mongodb';
  if (raw.includes('redis')) return 'redis';
  if (raw.includes('rabbit')) return 'rabbitmq';
  return 'unknown';
}

function resourceWorkbenchAdapter(resource: BranchResource): ResourceWorkbenchAdapter {
  const runtime = normalizeWorkbenchRuntime(resource.runtime);
  if (runtime === 'mysql' || runtime === 'postgres') {
    return {
      runtime: 'sql',
      runner: 'sql',
      label: `${resource.runtime} 工作台`,
      treeLabel: '数据库 / 表',
      consoleLabel: 'SQL Console',
      commandLanguage: 'sql',
      resultModes: ['table', 'json', 'output'],
      defaultCommand: 'SELECT * FROM <table> LIMIT 50',
      ready: true,
      writeSupported: true,
      note: 'SQL 系资源共用同一套左树、命令区和结果区；DDL/DML 走写权限与审计。',
      customPanels: ['schema', 'ddl', 'backup'],
    };
  }
  if (runtime === 'sqlserver') {
    return {
      runtime: 'sql',
      runner: 'planned',
      label: 'SQL Server 工作台',
      treeLabel: '数据库 / schema / 表',
      consoleLabel: 'T-SQL Console',
      commandLanguage: 'sql',
      resultModes: ['table', 'json', 'output'],
      defaultCommand: 'SELECT TOP 50 * FROM <table>;',
      ready: false,
      writeSupported: false,
      note: '已纳入通用 SQL 工作台协议；执行器需要容器内 sqlcmd 或 mssql-tools 后接入。',
      customPanels: ['schema', 'ddl', 'backup'],
    };
  }
  if (runtime === 'mongodb') {
    return {
      runtime: 'document',
      runner: 'mongo',
      label: 'MongoDB 工作台',
      treeLabel: '数据库 / collection',
      consoleLabel: 'MongoDB Console',
      commandLanguage: 'mongo',
      resultModes: ['table', 'json', 'output'],
      defaultCommand: 'db.getCollection("<collection>").find({}).limit(50);',
      ready: true,
      writeSupported: true,
      note: '文档型资源复用同一大面板；collection 选择只负责生成默认命令。',
      customPanels: ['collection', 'index', 'document'],
    };
  }
  if (runtime === 'redis') {
    return {
      runtime: 'keyValue',
      runner: 'redis-readonly',
      label: 'Redis 工作台',
      treeLabel: 'DB / key',
      consoleLabel: 'Redis Console',
      commandLanguage: 'redis',
      resultModes: ['json', 'output'],
      defaultCommand: 'GET <key>',
      ready: true,
      writeSupported: false,
      note: '第一阶段保留只读 key 浏览；后续在同一协议下补命令执行和结构化编辑。',
      customPanels: ['string', 'hash', 'list', 'set', 'zset', 'stream'],
    };
  }
  if (runtime === 'rabbitmq') {
    return {
      runtime: 'queue',
      runner: 'planned',
      label: 'RabbitMQ 工作台',
      treeLabel: 'vhost / exchange / queue / binding',
      consoleLabel: 'RabbitMQ Command',
      commandLanguage: 'rabbitmq',
      resultModes: ['table', 'json', 'output'],
      defaultCommand: 'list queues',
      ready: false,
      writeSupported: false,
      note: '队列型资源已纳入协议；后续接入 list / peek / publish / purge 等动作命令。',
      customPanels: ['queue', 'exchange', 'binding', 'message'],
    };
  }
  return {
    runtime: 'unsupported',
    runner: 'planned',
    label: `${resource.runtime} 工作台`,
    treeLabel: '资源树',
    consoleLabel: 'Command',
    commandLanguage: 'text',
    resultModes: ['json', 'output'],
    defaultCommand: '',
    ready: false,
    writeSupported: false,
    note: '该资源尚未声明数据工作台执行器，可按同一 adapter 协议扩展。',
    customPanels: [],
  };
}

function ResourceDataPanel({ resource }: { resource: BranchResource }): JSX.Element {
  const adapter = resourceWorkbenchAdapter(resource);
  if (adapter.runner === 'redis-readonly') {
    return <RedisResourceDataPanel resource={resource} />;
  }
  if (adapter.runner === 'mongo') {
    return <MongoResourceDataPanel resource={resource} />;
  }
  if (adapter.runner === 'sql') {
    return <SqlResourceDataPanel resource={resource} adapter={adapter} />;
  }
  return <PlannedResourceWorkbenchPanel resource={resource} adapter={adapter} />;
}

function PlannedResourceWorkbenchPanel({ resource, adapter }: { resource: BranchResource; adapter: ResourceWorkbenchAdapter }): JSX.Element {
  return (
    <div className="grid gap-3 text-sm">
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Terminal className="h-4 w-4 text-primary" />
              {adapter.label}
            </div>
            <div className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              {adapter.treeLabel}，右上执行 {adapter.consoleLabel}，右下查看{adapter.resultModes.map(resultModeLabel).join(' / ')}。{adapter.note}
            </div>
            <div className="mt-2 font-mono text-[11px] text-muted-foreground">
              {resource.displayName} · :{resource.port || resource.containerPort || '?'}
            </div>
          </div>
          <span className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-300">
            执行器待接入
          </span>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-3">
          <MetricChip label="左侧资源树" value={adapter.treeLabel} />
          <MetricChip label="命令区" value={adapter.consoleLabel} />
          <MetricChip label="默认命令" value={adapter.defaultCommand || '-'} />
        </div>
        {adapter.customPanels.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {adapter.customPanels.map((panel) => (
              <span key={panel} className="rounded border border-[hsl(var(--hairline))] bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {panel}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface MongoDatabaseSummary {
  name: string;
  sizeOnDisk?: number;
}

interface MongoCollectionSummary {
  name: string;
  type?: string;
}

const SYSTEM_MONGO_DATABASES = new Set(['admin', 'config', 'local']);

function chooseMongoDatabase(databases: MongoDatabaseSummary[], preferredDatabase?: string, currentDatabase?: string): string {
  const names = new Set(databases.map((database) => database.name));
  if (currentDatabase && names.has(currentDatabase)) return currentDatabase;
  if (preferredDatabase && names.has(preferredDatabase)) return preferredDatabase;
  const businessDatabase = databases.find((database) => !SYSTEM_MONGO_DATABASES.has(database.name));
  return businessDatabase?.name || databases[0]?.name || preferredDatabase || '';
}

function highlightedCode(value: string, language: 'sql' | 'json' | 'mongo'): ReactNode[] {
  const pattern = language === 'sql'
    ? /\b(select|from|where|insert|into|values|update|set|delete|create|alter|drop|truncate|replace|table|index|view|limit|order|by|group|join|left|right|inner|outer|on|and|or|null|not|primary|key|default|describe|show|explain)\b|('[^']*'|"[^"]*"|`[^`]*`)|(--.*$)|(\b\d+(?:\.\d+)?\b)/gim
    : language === 'mongo'
      ? /\b(db|find|findOne|aggregate|countDocuments|insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|createCollection|drop|createIndex|dropIndex|limit|sort|toArray)\b|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\btrue\b|\bfalse\b|\bnull\b)|(-?\b\d+(?:\.\d+)?\b)/gim
      : /("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|(\btrue\b|\bfalse\b|\bnull\b)|(-?\b\d+(?:\.\d+)?\b)/gim;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index > lastIndex) nodes.push(value.slice(lastIndex, match.index));
    const text = match[0];
    const className = language === 'sql'
      ? match[1]
        ? 'text-sky-600 dark:text-sky-300'
        : match[2]
          ? 'text-emerald-700 dark:text-emerald-300'
          : match[3]
            ? 'text-muted-foreground'
            : 'text-amber-700 dark:text-amber-300'
      : language === 'mongo'
        ? match[1]
          ? 'text-sky-600 dark:text-sky-300'
          : match[2]
            ? 'text-emerald-700 dark:text-emerald-300'
            : match[3]
              ? 'text-violet-600 dark:text-violet-300'
              : 'text-amber-700 dark:text-amber-300'
      : match[1]
        ? 'text-sky-600 dark:text-sky-300'
        : match[2]
          ? 'text-emerald-700 dark:text-emerald-300'
          : match[3]
            ? 'text-violet-600 dark:text-violet-300'
            : 'text-amber-700 dark:text-amber-300';
    nodes.push(<span key={`${match.index}-${text}`} className={className}>{text}</span>);
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < value.length) nodes.push(value.slice(lastIndex));
  return nodes;
}

function CodeEditor({
  label,
  value,
  onChange,
  language,
  minHeight = 140,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  language: 'sql' | 'json' | 'mongo';
  minHeight?: number;
  placeholder?: string;
}): JSX.Element {
  return (
    <label className="grid gap-1.5 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      <div className="relative overflow-hidden rounded-md border border-[hsl(var(--hairline))] bg-background focus-within:border-primary">
        <pre
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-5"
          style={{ minHeight }}
        >
          {value ? highlightedCode(value, language) : <span className="text-muted-foreground/55">{placeholder || ''}</span>}
        </pre>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="relative z-10 w-full resize-y bg-transparent px-3 py-2 font-mono text-xs leading-5 text-transparent caret-foreground outline-none selection:bg-primary/20"
          style={{ minHeight }}
          spellCheck={false}
          placeholder={placeholder}
        />
      </div>
    </label>
  );
}

interface MongoCommandState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  documents: unknown[];
  output?: unknown;
  message?: string;
}

function ResourceWorkbenchLauncher({
  resource,
  title,
  description,
  onOpen,
}: {
  resource: BranchResource;
  title: string;
  description: string;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Terminal className="h-4 w-4 text-primary" />
            {title}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{description}</div>
          <div className="mt-2 font-mono text-[11px] text-muted-foreground">
            {resource.displayName} · :{resource.port || resource.containerPort || '?'}
          </div>
        </div>
        <Button type="button" onClick={onOpen}>
          <Maximize2 className="h-4 w-4" />
          打开工作台
        </Button>
      </div>
    </div>
  );
}

function ResourceWorkbenchModal({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] bg-black/65 p-3 backdrop-blur-sm md:p-5" role="dialog" aria-modal="true">
      <div className="mx-auto grid h-full max-w-[1760px] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-[hsl(var(--hairline))] bg-background shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{title}</div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{subtitle}</div>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={onClose} aria-label="关闭工作台">
            <X className="h-4 w-4" />
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

function defaultMongoCommand(collection: string): string {
  return collection
    ? `db.getCollection(${JSON.stringify(collection)}).find({}).limit(50);`
    : 'db.getCollection("<collection>").find({}).limit(50);';
}

function resultModeLabel(mode: WorkbenchResultMode): string {
  if (mode === 'table') return '表';
  if (mode === 'json') return 'JSON';
  return '输出';
}

function MongoResourceDataPanel({ resource }: { resource: BranchResource }): JSX.Element {
  const [workbenchOpen, setWorkbenchOpen] = useState(true);
  const [databasesState, setDatabasesState] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; databases: MongoDatabaseSummary[]; currentDatabase?: string; configuredDatabase?: string; message?: string }>({ status: 'idle', databases: [] });
  const [collectionsState, setCollectionsState] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; collections: MongoCollectionSummary[]; database?: string; message?: string }>({ status: 'idle', collections: [] });
  const [selectedDatabase, setSelectedDatabase] = useState('');
  const selectedDatabaseRef = useRef('');
  const [selectedCollection, setSelectedCollection] = useState('');
  const [command, setCommand] = useState(defaultMongoCommand(''));
  const [resultMode, setResultMode] = useState<WorkbenchResultMode>('table');
  const [commandState, setCommandState] = useState<MongoCommandState>({ status: 'idle', documents: [] });
  const [selectedDocumentIndex, setSelectedDocumentIndex] = useState(0);
  const basePath = resource.branchId
    ? `/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/data/mongo`
    : '';

  useEffect(() => {
    selectedDatabaseRef.current = selectedDatabase;
  }, [selectedDatabase]);

  const loadDatabases = useCallback(async () => {
    if (!basePath) return;
    setDatabasesState((current) => ({ ...current, status: 'loading', message: undefined }));
    try {
      const res = await apiRequest<{ currentDatabase?: string; configuredDatabase?: string; databases: MongoDatabaseSummary[] }>(`${basePath}/databases`);
      const databases = res.databases || [];
      const currentDatabase = chooseMongoDatabase(databases, res.currentDatabase, selectedDatabaseRef.current);
      setDatabasesState({ status: 'ok', databases, currentDatabase, configuredDatabase: res.configuredDatabase });
      setSelectedDatabase((current) => {
        const nextDatabase = chooseMongoDatabase(databases, res.currentDatabase, current);
        if (nextDatabase !== current) {
          setSelectedCollection('');
          setCollectionsState({ status: 'idle', collections: [], database: nextDatabase });
          setCommandState({ status: 'idle', documents: [] });
        }
        return nextDatabase;
      });
    } catch (err) {
      setDatabasesState({ status: 'error', databases: [], message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [basePath]);

  const loadCollections = useCallback(async (database: string, preferredCollection?: string) => {
    if (!basePath || !database) return;
    setCollectionsState((current) => ({ ...current, status: 'loading', message: undefined }));
    setCommandState({ status: 'idle', documents: [] });
    try {
      const res = await apiRequest<{ database?: string; collections: MongoCollectionSummary[] }>(`${basePath}/collections?database=${encodeURIComponent(database)}`);
      const collections = res.collections || [];
      const nextCollection = preferredCollection && collections.some((item) => item.name === preferredCollection)
        ? preferredCollection
        : collections[0]?.name || '';
      setCollectionsState({ status: 'ok', collections, database: res.database });
      setSelectedCollection(nextCollection);
      setCommand(defaultMongoCommand(nextCollection));
    } catch (err) {
      setCollectionsState({ status: 'error', collections: [], message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [basePath]);

  const loadDocuments = useCallback(async (database: string, collection: string) => {
    if (!basePath || !database || !collection) return;
    setCommandState({ status: 'loading', documents: [] });
    try {
      const res = await apiRequest<{ documents: unknown[] }>(`${basePath}/documents?database=${encodeURIComponent(database)}&collection=${encodeURIComponent(collection)}&limit=50`);
      setCommandState({ status: 'ok', documents: res.documents || [] });
      setResultMode('table');
      setSelectedDocumentIndex(0);
    } catch (err) {
      setCommandState({ status: 'error', documents: [], message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [basePath]);

  useEffect(() => {
    void loadDatabases();
  }, [loadDatabases]);

  useEffect(() => {
    if (!selectedDatabase) return;
    void loadCollections(selectedDatabase);
  }, [loadCollections, selectedDatabase]);

  useEffect(() => {
    if (!selectedDatabase || !selectedCollection) return;
    void loadDocuments(selectedDatabase, selectedCollection);
  }, [loadDocuments, selectedCollection, selectedDatabase]);

  async function runMongoCommand(): Promise<void> {
    if (!basePath || !selectedDatabase || !command.trim()) return;
    setCommandState({ status: 'loading', documents: [] });
    try {
      const res = await apiRequest<{ kind: 'documents' | 'output'; documents?: unknown[]; output?: unknown; collection?: string }>(`${basePath}/command`, {
        method: 'POST',
        body: {
          database: selectedDatabase,
          command,
          confirmResourceName: resource.serviceName || resource.displayName,
        },
      });
      if (res.collection) setSelectedCollection(res.collection);
      setCommandState({ status: 'ok', documents: res.documents || [], output: res.output });
      setResultMode(res.kind === 'documents' ? 'table' : 'output');
      setSelectedDocumentIndex(0);
      if (res.kind === 'output') void loadCollections(selectedDatabase, res.collection || selectedCollection);
    } catch (err) {
      setCommandState({ status: 'error', documents: [], message: err instanceof ApiError ? err.message : String(err) });
      setResultMode('output');
    }
  }

  const databaseLabel = selectedDatabase || databasesState.currentDatabase || '-';
  const configuredDatabaseNotice = databasesState.configuredDatabase && databaseLabel !== '-' && databasesState.configuredDatabase !== databaseLabel
    ? `配置默认库 ${databasesState.configuredDatabase} 暂未创建，已选中 ${databaseLabel}`
    : databasesState.configuredDatabase
      ? `默认库 ${databasesState.configuredDatabase}`
      : '';

  return (
    <>
      <ResourceWorkbenchLauncher
        resource={resource}
        title="MongoDB 工作台"
        description="左侧选择数据库和 collection，右上执行一条命令，右下查看表格、JSON 或命令输出。"
        onOpen={() => setWorkbenchOpen(true)}
      />
      <ResourceWorkbenchModal
        open={workbenchOpen}
        title={`MongoDB :${resource.port || resource.containerPort || '?'}`}
        subtitle={`${databaseLabel}.${selectedCollection || '-'} · ${resource.displayName}`}
        onClose={() => setWorkbenchOpen(false)}
      >
        <div className="grid min-h-0 text-sm lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="min-h-0 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/25 lg:border-b-0 lg:border-r">
            <div className="border-b border-[hsl(var(--hairline))] px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold">数据库 / collection</div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{resource.displayName} :{resource.port || resource.containerPort || '?'}</div>
                </div>
                <Button type="button" size="sm" variant="outline" disabled={databasesState.status === 'loading'} onClick={() => void loadDatabases()}>
                  <RefreshCw className={databasesState.status === 'loading' ? 'animate-spin' : ''} />
                </Button>
              </div>
              {configuredDatabaseNotice ? <div className="mt-2 rounded-md border border-[hsl(var(--hairline))] bg-background/55 px-2 py-1.5 text-[11px] text-muted-foreground">{configuredDatabaseNotice}</div> : null}
            </div>
            <div className="h-full overflow-auto p-2">
              {databasesState.status === 'error' ? (
                <div className="px-2 py-3 text-xs leading-5 text-destructive">{databasesState.message}</div>
              ) : databasesState.databases.length > 0 ? (
                <div className="space-y-1">
                  {databasesState.databases.map((db) => {
                    const activeDatabase = db.name === selectedDatabase;
                    const isConfigured = db.name === databasesState.configuredDatabase;
                    const isSystem = SYSTEM_MONGO_DATABASES.has(db.name);
                    return (
                      <div key={db.name} className="rounded-md">
                        <button
                          type="button"
                          className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors ${activeDatabase ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'}`}
                          onClick={() => {
                            setSelectedCollection('');
                            setSelectedDatabase(db.name);
                            setCommandState({ status: 'idle', documents: [] });
                          }}
                        >
                          <span className="text-muted-foreground">{activeDatabase ? '▾' : '▸'}</span>
                          <Database className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                          <span className="min-w-0 flex-1 truncate font-mono">{db.name}</span>
                          {isConfigured ? <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">默认</span> : null}
                          {isSystem ? <span className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">系统</span> : null}
                        </button>
                        {activeDatabase ? (
                          <div className="ml-6 mt-1 space-y-1 border-l border-[hsl(var(--hairline))] pl-2">
                            {collectionsState.status === 'error' ? (
                              <div className="px-2 py-2 text-[11px] leading-5 text-destructive">{collectionsState.message}</div>
                            ) : collectionsState.collections.length > 0 ? collectionsState.collections.map((collection) => {
                              const activeCollection = collection.name === selectedCollection;
                              return (
                                <button
                                  key={collection.name}
                                  type="button"
                                  className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors ${activeCollection ? 'bg-primary/15 text-foreground ring-1 ring-primary/30' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'}`}
                                  onClick={() => {
                                    setSelectedCollection(collection.name);
                                    setCommand(defaultMongoCommand(collection.name));
                                    setSelectedDocumentIndex(0);
                                  }}
                                >
                                  <Table2 className="h-3.5 w-3.5 shrink-0" />
                                  <span className="min-w-0 flex-1 truncate font-mono">{collection.name}</span>
                                </button>
                              );
                            }) : (
                              <div className="px-2 py-2 text-[11px] text-muted-foreground">
                                {collectionsState.status === 'loading' ? '读取 collection...' : '暂无 collection'}
                              </div>
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="px-2 py-3 text-xs text-muted-foreground">{databasesState.status === 'loading' ? '读取数据库...' : '没有数据库信息。'}</div>
              )}
            </div>
          </aside>

          <main className="grid min-h-0 min-w-0 grid-rows-[245px_minmax(0,1fr)]">
            <section className="border-b border-[hsl(var(--hairline))] bg-background/30">
              <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold">MongoDB Console</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{databaseLabel}.{selectedCollection || '-'}</div>
                </div>
                <Button type="button" size="sm" disabled={!selectedDatabase || !command.trim() || commandState.status === 'loading'} onClick={() => void runMongoCommand()}>
                  {commandState.status === 'loading' ? <Loader2 className="animate-spin" /> : <Play />}
                  执行
                </Button>
              </div>
              <div
                className="p-3"
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void runMongoCommand();
                  }
                }}
              >
                <CodeEditor
                  label="命令"
                  value={command}
                  onChange={setCommand}
                  language="mongo"
                  minHeight={158}
                  placeholder="db.getCollection('users').find({}).limit(50);"
                />
              </div>
            </section>

            <MongoDocumentsView
              state={commandState}
              collection={selectedCollection}
              selectedIndex={selectedDocumentIndex}
              onSelectIndex={setSelectedDocumentIndex}
              viewMode={resultMode}
              onViewModeChange={setResultMode}
            />
          </main>
        </div>
      </ResourceWorkbenchModal>
    </>
  );
}

function MongoDocumentsView({
  state,
  collection,
  selectedIndex,
  onSelectIndex,
  viewMode,
  onViewModeChange,
}: {
  state: MongoCommandState;
  collection?: string;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  viewMode: WorkbenchResultMode;
  onViewModeChange: (mode: WorkbenchResultMode) => void;
}): JSX.Element {
  const hasDocuments = state.documents.length > 0;
  const outputText = state.status === 'error'
    ? state.message || '执行失败'
    : state.output === undefined
      ? state.status === 'ok'
        ? '执行完成。'
        : '执行命令后在这里查看输出。'
      : typeof state.output === 'string'
        ? state.output
        : JSON.stringify(state.output, null, 2);
  const jsonText = hasDocuments
    ? JSON.stringify(state.documents, null, 2)
    : outputText;
  const activeMode: WorkbenchResultMode = viewMode === 'table' && !hasDocuments ? 'output' : viewMode;

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-background/20">
      <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] bg-background/30 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold">结果</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {collection || '-'} · {hasDocuments ? `${state.documents.length} rows` : 'command output'}
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-[hsl(var(--hairline))] bg-background/70 p-1">
          {(['table', 'json', 'output'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`inline-flex h-7 items-center gap-1.5 rounded px-2 text-[11px] transition-colors ${activeMode === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => onViewModeChange(mode)}
            >
              {mode === 'table' ? <Table2 className="h-3.5 w-3.5" /> : mode === 'json' ? <Braces className="h-3.5 w-3.5" /> : <Terminal className="h-3.5 w-3.5" />}
              {resultModeLabel(mode)}
            </button>
          ))}
        </div>
      </div>

      {state.status === 'loading' ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          执行中
        </div>
      ) : activeMode === 'table' && hasDocuments ? (
        <MongoDocumentTable documents={state.documents} selectedIndex={selectedIndex} onSelectIndex={onSelectIndex} />
      ) : activeMode === 'json' ? (
        <pre className="min-h-0 overflow-auto p-3 font-mono text-xs leading-5">
          {highlightedCode(jsonText, 'json')}
        </pre>
      ) : (
        <pre className={`min-h-0 overflow-auto p-3 font-mono text-xs leading-5 ${state.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
          {outputText}
        </pre>
      )}
    </div>
  );
}

function MongoDocumentTable({
  documents,
  selectedIndex,
  onSelectIndex,
}: {
  documents: unknown[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
}): JSX.Element {
  const columns = mongoDocumentColumns(documents);
  return (
    <div className="min-h-0 overflow-auto">
      <table className="w-full min-w-[920px] text-left text-xs">
        <thead className="sticky top-0 z-10 bg-[hsl(var(--surface-sunken))] text-muted-foreground">
          <tr>
            <th className="w-12 px-3 py-2 font-medium">#</th>
            {columns.map((column) => (
              <th key={column} className="px-3 py-2 font-medium">
                <span className="font-mono">{column}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {documents.map((doc, rowIndex) => {
            const row = mongoDocumentRecord(doc);
            const active = rowIndex === selectedIndex;
            return (
              <tr
                // eslint-disable-next-line react/no-array-index-key
                key={rowIndex}
                className={`cursor-pointer border-t border-[hsl(var(--hairline))] ${active ? 'bg-primary/10 text-foreground' : 'hover:bg-[hsl(var(--surface-sunken))]/70'}`}
                onClick={() => onSelectIndex(rowIndex)}
              >
                <td className="px-3 py-2 font-mono text-muted-foreground">{rowIndex + 1}</td>
                {columns.map((column) => (
                  <td key={`${rowIndex}-${column}`} className="max-w-[280px] truncate px-3 py-2 font-mono text-muted-foreground" title={mongoValuePreview(row[column])}>
                    {mongoValuePreview(row[column])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function mongoDocumentRecord(doc: unknown): Record<string, unknown> {
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc as Record<string, unknown>;
  return { value: doc };
}

function mongoDocumentColumns(documents: unknown[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const doc of documents.slice(0, 50)) {
    const record = mongoDocumentRecord(doc);
    for (const key of Object.keys(record)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
      if (columns.length >= 14) return prioritizeMongoColumns(columns);
    }
  }
  return prioritizeMongoColumns(columns);
}

function prioritizeMongoColumns(columns: string[]): string[] {
  return columns.includes('_id')
    ? ['_id', ...columns.filter((column) => column !== '_id')]
    : columns;
}

function mongoValuePreview(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

interface RedisKeySummary {
  key: string;
  type: string;
  ttl: number;
  memoryBytes?: number | null;
}

interface RedisKeyDetail extends RedisKeySummary {
  preview: {
    kind: string;
    values: string[];
    truncated?: boolean;
  };
}

function RedisResourceDataPanel({ resource }: { resource: BranchResource }): JSX.Element {
  const [pattern, setPattern] = useState('*');
  const [cursor, setCursor] = useState('0');
  const [keysState, setKeysState] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; keys: RedisKeySummary[]; nextCursor: string; message?: string }>({ status: 'idle', keys: [], nextCursor: '0' });
  const [selectedKey, setSelectedKey] = useState('');
  const [detailState, setDetailState] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; detail?: RedisKeyDetail; message?: string }>({ status: 'idle' });
  const [memoryState, setMemoryState] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; memory: Record<string, string>; message?: string }>({ status: 'idle', memory: {} });
  const basePath = resource.branchId
    ? `/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/data/redis`
    : '';

  const loadKeys = useCallback(async (nextCursor = '0') => {
    if (!basePath) return;
    setKeysState((current) => ({ ...current, status: 'loading', message: undefined }));
    try {
      const res = await apiRequest<{ cursor: string; keys: RedisKeySummary[] }>(
        `${basePath}/keys?cursor=${encodeURIComponent(nextCursor)}&pattern=${encodeURIComponent(pattern || '*')}&count=100`,
      );
      const keys = res.keys || [];
      setKeysState({ status: 'ok', keys, nextCursor: res.cursor || '0' });
      setCursor(res.cursor || '0');
      setSelectedKey((current) => current || keys[0]?.key || '');
    } catch (err) {
      setKeysState({ status: 'error', keys: [], nextCursor: '0', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [basePath, pattern]);

  const loadMemory = useCallback(async () => {
    if (!basePath) return;
    setMemoryState((current) => ({ ...current, status: 'loading', message: undefined }));
    try {
      const res = await apiRequest<{ memory: Record<string, string> }>(`${basePath}/memory`);
      setMemoryState({ status: 'ok', memory: res.memory || {} });
    } catch (err) {
      setMemoryState({ status: 'error', memory: {}, message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [basePath]);

  const loadKeyDetail = useCallback(async (key: string) => {
    if (!basePath || !key) return;
    setDetailState({ status: 'loading' });
    try {
      const detail = await apiRequest<RedisKeyDetail>(`${basePath}/key?key=${encodeURIComponent(key)}`);
      setDetailState({ status: 'ok', detail });
    } catch (err) {
      setDetailState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [basePath]);

  useEffect(() => {
    void loadKeys('0');
    void loadMemory();
  }, [loadKeys, loadMemory]);

  useEffect(() => {
    if (!selectedKey) return;
    void loadKeyDetail(selectedKey);
  }, [loadKeyDetail, selectedKey]);

  return (
    <div className="grid gap-3 text-sm">
      <div className="grid min-h-[420px] gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35">
          <div className="grid gap-2 border-b border-[hsl(var(--hairline))] px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold">Key Browser</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">SCAN · 只读</div>
              </div>
              <Button type="button" size="sm" variant="outline" disabled={keysState.status === 'loading'} onClick={() => void loadKeys('0')}>
                <RefreshCw className={keysState.status === 'loading' ? 'animate-spin' : ''} />
              </Button>
            </div>
            <div className="flex gap-2">
              <input
                value={pattern}
                onChange={(event) => setPattern(event.target.value)}
                className="min-w-0 flex-1 rounded-md border border-[hsl(var(--hairline))] bg-background px-2 py-1.5 font-mono text-xs outline-none focus:border-primary"
                placeholder="*"
              />
              <Button type="button" size="sm" variant="outline" onClick={() => void loadKeys('0')}>过滤</Button>
            </div>
          </div>
          <div className="max-h-[340px] overflow-auto p-2">
            {keysState.status === 'error' ? (
              <div className="px-2 py-3 text-xs leading-5 text-destructive">{keysState.message}</div>
            ) : keysState.keys.length > 0 ? (
              <div className="space-y-1">
                {keysState.keys.map((item) => {
                  const active = item.key === selectedKey;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-2 py-2 text-left text-xs ${active ? 'border-primary bg-primary/10 text-foreground' : 'border-transparent text-muted-foreground hover:border-[hsl(var(--hairline))] hover:text-foreground'}`}
                      onClick={() => setSelectedKey(item.key)}
                    >
                      <span className="min-w-0 truncate font-mono">{item.key}</span>
                      <span className="rounded border border-[hsl(var(--hairline))] px-1.5 py-0.5 text-[10px]">{item.type}</span>
                      <span className="col-span-2 text-[11px] text-muted-foreground">
                        TTL {formatRedisTtl(item.ttl)} · {item.memoryBytes ? formatBytes(item.memoryBytes) : 'memory -'}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-2 py-3 text-xs text-muted-foreground">{keysState.status === 'loading' ? '扫描中...' : '没有匹配的 key。'}</div>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-[hsl(var(--hairline))] px-3 py-2 text-xs text-muted-foreground">
            <span>cursor {cursor}</span>
            <Button type="button" size="sm" variant="outline" disabled={keysState.status === 'loading' || keysState.nextCursor === '0'} onClick={() => void loadKeys(keysState.nextCursor)}>
              下一批
            </Button>
          </div>
        </aside>

        <div className="grid min-w-0 gap-3">
          <section className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35">
            <div className="border-b border-[hsl(var(--hairline))] px-3 py-2 text-xs font-semibold">Key Detail</div>
            {detailState.status === 'loading' ? (
              <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />读取 key</div>
            ) : detailState.status === 'error' ? (
              <div className="px-3 py-3 text-xs leading-5 text-destructive">{detailState.message}</div>
            ) : detailState.detail ? (
              <div className="grid gap-3 p-3">
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <MetricChip label="Type" value={detailState.detail.type} />
                  <MetricChip label="TTL" value={formatRedisTtl(detailState.detail.ttl)} />
                  <MetricChip label="Memory" value={detailState.detail.memoryBytes ? formatBytes(detailState.detail.memoryBytes) : '-'} />
                  <MetricChip label="Preview" value={detailState.detail.preview.kind} />
                </div>
                <pre className="max-h-[260px] overflow-auto rounded-md border border-[hsl(var(--hairline))] bg-background p-3 font-mono text-xs leading-5 text-muted-foreground">
                  {formatRedisPreview(detailState.detail.preview)}
                </pre>
              </div>
            ) : (
              <div className="px-3 py-3 text-xs text-muted-foreground">选择 key 查看 TTL、类型和值预览。</div>
            )}
          </section>

          <section className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35">
            <div className="flex items-center justify-between gap-2 border-b border-[hsl(var(--hairline))] px-3 py-2">
              <div className="text-xs font-semibold">Memory Usage</div>
              <Button type="button" size="sm" variant="outline" disabled={memoryState.status === 'loading'} onClick={() => void loadMemory()}>
                <RefreshCw className={memoryState.status === 'loading' ? 'animate-spin' : ''} />
              </Button>
            </div>
            {memoryState.status === 'error' ? (
              <div className="px-3 py-3 text-xs leading-5 text-destructive">{memoryState.message}</div>
            ) : (
              <div className="grid grid-cols-2 gap-2 p-3 lg:grid-cols-4">
                <MetricChip label="used_memory" value={formatRedisBytes(memoryState.memory.used_memory)} />
                <MetricChip label="peak" value={formatRedisBytes(memoryState.memory.used_memory_peak)} />
                <MetricChip label="rss" value={formatRedisBytes(memoryState.memory.used_memory_rss)} />
                <MetricChip label="fragmentation" value={memoryState.memory.mem_fragmentation_ratio || '-'} />
              </div>
            )}
          </section>
        </div>
      </div>

      <div className="rounded-md border border-[hsl(var(--hairline))] px-3 py-2 text-xs leading-5 text-muted-foreground">
        Redis 数据面板只执行 SCAN / TYPE / TTL / MEMORY / GET / HGETALL / LRANGE / SMEMBERS / ZRANGE 等只读命令。
      </div>
    </div>
  );
}

function MetricChip({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-md border border-[hsl(var(--hairline))] bg-background/60 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 truncate font-mono text-xs">{value}</div>
    </div>
  );
}

function formatRedisTtl(value: number): string {
  if (value === -1) return '永久';
  if (value === -2) return '不存在';
  if (!Number.isFinite(value) || value < 0) return '-';
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  return `${Math.round(value / 3600)}h`;
}

function formatRedisBytes(value?: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? formatBytes(n) : '-';
}

function formatRedisPreview(preview: RedisKeyDetail['preview']): string {
  if (!preview.values.length) return '(empty)';
  if (preview.kind === 'hash') {
    const lines: string[] = [];
    for (let i = 0; i < preview.values.length; i += 2) {
      lines.push(`${preview.values[i]}: ${preview.values[i + 1] || ''}`);
    }
    return lines.join('\n');
  }
  if (preview.kind === 'zset') {
    const lines: string[] = [];
    for (let i = 0; i < preview.values.length; i += 2) {
      lines.push(`${preview.values[i]}  score=${preview.values[i + 1] || ''}`);
    }
    return lines.join('\n');
  }
  return preview.values.join('\n');
}

function sqlTableKey(table: DbTableSummary): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function quoteSqlTableName(resource: BranchResource, table: DbTableSummary): string {
  if (resource.runtime === 'PostgreSQL') {
    const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    return table.schema ? `${quote(table.schema)}.${quote(table.name)}` : quote(table.name);
  }
  return `\`${table.name.replace(/`/g, '``')}\``;
}

type DbResultState = { status: 'idle' | 'loading' | 'ok' | 'error'; result?: DbQueryResult; message?: string };

function sqlCommandIsReadOnly(sql: string): boolean {
  const head = sql.trim().replace(/;+$/g, '').match(/^([a-z]+)/i)?.[1]?.toLowerCase() || '';
  return ['select', 'show', 'describe', 'desc', 'explain'].includes(head);
}

function SqlResourceDataPanel({ resource, adapter }: { resource: BranchResource; adapter: ResourceWorkbenchAdapter }): JSX.Element {
  const [workbenchOpen, setWorkbenchOpen] = useState(true);
  const [tablesState, setTablesState] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; tables: DbTableSummary[]; database?: string; message?: string }>({ status: 'idle', tables: [] });
  const [selectedTableKey, setSelectedTableKey] = useState('');
  const [sql, setSql] = useState('SELECT 1');
  const [resultState, setResultState] = useState<DbResultState>({ status: 'idle' });
  const [resultMode, setResultMode] = useState<WorkbenchResultMode>('table');
  const [initSql, setInitSql] = useState('');
  const [migrationCommand, setMigrationCommand] = useState('');
  const [initBusy, setInitBusy] = useState<'init-sql' | 'migration' | null>(null);
  const [initResult, setInitResult] = useState<WorkbenchCommandResult | null>(null);
  const [initError, setInitError] = useState('');

  const basePath = resource.branchId
    ? `/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/data`
    : '';
  const selectedTable = tablesState.tables.find((table) => sqlTableKey(table) === selectedTableKey) || null;

  const loadTables = useCallback(async () => {
    if (!basePath) return;
    setTablesState((current) => ({ ...current, status: 'loading', message: undefined }));
    try {
      const res = await apiRequest<{ database?: string; tables: DbTableSummary[] }>(`${basePath}/tables`);
      const tables = res.tables || [];
      setTablesState({ status: 'ok', tables, database: res.database });
      setSelectedTableKey((current) => current || (tables[0] ? sqlTableKey(tables[0]) : ''));
      setSql((current) => (!current || current === 'SELECT 1') && tables[0] ? `SELECT * FROM ${quoteSqlTableName(resource, tables[0])} LIMIT 50` : current);
    } catch (err) {
      setTablesState({ status: 'error', tables: [], message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [basePath, resource]);

  const loadTablePreview = useCallback(async (table: DbTableSummary) => {
    if (!basePath || !table) return;
    setResultState({ status: 'loading' });
    try {
      const schemaQs = table.schema ? `&schema=${encodeURIComponent(table.schema)}` : '';
      const preview = await apiRequest<DbQueryResult>(`${basePath}/preview?table=${encodeURIComponent(table.name)}${schemaQs}&limit=50`);
      setResultState({ status: 'ok', result: preview });
      setResultMode(preview.columns.length > 0 ? 'table' : 'output');
    } catch (err) {
      setResultState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
      setResultMode('output');
    }
  }, [basePath]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  useEffect(() => {
    if (!selectedTable) return;
    void loadTablePreview(selectedTable);
  }, [loadTablePreview, selectedTable]);

  async function runInitializationSql(): Promise<void> {
    if (!basePath || !initSql.trim()) return;
    setInitBusy('init-sql');
    setInitError('');
    try {
      const result = await apiRequest<WorkbenchCommandResult>(`${basePath}/init-sql`, {
        method: 'POST',
        body: { sql: initSql, confirmResourceName: resource.serviceName || resource.displayName },
      });
      setInitResult(result);
      void loadTables();
    } catch (err) {
      setInitError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setInitBusy(null);
    }
  }

  async function runMigrationCommand(): Promise<void> {
    if (!resource.branchId || !migrationCommand.trim()) return;
    setInitBusy('migration');
    setInitError('');
    try {
      const result = await apiRequest<WorkbenchCommandResult>(`/api/branches/${encodeURIComponent(resource.branchId)}/database-init/run`, {
        method: 'POST',
        body: { command: migrationCommand.trim() },
      });
      setInitResult(result);
      void loadTables();
    } catch (err) {
      setInitError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setInitBusy(null);
    }
  }

  async function runSqlCommand(): Promise<void> {
    if (!basePath || !sql.trim()) return;
    setResultState({ status: 'loading' });
    try {
      const readOnly = sqlCommandIsReadOnly(sql);
      const result = await apiRequest<DbQueryResult>(`${basePath}/${readOnly ? 'query' : 'query-write'}`, {
        method: 'POST',
        body: readOnly ? { sql } : { sql, confirmResourceName: resource.serviceName || resource.displayName },
      });
      setResultState({ status: 'ok', result });
      setResultMode(result.columns.length > 0 ? 'table' : 'output');
      if (!readOnly) {
        void loadTables();
        if (selectedTable) void loadTablePreview(selectedTable);
      }
    } catch (err) {
      setResultState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
      setResultMode('output');
    }
  }

  return (
    <>
      <ResourceWorkbenchLauncher
        resource={resource}
        title={adapter.label}
        description={`${adapter.treeLabel}，右上执行一条命令，右下查看${adapter.resultModes.map(resultModeLabel).join(' / ')}。`}
        onOpen={() => setWorkbenchOpen(true)}
      />
      <ResourceWorkbenchModal
        open={workbenchOpen}
        title={`${resource.runtime} :${resource.port || resource.containerPort || '?'}`}
        subtitle={`${tablesState.database || '-'}${selectedTable ? `.${selectedTable.schema ? `${selectedTable.schema}.` : ''}${selectedTable.name}` : ''} · ${resource.displayName}`}
        onClose={() => setWorkbenchOpen(false)}
      >
        <div className="grid min-h-0 text-sm lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="min-h-0 border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/25 lg:border-b-0 lg:border-r">
            <div className="border-b border-[hsl(var(--hairline))] px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold">{adapter.treeLabel}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{resource.displayName} · {tablesState.database || '-'}</div>
                </div>
                <Button type="button" size="sm" variant="outline" disabled={tablesState.status === 'loading'} onClick={() => void loadTables()}>
                  <RefreshCw className={tablesState.status === 'loading' ? 'animate-spin' : ''} />
                </Button>
              </div>
            </div>
            <div className="h-full overflow-auto p-2">
              {tablesState.status === 'error' ? (
                <div className="px-2 py-3 text-xs leading-5 text-destructive">{tablesState.message}</div>
              ) : tablesState.tables.length > 0 ? (
                <div className="space-y-1">
                  <div className="flex h-8 items-center gap-2 rounded-md px-2 text-xs text-foreground">
                    <Database className="h-3.5 w-3.5 text-cyan-500" />
                    <span className="min-w-0 truncate font-mono">{tablesState.database || 'database'}</span>
                  </div>
                  <div className="ml-4 space-y-1 border-l border-[hsl(var(--hairline))] pl-2">
                    {tablesState.tables.map((table) => {
                      const active = sqlTableKey(table) === selectedTableKey;
                      return (
                        <button
                          key={sqlTableKey(table)}
                          type="button"
                          className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs transition-colors ${active ? 'bg-primary/15 text-foreground ring-1 ring-primary/30' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground'}`}
                          onClick={() => {
                            setSelectedTableKey(sqlTableKey(table));
                            setSql(`SELECT * FROM ${quoteSqlTableName(resource, table)} LIMIT 50`);
                          }}
                        >
                          <Table2 className="h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate font-mono">{table.schema && resource.runtime === 'PostgreSQL' ? `${table.schema}.${table.name}` : table.name}</span>
                          <span className="text-[10px] text-muted-foreground">{table.type === 'VIEW' ? 'view' : 'table'}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="px-2 py-3 text-xs text-muted-foreground">{tablesState.status === 'loading' ? '读取表列表...' : '没有表。'}</div>
              )}
            </div>
          </aside>

          <main className="grid min-h-0 min-w-0 grid-rows-[245px_minmax(0,1fr)]">
            <section className="border-b border-[hsl(var(--hairline))] bg-background/30">
              <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] px-3 py-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold">{adapter.consoleLabel}</div>
                  <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{selectedTable ? `${tablesState.database || '-'}.${selectedTable.schema ? `${selectedTable.schema}.` : ''}${selectedTable.name}` : tablesState.database || '-'}</div>
                </div>
                <Button type="button" size="sm" disabled={!sql.trim() || resultState.status === 'loading'} onClick={() => void runSqlCommand()}>
                  {resultState.status === 'loading' ? <Loader2 className="animate-spin" /> : <Play />}
                  执行
                </Button>
              </div>
              <div
                className="p-3"
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void runSqlCommand();
                  }
                }}
              >
                <CodeEditor
                  label="命令"
                  value={sql}
                  onChange={setSql}
                  language="sql"
                  minHeight={158}
                  placeholder="SELECT * FROM users LIMIT 50"
                />
              </div>
            </section>

            <DbResultTable
              state={resultState}
              emptyLabel="选择表或执行 SQL 后在这里显示结果。"
              viewMode={resultMode}
              onViewModeChange={setResultMode}
            />
          </main>
          <section className="border-t border-[hsl(var(--hairline))] bg-background/30 p-3 lg:col-span-2">
            <details className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35 p-3">
              <summary className="cursor-pointer text-xs font-semibold">初始化 / 迁移 / 重试</summary>
              <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="space-y-2">
                  <div className="text-[11px] font-medium text-muted-foreground">执行初始化 SQL</div>
                  <textarea
                    className="min-h-28 w-full resize-y rounded-md border border-[hsl(var(--hairline))] bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={initSql}
                    onChange={(event) => setInitSql(event.target.value)}
                    placeholder="CREATE TABLE example (id INT PRIMARY KEY);"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" disabled={!initSql.trim() || initBusy !== null || !basePath} onClick={() => void runInitializationSql()}>
                      {initBusy === 'init-sql' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                      执行初始化 SQL
                    </Button>
                    <Button type="button" size="sm" variant="ghost" disabled={!sql.trim()} onClick={() => setInitSql(sql)}>
                      载入当前命令
                    </Button>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="text-[11px] font-medium text-muted-foreground">执行迁移命令</div>
                  <input
                    className="h-9 w-full rounded-md border border-[hsl(var(--hairline))] bg-background px-3 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    value={migrationCommand}
                    onChange={(event) => setMigrationCommand(event.target.value)}
                    placeholder="pnpm exec prisma migrate deploy"
                  />
                  <Button type="button" size="sm" variant="outline" disabled={!resource.branchId || !migrationCommand.trim() || initBusy !== null} onClick={() => void runMigrationCommand()}>
                    {initBusy === 'migration' ? <Loader2 className="animate-spin" /> : <Play />}
                    执行迁移命令
                  </Button>
                  {initError ? <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{initError}</div> : null}
                  {initResult ? (
                    <pre className="max-h-32 overflow-auto rounded-md border border-[hsl(var(--hairline))] bg-background p-2 font-mono text-[11px] leading-5 text-muted-foreground">
                      {(initResult.error ? `[exit ${initResult.exitCode ?? 1}]\n${initResult.error}\n\n` : '') + (initResult.output || (initResult.ok === false ? '执行失败' : '执行完成'))}
                      {initResult.truncated ? '\n...(输出已截断)' : ''}
                    </pre>
                  ) : null}
                </div>
              </div>
            </details>
          </section>
        </div>
      </ResourceWorkbenchModal>
    </>
  );
}

function DbResultTable({
  state,
  emptyLabel,
  viewMode,
  onViewModeChange,
}: {
  state: DbResultState;
  emptyLabel: string;
  viewMode: WorkbenchResultMode;
  onViewModeChange: (mode: WorkbenchResultMode) => void;
}): JSX.Element {
  const hasRows = Boolean(state.result && state.result.columns.length > 0);
  const activeMode: WorkbenchResultMode = viewMode === 'table' && !hasRows ? 'output' : viewMode;
  const jsonRows = state.result
    ? state.result.rows.map((row) => Object.fromEntries(state.result!.columns.map((column, index) => [column, row[index] ?? null])))
    : [];
  const outputText = state.status === 'error'
    ? state.message || '执行失败'
    : state.result
      ? state.result.columns.length > 0
        ? `返回 ${state.result.rowCount} 行。`
        : `执行完成，返回 ${state.result.rowCount} 行。`
      : emptyLabel;

  return (
    <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] bg-background/20">
      <div className="flex items-center justify-between gap-3 border-b border-[hsl(var(--hairline))] bg-background/30 px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold">结果</div>
          <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            {hasRows ? `${state.result?.rowCount || 0} rows` : 'command output'}
          </div>
        </div>
        <div className="flex items-center gap-1 rounded-md border border-[hsl(var(--hairline))] bg-background/70 p-1">
          {(['table', 'json', 'output'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`inline-flex h-7 items-center gap-1.5 rounded px-2 text-[11px] transition-colors ${activeMode === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              onClick={() => onViewModeChange(mode)}
            >
              {mode === 'table' ? <Table2 className="h-3.5 w-3.5" /> : mode === 'json' ? <Braces className="h-3.5 w-3.5" /> : <Terminal className="h-3.5 w-3.5" />}
              {resultModeLabel(mode)}
            </button>
          ))}
        </div>
      </div>

      {state.status === 'loading' ? (
        <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />执行中</div>
      ) : activeMode === 'table' && hasRows ? (
        <div className="min-h-0 overflow-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="sticky top-0 bg-[hsl(var(--surface-sunken))] text-muted-foreground">
              <tr>
                {state.result!.columns.map((column) => <th key={column} className="px-3 py-2 font-medium">{column}</th>)}
              </tr>
            </thead>
            <tbody>
              {state.result!.rows.map((row, rowIndex) => (
                <tr
                  // eslint-disable-next-line react/no-array-index-key
                  key={rowIndex}
                  className="border-t border-[hsl(var(--hairline))] hover:bg-[hsl(var(--surface-sunken))]/70"
                >
                  {state.result!.columns.map((column, columnIndex) => (
                    <td key={`${column}-${columnIndex}`} className="max-w-[260px] truncate px-3 py-2 font-mono text-muted-foreground" title={row[columnIndex] || ''}>
                      {row[columnIndex] || 'NULL'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : activeMode === 'json' ? (
        <pre className="min-h-0 overflow-auto p-3 font-mono text-xs leading-5">
          {highlightedCode(JSON.stringify(jsonRows, null, 2), 'json')}
        </pre>
      ) : (
        <pre className={`min-h-0 overflow-auto p-3 font-mono text-xs leading-5 ${state.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
          {outputText}
        </pre>
      )}
    </div>
  );
}
interface ResourceBackupEntry {
  id: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
  runtime: string;
  database?: string;
}

function ResourceBackupsPanel({
  resource,
  permissions,
  busy,
  onCreateCloneTask,
}: {
  resource: BranchResource;
  permissions: ResourcePermissionSummary | null;
  busy: boolean;
  onCreateCloneTask: (input: ResourceCloneInput) => Promise<void>;
}): JSX.Element {
  const cloneTasks = resource.cloneTasks || [];
  const canCloneDatabase = resourcePermissionAllows(permissions, 'database-clone');
  const canConnectExisting = resourcePermissionAllows(permissions, 'database-connect-existing');
  const canCreateBackup = resourcePermissionAllows(permissions, 'backup-create');
  const canRestoreBackup = resourcePermissionAllows(permissions, 'backup-restore');
  const [backupState, setBackupState] = useState<{
    status: 'idle' | 'loading' | 'ok' | 'error';
    backups: ResourceBackupEntry[];
    message?: string;
    database?: string;
    supported?: boolean;
  }>({ status: 'idle', backups: [] });
  const [backupBusy, setBackupBusy] = useState<'manual' | 'restore' | null>(null);

  const loadBackups = useCallback(async () => {
    if (!resource.branchId || resource.kind !== 'database') {
      setBackupState({ status: 'ok', backups: [], supported: false, message: '当前资源没有分支上下文，暂不能读取备份。' });
      return;
    }
    setBackupState((current) => ({ ...current, status: 'loading', message: undefined }));
    try {
      const res = await apiRequest<{
        backups: ResourceBackupEntry[];
        database?: string;
        supported?: boolean;
        message?: string;
      }>(`/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/backups`);
      setBackupState({
        status: 'ok',
        backups: res.backups || [],
        database: res.database,
        supported: res.supported !== false,
        message: res.message,
      });
    } catch (err) {
      setBackupState({ status: 'error', backups: [], message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [resource.branchId, resource.id, resource.kind]);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

  async function createManualBackup(): Promise<void> {
    if (!resource.branchId) return;
    setBackupBusy('manual');
    try {
      await apiRequest(`/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/backups`, {
        method: 'POST',
        body: { reason: 'manual' },
      });
      await loadBackups();
    } catch (err) {
      setBackupState((current) => ({ ...current, status: 'error', message: err instanceof ApiError ? err.message : String(err) }));
    } finally {
      setBackupBusy(null);
    }
  }

  async function restoreBackup(backup: ResourceBackupEntry): Promise<void> {
    if (!resource.branchId) return;
    const confirmResourceName = window.prompt(`恢复会覆盖当前 ${resource.displayName} 数据库。请输入资源名确认：${resource.serviceName}`);
    if (!confirmResourceName) return;
    setBackupBusy('restore');
    try {
      await apiRequest(`/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/restore-backup`, {
        method: 'POST',
        body: { backupName: backup.name, confirmResourceName },
      });
      await loadBackups();
    } catch (err) {
      setBackupState((current) => ({ ...current, status: 'error', message: err instanceof ApiError ? err.message : String(err) }));
    } finally {
      setBackupBusy(null);
    }
  }

  async function createDatabaseFromBackup(backup: ResourceBackupEntry): Promise<void> {
    const targetDatabase = window.prompt(`从备份创建新的分支数据库。请输入目标数据库名：`, backup.database ? `${backup.database}_copy` : '');
    if (!targetDatabase) return;
    await onCreateCloneTask({ mode: 'restore-backup', backupName: backup.name, backupId: backup.id, targetDatabase });
    await loadBackups();
  }

  async function connectExistingDatabase(): Promise<void> {
    const connectionString = window.prompt(`连接已有 ${resource.runtime} 数据库。请输入连接串：`);
    if (!connectionString) return;
    const externalConnectionName = window.prompt('给这个外部连接起一个名称：', `${resource.serviceName}-external`) || `${resource.serviceName}-external`;
    await onCreateCloneTask({ mode: 'connect-existing', connectionString, externalConnectionName });
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="font-semibold">创建分支独立数据库</div>
          <Button type="button" size="sm" variant="outline" disabled={busy || resource.kind !== 'database' || !canCloneDatabase} title={!canCloneDatabase ? resourcePermissionReason(permissions, 'database-clone') : undefined} onClick={() => void onCreateCloneTask({ mode: 'empty' })}>
            {busy ? <Loader2 className="animate-spin" /> : <Database />}
            空库
          </Button>
        </div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          支持空库、从 main/prod 克隆、从备份恢复、连接已有数据库。克隆完成后写入必须与主库隔离。
        </div>
      </div>
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="font-semibold">{resource.runtime === 'MySQL' ? 'MySQL 快速复制' : '备份与恢复'}</div>
          <Button type="button" size="sm" variant="outline" disabled={busy || resource.kind !== 'database' || !canCloneDatabase} title={!canCloneDatabase ? resourcePermissionReason(permissions, 'database-clone') : undefined} onClick={() => void onCreateCloneTask({ mode: 'clone-main' })}>
            {busy ? <Loader2 className="animate-spin" /> : <Copy />}
            克隆 main/prod
          </Button>
        </div>
        <div className="mt-1 text-xs leading-5 text-muted-foreground">
          MySQL 小库走 mysqldump/mysqlpump；中型库走后台任务；大库预留 snapshot/provider clone。恢复覆盖当前库必须输入资源名确认。
        </div>
      </div>
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold">连接已有数据库</div>
            <div className="mt-1 text-xs leading-5 text-muted-foreground">把外部数据库连接串写入当前分支 scope，不修改主库；管理员操作会进入审计。</div>
          </div>
          <Button type="button" size="sm" variant="outline" disabled={busy || resource.kind !== 'database' || !canConnectExisting} title={!canConnectExisting ? resourcePermissionReason(permissions, 'database-connect-existing') : undefined} onClick={() => void connectExistingDatabase()}>
            {busy ? <Loader2 className="animate-spin" /> : <ExternalLink />}
            连接已有
          </Button>
        </div>
      </div>
      <div className="rounded-md border border-[hsl(var(--hairline))] px-3 py-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div>
            <div className="text-xs font-semibold text-muted-foreground">备份文件</div>
            {backupState.database ? <div className="mt-1 font-mono text-[11px] text-muted-foreground">{backupState.database}</div> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="outline" disabled={backupState.status === 'loading'} onClick={() => void loadBackups()}>
              <RefreshCw className={backupState.status === 'loading' ? 'animate-spin' : ''} />
              刷新
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={busy || backupBusy !== null || resource.kind !== 'database' || backupState.supported === false || !canCreateBackup} title={!canCreateBackup ? resourcePermissionReason(permissions, 'backup-create') : undefined} onClick={() => void createManualBackup()}>
              {backupBusy === 'manual' ? <Loader2 className="animate-spin" /> : <Database />}
              手动备份
            </Button>
          </div>
        </div>
        {backupState.status === 'loading' ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />读取备份列表</div>
        ) : backupState.status === 'error' ? (
          <div className="text-xs leading-5 text-destructive">{backupState.message}</div>
        ) : backupState.supported === false ? (
          <div className="text-xs leading-5 text-muted-foreground">{backupState.message || '当前数据库类型的资源级备份恢复待接入。'}</div>
        ) : backupState.backups.length > 0 ? (
          <div className="space-y-2">
            {backupState.backups.slice(0, 6).map((backup) => (
              <div key={backup.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded-md bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <div className="truncate font-mono" title={backup.name}>{backup.name}</div>
                  <div className="mt-0.5 text-muted-foreground">{formatBytes(backup.sizeBytes)} · {new Date(backup.createdAt).toLocaleString()}</div>
                </div>
                <span className="rounded border border-[hsl(var(--hairline))] px-2 py-0.5 text-muted-foreground">{backup.runtime}</span>
                <Button type="button" size="sm" variant="outline" disabled={busy || backupBusy !== null || !canRestoreBackup} title={!canRestoreBackup ? resourcePermissionReason(permissions, 'backup-restore') : undefined} onClick={() => void restoreBackup(backup)}>
                  {backupBusy === 'restore' ? <Loader2 className="animate-spin" /> : <RotateCw />}
                  恢复
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy || backupBusy !== null || !canRestoreBackup} title={!canRestoreBackup ? resourcePermissionReason(permissions, 'backup-restore') : undefined} onClick={() => void createDatabaseFromBackup(backup)}>
                  <Database />
                  新库
                </Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">还没有可恢复的备份文件。</div>
        )}
      </div>
      <div className="rounded-md border border-[hsl(var(--hairline))] px-3 py-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">最近任务</div>
        {cloneTasks.length > 0 ? (
          <div className="space-y-2">
            {cloneTasks.slice(0, 4).map((task) => (
              <div key={task.id} className="flex items-center justify-between gap-3 rounded-md bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <div className="font-medium">{task.mode} · {task.strategy}</div>
                  <div className="truncate text-muted-foreground">{task.progressMessage || task.status}</div>
                </div>
                <span className={`rounded border px-2 py-0.5 ${task.status === 'completed' ? 'border-emerald-500/30 text-emerald-600' : task.status === 'failed' ? 'border-destructive/30 text-destructive' : 'border-amber-500/30 text-amber-600'}`}>
                  {task.progress}%
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">还没有数据库创建或克隆任务。</div>
        )}
      </div>
    </div>
  );
}

function ResourceVariablesPanel({ resource }: { resource: BranchResource }): JSX.Element {
  return (
    <div className="grid gap-2">
      {(resource.envKeys.length > 0 ? resource.envKeys : ['RESOURCE_HOST', 'RESOURCE_PORT']).map((key) => (
        <div key={key} className="flex items-center justify-between gap-3 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2">
          <code className="font-mono text-xs">{key}</code>
          <span className="text-xs text-muted-foreground">可注入依赖应用</span>
        </div>
      ))}
    </div>
  );
}

function ResourceMetricsPanel({ resource }: { resource: BranchResource }): JSX.Element {
  const [state, setState] = useState<ResourceMetricsState>({ status: 'idle' });

  const loadMetrics = useCallback(async () => {
    if (!resource.branchId) {
      setState({ status: 'error', message: '资源缺少所属分支，无法读取指标。' });
      return;
    }
    setState((current) => current.status === 'ok' ? current : { status: 'loading' });
    try {
      const data = await apiRequest<ResourceMetricsResponse>(
        `/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/metrics`,
      );
      setState({ status: 'ok', data });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [resource.branchId, resource.id]);

  useEffect(() => {
    void loadMetrics();
    const timer = window.setInterval(() => void loadMetrics(), 5000);
    return () => window.clearInterval(timer);
  }, [loadMetrics]);

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        <CdsLogoLoader size="sm" className="mb-2 justify-center" inline={false} />
        正在读取 {resource.displayName} 指标…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>读取指标失败：{state.message}</span>
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => void loadMetrics()}>
            <RefreshCw />重试
          </Button>
        </div>
      </div>
    );
  }

  const { data } = state;
  const { stats } = data;
  if (!stats) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="truncate font-mono">{data.containerName || resource.containerName || resource.serviceName}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => void loadMetrics()}>
            <RefreshCw />刷新
          </Button>
        </div>
        <div className="rounded-md border border-dashed border-[hsl(var(--hairline))] bg-card px-5 py-8 text-center text-sm text-muted-foreground">
          当前状态为 {resourceStatusLabel(resource.status)}，没有可读的实时容器指标。
        </div>
      </div>
    );
  }

  const metrics = [
    { label: 'CPU', value: `${stats.cpuPercent.toFixed(1)}%` },
    { label: '内存', value: `${stats.memPercent.toFixed(1)}%`, sub: `${formatBytes(stats.memUsedBytes)} / ${formatBytes(stats.memLimitBytes)}` },
    { label: '网络入站', value: formatBytes(stats.netRxBytes) },
    { label: '网络出站', value: formatBytes(stats.netTxBytes) },
    { label: '磁盘读取', value: formatBytes(stats.blockReadBytes) },
    { label: '磁盘写入', value: formatBytes(stats.blockWriteBytes) },
    { label: 'PIDs', value: String(stats.pids) },
    { label: '采集时间', value: new Date(data.ts).toLocaleTimeString() },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="truncate font-mono" title={data.containerName || undefined}>{data.containerName || resource.containerName || resource.serviceName}</span>
        <Button type="button" size="sm" variant="ghost" onClick={() => void loadMetrics()}>
          <RefreshCw />刷新
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {metrics.map((metric) => (
          <div key={metric.label} className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-3">
            <div className="text-xs text-muted-foreground">{metric.label}</div>
            <div className="mt-1 font-mono text-sm">{metric.value}</div>
            {'sub' in metric && metric.sub ? <div className="mt-0.5 text-[10px] text-muted-foreground">{metric.sub}</div> : null}
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <MetricBar label="CPU" value={stats.cpuPercent} unit="%" max={100} />
        <MetricBar label="内存" value={stats.memPercent} unit="%" max={100} sub={`${formatBytes(stats.memUsedBytes)} / ${formatBytes(stats.memLimitBytes)}`} />
      </div>
    </div>
  );
}

function ResourceLogsPanel({ resource }: { resource: BranchResource }): JSX.Element {
  const [state, setState] = useState<ResourceLogsState>({ status: 'idle' });

  const loadLogs = useCallback(async () => {
    if (!resource.branchId) {
      setState({ status: 'error', message: '资源缺少所属分支，无法读取日志。' });
      return;
    }
    setState((current) => current.status === 'ok' ? current : { status: 'loading' });
    try {
      const data = await apiRequest<ResourceLogsResponse>(
        `/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/logs?tail=200`,
      );
      setState({ status: 'ok', data });
    } catch (err) {
      setState({ status: 'error', message: err instanceof ApiError ? err.message : String(err) });
    }
  }, [resource.branchId, resource.id]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        <CdsLogoLoader size="sm" className="mb-2 justify-center" inline={false} />
        正在读取 {resource.displayName} 日志…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>读取日志失败：{state.message}</span>
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={() => void loadLogs()}>
            <RefreshCw />重试
          </Button>
        </div>
      </div>
    );
  }

  const logs = normalizeContainerLogsForDisplay(state.data.logs || '');
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="min-w-0">
          <div className="truncate font-mono" title={state.data.containerName}>{state.data.containerName}</div>
          <div>最近 {state.data.tail} 行{state.data.masked ? ' · 已脱敏' : ''}</div>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => void loadLogs()}>
          <RefreshCw />刷新
        </Button>
      </div>
      {logs ? (
        <pre className="max-h-[420px] overflow-auto rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] px-3 py-3 font-mono text-[11px] leading-5 text-foreground">
          {logs}
        </pre>
      ) : (
        <div className={DETAIL_LOG_EMPTY_CLASS}>
          该资源暂时没有容器日志。
        </div>
      )}
    </div>
  );
}

interface ResourceAuditLog {
  id: string;
  at: string;
  type: string;
  actor?: string;
  note?: string;
  result?: 'success' | 'failed' | 'pending';
}

function ResourceSettingsPanel({ resource, permissions }: { resource: BranchResource; permissions: ResourcePermissionSummary | null }): JSX.Element {
  const [auditState, setAuditState] = useState<{ status: 'idle' | 'loading' | 'ok' | 'error'; logs: ResourceAuditLog[]; message?: string }>({ status: 'idle', logs: [] });
  const [dangerBusy, setDangerBusy] = useState<'clear' | 'delete' | 'write-sql' | null>(null);
  const [dangerSql, setDangerSql] = useState('');
  const [dangerMessage, setDangerMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!resource.branchId) return;
    let cancelled = false;
    setAuditState({ status: 'loading', logs: [] });
    apiRequest<{ logs: ResourceAuditLog[] }>(`/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/audit`)
      .then((res) => {
        if (!cancelled) setAuditState({ status: 'ok', logs: res.logs || [] });
      })
      .catch((err) => {
        if (!cancelled) setAuditState({ status: 'error', logs: [], message: err instanceof ApiError ? err.message : String(err) });
      });
    return () => { cancelled = true; };
  }, [resource.branchId, resource.id]);

  async function runDangerAction(action: 'clear' | 'delete' | 'write-sql'): Promise<void> {
    if (!resource.branchId) return;
    const confirmResourceName = window.prompt(`危险操作会影响 ${resource.displayName}。请输入资源名确认：${resource.serviceName}`);
    if (!confirmResourceName) return;
    setDangerBusy(action);
    setDangerMessage(null);
    try {
      if (action === 'clear') {
        await apiRequest(`/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/clear-data`, {
          method: 'POST',
          body: { confirmResourceName },
        });
        setDangerMessage('数据已清空，操作前备份和审计日志已记录。');
      } else if (action === 'delete') {
        await apiRequest(`/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}`, {
          method: 'DELETE',
          body: { confirmResourceName },
        });
        setDangerMessage('分支数据库已删除，连接变量已从分支 scope 移除。');
      } else {
        await apiRequest(`/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/data/query-write`, {
          method: 'POST',
          body: { sql: dangerSql, confirmResourceName },
        });
        setDangerMessage('写 SQL 已执行并记录审计日志。');
      }
      const res = await apiRequest<{ logs: ResourceAuditLog[] }>(`/api/branches/${encodeURIComponent(resource.branchId)}/resources/${encodeURIComponent(resource.id)}/audit`);
      setAuditState({ status: 'ok', logs: res.logs || [] });
    } catch (err) {
      setDangerMessage(err instanceof ApiError ? err.message : String(err));
    } finally {
      setDangerBusy(null);
    }
  }

  const supportsWriteSql = resource.runtime === 'MySQL' || resource.runtime === 'PostgreSQL';
  const supportsClear = resource.kind === 'database' || resource.kind === 'cache';
  const supportsDelete = resource.kind === 'database' && resource.runtime !== 'Redis';
  const canClearData = resourcePermissionAllows(permissions, 'data-clear');
  const canDeleteResource = resourcePermissionAllows(permissions, 'resource-delete');
  const canWriteSql = resourcePermissionAllows(permissions, 'data-write');

  return (
    <div className="space-y-3 text-sm">
      <div className={`rounded-md border px-3 py-2 text-xs leading-5 ${permissions ? 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 text-muted-foreground' : 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>
        当前权限：{permissions ? permissions.role : '加载中'}。生产相关资源：{permissions?.productionLike ? '是' : '否'}。
        {permissions?.role === 'member' ? '普通成员只能查看连接信息，写入类按钮会被禁用。' : null}
      </div>
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
        危险操作保护：删除、清空数据、恢复覆盖、写 SQL、开启生产库公网访问必须二次确认，并记录操作者、时间、资源和结果。
      </div>
      {resource.source === 'infra' ? (
        <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-destructive">危险操作</div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">后端会校验管理员权限、资源名确认，并先创建安全备份。</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={!supportsClear || dangerBusy !== null || !canClearData} title={!canClearData ? resourcePermissionReason(permissions, 'data-clear') : undefined} onClick={() => void runDangerAction('clear')}>
                {dangerBusy === 'clear' ? <Loader2 className="animate-spin" /> : <RotateCw />}
                清空数据
              </Button>
              <Button type="button" size="sm" variant="destructive" disabled={!supportsDelete || dangerBusy !== null || !canDeleteResource} title={!canDeleteResource ? resourcePermissionReason(permissions, 'resource-delete') : undefined} onClick={() => void runDangerAction('delete')}>
                {dangerBusy === 'delete' ? <Loader2 className="animate-spin" /> : <Trash2 />}
                删除分支库
              </Button>
            </div>
          </div>
          {supportsWriteSql ? (
            <div className="grid gap-2">
              <textarea
                value={dangerSql}
                onChange={(event) => setDangerSql(event.target.value)}
                className="min-h-[84px] resize-y rounded-md border border-destructive/25 bg-background px-3 py-2 font-mono text-xs outline-none focus:border-destructive"
                placeholder="INSERT / UPDATE / DELETE / CREATE / ALTER / DROP / TRUNCATE / REPLACE"
                spellCheck={false}
              />
              <div className="flex justify-end">
                <Button type="button" size="sm" variant="destructive" disabled={!dangerSql.trim() || dangerBusy !== null || !canWriteSql} title={!canWriteSql ? resourcePermissionReason(permissions, 'data-write') : undefined} onClick={() => void runDangerAction('write-sql')}>
                  {dangerBusy === 'write-sql' ? <Loader2 className="animate-spin" /> : <Play />}
                  执行写 SQL
                </Button>
              </div>
            </div>
          ) : null}
          {dangerMessage ? <div className="text-xs leading-5 text-muted-foreground">{dangerMessage}</div> : null}
        </div>
      ) : null}
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2">
        权限：成员查看连接信息，开发者可重启和开启临时访问，管理员可删除资源、恢复备份和修改公网策略。
      </div>
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2">
        审计：资源创建、删除、重启、外部访问、数据库克隆、备份恢复、凭据重置都进入审计日志。
      </div>
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-3">
        <div className="mb-2 text-xs font-semibold text-muted-foreground">最近审计</div>
        {auditState.status === 'loading' ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />加载中</div>
        ) : auditState.status === 'error' ? (
          <div className="text-xs text-destructive">{auditState.message}</div>
        ) : auditState.logs.length > 0 ? (
          <div className="space-y-2">
            {auditState.logs.slice(0, 6).map((log) => (
              <div key={log.id} className="rounded-md border border-[hsl(var(--hairline))] px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">{log.type}</span>
                  <span className="font-mono text-muted-foreground">{log.at}</span>
                </div>
                <div className="mt-1 text-muted-foreground">{log.note || '-'}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">当前资源还没有审计事件。</div>
        )}
      </div>
    </div>
  );
}

function ServiceLogsPanel({
  service,
  state,
}: {
  service: ServiceState | null;
  state: ServiceLogsState;
}): JSX.Element {
  const logs = state.status === 'ok' ? (state.logs || '') : '';
  const isCurrent = service && state.profileId === service.profileId;
  const displayLogs = isCurrent ? logs : '';
  const visibleLogs = normalizeContainerLogsForDisplay(displayLogs);
  const serviceLogViewportClass = 'min-h-0 flex-1 overflow-auto';

  if (!service) {
    return <div className={DETAIL_LOG_EMPTY_CLASS}>选择一个服务查看容器日志。</div>;
  }

  return (
    <div className="h-[424px] min-w-0 overflow-hidden p-4 pt-3">
      <div className="flex h-full min-h-0 flex-col rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45">
        <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
          <div className="mb-2 flex shrink-0 items-center justify-between text-xs text-muted-foreground">
            <span>容器详情日志</span>
            {state.status === 'loading' && isCurrent ? <span>读取中...</span> : null}
          </div>
          {service.errorMessage ? (
            <div className="mb-2 shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
              {service.errorMessage}
            </div>
          ) : null}
          {state.status === 'error' && isCurrent ? (
            <div className={`${serviceLogViewportClass} flex items-center justify-center rounded-md border border-destructive/30 bg-destructive/10 px-3 text-center text-xs leading-5 text-destructive`}>
              {state.message}
            </div>
          ) : (
            <pre className={`${serviceLogViewportClass} overflow-auto whitespace-pre-wrap rounded-md border border-[hsl(var(--hairline))] bg-black/35 p-3 font-mono text-[11px] leading-5 text-muted-foreground`}>
              {state.status === 'loading' && isCurrent
                ? '正在读取 docker logs...'
                : visibleLogs || '暂无容器日志。若容器不存在或已被清理，请重新部署该服务。'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function CopyServiceLogsButton({
  service,
  state,
}: {
  service: ServiceState | null;
  state: ServiceLogsState;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const isCurrent = service && state.profileId === service.profileId;
  const logs = state.status === 'ok' && isCurrent ? normalizeContainerLogsForDisplay(state.logs || '') : '';

  async function copyLogs(): Promise<void> {
    if (!service) return;
    const text = [
      `${service.profileId} ${statusLabel(service.status)} :${service.hostPort || '?'}`,
      service.containerName,
      service.errorMessage ? `error: ${service.errorMessage}` : '',
      '',
      logs,
    ].filter(Boolean).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[hsl(var(--hairline))] px-2 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
      onClick={() => void copyLogs()}
      disabled={!service}
    >
      <Copy className="h-3.5 w-3.5" />
      {copied ? '已复制' : '复制'}
    </button>
  );
}

function HttpLogsPanel({ events, query }: { events: DrawerActivityEvent[]; query: string }): JSX.Element {
  const rows = events.filter((event) => textMatchesQuery([
    event.method || '',
    event.path || '',
    String(event.status || ''),
    event.label || '',
    event.profileId || '',
  ].join(' '), query));

  if (rows.length === 0) {
    return (
      <div className={DETAIL_LOG_EMPTY_CLASS}>
        {query ? '没有匹配的 HTTP 访问日志。' : '还没有捕获到这个分支的 HTTP 请求。打开预览后，请求会出现在这里。'}
      </div>
    );
  }

  return (
    <div className={`${DETAIL_LOG_VIEWPORT_CLASS} p-3`}>
      <div className="space-y-2">
        {rows.map((event, index) => {
          const ok = (event.status || 0) < 400;
          const duration = typeof event.duration === 'number'
            ? event.duration < 1000 ? `${event.duration}ms` : `${(event.duration / 1000).toFixed(1)}s`
            : '-';
          return (
            <div key={`${event.id || index}-${event.ts || ''}`} className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2 text-xs">
              <span className="font-mono text-muted-foreground">{event.method || '-'}</span>
              <span className={`rounded border px-1.5 py-0.5 ${ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600' : 'border-destructive/30 bg-destructive/10 text-destructive'}`}>
                {event.status || '-'}
              </span>
              <span className="min-w-0 truncate font-mono text-muted-foreground" title={event.path || event.label || ''}>
                {event.label || event.path || '-'}
              </span>
              <span className="font-mono text-muted-foreground">{duration}</span>
              <span className="text-muted-foreground">{event.ts ? new Date(event.ts).toLocaleTimeString() : ''}</span>
              {!ok && (event.errorSummary || event.requestId) ? (
                <div className="col-span-5 rounded border border-destructive/25 bg-destructive/10 px-2 py-1 font-mono text-[11px] leading-5 text-destructive">
                  {event.errorSummary || '后端未返回错误摘要'}
                  {event.requestId ? <span className="ml-2 text-destructive/75">requestId={event.requestId}</span> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// 同 DeploymentCard：保留供后续可能的引用，Week 4.7 起本抽屉
// 通过 legacyLogToDeploymentItem 把 OperationLog 投影成 BranchDeploymentItem
// 后再走 ActiveDeployment / HistoryRow 渲染。
export function LegacyDeploymentCard({ log, onOpenLogs }: { log: OperationLog; onOpenLogs: (log: OperationLog) => void }): JSX.Element {
  const failure = logFailureReason(log);
  const latest = log.events.slice(-2).map(eventText).join('\n') || '(no log lines)';
  return (
    <button
      type="button"
      className={`block w-full rounded-md border bg-[hsl(var(--surface-sunken))]/50 px-4 py-3 text-left transition-colors hover:border-primary/45 hover:bg-[hsl(var(--surface-raised))]/45 ${log.status === 'error' ? 'border-destructive/35' : 'border-[hsl(var(--hairline))]'}`}
      onClick={() => onOpenLogs(log)}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={`rounded border px-2 py-0.5 ${statusClass(log.status)}`}>{statusLabel(log.status)}</span>
        <span className="font-mono">{log.type}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{failure || latest}</span>
        <span className="shrink-0 text-muted-foreground">{new Date(log.startedAt).toLocaleString()}</span>
        <span className="shrink-0 text-primary">查看日志</span>
      </div>
      {failure ? (
        <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
          {failure}
        </div>
      ) : null}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Phase A — Variables panel(2026-05-04)
//
// 用户反馈:抽屉里「变量」tab 还是 placeholder。Railway / Vercel 都有这块,
// 是判断「我配的 env 有没有真的被 deploy 用上」最直接的视图。
//
// 设计选择:
//   - 只读(编辑入口仍然在「项目设置」,跳转一下不会让用户绕远)
//   - 默认 redact secret,单条「显示」按钮按需解锁(Vercel 同款)
//   - 来源 chip:project / global / mirror / cds-derived / cds-builtin
//   - 搜索框过滤 key
// ──────────────────────────────────────────────────────────────────────────

function VariablesPanel({
  state,
  revealedValues,
  onToggleReveal,
  onCopySecret,
  query,
  onQuery,
  onRefresh,
  branchId,
  projectId,
  editorOpen,
  onToggleEditor,
  onEnvChanged,
  onToast,
}: {
  state: EffectiveEnvState;
  /** 已 reveal 的 secret key → 明文。未 reveal 的不在 map 里。 */
  revealedValues: Map<string, string>;
  onToggleReveal: (key: string) => void | Promise<void>;
  onCopySecret: (key: string) => void | Promise<void>;
  query: string;
  onQuery: (q: string) => void;
  onRefresh: () => void;
  branchId: string;
  projectId: string;
  editorOpen: boolean;
  onToggleEditor: () => void;
  onEnvChanged: () => void;
  onToast: (message: string) => void;
}): JSX.Element {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <section className="rounded-md border border-[hsl(var(--hairline))] bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        <CdsLogoLoader size="sm" className="mb-2 justify-center" inline={false} />
        正在读取该分支的生效环境变量…
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="rounded-md border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>读取失败:{state.message}</span>
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={onRefresh}>
            <RefreshCw />重试
          </Button>
        </div>
      </section>
    );
  }
  const data = state.data;
  const branchOverrideCount = data.bySource?.branch ?? 0;
  const filtered = query.trim()
    ? data.variables.filter((v) => v.key.toLowerCase().includes(query.trim().toLowerCase()))
    : data.variables;

  return (
    <section className="rounded-md border border-[hsl(var(--hairline))] bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b border-[hsl(var(--hairline))] px-4 py-3">
        <span className="text-sm font-medium">生效环境变量</span>
        <span className="group/help relative inline-flex">
          <button
            type="button"
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="环境变量作用范围说明"
          >
            <HelpCircle className="h-3.5 w-3.5" />
          </button>
          <span className="pointer-events-none absolute left-0 top-7 z-20 hidden w-72 rounded-md border border-[hsl(var(--hairline))] bg-popover p-3 text-xs leading-5 text-popover-foreground shadow-xl group-hover/help:block group-focus-within/help:block">
            这里显示本分支部署时最终进入容器的变量。点击“编辑本分支”只会写入当前分支覆盖，不会修改项目变量；重新部署本分支后生效。
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          共 {data.total ?? 0} 个 · 分支覆盖 {branchOverrideCount} · 项目 {data.bySource?.project ?? 0} · 全局 {data.bySource?.global ?? 0} ·
          镜像 {data.bySource?.mirror ?? 0} · CDS 内置 {(data.bySource?.['cds-builtin'] ?? 0) + (data.bySource?.['cds-derived'] ?? 0)}
        </span>
        <Button type="button" size="sm" variant={editorOpen ? 'secondary' : 'ghost'} className="ml-auto" onClick={onToggleEditor}>
          <ExternalLink />编辑本分支
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
          <RefreshCw />刷新
        </Button>
      </header>
      <div className="border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/35 px-4 py-2 text-[11px] leading-5 text-muted-foreground">
        当前编辑范围:<span className="mx-1 rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-700 dark:text-amber-300">仅本分支</span>
        。分支覆盖优先级最高，左侧出现橙色“分支覆盖”即表示该 key 被当前分支改写。
        项目级默认值仍在 <a className="text-primary underline-offset-2 hover:underline" href={`/settings/${encodeURIComponent(projectId)}?tab=env`}>项目环境变量</a> 中维护。
      </div>
      {editorOpen ? (
        <div className="border-b border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/18 px-4 py-3">
          <EnvEditor
            scope={branchId}
            title="本分支环境变量覆盖"
            description="这些变量只写入当前分支，优先级高于项目和全局变量。保存后需要重新部署本分支，容器才会使用新值。"
            emptyDescription="当前分支还没有覆盖变量。新增后只影响本分支。"
            onToast={onToast}
            onChanged={onEnvChanged}
            topContent={(
              <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">
                保存目标是分支 scope <code className="font-mono">{branchId}</code>，不会写入项目环境变量。
              </div>
            )}
          />
        </div>
      ) : null}
      <div className="border-b border-[hsl(var(--hairline))] px-4 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="过滤 key…"
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-sm outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring"
            spellCheck={false}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">
          {data.total === 0 ? '没有任何变量(连 CDS_HOST 都没?这不太正常,联系管理员)' : '没有匹配的 key'}
        </div>
      ) : (
        <ul className="divide-y divide-[hsl(var(--hairline))]">
          {filtered.map((v) => (
            <EnvRow
              key={v.key}
              entry={v}
              revealedPlain={revealedValues.get(v.key)}
              onToggleReveal={() => { void onToggleReveal(v.key); }}
              onCopySecret={() => { void onCopySecret(v.key); }}
            />
          ))}
        </ul>
      )}

      <footer className="border-t border-[hsl(var(--hairline))] px-4 py-2 text-[11px] leading-5 text-muted-foreground">
        优先级:project &gt; global &gt; mirror &gt; cds-derived &gt; cds-builtin。同名 key 后写覆盖前写。
        敏感值默认隐藏,点眼睛图标按条解锁。
      </footer>
    </section>
  );
}

function isSensitiveEnvKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (/password|secret|token|credential|private|jwt/.test(normalized)) return true;
  const parts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return parts.includes('pat') || parts.includes('key');
}

function maskedEnvValue(entry: EffectiveEnvVar, isSecretFromKey: boolean): string {
  if (entry.isSecret) return entry.value || '••••';
  if (!isSecretFromKey) return entry.value;
  const length = entry.valueLength ?? entry.value.length;
  return length > 0 ? `•••••••• (${length} 字符)` : '••••••••';
}

function EnvRow({
  entry,
  revealedPlain,
  onToggleReveal,
  onCopySecret,
}: {
  entry: EffectiveEnvVar;
  /** 已 reveal 的明文。undefined 表示尚未 reveal(secret)或非 secret。 */
  revealedPlain: string | undefined;
  onToggleReveal: () => void;
  onCopySecret: () => void;
}): JSX.Element {
  const effectiveIsSecret = entry.isSecret || isSensitiveEnvKey(entry.key);
  const isRevealed = revealedPlain !== undefined;
  // 后端 isSecret=false 但 key 看起来敏感时,列表里的 entry.value 可能是明文;
  // 未 reveal 前必须用前端 mask 兜底,避免 GITHUB_PAT 等直接暴露。
  const displayValue = effectiveIsSecret
    ? (isRevealed ? (revealedPlain as string) : entry.value)
    : entry.value;
  const safeDisplayValue = effectiveIsSecret && !isRevealed
    ? maskedEnvValue(entry, !entry.isSecret)
    : displayValue;
  return (
    <li className="flex items-center gap-3 px-4 py-2 text-sm">
      <span className={`inline-flex h-5 shrink-0 items-center rounded-md border px-1.5 text-[10px] font-medium ${envSourceClass(entry.source)}`}>
        {entry.source === 'branch' ? <AlertCircle className="mr-1 h-3 w-3" aria-hidden /> : null}
        {envSourceLabel(entry.source)}
      </span>
      <span className="min-w-0 max-w-[35%] shrink-0 truncate font-mono text-xs" title={entry.key}>
        {entry.key}
      </span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
        title={effectiveIsSecret && !isRevealed ? '点击右侧眼睛查看真实值' : safeDisplayValue}
      >
        {safeDisplayValue}
      </span>
      {effectiveIsSecret ? (
        <button
          type="button"
          onClick={onToggleReveal}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground"
          title={isRevealed ? '隐藏' : '显示真实值'}
          aria-label={isRevealed ? '隐藏值' : '显示值'}
        >
          {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => {
          // secret 走 reveal 端点取明文再复制,non-secret 直接 entry.value
          if (effectiveIsSecret) onCopySecret();
          else void navigator.clipboard.writeText(entry.value);
        }}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[hsl(var(--surface-sunken))] hover:text-foreground"
        title="复制原值"
        aria-label="复制"
      >
        <Copy className="h-4 w-4" />
      </button>
    </li>
  );
}

function envSourceLabel(s: EnvSource): string {
  return ({
    branch: '分支覆盖', project: '项目', global: '全局', mirror: '镜像',
    'cds-derived': 'CDS派生', 'cds-builtin': 'CDS内置',
  } as Record<EnvSource, string>)[s];
}

function envSourceClass(s: EnvSource): string {
  switch (s) {
    case 'branch':
      return 'border-amber-500/45 bg-amber-500/15 text-amber-700 dark:text-amber-300';
    case 'project':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'global':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300';
    case 'mirror':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'cds-derived':
    case 'cds-builtin':
      return 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground';
  }
}

function compactProfileOverride(override: BuildProfileOverride): BuildProfileOverride {
  const next: BuildProfileOverride = {};
  if (override.dockerImage?.trim()) next.dockerImage = override.dockerImage.trim();
  if (override.command?.trim()) next.command = override.command.trim();
  if (override.containerWorkDir?.trim()) next.containerWorkDir = override.containerWorkDir.trim();
  if (typeof override.containerPort === 'number' && override.containerPort > 0) next.containerPort = override.containerPort;
  if (override.env && Object.keys(override.env).length > 0) next.env = override.env;
  if (override.pathPrefixes && override.pathPrefixes.length > 0) next.pathPrefixes = override.pathPrefixes;
  if (override.resources && Object.keys(override.resources).length > 0) next.resources = override.resources;
  if (override.activeDeployMode !== undefined) next.activeDeployMode = override.activeDeployMode.trim();
  if (override.startupSignal?.trim()) next.startupSignal = override.startupSignal.trim();
  if (override.notes?.trim()) next.notes = override.notes.trim();
  return next;
}

function hasProfileOverrideFields(override: BuildProfileOverride): boolean {
  return Object.keys(compactProfileOverride(override)).length > 0;
}

function runtimeClass(kind?: 'source' | 'release' | 'mixed'): string {
  if (kind === 'release') return 'border-emerald-400/35 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300';
  if (kind === 'mixed') return 'border-violet-400/35 bg-violet-400/10 text-violet-700 dark:text-violet-300';
  return 'border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))] text-muted-foreground';
}

// ──────────────────────────────────────────────────────────────────────────
// Phase C — Settings panel(2026-05-04)
//
// 把分散在卡片 hover / kebab 菜单 / 详情页脚部的 per-branch 操作收口到
// 这一个面板。所有 endpoint 都是已存在的(POST /deploy / /pull / /stop / /reset
// + DELETE /branches/:id),不引入新 API,只重新组织。
//
// 用户场景:进入分支抽屉看完日志/服务/部署后,直接在「设置」tab 点重新部署
// 或停止 — 不再需要关抽屉回卡片找按钮。
// ──────────────────────────────────────────────────────────────────────────

function SettingsPanel({
  branch,
  projectId,
  busy,
  profileState,
  modeSavingProfileId,
  confirmDelete,
  onConfirmDelete,
  onRunAction,
  onSetProfileDeployMode,
}: {
  branch: BranchDetailData | null;
  projectId: string;
  busy: 'deploy' | 'restart' | 'pull' | 'stop' | 'reset' | 'delete' | null;
  profileState: ProfileOverridesState;
  modeSavingProfileId: string | null;
  confirmDelete: boolean;
  onConfirmDelete: (next: boolean) => void;
  onRunAction: (
    action: 'deploy' | 'restart' | 'pull' | 'stop' | 'reset' | 'delete',
    label: string,
  ) => void;
  onSetProfileDeployMode: (profile: ProfileRow, mode: string) => void;
}): JSX.Element {
  if (!branch) {
    return (
      <section className="rounded-md border border-[hsl(var(--hairline))] bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        正在加载分支信息…
      </section>
    );
  }
  const isRunning = branch.status === 'running';
  const isError = branch.status === 'error';
  const isAnyBusy = busy !== null;
  const runtime = branch.deployRuntime;

  return (
    <section className="space-y-4">
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              本分支运行模式
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              这里写入当前分支的容器覆盖，不会修改项目 BuildProfile 或其它分支。
            </div>
          </div>
          <span
            className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs font-medium ${runtimeClass(runtime?.kind)}`}
            title={runtime?.title || '当前分支使用源码热加载/默认构建模式'}
          >
            {runtime?.kind === 'release' || runtime?.kind === 'mixed' ? <Rocket className="h-3 w-3" /> : <GitBranch className="h-3 w-3" />}
            {runtime?.label || '源码'}
          </span>
        </div>
        {profileState.status === 'loading' || profileState.status === 'idle' ? (
          <div className="text-sm text-muted-foreground">正在加载容器模式…</div>
        ) : null}
        {profileState.status === 'error' ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {profileState.message}
          </div>
        ) : null}
        {profileState.status === 'ok' ? (
          <div className="space-y-2">
            {profileState.profiles.length === 0 ? (
              <div className="text-sm text-muted-foreground">当前项目没有可切换的容器配置。</div>
            ) : null}
            {profileState.profiles.map((profile) => {
              const deployModes = profile.baseline.deployModes || profile.effective?.deployModes || {};
              const entries = Object.entries(deployModes);
              const hasBranchModeOverride = profile.override?.activeDeployMode !== undefined;
              const activeMode = hasBranchModeOverride
                ? (profile.override?.activeDeployMode || '')
                : (profile.effective?.activeDeployMode || '');
              return (
                <div key={profile.profileId} className="flex flex-wrap items-center gap-2 rounded-md border border-[hsl(var(--hairline))] bg-[hsl(var(--surface-sunken))]/45 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{profile.profileName || profile.profileId}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-mono">{profile.profileId}</span>
                      <span className={`rounded border px-1.5 py-0.5 ${hasBranchModeOverride ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'border-[hsl(var(--hairline))]'}`}>
                        {hasBranchModeOverride ? '本分支覆盖' : '继承默认'}
                      </span>
                    </div>
                  </div>
                  <select
                    className="h-9 min-w-[170px] rounded-md border border-input bg-background px-3 text-sm"
                    value={activeMode}
                    onChange={(event) => onSetProfileDeployMode(profile, event.target.value)}
                    disabled={entries.length === 0 || modeSavingProfileId === profile.profileId}
                    title="只切换当前分支的这个容器"
                  >
                    <option value="">热加载 / 源码</option>
                    {entries.map(([modeId, mode]) => (
                      <option key={modeId} value={modeId}>
                        {mode.label || modeId}
                      </option>
                    ))}
                  </select>
                  {modeSavingProfileId === profile.profileId ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* 主操作 */}
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          常用操作
        </div>
        <div className="grid grid-cols-3 gap-2">
          <SettingsActionButton
            icon={<Play />}
            label="重新部署"
            onClick={() => onRunAction('deploy', '重新部署')}
            busy={busy === 'deploy'}
            disabled={isAnyBusy}
            primary
          />
          <SettingsActionButton
            icon={<RefreshCw />}
            label="拉取最新"
            onClick={() => onRunAction('pull', '拉取最新')}
            busy={busy === 'pull'}
            disabled={isAnyBusy}
          />
          <SettingsActionButton
            icon={<Square />}
            label="停止运行"
            onClick={() => onRunAction('stop', '停止运行')}
            busy={busy === 'stop'}
            disabled={isAnyBusy || !isRunning}
            tooltip={!isRunning ? '当前未运行' : undefined}
          />
        </div>
      </div>

      {/* 异常恢复 */}
      {isError ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-sm text-amber-700 dark:text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>分支处于异常状态。修代码后重新部署,或先重置异常清空错误标记。</span>
          </div>
          <SettingsActionButton
            icon={<RotateCw />}
            label="重置异常状态"
            onClick={() => onRunAction('reset', '重置异常')}
            busy={busy === 'reset'}
            disabled={isAnyBusy}
            inline
          />
        </div>
      ) : null}

      {/* 元信息 */}
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3 text-sm">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          元信息
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-muted-foreground">分支名</dt>
          <dd className="truncate font-mono text-xs">{branch.branch}</dd>
          <dt className="text-muted-foreground">CDS 分支 id</dt>
          <dd className="truncate font-mono text-xs">{branch.id}</dd>
          <dt className="text-muted-foreground">所属项目</dt>
          <dd className="truncate text-xs">{projectId}</dd>
          <dt className="text-muted-foreground">服务数</dt>
          <dd className="text-xs">{Object.keys(branch.services || {}).length}</dd>
        </dl>
      </div>

      {/* 跳转 */}
      <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          配置入口
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={`/settings/${encodeURIComponent(projectId)}`}>
              <Settings />
              项目设置
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost" className="text-muted-foreground">
            <a href={`/settings/${encodeURIComponent(projectId)}?tab=env`}>
              环境变量
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost" className="text-muted-foreground">
            <a href={`/settings/${encodeURIComponent(projectId)}?tab=build`}>
              构建配置
            </a>
          </Button>
          <Button asChild size="sm" variant="ghost" className="text-muted-foreground">
            <a href={`/settings/${encodeURIComponent(projectId)}?tab=routing`}>
              路由规则
            </a>
          </Button>
        </div>
      </div>

      {/* 危险操作 */}
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          危险操作
        </div>
        {confirmDelete ? (
          <div className="space-y-2">
            <div className="text-sm text-destructive">
              将停止 {Object.keys(branch.services || {}).length} 个服务并删除该分支的工作区。**git 历史不会被删**(只是 CDS 端忘记这个分支)。继续?
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => onRunAction('delete', '删除分支')}
                disabled={isAnyBusy}
              >
                {busy === 'delete' ? <Loader2 className="animate-spin" /> : <Trash2 />}
                确认删除
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onConfirmDelete(false)}
                disabled={isAnyBusy}
              >
                取消
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => onConfirmDelete(true)}
            disabled={isAnyBusy}
          >
            <Trash2 />
            删除分支
          </Button>
        )}
      </div>
    </section>
  );
}

function SettingsActionButton({
  icon,
  label,
  onClick,
  busy,
  disabled,
  primary,
  inline,
  tooltip,
}: {
  icon: JSX.Element;
  label: string;
  onClick: () => void;
  busy: boolean;
  disabled: boolean;
  primary?: boolean;
  inline?: boolean;
  tooltip?: string;
}): JSX.Element {
  return (
    <Button
      type="button"
      variant={primary ? 'default' : 'outline'}
      size={inline ? 'sm' : 'default'}
      onClick={onClick}
      disabled={disabled}
      title={tooltip}
      className={inline ? '' : 'flex h-auto flex-col items-center justify-center gap-1.5 py-3'}
    >
      {busy ? <Loader2 className="animate-spin" /> : icon}
      <span className={inline ? '' : 'text-xs'}>{label}</span>
    </Button>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Phase B — Metrics panel(2026-05-04)
//
// 5s 轮询 docker stats,每 service 一行卡片:CPU% + Mem%(条形)+
// Net rx/tx rate(数字),最右一个 60 点 SVG sparkline(过去 5 分钟 CPU 趋势)。
// 内联 SVG sparkline = 30 行,不引入 recharts(~50KB gzip)。
// 不持久化(关抽屉就丢)— 这是观测视图,不是审计。
// ──────────────────────────────────────────────────────────────────────────

function pushRing(
  series: MetricSeries,
  cpu: number,
  mem: number,
  rxRate: number,
  txRate: number,
): MetricSeries {
  const trim = (arr: number[], v: number): number[] => {
    const next = [...arr, v];
    return next.length > METRIC_RING_SIZE ? next.slice(next.length - METRIC_RING_SIZE) : next;
  };
  return {
    cpu: trim(series.cpu, cpu),
    mem: trim(series.mem, mem),
    rxRate: trim(series.rxRate, rxRate),
    txRate: trim(series.txRate, txRate),
  };
}

function MetricsPanel({
  state,
  series,
  onRefresh,
}: {
  state: MetricsState;
  series: Record<string, MetricSeries>;
  onRefresh: () => void;
}): JSX.Element {
  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <section className="rounded-md border border-[hsl(var(--hairline))] bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        <CdsLogoLoader size="sm" className="mb-2 justify-center" inline={false} />
        正在采集 docker stats…
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="rounded-md border border-destructive/30 bg-destructive/10 px-5 py-4 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>读取失败:{state.message}</span>
          <Button type="button" size="sm" variant="outline" className="ml-auto" onClick={onRefresh}>
            <RefreshCw />重试
          </Button>
        </div>
      </section>
    );
  }
  const data = state.data;
  if (data.services.length === 0) {
    return (
      <section className="rounded-md border border-dashed border-[hsl(var(--hairline))] bg-card px-5 py-8 text-center text-sm text-muted-foreground">
        该分支没有任何 service。先去构建配置 / 部署。
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>共 {data.totalCount} 个 service · 运行中 {data.runningCount} · 每 5s 自动刷新 · 5min 滚动窗口</span>
        <Button type="button" size="sm" variant="ghost" className="ml-auto" onClick={onRefresh}>
          <RefreshCw />立即刷新
        </Button>
      </div>
      {data.services.map((svc) => (
        <ServiceMetricCard
          key={svc.profileId}
          profileId={svc.profileId}
          containerName={svc.containerName}
          status={svc.status}
          stats={svc.stats}
          series={series[svc.profileId]}
        />
      ))}
    </section>
  );
}

function ServiceMetricCard({
  profileId,
  containerName,
  status,
  stats,
  series,
}: {
  profileId: string;
  containerName: string;
  status: string;
  stats: ContainerStatsResponse | null;
  series: MetricSeries | undefined;
}): JSX.Element {
  const isRunning = status === 'running' && stats !== null;
  return (
    <div className="rounded-md border border-[hsl(var(--hairline))] bg-card px-4 py-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${statusRailClass(status)}`} aria-hidden />
            <span className="font-mono text-sm font-medium">{profileId}</span>
            <span className={`inline-flex h-5 items-center rounded-md border px-1.5 text-[10px] ${statusClass(status)}`}>
              {status}
            </span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={containerName}>
            {containerName}
          </div>
        </div>
      </div>

      {!isRunning ? (
        <div className="text-xs text-muted-foreground">服务未运行,无指标可读。</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          <MetricBar label="CPU" value={stats!.cpuPercent} unit="%" max={100} />
          <MetricBar
            label="内存"
            value={stats!.memPercent}
            unit="%"
            max={100}
            sub={`${formatBytes(stats!.memUsedBytes)} / ${formatBytes(stats!.memLimitBytes)}`}
          />
          <MetricRate label="网络入站(rx)" rate={series?.rxRate.at(-1) || 0} />
          <MetricRate label="网络出站(tx)" rate={series?.txRate.at(-1) || 0} />
        </div>
      )}

      {/* CPU sparkline — 5min 滚动窗口 */}
      {isRunning && series && series.cpu.length >= 2 ? (
        <div className="mt-3 flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground">CPU 5min 趋势</span>
          <Sparkline data={series.cpu} max={Math.max(100, ...series.cpu)} />
          <span className="text-[11px] text-muted-foreground">峰值 {Math.max(...series.cpu).toFixed(1)}%</span>
        </div>
      ) : null}
    </div>
  );
}

function MetricBar({
  label,
  value,
  unit,
  max,
  sub,
}: {
  label: string;
  value: number;
  unit: string;
  max: number;
  sub?: string;
}): JSX.Element {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const colorClass =
    pct > 85 ? 'bg-destructive'
      : pct > 65 ? 'bg-amber-500'
        : 'bg-emerald-500';
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-medium">{value.toFixed(1)}{unit}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-[hsl(var(--surface-sunken))]">
        <div className={`h-full ${colorClass} transition-[width] duration-500`} style={{ width: `${pct}%` }} />
      </div>
      {sub ? <div className="mt-0.5 text-[10px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function MetricRate({ label, rate }: { label: string; rate: number }): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="font-mono text-sm font-medium">{formatBytes(rate)}/s</div>
    </div>
  );
}

/**
 * 极简内联 SVG sparkline。zero-dep,~30 行,viewBox 0..100 × 0..30,
 * 父容器用 className 控制实际像素尺寸。data 不足 2 点时不渲染。
 */
function Sparkline({ data, max, className }: { data: number[]; max: number; className?: string }): JSX.Element | null {
  if (data.length < 2) return null;
  const width = 100;
  const height = 30;
  const safeMax = max > 0 ? max : 1;
  const points = data
    .map((v, i) => {
      const x = (i / (data.length - 1)) * width;
      const y = height - (v / safeMax) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={`flex-1 h-6 ${className || ''}`}
      aria-label="趋势"
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
        className="text-primary"
      />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
