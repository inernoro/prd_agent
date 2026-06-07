import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, CalendarClock, Copy, Cpu, Download, FileSearch, FileText, GitCompare, GitPullRequest, Globe2, KeyRound, ListChecks, MessageSquare, MousePointerClick, Network, PauseCircle, Play, Plus, RefreshCw, Route, Search, Send, Server, ShieldCheck, Square, Terminal, UserCheck } from 'lucide-react';

import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
import { MarkdownContent } from '@/components/ui/MarkdownContent';
import { toast } from '@/lib/toast';
import { listInfraConnections, type InfraConnectionPublicView } from '@/services/real/infraConnections';
import {
  approveInfraAgentTool,
  archiveInfraAgentSession,
  addInfraAgentManualInput,
  captureInfraAgentBrowserSnapshot,
  collectInfraAgentArtifacts,
  createInfraAgentRuntimeProfile,
  createDefaultInfraAgentRuntimeProfileFromTemplateAfterTest,
  createInfraAgentRuntimeProfileFromTemplate,
  createInfraAgentSession,
  deleteInfraAgentRuntimeProfile,
  getInfraAgentGovernanceDashboard,
  getInfraAgentLogs,
  getInfraAgentRuntimeAdapterMatrix,
  getInfraAgentRuntimeStatus,
  getInfraAgentScheduleDashboard,
  getInfraAgentSlaDashboard,
  getInfraAgentTraceBundle,
  importDefaultInfraAgentRuntimeProfile,
  listInfraAgentRuntimeAdapterCompatibility,
  listInfraAgentRuntimeProfileTemplates,
  listInfraAgentEvents,
  listInfraAgentMessages,
  listInfraAgentRuntimeProfiles,
  listInfraAgentSessions,
  requestInfraAgentToolApproval,
  runInfraAgentBrowserAction,
  runInfraAgentReadonlyChecks,
  sendInfraAgentMessage,
  setInfraAgentManualTakeover,
  startInfraAgentSession,
  stopInfraAgentSession,
  streamInfraAgentEvents,
  testInfraAgentRuntimeProfile,
  updateInfraAgentRuntimeProfile,
  type InfraAgentEventView,
  type InfraAgentMessageView,
  type InfraAgentGovernanceDashboardView,
  type InfraAgentRuntimeAdapterCompatibilityView,
  type InfraAgentRuntimeAdapterMatrixView,
  type InfraAgentRuntimeDiagnostics,
  type InfraAgentRuntimeProfileTemplateView,
  type InfraAgentRuntimeProfileView,
  type InfraAgentScheduleDashboardView,
  type InfraAgentSessionView,
  type InfraAgentSlaDashboardView,
} from '@/services/real/infraAgentSessions';
import { resolveExecutionRunway, resolveProviderEvidenceState, resolveSessionRuntimeState } from './cdsAgentReadiness';

const EVENT_PAGE_LIMIT = 500;
const EVENT_MAX_BATCHES_PER_REFRESH = 20;
const ANTHROPIC_OFFICIAL_PROFILE_TEMPLATE_ID = 'anthropic-official-claude-sonnet-4';

function statusLabel(status: string): string {
  if (status === 'creating') return '准备中';
  if (status === 'running') return '运行中';
  if (status === 'idle') return '待启动';
  if (status === 'stopping') return '停止中';
  if (status === 'stopped') return '已停止';
  if (status === 'failed') return '失败';
  if (status === 'timed_out') return '已超时';
  return status;
}

function formatTime(value?: string | null): string {
  if (!value) return '未记录';
  return new Date(value).toLocaleString();
}

function formatClockTime(value?: Date | null): string {
  if (!value) return '未记录';
  return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  if (minutes <= 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours <= 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remainMinutes}m`;
}

function formatHumanDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  if (safe < 60) return `${safe} 秒`;
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours} 小时 ${remainMinutes} 分钟` : `${hours} 小时`;
}

function formatRelativePast(value?: string | Date | null, now = Date.now()): string {
  if (!value) return '未记录';
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(time)) return '未记录';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 30) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function humanTargetName(value?: string | null): string {
  const raw = (value ?? '').trim();
  if (!raw) return '默认 workspace';
  if (/^shared-sidecar-pool-[a-z0-9]+$/i.test(raw)) return 'CDS 部署沙箱';
  if (/^cds-agent-runtime/i.test(raw)) return 'CDS Agent Runtime';
  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1].replace(/\.git$/, '')}`;
  } catch {
    // not a URL
  }
  return raw.replace(/\.git$/, '');
}

function humanTargetWithRef(target?: string | null, ref?: string | null): string {
  const name = humanTargetName(target);
  const branch = (ref ?? '').trim();
  return branch ? `${name} · ${branch}` : name;
}

function formatPercent(value?: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0%';
  return `${(value * 100).toFixed(value > 0 && value < 0.01 ? 2 : 1)}%`;
}

function formatTokenCount(value?: number | null): string {
  const safe = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(1)}K`;
  return String(safe);
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function normalizeAdapterCompatibilityItem(item: InfraAgentRuntimeAdapterCompatibilityView): InfraAgentRuntimeAdapterCompatibilityView {
  const raw = item as InfraAgentRuntimeAdapterCompatibilityView & Record<string, unknown>;
  return {
    ...item,
    loopOwner: item.loopOwner ?? '',
    mapRole: item.mapRole ?? '',
    cdsRole: item.cdsRole ?? '',
    supportedTaskKinds: normalizeStringList(raw.supportedTaskKinds),
    supportedProfileProtocols: normalizeStringList(raw.supportedProfileProtocols),
    modelHints: normalizeStringList(raw.modelHints),
    compatibleRuntimeProfileTemplateIds: normalizeStringList(raw.compatibleRuntimeProfileTemplateIds),
    requiredEvidenceGates: normalizeStringList(raw.requiredEvidenceGates),
    missingAdapterContracts: normalizeStringList(raw.missingAdapterContracts),
    knownIncompatibleProfilePatterns: normalizeStringList(raw.knownIncompatibleProfilePatterns),
    notes: normalizeStringList(raw.notes),
    nextActions: normalizeStringList(raw.nextActions),
  };
}

function primaryActionLabel(status: string): string {
  if (status === 'failed') return '重试';
  if (status === 'stopped') return '继续';
  return '启动';
}

function primaryActionHint(status: string): string {
  if (status === 'failed') return '保留历史对话和事件，重新创建远程 runtime 后继续执行。';
  if (status === 'stopped') return '复用本会话记录，重新启动远程 runtime 后继续发送任务。';
  if (status === 'idle') return '创建远程 runtime 并进入运行状态。';
  return '';
}

function canStartFromStatus(status: string): boolean {
  return status === 'idle' || status === 'failed' || status === 'stopped';
}

function statusRank(status: string): number {
  if (status === 'running') return 0;
  if (status === 'creating') return 1;
  if (status === 'idle') return 2;
  if (status === 'stopping') return 3;
  if (status === 'timed_out') return 4;
  if (status === 'failed') return 4;
  if (status === 'stopped') return 5;
  return 6;
}

function protocolLabel(protocol: string): string {
  if (protocol === 'anthropic') return 'Anthropic Messages';
  if (protocol === 'openai-compatible') return 'OpenAI-compatible';
  return protocol;
}

function profileLabel(profile: InfraAgentRuntimeProfileView): string {
  const keyState = profile.hasApiKey ? '' : ' · 需重新保存 provider secret';
  const scope = profile.scope === 'team-shared' ? ' · 团队共享' : '';
  return `${profile.name}${scope} · ${protocolLabel(profile.protocol)} · ${profile.model}${keyState}`;
}

function profileSummary(profile: InfraAgentRuntimeProfileView | null): string {
  if (!profile) return '未选择';
  const keyState = profile.hasApiKey ? '' : ' · provider secret 需重新保存';
  const scope = profile.scope === 'team-shared' ? '团队共享 · ' : '';
  return `${scope}${protocolLabel(profile.protocol)} · ${profile.model} @ ${profile.baseUrl}${keyState}`;
}

function networkPolicyLabel(policy?: string | null): string {
  if (policy === 'open') return '开放网络';
  if (policy === 'egress-only') return '仅出站';
  return '受限网络';
}

function formatResourcePolicy(profile?: InfraAgentRuntimeProfileView | null): string {
  if (!profile) return '默认 2 CPU / 4096 MB / 900s / 受限网络 / 30m 清理';
  return [
    `${profile.resourceCpuCores ?? 2} CPU`,
    `${profile.resourceMemoryMb ?? 4096} MB`,
    `${profile.timeoutSeconds ?? 900}s`,
    networkPolicyLabel(profile.networkPolicy),
    `${profile.autoCleanupMinutes ?? 30}m 清理`,
  ].join(' / ');
}

function formatSessionResourcePolicy(session?: InfraAgentSessionView | null): string {
  if (!session) return '未固化';
  return [
    `${session.resourceCpuCores ?? 2} CPU`,
    `${session.resourceMemoryMb ?? 4096} MB`,
    `${session.timeoutSeconds ?? 900}s`,
    networkPolicyLabel(session.networkPolicy),
    `${session.autoCleanupMinutes ?? 30}m 清理`,
  ].join(' / ');
}

function profileBlockReason(profile: InfraAgentRuntimeProfileView | null): string {
  if (!profile) return '请先同步系统主模型，或保存一个兼容模型配置。';
  if (!profile.hasApiKey) return '当前模型配置的 provider secret 无法读取，请在系统配置中重新保存后再启动远程会话。';
  if (!profile.baseUrl || !profile.model) return '当前模型配置缺少 baseUrl 或 model，请补全后再启动远程会话。';
  return '';
}

function profileCompatibilityBlockReason(profile: InfraAgentRuntimeProfileView | null, desiredRuntimeAdapter?: string | null): string {
  if (!profile || !desiredRuntimeAdapter) return '';
  if (!desiredRuntimeAdapter.toLowerCase().includes('claude-agent-sdk')) return '';
  const protocol = profile.protocol || '';
  const model = profile.model || '';
  const compatible = protocol.toLowerCase() === 'anthropic'
    || model.toLowerCase().includes('claude')
    || model.toLowerCase().startsWith('anthropic/');
  return compatible
    ? ''
    : 'Claude Agent SDK 路径需要 Claude/Anthropic 兼容模型；当前模型可能只适合普通 OpenAI-compatible gateway。';
}

function runtimeDiagnosticsProfileToView(
  profile: InfraAgentRuntimeDiagnostics['defaultRuntimeProfile'] | null | undefined,
): InfraAgentRuntimeProfileView | null {
  if (!profile) return null;
  return {
    id: profile.id,
    name: profile.name,
    runtime: profile.runtime,
    protocol: profile.protocol,
    baseUrl: 'runtime-profile-secret',
    model: profile.model,
    resourceCpuCores: 2,
    resourceMemoryMb: 4096,
    timeoutSeconds: 900,
    networkPolicy: 'restricted',
    autoCleanupMinutes: 30,
    hasApiKey: profile.hasApiKey,
    isDefault: profile.isDefault,
    createdAt: '',
    updatedAt: '',
    scope: 'runtime-status',
    ownerUserId: null,
    sharedTeamIds: null,
  };
}

function runtimeDiscoveryBlockReason(status: InfraAgentRuntimeDiagnostics): string {
  const metrics = status.discoveryMetrics;
  if (!metrics) return '';
  if ((metrics.tokenFailures ?? 0) > 0) {
    return 'CDS 长期授权不可用，请在基础设施设置中重新完成 CDS 授权。';
  }
  if ((metrics.endpointFailures ?? 0) > 0 && (metrics.emptyEndpoints ?? 0) <= 0) {
    return `CDS 实例发现请求失败：${metrics.endpointFailures} 个 endpoint 失败，请检查共享 CDS 控制面和 long token。`;
  }
  if ((metrics.emptyEndpoints ?? 0) > 0 || (metrics.endpointsWithInstances ?? 0) === 0) {
    if ((metrics.skippedBranchServiceCount ?? 0) > 0 && (metrics.runtimeBranchServiceCount ?? 0) <= 0) {
      return `CDS 已发现 ${metrics.runningBranchServiceCount ?? 0} 个 running 分支服务，但 ${metrics.skippedBranchServiceCount} 个被 runtime 过滤跳过；请把 sidecar runtime profile/service 命名为 api、sidecar、runtime、worker 或 agent，避免 admin/web/ui。`;
    }
    if ((metrics.runningBranchServiceCount ?? 0) <= 0) {
      return 'CDS 授权可用，但 shared sidecar pool 当前没有 running branch service；请先启动或重新部署 sidecar pool。';
    }
    if ((metrics.runtimeBranchServiceCount ?? 0) <= 0) {
      return 'CDS 发现到了分支服务，但没有可作为 runtime 的 sidecar 实例；请检查服务命名、标签和实例发现过滤规则。';
    }
  }
  return '';
}

function runtimePoolBlockReason(status: InfraAgentRuntimeDiagnostics | null): string {
  if (!status) return '正在检测 CDS runtime pool，请稍后刷新。';
  if (status.instanceCount > 0 && status.healthyCount > 0) return '';
  // Lite 只读审查降级可用时不阻塞：用户仍可发起只读审查（结果为预览级），官方 SDK pool 就绪后自动升级。
  if (status.liteReviewAvailable) return '';
  const discoveryReason = runtimeDiscoveryBlockReason(status);
  if (discoveryReason) return discoveryReason;
  const firstBlocker = status.blockers?.find((item) => item.trim());
  if (status.instanceCount <= 0) {
    if (firstBlocker) return firstBlocker;
    return status.registryLastRefreshError
      ? `未发现可用 sidecar 实例：${status.registryLastRefreshError}`
      : '未发现可用 sidecar 实例，请先完成 CDS sidecar pool 授权和实例发现。';
  }
  if (status.healthyCount <= 0) {
    if (firstBlocker) return firstBlocker;
    const firstError = status.instances.find((item) => item.error)?.error;
    return firstError
      ? `sidecar 实例均不健康：${firstError}`
      : 'sidecar 实例均不健康，请检查 /readyz、官方 SDK 包、workspace、token 和 provider secret 配置。';
  }
  return '';
}

function boolStatus(value: boolean | null | undefined, yes = 'OK', no = '缺失', unknown = '未知'): string {
  if (value === true) return yes;
  if (value === false) return no;
  return unknown;
}

function sortSessions(items: InfraAgentSessionView[]): InfraAgentSessionView[] {
  const now = Date.now();
  return [...items].sort((a, b) => {
    const rank = statusRank(resolveSessionRuntimeState(a, now).effectiveStatus) - statusRank(resolveSessionRuntimeState(b, now).effectiveStatus);
    if (rank !== 0) return rank;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function parsePayload(event: InfraAgentEventView): Record<string, unknown> {
  try {
    return JSON.parse(event.payloadJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// 判断某事件是否代表「本轮 run 结束」。收到即可停掉 SSE pump 和元数据轮询。
const TERMINAL_SESSION_STATUSES = new Set(['stopped', 'failed', 'idle', 'completed', 'timed_out', 'canceled', 'cancelled']);
function isRunFinishedEvent(event: InfraAgentEventView): boolean {
  if (event.type === 'done' || event.type === 'error') return true;
  if (event.type === 'status') {
    const status = String(parsePayload(event).status ?? '').toLowerCase();
    return TERMINAL_SESSION_STATUSES.has(status);
  }
  return false;
}

// 减少「无用的渲染」：底层传输/路由的 info 级 log（runtime tools exposed、
// lite review runtime started、message dispatched 等）对用户没有意义，从对话时间线里隐去；
// 但保留 warning/error 级（可能是真问题）。判定走结构化的 source/level 字段，不靠内容匹配，避免误伤真实输出。
const PLUMBING_LOG_SOURCES = new Set(['runtime-router', 'runtime-adapter', 'sidecar-runtime-adapter', 'claude-sdk-sidecar']);
const NOISE_LOG_KEYWORDS = [
  'adapter started', 'runtime started', 'runtime tools exposed', 'lite review runtime',
  'message dispatched', 'message accepted', 'queue stopped', 'cds logs unavailable',
  'runtime run cancel', 'sidecar_runtime_started', 'session transport',
];
function isNoiseEvent(event: InfraAgentEventView): boolean {
  if (event.type !== 'log') return false;
  const payload = parsePayload(event);
  const level = String(payload.level ?? '').toLowerCase();
  if (level === 'warning' || level === 'error') return false; // 真问题始终保留
  if (PLUMBING_LOG_SOURCES.has(String(payload.source ?? '').toLowerCase())) return true;
  const msg = String(payload.message ?? '').trim().toLowerCase();
  if (!msg) return true; // 空消息日志（被渲染成「后台运行日志」）零信息价值，隐去
  return NOISE_LOG_KEYWORDS.some((k) => msg.includes(k));
}

function renderPayload(event: InfraAgentEventView): string {
  const payload = parsePayload(event);
  const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string).trim() : '');
  if (event.type === 'text_delta' && typeof payload.text === 'string') return payload.text;
  if (event.type === 'done' && typeof payload.finalText === 'string') return payload.finalText;
  // 展开后给人话细节，而不是裸 JSON。
  if (event.type === 'error') {
    const lines: string[] = [];
    if (str('message')) lines.push(str('message'));
    if (str('code')) lines.push(`代码：${str('code')}`);
    const na = Array.isArray(payload.nextActions)
      ? (payload.nextActions as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    if (na.length) lines.push(`下一步：${na.join('；')}`);
    if (str('traceId')) lines.push(`traceId：${str('traceId')}`);
    if (lines.length) return lines.join('\n');
  }
  if (event.type === 'status') {
    const mode = str('mode');
    const parts: string[] = [];
    if (mode) parts.push(`运行模式：${mode === 'lite' ? 'Lite 预览（只读）' : '官方 SDK'}`);
    if (str('status')) parts.push(`状态：${str('status')}`);
    const reason = str('degradeReason') || str('reason');
    if (reason) parts.push(`原因：${reason}`);
    if (str('model')) parts.push(`模型：${str('model')}`);
    if (parts.length) return parts.join('\n');
  }
  if (event.type === 'log' && str('message')) return str('message');
  return JSON.stringify(payload, null, 2);
}

function mergeEventsBySeq(
  current: InfraAgentEventView[],
  incoming: InfraAgentEventView[],
): InfraAgentEventView[] {
  if (incoming.length === 0) return current;
  const bySeq = new Map<number, InfraAgentEventView>();
  current.forEach((item) => bySeq.set(item.seq, item));
  incoming.forEach((item) => bySeq.set(item.seq, item));
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

function latestEventSeq(items: InfraAgentEventView[]): number {
  return items.reduce((max, item) => Math.max(max, item.seq), 0);
}

function shortId(value?: string | null, head = 12): string {
  if (!value) return '未上报';
  return value.length > head + 4 ? `${value.slice(0, head)}...${value.slice(-4)}` : value;
}

function readString(payload: Record<string, unknown> | null | undefined, key: string): string {
  if (!payload) return '';
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readBoolean(payload: Record<string, unknown> | null, key: string): boolean | null {
  if (!payload) return null;
  const value = payload[key];
  return typeof value === 'boolean' ? value : null;
}

function readStringArray(payload: Record<string, unknown> | null, key: string): string[] {
  if (!payload) return [];
  const value = payload[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function readDiffStatSummary(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  const added = typeof record.added === 'number' ? record.added : null;
  const removed = typeof record.removed === 'number' ? record.removed : null;
  const changed = typeof record.changed === 'number' ? record.changed : null;
  const parts: string[] = [];
  if (added !== null) parts.push(`+${added}`);
  if (removed !== null) parts.push(`-${removed}`);
  if (changed !== null) parts.push(`${changed} changed`);
  return parts.join(' · ');
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/sk-ant-[A-Za-z0-9._-]+/g, 'sk-ant-***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer ***')
    .replace(/(api[_-]?key|access[_-]?token|long[_-]?token|sid(e)?car[_-]?token|authorization)(["'\s:=]+)([^"',\s}]+)/gi, '$1$3***');
}

function redactForBundle(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactForBundle(item));
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, item]) => {
    if (/apiKey|accessToken|longToken|sidecarToken|authorization|secret|password/i.test(key)) {
      if (typeof item === 'boolean') result[key] = item;
      else if (item == null || item === '') result[key] = item;
      else result[key] = '***';
      return;
    }
    result[key] = redactForBundle(item);
  });
  return result;
}

function safeFilenamePart(value?: string | null): string {
  const normalized = (value || 'session').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 80) || 'session';
}

function buildPromptWithContext(
  task: string,
  context: { files: string; urls: string; notes: string },
): string {
  const sections: string[] = [];
  if (context.files.trim()) sections.push(`文件路径:\n${context.files.trim()}`);
  if (context.urls.trim()) sections.push(`网页地址:\n${context.urls.trim()}`);
  if (context.notes.trim()) sections.push(`项目文档/知识库:\n${context.notes.trim()}`);
  if (sections.length === 0) return task.trim();
  return [
    '附加上下文',
    sections.join('\n\n'),
    '任务',
    task.trim(),
  ].join('\n\n');
}

function messageRoleLabel(role: string): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return 'Agent';
  if (role === 'tool') return '工具';
  if (role === 'system') return '系统';
  return role;
}

function displayMessageContent(message: { role: string; content: string }): string {
  if (message.role !== 'user') return message.content;
  return message.content.replace(/^【(?:Code 巡检模式|对话模式)】[^\n]*\n/, '').trim();
}

// 简洁模式：把工具名翻译成用户能懂的中文动作短语，不暴露原始 tool_use JSON。
function toolActionLabel(toolName: string, payload: Record<string, unknown>): string {
  const args = parseJsonString(payload.argsSummary) ?? {};
  const path = typeof args.path === 'string' ? args.path : '';
  const command = typeof args.command === 'string' ? args.command : '';
  switch (toolName) {
    case 'repo_read_file': return path ? `读取文件 ${path}` : '读取文件';
    case 'repo_write_file': return path ? `修改文件 ${path}` : '修改文件';
    case 'repo_list_files': return '浏览文件树';
    case 'repo_search': return '搜索代码';
    case 'repo_git_status': return '查看仓库状态';
    case 'repo_git_diff': return '查看代码改动';
    case 'repo_run_command': return command ? `运行命令 ${command}` : '运行命令';
    case 'repo_create_pull_request': return '创建 Pull Request';
    case 'kb_list': return '浏览知识库';
    case 'kb_search': return '搜索知识库';
    case 'kb_read': return '读取知识库文档';
    case 'kb_draft_create': return '创建知识库草稿';
    case 'kb_draft_read': return '读取知识库草稿';
    case 'kb_draft_list': return '列出知识库草稿';
    case 'kb_draft_discard': return '丢弃知识库草稿';
    case 'kb_diff': return '查看知识库差异';
    case 'kb_apply': return '应用知识库草稿';
    case 'kb_reject': return '拒绝知识库草稿';
    case 'current_time': return '获取当前时间';
    case 'echo': return '回显测试';
    default:
      if (toolName.startsWith('cds_bridge')) return '操作远程页面';
      return toolName;
  }
}

function processEventLabel(event: InfraAgentEventView): string {
  const payload = parsePayload(event);
  const toolName = String(payload.toolName ?? '');
  if (event.type === 'tool_call') return toolActionLabel(toolName, payload);
  if (event.type === 'tool_result') return `完成：${toolActionLabel(toolName, payload)}`;
  if (event.type === 'error') return `出错：${String(payload.message ?? '未知错误')}`;
  const message = String(payload.message ?? payload.summary ?? payload.status ?? '').trim();
  if (event.type === 'status') return message || '状态更新';
  if (event.type === 'log') return message || '后台运行日志';
  if (event.type === 'file') return String(payload.path ?? payload.file ?? '记录文件变更');
  if (event.type === 'diff') return String(payload.path ?? payload.summary ?? '记录代码差异');
  if (event.type === 'browser') return message || '浏览器操作';
  if (event.type === 'manual') return message || '人工输入';
  if (event.type === 'hook') return message || 'Hook 执行';
  return statusLabel(event.type);
}

const SIMPLE_VIEW_STORAGE_KEY = 'cds-agent:view-mode';

function readInitialViewMode(): 'simple' | 'pro' {
  try {
    if (typeof window !== 'undefined') {
      const requested = new URLSearchParams(window.location.search).get('viewMode')
        ?? new URLSearchParams(window.location.search).get('mode');
      if (requested === 'pro') return 'pro';
      if (requested === 'simple') return 'simple';
    }
    const saved = sessionStorage.getItem(SIMPLE_VIEW_STORAGE_KEY);
    return saved === 'pro' ? 'pro' : 'simple';
  } catch {
    return 'simple';
  }
}

function readRequestedSessionId(): string {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search).get('sessionId')?.trim() ?? '';
  } catch {
    return '';
  }
}

function parseJsonString(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

type AgentArtifact = {
  id: string;
  title: string;
  kind: 'files' | 'diff' | 'command' | 'browser' | 'log';
  summary: string;
  body: string;
  count?: number;
};

type LocalTimelineMessage = {
  id: string;
  role: string;
  content: string;
  status: string;
  createdAt: string;
  sessionId?: string | null;
};

type SimpleRunPhase = 'idle' | 'submitting' | 'creating' | 'starting' | 'running' | 'stopping' | 'completed' | 'failed';

type SimpleRunState = {
  phase: SimpleRunPhase;
  label: string;
  detail?: string;
  startedAt: number;
  updatedAt: number;
  sessionId?: string | null;
  traceId?: string | null;
  requestId?: string | null;
  source?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  elapsedMs?: number | null;
};

type RuntimeReadinessGate = {
  label: string;
  value: string;
  detail: string;
  state: 'pass' | 'warn' | 'pending';
  reasonCode?: string | null;
};

type CommercialReadinessGate = RuntimeReadinessGate & {
  code: 'R0' | 'A0' | 'R1' | 'T1' | 'S1' | 'S2' | 'S3' | 'V1';
};

function artifactIcon(kind: AgentArtifact['kind']) {
  if (kind === 'diff') return <GitCompare size={13} />;
  if (kind === 'browser') return <Globe2 size={13} />;
  if (kind === 'command') return <Terminal size={13} />;
  return <FileText size={13} />;
}

function buildArtifacts(events: InfraAgentEventView[], logs: string): AgentArtifact[] {
  const artifacts: AgentArtifact[] = [];
  events.forEach((event) => {
    if (event.type !== 'tool_result') return;
    const payload = parsePayload(event);
    const detail = parseJsonString(payload.resultSummary) ?? parseJsonString(payload.content);
    if (!detail) return;

    if (Array.isArray(detail.files)) {
      const files = detail.files.map((item) => String(item));
      artifacts.push({
        id: `${event.id}-files`,
        title: '文件树',
        kind: 'files',
        summary: `${files.length} 个文件${detail.truncated ? '，已截断' : ''}`,
        body: files.join('\n'),
        count: files.length,
      });
    }

    if (typeof detail.branch === 'string' || typeof detail.status === 'string') {
      artifacts.push({
        id: `${event.id}-status`,
        title: '仓库状态',
        kind: 'log',
        summary: `${String(detail.branch ?? 'workspace')} · ${String(detail.commit ?? 'unknown')}`,
        body: [
          `branch: ${String(detail.branch ?? 'unknown')}`,
          `commit: ${String(detail.commit ?? 'unknown')}`,
          '',
          'status:',
          typeof detail.status === 'string' ? detail.status : '',
          '',
          'diffStat:',
          typeof detail.diffStat === 'string' ? detail.diffStat : '',
        ].join('\n'),
      });
    }

    if (typeof detail.diff === 'string' || typeof detail.unifiedDiff === 'string' || (readDiffStatSummary(detail.diffStat) && typeof detail.branch !== 'string')) {
      const diffStat = readDiffStatSummary(detail.diffStat);
      const unifiedDiff = typeof detail.unifiedDiff === 'string' ? detail.unifiedDiff : '';
      const diff = typeof detail.diff === 'string' ? detail.diff : unifiedDiff;
      artifacts.push({
        id: `${event.id}-diff`,
        title: unifiedDiff ? '知识库 diff' : '代码 diff',
        kind: 'diff',
        summary: [String(detail.path ?? 'workspace'), detail.truncated ? '已截断' : '完整'].join(' · '),
        body: [diffStat, diff].filter(Boolean).join('\n\n'),
      });
    }

    if (typeof detail.command === 'string' && (typeof detail.stdout === 'string' || typeof detail.stderr === 'string')) {
      artifacts.push({
        id: `${event.id}-command`,
        title: '命令结果',
        kind: 'command',
        summary: `${String(detail.command ?? 'command')} · exit ${String(detail.exitCode ?? 'unknown')}`,
        body: [
          `command: ${String(detail.command ?? '')}`,
          `cwd: ${String(detail.cwd ?? '.')}`,
          `exitCode: ${String(detail.exitCode ?? 'unknown')}`,
          '',
          'stdout:',
          typeof detail.stdout === 'string' ? detail.stdout : '',
          '',
          'stderr:',
          typeof detail.stderr === 'string' ? detail.stderr : '',
        ].join('\n'),
      });
    }

    const state = 'state' in detail && detail.state && typeof detail.state === 'object'
      ? detail.state as Record<string, unknown>
      : detail;
    if ('url' in state || 'title' in state || 'domTree' in state || 'consoleErrors' in state || 'networkErrors' in state) {
      artifacts.push({
        id: `${event.id}-browser`,
        title: '远程页面快照',
        kind: 'browser',
        summary: String(state.title ?? state.url ?? 'browser snapshot'),
        body: JSON.stringify(state, null, 2),
      });
    }
  });

  if (logs.trim()) {
    artifacts.push({
      id: 'session-log',
      title: '运行日志',
      kind: 'log',
      summary: `${logs.split('\n').filter(Boolean).length} 行日志`,
      body: logs,
    });
  }

  return artifacts;
}

function EventBody({ event }: { event: InfraAgentEventView }) {
  const payload = parsePayload(event);
  if (event.type === 'tool_call') {
    return (
      <div className="mt-2 space-y-2">
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded bg-white/10 px-2 py-1 text-white/70">{String(payload.toolName ?? 'tool')}</span>
          <span className="rounded bg-white/10 px-2 py-1 text-white/55">{String(payload.risk ?? 'readonly')}</span>
          <span className="rounded bg-white/10 px-2 py-1 text-white/55">{String(payload.status ?? 'pending')}</span>
        </div>
        <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-white/62">{String(payload.argsSummary ?? '{}')}</pre>
      </div>
    );
  }

  if (event.type === 'tool_result') {
    const detail = parseJsonString(payload.resultSummary) ?? parseJsonString(payload.content);
    if (detail && Array.isArray(detail.files)) {
      const files = detail.files.map((item) => String(item));
      return (
        <div className="mt-2 space-y-2 text-xs">
          <div className="inline-flex rounded bg-white/10 px-2 py-1 text-white/70">
            文件树: {files.length} 个文件{detail.truncated ? '，已截断' : ''}
          </div>
          <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-white/68">{files.join('\n')}</pre>
        </div>
      );
    }
    if (detail && ('status' in detail || 'diffStat' in detail || 'diff' in detail || 'unifiedDiff' in detail)) {
      const diffStatSummary = readDiffStatSummary(detail.diffStat);
      const unifiedDiff = typeof detail.unifiedDiff === 'string' ? detail.unifiedDiff : '';
      const diffText = typeof detail.diff === 'string' ? detail.diff : unifiedDiff;
      return (
        <div className="mt-2 space-y-2 text-xs">
          {'branch' in detail && (
            <div className="flex flex-wrap gap-2">
              <span className="rounded bg-white/10 px-2 py-1 text-white/70">branch: {String(detail.branch ?? 'unknown')}</span>
              <span className="rounded bg-white/10 px-2 py-1 text-white/70">commit: {String(detail.commit ?? 'unknown')}</span>
            </div>
          )}
          {typeof detail.status === 'string' && detail.status && (
            <pre className="max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-white/68">{detail.status}</pre>
          )}
          {diffStatSummary && (
            <pre className="max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-white/68">{diffStatSummary}</pre>
          )}
          {diffText && (
            <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-white/68">{diffText}</pre>
          )}
        </div>
      );
    }
    if (detail && ('exitCode' in detail || 'stdout' in detail || 'stderr' in detail)) {
      return (
        <div className="mt-2 space-y-2 text-xs">
          <div className="inline-flex rounded bg-white/10 px-2 py-1 text-white/70">exitCode: {String(detail.exitCode ?? 'unknown')}</div>
          {typeof detail.stdout === 'string' && detail.stdout && (
            <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-white/68">{detail.stdout}</pre>
          )}
          {typeof detail.stderr === 'string' && detail.stderr && (
            <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded bg-red-950/30 p-2 text-red-100/75">{detail.stderr}</pre>
          )}
        </div>
      );
    }
    const state = detail && 'state' in detail && detail.state && typeof detail.state === 'object'
      ? detail.state as Record<string, unknown>
      : detail;
    if (state && ('url' in state || 'title' in state || 'domTree' in state || 'consoleErrors' in state || 'networkErrors' in state)) {
      return (
        <div className="mt-2 space-y-2 text-xs">
          <div className="flex flex-wrap gap-2">
            {'title' in state && <span className="rounded bg-white/10 px-2 py-1 text-white/70">title: {String(state.title ?? 'unknown')}</span>}
            {'url' in state && <span className="rounded bg-white/10 px-2 py-1 text-white/70 break-all">url: {String(state.url ?? '')}</span>}
          </div>
          {typeof state.domTree === 'string' && state.domTree && (
            <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-white/68">{state.domTree}</pre>
          )}
          {Array.isArray(state.consoleErrors) && state.consoleErrors.length > 0 && (
            <pre className="max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded bg-red-950/30 p-2 text-red-100/75">{JSON.stringify(state.consoleErrors, null, 2)}</pre>
          )}
          {Array.isArray(state.networkErrors) && state.networkErrors.length > 0 && (
            <pre className="max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded bg-red-950/30 p-2 text-red-100/75">{JSON.stringify(state.networkErrors, null, 2)}</pre>
          )}
        </div>
      );
    }
  }

  return <pre className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-white/62">{renderPayload(event)}</pre>;
}

function assistantTextFromEvents(items: InfraAgentEventView[]): string {
  const deltas: string[] = [];
  let finalText = '';
  items.forEach((event) => {
    const payload = parsePayload(event);
    if (event.type === 'text_delta' && typeof payload.text === 'string') deltas.push(payload.text);
    if (event.type === 'done' && typeof payload.finalText === 'string') finalText = payload.finalText;
  });
  return finalText || deltas.join('');
}

function summarizeProcessEvents(items: InfraAgentEventView[]): {
  rawCount: number;
  toolCallCount: number;
  toolResultCount: number;
  logCount: number;
  statusCount: number;
  errorCount: number;
  usefulCount: number;
  toolNames: string[];
} {
  const toolNames = new Set<string>();
  let toolCallCount = 0;
  let toolResultCount = 0;
  let logCount = 0;
  let statusCount = 0;
  let errorCount = 0;
  items.forEach((event) => {
    const payload = parsePayload(event);
    const toolName = readString(payload, 'toolName');
    if (toolName) toolNames.add(toolName);
    if (event.type === 'tool_call') toolCallCount += 1;
    else if (event.type === 'tool_result') toolResultCount += 1;
    else if (event.type === 'log') logCount += 1;
    else if (event.type === 'status') statusCount += 1;
    else if (event.type === 'error') errorCount += 1;
  });
  return {
    rawCount: items.length,
    toolCallCount,
    toolResultCount,
    logCount,
    statusCount,
    errorCount,
    usefulCount: toolCallCount + toolResultCount + errorCount,
    toolNames: Array.from(toolNames).slice(0, 5),
  };
}

export default function CdsAgentPage() {
  const [connections, setConnections] = useState<InfraConnectionPublicView[]>([]);
  const [profiles, setProfiles] = useState<InfraAgentRuntimeProfileView[]>([]);
  const [profileTemplates, setProfileTemplates] = useState<InfraAgentRuntimeProfileTemplateView[]>([]);
  const [adapterCompatibility, setAdapterCompatibility] = useState<InfraAgentRuntimeAdapterCompatibilityView[]>([]);
  const [adapterMatrix, setAdapterMatrix] = useState<InfraAgentRuntimeAdapterMatrixView | null>(null);
  const [slaDashboard, setSlaDashboard] = useState<InfraAgentSlaDashboardView | null>(null);
  const [scheduleDashboard, setScheduleDashboard] = useState<InfraAgentScheduleDashboardView | null>(null);
  const [governanceDashboard, setGovernanceDashboard] = useState<InfraAgentGovernanceDashboardView | null>(null);
  const [sessions, setSessions] = useState<InfraAgentSessionView[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<InfraAgentMessageView[]>([]);
  const [localMessages, setLocalMessages] = useState<LocalTimelineMessage[]>([]);
  const [events, setEvents] = useState<InfraAgentEventView[]>([]);
  const [logs, setLogs] = useState('');
  const [runtimeStatus, setRuntimeStatus] = useState<InfraAgentRuntimeDiagnostics | null>(null);
  const [runtimeDiscoveryRefreshed, setRuntimeDiscoveryRefreshed] = useState<boolean | null>(null);
  const [runtimeStatusLoadedAt, setRuntimeStatusLoadedAt] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'simple' | 'pro'>(readInitialViewMode);
  // 简洁模式保持「聊天纯净」：Git/证据/运行摘要/调试 等运维遥测默认收起（用户心智：这是聊天，不是运维台）。
  // 用 state 而非常量，既不触发 ESLint no-constant-binary，又让块内变量保持被引用、避免误删级联。
  const [showOpsPanels] = useState(false);
  const [simpleTaskMode, setSimpleTaskMode] = useState<'chat' | 'code'>('chat');
  const [simpleExpandedEventId, setSimpleExpandedEventId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [simpleSubmitStatus, setSimpleSubmitStatus] = useState('');
  const [simpleRunState, setSimpleRunState] = useState<SimpleRunState | null>(null);
  const [autoScrollPaused, setAutoScrollPaused] = useState(false);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const timelineRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<InfraAgentEventView[]>([]);
  // 本轮 run 是否已结束（收到 done/error/终态 status）。用于立即停掉 SSE pump 与元数据轮询，
  // 杜绝「跑完之后还在循环请求」——不依赖 session.status 在列表里的滞后翻转。
  const runFinishedRef = useRef(false);
  const pollTickRef = useRef(0);
  const [eventStreamHealthy, setEventStreamHealthy] = useState(false);
  const [sessionQuery, setSessionQuery] = useState('');
  const [eventReplayMode, setEventReplayMode] = useState(false);
  const [eventReplayIndex, setEventReplayIndex] = useState(1);
  const [busy, setBusy] = useState(false);
  const [testingProfile, setTestingProfile] = useState(false);
  const [profileTest, setProfileTest] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [contextDraft, setContextDraft] = useState({
    files: '',
    urls: '',
    notes: '',
  });
  const [manualReason, setManualReason] = useState('人工检查远程页面或审批危险工具');
  const [browserBranchId, setBrowserBranchId] = useState('prd-agent-main');
  const [browserAction, setBrowserAction] = useState('spa-navigate');
  const [browserTargetIndex, setBrowserTargetIndex] = useState('0');
  const [browserActionText, setBrowserActionText] = useState('/cds-agent');
  const [draft, setDraft] = useState({
    title: '',
    connectionId: '',
    runtimeProfileId: '',
    toolPolicy: 'readonly-auto',
    gitRepository: '',
    gitRef: 'main',
    workspaceRoot: '',
  });
  const [profileDraft, setProfileDraft] = useState({
    name: '',
    runtime: 'claude-sdk',
    protocol: 'anthropic',
    baseUrl: '',
    model: '',
    apiKey: '',
    resourceCpuCores: 2,
    resourceMemoryMb: 4096,
    timeoutSeconds: 900,
    networkPolicy: 'restricted',
    autoCleanupMinutes: 30,
    isDefault: true,
  });

  const activeConnection = useMemo(
    () => connections.find((item) => item.id === draft.connectionId) ?? connections.find((item) => item.status === 'active') ?? null,
    [connections, draft.connectionId],
  );
  const runtimeStatusDefaultProfile = useMemo(
    () => runtimeDiagnosticsProfileToView(runtimeStatus?.defaultRuntimeProfile),
    [runtimeStatus?.defaultRuntimeProfile],
  );
  const activeProfile = useMemo(
    () => profiles.find((item) => item.id === draft.runtimeProfileId)
      ?? profiles.find((item) => item.isDefault)
      ?? profiles[0]
      ?? runtimeStatusDefaultProfile
      ?? null,
    [profiles, draft.runtimeProfileId, runtimeStatusDefaultProfile],
  );
  const anthropicOfficialProfileTemplate = useMemo(
    () => profileTemplates.find((item) => item.id === ANTHROPIC_OFFICIAL_PROFILE_TEMPLATE_ID) ?? null,
    [profileTemplates],
  );
  const activeAdapterCompatibility = useMemo(() => {
    const desired = (runtimeStatus?.desiredRuntimeAdapter || '').toLowerCase();
    if (!desired) return null;
    return adapterCompatibility.find((item) => item.id.toLowerCase() === desired) ?? null;
  }, [adapterCompatibility, runtimeStatus?.desiredRuntimeAdapter]);
  const sortedSessions = useMemo(() => sortSessions(sessions), [sessions]);
  const visibleSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    if (!query) return sortedSessions;
    return sortedSessions.filter((session) => [
      session.title,
      session.model ?? '',
      session.runtime,
      session.status,
      session.lastError ?? '',
      session.traceId,
      session.gitRepository ?? '',
      session.gitRef ?? '',
      session.workspaceRoot ?? '',
    ].some((value) => value.toLowerCase().includes(query)));
  }, [sessionQuery, sortedSessions]);
  const resumableCount = useMemo(
    () => sessions.filter((item) => {
      const state = resolveSessionRuntimeState(item, nowTick).effectiveStatus;
      return state === 'running' || state === 'creating' || state === 'idle';
    }).length,
    [nowTick, sessions],
  );
  const activeSession = sessions.find((item) => item.id === activeSessionId) ?? sortedSessions[0] ?? null;
  const activeSessionRuntimeState = useMemo(
    () => resolveSessionRuntimeState(activeSession, nowTick),
    [activeSession, nowTick],
  );
  const activeSessionEffectiveStatus = activeSessionRuntimeState.effectiveStatus;
  const activeSessionTimedOut = activeSessionRuntimeState.timedOut;
  const activeSessionProfile = activeSession?.runtimeProfileId
    ? profiles.find((item) => item.id === activeSession.runtimeProfileId)
      ?? (runtimeStatusDefaultProfile?.id === activeSession.runtimeProfileId ? runtimeStatusDefaultProfile : null)
    : activeProfile;
  const desiredRuntimeAdapterForProfile = runtimeStatus?.desiredRuntimeAdapter || '';
  // Lite 兜底可用时，整套「模型 profile」前置都不该挡路——Lite 只读审查走现有 LLM Gateway，
  // 不依赖 profile 的 baseUrl/key/兼容性。没 profile、profile 不兼容、缺 key 都自动降级为 Lite。
  const liteReviewAvailable = Boolean(runtimeStatus?.liteReviewAvailable);
  const activeProfileBlockReason = liteReviewAvailable
    ? ''
    : profileBlockReason(activeProfile)
      || profileCompatibilityBlockReason(activeProfile, desiredRuntimeAdapterForProfile);
  const activeSessionProfileBlockReason = !activeSession || liteReviewAvailable
    ? ''
    : profileBlockReason(activeSessionProfile)
      || profileCompatibilityBlockReason(activeSessionProfile, desiredRuntimeAdapterForProfile);
  const activeRuntimePoolBlockReason = runtimePoolBlockReason(runtimeStatus);
  const canReuseActiveProfileSecret = Boolean(activeProfile?.hasApiKey && !profileDraft.apiKey.trim());
  const canUpdateActiveProfile = Boolean(
    activeProfile
    && profileDraft.baseUrl.trim()
    && profileDraft.model.trim()
    && (profileDraft.apiKey.trim() || activeProfile.hasApiKey),
  );
  // Lite 可用时连 CDS 连接都不强制（对话模式后端走 Lite 本地，不需要授权）；否则仍要 active 连接 + 可用 profile。
  // 需要一个 active CDS 连接（授权一次后，旧会话/新会话都会 remap 到它，不再反复授权）。
  // 模型 profile 不强制：Lite 可用时 activeProfileBlockReason 已为空。
  const canCreateSession = Boolean(
    activeConnection
    && !activeProfileBlockReason
    && !activeRuntimePoolBlockReason,
  );
  const canRunActiveSession = Boolean(activeSession && !activeSessionProfileBlockReason && !activeRuntimePoolBlockReason);
  const canStartActiveSession = Boolean(activeSession && !activeSessionTimedOut && !activeSession.manualTakeoverEnabled && canRunActiveSession && canStartFromStatus(activeSessionEffectiveStatus));
  const canSendActiveSession = Boolean(activeSession && !activeSessionTimedOut && !activeSession.manualTakeoverEnabled && canRunActiveSession && (activeSessionEffectiveStatus === 'running' || activeSessionEffectiveStatus === 'idle'));
  const canRecordManualInput = Boolean(activeSession?.manualTakeoverEnabled && prompt.trim());
  const defaultRuntimeProfileDiagnostics = runtimeStatus?.defaultRuntimeProfile ?? null;
  const r1DefaultProfileBlocked = Boolean(defaultRuntimeProfileDiagnostics && (
    !defaultRuntimeProfileDiagnostics.hasApiKey
    || !defaultRuntimeProfileDiagnostics.compatibleWithDesiredRuntimeAdapter
  ));
  const backendR1RepairPlan = runtimeStatus?.runtimeProfileRepairPlan ?? null;
  const r1RepairPlan = useMemo(() => ({
    gate: backendR1RepairPlan?.gate ?? 'R1',
    state: backendR1RepairPlan?.state ?? (r1DefaultProfileBlocked ? 'blocked' : defaultRuntimeProfileDiagnostics ? 'ready' : 'missing'),
    source: backendR1RepairPlan ? 'backend-runtime-status' : 'page-derived',
    currentProfile: backendR1RepairPlan?.currentProfile ?? (defaultRuntimeProfileDiagnostics
      ? {
          name: defaultRuntimeProfileDiagnostics.name,
          protocol: defaultRuntimeProfileDiagnostics.protocol,
          model: defaultRuntimeProfileDiagnostics.model,
          hasApiKey: defaultRuntimeProfileDiagnostics.hasApiKey,
          compatibleWithDesiredRuntimeAdapter: defaultRuntimeProfileDiagnostics.compatibleWithDesiredRuntimeAdapter,
          warning: defaultRuntimeProfileDiagnostics.warning ?? null,
          compatibilityReasonCode: defaultRuntimeProfileDiagnostics.compatibilityReasonCode ?? null,
          compatibilityReason: defaultRuntimeProfileDiagnostics.compatibilityReason ?? null,
          compatibilityNextActions: defaultRuntimeProfileDiagnostics.compatibilityNextActions ?? null,
        }
      : null),
    targetTemplate: backendR1RepairPlan
      ? {
          id: backendR1RepairPlan.targetTemplateId,
          protocol: backendR1RepairPlan.targetProtocol,
          baseUrl: backendR1RepairPlan.targetBaseUrl,
          model: backendR1RepairPlan.targetModel,
          isDefaultRecommended: backendR1RepairPlan.targetIsDefaultRecommended,
        }
      : anthropicOfficialProfileTemplate
      ? {
          id: anthropicOfficialProfileTemplate.id,
          protocol: anthropicOfficialProfileTemplate.protocol,
          baseUrl: anthropicOfficialProfileTemplate.baseUrl,
          model: anthropicOfficialProfileTemplate.model,
          isDefaultRecommended: anthropicOfficialProfileTemplate.isDefaultRecommended,
        }
      : null,
    nextActions: backendR1RepairPlan?.nextActions ?? [
      '使用 claude-sdk runtime + anthropic protocol 保存 Claude Code provider-switch profile。',
      'DeepSeek/cc-switch 可使用自定义 provider secret；只有原生 api.anthropic.com 才要求 sk-ant。',
      '点击“测试模型”；成功后再运行 S1/S2/S3 provider smokes。',
    ],
  }), [anthropicOfficialProfileTemplate, backendR1RepairPlan, defaultRuntimeProfileDiagnostics, r1DefaultProfileBlocked]);
  const r1RepairNeedsAttention = r1RepairPlan.state !== 'ready';
  const r1RepairCurrentLabel = r1RepairPlan.currentProfile
    ? [
        r1RepairPlan.currentProfile.name,
        r1RepairPlan.currentProfile.protocol,
        r1RepairPlan.currentProfile.model,
      ].filter(Boolean).join(' / ')
    : '未找到默认 runtime profile';
  const r1RepairTargetLabel = r1RepairPlan.targetTemplate
    ? [
        r1RepairPlan.targetTemplate.protocol,
        r1RepairPlan.targetTemplate.model,
      ].filter(Boolean).join(' / ')
    : '等待后端官方模板';

  const fetchEventsSince = useCallback(async (sessionId: string, afterSeq: number): Promise<InfraAgentEventView[]> => {
    const collected: InfraAgentEventView[] = [];
    let cursor = afterSeq;
    for (let batch = 0; batch < EVENT_MAX_BATCHES_PER_REFRESH; batch += 1) {
      const eventsRes = await listInfraAgentEvents(sessionId, cursor, EVENT_PAGE_LIMIT);
      if (!eventsRes.success) break;
      const items = eventsRes.data?.items ?? [];
      if (items.length === 0) break;
      collected.push(...items);
      cursor = latestEventSeq(items);
      if (items.length < EVENT_PAGE_LIMIT) break;
    }
    return collected;
  }, []);

  const refreshDetail = useCallback(async (sessionId: string, options: { resetEvents?: boolean; skipEvents?: boolean } = {}) => {
    const afterSeq = options.resetEvents || activeSessionId !== sessionId ? 0 : latestEventSeq(eventsRef.current);
    const [messagesRes, newEvents, logsRes] = await Promise.all([
      listInfraAgentMessages(sessionId, 200),
      options.skipEvents ? Promise.resolve([]) : fetchEventsSince(sessionId, afterSeq),
      getInfraAgentLogs(sessionId),
    ]);
    if (messagesRes.success) setMessages(messagesRes.data?.items ?? []);
    if (!options.skipEvents) {
      setEvents((prev) => {
        const next = afterSeq > 0
          ? mergeEventsBySeq(prev, newEvents)
          : mergeEventsBySeq([], newEvents);
        eventsRef.current = next;
        return next;
      });
    }
    if (logsRes.success) setLogs(logsRes.data?.logs ?? '');
  }, [activeSessionId, fetchEventsSince]);

  const displayedEvents = useMemo(
    () => eventReplayMode ? events.slice(0, Math.max(0, Math.min(eventReplayIndex, events.length))) : events,
    [eventReplayIndex, eventReplayMode, events],
  );
  const artifacts = useMemo(() => buildArtifacts(events, logs), [events, logs]);
  const metrics = useMemo(() => {
    const runtimeStates = sessions.map((item) => resolveSessionRuntimeState(item, nowTick).effectiveStatus);
    const running = runtimeStates.filter((status) => status === 'running' || status === 'creating').length;
    const failed = runtimeStates.filter((status) => status === 'failed').length;
    const stopped = runtimeStates.filter((status) => status === 'stopped' || status === 'timed_out').length;
    const toolEvents = events.filter((item) => item.type === 'tool_call' || item.type === 'tool_result').length;
    return {
      totalSessions: sessions.length,
      running,
      failed,
      stopped,
      eventCount: events.length,
      toolEvents,
      artifactCount: artifacts.length,
    };
  }, [artifacts.length, events, nowTick, sessions]);
  const slaSummary = slaDashboard?.summary ?? null;
  const slaRuntimeFocus = slaDashboard?.runtimeBreakdown?.[0] ?? null;
  const scheduleSummary = scheduleDashboard?.summary ?? null;
  const nextCdsAgentSchedule = scheduleDashboard?.schedules?.[0] ?? null;
  const latestScheduledExecution = scheduleDashboard?.recentExecutions?.[0] ?? null;
  const governanceSummary = governanceDashboard?.summary ?? null;
  const governanceProfileGate = governanceDashboard?.gates?.find((item) => item.code === 'GOV-PROFILE-SCOPE') ?? null;
  const governanceOwnerPolicies = governanceDashboard?.ownerPolicies ?? [];
  const gitContext = useMemo(() => {
    let branch = '';
    let commit = '';
    let prUrl = '';
    for (const ev of displayedEvents) {
      if (ev.type !== 'tool_result') continue;
      const p = parsePayload(ev);
      const detail = parseJsonString(p.resultSummary) ?? parseJsonString(p.content) ?? {};
      if (typeof detail.branch === 'string' && detail.branch) branch = detail.branch;
      if (typeof detail.commit === 'string' && detail.commit) commit = detail.commit;
      const urlCandidate = typeof detail.url === 'string' ? detail.url
        : typeof detail.prUrl === 'string' ? detail.prUrl
          : typeof detail.pullRequestUrl === 'string' ? detail.pullRequestUrl : '';
      if (urlCandidate && /github\.com\/.+\/pull\/\d+/.test(urlCandidate)) prUrl = urlCandidate;
    }
    if (!prUrl) {
      for (const artifact of artifacts) {
        const match = artifact.body.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
        if (match?.[0]) {
          prUrl = match[0];
          break;
        }
      }
    }
    return { branch, commit, prUrl };
  }, [artifacts, displayedEvents]);
  const auditRows = useMemo(() => {
    if (!activeSession) return [];
    const eventTypes = Array.from(new Set(events.map((item) => item.type))).sort();
    const approvalEvents = events.filter((item) => {
      if (item.type !== 'tool_call' && item.type !== 'tool_result') return false;
      return item.payloadJson.includes('approval') || item.payloadJson.includes('dangerous') || item.payloadJson.includes('auto_allowed');
    }).length;
    return [
      ['会话用户', activeSession.userId],
      ['CDS 连接', activeConnection?.partnerName || activeConnection?.partnerId || activeSession.partner],
      ['模型配置', activeSessionProfile?.name ?? activeSession.runtimeProfileId ?? '未绑定'],
      ['目标仓库', activeSession.gitRepository || activeSession.cdsProjectId],
      ['目标分支', activeSession.gitRef || '未指定'],
      ['Workspace', activeSession.workspaceRoot || '由 CDS sidecar 默认工作区决定'],
      ['资源限制', formatSessionResourcePolicy(activeSession)],
      ['工具策略', activeSession.toolPolicy],
      ['人工接管', activeSession.manualTakeoverEnabled ? `已接管 · ${activeSession.manualTakeoverReason ?? '未填写原因'}` : '未接管'],
      ['事件类型', eventTypes.length > 0 ? eventTypes.join(' / ') : '暂无事件'],
      ['审批相关事件', `${approvalEvents}`],
      ['凭据暴露', '不向前端显示 long token / provider secret'],
    ];
  }, [activeConnection, activeSession, activeSessionProfile, events]);
  const runtimeDiagnostics = useMemo(() => {
    const primaryRuntime = runtimeStatus?.instances?.[0] ?? null;
    const sidecarAdapter = primaryRuntime?.agentAdapter || '';
    const desiredRuntimeAdapter = runtimeStatus?.desiredRuntimeAdapter || '';
    const runtimeTransport = runtimeStatus?.runtimeTransport || '';
    const discoveryMetrics = runtimeStatus?.discoveryMetrics ?? null;
    const discoveryMetricSummary = discoveryMetrics
      ? [
          discoveryMetrics.projectKind ? `kind ${discoveryMetrics.projectKind}` : '',
          discoveryMetrics.activeCdsConnections != null ? `active ${discoveryMetrics.activeCdsConnections}` : '',
          discoveryMetrics.emptyEndpoints != null ? `empty ${discoveryMetrics.emptyEndpoints}` : '',
          discoveryMetrics.runtimeBranchServiceCount != null ? `runtime ${discoveryMetrics.runtimeBranchServiceCount}` : '',
          discoveryMetrics.skippedBranchServiceCount != null ? `skipped ${discoveryMetrics.skippedBranchServiceCount}` : '',
        ].filter(Boolean).join(' · ') || '已解析'
      : '未上报';
    const sidecarState = runtimeStatus
      ? `${runtimeStatus.healthyCount}/${runtimeStatus.instanceCount} healthy`
      : '未检测';
    const registryIssue = runtimeStatus?.registryLastRefreshError || '';
    const blockers = runtimeStatus?.blockers?.filter(Boolean) ?? [];
    const nextActions = runtimeStatus?.nextActions?.filter(Boolean) ?? [];
    const defaultRuntimeProfile = runtimeStatus?.defaultRuntimeProfile ?? null;
    const profileCompatibilityReasonCode = defaultRuntimeProfile?.compatibilityReasonCode || '';
    const profileCompatibilityWarning = defaultRuntimeProfile?.compatibilityReason || defaultRuntimeProfile?.warning || '';
    const profileCompatibilityState = defaultRuntimeProfile
      ? `${defaultRuntimeProfile.compatibleWithDesiredRuntimeAdapter ? '兼容' : '需调整'} · ${defaultRuntimeProfile.name} / ${defaultRuntimeProfile.model}`
      : '未上报';
    const readyzBlockers = primaryRuntime?.readyzBlockers?.filter(Boolean) ?? [];
    const readyzNextActions = primaryRuntime?.readyzNextActions?.filter(Boolean) ?? [];
    const providerKeyState = primaryRuntime
      ? boolStatus(primaryRuntime.anthropicKeyConfigured, '已配置', '缺失')
      : '无实例';
    const sidecarTokenState = primaryRuntime
      ? boolStatus(primaryRuntime.sidecarTokenConfigured || primaryRuntime.tokenConfigured, '已配置', '缺失')
      : '无实例';
    const readyState = primaryRuntime ? boolStatus(primaryRuntime.ready, 'ready', 'not ready') : '无实例';
    const httpState = primaryRuntime?.httpStatus ? `HTTP ${primaryRuntime.httpStatus}` : '未探测';
    const payloads = events.map(parsePayload).reverse();
    const latestRuntimePayload = payloads.find((payload) => (
      readString(payload, 'runtimeAdapter')
      || readString(payload, 'runtimeInstance')
      || readString(payload, 'runtimeRunId')
      || readString(payload, 'messageId')
      || readString(payload, 'sidecar')
      || readString(payload, 'loopOwner')
    ));
    const latestRuntimeContent = latestRuntimePayload ? parseJsonString(latestRuntimePayload.content) : null;
    const latestWorkspaceErrorPayload = payloads.find((payload) => (
      readString(payload, 'errorCode') === 'workspace_prepare_failed'
      || readString(payload, 'error_code') === 'workspace_prepare_failed'
      || readString(payload, 'workspaceErrorCode')
      || readString(parseJsonString(payload.content), 'workspaceErrorCode')
    ));
    const latestWorkspaceErrorContent = latestWorkspaceErrorPayload ? parseJsonString(latestWorkspaceErrorPayload.content) : null;
    const workspaceErrorCode = latestWorkspaceErrorPayload
      ? readString(latestWorkspaceErrorPayload, 'workspaceErrorCode') || readString(latestWorkspaceErrorContent, 'workspaceErrorCode')
      : '';
    const workspaceErrorActions = latestWorkspaceErrorPayload
      ? [
          ...readStringArray(latestWorkspaceErrorPayload, 'nextActions'),
          ...readStringArray(latestWorkspaceErrorContent, 'nextActions'),
        ]
      : [];
    const workspaceErrorState = workspaceErrorCode
      ? `${workspaceErrorCode}${workspaceErrorActions[0] ? ` · ${workspaceErrorActions[0]}` : ''}`
      : '无 workspace 错误';
    const latestProviderKeyErrorPayload = payloads.find((payload) => (
      readString(payload, 'errorCode') === 'provider_key_missing'
      || readString(payload, 'error_code') === 'provider_key_missing'
      || readString(payload, 'code') === 'provider_key_missing'
      || readString(parseJsonString(payload.content), 'errorCode') === 'provider_key_missing'
      || readString(parseJsonString(payload.content), 'error_code') === 'provider_key_missing'
    ));
    const latestProviderKeyErrorContent = latestProviderKeyErrorPayload ? parseJsonString(latestProviderKeyErrorPayload.content) : null;
    const providerKeyErrorCode = latestProviderKeyErrorPayload
      ? readString(latestProviderKeyErrorPayload, 'errorCode')
        || readString(latestProviderKeyErrorPayload, 'error_code')
        || readString(latestProviderKeyErrorPayload, 'code')
        || readString(latestProviderKeyErrorContent, 'errorCode')
        || readString(latestProviderKeyErrorContent, 'error_code')
      : '';
    const providerKeyErrorActions = latestProviderKeyErrorPayload
      ? [
          ...readStringArray(latestProviderKeyErrorPayload, 'nextActions'),
          ...readStringArray(latestProviderKeyErrorContent, 'nextActions'),
        ]
      : [];
    const providerKeyErrorState = providerKeyErrorCode
      ? `${providerKeyErrorCode}${providerKeyErrorActions[0] ? ` · ${providerKeyErrorActions[0]}` : ''}`
      : '无 provider secret 错误';
    const latestRuntimeErrorEntry = events
      .map((event) => ({ event, payload: parsePayload(event) }))
      .reverse()
      .find(({ event, payload }) => (
        event.type === 'error'
        && (
          readString(payload, 'runtimeAdapter')
          || readString(payload, 'runtimeInstance')
          || readString(payload, 'source').includes('sidecar')
          || readString(payload, 'source').includes('runtime')
          || readString(payload, 'code').includes('claude_agent_sdk')
          || readString(payload, 'code') === 'provider_key_missing'
          || readString(payload, 'code') === 'workspace_prepare_failed'
          || readString(payload, 'recoveryKind')
        )
      )) ?? null;
    const latestRuntimeErrorPayload = latestRuntimeErrorEntry?.payload ?? null;
    const latestRuntimeErrorContent = latestRuntimeErrorPayload ? parseJsonString(latestRuntimeErrorPayload.content) : null;
    const runtimeErrorCode = latestRuntimeErrorPayload
      ? readString(latestRuntimeErrorPayload, 'code')
        || readString(latestRuntimeErrorPayload, 'errorCode')
        || readString(latestRuntimeErrorPayload, 'error_code')
        || readString(latestRuntimeErrorContent, 'errorCode')
        || readString(latestRuntimeErrorContent, 'error_code')
      : '';
    const runtimeErrorMessage = latestRuntimeErrorPayload
      ? readString(latestRuntimeErrorPayload, 'message') || readString(latestRuntimeErrorContent, 'message')
      : '';
    const runtimeErrorRecoveryKind = latestRuntimeErrorPayload
      ? readString(latestRuntimeErrorPayload, 'recoveryKind') || readString(latestRuntimeErrorContent, 'recoveryKind')
      : '';
    const runtimeErrorRetryable = latestRuntimeErrorPayload
      ? readBoolean(latestRuntimeErrorPayload, 'retryable') ?? readBoolean(latestRuntimeErrorContent, 'retryable')
      : null;
    const runtimeErrorActions = latestRuntimeErrorPayload
      ? [
          ...readStringArray(latestRuntimeErrorPayload, 'nextActions'),
          ...readStringArray(latestRuntimeErrorContent, 'nextActions'),
        ]
      : [];
    const runtimeErrorState = runtimeErrorCode
      ? [
          runtimeErrorCode,
          runtimeErrorRecoveryKind ? `kind=${runtimeErrorRecoveryKind}` : '',
          runtimeErrorRetryable === null ? '' : `retryable=${runtimeErrorRetryable ? 'yes' : 'no'}`,
          runtimeErrorActions[0] || runtimeErrorMessage,
        ].filter(Boolean).join(' · ')
      : '无 runtime 错误';
    const approvalRequests = events
      .map((event) => ({ event, payload: parsePayload(event) }))
      .filter(({ event, payload }) => event.type === 'tool_call' && readString(payload, 'approvalId'));
    const approvalDecisions = events
      .map((event) => ({ event, payload: parsePayload(event) }))
      .filter(({ event, payload }) => event.type === 'tool_result' && readString(payload, 'approvalId') && readString(payload, 'source') === 'map-tool-approval');
    const decidedApprovalIds = new Set(approvalDecisions.map(({ payload }) => readString(payload, 'approvalId')).filter(Boolean));
    const pendingApprovalCount = approvalRequests.filter(({ payload }) => {
      const approvalId = readString(payload, 'approvalId');
      return readString(payload, 'status') === 'waiting' && !decidedApprovalIds.has(approvalId);
    }).length;
    const latestApprovalDecision = approvalDecisions.at(-1)?.payload ?? null;
    const approvalEvidence = {
      requestCount: approvalRequests.length,
      pendingCount: pendingApprovalCount,
      decisionCount: approvalDecisions.length,
      latestDecision: latestApprovalDecision ? readString(latestApprovalDecision, 'decision') : '',
      latestApprovalId: latestApprovalDecision ? readString(latestApprovalDecision, 'approvalId') : '',
    };
    const approvalEvidenceState = approvalEvidence.requestCount > 0
      ? `${approvalEvidence.requestCount} requests · ${approvalEvidence.decisionCount} decisions${approvalEvidence.pendingCount ? ` · ${approvalEvidence.pendingCount} pending` : ''}`
      : '无审批事件';
    const cancelEvents = events
      .map((event) => ({ event, payload: parsePayload(event) }))
      .filter(({ payload }) => {
        const message = readString(payload, 'message');
        return readString(payload, 'reason') === 'session_stop_requested'
          || message.includes('runtime run cancel')
          || readString(payload, 'code') === 'cancelled'
          || readString(payload, 'errorCode') === 'cancelled';
      });
    const stopRequested = cancelEvents.some(({ payload }) => readString(payload, 'reason') === 'session_stop_requested');
    const runtimeCancelRequested = cancelEvents.some(({ payload }) => readString(payload, 'message').includes('runtime run cancel requested'));
    const sdkCancelled = cancelEvents.some(({ payload }) => readString(payload, 'code') === 'cancelled' || readString(payload, 'errorCode') === 'cancelled');
    const cancelEvidence = {
      eventCount: cancelEvents.length,
      stopRequested,
      runtimeCancelRequested,
      sdkCancelled,
      latestMessage: cancelEvents.length > 0 ? readString(cancelEvents[cancelEvents.length - 1].payload, 'message') || readString(cancelEvents[cancelEvents.length - 1].payload, 'reason') : '',
    };
    const cancelEvidenceState = cancelEvidence.eventCount > 0
      ? `${cancelEvidence.eventCount} events · stop ${cancelEvidence.stopRequested ? 'yes' : 'no'} · runtime ${cancelEvidence.runtimeCancelRequested ? 'yes' : 'no'} · sdk ${cancelEvidence.sdkCancelled ? 'yes' : 'no'}`
      : '无取消事件';
    const primaryAdapterDiagnostics = primaryRuntime ? parseJsonString(primaryRuntime.adapterDiagnosticsJson) : null;
    const adapter = activeSession?.runtimeAdapter
      || (latestRuntimePayload ? readString(latestRuntimePayload, 'runtimeAdapter') : '')
      || sidecarAdapter
      || desiredRuntimeAdapter
      || (activeSession?.runtime === 'claude-sdk' ? 'sidecar-runtime-adapter' : '');
    const loopOwner = (latestRuntimePayload ? readString(latestRuntimePayload, 'loopOwner') : '')
      || (latestRuntimeContent ? readString(latestRuntimeContent, 'loopOwner') : '')
      || primaryRuntime?.loopOwner
      || (primaryAdapterDiagnostics ? readString(primaryAdapterDiagnostics, 'loopOwner') : '')
      || (adapter.includes('legacy') ? 'sidecar-legacy-loop' : adapter ? 'claude-agent-sdk' : '');
    const sdkLoopEnabled = readBoolean(latestRuntimeContent, 'sdkLoopEnabled')
      ?? primaryRuntime?.sdkLoopEnabled
      ?? readBoolean(primaryAdapterDiagnostics, 'sdkLoopEnabled');
    const legacyLoopImport = (latestRuntimeContent ? readString(latestRuntimeContent, 'legacyLoopImport') : '')
      || primaryRuntime?.legacyLoopImport
      || (primaryAdapterDiagnostics ? readString(primaryAdapterDiagnostics, 'legacyLoopImport') : '');
    const mapRole = (latestRuntimeContent ? readString(latestRuntimeContent, 'mapRole') : '')
      || primaryRuntime?.mapRole
      || (primaryAdapterDiagnostics ? readString(primaryAdapterDiagnostics, 'mapRole') : '');
    const cdsRole = (latestRuntimeContent ? readString(latestRuntimeContent, 'cdsRole') : '')
      || primaryRuntime?.cdsRole
      || (primaryAdapterDiagnostics ? readString(primaryAdapterDiagnostics, 'cdsRole') : '');
    const approvalBridge = (latestRuntimeContent ? readString(latestRuntimeContent, 'approvalBridge') : '')
      || (primaryAdapterDiagnostics ? readString(primaryAdapterDiagnostics, 'approvalBridge') : '');
    const claudeCliPath = primaryRuntime?.claudeCliPath
      || (primaryAdapterDiagnostics ? readString(primaryAdapterDiagnostics, 'claudeCliPath') : '');
    const claudeCliBundled = primaryRuntime?.claudeCliBundled
      ?? readBoolean(primaryAdapterDiagnostics, 'claudeCliBundled');
    const claudeCliState = claudeCliBundled === true
      ? (claudeCliPath ? `SDK bundled · PATH ${claudeCliPath}` : 'SDK bundled · PATH 未配置')
      : claudeCliBundled === false
        ? 'SDK 未安装'
        : claudeCliPath || '未上报';
    const workspacePreparation = (
      primaryRuntime?.workspacePreparation
      ?? (primaryAdapterDiagnostics ? (primaryAdapterDiagnostics.workspacePreparation as Record<string, unknown> | null | undefined) : null)
      ?? null
    );
    const autoGitWorkspace = readBoolean(workspacePreparation, 'autoGitWorkspace');
    const workspaceRoot = workspacePreparation ? readString(workspacePreparation, 'workspacesRoot') : '';
    const workspaceRootExists = readBoolean(workspacePreparation, 'workspacesRootExists');
    const gitInstalled = readBoolean(workspacePreparation, 'gitInstalled');
    const privateRepositoryAuthConfigured = readBoolean(workspacePreparation, 'privateRepositoryAuthConfigured');
    const workspaceLock = workspacePreparation ? readString(workspacePreparation, 'workspaceLock') : '';
    const workspacePrepState = workspacePreparation
      ? [
          autoGitWorkspace === true ? 'auto git' : autoGitWorkspace === false ? 'manual only' : 'auto 未上报',
          gitInstalled === true ? 'git ok' : gitInstalled === false ? 'git missing' : 'git 未上报',
          workspaceRootExists === true ? 'root exists' : workspaceRootExists === false ? 'root missing' : 'root 未上报',
          privateRepositoryAuthConfigured === true ? 'private repo auth ok' : privateRepositoryAuthConfigured === false ? 'private repo auth missing' : 'private auth 未上报',
          workspaceLock || 'lock 未上报',
        ].join(' · ')
      : '未上报';
    const runId = activeSession?.currentRuntimeRunId
      || (latestRuntimePayload ? readString(latestRuntimePayload, 'runtimeRunId') || readString(latestRuntimePayload, 'messageId') : '');
    const instance = latestRuntimePayload
      ? readString(latestRuntimePayload, 'runtimeInstance') || readString(latestRuntimePayload, 'sidecar')
      : '';
    const source = latestRuntimePayload ? readString(latestRuntimePayload, 'source') : '';
    const adapterLabel = adapter || '未上报';
    const adapterMode = adapter.includes('legacy')
      ? 'Legacy fallback'
      : adapter
        ? 'Official SDK adapter'
        : '待上报';
    const sdkLoopState = sdkLoopEnabled === null
      ? '未上报'
      : sdkLoopEnabled
        ? '官方 SDK loop'
        : 'Legacy sidecar loop';
    const cancelState = activeSession?.currentRuntimeRunId
      ? 'Stop 会取消底层 run'
      : activeSession?.status === 'running'
        ? '等待 run id'
        : '无活动 run';
    const selectedProfile = activeSessionProfile ?? activeProfile;
    const profileReady = Boolean(selectedProfile?.hasApiKey && selectedProfile.baseUrl && selectedProfile.model);
    const runtimePoolReady = Boolean(runtimeStatus && runtimeStatus.instanceCount > 0 && runtimeStatus.healthyCount > 0);
    const officialLoopReady = adapterMode === 'Official SDK adapter'
      && loopOwner === 'claude-agent-sdk'
      && sdkLoopEnabled === true;
    const approvalBridgeReady = approvalBridge === 'sdk-can-use-tool';
    const eventStreamState = activeSession?.status === 'running'
      ? (eventStreamHealthy ? 'SSE live' : '等待 SSE 心跳')
      : events.length > 0
        ? '可回放'
        : '待运行';
    const defaultProfileReady = Boolean(defaultRuntimeProfile?.hasApiKey && defaultRuntimeProfile.compatibleWithDesiredRuntimeAdapter);
    const templateReady = Boolean(anthropicOfficialProfileTemplate && activeAdapterCompatibility);
    const backendCommercialReadiness = runtimeStatus?.commercialReadiness ?? null;
    const backendCommercialGates = new Map((backendCommercialReadiness?.gates ?? []).map((gate) => [gate.code, gate]));
    const backendGateState = (code: string, fallback: RuntimeReadinessGate['state']): RuntimeReadinessGate['state'] => {
      const status = backendCommercialGates.get(code)?.status;
      if (status === 'pass') return 'pass';
      if (status === 'unblocked') return 'warn';
      if (status === 'pending') return 'pending';
      return fallback;
    };
    const backendGateValue = (code: string, fallback: string): string => backendCommercialGates.get(code)?.status || fallback;
    const backendGateDetail = (code: string, fallback: string): string => backendCommercialGates.get(code)?.message || fallback;
    const backendGateReasonCode = (code: string): string | null => backendCommercialGates.get(code)?.reasonCode || null;
    const providerEvidenceState = resolveProviderEvidenceState({
      defaultProfileReady,
      officialLoopReady,
      hasReadonlyRunEvidence: events.some((event) => event.type === 'done' || event.type === 'text_delta')
        && messages.some((message) => message.role === 'assistant' && message.content.trim()),
      hasApprovalEvidence: approvalEvidence.requestCount > 0 && approvalEvidence.decisionCount > 0,
      hasCancelEvidence: cancelEvidence.runtimeCancelRequested || cancelEvidence.sdkCancelled,
    });
    const s1EvidenceReady = providerEvidenceState.s1EvidenceReady;
    const s2EvidenceReady = providerEvidenceState.s2EvidenceReady;
    const s3EvidenceReady = providerEvidenceState.s3EvidenceReady;
    const v1EvidenceReady = Boolean(runtimeStatus && runtimeStatusLoadedAt);
    const commercialReadinessGates: CommercialReadinessGate[] = [
      {
        code: 'R0',
        label: '控制面与官方 loop',
        value: backendGateValue('R0', runtimePoolReady && officialLoopReady ? 'ready' : runtimePoolReady ? 'pool ready' : 'not ready'),
        detail: backendGateDetail('R0', runtimePoolReady && officialLoopReady
          ? 'MAP 已发现 healthy sidecar，loopOwner 指向 claude-agent-sdk。'
          : runtimePoolReady
          ? 'runtime pool 可用，但还需要证明 loopOwner=claude-agent-sdk 且 SDK loop enabled。'
          : blockers[0] || registryIssue || '需要先恢复 CDS sidecar runtime pool.'),
        state: backendGateState('R0', runtimePoolReady && officialLoopReady ? 'pass' : runtimeStatus ? 'warn' : 'pending'),
        reasonCode: backendGateReasonCode('R0'),
      },
      {
        code: 'A0',
        label: '官方 SDK 边界',
        value: backendGateValue('A0', activeAdapterCompatibility?.routableByDefault ? 'ready' : 'pending'),
        detail: backendGateDetail('A0', activeAdapterCompatibility?.routableByDefault
          ? '默认 adapter contract 指向 claude-agent-sdk，MAP/CDS 只保留控制面，legacy loop 只能显式 fallback。'
          : '需要后端 adapter compatibility 证明 claude-agent-sdk 可默认路由且没有缺失 contract。'),
        state: backendGateState('A0', activeAdapterCompatibility?.routableByDefault ? 'pass' : 'pending'),
        reasonCode: backendGateReasonCode('A0'),
      },
      {
        code: 'R1',
        label: '默认 Claude profile',
        value: backendGateValue('R1', defaultProfileReady ? 'ready' : defaultRuntimeProfile ? 'pending' : 'missing'),
        detail: backendGateDetail('R1', defaultProfileReady
          ? `${defaultRuntimeProfile?.name} 已兼容 ${desiredRuntimeAdapter || 'claude-agent-sdk'}，且 provider secret 已保存。`
          : defaultRuntimeProfile
          ? profileCompatibilityWarning || `${defaultRuntimeProfile.name} 仍不是 Claude Code provider-switch profile，真实 S1/S2/S3 会被阻断。`
          : '需要保存 claude-sdk runtime + anthropic protocol 的默认 CDS-managed runtime profile，并保存 provider secret.'),
        state: backendGateState('R1', defaultProfileReady ? 'pass' : defaultRuntimeProfile ? 'warn' : 'pending'),
        reasonCode: backendGateReasonCode('R1') || profileCompatibilityReasonCode || null,
      },
      {
        code: 'T1',
        label: '官方模板与兼容矩阵',
        value: backendGateValue('T1', templateReady ? 'ready' : 'pending'),
        detail: backendGateDetail('T1', templateReady
          ? '原生 Anthropic 官方模板和 adapter compatibility 均由后端返回；cc-switch/DeepSeek 走自定义 provider-switch profile。'
          : '需要后端返回原生 Anthropic 官方模板和 claude-agent-sdk 兼容矩阵.'),
        state: backendGateState('T1', templateReady ? 'pass' : 'pending'),
        reasonCode: backendGateReasonCode('T1'),
      },
      {
        code: 'S1',
        label: '只读 provider run',
        value: s1EvidenceReady ? 'evidence found' : backendGateValue('S1', defaultProfileReady ? 'unblocked' : 'blocked'),
        detail: s1EvidenceReady
          ? '当前会话已有 assistant 输出或 done 事件，可作为只读 run 的页面证据。'
          : providerEvidenceState.s1DetailOverride
          ? providerEvidenceState.s1DetailOverride
          : backendGateDetail('S1', defaultProfileReady
          ? '配置已解锁；还需运行 S1 smoke，证明官方 SDK 能真实审查仓库。'
          : providerEvidenceState.blockedDetail),
        state: s1EvidenceReady ? 'pass' : backendGateState('S1', defaultProfileReady ? 'warn' : 'pending'),
        reasonCode: backendGateReasonCode('S1') || (!defaultProfileReady ? profileCompatibilityReasonCode || null : null),
      },
      {
        code: 'S2',
        label: 'MAP 工具审批',
        value: s2EvidenceReady ? 'evidence found' : backendGateValue('S2', defaultProfileReady ? 'unblocked' : 'blocked'),
        detail: s2EvidenceReady
          ? '当前会话已有 approval request 和 MAP decision 证据。'
          : providerEvidenceState.s2DetailOverride
          ? providerEvidenceState.s2DetailOverride
          : backendGateDetail('S2', defaultProfileReady
          ? '还需运行 S2 controls，证明危险工具会回到 MAP 审批。'
          : providerEvidenceState.blockedDetail),
        state: s2EvidenceReady ? 'pass' : backendGateState('S2', defaultProfileReady ? 'warn' : 'pending'),
        reasonCode: backendGateReasonCode('S2') || (!defaultProfileReady ? profileCompatibilityReasonCode || null : null),
      },
      {
        code: 'S3',
        label: 'Stop / interrupt',
        value: s3EvidenceReady ? 'evidence found' : backendGateValue('S3', defaultProfileReady ? 'unblocked' : 'blocked'),
        detail: s3EvidenceReady
          ? '当前会话已有 runtime cancel 或 SDK cancelled 证据。'
          : providerEvidenceState.s3DetailOverride
          ? providerEvidenceState.s3DetailOverride
          : backendGateDetail('S3', defaultProfileReady
          ? '还需运行 S3 controls，证明 Stop 能触达底层 SDK run。'
          : providerEvidenceState.blockedDetail),
        state: s3EvidenceReady ? 'pass' : backendGateState('S3', defaultProfileReady ? 'warn' : 'pending'),
        reasonCode: backendGateReasonCode('S3') || (!defaultProfileReady ? profileCompatibilityReasonCode || null : null),
      },
      {
        code: 'V1',
        label: '页面可观察性',
        value: v1EvidenceReady ? 'visible' : 'pending',
        detail: v1EvidenceReady
          ? '当前页面已显示 runtime-status、adapter、profile、事件和诊断包字段。'
          : '需要打开 /cds-agent 并看到真实 runtime-status 结果。',
        state: v1EvidenceReady ? 'pass' : 'pending',
        reasonCode: backendGateReasonCode('V1'),
      },
    ];
    const commercialPassed = commercialReadinessGates.filter((gate) => gate.state === 'pass').length;
    const commercialTotal = commercialReadinessGates.length;
    const commercialPending = commercialReadinessGates.filter((gate) => gate.state !== 'pass');
    const commercialState = commercialPassed === commercialTotal
      ? 'commercial-ready'
      : defaultProfileReady
        ? 'provider-smokes-required'
        : 'profile-blocked';
    const nextCyclePlan = runtimeStatus?.nextCyclePlan ?? null;
    const debugCommands = runtimeStatus?.debugCommands ?? [];
    const backendExecutionPanel = runtimeStatus?.executionPanel ?? null;
    const firstBlockedCycleItem = nextCyclePlan?.items.find((item) => item.status !== 'pass') ?? null;
    const primaryDebugCommand = debugCommands.find((item) => item.status === 'blocked')
      ?? debugCommands.find((item) => item.status !== 'pass')
      ?? debugCommands[0]
      ?? null;
    const commercialBlockingGate = commercialPending[0] ?? null;
    const commercialBlockingCode = commercialBlockingGate?.code
      ?? firstBlockedCycleItem?.code
      ?? primaryDebugCommand?.blockedBy
      ?? primaryDebugCommand?.code
      ?? '';
    const commercialNextAction = commercialBlockingGate?.detail
      || firstBlockedCycleItem?.nextActions?.[0]
      || primaryDebugCommand?.purpose
      || (commercialState === 'commercial-ready' ? '商业级门禁已通过。' : '等待 runtime-status 返回下一步建议。');
    const commercialNextCommand = primaryDebugCommand?.command ?? '';
    const executionCommercialState = backendExecutionPanel?.status || commercialState;
    const executionBlockingCode = backendExecutionPanel?.currentBlockingGate || commercialBlockingCode;
    const executionNextAction = backendExecutionPanel?.blockingReason || commercialNextAction;
    const executionDeploymentAdvice = backendExecutionPanel?.deploymentAdvice
      || (executionCommercialState === 'commercial-ready'
        ? '商业级门禁已通过；只有新代码变更、promotion 或环境切换时才需要重新部署。'
        : defaultProfileReady
          ? '不要重复部署；下一步是显式开启 provider smoke，补齐 S1/S2/S3 的真实调用证据。'
          : '不要靠重新部署解决 R1；当前阻塞是 CDS-managed runtime profile/secret，需要保存 Anthropic/Claude-compatible profile。');
    const executionNextCommand = backendExecutionPanel?.nextCommand || commercialNextCommand;
    const executionGateCounts = backendExecutionPanel?.gateCounts ?? null;
    const executionTimeline = backendExecutionPanel?.timeline ?? nextCyclePlan?.items.map((item) => ({
      order: item.order,
      code: item.code,
      title: item.title,
      status: item.status,
      blockedBy: item.blockedBy,
    })) ?? [];
    const executionRunbook = backendExecutionPanel?.runbook ?? [];
    const executionCurrentStep = backendExecutionPanel?.currentStep
      ?? executionTimeline.find((item) => item.status !== 'pass')
      ?? null;
    const executionStepTotal = backendExecutionPanel?.stepTotal ?? executionTimeline.length;
    const executionStepIndex = backendExecutionPanel?.stepIndex
      ?? executionCurrentStep?.order
      ?? executionStepTotal;
    const executionPassedSteps = backendExecutionPanel?.passedSteps
      ?? executionTimeline.filter((item) => item.status === 'pass').length;
    const executionPendingSteps = backendExecutionPanel?.pendingSteps
      ?? Math.max(0, executionStepTotal - executionPassedSteps);
    const executionTaskBoard = backendExecutionPanel?.taskBoard ?? [];
    const executionNextStepEta = backendExecutionPanel?.nextStepEta ?? '';
    const executionTimeSinkAdvice = backendExecutionPanel?.timeSinkAdvice ?? '';
    const executionRunway = resolveExecutionRunway({
      commercialComplete: backendExecutionPanel?.commercialComplete ?? executionCommercialState === 'commercial-ready',
      blockingCode: executionBlockingCode,
      deploymentAdvice: executionDeploymentAdvice,
      nextCommand: executionNextCommand,
    });
    const readinessGates: RuntimeReadinessGate[] = [
      {
        label: '官方 loop 边界',
        value: officialLoopReady ? '已切到官方 SDK' : adapterMode,
        detail: officialLoopReady
          ? 'MAP/CDS 只保留控制面，turn loop 由 claude-agent-sdk 承担。'
          : '还不能证明 turn loop 已从自研路径收缩到官方 SDK adapter。',
        state: officialLoopReady ? 'pass' : adapter ? 'warn' : 'pending',
      },
      {
        label: 'Runtime pool',
        value: runtimeStatus ? `${runtimeStatus.healthyCount}/${runtimeStatus.instanceCount} healthy` : '检测中',
        detail: runtimePoolReady
          ? 'MAP 已发现可路由 sidecar 实例。'
          : blockers[0] || registryIssue || '需要 CDS sidecar pool 实例发现返回可用实例。',
        state: runtimePoolReady ? 'pass' : runtimeStatus ? 'warn' : 'pending',
      },
      {
        label: '模型凭据',
        value: profileCompatibilityWarning ? '模型需调整' : providerKeyErrorCode ? '执行时缺失' : profileReady ? '可按请求下发' : '未就绪',
        detail: providerKeyErrorCode
          ? (providerKeyErrorActions[0] || '本次 run 没有拿到 CDS-managed runtime profile/secret 或 request override provider secret。')
          : profileCompatibilityWarning
          ? profileCompatibilityWarning
          : profileReady
          ? 'Runtime profile 已具备 baseUrl、model 和可用 provider secret。'
          : profileBlockReason(selectedProfile),
        state: providerKeyErrorCode || profileCompatibilityWarning ? 'warn' : profileReady ? 'pass' : selectedProfile ? 'warn' : 'pending',
      },
      {
        label: '审批桥',
        value: approvalBridgeReady ? 'SDK can_use_tool' : approvalBridge || '未上报',
        detail: approvalBridgeReady
          ? '危险内置工具会进入 MAP approval request，再返回官方 SDK PermissionResult。'
          : '需要真实 runtime_init 或 readyz 证明官方 SDK can_use_tool 已接入 MAP 审批。',
        state: approvalBridgeReady ? 'pass' : adapterMode === 'Official SDK adapter' ? 'warn' : 'pending',
      },
      {
        label: '取消句柄',
        value: runId ? shortId(runId) : '无活动 run',
        detail: runId
          ? 'Stop 会调用 sidecar cancel，并在官方路径触发 ClaudeSDKClient.interrupt()。'
          : '需要启动真实 run 后验证 Stop 能取消底层 SDK 调用。',
        state: runId ? 'pass' : activeSessionEffectiveStatus === 'running' ? 'warn' : 'pending',
      },
      {
        label: '事件恢复',
        value: eventStreamState,
        detail: eventStreamHealthy
          ? 'SSE afterSeq 正在续读，断线后仍可按游标回放。'
          : '未处于 live SSE 时，仍保留 JSON 分页回放兜底。',
        state: eventStreamHealthy || events.length > 0 ? 'pass' : activeSession ? 'pending' : 'warn',
      },
      {
        label: '错误归因',
        value: runtimeErrorCode ? (runtimeErrorRetryable === false ? '需修配置' : '可诊断') : '无错误',
        detail: runtimeErrorCode
          ? (runtimeErrorActions[0] || runtimeErrorMessage || `recoveryKind=${runtimeErrorRecoveryKind || '未上报'}`)
          : 'Runtime error 会上提 code、recoveryKind、retryable 和 nextActions 到诊断包。',
        state: runtimeErrorCode ? 'warn' : events.length > 0 ? 'pass' : 'pending',
      },
    ];
    return {
      adapter: adapterLabel,
      adapterMode,
      loopOwner: loopOwner || '未上报',
      sdkLoopEnabled,
      legacyLoopImport: legacyLoopImport || '未上报',
      mapRole: mapRole || '未上报',
      cdsRole: cdsRole || '未上报',
      runId,
      instance,
      source,
      cancelState,
      commercialReadinessGates,
      commercialPassed,
      commercialTotal,
      commercialPending,
      commercialState: executionCommercialState,
      commercialBlockingCode: executionBlockingCode,
      commercialNextAction: executionNextAction,
      commercialDeploymentAdvice: executionDeploymentAdvice,
      commercialNextCommand: executionNextCommand,
      executionRunway,
      executionGateCounts,
      executionStepIndex,
      executionStepTotal,
      executionPassedSteps,
      executionPendingSteps,
      executionCurrentStep,
      executionTimeline,
      executionRunbook,
      executionTaskBoard,
      executionNextStepEta,
      executionTimeSinkAdvice,
      nextCyclePlan,
      debugCommands,
      readinessGates,
      rows: [
        ['Adapter', adapterLabel],
        ['Mode', adapterMode],
        ['Adapter status', activeAdapterCompatibility?.status || '未上报'],
        ['Desired adapter', desiredRuntimeAdapter || '未上报'],
        ['Transport', runtimeTransport || '未上报'],
        ['Loop owner', loopOwner || '未上报'],
        ['Expected loop owner', activeAdapterCompatibility?.loopOwner || '未上报'],
        ['Legacy loop import', legacyLoopImport || '未上报'],
        ['Expected MAP role', activeAdapterCompatibility?.mapRole || '未上报'],
        ['SDK loop', sdkLoopState],
        ['MAP role', mapRole || '未上报'],
        ['CDS role', cdsRole || '未上报'],
        ['External CLI', claudeCliState],
        ['Workspace prep', workspacePrepState],
        ['Workspace root', workspaceRoot || '未上报'],
        ['Private repo auth', privateRepositoryAuthConfigured === true ? '已配置' : privateRepositoryAuthConfigured === false ? '未配置' : '未上报'],
        ['Workspace error', workspaceErrorState],
        ['Runtime error', runtimeErrorState],
        ['Approval evidence', approvalEvidenceState],
        ['Cancel evidence', cancelEvidenceState],
        ['Run ID', shortId(runId)],
        ['Instance', instance || '未上报'],
        ['Source', source || '无 runtime 事件'],
        ['Pool', sidecarState],
        ['Ready', readyState],
        ['HTTP', httpState],
        ['Default profile', profileCompatibilityState],
        ['Profile reason', profileCompatibilityReasonCode || '无结构化原因'],
        ['Execution panel', backendExecutionPanel ? `${backendExecutionPanel.status} · ${backendExecutionPanel.currentBlockingGate || 'clear'}` : 'page-derived'],
        ['Profile warning', profileCompatibilityWarning || '无兼容性提示'],
        ['Provider key', providerKeyState],
        ['Provider key error', providerKeyErrorState],
        ['Sidecar token', sidecarTokenState],
        ['Discovery refresh', runtimeDiscoveryRefreshed === null ? '未请求' : runtimeDiscoveryRefreshed ? `已触发 · ${formatTime(runtimeStatusLoadedAt)}` : `未触发 · ${formatTime(runtimeStatusLoadedAt)}`],
        ['Discovery metrics', discoveryMetricSummary],
        ['Discovery', registryIssue || '无发现异常'],
        ['Blocker', blockers[0] || '无阻塞项'],
        ['Next', nextActions[0] || '无建议动作'],
        ['Readyz blocker', readyzBlockers[0] || '无实例级阻塞'],
        ['Readyz next', readyzNextActions[0] || '无实例级建议'],
        ['Cancel', cancelState],
      ],
      blockers,
      nextActions,
      readyzBlockers,
      readyzNextActions,
      approvalEvidence,
      cancelEvidence,
      runtimeError: runtimeErrorCode ? {
        code: runtimeErrorCode,
        message: runtimeErrorMessage,
        recoveryKind: runtimeErrorRecoveryKind,
        retryable: runtimeErrorRetryable,
        nextActions: runtimeErrorActions,
        source: latestRuntimeErrorPayload ? readString(latestRuntimeErrorPayload, 'source') : '',
        runtimeAdapter: latestRuntimeErrorPayload ? readString(latestRuntimeErrorPayload, 'runtimeAdapter') : '',
        runtimeInstance: latestRuntimeErrorPayload ? readString(latestRuntimeErrorPayload, 'runtimeInstance') : '',
      } : null,
      workspaceError: workspaceErrorCode ? {
        code: workspaceErrorCode,
        nextActions: workspaceErrorActions,
        gitRepository: latestWorkspaceErrorPayload
          ? readString(latestWorkspaceErrorPayload, 'gitRepository') || readString(latestWorkspaceErrorContent, 'gitRepository')
          : '',
        gitRef: latestWorkspaceErrorPayload
          ? readString(latestWorkspaceErrorPayload, 'gitRef') || readString(latestWorkspaceErrorContent, 'gitRef')
          : '',
        privateRepositoryAuthConfigured: latestWorkspaceErrorPayload
          ? readBoolean(latestWorkspaceErrorPayload, 'privateRepositoryAuthConfigured') ?? readBoolean(latestWorkspaceErrorContent, 'privateRepositoryAuthConfigured')
          : null,
      } : null,
      providerKeyError: providerKeyErrorCode ? {
        code: providerKeyErrorCode,
        nextActions: providerKeyErrorActions,
        upstreamSource: latestProviderKeyErrorPayload
          ? readString(latestProviderKeyErrorPayload, 'upstreamSource') || readString(latestProviderKeyErrorContent, 'upstreamSource')
          : '',
        baseUrlConfigured: latestProviderKeyErrorPayload
          ? readBoolean(latestProviderKeyErrorPayload, 'baseUrlConfigured') ?? readBoolean(latestProviderKeyErrorContent, 'baseUrlConfigured')
          : null,
        providerKeyMode: latestProviderKeyErrorPayload
          ? readString(latestProviderKeyErrorPayload, 'providerKeyMode') || readString(latestProviderKeyErrorContent, 'providerKeyMode')
          : '',
      } : null,
    };
  }, [activeAdapterCompatibility, activeProfile, activeSession, activeSessionEffectiveStatus, activeSessionProfile, anthropicOfficialProfileTemplate, eventStreamHealthy, events, messages, runtimeDiscoveryRefreshed, runtimeStatus, runtimeStatusLoadedAt]);
  const sidecarInstanceSummaries = useMemo(() => (
    (runtimeStatus?.instances ?? []).map((item) => ({
      name: item.name,
      source: item.source,
      tags: item.tags,
      ready: item.ready,
      httpStatus: item.httpStatus,
      agentAdapter: item.agentAdapter,
      providerKeyRequiredForReady: item.providerKeyRequiredForReady,
      anthropicKeyConfigured: item.anthropicKeyConfigured,
      sidecarTokenConfigured: item.sidecarTokenConfigured,
      loopOwner: item.loopOwner,
      sdkLoopEnabled: item.sdkLoopEnabled,
      legacyLoopImport: item.legacyLoopImport,
      mapRole: item.mapRole,
      cdsRole: item.cdsRole,
      claudeCliPath: item.claudeCliPath,
      claudeCliBundled: item.claudeCliBundled,
      workspacePreparation: item.workspacePreparation,
      readyzBlockers: item.readyzBlockers,
      readyzNextActions: item.readyzNextActions,
      error: item.error,
    }))
  ), [runtimeStatus?.instances]);
  const runtimeDiagnosticBundle = useMemo(() => ({
    generatedAt: new Date().toISOString(),
    session: activeSession ? {
      id: activeSession.id,
      traceId: activeSession.traceId,
      status: activeSession.status,
      runtime: activeSession.runtime,
      runtimeAdapter: activeSession.runtimeAdapter,
      currentRuntimeRunId: activeSession.currentRuntimeRunId,
      runtimeProfileId: activeSession.runtimeProfileId,
      workspaceRoot: activeSession.workspaceRoot,
      gitRepository: activeSession.gitRepository,
      gitRef: activeSession.gitRef,
    } : null,
    connection: activeConnection ? {
      id: activeConnection.id,
      partner: activeConnection.partner,
      partnerName: activeConnection.partnerName,
      status: activeConnection.status,
      lastProbeOk: activeConnection.lastProbeOk,
      longTokenExpiresAt: activeConnection.longTokenExpiresAt,
    } : null,
    runtimeProfile: activeSessionProfile ? {
      id: activeSessionProfile.id,
      name: activeSessionProfile.name,
      runtime: activeSessionProfile.runtime,
      model: activeSessionProfile.model,
      protocol: activeSessionProfile.protocol,
      hasApiKey: activeSessionProfile.hasApiKey,
      baseUrlConfigured: Boolean(activeSessionProfile.baseUrl),
    } : null,
    runtimeDiscovery: {
      refreshRequested: true,
      refreshed: runtimeDiscoveryRefreshed,
      loadedAt: runtimeStatusLoadedAt,
    },
    adapterCompatibility: activeAdapterCompatibility,
    r1RepairPlan,
    sidecarInstances: sidecarInstanceSummaries,
    runtimeStatus,
    summary: {
      adapter: runtimeDiagnostics.adapter,
      adapterMode: runtimeDiagnostics.adapterMode,
      loopOwner: runtimeDiagnostics.loopOwner,
      sdkLoopEnabled: runtimeDiagnostics.sdkLoopEnabled,
      legacyLoopImport: runtimeDiagnostics.legacyLoopImport,
      mapRole: runtimeDiagnostics.mapRole,
      cdsRole: runtimeDiagnostics.cdsRole,
      runId: runtimeDiagnostics.runId,
      instance: runtimeDiagnostics.instance,
      source: runtimeDiagnostics.source,
      cancelState: runtimeDiagnostics.cancelState,
      commercialState: runtimeDiagnostics.commercialState,
      commercialBlockingCode: runtimeDiagnostics.commercialBlockingCode,
      commercialNextAction: runtimeDiagnostics.commercialNextAction,
      commercialNextCommand: runtimeDiagnostics.commercialNextCommand,
      executionRunway: runtimeDiagnostics.executionRunway,
      executionStepIndex: runtimeDiagnostics.executionStepIndex,
      executionStepTotal: runtimeDiagnostics.executionStepTotal,
      executionPassedSteps: runtimeDiagnostics.executionPassedSteps,
      executionPendingSteps: runtimeDiagnostics.executionPendingSteps,
      executionCurrentStep: runtimeDiagnostics.executionCurrentStep,
      executionTimeline: runtimeDiagnostics.executionTimeline,
      executionRunbook: runtimeDiagnostics.executionRunbook,
      commercialPassed: runtimeDiagnostics.commercialPassed,
      commercialTotal: runtimeDiagnostics.commercialTotal,
      commercialReadinessGates: runtimeDiagnostics.commercialReadinessGates,
      commercialPending: runtimeDiagnostics.commercialPending,
      nextCyclePlan: runtimeDiagnostics.nextCyclePlan,
      debugCommands: runtimeDiagnostics.debugCommands,
      readinessGates: runtimeDiagnostics.readinessGates,
      rows: runtimeDiagnostics.rows,
      blockers: runtimeDiagnostics.blockers,
      nextActions: runtimeDiagnostics.nextActions,
      readyzBlockers: runtimeDiagnostics.readyzBlockers,
      readyzNextActions: runtimeDiagnostics.readyzNextActions,
      approvalEvidence: runtimeDiagnostics.approvalEvidence,
      cancelEvidence: runtimeDiagnostics.cancelEvidence,
      runtimeError: runtimeDiagnostics.runtimeError,
      workspaceError: runtimeDiagnostics.workspaceError,
      providerKeyError: runtimeDiagnostics.providerKeyError,
    },
  }), [activeAdapterCompatibility, activeConnection, activeSession, activeSessionProfile, r1RepairPlan, runtimeDiagnostics, runtimeDiscoveryRefreshed, runtimeStatus, runtimeStatusLoadedAt, sidecarInstanceSummaries]);
  const runBundle = useMemo(() => {
    const eventTypeCounts = events.reduce<Record<string, number>>((acc, event) => {
      acc[event.type] = (acc[event.type] ?? 0) + 1;
      return acc;
    }, {});
    const lastSeq = latestEventSeq(events);
    const payload = {
      schemaVersion: 'cds-agent-run-bundle/v1',
      generatedAt: new Date().toISOString(),
      page: {
        path: typeof window === 'undefined' ? '/cds-agent' : window.location.pathname,
        mode: viewMode,
      },
      summary: {
        sessionId: activeSession?.id ?? null,
        title: activeSession?.title ?? null,
        status: activeSession ? activeSessionEffectiveStatus : null,
        traceId: activeSession?.traceId ?? null,
        runtimeAdapter: runtimeDiagnostics.adapter,
        loopOwner: runtimeDiagnostics.loopOwner,
        sdkLoopEnabled: runtimeDiagnostics.sdkLoopEnabled,
        legacyLoopImport: runtimeDiagnostics.legacyLoopImport,
        runtimePool: runtimeStatus ? `${runtimeStatus.healthyCount}/${runtimeStatus.instanceCount}` : null,
        readinessPassed: runtimeDiagnostics.readinessGates.filter((gate) => gate.state === 'pass').length,
        readinessTotal: runtimeDiagnostics.readinessGates.length,
        eventCount: events.length,
        lastSeq,
        eventTypeCounts,
        artifactCount: artifacts.length,
        logLineCount: logs.split('\n').filter(Boolean).length,
      },
      runtimeDiagnosticBundle,
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        createdAt: message.createdAt,
        content: message.content,
      })),
      events: events.map((event) => ({
        id: event.id,
        seq: event.seq,
        type: event.type,
        createdAt: event.createdAt,
        payload: parsePayload(event),
      })),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        summary: artifact.summary,
        count: artifact.count,
        body: artifact.body,
      })),
      logs,
    };
    return redactForBundle(payload);
  }, [activeSession, activeSessionEffectiveStatus, artifacts, events, logs, messages, runtimeDiagnosticBundle, runtimeDiagnostics, runtimeStatus, viewMode]);
  const activeRuntimeProfile = activeSessionProfile ?? activeProfile;
  const runtimeReady = Boolean(activeRuntimeProfile && activeRuntimeProfile.hasApiKey && activeRuntimeProfile.baseUrl && activeRuntimeProfile.model);
  const activeRuntimeProfileWarning = profileCompatibilityBlockReason(activeRuntimeProfile, runtimeStatus?.desiredRuntimeAdapter)
    || runtimeStatus?.defaultRuntimeProfile?.warning
    || '';
  const prArtifact = artifacts.find((item) => /github\.com\/.+\/pull\/\d+/.test(item.body)) ?? null;
  const runwaySteps = [
    {
      label: 'MAP 会话',
      value: activeSession ? statusLabel(activeSessionEffectiveStatus) : '未创建',
      detail: activeSessionTimedOut ? `trace ${activeSession.traceId.slice(0, 12)} · 已到达 timeout` : activeSession ? `trace ${activeSession.traceId.slice(0, 12)}` : '先新建远程任务',
      icon: MessageSquare,
      state: activeSessionTimedOut ? 'warn' : activeSession ? 'pass' : 'pending',
    },
    {
      label: 'CDS Runtime',
      value: activeRuntimeProfileWarning ? '模型需调整' : runtimeReady ? runtimeDiagnostics.adapterMode : '待配置',
      detail: activeRuntimeProfileWarning || (activeRuntimeProfile ? `${runtimeDiagnostics.adapter} · ${profileSummary(activeRuntimeProfile)}` : '选择模型并保存 provider secret'),
      icon: Server,
      state: activeRuntimeProfileWarning ? 'warn' : runtimeReady ? 'pass' : 'pending',
    },
    {
      label: 'Worker Sandbox',
      value: activeSession ? formatSessionResourcePolicy(activeSession) : formatResourcePolicy(activeRuntimeProfile),
      detail: activeConnection?.partnerName || activeConnection?.partnerId || '等待 CDS 授权连接',
      icon: Cpu,
      state: activeSession && ['creating', 'running'].includes(activeSessionEffectiveStatus) ? 'pass' : 'pending',
    },
    {
      label: 'PR / 证据',
      value: gitContext.prUrl || prArtifact ? '已有 PR 证据' : `${metrics.artifactCount} 个产物`,
      detail: `${metrics.eventCount} 事件 / ${metrics.toolEvents} 工具事件`,
      icon: GitPullRequest,
      state: gitContext.prUrl || prArtifact || metrics.artifactCount > 0 ? 'pass' : 'pending',
    },
  ];

  const executionRunway = (
    <section className="rounded-xl px-4 py-3" style={{ background: '#111827', border: '1px solid rgba(148,163,184,0.18)' }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-white/78">
            <Route size={15} />
            执行链路
          </div>
          <div className="mt-1 text-xs leading-relaxed text-white/45">
            从任务、runtime、沙箱到 PR/证据包的完整状态，避免用户只看到一堆日志却不知道 Agent 现在卡在哪。
          </div>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-white/58" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <KeyRound size={12} /> {activeConnection?.status === 'active' ? '连接已授权' : '连接待确认'}
          </span>
          <span className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-white/58" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <Network size={12} /> {networkPolicyLabel(activeRuntimeProfile?.networkPolicy)}
          </span>
          <span className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-white/58" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.07)' }}>
            <ShieldCheck size={12} /> {activeSession?.toolPolicy ?? draft.toolPolicy}
          </span>
        </div>
      </div>
      <div className="relative mt-3">
        <div className="absolute left-8 right-8 top-[47px] hidden h-px bg-slate-700/80 xl:block" />
        <div className="relative grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          {runwaySteps.map((step, index) => {
            const Icon = step.icon;
            const isPass = step.state === 'pass';
            const isWarn = step.state === 'warn';
            return (
              <div
                key={step.label}
                className="relative min-h-[100px] min-w-0 overflow-hidden rounded-lg p-3"
                style={{
                  background: isPass ? 'rgba(34,197,94,0.08)' : isWarn ? 'rgba(245,158,11,0.1)' : 'rgba(15,23,42,0.92)',
                  border: isPass ? '1px solid rgba(34,197,94,0.28)' : isWarn ? '1px solid rgba(245,158,11,0.32)' : '1px solid rgba(148,163,184,0.14)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-white/48">{step.label}</span>
                  <span
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md"
                    style={{ background: isPass ? 'rgba(34,197,94,0.13)' : isWarn ? 'rgba(245,158,11,0.16)' : 'rgba(148,163,184,0.08)' }}
                  >
                    <Icon size={14} className={isPass ? 'text-emerald-300/85' : isWarn ? 'text-amber-200/85' : 'text-white/36'} />
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold" style={{ background: isPass ? 'rgba(34,197,94,0.2)' : isWarn ? 'rgba(245,158,11,0.2)' : 'rgba(148,163,184,0.12)', color: isPass ? 'rgba(134,239,172,0.95)' : isWarn ? 'rgba(253,230,138,0.95)' : 'rgba(148,163,184,0.9)' }}>
                    {index + 1}
                  </span>
                  <div className="min-w-0 truncate text-sm font-semibold text-white/82">{step.value}</div>
                </div>
                <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/42">{step.detail}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div
        className="mt-3 rounded-lg px-3 py-3"
        style={{
          background: runtimeDiagnostics.commercialState === 'commercial-ready'
            ? 'rgba(20,83,45,0.18)'
            : 'rgba(113,63,18,0.18)',
          border: runtimeDiagnostics.commercialState === 'commercial-ready'
            ? '1px solid rgba(34,197,94,0.24)'
            : '1px solid rgba(245,158,11,0.22)',
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-white/48">
              <ListChecks size={13} />
              当前执行面板
            </div>
            <div className="mt-1 text-sm font-semibold text-white/84">
              {runtimeDiagnostics.commercialState === 'commercial-ready'
                ? '商业级门禁已通过'
                : `${runtimeDiagnostics.commercialBlockingCode || 'Gate'} 阻塞`}
            </div>
            <div className="mt-1 max-w-5xl text-xs leading-relaxed text-white/58">
              {runtimeDiagnostics.commercialNextAction}
            </div>
            <div className="mt-2 max-w-5xl rounded-md px-2 py-1.5 text-xs leading-relaxed text-white/62" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.07)' }}>
              {runtimeDiagnostics.commercialDeploymentAdvice}
            </div>
            {(runtimeDiagnostics.executionNextStepEta || runtimeDiagnostics.executionTimeSinkAdvice) && (
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {runtimeDiagnostics.executionNextStepEta && (
                  <div className="rounded-md px-2 py-1.5 text-xs leading-relaxed text-white/62" style={{ background: 'rgba(14,165,233,0.08)', border: '1px solid rgba(56,189,248,0.16)' }}>
                    <span className="font-semibold text-sky-100/72">下一步耗时：</span>{runtimeDiagnostics.executionNextStepEta}
                  </div>
                )}
                {runtimeDiagnostics.executionTimeSinkAdvice && (
                  <div className="rounded-md px-2 py-1.5 text-xs leading-relaxed text-white/62" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.16)' }}>
                    <span className="font-semibold text-amber-100/72">耗时控制：</span>{runtimeDiagnostics.executionTimeSinkAdvice}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex w-full min-w-0 flex-col items-stretch gap-2 sm:w-auto sm:min-w-[190px]">
            {runtimeDiagnostics.executionStepTotal > 0 && (
              <div className="rounded-md px-2 py-1.5 text-right" style={{ background: 'rgba(15,23,42,0.5)', border: '1px solid rgba(148,163,184,0.14)' }}>
                <div className="text-[11px] font-semibold text-white/42">执行进度</div>
                <div className="mt-0.5 text-xs font-semibold text-white/78">
                  {runtimeDiagnostics.executionPassedSteps}/{runtimeDiagnostics.executionStepTotal} 已完成 · 当前 {runtimeDiagnostics.executionStepIndex}/{runtimeDiagnostics.executionStepTotal}
                </div>
                {runtimeDiagnostics.executionCurrentStep && (
                  <div className="mt-0.5 truncate text-[11px] text-white/50">
                    {runtimeDiagnostics.executionCurrentStep.code} · {runtimeDiagnostics.executionCurrentStep.title}
                  </div>
                )}
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-1">
              {runtimeDiagnostics.executionGateCounts
                ? (['pass', 'pending', 'failed', 'unknown'] as const).map((key) => {
                  const count = runtimeDiagnostics.executionGateCounts?.[key] ?? 0;
                  if (count <= 0) return null;
                  const tone = key === 'pass'
                    ? 'rgba(34,197,94,0.16)'
                    : key === 'failed'
                      ? 'rgba(239,68,68,0.16)'
                      : key === 'pending'
                        ? 'rgba(245,158,11,0.16)'
                        : 'rgba(148,163,184,0.12)';
                  const textTone = key === 'pass'
                    ? 'rgba(134,239,172,0.92)'
                    : key === 'failed'
                      ? 'rgba(254,202,202,0.92)'
                      : key === 'pending'
                        ? 'rgba(253,230,138,0.92)'
                        : 'rgba(203,213,225,0.78)';
                  return (
                    <span
                      key={key}
                      className="inline-flex min-h-6 items-center rounded px-1.5 text-[11px] font-semibold"
                      style={{ background: tone, color: textTone, border: '1px solid rgba(255,255,255,0.08)' }}
                    >
                      {key} {count}
                    </span>
                  );
                })
                : (
                  <span className="inline-flex min-h-6 items-center rounded px-1.5 text-[11px] font-semibold text-white/60" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    {runtimeDiagnostics.commercialPassed}/{runtimeDiagnostics.commercialTotal} gates
                  </span>
                )}
            </div>
            {runtimeDiagnostics.commercialBlockingCode === 'R1' && (
              <button
                type="button"
                onClick={() => void importDefaultProfile()}
                disabled={busy}
                title="当前还没有配置可用的运行模型，所以无法创建会话。点此用系统默认主模型一键生成一个运行配置，之后即可正常使用。"
                className="inline-flex min-h-8 items-center justify-center gap-2 rounded-md px-2 text-xs font-semibold disabled:opacity-45"
                style={{ background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.32)', color: 'rgba(253,230,138,0.95)' }}
              >
                <KeyRound size={12} /> 一键启用默认模型
              </button>
            )}
          </div>
        </div>
        {runtimeDiagnostics.commercialNextCommand && (
          <div className="mt-3 flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded px-2 py-1.5 text-[11px] leading-relaxed text-amber-50/78" style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.07)' }}>
              {runtimeDiagnostics.commercialNextCommand}
            </code>
            <button
              type="button"
              onClick={() => void copyText('当前下一步命令', runtimeDiagnostics.commercialNextCommand)}
              className="shrink-0 rounded p-1.5 text-white/46 hover:text-white/86"
              aria-label="复制当前下一步命令"
            >
              <Copy size={12} />
            </button>
          </div>
        )}
      </div>
    </section>
  );

  const hasContextDraft = Boolean(
    contextDraft.files.trim()
    || contextDraft.urls.trim()
    || contextDraft.notes.trim(),
  );

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(SIMPLE_VIEW_STORAGE_KEY, viewMode);
    } catch {
      /* sessionStorage 不可用时忽略，仅影响刷新后记忆 */
    }
  }, [viewMode]);

  useEffect(() => {
    eventsRef.current = events;
  }, [events]);

  // 简洁模式时间线：只在用户仍贴近底部时自动滚动；用户上滑查看历史后暂停。
  useEffect(() => {
    if (viewMode !== 'simple') return;
    if (autoScrollPaused) return;
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [viewMode, activeSessionId, messages.length, localMessages.length, events.length, autoScrollPaused]);

  // 运行中自动刷新会话元数据；事件优先走 SSE afterSeq 续读，异常时由 refreshDetail 兜底。
  const activeSessionForPoll = sessions.find((item) => item.id === activeSessionId) ?? null;
  const isLiveStatus = resolveSessionRuntimeState(activeSessionForPoll, nowTick).isLive;
  // 轻量时钟 + 节流的元数据轮询。事件不在这里拉（由下面的 SSE pump 独占），
  // 会话列表也不再每 3s 拉 100 个——12s 一次足够刷新左侧状态。跑完即停。
  useEffect(() => {
    if (!isLiveStatus || !activeSessionId) return;
    pollTickRef.current = 0;
    const tick = window.setInterval(() => {
      setNowTick(Date.now());
      if (runFinishedRef.current) return;
      pollTickRef.current += 1;
      const n = pollTickRef.current;
      if (n % 2 === 0) {
        // 6s：刷消息 / 日志（事件由 SSE pump 负责，这里 skipEvents 避免重复拉取）
        void refreshDetail(activeSessionId, { skipEvents: true });
      }
      if (n % 4 === 0) {
        // 12s：同步左侧列表状态，替代原来每 3s 拉 100 个会话的请求风暴
        void listInfraAgentSessions(100).then((res) => {
          if (res.success && res.data?.items) setSessions(sortSessions(res.data.items));
        });
      }
    }, 3000);
    return () => window.clearInterval(tick);
  }, [isLiveStatus, activeSessionId, refreshDetail]);

  useEffect(() => {
    if (!isLiveStatus || !activeSessionId) {
      setEventStreamHealthy(false);
      return;
    }

    const controller = new AbortController();
    let stopped = false;
    runFinishedRef.current = false; // 新一轮 run 开始

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      controller.signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
    });

    const mergeStreamEvent = (event: InfraAgentEventView) => {
      // 收到 done / error / 终态 status 立即标记结束，停掉 pump 与轮询，杜绝跑完后空转。
      if (isRunFinishedEvent(event)) runFinishedRef.current = true;
      setEvents((prev) => {
        const next = mergeEventsBySeq(prev, [event]);
        eventsRef.current = next;
        return next;
      });
    };

    const pump = async () => {
      setEventStreamHealthy(false);
      while (!controller.signal.aborted && !stopped && !runFinishedRef.current) {
        const afterSeq = latestEventSeq(eventsRef.current);
        let received = false;
        try {
          await streamInfraAgentEvents(
            activeSessionId,
            afterSeq,
            EVENT_PAGE_LIMIT,
            (event) => {
              received = true;
              mergeStreamEvent(event);
            },
            controller.signal,
            () => {
              if (!controller.signal.aborted && !stopped) setEventStreamHealthy(true);
            },
          );
          if (runFinishedRef.current) break;
          await sleep(received ? 250 : 1500);
        } catch {
          if (!controller.signal.aborted && !stopped) {
            setEventStreamHealthy(false);
            await sleep(3000);
          }
        }
      }
      // 跑完做一次最终同步 + 翻转左侧列表状态，让 isLiveStatus 落到终态后自然拆除两个 effect。
      if (runFinishedRef.current && !controller.signal.aborted && !stopped) {
        setEventStreamHealthy(false);
        await refreshDetail(activeSessionId).catch(() => {});
        await listInfraAgentSessions(100)
          .then((res) => { if (res.success && res.data?.items) setSessions(sortSessions(res.data.items)); })
          .catch(() => {});
      }
    };

    void pump();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [isLiveStatus, activeSessionId, refreshDetail]);

  useEffect(() => {
    if (!activeSession?.id) {
      setMessages([]);
      setLocalMessages((prev) => prev.filter((item) => !item.sessionId));
      setEvents([]);
      setLogs('');
      setEventReplayMode(false);
      setEventReplayIndex(1);
      return;
    }
    setEventReplayMode(false);
    setEventReplayIndex(1);
    setAutoScrollPaused(false);
    eventsRef.current = [];
    runFinishedRef.current = false;
    pollTickRef.current = 0;
    setEvents([]);
    void refreshDetail(activeSession.id, { resetEvents: true });
  }, [activeSession?.id, refreshDetail]);

  useEffect(() => {
    if (events.length === 0) {
      setEventReplayMode(false);
      setEventReplayIndex(1);
      return;
    }
    setEventReplayIndex((prev) => Math.max(1, Math.min(prev, events.length)));
  }, [events.length]);

  useEffect(() => {
    if (!activeProfile || profileDraft.apiKey.trim()) return;
    setProfileDraft((prev) => ({
      ...prev,
      name: activeProfile.name,
      runtime: activeProfile.runtime,
      protocol: activeProfile.protocol,
      baseUrl: activeProfile.baseUrl,
      model: activeProfile.model,
      resourceCpuCores: activeProfile.resourceCpuCores ?? 2,
      resourceMemoryMb: activeProfile.resourceMemoryMb ?? 4096,
      timeoutSeconds: activeProfile.timeoutSeconds ?? 900,
      networkPolicy: activeProfile.networkPolicy ?? 'restricted',
      autoCleanupMinutes: activeProfile.autoCleanupMinutes ?? 30,
      isDefault: activeProfile.isDefault,
    }));
  }, [activeProfile, profileDraft.apiKey]);

  useEffect(() => {
    if (!anthropicOfficialProfileTemplate || activeProfile || profileDraft.apiKey.trim() || profileDraft.baseUrl.trim() || profileDraft.model.trim()) {
      return;
    }
    setProfileDraft((prev) => ({
      ...prev,
      name: anthropicOfficialProfileTemplate.name,
      runtime: anthropicOfficialProfileTemplate.runtime,
      protocol: anthropicOfficialProfileTemplate.protocol,
      baseUrl: anthropicOfficialProfileTemplate.baseUrl,
      model: anthropicOfficialProfileTemplate.model,
      resourceCpuCores: anthropicOfficialProfileTemplate.resourceCpuCores,
      resourceMemoryMb: anthropicOfficialProfileTemplate.resourceMemoryMb,
      timeoutSeconds: anthropicOfficialProfileTemplate.timeoutSeconds,
      networkPolicy: anthropicOfficialProfileTemplate.networkPolicy,
      autoCleanupMinutes: anthropicOfficialProfileTemplate.autoCleanupMinutes,
      isDefault: anthropicOfficialProfileTemplate.isDefaultRecommended,
    }));
  }, [activeProfile, anthropicOfficialProfileTemplate, profileDraft.apiKey, profileDraft.baseUrl, profileDraft.model]);

  async function loadAll() {
    const requestedSessionId = readRequestedSessionId();
    const [connRes, profileRes, profileTemplateRes, adapterCompatibilityRes, adapterMatrixRes, slaDashboardRes, scheduleDashboardRes, governanceDashboardRes, sessionRes, runtimeRes] = await Promise.all([
      listInfraConnections(),
      listInfraAgentRuntimeProfiles(),
      listInfraAgentRuntimeProfileTemplates(),
      listInfraAgentRuntimeAdapterCompatibility(),
      getInfraAgentRuntimeAdapterMatrix(),
      getInfraAgentSlaDashboard(7),
      getInfraAgentScheduleDashboard(14),
      getInfraAgentGovernanceDashboard(),
      listInfraAgentSessions(100),
      getInfraAgentRuntimeStatus(true),
    ]);
    if (connRes.success) {
      const items = (connRes.data?.items ?? []).filter((item) => item.status !== 'revoked');
      setConnections(items);
      const preferred = items.find((item) => item.status === 'active') ?? items[0];
      if (preferred) setDraft((prev) => ({ ...prev, connectionId: prev.connectionId || preferred.id }));
    }
    if (profileRes.success) {
      const items = profileRes.data?.items ?? [];
      setProfiles(items);
      const preferred = items.find((item) => item.isDefault) ?? items[0];
      if (preferred) setDraft((prev) => ({ ...prev, runtimeProfileId: prev.runtimeProfileId || preferred.id }));
    }
    if (profileTemplateRes.success) {
      setProfileTemplates(profileTemplateRes.data?.items ?? []);
    }
    if (adapterCompatibilityRes.success) {
      setAdapterCompatibility((adapterCompatibilityRes.data?.items ?? []).map(normalizeAdapterCompatibilityItem));
    }
    if (adapterMatrixRes.success) {
      setAdapterMatrix(adapterMatrixRes.data?.matrix ?? null);
    }
    if (slaDashboardRes.success) {
      setSlaDashboard(slaDashboardRes.data?.dashboard ?? null);
    }
    if (scheduleDashboardRes.success) {
      setScheduleDashboard(scheduleDashboardRes.data?.dashboard ?? null);
    }
    if (governanceDashboardRes.success) {
      setGovernanceDashboard(governanceDashboardRes.data?.dashboard ?? null);
    }
    if (sessionRes.success) {
      const items = sortSessions(sessionRes.data?.items ?? []);
      setSessions(items);
      const requested = requestedSessionId
        ? items.find((item) => item.id === requestedSessionId)
        : null;
      setActiveSessionId((prev) => requested?.id ?? prev ?? items[0]?.id ?? null);
    }
    if (runtimeRes.success && runtimeRes.data?.diagnostics) {
      setRuntimeStatus(runtimeRes.data.diagnostics);
      setRuntimeDiscoveryRefreshed(Boolean(runtimeRes.data.discoveryRefreshed));
      setRuntimeStatusLoadedAt(new Date().toISOString());
    }
  }

  function upsertSession(session: InfraAgentSessionView) {
    setSessions((prev) => sortSessions([session, ...prev.filter((item) => item.id !== session.id)]));
    setActiveSessionId(session.id);
    setLocalMessages((prev) => prev.map((item) => (
      item.sessionId ? item : { ...item, sessionId: session.id }
    )));
  }

  function removeMissingSession(sessionId: string) {
    setSessions((prev) => sortSessions(prev.filter((item) => item.id !== sessionId)));
    setActiveSessionId((prev) => (prev === sessionId ? null : prev));
  }

  function isSessionNotFoundFailure(res: { success: boolean; error?: { code?: string; message?: string } | null }) {
    const code = res.error?.code ?? '';
    const message = res.error?.message ?? '';
    return !res.success
      && (code === 'SESSION_NOT_FOUND'
        || code === 'session_not_found'
        || code === 'connection_not_found'
        || (code === 'cds_request_failed' && message.includes('HTTP 400'))
        || message.includes('会话不存在')
        || message.includes('CDS 连接不存在')
        || message.includes('session_not_found'));
  }

  function isTransientStartFailure(res: { success: boolean; error?: { code?: string; message?: string } | null }) {
    const code = res.error?.code ?? '';
    const message = res.error?.message ?? '';
    return !res.success
      && (((code === 'SERVER_ERROR' || code === 'SERVER_UNAVAILABLE') && (message.includes('HTTP 502') || message.includes('/start')))
        || (code === 'cds_request_failed' && message.includes('HTTP 400')));
  }

  function pushLocalUserMessage(content: string, sessionId?: string | null): string {
    const id = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const item: LocalTimelineMessage = {
      id,
      role: 'user',
      content,
      status: 'sending',
      createdAt: new Date().toISOString(),
      sessionId: sessionId ?? activeSession?.id ?? null,
    };
    setLocalMessages((prev) => [...prev, item]);
    setAutoScrollPaused(false);
    return id;
  }

  function updateLocalMessageStatus(id: string | null, status: string) {
    if (!id) return;
    setLocalMessages((prev) => prev.map((item) => (
      item.id === id ? { ...item, status } : item
    )));
  }

  function clearLocalUserMessages(content: string, sessionId?: string | null) {
    const normalized = content.trim();
    setLocalMessages((prev) => prev.filter((item) => {
      if (item.role !== 'user') return true;
      if (sessionId && item.sessionId && item.sessionId !== sessionId) return true;
      return item.content.trim() !== normalized;
    }));
  }

  function setSimplePhase(
    phase: SimpleRunPhase,
    label: string,
    detail?: string,
    session?: InfraAgentSessionView | null,
    error?: { code?: string | null; message?: string | null; traceId?: string | null; requestId?: string | null; source?: string | null; elapsedMs?: number | null } | null,
  ) {
    const now = Date.now();
    setSimpleRunState((prev) => ({
      phase,
      label,
      detail,
      startedAt: prev && prev.phase !== 'completed' && prev.phase !== 'failed' ? prev.startedAt : now,
      updatedAt: now,
      sessionId: session?.id ?? prev?.sessionId ?? null,
      traceId: error?.traceId ?? session?.traceId ?? prev?.traceId ?? null,
      requestId: error?.requestId ?? prev?.requestId ?? null,
      source: error?.source ?? prev?.source ?? null,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      elapsedMs: error?.elapsedMs ?? null,
    }));
    setSimpleSubmitStatus(label);
  }

  function clearSimplePhaseAfterSuccess() {
    window.setTimeout(() => {
      setSimpleRunState((prev) => (prev?.phase === 'completed' ? null : prev));
      setSimpleSubmitStatus('');
    }, 3500);
  }

  function buildSimpleRunDiagnostic(state: SimpleRunState) {
    return JSON.stringify({
      phase: state.phase,
      label: state.label,
      detail: state.detail,
      sessionId: state.sessionId,
      traceId: state.traceId,
      requestId: state.requestId,
      source: state.source,
      errorCode: state.errorCode,
      errorMessage: state.errorMessage,
      elapsedMs: state.elapsedMs,
      clientElapsedMs: Date.now() - state.startedAt,
      updatedAt: new Date(state.updatedAt).toISOString(),
    }, null, 2);
  }

  async function createSession() {
    if (!activeConnection && !liteReviewAvailable) {
      toast.warning('没有可用 CDS 连接', '请先到设置里的基础设施服务完成系统级授权');
      return;
    }
    if (activeProfileBlockReason) {
      toast.warning('模型配置不可用', activeProfileBlockReason);
      return;
    }
    if (activeRuntimePoolBlockReason) {
      toast.warning('CDS runtime pool 不可用', activeRuntimePoolBlockReason);
      return;
    }
    setBusy(true);
    try {
      const res = await createInfraAgentSession({
        connectionId: activeConnection!.id,
        runtime: activeProfile?.runtime ?? 'claude-sdk',
        model: activeProfile?.model,
        runtimeProfileId: activeProfile?.id,
        title: draft.title.trim() || prompt.trim().slice(0, 28) || '新会话',
        toolPolicy: draft.toolPolicy,
        gitRepository: draft.gitRepository.trim() || undefined,
        gitRef: draft.gitRef.trim() || undefined,
        workspaceRoot: draft.workspaceRoot.trim() || undefined,
      });
      if (!res.success || !res.data?.item) {
        toast.error('新建会话失败', res.error?.message ?? '请检查 CDS 连接和模型配置');
        return;
      }
      upsertSession(res.data.item);
      toast.success('远程会话已创建');
    } catch (err) {
      toast.error('新建会话失败', err instanceof Error ? err.message : '请检查 CDS 连接和模型配置');
    } finally {
      setBusy(false);
    }
  }

  async function startSession() {
    if (!activeSession) return;
    if (activeSessionProfileBlockReason) {
      toast.warning('模型配置不可用', activeSessionProfileBlockReason);
      return;
    }
    if (activeRuntimePoolBlockReason) {
      toast.warning('CDS runtime pool 不可用', activeRuntimePoolBlockReason);
      return;
    }
    const sessionId = activeSession.id;
    setBusy(true);
    try {
      const res = await startInfraAgentSession(sessionId);
      if (!res.success || !res.data?.item) {
        if (isSessionNotFoundFailure(res)) {
          removeMissingSession(sessionId);
          toast.warning('旧会话已失效', '已从列表移除，请直接输入任务重新运行');
          return;
        }
        toast.error('启动失败', res.error?.message ?? '请检查 CDS runtime');
        await refreshDetail(sessionId);
        return;
      }
      upsertSession(res.data.item);
      await refreshDetail(res.data.item.id);
    } catch (err) {
      toast.error('启动失败', err instanceof Error ? err.message : '请检查 CDS runtime');
      await refreshDetail(sessionId);
    } finally {
      setBusy(false);
    }
  }

  async function sendPrompt() {
    if (!activeSession || !prompt.trim()) return;
    if (activeSession.manualTakeoverEnabled) {
      const sessionId = activeSession.id;
      setBusy(true);
      try {
        const res = await addInfraAgentManualInput(sessionId, prompt);
        if (!res.success || !res.data?.item) {
          toast.error('人工输入记录失败', res.error?.message ?? '请稍后重试');
          await refreshDetail(sessionId);
          return;
        }
        upsertSession(res.data.item);
        await refreshDetail(res.data.item.id);
        toast.success('人工输入已记录', 'Agent 仍保持暂停，审批按钮可继续使用');
      } catch (err) {
        toast.error('人工输入记录失败', err instanceof Error ? err.message : '请稍后重试');
        await refreshDetail(sessionId);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (activeSessionProfileBlockReason) {
      toast.warning('模型配置不可用', activeSessionProfileBlockReason);
      return;
    }
    if (activeRuntimePoolBlockReason) {
      toast.warning('CDS runtime pool 不可用', activeRuntimePoolBlockReason);
      return;
    }
    const sessionId = activeSession.id;
    setBusy(true);
    try {
      const res = await sendInfraAgentMessage(sessionId, buildPromptWithContext(prompt, contextDraft));
      if (!res.success || !res.data?.item) {
        toast.error('发送失败', res.error?.message ?? '请稍后重试');
        await refreshDetail(sessionId);
        return;
      }
      setPrompt('');
      upsertSession(res.data.item);
      await refreshDetail(res.data.item.id);
    } catch (err) {
      toast.error('发送失败', err instanceof Error ? err.message : '请稍后重试');
      await refreshDetail(sessionId);
    } finally {
      setBusy(false);
    }
  }

  async function runSimpleReadonlyReview() {
    if (!prompt.trim()) return;
    if (activeSession?.manualTakeoverEnabled) {
      await sendPrompt();
      return;
    }

    let session = activeSessionTimedOut ? null : activeSession;
    if (!session && !activeConnection && !liteReviewAvailable) {
      toast.warning('没有可用 CDS 连接', '请先到设置里的基础设施服务完成系统级授权');
      return;
    }
    if (!session && activeProfileBlockReason) {
      toast.warning('模型配置不可用', activeProfileBlockReason);
      return;
    }
    if (session && activeSessionProfileBlockReason) {
      toast.warning('模型配置不可用', activeSessionProfileBlockReason);
      return;
    }
    if (activeRuntimePoolBlockReason) {
      toast.warning('CDS runtime pool 不可用', activeRuntimePoolBlockReason);
      return;
    }

    const normalizedPrompt = prompt.trim();
    let optimisticMessageId: string | null = null;
    setBusy(true);
    try {
      optimisticMessageId = pushLocalUserMessage(normalizedPrompt, session?.id ?? null);
      setPrompt('');
      setSimplePhase('submitting', '请求已提交', '1 秒内已进入 CDS Agent 提交流程', session);
      setSimpleSubmitStatus(session ? '正在发送给 Agent…' : '正在创建 CDS Agent 会话…');
      const simplePrompt = simpleTaskMode === 'code'
        ? `【Code 巡检模式】请优先围绕代码仓库、文件、测试、构建和提交建议处理：\n${normalizedPrompt}`
        : `【对话模式】请直接回答用户问题；只有用户明确要求检查代码时才进入代码巡检：\n${normalizedPrompt}`;

      const createSimpleSession = async () => {
        const title = normalizedPrompt.slice(0, 28) || (simpleTaskMode === 'code' ? '只读代码巡检' : 'Agent 对话');
        setSimplePhase('creating', '正在创建会话', '绑定 connection、runtime profile 与工作区信息', session);
        const createRes = await createInfraAgentSession({
          connectionId: activeConnection!.id,
          runtime: activeProfile?.runtime ?? 'claude-sdk',
          model: activeProfile?.model,
          runtimeProfileId: activeProfile?.id,
          title,
          toolPolicy: draft.toolPolicy,
          gitRepository: simpleTaskMode === 'code' ? draft.gitRepository.trim() || undefined : undefined,
          gitRef: simpleTaskMode === 'code' ? draft.gitRef.trim() || undefined : undefined,
          workspaceRoot: draft.workspaceRoot.trim() || undefined,
        });
        if (!createRes.success || !createRes.data?.item) {
          setSimplePhase('failed', '创建会话失败', createRes.error?.message ?? '请检查 CDS 连接和模型配置', session, createRes.error);
          toast.error('新建会话失败', createRes.error?.message ?? '请检查 CDS 连接和模型配置');
          updateLocalMessageStatus(optimisticMessageId, 'failed');
          return null;
        }
        upsertSession(createRes.data.item);
        setSimplePhase('creating', '会话已创建', '准备启动远程 runtime', createRes.data.item);
        return createRes.data.item;
      };

      if (!session) {
        session = await createSimpleSession();
        if (!session) return;
      }

      if (canStartFromStatus(session.status)) {
        setSimplePhase('starting', '正在启动远程 runtime', 'CDS 正在准备容器、workspace 和 runtime transport', session);
        setSimpleSubmitStatus('正在启动远程 runtime…');
        const startRes = await startInfraAgentSession(session.id);
        if (!startRes.success || !startRes.data?.item) {
          if (isSessionNotFoundFailure(startRes)) {
            removeMissingSession(session.id);
            session = await createSimpleSession();
            if (!session) return;
            const retryStartRes = await startInfraAgentSession(session.id);
            if (!retryStartRes.success || !retryStartRes.data?.item) {
              setSimplePhase('failed', '启动失败', retryStartRes.error?.message ?? '请检查 CDS runtime', session, retryStartRes.error);
              toast.error('启动失败', retryStartRes.error?.message ?? '请检查 CDS runtime');
              updateLocalMessageStatus(optimisticMessageId, 'failed');
              await refreshDetail(session.id);
              return;
            }
            session = retryStartRes.data.item;
            upsertSession(session);
          } else if (isTransientStartFailure(startRes)) {
            await new Promise((resolve) => window.setTimeout(resolve, 2500));
            const retryStartRes = await startInfraAgentSession(session.id);
            if (!retryStartRes.success || !retryStartRes.data?.item) {
              setSimplePhase('failed', '启动失败', retryStartRes.error?.message ?? 'CDS runtime 暂不可用，请稍后重试', session, retryStartRes.error);
              toast.error('启动失败', retryStartRes.error?.message ?? 'CDS runtime 暂不可用，请稍后重试');
              updateLocalMessageStatus(optimisticMessageId, 'failed');
              await refreshDetail(session.id);
              return;
            }
            session = retryStartRes.data.item;
            upsertSession(session);
          } else {
          setSimplePhase('failed', '启动失败', startRes.error?.message ?? '请检查 CDS runtime', session, startRes.error);
          toast.error('启动失败', startRes.error?.message ?? '请检查 CDS runtime');
          updateLocalMessageStatus(optimisticMessageId, 'failed');
          await refreshDetail(session.id);
          return;
          }
        } else {
          session = startRes.data.item;
          upsertSession(session);
          setSimplePhase('starting', 'runtime 已启动', '准备发送任务 prompt', session);
        }
      }

      setSimplePhase('running', '正在发送任务', '等待 CDS runtime 接受 prompt 并产生首个事件', session);
      setSimpleSubmitStatus('请求已提交，等待 Agent 首个事件…');
      const messageRes = await sendInfraAgentMessage(session.id, buildPromptWithContext(simplePrompt, contextDraft));
      if (!messageRes.success || !messageRes.data?.item) {
        if (isSessionNotFoundFailure(messageRes)) {
          removeMissingSession(session.id);
          session = await createSimpleSession();
          if (!session) return;
          const retryStartRes = canStartFromStatus(session.status)
            ? await startInfraAgentSession(session.id)
            : null;
          if (retryStartRes && (!retryStartRes.success || !retryStartRes.data?.item)) {
            setSimplePhase('failed', '启动失败', retryStartRes.error?.message ?? '请检查 CDS runtime', session, retryStartRes.error);
            toast.error('启动失败', retryStartRes.error?.message ?? '请检查 CDS runtime');
            updateLocalMessageStatus(optimisticMessageId, 'failed');
            await refreshDetail(session.id);
            return;
          }
          if (retryStartRes?.success && retryStartRes.data?.item) {
            session = retryStartRes.data.item;
            upsertSession(session);
          }
          setSimplePhase('running', '正在重发任务', '旧 session 已自愈，正在向新 runtime 发送 prompt', session);
          const retryMessageRes = await sendInfraAgentMessage(session.id, buildPromptWithContext(simplePrompt, contextDraft));
          if (!retryMessageRes.success || !retryMessageRes.data?.item) {
            setSimplePhase('failed', '发送失败', retryMessageRes.error?.message ?? '请稍后重试', session, retryMessageRes.error);
            toast.error('发送失败', retryMessageRes.error?.message ?? '请稍后重试');
            updateLocalMessageStatus(optimisticMessageId, 'failed');
            await refreshDetail(session.id);
            return;
          }
          clearLocalUserMessages(normalizedPrompt, retryMessageRes.data.item.id);
          upsertSession(retryMessageRes.data.item);
          await refreshDetail(retryMessageRes.data.item.id);
          setSimplePhase('completed', '请求已进入运行队列', 'Agent 已接收任务，后续结果会在当前会话流式出现', retryMessageRes.data.item);
          clearSimplePhaseAfterSuccess();
          return;
        }
        setSimplePhase('failed', '发送失败', messageRes.error?.message ?? '请稍后重试', session, messageRes.error);
        toast.error('发送失败', messageRes.error?.message ?? '请稍后重试');
        updateLocalMessageStatus(optimisticMessageId, 'failed');
        await refreshDetail(session.id);
        return;
      }
      clearLocalUserMessages(normalizedPrompt, messageRes.data.item.id);
      upsertSession(messageRes.data.item);
      await refreshDetail(messageRes.data.item.id);
      setSimplePhase('completed', '请求已进入运行队列', 'Agent 已接收任务，后续结果会在当前会话流式出现', messageRes.data.item);
      clearSimplePhaseAfterSuccess();
    } catch (err) {
      setSimplePhase('failed', '启动巡检失败', err instanceof Error ? err.message : '请稍后重试', session);
      toast.error('启动巡检失败', err instanceof Error ? err.message : '请稍后重试');
      updateLocalMessageStatus(optimisticMessageId, 'failed');
      if (session?.id) await refreshDetail(session.id);
    } finally {
      setBusy(false);
    }
  }

  async function stopSession() {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    setSimplePhase('stopping', '正在停止任务', '正在通知 CDS/runtime 取消当前运行', activeSession);
    setBusy(true);
    try {
      const res = await stopInfraAgentSession(sessionId);
      if (!res.success || !res.data?.item) {
        setSimplePhase('failed', '停止失败', res.error?.message ?? '请稍后重试', activeSession, res.error);
        toast.error('停止失败', res.error?.message ?? '请稍后重试');
        await refreshDetail(sessionId);
        return;
      }
      upsertSession(res.data.item);
      await refreshDetail(res.data.item.id);
      setSimplePhase('completed', '任务已停止', '运行已进入 stopped/stopping，结果和事件仍可复盘', res.data.item);
      clearSimplePhaseAfterSuccess();
    } catch (err) {
      setSimplePhase('failed', '停止失败', err instanceof Error ? err.message : '请稍后重试', activeSession);
      toast.error('停止失败', err instanceof Error ? err.message : '请稍后重试');
      await refreshDetail(sessionId);
    } finally {
      setBusy(false);
    }
  }

  async function archiveSession() {
    if (!activeSession) return;
    if (activeSession.status === 'running' || activeSession.status === 'creating' || activeSession.status === 'stopping') {
      toast.warning('先停止会话', '运行中的远程会话需要先停止，再归档');
      return;
    }
    const sessionId = activeSession.id;
    setBusy(true);
    try {
      const res = await archiveInfraAgentSession(sessionId);
      if (!res.success || !res.data?.item) {
        toast.error('归档失败', res.error?.message ?? '请稍后重试');
        return;
      }
      setSessions((prev) => sortSessions(prev.filter((item) => item.id !== sessionId)));
      setActiveSessionId((prev) => (prev === sessionId ? null : prev));
      setMessages([]);
      setEvents([]);
      setLogs('');
      toast.success('会话已归档');
    } catch (err) {
      toast.error('归档失败', err instanceof Error ? err.message : '请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  async function collectArtifacts() {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    setBusy(true);
    try {
      const res = await collectInfraAgentArtifacts(sessionId);
      if (!res.success || !res.data?.item) {
        toast.error('产物采集失败', res.error?.message ?? '请稍后重试');
        await refreshDetail(sessionId);
        return;
      }
      upsertSession(res.data.item);
      await refreshDetail(res.data.item.id);
      toast.success('只读产物已生成');
    } catch (err) {
      toast.error('产物采集失败', err instanceof Error ? err.message : '请稍后重试');
      await refreshDetail(sessionId);
    } finally {
      setBusy(false);
    }
  }

  async function runReadonlyChecks() {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    setBusy(true);
    try {
      const res = await runInfraAgentReadonlyChecks(sessionId);
      if (!res.success || !res.data?.item) {
        toast.error('只读检查失败', res.error?.message ?? '请稍后重试');
        await refreshDetail(sessionId);
        return;
      }
      upsertSession(res.data.item);
      await refreshDetail(res.data.item.id);
      toast.success('只读检查已完成');
    } catch (err) {
      toast.error('只读检查失败', err instanceof Error ? err.message : '请稍后重试');
      await refreshDetail(sessionId);
    } finally {
      setBusy(false);
    }
  }

  async function captureBrowserSnapshot() {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    const branchId = browserBranchId.trim() || 'prd-agent-main';
    setBusy(true);
    try {
      const res = await captureInfraAgentBrowserSnapshot(sessionId, {
        branchId,
        description: `从 MAP 工作台读取 ${branchId} 的远程页面快照`,
      });
      if (!res.success || !res.data?.item) {
        toast.error('远程页面快照失败', res.error?.message ?? '请确认预览页 Bridge 已连接');
        await refreshDetail(sessionId);
        return;
      }
      upsertSession(res.data.item);
      await refreshDetail(res.data.item.id);
      toast.success('远程页面快照已生成');
    } catch (err) {
      toast.error('远程页面快照失败', err instanceof Error ? err.message : '请确认预览页 Bridge 已连接');
      await refreshDetail(sessionId);
    } finally {
      setBusy(false);
    }
  }

  function buildBrowserActionParams(): Record<string, unknown> {
    if (browserAction === 'click') {
      return { index: Number(browserTargetIndex) || 0 };
    }
    if (browserAction === 'type') {
      return { index: Number(browserTargetIndex) || 0, text: browserActionText, clear: true };
    }
    if (browserAction === 'scroll') {
      return { direction: browserActionText.trim() === 'up' ? 'up' : 'down', pixels: 420 };
    }
    if (browserAction === 'navigate' || browserAction === 'spa-navigate') {
      return { url: browserActionText.trim() || '/cds-agent' };
    }
    if (browserAction === 'evaluate') {
      return { script: browserActionText.trim() || 'document.title' };
    }
    return {};
  }

  async function runBrowserAction() {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    const branchId = browserBranchId.trim() || 'prd-agent-main';
    setBusy(true);
    try {
      const res = await runInfraAgentBrowserAction(sessionId, {
        branchId,
        action: browserAction,
        params: buildBrowserActionParams(),
        description: `从 MAP 工作台执行 ${browserAction}`,
      });
      if (!res.success || !res.data?.item) {
        toast.error('远程页面动作失败', res.error?.message ?? '请先读取快照确认元素索引');
        await refreshDetail(sessionId);
        return;
      }
      upsertSession(res.data.item);
      await refreshDetail(res.data.item.id);
      toast.success('远程页面动作已执行');
    } catch (err) {
      toast.error('远程页面动作失败', err instanceof Error ? err.message : '请先读取快照确认元素索引');
      await refreshDetail(sessionId);
    } finally {
      setBusy(false);
    }
  }

  async function toggleManualTakeover(enabled: boolean) {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    setBusy(true);
    try {
      const res = await setInfraAgentManualTakeover(sessionId, enabled, enabled ? manualReason : undefined);
      if (!res.success || !res.data?.item) {
        toast.error(enabled ? '接管失败' : '恢复失败', res.error?.message ?? '请稍后重试');
        await refreshDetail(sessionId);
        return;
      }
      upsertSession(res.data.item);
      await refreshDetail(res.data.item.id);
      toast.success(enabled ? '已进入人工接管' : 'Agent 已恢复', enabled ? '发送框会记录人工输入，工具审批仍可继续操作' : '可以继续向远程 Agent 发送任务');
    } catch (err) {
      toast.error(enabled ? '接管失败' : '恢复失败', err instanceof Error ? err.message : '请稍后重试');
      await refreshDetail(sessionId);
    } finally {
      setBusy(false);
    }
  }

  async function testProfile() {
    if (!activeProfile) {
      toast.warning('没有可测试的模型配置');
      return;
    }
    setTestingProfile(true);
    setProfileTest('');
    try {
      const res = await testInfraAgentRuntimeProfile(activeProfile.id);
      if (!res.success || !res.data?.result) {
        const message = res.error?.message ?? '模型配置测试失败';
        setProfileTest(message);
        toast.error('模型测试失败', message);
        return;
      }
      const result = res.data.result;
      const message = `${result.success ? '可用' : '失败'} · ${result.protocol} · HTTP ${result.httpStatus ?? 'n/a'} · ${result.elapsedMs}ms · ${result.message}`;
      setProfileTest(message);
      if (result.success) {
        toast.success('模型配置可用', `${result.protocol} · ${result.model} @ ${result.baseUrl}`);
      } else {
        toast.error('模型测试失败', result.message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '模型配置测试失败';
      setProfileTest(message);
      toast.error('模型测试失败', message);
    } finally {
      setTestingProfile(false);
    }
  }

  function matchingRuntimeProfileTemplate() {
    return profileTemplates.find((template) => (
      profileDraft.runtime === template.runtime
      && profileDraft.protocol === template.protocol
      && profileDraft.baseUrl.trim() === template.baseUrl
      && profileDraft.model.trim() === template.model
      && Number(profileDraft.resourceCpuCores) === template.resourceCpuCores
      && Number(profileDraft.resourceMemoryMb) === template.resourceMemoryMb
      && Number(profileDraft.timeoutSeconds) === template.timeoutSeconds
      && profileDraft.networkPolicy === template.networkPolicy
      && Number(profileDraft.autoCleanupMinutes) === template.autoCleanupMinutes
    )) ?? null;
  }

  function validateProfileDraftBeforeSave(action: 'save' | 'update') {
    const canRetainExistingSecret = action === 'update' && Boolean(activeProfile?.hasApiKey) && !profileDraft.apiKey.trim();
    if (!profileDraft.baseUrl.trim() || !profileDraft.model.trim() || (!profileDraft.apiKey.trim() && !canRetainExistingSecret)) {
      return action === 'update'
        ? '更新当前配置需要 baseUrl、model；provider secret 可留空以复用已加密保存的值'
        : 'baseUrl、model 和 provider secret 都必填';
    }

    const template = matchingRuntimeProfileTemplate();
    if (template?.id === ANTHROPIC_OFFICIAL_PROFILE_TEMPLATE_ID && !canRetainExistingSecret && !profileDraft.apiKey.trim().startsWith('sk-ant-')) {
      return 'Anthropic 官方模板只接受 sk-ant- 开头的 provider secret；cc-switch/DeepSeek 自定义 key 请使用自定义 profile，不要套用原生 Anthropic 官方模板。';
    }

    return '';
  }

  async function saveProfile() {
    const profileDraftError = validateProfileDraftBeforeSave('save');
    if (profileDraftError) {
      setProfileTest(profileDraftError);
      toast.warning(profileDraftError.includes('sk-ant-') ? 'provider secret 不匹配' : '模型配置不完整', profileDraftError);
      return;
    }
    setBusy(true);
    let candidateId = '';
    let promoted = false;
    try {
      const template = matchingRuntimeProfileTemplate();
      const shouldPromoteAfterTest = profileDraft.isDefault;
      if (shouldPromoteAfterTest && template) {
        const promotionRes = await createDefaultInfraAgentRuntimeProfileFromTemplateAfterTest(template.id, {
          name: profileDraft.name,
          apiKey: profileDraft.apiKey,
          isDefault: true,
        });
        if (!promotionRes.success || !promotionRes.data?.item) {
          toast.error('默认配置测试失败', promotionRes.error?.message ?? '已取消设为默认');
          return;
        }
        const testResult = promotionRes.data.test;
        setProfileTest(`${testResult.success ? '可用' : '失败'} · ${testResult.protocol} · HTTP ${testResult.httpStatus ?? 'n/a'} · ${testResult.elapsedMs}ms · ${testResult.message}`);
        const savedProfile = promotionRes.data.item;
        setProfiles((prev) => [savedProfile, ...prev.filter((item) => item.id !== savedProfile.id)]);
        setDraft((prev) => ({ ...prev, runtimeProfileId: savedProfile.id }));
        setProfileDraft((prev) => ({ ...prev, apiKey: '' }));
        promoted = true;
        toast.success('模型配置已保存', '已通过模型测试并设为默认配置');
        return;
      }

      const createInput = { ...profileDraft, isDefault: shouldPromoteAfterTest ? false : profileDraft.isDefault };
      const res = template
        ? await createInfraAgentRuntimeProfileFromTemplate(template.id, {
            name: profileDraft.name,
            apiKey: profileDraft.apiKey,
            isDefault: createInput.isDefault,
          })
        : await createInfraAgentRuntimeProfile(createInput);
      if (!res.success || !res.data?.item) {
        toast.error('保存模型配置失败', res.error?.message ?? '请检查 baseUrl、model 和 provider secret');
        return;
      }

      let savedProfile = res.data.item;
      candidateId = savedProfile.id;
      if (shouldPromoteAfterTest) {
        const testRes = await testInfraAgentRuntimeProfile(savedProfile.id);
        if (!testRes.success || !testRes.data?.result) {
          toast.error('默认配置测试失败', testRes.error?.message ?? '已取消设为默认，并清理候选配置');
          return;
        }
        const testResult = testRes.data.result;
        const testMessage = `${testResult.success ? '可用' : '失败'} · ${testResult.protocol} · HTTP ${testResult.httpStatus ?? 'n/a'} · ${testResult.elapsedMs}ms · ${testResult.message}`;
        setProfileTest(testMessage);
        if (!testResult.success) {
          toast.error('默认配置测试失败', `${testResult.message}；已清理候选配置`);
          return;
        }

        const promoteRes = await updateInfraAgentRuntimeProfile(savedProfile.id, {
          name: savedProfile.name,
          runtime: savedProfile.runtime,
          protocol: savedProfile.protocol,
          baseUrl: savedProfile.baseUrl,
          model: savedProfile.model,
          apiKey: profileDraft.apiKey,
          resourceCpuCores: savedProfile.resourceCpuCores,
          resourceMemoryMb: savedProfile.resourceMemoryMb,
          timeoutSeconds: savedProfile.timeoutSeconds,
          networkPolicy: savedProfile.networkPolicy,
          autoCleanupMinutes: savedProfile.autoCleanupMinutes,
          isDefault: true,
        });
        if (!promoteRes.success || !promoteRes.data?.item) {
          toast.error('设为默认失败', promoteRes.error?.message ?? '候选配置已通过测试，但默认提升失败');
          return;
        }
        savedProfile = promoteRes.data.item;
        promoted = true;
      }

      setProfiles((prev) => [savedProfile, ...prev.filter((item) => item.id !== savedProfile.id)]);
      setDraft((prev) => ({ ...prev, runtimeProfileId: savedProfile.id }));
      setProfileDraft((prev) => ({ ...prev, apiKey: '' }));
      if (!shouldPromoteAfterTest) setProfileTest('');
      toast.success(
        '模型配置已保存',
        shouldPromoteAfterTest
          ? '已通过模型测试并设为默认配置'
          : (template ? '已按后端官方模板创建，可以立即点击测试模型' : '可以立即点击测试模型'),
      );
    } catch (err) {
      toast.error('保存模型配置失败', err instanceof Error ? err.message : '请检查 baseUrl、model 和 provider secret');
    } finally {
      if (candidateId && profileDraft.isDefault && !promoted) {
        await deleteInfraAgentRuntimeProfile(candidateId).catch(() => undefined);
      }
      setBusy(false);
    }
  }

  async function updateProfile() {
    if (!activeProfile) {
      toast.warning('没有可更新的模型配置');
      return;
    }
    const profileDraftError = validateProfileDraftBeforeSave('update');
    if (profileDraftError) {
      setProfileTest(profileDraftError);
      toast.warning(profileDraftError.includes('sk-ant-') ? 'provider secret 不匹配' : '模型配置不完整', profileDraftError);
      return;
    }
    setBusy(true);
    let candidateId = '';
    let promoted = false;
    const retainsExistingSecret = activeProfile.hasApiKey && !profileDraft.apiKey.trim();
    try {
      if (profileDraft.isDefault && !retainsExistingSecret) {
        const template = matchingRuntimeProfileTemplate();
        if (template) {
          const promotionRes = await createDefaultInfraAgentRuntimeProfileFromTemplateAfterTest(template.id, {
            name: profileDraft.name,
            apiKey: profileDraft.apiKey,
            isDefault: true,
          });
          if (!promotionRes.success || !promotionRes.data?.item) {
            toast.error('默认配置测试失败', promotionRes.error?.message ?? '当前默认配置保持不变');
            return;
          }
          const testResult = promotionRes.data.test;
          setProfileTest(`${testResult.success ? '可用' : '失败'} · ${testResult.protocol} · HTTP ${testResult.httpStatus ?? 'n/a'} · ${testResult.elapsedMs}ms · ${testResult.message}`);
          const savedProfile = promotionRes.data.item;
          promoted = true;
          if (activeProfile.id !== savedProfile.id) {
            await deleteInfraAgentRuntimeProfile(activeProfile.id).catch(() => undefined);
          }
          setProfiles((prev) => [savedProfile, ...prev.filter((item) => item.id !== savedProfile.id && item.id !== activeProfile.id)]);
          setDraft((prev) => ({ ...prev, runtimeProfileId: savedProfile.id }));
          setProfileDraft((prev) => ({ ...prev, apiKey: '' }));
          toast.success('模型配置已更新', '已通过模型测试并设为默认配置');
          return;
        }
        const candidateRes = await createInfraAgentRuntimeProfile({ ...profileDraft, isDefault: false });
        if (!candidateRes.success || !candidateRes.data?.item) {
          toast.error('更新模型配置失败', candidateRes.error?.message ?? '请检查 baseUrl、model 和 provider secret');
          return;
        }

        let savedProfile = candidateRes.data.item;
        candidateId = savedProfile.id;
        const testRes = await testInfraAgentRuntimeProfile(savedProfile.id);
        if (!testRes.success || !testRes.data?.result) {
          toast.error('默认配置测试失败', testRes.error?.message ?? '已取消更新，并清理候选配置');
          return;
        }
        const testResult = testRes.data.result;
        const testMessage = `${testResult.success ? '可用' : '失败'} · ${testResult.protocol} · HTTP ${testResult.httpStatus ?? 'n/a'} · ${testResult.elapsedMs}ms · ${testResult.message}`;
        setProfileTest(testMessage);
        if (!testResult.success) {
          toast.error('默认配置测试失败', `${testResult.message}；已清理候选配置，当前默认配置保持不变`);
          return;
        }

        const promoteRes = await updateInfraAgentRuntimeProfile(savedProfile.id, {
          name: savedProfile.name,
          runtime: savedProfile.runtime,
          protocol: savedProfile.protocol,
          baseUrl: savedProfile.baseUrl,
          model: savedProfile.model,
          apiKey: profileDraft.apiKey,
          resourceCpuCores: savedProfile.resourceCpuCores,
          resourceMemoryMb: savedProfile.resourceMemoryMb,
          timeoutSeconds: savedProfile.timeoutSeconds,
          networkPolicy: savedProfile.networkPolicy,
          autoCleanupMinutes: savedProfile.autoCleanupMinutes,
          isDefault: true,
        });
        if (!promoteRes.success || !promoteRes.data?.item) {
          toast.error('设为默认失败', promoteRes.error?.message ?? '候选配置已通过测试，但默认提升失败');
          return;
        }
        savedProfile = promoteRes.data.item;
        promoted = true;
        if (activeProfile.id !== savedProfile.id) {
          await deleteInfraAgentRuntimeProfile(activeProfile.id).catch(() => undefined);
        }
        setProfiles((prev) => [savedProfile, ...prev.filter((item) => item.id !== savedProfile.id && item.id !== activeProfile.id)]);
        setDraft((prev) => ({ ...prev, runtimeProfileId: savedProfile.id }));
        setProfileDraft((prev) => ({ ...prev, apiKey: '' }));
        toast.success('模型配置已更新', '已通过模型测试并设为默认配置');
        return;
      }

      const res = await updateInfraAgentRuntimeProfile(activeProfile.id, profileDraft);
      if (!res.success || !res.data?.item) {
        toast.error('更新模型配置失败', res.error?.message ?? '请检查 baseUrl、model 和 provider secret');
        return;
      }
      setProfiles((prev) => [res.data.item, ...prev.filter((item) => item.id !== res.data.item.id)]);
      setDraft((prev) => ({ ...prev, runtimeProfileId: res.data.item.id }));
      setProfileDraft((prev) => ({ ...prev, apiKey: '' }));
      setProfileTest('');
      toast.success(
        '模型配置已更新',
        retainsExistingSecret
          ? '已复用当前加密 provider secret；请点击测试模型确认上游可用'
          : '这是一条系统级长期配置，后续会话会继续复用',
      );
    } catch (err) {
      toast.error('更新模型配置失败', err instanceof Error ? err.message : '请检查 baseUrl、model 和 provider secret');
    } finally {
      if (candidateId && profileDraft.isDefault && !promoted) {
        await deleteInfraAgentRuntimeProfile(candidateId).catch(() => undefined);
      }
      setBusy(false);
    }
  }

  async function importDefaultProfile() {
    setBusy(true);
    const res = await importDefaultInfraAgentRuntimeProfile();
    setBusy(false);
    if (!res.success || !res.data?.item) {
      toast.error('启用默认模型失败', res.error?.message ?? '请先在模型设置中配置可用主模型');
      return;
    }
    setProfiles((prev) => [res.data!.item, ...prev.filter((item) => item.id !== res.data!.item.id)]);
    setDraft((prev) => ({ ...prev, runtimeProfileId: res.data!.item.id }));
    setProfileTest('');
    toast.success('已启用默认模型', '现在可以创建并运行远程会话了');
  }

  async function approveTool(approvalId: string, decision: 'allow' | 'deny') {
    if (!activeSession) return;
    setBusy(true);
    const res = await approveInfraAgentTool(activeSession.id, approvalId, decision);
    setBusy(false);
    if (!res.success) {
      toast.error('审批失败', res.error?.message ?? '请稍后重试');
      return;
    }
    await refreshDetail(activeSession.id);
  }

  async function createApprovalCard() {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    setBusy(true);
    try {
      const res = await requestInfraAgentToolApproval(sessionId, {
        toolName: 'repo_run_command',
        argsSummary: '{"command":"git status --short","cwd":"."}',
        risk: 'dangerous',
      });
      if (!res.success || !res.data?.item) {
        toast.error('审批卡创建失败', res.error?.message ?? '请稍后重试');
        await refreshDetail(sessionId);
        return;
      }
      upsertSession(res.data.item);
      await refreshDetail(res.data.item.id);
      toast.success('危险工具审批卡已生成', '刷新页面后仍会保留，允许或拒绝都会写入审计事件');
    } catch (err) {
      toast.error('审批卡创建失败', err instanceof Error ? err.message : '请稍后重试');
      await refreshDetail(sessionId);
    } finally {
      setBusy(false);
    }
  }

  async function copyText(label: string, value: string) {
    await navigator.clipboard.writeText(value);
    toast.success(`${label}已复制`);
  }

  function downloadText(filename: string, value: string, mimeType = 'text/plain;charset=utf-8') {
    const blob = new Blob([value], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadRunBundle() {
    const filename = `cds-agent-trace-bundle-${safeFilenamePart(activeSession?.id ?? activeSession?.traceId)}.json`;
    if (activeSession) {
      try {
        const res = await getInfraAgentTraceBundle(activeSession.id);
        if (res.success && res.data?.bundle) {
          downloadText(filename, JSON.stringify(res.data.bundle, null, 2), 'application/json;charset=utf-8');
          toast.success('Trace bundle 已导出', filename);
          return;
        }
        toast.warning('服务端 trace bundle 不可用', res.error?.message ?? '已导出当前页面缓存');
      } catch (err) {
        toast.warning('服务端 trace bundle 不可用', err instanceof Error ? err.message : '已导出当前页面缓存');
      }
    }

    downloadText(filename, JSON.stringify(runBundle, null, 2), 'application/json;charset=utf-8');
    toast.success('Run bundle 已导出', filename);
  }

  const viewToggle = (
    <div className="inline-flex rounded-lg p-0.5" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
      {(['simple', 'pro'] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          onClick={() => setViewMode(mode)}
          className="rounded-md px-3 py-1.5 text-sm transition-colors"
          style={
            viewMode === mode
              ? { background: 'rgba(99,179,237,0.18)', border: '1px solid rgba(99,179,237,0.4)', color: 'rgba(186,230,253,0.96)' }
              : { color: 'rgba(255,255,255,0.55)' }
          }
        >
          {mode === 'simple' ? '简洁模式' : '专业模式'}
        </button>
      ))}
    </div>
  );

  if (viewMode === 'simple') {
    // 过程类事件折叠进「执行过程」块；text_delta / done 的最终文本已由 assistant 消息承载，不重复渲染。
    const PROCESS_TYPES = new Set(['tool_call', 'tool_result', 'error', 'status', 'file', 'diff', 'browser', 'manual', 'hook', 'log']);
    type TimelineItem =
      | { kind: 'msg'; at: number; key: string; msg: InfraAgentMessageView }
      | { kind: 'local-msg'; at: number; key: string; msg: LocalTimelineMessage }
      | { kind: 'evt'; at: number; seq: number; key: string; ev: InfraAgentEventView };
    const visibleLocalMessages = localMessages.filter((item) => (
      !item.sessionId || !activeSession?.id || item.sessionId === activeSession.id
    ));
    const assistantStreamText = assistantTextFromEvents(displayedEvents);
    // 推理模型的思考原文（边车 thinking 事件透出）。在等待气泡里流式展示，消除"思考期间空白"。
    const thinkingText = displayedEvents
      .filter((e) => e.type === 'thinking')
      .map((e) => (typeof parsePayload(e).text === 'string' ? (parsePayload(e).text as string) : ''))
      .join('');
    const shouldShowAssistantStream = Boolean(
      assistantStreamText.trim()
      && !messages.some((message) => message.role === 'assistant' && message.content.trim() === assistantStreamText.trim()),
    );
    const latestAssistantEvent = [...displayedEvents].reverse().find((event) => event.type === 'done' || event.type === 'text_delta') ?? null;
    const timelineItems: TimelineItem[] = [
      ...messages.map((m): TimelineItem => ({ kind: 'msg', at: new Date(m.createdAt).getTime(), key: `m-${m.id}`, msg: m })),
      ...visibleLocalMessages.map((m): TimelineItem => ({ kind: 'local-msg', at: new Date(m.createdAt).getTime(), key: `lm-${m.id}`, msg: m })),
      ...(shouldShowAssistantStream ? [{
        kind: 'local-msg' as const,
        at: latestAssistantEvent ? new Date(latestAssistantEvent.createdAt).getTime() : Date.now(),
        key: 'assistant-stream',
        msg: {
          id: 'assistant-stream',
          role: 'assistant',
          content: assistantStreamText,
          // 本轮回复收到 done 即视为完成（即便会话仍 live），让回复立刻按 markdown 渲染，而不是一直纯文本
          status: (isLiveStatus && latestAssistantEvent?.type !== 'done') ? 'streaming' : 'completed',
          createdAt: latestAssistantEvent?.createdAt ?? new Date().toISOString(),
          sessionId: activeSession?.id ?? null,
        },
      }] : []),
      ...displayedEvents
        .filter((e) => PROCESS_TYPES.has(e.type) && !isNoiseEvent(e))
        .map((e): TimelineItem => ({ kind: 'evt', at: new Date(e.createdAt).getTime(), seq: e.seq, key: `e-${e.id}`, ev: e })),
    ].sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at; // 旧 → 新
      if (a.kind !== b.kind) return a.kind === 'msg' || a.kind === 'local-msg' ? -1 : 1;
      if (a.kind === 'evt' && b.kind === 'evt') return a.seq - b.seq;
      return 0;
    });
    type TimelineBlock =
      | { type: 'msg'; key: string; msg: InfraAgentMessageView | LocalTimelineMessage }
      | { type: 'group'; key: string; events: InfraAgentEventView[] };
	    const timelineBlocks: TimelineBlock[] = [];
	    for (const item of timelineItems) {
      if (item.kind === 'msg' || item.kind === 'local-msg') {
        timelineBlocks.push({ type: 'msg', key: item.key, msg: item.msg });
        continue;
      }
      const last = timelineBlocks[timelineBlocks.length - 1];
      if (last && last.type === 'group') last.events.push(item.ev);
      else timelineBlocks.push({ type: 'group', key: item.key, events: [item.ev] });
	    }
	    const hasConversation = messages.length > 0 || visibleLocalMessages.length > 0 || shouldShowAssistantStream;
    const canRunSimplePrompt = Boolean(
      prompt.trim()
      && !busy
      && (
        (activeSession && !activeSessionTimedOut && (canSendActiveSession || canStartActiveSession || canRecordManualInput))
        || ((!activeSession || activeSessionTimedOut) && canCreateSession)
      ),
    );
    const sendDisabled = !canRunSimplePrompt;

    // 左侧任务分组：运行中 vs 已完成。
    const runningSessions = visibleSessions.filter((s) => {
      const state = resolveSessionRuntimeState(s, nowTick).effectiveStatus;
      return state === 'running' || state === 'creating' || state === 'idle';
    });
    const finishedSessions = visibleSessions.filter((s) => {
      const state = resolveSessionRuntimeState(s, nowTick).effectiveStatus;
      return state === 'stopped' || state === 'failed' || state === 'stopping' || state === 'timed_out';
    });
    const promptPresets = simpleTaskMode === 'code'
      ? [
        '巡检当前仓库，找一个小问题并给出修复计划',
        '读取 README 和最近 changelog，总结这个功能怎么验收',
        '运行只读检查，整理失败原因和下一步动作',
      ]
      : [
        '总结这个 Agent 当前能做什么，以及下一步怎么用',
        '解释最近一次运行状态，告诉我是否需要停止或重试',
        '帮我把这个需求拆成可执行的检查清单',
      ];

    // 运行中且最后一块不是 Agent 回复 = 还在干活，给"已等待 Xs"反馈（规则 #6）。
    const lastBlock = timelineBlocks[timelineBlocks.length - 1];
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant') ?? null;
    const hasUserMessage = messages.some((message) => message.role === 'user');
    const hasAssistantOutput = Boolean(lastAssistant?.content.trim() || assistantStreamText.trim());
    const hasRuntimeRun = Boolean(activeSession?.currentRuntimeRunId);
    const awaitingAgent = isLiveStatus
      && (hasUserMessage || hasRuntimeRun)
      && !hasAssistantOutput
      && (!lastBlock || lastBlock.type !== 'msg' || lastBlock.msg.role !== 'assistant');
    let waitedSec = 0;
    if (awaitingAgent) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const base = lastUser ? new Date(lastUser.createdAt).getTime() : nowTick;
      waitedSec = Math.max(0, Math.round((nowTick - base) / 1000));
    }
    const sessionStartedAt = activeSession?.startedAt ? new Date(activeSession.startedAt) : activeSession?.createdAt ? new Date(activeSession.createdAt) : null;
    const elapsedSeconds = activeSessionRuntimeState.elapsedSeconds;
    const timeoutSeconds = activeSession?.timeoutSeconds ?? activeRuntimeProfile?.timeoutSeconds ?? 900;
    const timeoutAt = activeSessionRuntimeState.timeoutAt ?? (sessionStartedAt ? new Date(sessionStartedAt.getTime() + timeoutSeconds * 1000) : null);
    const timeoutReached = activeSessionTimedOut || activeSessionEffectiveStatus === 'timed_out';
    const lastSeq = latestEventSeq(events);
    const stopState = activeSessionTimedOut
      ? '已超时'
      : activeSession?.status === 'stopping'
      ? '停止中'
      : activeSession?.status === 'stopped'
        ? '已停止'
        : runtimeDiagnostics.cancelEvidence.eventCount > 0
          ? runtimeDiagnostics.cancelEvidence.latestMessage || '已有取消事件'
          : '未触发';
    const timeoutState = timeoutReached
      ? '已超时'
      : timeoutAt
        ? `约 ${formatHumanDuration(Math.max(0, Math.round((timeoutAt.getTime() - nowTick) / 1000)))} 后超时`
        : `启动后 ${formatHumanDuration(timeoutSeconds)} 超时`;
    const usefulEventTypes = new Set(['tool_call', 'tool_result', 'text_delta', 'done', 'file', 'diff', 'error', 'browser', 'manual']);
    const usefulEvents = events.filter((event) => usefulEventTypes.has(event.type));
    const latestUsefulEventAt = usefulEvents.length > 0 ? new Date(usefulEvents[usefulEvents.length - 1].createdAt) : null;
    const usefulBaseAt = latestUsefulEventAt?.getTime() ?? sessionStartedAt?.getTime() ?? (activeSession?.createdAt ? new Date(activeSession.createdAt).getTime() : null);
    const quietSeconds = activeSessionRuntimeState.isLive && usefulBaseAt
      ? Math.max(0, Math.round((nowTick - usefulBaseAt) / 1000))
      : null;
    const emptyExecution = Boolean(activeSession && hasRuntimeRun && !hasAssistantOutput && artifacts.length === 0 && usefulEvents.length === 0 && events.length > 0);
    const staleExecution = Boolean(activeSessionRuntimeState.isLive && !hasAssistantOutput && artifacts.length === 0 && quietSeconds !== null && quietSeconds >= 120);
    const executionKind = !activeSession
      ? '等待创建'
      : !hasUserMessage && !hasRuntimeRun
        ? '等待输入'
        : activeSessionTimedOut
          ? '已超时'
          : emptyExecution
            ? '空执行'
            : staleExecution
              ? '疑似假死'
              : activeSessionRuntimeState.isLive
                ? '执行中'
                : hasAssistantOutput || artifacts.length > 0
                  ? '有结果'
                  : '等待输出';
    const executionDetail = emptyExecution
      ? '已有 run 但没有有效输出事件'
      : staleExecution
        ? `超过 ${formatHumanDuration(quietSeconds ?? 0)} 没有有效输出`
        : latestUsefulEventAt
          ? `${usefulEvents.length} 个有效事件 · ${formatRelativePast(latestUsefulEventAt, nowTick)}`
          : '未开始或尚无有效事件';
	    const activeTargetLabel = activeSession
	      ? humanTargetWithRef(activeSession.gitRepository || activeSession.cdsProjectId || '默认 workspace', activeSession.gitRef || 'main')
	      : simpleTaskMode === 'code'
	        ? humanTargetWithRef(draft.gitRepository.trim() || '默认 workspace', draft.gitRef.trim() || 'main')
	        : '对话模式 · 不要求仓库';
    const fullTargetLabel = activeSession
      ? `${activeSession.gitRepository || activeSession.cdsProjectId || '默认 workspace'} · ${activeSession.gitRef || 'main'}`
      : simpleTaskMode === 'code'
        ? `${draft.gitRepository.trim() || '默认 workspace'} · ${draft.gitRef.trim() || 'main'}`
        : '对话模式 · 不要求仓库';
	    const readinessChecklist = [
	      { label: simpleTaskMode === 'code' || activeSession ? '目标仓库' : '交互模式', detail: activeTargetLabel, state: 'pass' },
	      {
	        label: canCreateSession ? '运行环境就绪' : '等待模型配置',
	        detail: canCreateSession ? '模型与远程运行环境可用' : (activeProfileBlockReason || activeRuntimePoolBlockReason || '需要可用模型后才能创建任务'),
	        state: canCreateSession ? 'pass' : 'warn',
	      },
	      {
	        label: activeSession ? '任务已创建' : '等待发起巡检',
	        detail: activeSession ? statusLabel(activeSessionEffectiveStatus) : '输入任务后点击运行',
	        state: activeSession ? 'pass' : 'pending',
	      },
	    ] as const;
	    const runProgressChecklist = [
        {
          label: '执行有效性',
          detail: activeSession ? executionDetail : '发起后判断是否有真实输出',
          state: emptyExecution || staleExecution || activeSessionTimedOut ? 'warn' : hasRuntimeRun || hasAssistantOutput ? 'pass' : activeSession ? 'pending' : 'idle',
        },
	      {
	        label: lastAssistant || artifacts.length > 0 ? '结果可复盘' : '等待 Agent 输出',
	        detail: artifacts.length > 0 ? `${artifacts.length} 个产物 / ${lastSeq} 个事件` : `${lastSeq} 个事件 / ${messages.length} 条消息`,
	        state: lastAssistant || artifacts.length > 0 ? 'pass' : activeSession ? 'pending' : 'idle',
	      },
	    ] as const;
    const readinessDone = readinessChecklist.filter((item) => item.state === 'pass').length;
    const runProgressDone = runProgressChecklist.filter((item) => item.state === 'pass').length;
    const showRunProgress = Boolean(activeSession && (hasRuntimeRun || hasConversation || activeSessionTimedOut));
    const simpleRunElapsedSeconds = simpleRunState
      ? Math.max(0, Math.round((nowTick - simpleRunState.startedAt) / 1000))
      : 0;
    const simpleDebugTelemetry = [
      { label: 'traceId', value: activeSession ? activeSession.traceId : '待生成' },
      { label: 'runtimeRunId', value: activeSession?.currentRuntimeRunId ?? '未启动' },
      { label: 'lastEventSeq', value: String(lastSeq) },
      { label: 'timeoutAt', value: timeoutAt ? `${timeoutAt.toLocaleString()} (${formatClockTime(timeoutAt)})` : '待计算' },
      { label: 'CDS session', value: activeSession?.cdsSessionId ?? '未绑定' },
      { label: '事件流', value: eventStreamHealthy ? 'SSE live' : events.length > 0 ? '分页回放' : '暂无事件' },
    ];
    const simpleRunSummary = [
      { label: '当前状态', value: activeSession ? executionKind : '未创建', detail: activeSessionTimedOut ? '旧任务已超时；再次运行会创建新会话' : executionDetail },
      { label: '已经用时', value: sessionStartedAt ? formatHumanDuration(elapsedSeconds) : '未启动', detail: sessionStartedAt ? `从 ${formatRelativePast(sessionStartedAt, nowTick)} 开始` : '启动后开始计时' },
      { label: '超时', value: timeoutState, detail: '这是任务超时，不是容器存活时间' },
      { label: '停止', value: stopState, detail: activeSessionRuntimeState.isLive ? '可以随时停止当前运行' : '当前没有活动运行' },
      { label: '产物', value: artifacts.length > 0 ? `${artifacts.length} 个产物` : '暂无产物', detail: artifacts.length > 0 ? '可在证据区查看' : '等待文件、diff、日志或快照' },
    ];
	    const evidenceEvents = displayedEvents
	      .filter((event) => event.type === 'tool_result' || event.type === 'error' || event.type === 'file' || event.type === 'diff')
	      .slice(-6)
	      .reverse();
	    const simplePromptPresetRow = (
	      <div className="flex flex-wrap justify-center gap-2">
	        {promptPresets.map((item) => (
	          <button
	            key={item}
	            type="button"
	            onClick={() => setPrompt(item)}
	            className="rounded-lg px-2.5 py-1.5 text-xs text-white/46 hover:text-white/76"
	            style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)' }}
	          >
	            {item}
	          </button>
	        ))}
	      </div>
	    );
	    const officialPoolReady = Boolean(runtimeStatus && runtimeStatus.instanceCount > 0 && runtimeStatus.healthyCount > 0);
	    const liteModeActive = Boolean(runtimeStatus?.liteReviewAvailable && !officialPoolReady);
	    const simpleComposer = (
	      <div className="mx-auto w-full max-w-[820px] rounded-2xl p-3" style={{ background: 'rgba(38,38,38,0.96)', border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 18px 60px rgba(0,0,0,0.34)' }}>
	        {liteModeActive && (
	          <div className="mb-2 rounded-lg px-3 py-2 text-[11px] leading-relaxed text-blue-100/82" style={{ background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.22)' }}>
	            当前为 <strong>Lite 预览模式</strong>：尚未配置 Claude/Anthropic provider，系统改用现有模型做<strong>只读</strong>代码审查（不修改文件、不执行命令、无需审批）。结果为预览级，配置官方 provider 后自动升级为商业级审查。
	          </div>
	        )}
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-lg p-1" style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.08)' }}>
              {([
                { value: 'chat', label: '对话', icon: MessageSquare },
                { value: 'code', label: '代码', icon: Terminal },
              ] as const).map((mode) => {
                const Icon = mode.icon;
                const active = simpleTaskMode === mode.value;
                return (
                  <button
                    key={mode.value}
                    type="button"
                    onClick={() => setSimpleTaskMode(mode.value)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold"
                    style={active
                      ? { background: 'rgba(96,165,250,0.18)', color: 'rgba(191,219,254,0.96)' }
                      : { color: 'rgba(255,255,255,0.48)' }}
                  >
                    <Icon size={13} />
                    {mode.label}
                  </button>
                );
              })}
            </div>
          </div>
	        <textarea
	          value={prompt}
	          onChange={(e) => setPrompt(e.target.value)}
	          rows={2}
	          autoFocus
	          placeholder={simpleTaskMode === 'code'
	            ? '在此输入：告诉 Agent 要巡检什么，例如「找出当前仓库最值得修复的一个小问题，并说明如何提交 PR」'
	            : '在此输入你的问题，回车发送（无需先填仓库）'}
	          className="min-h-[80px] w-full resize-none rounded-xl border border-white/15 bg-white/5 px-3.5 py-3 text-base leading-relaxed text-white outline-none transition placeholder:text-white/40 focus:border-sky-400/60 focus:bg-white/[0.07] focus:ring-2 focus:ring-sky-400/25"
	        />
          {simpleRunState && (
            <div
              className="mt-2 rounded-xl px-3 py-2 text-xs"
              style={{
                background: simpleRunState.phase === 'failed' ? 'rgba(239,68,68,0.1)' : 'rgba(96,165,250,0.08)',
                border: simpleRunState.phase === 'failed' ? '1px solid rgba(239,68,68,0.28)' : '1px solid rgba(96,165,250,0.18)',
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="inline-flex items-center gap-2 text-white/72">
                  {simpleRunState.phase === 'failed'
                    ? <Square size={13} className="text-red-300/80" />
                    : simpleRunState.phase === 'completed'
                      ? <ShieldCheck size={13} className="text-emerald-300/80" />
                      : <MapSpinner size={13} />}
                  <span className="font-semibold">{simpleRunState.label}</span>
                  <span className="text-white/38">· {formatHumanDuration(simpleRunElapsedSeconds)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void copyText('请求诊断', buildSimpleRunDiagnostic(simpleRunState))}
                  className="inline-flex items-center gap-1 rounded px-2 py-1 text-white/45 hover:text-white/80"
                >
                  <Copy size={12} /> 复制诊断
                </button>
              </div>
              {simpleRunState.detail && <div className="mt-1 text-white/48">{simpleRunState.detail}</div>}
              {simpleRunState.errorMessage && (
                <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap rounded-lg p-2 text-[11px] leading-relaxed text-red-100/78" style={{ background: 'rgba(0,0,0,0.24)' }}>
                  {[
                    simpleRunState.errorCode ? `code=${simpleRunState.errorCode}` : '',
                    simpleRunState.errorMessage,
                    simpleRunState.traceId ? `traceId=${simpleRunState.traceId}` : '',
                    simpleRunState.requestId ? `requestId=${simpleRunState.requestId}` : '',
                    simpleRunState.source ? `source=${simpleRunState.source}` : '',
                  ].filter(Boolean).join('\n')}
                </pre>
              )}
            </div>
          )}
	        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2">
            {simpleTaskMode === 'code' ? (
              <>
                <input
                  value={draft.gitRepository}
                  onChange={(e) => setDraft((prev) => ({ ...prev, gitRepository: e.target.value }))}
                  placeholder="仓库 URL，可留空使用默认 workspace"
                  className="h-9 min-w-[220px] flex-1 rounded-lg px-3 text-xs text-white outline-none placeholder:text-white/30"
                  style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.09)' }}
                />
                <input
                  value={draft.gitRef}
                  onChange={(e) => setDraft((prev) => ({ ...prev, gitRef: e.target.value }))}
                  placeholder="main"
                  className="h-9 w-[104px] rounded-lg px-3 text-xs text-white outline-none placeholder:text-white/30"
                  style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.09)' }}
                />
              </>
            ) : (
              <div className="min-w-[200px] flex-1 truncate text-[11px] text-white/35">
                对话模式不要求仓库；需要代码上下文时切到「代码」模式
              </div>
            )}
            {/* 模型可见 + 可改（参照 Codex 输入栏模型选择器）：运行中显示当前模型；新会话可在此切换（解决"配了 v4 却跑 v3.2"——直接选对的那个）。 */}
            {activeSession && activeSessionRuntimeState.isLive ? (
              <span
                className="inline-flex h-9 max-w-[240px] items-center gap-1.5 truncate rounded-lg px-3 text-[11px] text-white/60"
                style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.09)' }}
                title="本会话运行中，模型已固定；新建会话可改"
              >
                <ShieldCheck size={12} className="shrink-0 text-emerald-300/70" />
                模型 · {activeSessionProfile?.model || activeSession.model || '默认'}
              </span>
            ) : profiles.length > 0 ? (
              <select
                value={draft.runtimeProfileId}
                onChange={(e) => setDraft((prev) => ({ ...prev, runtimeProfileId: e.target.value }))}
                title="选择本次会话使用的模型"
                className="h-9 max-w-[240px] rounded-lg px-2 text-xs text-white outline-none"
                style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.09)' }}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.model || p.name}</option>
                ))}
              </select>
            ) : null}
            {activeSessionRuntimeState.isLive && (
              <button
                type="button"
                onClick={() => void stopSession()}
                disabled={busy}
                className="inline-flex h-9 min-w-[82px] items-center justify-center gap-2 rounded-lg text-sm font-semibold disabled:opacity-45"
                style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.34)', color: 'rgba(252,165,165,0.98)' }}
              >
                <Square size={14} />
                停止
              </button>
            )}
	          <button
	            type="button"
	            onClick={() => void runSimpleReadonlyReview()}
	            disabled={sendDisabled}
	            className="inline-flex h-9 min-w-[94px] items-center justify-center gap-2 rounded-lg text-sm font-semibold disabled:opacity-45"
	            style={{ background: 'rgba(96,165,250,0.16)', border: '1px solid rgba(96,165,250,0.36)', color: 'rgba(191,219,254,0.98)' }}
	          >
	            {busy ? <MapSpinner size={14} /> : activeSession?.manualTakeoverEnabled ? <UserCheck size={14} /> : <Send size={14} />}
	            {activeSession?.manualTakeoverEnabled ? '记录' : activeSession ? '发送' : '运行'}
	          </button>
	        </div>
	      </div>
	    );
    const handleTimelineScroll = () => {
      const el = timelineRef.current;
      if (!el) return;
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setAutoScrollPaused(distanceToBottom > 96);
    };
    const jumpToTimelineBottom = () => {
      const el = timelineRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      setAutoScrollPaused(false);
    };
	    return (
	      <div className="h-full min-h-0 overflow-hidden px-3 py-4 text-white sm:px-5" style={{ background: '#0F0F10' }}>
	        <div className="mx-auto grid h-[calc(100vh-112px)] max-w-[1880px] gap-4 xl:grid-cols-[292px_minmax(0,1fr)_336px]">
	          <aside className="min-h-0 overflow-hidden rounded-2xl" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>
	            <div className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
	              <div className="min-w-0">
	                <div className="text-sm font-semibold text-white/82">任务</div>
	                <div className="mt-0.5 truncate text-xs text-white/38">{sortedSessions.length} 个会话 · {activeSession ? statusLabel(activeSessionEffectiveStatus) : '待运行'}</div>
	              </div>
	              <button
	                type="button"
	                onClick={() => void createSession()}
	                disabled={!canCreateSession || busy}
	                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/70 disabled:opacity-45"
	                style={{ background: 'rgba(255,255,255,0.055)', border: '1px solid rgba(255,255,255,0.1)' }}
	                aria-label="新建任务"
	              >
	                <Plus size={15} />
	              </button>
	            </div>
	            {!canCreateSession && (
	              <div className="m-3 rounded-lg px-3 py-2 text-xs leading-relaxed text-amber-100/80" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.22)' }}>
	                {activeProfileBlockReason || activeRuntimePoolBlockReason || '请先在专业模式选择 CDS 连接和模型配置。'}
	                {activeProfileBlockReason && (
	                  <button
                    type="button"
	                    onClick={() => void importDefaultProfile()}
	                    className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs font-semibold"
	                    style={{ background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.34)', color: 'rgba(253,230,138,0.95)' }}
	                  >
	                    <Server size={12} /> 同步系统主模型
	                  </button>
	                )}
	              </div>
	            )}
	            <label className="mx-3 mt-3 flex items-center gap-2 rounded-lg px-3 py-2" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.07)' }}>
	              <Search size={13} className="text-white/35" />
	              <input
	                value={sessionQuery}
	                onChange={(e) => setSessionQuery(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-white/32"
	                placeholder="搜索任务、模型、状态"
	              />
	            </label>
	            <div className="h-[calc(100%-116px)] space-y-3 overflow-y-auto px-3 pb-3 pt-3" style={{ overscrollBehavior: 'contain' }}>
	              {sortedSessions.length === 0 ? (
	                <div className="flex h-full min-h-[180px] items-center justify-center rounded-xl text-center text-xs text-white/38" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
	                  还没有任务
	                </div>
	              ) : visibleSessions.length === 0 ? (
	                <div className="flex min-h-[180px] items-center justify-center rounded-xl text-center text-xs text-white/38" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
	                  没有匹配的任务
	                </div>
	              ) : (
                ([
                  ['运行中', runningSessions],
                  ['已完成', finishedSessions],
                ] as const).filter(([, list]) => list.length > 0).map(([groupLabel, list]) => (
	                  <div key={groupLabel} className="space-y-1.5">
	                    <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-white/34">{groupLabel} · {list.length}</div>
	                    {list.map((session) => {
	                      const selected = session.id === activeSession?.id;
	                      const sessionState = resolveSessionRuntimeState(session, nowTick);
	                      const live = sessionState.isLive;
	                      return (
                        <button
                          key={session.id}
	                          type="button"
	                          onClick={() => setActiveSessionId(session.id)}
	                          className="block w-full rounded-xl px-3 py-2.5 text-left"
	                          style={{
	                            background: selected ? 'rgba(96,165,250,0.10)' : 'rgba(0,0,0,0.14)',
	                            border: selected ? '1px solid rgba(96,165,250,0.28)' : '1px solid rgba(255,255,255,0.06)',
	                          }}
	                        >
	                          <div className="flex items-center gap-2">
	                            <span className={`h-2 w-2 shrink-0 rounded-full ${live ? 'animate-pulse bg-sky-400' : selected ? 'bg-sky-400/80' : 'bg-white/18'}`} />
	                            <span className="truncate text-sm font-medium text-white/76">{session.title}</span>
	                          </div>
	                          <div className="mt-1 truncate pl-4 text-xs text-white/38">{statusLabel(sessionState.effectiveStatus)} · {formatRelativePast(session.updatedAt, nowTick)}</div>
	                        </button>
	                      );
	                    })}
                  </div>
                ))
	              )}
	            </div>
	          </aside>

	          <main className="relative flex min-h-0 flex-col overflow-hidden rounded-2xl" style={{ background: 'rgba(18,18,18,0.94)', border: '1px solid rgba(255,255,255,0.075)' }}>
	            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-3">
	              <div className="min-w-0">
	                <div className="flex items-center gap-2">
	                  <span className={`h-2.5 w-2.5 rounded-full ${isLiveStatus ? 'animate-pulse bg-sky-400' : activeSession ? 'bg-white/28' : 'bg-amber-300/80'}`} />
	                  <h1 className="truncate text-base font-semibold text-white/86">{activeSession ? activeSession.title : 'CDS Agent 只读巡检'}</h1>
	                </div>
	                <div className="mt-1 truncate text-xs text-white/42">
	                  {activeSession ? `${statusLabel(activeSessionEffectiveStatus)} · ${activeTargetLabel}` : '填写目标和任务，点击运行后自动创建 CDS 会话'}
	                </div>
	              </div>
	              <div className="flex items-center gap-2">
	                {viewToggle}
	                <button
	                  type="button"
	                  onClick={() => void loadAll()}
	                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-white/58 hover:text-white/82"
	                  style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}
	                  aria-label="刷新"
	                >
	                  <RefreshCw size={14} />
	                </button>
	                {activeSession && canStartActiveSession && (
	                  <button
	                    type="button"
	                    onClick={() => void startSession()}
	                    disabled={busy}
	                    className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold disabled:opacity-45"
	                    style={{ background: 'rgba(96,165,250,0.14)', border: '1px solid rgba(96,165,250,0.32)', color: 'rgba(191,219,254,0.95)' }}
	                  >
	                    <Play size={14} /> {primaryActionLabel(activeSessionEffectiveStatus)}
                  </button>
                )}
                {activeSession && activeSessionRuntimeState.isLive && (
                  <button
	                    type="button"
	                    onClick={() => void stopSession()}
	                    disabled={busy}
	                    className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold disabled:opacity-45"
	                    style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(252,165,165,0.95)' }}
	                  >
	                    <Square size={14} /> 停止
                  </button>
	                )}
	              </div>
	            </div>

	            <div ref={timelineRef} onScroll={handleTimelineScroll} className="mx-auto mt-4 min-h-0 w-full max-w-[980px] flex-1 space-y-3 overflow-y-auto px-4 pb-5 pt-4" style={{ overscrollBehavior: 'contain' }}>
	              {!hasConversation ? (
	                <div className="flex h-full min-h-[360px] flex-col items-center justify-center gap-6 text-center">
	                  <div>
	                    <h2 className="text-2xl font-semibold text-white/88">{simpleTaskMode === 'code' ? '要在这个仓库里检查什么？' : '想让 Agent 做什么？'}</h2>
	                    <div className="mt-2 text-sm text-white/42">
                        {simpleTaskMode === 'code'
                          ? '输入代码巡检任务后，CDS 会创建只读 Agent 会话并沉淀过程、结果和产物。'
                          : '可以先直接对话；需要仓库、测试或 PR 建议时再切到「代码」模式。'}
                      </div>
	                  </div>
	                  {simpleComposer}
	                  {simplePromptPresetRow}
	                </div>
	              ) : (
	                timelineBlocks.map((block) => {
                  if (block.type === 'msg') {
                    const isUser = block.msg.role === 'user';
                    return (
	                      <article key={block.key} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
	                        <div
	                          className="max-w-[86%] rounded-2xl px-3.5 py-2.5"
	                          style={{
	                            background: isUser ? 'rgba(96,165,250,0.12)' : 'rgba(255,255,255,0.045)',
	                            border: isUser ? '1px solid rgba(96,165,250,0.28)' : '1px solid rgba(255,255,255,0.08)',
	                          }}
	                        >
	                          <div className="mb-1 text-[11px] text-white/42">{messageRoleLabel(block.msg.role)} · {new Date(block.msg.createdAt).toLocaleTimeString()}</div>
                          {block.msg.role === 'assistant' ? (
                            block.msg.id === 'assistant-stream' && block.msg.status === 'streaming' ? (
                              <div className="text-sm leading-relaxed text-white/78">
                                <StreamingText text={block.msg.content} streaming mode="blur" />
                              </div>
                            ) : (
                              <MarkdownContent content={displayMessageContent(block.msg)} className="text-sm leading-relaxed text-white/78" />
                            )
                          ) : (
                            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-white/78">{displayMessageContent(block.msg)}</div>
                          )}
                          {(block.msg.status === 'sending' || block.msg.status === 'failed') && (
                            <div className="mt-1 text-[11px] text-white/35">
                              {block.msg.status === 'failed' ? '发送失败，请检查上方错误后重试。' : simpleSubmitStatus || '正在提交…'}
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  }
                  const events = block.events;
                  const summary = summarizeProcessEvents(events);
                  const pendingApproval = events.find((e) => {
                    if (e.type !== 'tool_call') return false;
                    const p = parsePayload(e);
                    return typeof p.approvalId === 'string' && p.status === 'waiting';
                  });
                  const forcedOpen = Boolean(pendingApproval);
                  const open = forcedOpen || expandedGroups.has(block.key);
                  const firstAt = new Date(events[0].createdAt).getTime();
                  const lastAt = new Date(events[events.length - 1].createdAt).getTime();
                  const durationSec = Math.max(0, Math.round((lastAt - firstAt) / 1000));
                  const lastLabel = processEventLabel(events[events.length - 1]);
                  const hasError = events.some((e) => e.type === 'error');
                  // 纯内部状态/日志分组（无工具调用/结果、无错误、无待审批）对普通对话零价值，
                  // 「后台状态 running / dispatching run to CDS-managed... / 用时10小时2分钟」这种会污染聊天流
                  // （用户反馈：我消息发出去了，怎么冒出奇怪的对话框日志）。从对话里隐去；
                  // 运行状态看右侧「运行进展/摘要」，完整内部日志看右侧「运行日志」。
                  if (summary.usefulCount === 0 && !hasError && !pendingApproval) return null;
                  const processTitle = pendingApproval
                    ? '等待审批'
                    : hasError
                      ? '执行过程（含错误）'
                      : summary.usefulCount > 0
                        ? '工具执行'
                        : '后台状态';
                  const processMeta = [
                    summary.toolCallCount > 0 ? `${summary.toolCallCount} 次工具调用` : '',
                    summary.toolResultCount > 0 ? `${summary.toolResultCount} 个结果` : '',
                    summary.logCount > 0 ? `${summary.logCount} 条日志` : '',
                    summary.statusCount > 0 ? `${summary.statusCount} 个状态` : '',
                    summary.rawCount > summary.usefulCount ? `原始 ${summary.rawCount} 条` : '',
                  ].filter(Boolean).join(' · ');
                  const processHint = summary.toolNames.length > 0
                    ? summary.toolNames.map((name) => toolActionLabel(name, {})).join(' / ')
                    : lastLabel;
                  const headerTone = hasError
                    ? { background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.24)' }
                    : pendingApproval
                      ? { background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)' }
                      : { background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.09)' };
	                  return (
	                    <div key={block.key} className="flex justify-start">
	                      <div className="w-full max-w-[92%] rounded-xl" style={headerTone}>
	                        <button
                          type="button"
                          onClick={() => setExpandedGroups((prev) => {
                            const next = new Set(prev);
                            if (next.has(block.key)) next.delete(block.key); else next.add(block.key);
                            return next;
                          })}
                          disabled={forcedOpen}
	                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-white/64 disabled:cursor-default"
	                        >
	                          <Terminal size={12} className="shrink-0" />
	                          <span className="shrink-0 font-semibold">
                            {processTitle}
                          </span>
                          <span className="shrink-0 text-white/40">{processMeta || `${events.length} 条`} · 用时 {formatHumanDuration(durationSec)}</span>
                          <span className="min-w-0 flex-1 truncate text-white/40">{open ? '' : processHint}</span>
                          {!forcedOpen && <span className="shrink-0 text-white/35">{open ? '收起' : '展开'}</span>}
                        </button>
                        {open && (
                          <div className="space-y-1.5 border-t border-white/10 px-3 py-2">
                            {events.map((event) => {
                              const payload = parsePayload(event);
                              const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
                              const waitingApproval = event.type === 'tool_call' && approvalId && payload.status === 'waiting';
                              const stepOpen = simpleExpandedEventId === event.id;
                              const label = processEventLabel(event);
                              // 任何事件都能展开看细节（错误码/traceId、状态原因、工具入参/结果），不再只有工具调用可展开。
                              // 只在「展开后确实有内容」时才显示「详情」。否则空 payload 事件
                              // 会展开成空/「{}」（用户反馈：展开折叠的没有内容）。tool_call/tool_result
                              // 有富渲染（工具名/文件树/diff/输出）始终可展开；其它类型要求 renderPayload 有真实文本。
                              const canExpand = (() => {
                                if (event.type === 'tool_call' || event.type === 'tool_result') return true;
                                const txt = renderPayload(event).trim();
                                return txt.length > 0 && txt !== '{}';
                              })();
                              return (
                                <div key={event.id} className="rounded-md px-2 py-1.5 text-xs" style={{ background: 'rgba(0,0,0,0.2)' }}>
                                  <button
                                    type="button"
                                    disabled={!canExpand}
                                    onClick={() => setSimpleExpandedEventId((prev) => (prev === event.id ? null : event.id))}
                                    className="flex w-full items-center gap-2 text-left text-white/62 disabled:cursor-default"
                                  >
                                    {event.type === 'tool_result'
                                      ? <ShieldCheck size={12} className="shrink-0 text-emerald-300/70" />
                                      : event.type === 'error'
                                        ? <Square size={12} className="shrink-0 text-red-300/70" />
                                        : <Terminal size={12} className="shrink-0" />}
                                    <span className="min-w-0 flex-1 break-words">{label}</span>
                                    {canExpand && <span className="shrink-0 text-white/30">{stepOpen ? '收起' : '详情'}</span>}
                                  </button>
                                  {stepOpen && canExpand && (
                                    <div className="mt-1 border-t border-white/10 pt-1"><EventBody event={event} /></div>
                                  )}
                                  {waitingApproval && (
                                    <div className="mt-2 flex gap-2">
                                      <button type="button" onClick={() => void approveTool(approvalId, 'allow')} className="rounded-md px-2 py-1 text-xs" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.28)', color: 'rgba(134,239,172,0.95)' }}>允许</button>
                                      <button type="button" onClick={() => void approveTool(approvalId, 'deny')} className="rounded-md px-2 py-1 text-xs" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(252,165,165,0.95)' }}>拒绝</button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })
	              )}
	              {awaitingAgent && (
	                <div className="flex justify-start">
	                  <div className="max-w-[88%] rounded-xl px-3 py-2 text-xs text-white/55" style={{ background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)' }}>
	                    <div className="inline-flex items-center gap-2">
	                      <MapSpinner size={13} />
	                      <span>Agent 思考中… 已等待 {formatHumanDuration(waitedSec)}（推理模型首字可能较慢）</span>
	                    </div>
	                    {thinkingText.trim() && (
	                      <div className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg px-2 py-1.5 text-[11px] leading-relaxed text-white/50" style={{ background: 'rgba(0,0,0,0.22)', overscrollBehavior: 'contain' }}>
	                        {thinkingText}
	                      </div>
	                    )}
	                  </div>
                </div>
              )}
	            </div>
              {autoScrollPaused && (
                <button
                  type="button"
                  onClick={jumpToTimelineBottom}
                  className="absolute bottom-[142px] left-1/2 z-10 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs font-semibold text-white/72 shadow-lg"
                  style={{ background: 'rgba(39,39,42,0.94)', border: '1px solid rgba(255,255,255,0.14)' }}
                >
                  有新内容，回到底部
                </button>
              )}

	            {hasConversation && (
	              <div className="shrink-0 px-5 pb-5 pt-3" style={{ background: 'linear-gradient(180deg, rgba(18,18,18,0) 0%, rgba(18,18,18,0.96) 18%)' }}>
	                <div className="mb-3">{simplePromptPresetRow}</div>
	                {simpleComposer}
	              </div>
	            )}
	          </main>

	          <aside className="min-h-0 overflow-y-auto rounded-2xl" style={{ background: 'rgba(255,255,255,0.055)', border: '1px solid rgba(255,255,255,0.08)', overscrollBehavior: 'contain' }}>
	            <div className="border-b border-white/10 px-4 py-4">
	              <div className="flex items-center justify-between gap-3">
	                <div>
	                  <div className="text-sm font-semibold text-white/82">{showRunProgress ? '运行进展' : '准备情况'}</div>
	                  <div className="mt-1 text-xs text-white/42">
	                    准备项 {readinessDone}/{readinessChecklist.length} 就绪{showRunProgress ? ` · 运行项 ${runProgressDone}/${runProgressChecklist.length}` : ''}
	                  </div>
	                </div>
	                <span className="rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: isLiveStatus ? 'rgba(96,165,250,0.14)' : 'rgba(255,255,255,0.06)', color: isLiveStatus ? 'rgba(191,219,254,0.95)' : 'rgba(203,213,225,0.72)' }}>
	                  {activeSession ? statusLabel(activeSessionEffectiveStatus) : '待运行'}
	                </span>
	              </div>
	              <div className="mt-4 space-y-3">
	                {readinessChecklist.map((item) => {
	                  const done = item.state === 'pass';
	                  const warn = item.state === 'warn';
	                  return (
	                    <div key={item.label} className="flex gap-2.5">
	                      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full" style={{ background: done ? 'rgba(34,197,94,0.2)' : warn ? 'rgba(245,158,11,0.18)' : 'rgba(255,255,255,0.08)', color: done ? 'rgba(134,239,172,0.95)' : warn ? 'rgba(253,230,138,0.92)' : 'rgba(148,163,184,0.74)' }}>
	                        {done ? <ShieldCheck size={12} /> : warn ? <KeyRound size={11} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
	                      </span>
	                      <div className="min-w-0">
	                        <div className="text-sm font-medium text-white/76">{item.label}</div>
	                        <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-white/40">{item.detail}</div>
	                      </div>
	                    </div>
	                  );
	                })}
                  {showRunProgress && (
                    <div className="border-t border-white/10 pt-3">
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-normal text-white/34">任务运行</div>
                      <div className="space-y-3">
                        {runProgressChecklist.map((item) => {
                          const done = item.state === 'pass';
                          const warn = item.state === 'warn';
                          return (
                            <div key={item.label} className="flex gap-2.5">
                              <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full" style={{ background: done ? 'rgba(34,197,94,0.18)' : warn ? 'rgba(245,158,11,0.18)' : 'rgba(255,255,255,0.08)', color: done ? 'rgba(134,239,172,0.95)' : warn ? 'rgba(253,230,138,0.92)' : 'rgba(148,163,184,0.74)' }}>
                                {done ? <ShieldCheck size={12} /> : warn ? <KeyRound size={11} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                              </span>
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-white/76">{item.label}</div>
                                <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-white/40">{item.detail}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
	              </div>
	            </div>

	            {showOpsPanels && (<>
	            <div className="border-b border-white/10 px-4 py-4">
	              <div className="mb-3 flex items-center justify-between gap-2">
	                <div className="inline-flex items-center gap-2 text-sm font-semibold text-white/76"><GitPullRequest size={14} /> Git</div>
	                <span className="rounded-full px-2 py-0.5 text-[11px]" style={{ background: gitContext.prUrl ? 'rgba(34,197,94,0.13)' : 'rgba(148,163,184,0.1)', color: gitContext.prUrl ? 'rgba(134,239,172,0.95)' : 'rgba(148,163,184,0.86)' }}>
	                  {gitContext.prUrl ? 'Ready' : 'Pending'}
	                </span>
	              </div>
	              <div className="space-y-2 text-xs">
	                <div className="flex justify-between gap-3"><span className="text-white/38">目标</span><span className="min-w-0 truncate text-white/70" title={fullTargetLabel}>{activeTargetLabel}</span></div>
	                <div className="flex justify-between gap-3"><span className="text-white/38">分支</span><span className="min-w-0 truncate text-white/70">{gitContext.branch || '等待 Agent 创建'}</span></div>
	                <div className="flex justify-between gap-3"><span className="text-white/38">提交</span><span className="font-mono text-white/70">{gitContext.commit ? gitContext.commit.slice(0, 12) : 'n/a'}</span></div>
	              </div>
	              {gitContext.prUrl && (
	                <a href={gitContext.prUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.28)', color: 'rgba(134,239,172,0.95)' }}>
	                  <Globe2 size={12} /> 打开 Pull Request
	                </a>
	              )}
	            </div>

	            <div className="border-b border-white/10 px-4 py-4">
	              <div className="mb-3 flex items-center justify-between gap-2">
	                <span className="inline-flex items-center gap-2 text-sm font-semibold text-white/76"><FileText size={14} /> 证据</span>
	                <button
	                  type="button"
	                  onClick={() => void collectArtifacts()}
	                  disabled={!activeSession || busy}
	                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-white/55 hover:text-white/85 disabled:opacity-45"
	                  style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}
	                >
	                  {busy ? <MapSpinner size={11} /> : <FileSearch size={11} />} 生成
	                </button>
	              </div>
	              <div className="max-h-[260px] space-y-2 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
	                {artifacts.length > 0 ? artifacts.map((artifact) => (
	                  <div key={artifact.id} className="rounded-xl p-2.5" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)' }}>
	                    <div className="flex items-center justify-between gap-2">
	                      <span className="inline-flex min-w-0 items-center gap-1.5 truncate text-xs font-semibold text-white/72">{artifactIcon(artifact.kind)} {artifact.title}</span>
	                      <button type="button" onClick={() => void copyText(artifact.title, artifact.body)} className="shrink-0 rounded p-1 text-white/40 hover:text-white/80" aria-label={`复制${artifact.title}`}>
	                        <Copy size={12} />
	                      </button>
	                    </div>
	                    <div className="mt-1 line-clamp-2 text-xs text-white/42">{artifact.summary}</div>
	                  </div>
	                )) : evidenceEvents.length > 0 ? evidenceEvents.map((event) => {
	                  const payload = parsePayload(event);
	                  return (
	                    <div key={event.id} className="rounded-xl px-3 py-2 text-xs" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.06)' }}>
	                      <div className="flex items-center justify-between gap-2">
	                        <span className="font-semibold text-white/66">{event.type === 'error' ? '错误' : event.type === 'diff' ? 'Diff' : event.type === 'file' ? '文件' : '工具结果'}</span>
	                        <span className="font-mono text-white/30">#{event.seq}</span>
	                      </div>
	                      <div className="mt-1 line-clamp-2 text-white/38">{String(payload.message ?? payload.summary ?? payload.path ?? payload.toolName ?? '已记录')}</div>
	                    </div>
	                  );
	                }) : (
	                  <div className="rounded-xl px-3 py-4 text-xs leading-relaxed text-white/38" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
	                    等待文件、diff、命令输出或日志证据。
	                  </div>
	                )}
	              </div>
	            </div>

	            <div className="px-4 py-4">
	              <div className="mb-3 text-sm font-semibold text-white/76">运行摘要</div>
	              <div className="space-y-2">
	                {simpleRunSummary.map((item) => (
	                  <div key={item.label} className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(0,0,0,0.14)', border: '1px solid rgba(255,255,255,0.055)' }}>
	                    <div className="flex items-center justify-between gap-3">
	                      <span className="text-xs text-white/38">{item.label}</span>
	                      <span className="min-w-0 truncate text-xs font-semibold text-white/76">{item.value}</span>
	                    </div>
	                    <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-white/34">{item.detail}</div>
	                  </div>
	                ))}
	              </div>
	              <details className="mt-3 rounded-xl px-3 py-2 text-xs text-white/46" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.055)' }}>
	                <summary className="cursor-pointer select-none font-semibold text-white/58">调试信息</summary>
	                <div className="mt-2 space-y-1.5">
	                  {simpleDebugTelemetry.map((item) => (
	                    <div key={item.label} className="flex gap-2">
	                      <span className="w-20 shrink-0 text-white/32">{item.label}</span>
	                      <span className="min-w-0 break-all font-mono text-white/48">{item.value}</span>
	                    </div>
	                  ))}
	                </div>
	                {runtimeDiagnostics.commercialNextAction && <div className="mt-2 leading-relaxed">{runtimeDiagnostics.commercialNextAction}</div>}
	                {runtimeDiagnostics.commercialNextCommand && (
	                  <code className="mt-2 block break-all rounded-lg px-2 py-1.5 text-[11px] text-white/55" style={{ background: 'rgba(0,0,0,0.22)' }}>
	                    {runtimeDiagnostics.commercialNextCommand}
	                  </code>
	                )}
	              </details>
	            </div>
	            </>)}
	          </aside>
	        </div>
	      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-5 text-white" style={{ background: 'linear-gradient(180deg, #101116 0%, #17181d 100%)' }}>
      <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
        <header className="order-1 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">CDS Agent</h1>
            <p className="mt-1 text-sm text-white/55">在远程 CDS sandbox 中运行 Claude Code / Codex 类任务，过程、工具审批和日志都留在 MAP。</p>
          </div>
          <div className="flex items-center gap-2">
            {viewToggle}
            <button
              type="button"
              onClick={() => void loadAll()}
              className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/70"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
            >
              <RefreshCw size={14} /> 刷新
            </button>
          </div>
        </header>

        <section className="order-2 rounded-xl px-4 py-3" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.08)' }}>
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
            <div className="grid gap-2 md:grid-cols-4">
              {[
                { label: '当前会话', value: activeSession ? statusLabel(activeSessionEffectiveStatus) : '未选择', hint: activeSession ? shortId(activeSession.traceId, 12) : '先选择或新建' },
                { label: '模型', value: activeProfile?.model ?? '未配置', hint: activeProfile ? protocolLabel(activeProfile.protocol) : '同步系统主模型' },
                { label: '运行中', value: metrics.running, hint: `${metrics.totalSessions} 个会话` },
                { label: '产物', value: metrics.artifactCount, hint: `${metrics.eventCount} 事件` },
              ].map((item) => (
                <div key={item.label} className="min-w-0 rounded-lg px-3 py-2" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="text-[11px] text-white/36">{item.label}</div>
                  <div className="mt-1 truncate text-sm font-semibold text-white/82">{item.value}</div>
                  <div className="mt-0.5 truncate text-xs text-white/38">{item.hint}</div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 xl:justify-end">
              <a href="#pro-workbench" className="inline-flex min-h-9 items-center rounded-lg px-3 text-xs font-semibold text-emerald-100/84" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.24)' }}>工作区</a>
              <a href="#pro-ops-panels" className="inline-flex min-h-9 items-center rounded-lg px-3 text-xs font-semibold text-white/62 hover:text-white/86" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>指标</a>
              <a href="#pro-runtime-diagnostics" className="inline-flex min-h-9 items-center rounded-lg px-3 text-xs font-semibold text-white/62 hover:text-white/86" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>诊断</a>
            </div>
          </div>
        </section>

        <section id="pro-ops-panels" className="order-6 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
          {[
            { label: '会话总数', value: metrics.totalSessions, hint: `${metrics.running} 运行中 / ${metrics.stopped} 已停止` },
            { label: '失败会话', value: metrics.failed, hint: metrics.failed > 0 ? '需要重试或检查模型配置' : '当前无失败会话' },
            { label: '当前事件', value: metrics.eventCount, hint: activeSession ? `trace ${activeSession.traceId.slice(0, 12)}` : '未选择会话' },
            { label: '工具事件', value: metrics.toolEvents, hint: 'tool_call / tool_result' },
            { label: '可见产物', value: metrics.artifactCount, hint: '文件、diff、日志和快照' },
          ].map((item) => (
            <div
              key={item.label}
              className="min-h-[76px] rounded-xl px-4 py-3"
              style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <div className="text-xs text-white/45">{item.label}</div>
              <div className="mt-1 text-2xl font-semibold leading-none text-white/88">{item.value}</div>
              <div className="mt-2 truncate text-xs text-white/42">{item.hint}</div>
            </div>
          ))}
        </section>

        <section
          className="order-7 rounded-xl px-4 py-3"
          style={{ background: 'rgba(255,255,255,0.032)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-white/78">SLA / 成本</div>
              <div className="mt-1 text-xs text-white/42">
                {slaDashboard ? `${slaDashboard.windowDays} 天窗口 · ${formatTime(slaDashboard.generatedAt)}` : '等待后端 SLA 指标'}
              </div>
            </div>
            <div className="text-xs text-white/42">
              {slaRuntimeFocus ? `${slaRuntimeFocus.runtime} · ${slaRuntimeFocus.runtimeAdapter}` : 'runtime 未聚合'}
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {[
              { label: '运行数', value: slaSummary?.sessionCount ?? 0, hint: `${slaSummary?.runningCount ?? 0} running / ${slaSummary?.completedCount ?? 0} complete` },
              { label: '失败率', value: formatPercent(slaSummary?.failureRate), hint: `${slaSummary?.failedCount ?? 0} failed / ${slaSummary?.errorEventCount ?? 0} error events` },
              { label: '超时率', value: formatPercent(slaSummary?.timeoutRate), hint: `${slaSummary?.timeoutCount ?? 0} timeout sessions` },
              { label: '平均耗时', value: slaSummary?.averageDurationSeconds != null ? formatDuration(slaSummary.averageDurationSeconds) : '未记录', hint: `${slaSummary?.eventCount ?? 0} events / ${slaSummary?.toolEventCount ?? 0} tools` },
              {
                label: 'Token',
                value: slaSummary?.tokenUsageObserved ? formatTokenCount(slaSummary.totalTokens) : '未上报',
                hint: slaSummary?.tokenUsageObserved
                  ? `in ${formatTokenCount(slaSummary.inputTokens)} / out ${formatTokenCount(slaSummary.outputTokens)}`
                  : 'adapter 暂未返回 usage',
              },
            ].map((item) => (
              <div
                key={item.label}
                className="min-h-[72px] rounded-lg px-3 py-2"
                style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div className="text-xs text-white/42">{item.label}</div>
                <div className="mt-1 truncate text-xl font-semibold leading-tight text-white/84">{item.value}</div>
                <div className="mt-1 truncate text-xs text-white/38">{item.hint}</div>
              </div>
            ))}
          </div>
        </section>

        <section
          className="order-8 rounded-xl px-4 py-3"
          style={{ background: 'rgba(255,255,255,0.032)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-white/78">
                <CalendarClock size={15} /> 定时巡检 / 知识治理
              </div>
              <div className="mt-1 text-xs text-white/42">
                {scheduleDashboard ? `${scheduleDashboard.windowDays} 天窗口 · 只读调度视图` : '等待 workflow schedule 指标'}
              </div>
            </div>
            <div className="text-xs text-white/42">
              {nextCdsAgentSchedule?.nextRunAt ? `next ${formatTime(nextCdsAgentSchedule.nextRunAt)}` : '暂无下一次 cron'}
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {[
              { label: '工作流', value: scheduleSummary?.workflowCount ?? 0, hint: `${scheduleSummary?.cdsAgentNodeCount ?? 0} CdsAgentRun nodes` },
              { label: 'Cron', value: scheduleSummary?.enabledCronScheduleCount ?? 0, hint: `${scheduleSummary?.cronScheduleCount ?? 0} total / ${scheduleSummary?.dueSoonScheduleCount ?? 0} due soon` },
              { label: '近期开跑', value: scheduleSummary?.recentExecutionCount ?? 0, hint: `${scheduleSummary?.failedRecentExecutionCount ?? 0} failed or timed out` },
              { label: 'KB 只读治理', value: scheduleDashboard?.knowledgeGovernance.workflowCount ?? 0, hint: scheduleDashboard?.knowledgeGovernance.readonlyTools.join(' / ') || 'kb_list / kb_search / kb_read' },
              {
                label: '最近执行',
                value: latestScheduledExecution?.status ?? '无',
                hint: latestScheduledExecution?.durationMs != null
                  ? formatDuration(Math.round(latestScheduledExecution.durationMs / 1000))
                  : latestScheduledExecution?.triggerType ?? '等待 cron/manual',
              },
            ].map((item) => (
              <div
                key={item.label}
                className="min-h-[72px] rounded-lg px-3 py-2"
                style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div className="text-xs text-white/42">{item.label}</div>
                <div className="mt-1 truncate text-xl font-semibold leading-tight text-white/84">{item.value}</div>
                <div className="mt-1 truncate text-xs text-white/38">{item.hint}</div>
              </div>
            ))}
          </div>
          {(nextCdsAgentSchedule || latestScheduledExecution) && (
            <div className="mt-3 grid gap-2 lg:grid-cols-2">
              {nextCdsAgentSchedule && (
                <a
                  href={nextCdsAgentSchedule.workflowPath}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 rounded-lg px-3 py-2 transition-colors hover:bg-white/[0.04]"
                  style={{ background: 'rgba(15,23,42,0.36)', border: '1px solid rgba(148,163,184,0.12)' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-white/70">{nextCdsAgentSchedule.name || nextCdsAgentSchedule.workflowName}</span>
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-cyan-100/70" style={{ background: 'rgba(56,189,248,0.1)' }}>{nextCdsAgentSchedule.state}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-white/42">{nextCdsAgentSchedule.cronExpression || nextCdsAgentSchedule.mode} · {nextCdsAgentSchedule.timezone}</div>
                </a>
              )}
              {latestScheduledExecution && (
                <a
                  href={latestScheduledExecution.workbenchPath || latestScheduledExecution.workflowPath}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 rounded-lg px-3 py-2 transition-colors hover:bg-white/[0.04]"
                  style={{ background: 'rgba(15,23,42,0.36)', border: '1px solid rgba(148,163,184,0.12)' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-white/70">{latestScheduledExecution.workflowName}</span>
                    <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-emerald-100/70" style={{ background: 'rgba(34,197,94,0.1)' }}>{latestScheduledExecution.status}</span>
                  </div>
                  <div className="mt-1 truncate text-xs text-white/42">
                    {latestScheduledExecution.cdsAgentSessionId ? `CDS session ${latestScheduledExecution.cdsAgentSessionId.slice(0, 10)}` : latestScheduledExecution.traceId}
                  </div>
                </a>
              )}
            </div>
          )}
        </section>

        <section
          className="order-9 rounded-xl px-4 py-3"
          style={{ background: 'rgba(255,255,255,0.032)', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold text-white/78">
                <ShieldCheck size={15} /> 权限 / 组织治理
              </div>
              <div className="mt-1 text-xs text-white/42">
                {governanceDashboard
                  ? `${governanceDashboard.subject.teamCount} 个团队上下文 · ${governanceSummary?.passedGateCount ?? 0}/${governanceSummary?.totalGateCount ?? 0} gates`
                  : '等待治理边界指标'}
              </div>
            </div>
            <div className={`rounded px-2 py-1 text-xs ${governanceProfileGate?.status === 'warn' ? 'text-amber-100/80' : 'text-emerald-100/80'}`} style={{ background: governanceProfileGate?.status === 'warn' ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)' }}>
              profile {governanceProfileGate?.status ?? 'unknown'}
            </div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {[
              { label: '团队', value: governanceDashboard?.subject.teamCount ?? 0, hint: governanceDashboard?.subject.teamIds.slice(0, 2).join(' / ') || '当前用户上下文' },
              { label: '工作流', value: governanceSummary?.ownedWorkflowCount ?? 0, hint: 'owner scoped' },
              { label: '知识库', value: governanceSummary?.ownedKnowledgeBaseCount ?? 0, hint: `${governanceSummary?.publicKnowledgeBaseCount ?? 0} public readable` },
              { label: 'Profile', value: `${governanceSummary?.ownedRuntimeProfileCount ?? 0}/${governanceSummary?.runtimeProfileCount ?? 0}`, hint: `${governanceSummary?.teamSharedRuntimeProfileCount ?? 0} team shared` },
              { label: '审批', value: governanceSummary?.waitingApprovalExecutionCount ?? 0, hint: `${governanceSummary?.writablePolicySessionCount ?? 0} writable sessions` },
            ].map((item) => (
              <div
                key={item.label}
                className="min-h-[72px] rounded-lg px-3 py-2"
                style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.06)' }}
              >
                <div className="text-xs text-white/42">{item.label}</div>
                <div className="mt-1 truncate text-xl font-semibold leading-tight text-white/84">{item.value}</div>
                <div className="mt-1 truncate text-xs text-white/38">{item.hint}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {(governanceDashboard?.scopes ?? []).slice(0, 4).map((scope) => (
              <div
                key={scope.area}
                className="min-w-0 rounded-lg px-3 py-2"
                style={{ background: 'rgba(15,23,42,0.36)', border: '1px solid rgba(148,163,184,0.12)' }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-white/70">{scope.area}</span>
                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-cyan-100/70" style={{ background: 'rgba(56,189,248,0.1)' }}>{scope.state}</span>
                </div>
                <div className="mt-1 truncate text-xs text-white/42">{scope.evidence}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2 lg:grid-cols-3">
            {governanceOwnerPolicies.map((policy) => (
              <a
                key={policy.area}
                href={policy.path}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 rounded-lg px-3 py-2 transition-colors hover:bg-white/[0.04]"
                style={{ background: 'rgba(2,6,23,0.28)', border: '1px solid rgba(148,163,184,0.12)' }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold text-white/72">{policy.label}</span>
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-sky-100/72"
                    style={{ background: 'rgba(56,189,248,0.1)' }}
                  >
                    {policy.state}
                  </span>
                </div>
                <div className="mt-2 grid grid-cols-[54px_1fr] gap-x-2 gap-y-1 text-xs">
                  <span className="text-white/34">Owner</span>
                  <span className="truncate text-white/64">{policy.owner}</span>
                  <span className="text-white/34">Scope</span>
                  <span className="truncate text-white/54">{policy.subject}</span>
                </div>
                <div className="mt-2 line-clamp-2 text-xs leading-relaxed text-white/42">{policy.evidence}</div>
                <div className="mt-2 truncate text-[11px] text-amber-100/60">{policy.nextAction}</div>
              </a>
            ))}
          </div>
          {governanceDashboard?.nextActions?.[0] && (
            <div className="mt-3 truncate rounded-lg px-3 py-2 text-xs text-amber-100/70" style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.14)' }}>
              {governanceDashboard.nextActions[0]}
            </div>
          )}
        </section>

        <div className="order-10">
          {executionRunway}
        </div>

        {activeSession && (
          <section
            className="order-11 rounded-xl px-4 py-3"
            style={{ background: 'rgba(255,255,255,0.032)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-white/78">审计摘要</div>
                <div className="mt-1 text-xs text-white/42">trace {activeSession.traceId}</div>
              </div>
              <div className="text-xs text-white/42">
                创建 {formatTime(activeSession.createdAt)} · 更新 {formatTime(activeSession.updatedAt)}
              </div>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {auditRows.map(([label, value]) => (
                <div key={label} className="min-w-0 rounded-lg px-3 py-2" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="text-xs text-white/38">{label}</div>
                  <div className="mt-1 truncate text-xs text-white/68">{value}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section id="pro-workbench" className="order-3 grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.09)' }}>
            <div className="space-y-3">
              <label className="block space-y-1">
                <span className="text-xs text-white/45">CDS 连接</span>
                <select
                  value={draft.connectionId}
                  onChange={(e) => setDraft((prev) => ({ ...prev, connectionId: e.target.value }))}
                  className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                  style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                >
                  <option value="">未选择</option>
                  {connections.map((item) => (
                    <option key={item.id} value={item.id}>{item.partnerName || item.partnerId}</option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-white/45">模型配置</span>
                <select
                  value={draft.runtimeProfileId}
                  onChange={(e) => setDraft((prev) => ({ ...prev, runtimeProfileId: e.target.value }))}
                  className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                  style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                >
                  <option value="">未选择</option>
                  {profiles.map((item) => (
                    <option key={item.id} value={item.id}>{profileLabel(item)}</option>
                  ))}
                </select>
              </label>
              <div className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="text-xs text-white/45">当前模型</div>
                <div className="mt-1 break-words text-sm text-white/75">{profileSummary(activeProfile)}</div>
                <div className="mt-1 break-words text-xs text-white/50">资源边界: {formatResourcePolicy(activeProfile)}</div>
                <div className="mt-2 rounded-md px-2 py-1 text-xs leading-relaxed text-white/45" style={{ background: 'rgba(255,255,255,0.04)' }}>
                  支持任意兼容服务：填入 baseUrl、model 和 provider secret 后保存为系统级配置，后续会话复用，不按 10 分钟过期。
                </div>
                {activeProfileBlockReason && (
                  <div className="mt-2 rounded-md px-2 py-2 text-xs leading-relaxed text-amber-100/85" style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.26)' }}>
                    {activeProfileBlockReason}
                    <button
                      type="button"
                      onClick={() => void importDefaultProfile()}
                      disabled={busy}
                      className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs"
                      style={{ background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.34)', color: 'rgba(253,230,138,0.95)' }}
                    >
                      {busy ? <MapSpinner size={12} /> : <Server size={12} />} 同步系统主模型
                    </button>
                  </div>
                )}
                {r1RepairNeedsAttention && (
                  <div className="mt-2 rounded-md px-2 py-2 text-xs leading-relaxed text-amber-100/82" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.22)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="inline-flex items-center gap-1.5 font-semibold text-amber-100/90">
                        <KeyRound size={12} /> R1 默认 Claude profile
                      </div>
                      <span className="rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-normal text-amber-100/70" style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.18)' }}>
                        {r1RepairPlan.source}
                      </span>
                    </div>
                    <div className="mt-1 break-words text-amber-50/72">
                      当前: {r1RepairCurrentLabel}
                    </div>
                    <div className="mt-1 break-words text-amber-50/72">
                      目标: {r1RepairTargetLabel}
                    </div>
                    {r1RepairPlan.nextActions.length > 0 && (
                      <ul className="mt-2 space-y-1 text-amber-50/66">
                        {r1RepairPlan.nextActions.slice(0, 3).map((item) => (
                          <li key={item} className="break-words">- {item}</li>
                        ))}
                      </ul>
                    )}
                    <button
                      type="button"
                      onClick={() => void importDefaultProfile()}
                      disabled={busy}
                      className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs disabled:opacity-45"
                      style={{ background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.34)', color: 'rgba(253,230,138,0.95)' }}
                    >
                      {busy ? <MapSpinner size={12} /> : <KeyRound size={12} />} 同步系统主模型
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void testProfile()}
                  disabled={!activeProfile || testingProfile || !activeProfile.hasApiKey}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs disabled:opacity-45"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  {testingProfile ? <MapSpinner size={13} /> : <RefreshCw size={13} />} 测试模型
                </button>
                <button
                  type="button"
                  onClick={() => void importDefaultProfile()}
                  disabled={busy}
                  className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs disabled:opacity-45"
                  style={{ background: 'rgba(99,179,237,0.12)', border: '1px solid rgba(99,179,237,0.28)', color: 'rgba(186,230,253,0.92)' }}
                >
                  {busy ? <MapSpinner size={13} /> : <Download size={13} />} 从系统主模型同步
                </button>
                {profileTest && <div className="mt-2 break-words text-xs leading-relaxed text-white/55">{profileTest}</div>}
              </div>
              <div className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="inline-flex items-center gap-2 text-xs font-semibold text-white/65">
                  <GitCompare size={13} /> 目标代码仓库
                </div>
                <div className="mt-2 grid gap-2">
                  <input
                    value={draft.gitRepository}
                    onChange={(e) => setDraft((prev) => ({ ...prev, gitRepository: e.target.value }))}
                    className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                    placeholder="GitHub 仓库，例如 inernoro/prd_agent"
                  />
                  <input
                    value={draft.gitRef}
                    onChange={(e) => setDraft((prev) => ({ ...prev, gitRef: e.target.value }))}
                    className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                    placeholder="分支或 ref，例如 main"
                  />
                  <input
                    value={draft.workspaceRoot}
                    onChange={(e) => setDraft((prev) => ({ ...prev, workspaceRoot: e.target.value }))}
                    className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                    placeholder="可选：sidecar 内 workspace 绝对路径"
                  />
                </div>
                <div className="mt-2 text-xs leading-relaxed text-white/42">
                  留空时沿用 CDS sidecar 默认工作区。填写 workspaceRoot 后会作为官方 SDK cwd 下发，并在 runtime_init 事件里回显，方便审计“到底审了哪个仓库”。
                </div>
              </div>
              <details className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <summary className="cursor-pointer select-none text-xs font-semibold text-white/62">
                  <ShieldCheck size={13} /> 远程页面安全边界
                </summary>
                <div className="mt-2 text-xs leading-relaxed text-white/45">
                  `cds_bridge_snapshot` 只读查看远程浏览器，`cds_bridge_action` 统一走危险工具审批；navigate / spa-navigate 默认拦截 localhost、内网、链路本地和 metadata 地址，命中时返回 `bridge_url_blocked`。
                </div>
              </details>
              <details className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <summary className="cursor-pointer select-none text-xs font-semibold text-white/62">
                  <GitCompare size={13} /> Git 产物与 PR
                </summary>
                <div className="mt-2 text-xs leading-relaxed text-white/45">
                  `repo_git_status`、`repo_git_diff` 和 `repo_create_pull_request` 会把分支、diff、测试输出和 PR 链接沉淀到事件与产物面板；`repo_create_pull_request` 属于危险工具，默认需要人工审批后才会提交分支并创建 PR。
                </div>
              </details>
              <details open={Boolean(activeProfileBlockReason || r1DefaultProfileBlocked)} className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <summary className="cursor-pointer text-xs font-semibold text-white/60">保存新模型配置</summary>
                <div className="mt-3 grid gap-2">
                  <button
                    type="button"
                    onClick={() => void importDefaultProfile()}
                    disabled={busy}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs"
                    style={{ background: 'rgba(99,179,237,0.12)', border: '1px solid rgba(99,179,237,0.28)', color: 'rgba(186,230,253,0.92)' }}
                  >
                    {busy ? <MapSpinner size={13} /> : <Server size={13} />} 同步系统主模型
                  </button>
                  <input
                    value={profileDraft.name}
                    onChange={(e) => setProfileDraft((prev) => ({ ...prev, name: e.target.value }))}
                    className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                    placeholder="配置名称"
                  />
                  <select
                    value={profileDraft.runtime}
                    onChange={(e) => setProfileDraft((prev) => ({ ...prev, runtime: e.target.value }))}
                    className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                  >
                    <option value="claude-sdk">claude-sdk</option>
                    <option value="openai-compatible">openai-compatible</option>
                    <option value="codex">codex</option>
                    <option value="custom">custom</option>
                  </select>
                  <select
                    value={profileDraft.protocol}
                    onChange={(e) => setProfileDraft((prev) => ({
                      ...prev,
                      protocol: e.target.value,
                      baseUrl: e.target.value === 'openai-compatible' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com',
                    }))}
                    className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                  >
                    <option value="anthropic">Anthropic Messages</option>
                    <option value="openai-compatible">OpenAI-compatible Chat Completions</option>
                  </select>
                  <input
                    value={profileDraft.baseUrl}
                    onChange={(e) => setProfileDraft((prev) => ({ ...prev, baseUrl: e.target.value }))}
                    className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                    placeholder="https://api.anthropic.com"
                  />
                  <input
                    value={profileDraft.model}
                    onChange={(e) => setProfileDraft((prev) => ({ ...prev, model: e.target.value }))}
                    className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                    placeholder="model"
                  />
                  <input
                    value={profileDraft.apiKey}
                    onChange={(e) => setProfileDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
                    className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                    placeholder={profileDraft.protocol === 'anthropic' && profileDraft.baseUrl.includes('api.anthropic.com') ? 'Anthropic provider secret: sk-ant-...' : 'provider secret'}
                    type="password"
                  />
                  {canReuseActiveProfileSecret && (
                    <div className="text-xs leading-relaxed text-emerald-200/65">
                      留空会复用当前配置已加密保存的 provider secret；适合把 OpenRouter/DeepSeek profile 纠偏为 Claude Code provider-switch 形态。
                    </div>
                  )}
                  {matchingRuntimeProfileTemplate()?.id === ANTHROPIC_OFFICIAL_PROFILE_TEMPLATE_ID && (
                    <div className="text-xs leading-relaxed text-white/42">
                      这是原生 Anthropic 官方模板，只接受 `sk-ant-` provider secret。cc-switch/DeepSeek 自定义 key 可以用 `claude-sdk + anthropic protocol + 兼容 baseUrl`，不要套用此模板。
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={profileDraft.resourceCpuCores}
                      onChange={(e) => setProfileDraft((prev) => ({ ...prev, resourceCpuCores: Number(e.target.value) }))}
                      className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                      style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                      placeholder="CPU cores"
                      type="number"
                      min={0.25}
                      max={8}
                      step={0.25}
                    />
                    <input
                      value={profileDraft.resourceMemoryMb}
                      onChange={(e) => setProfileDraft((prev) => ({ ...prev, resourceMemoryMb: Number(e.target.value) }))}
                      className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                      style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                      placeholder="Memory MB"
                      type="number"
                      min={512}
                      max={32768}
                      step={256}
                    />
                    <input
                      value={profileDraft.timeoutSeconds}
                      onChange={(e) => setProfileDraft((prev) => ({ ...prev, timeoutSeconds: Number(e.target.value) }))}
                      className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                      style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                      placeholder="Timeout seconds"
                      type="number"
                      min={30}
                      max={7200}
                      step={30}
                    />
                    <input
                      value={profileDraft.autoCleanupMinutes}
                      onChange={(e) => setProfileDraft((prev) => ({ ...prev, autoCleanupMinutes: Number(e.target.value) }))}
                      className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                      style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                      placeholder="Cleanup minutes"
                      type="number"
                      min={5}
                      max={1440}
                      step={5}
                    />
                  </div>
                  <select
                    value={profileDraft.networkPolicy}
                    onChange={(e) => setProfileDraft((prev) => ({ ...prev, networkPolicy: e.target.value }))}
                    className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
                  >
                    <option value="restricted">受限网络</option>
                    <option value="egress-only">仅出站</option>
                    <option value="open">开放网络</option>
                  </select>
                  <label className="inline-flex items-center gap-2 text-xs text-white/55">
                    <input
                      type="checkbox"
                      checked={profileDraft.isDefault}
                      onChange={(e) => setProfileDraft((prev) => ({ ...prev, isDefault: e.target.checked }))}
                    />
                    设为默认
                  </label>
                  <button
                    type="button"
                    onClick={() => void saveProfile()}
                    disabled={busy || !profileDraft.baseUrl.trim() || !profileDraft.model.trim() || !profileDraft.apiKey.trim()}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs disabled:opacity-45"
                    style={{ background: 'rgba(99,179,237,0.15)', border: '1px solid rgba(99,179,237,0.32)', color: 'rgba(186,230,253,0.96)' }}
                  >
                    {busy ? <MapSpinner size={13} /> : <Plus size={13} />} 保存配置
                  </button>
                  <button
                    type="button"
                    onClick={() => void updateProfile()}
                    disabled={busy || !canUpdateActiveProfile}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs disabled:opacity-45"
                    style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                  >
                    {busy ? <MapSpinner size={13} /> : <RefreshCw size={13} />} 更新当前配置
                  </button>
                  <div className="text-xs leading-relaxed text-white/42">
                    更新会覆盖当前选中的系统级配置。provider secret 只保存加密值，不会回显；留空更新会保留当前密文，重新输入则替换。
                  </div>
                </div>
              </details>
              <input
                value={draft.title}
                onChange={(e) => setDraft((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="会话名称（留空自动从首条消息命名）"
                className="w-full rounded-md px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
                style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.12)' }}
              />
              <button
                type="button"
                onClick={() => void createSession()}
                disabled={busy || !canCreateSession}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-45"
                style={{ background: 'rgba(99,179,237,0.17)', border: '1px solid rgba(99,179,237,0.4)', color: 'rgba(186,230,253,0.96)' }}
              >
                {busy ? <MapSpinner size={14} /> : <Plus size={14} />} 新建远程会话
              </button>
            </div>

              <div className="mt-4 space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs font-semibold text-white/45">
                  <span>会话</span>
                  <span>{resumableCount} 个可继续</span>
                </div>
                <label className="flex items-center gap-2 rounded-md px-2 py-1.5" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <Search size={13} className="text-white/35" />
                  <input
                    value={sessionQuery}
                    onChange={(e) => setSessionQuery(e.target.value)}
                    className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-white/32"
                    placeholder="搜索标题、模型、状态或错误"
                  />
                </label>
              {sessions.length === 0 ? (
                <div className="rounded-lg px-3 py-8 text-center text-sm text-white/40" style={{ background: 'rgba(0,0,0,0.16)' }}>
                  先保存并测试模型配置，再新建远程会话。
                </div>
              ) : visibleSessions.length === 0 ? (
                <div className="rounded-lg px-3 py-8 text-center text-sm text-white/40" style={{ background: 'rgba(0,0,0,0.16)' }}>
                  没有匹配的会话。
                </div>
              ) : (
                visibleSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => setActiveSessionId(session.id)}
                    className="block w-full rounded-lg px-3 py-2 text-left"
                    style={{
                      background: activeSession?.id === session.id ? 'rgba(99,179,237,0.14)' : 'rgba(0,0,0,0.16)',
                      border: activeSession?.id === session.id ? '1px solid rgba(99,179,237,0.35)' : '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div className="truncate text-sm font-medium text-white/85">{session.title}</div>
                    <div className="mt-1 text-xs text-white/45">{statusLabel(resolveSessionRuntimeState(session, nowTick).effectiveStatus)} · {session.model ?? '未配置模型'}</div>
                    {(session.gitRepository || session.gitRef || session.workspaceRoot) && (
                      <div className="mt-1 truncate text-[11px] text-white/35">
                        {session.gitRepository || session.cdsProjectId} · {session.gitRef || 'ref 未指定'} · {session.workspaceRoot || '默认 workspace'}
                      </div>
                    )}
                    {(session.runtimeAdapter || session.currentRuntimeRunId) && (
                      <div className="mt-1 truncate text-[11px] text-white/35">
                        {session.runtimeAdapter ?? 'runtime adapter 未上报'} · {shortId(session.currentRuntimeRunId)}
                      </div>
                    )}
                    {session.lastError && <div className="mt-1 line-clamp-2 text-xs text-red-200/65">{session.lastError}</div>}
                  </button>
                ))
              )}
            </div>
          </aside>

          <main className="flex min-h-[720px] flex-col rounded-xl" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.09)' }}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-white/90">{activeSession?.title ?? '未选择会话'}</div>
                <div className="mt-1 text-xs text-white/45">
                  {activeSession ? `${statusLabel(activeSessionEffectiveStatus)} · ${activeSession.runtime} · ${runtimeDiagnostics.adapter} · ${activeSession.modelBaseUrl ?? activeProfile?.baseUrl ?? '未配置 baseUrl'} · trace ${activeSession.traceId}` : '选择或新建一个远程会话'}
                </div>
                {activeSession && primaryActionHint(activeSessionEffectiveStatus) && (
                  <div className="mt-1 text-xs text-white/40">{primaryActionHint(activeSessionEffectiveStatus)}</div>
                )}
                {activeRuntimePoolBlockReason && (
                  <div className="mt-1 max-w-[760px] text-xs leading-relaxed text-amber-100/75">
                    {activeRuntimePoolBlockReason}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void startSession()} disabled={!activeSession || busy || !canStartActiveSession} className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm disabled:opacity-45" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: 'rgba(134,239,172,0.95)' }}>
                  <Play size={13} /> {activeSession ? primaryActionLabel(activeSessionEffectiveStatus) : '启动'}
                </button>
                <button
                  type="button"
                  onClick={() => void toggleManualTakeover(!activeSession?.manualTakeoverEnabled)}
                  disabled={!activeSession || busy}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm disabled:opacity-45"
                  style={{ background: activeSession?.manualTakeoverEnabled ? 'rgba(99,179,237,0.14)' : 'rgba(255,255,255,0.05)', border: activeSession?.manualTakeoverEnabled ? '1px solid rgba(99,179,237,0.35)' : '1px solid rgba(255,255,255,0.1)', color: activeSession?.manualTakeoverEnabled ? 'rgba(186,230,253,0.96)' : 'rgba(255,255,255,0.68)' }}
                >
                  {activeSession?.manualTakeoverEnabled ? <UserCheck size={13} /> : <PauseCircle size={13} />}
                  {activeSession?.manualTakeoverEnabled ? '恢复 Agent' : '人工接管'}
                </button>
                <button type="button" onClick={() => void stopSession()} disabled={!activeSession || busy} className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm disabled:opacity-45" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(252,165,165,0.95)' }}>
                  <Square size={13} /> 停止
                </button>
                <button type="button" onClick={() => void archiveSession()} disabled={!activeSession || busy || activeSession.status === 'running' || activeSession.status === 'creating' || activeSession.status === 'stopping'} className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm disabled:opacity-45" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.68)' }}>
                  <Archive size={13} /> 归档
                </button>
              </div>
            </div>

            <div className="grid flex-1 gap-3 p-4 xl:grid-cols-[minmax(0,1fr)_420px]">
	              <section className="flex min-h-0 flex-col gap-3">
	                {activeSession && (
	                  <div className="order-1 rounded-lg p-3" style={{ background: activeSession.manualTakeoverEnabled ? 'rgba(99,179,237,0.1)' : 'rgba(0,0,0,0.14)', border: activeSession.manualTakeoverEnabled ? '1px solid rgba(99,179,237,0.28)' : '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="inline-flex items-center gap-2 text-sm font-semibold text-white/76">
                          {activeSession.manualTakeoverEnabled ? <UserCheck size={14} /> : <PauseCircle size={14} />}
                          {activeSession.manualTakeoverEnabled ? '人工接管中' : 'Agent 自动执行中'}
                        </div>
                        <div className="mt-1 text-xs leading-relaxed text-white/45">
                          {activeSession.manualTakeoverEnabled
                            ? '发送框只记录人工输入，不会调用模型；工具审批、日志和事件仍可继续操作并持久化。'
                            : '需要检查远程页面或临时暂停自动发送时，可以开启人工接管。'}
                        </div>
                      </div>
                      <input
                        value={manualReason}
                        onChange={(e) => setManualReason(e.target.value)}
                        disabled={activeSession.manualTakeoverEnabled}
                        className="min-w-[220px] flex-1 rounded-md px-3 py-2 text-xs text-white outline-none disabled:opacity-60"
                        style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.09)' }}
                        placeholder="接管原因"
                      />
                    </div>
                  </div>
                )}
	                <details id="pro-runtime-diagnostics" className="order-5 rounded-lg p-3" style={{ background: 'rgba(15,23,42,0.82)', border: '1px solid rgba(148,163,184,0.16)' }}>
                  <summary className="cursor-pointer select-none text-sm font-semibold text-white/70">
                    Runtime / 门禁 / 调试诊断
                  </summary>
                  <div className="mt-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="inline-flex items-center gap-2 text-sm font-semibold text-white/76">
                          <Server size={14} />
                          Runtime 调试
                        </div>
                        <div className="mt-1 text-xs leading-relaxed text-white/42">
                          {activeSession
                            ? '当前显示的是后端实际记录的 adapter、run id、实例和取消能力；`Legacy fallback` 表示还未切到官方 SDK adapter。'
                            : '选择或创建会话后，这里会显示真实 adapter、run id、实例和取消能力。'}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void copyText('Runtime 诊断包', JSON.stringify(runtimeDiagnosticBundle, null, 2))}
                          className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-white/58 hover:text-white/86"
                          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                        >
                          <Copy size={12} /> 复制诊断包
                        </button>
                        <button
                          type="button"
                          onClick={() => void downloadRunBundle()}
                          className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-white/58 hover:text-white/86"
                          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                        >
                          <Download size={12} /> 导出 run bundle
                        </button>
                        <span
                          className="inline-flex min-h-7 items-center rounded-md px-2 text-xs font-medium"
                          style={{
                            background: runtimeDiagnostics.adapterMode === 'Official SDK adapter' ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)',
                            border: runtimeDiagnostics.adapterMode === 'Official SDK adapter' ? '1px solid rgba(34,197,94,0.26)' : '1px solid rgba(245,158,11,0.26)',
                            color: runtimeDiagnostics.adapterMode === 'Official SDK adapter' ? 'rgba(134,239,172,0.92)' : 'rgba(253,230,138,0.92)',
                          }}
                        >
                          {runtimeDiagnostics.adapterMode}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {runtimeDiagnostics.rows.map(([label, value]) => (
                        <div
                          key={label}
                          className="min-h-[58px] rounded-md px-3 py-2"
                          style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid rgba(255,255,255,0.07)' }}
                        >
                          <div className="text-[11px] font-semibold text-white/38">{label}</div>
                          <div className="mt-1 break-all text-xs leading-relaxed text-white/72">{value}</div>
                        </div>
                      ))}
                    </div>
                    <div
                      className="mt-3 rounded-md px-3 py-3"
                      style={{
                        background: runtimeDiagnostics.commercialState === 'commercial-ready'
                          ? 'rgba(20,83,45,0.22)'
                          : 'rgba(113,63,18,0.2)',
                        border: runtimeDiagnostics.commercialState === 'commercial-ready'
                          ? '1px solid rgba(34,197,94,0.24)'
                          : '1px solid rgba(245,158,11,0.22)',
                      }}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-white/48">
                            <ListChecks size={13} />
                            当前执行结论
                          </div>
                          <div className="mt-1 text-sm font-semibold text-white/82">
                            {runtimeDiagnostics.commercialState === 'commercial-ready'
                              ? '商业级门禁已通过'
                              : `${runtimeDiagnostics.commercialBlockingCode || 'Gate'} 阻塞`}
                          </div>
                          <div className="mt-1 max-w-4xl text-xs leading-relaxed text-white/58">
                            {runtimeDiagnostics.commercialNextAction}
                          </div>
                          <div className="mt-2 inline-flex max-w-4xl items-start gap-2 rounded-md px-2 py-1.5 text-xs leading-relaxed text-white/64" style={{ background: 'rgba(15,23,42,0.54)', border: '1px solid rgba(148,163,184,0.14)' }}>
                            <GitPullRequest size={13} className="mt-0.5 shrink-0 text-white/42" />
                            <span>{runtimeDiagnostics.commercialDeploymentAdvice}</span>
                          </div>
                        </div>
                        <div className="grid min-w-[220px] gap-1 text-right text-xs text-white/58">
                          <div>{runtimeDiagnostics.commercialPassed}/{runtimeDiagnostics.commercialTotal} gates passed</div>
                          <div>{runtimeDiagnostics.commercialPending.length} pending gates</div>
                          <div>{runtimeDiagnostics.commercialState}</div>
                          {runtimeDiagnostics.executionStepTotal > 0 && (
                            <div>
                              cycle {runtimeDiagnostics.executionPassedSteps}/{runtimeDiagnostics.executionStepTotal} · 当前 {runtimeDiagnostics.executionStepIndex}/{runtimeDiagnostics.executionStepTotal}
                            </div>
                          )}
                          {runtimeDiagnostics.executionGateCounts && (
                            <div className="mt-2 flex max-w-[260px] flex-wrap justify-end gap-1 justify-self-end">
                              {(['pass', 'pending', 'failed', 'unknown'] as const).map((key) => {
                                const count = runtimeDiagnostics.executionGateCounts?.[key] ?? 0;
                                if (count <= 0) return null;
                                const tone = key === 'pass'
                                  ? 'rgba(34,197,94,0.16)'
                                  : key === 'failed'
                                    ? 'rgba(239,68,68,0.16)'
                                    : key === 'pending'
                                      ? 'rgba(245,158,11,0.16)'
                                      : 'rgba(148,163,184,0.12)';
                                const textTone = key === 'pass'
                                  ? 'rgba(134,239,172,0.92)'
                                  : key === 'failed'
                                    ? 'rgba(254,202,202,0.92)'
                                    : key === 'pending'
                                      ? 'rgba(253,230,138,0.92)'
                                      : 'rgba(203,213,225,0.78)';
                                return (
                                  <span
                                    key={key}
                                    className="inline-flex min-h-6 items-center rounded px-1.5 text-[11px] font-semibold"
                                    style={{ background: tone, color: textTone, border: '1px solid rgba(255,255,255,0.08)' }}
                                  >
                                    {key} {count}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 md:grid-cols-3">
                        {[
                          {
                            label: '部署判定',
                            value: runtimeDiagnostics.executionRunway.deployLabel,
                            detail: runtimeDiagnostics.executionRunway.deployDecision === 'skip-deploy'
                              ? '当前阻塞不靠 build/deploy 解决。'
                              : runtimeDiagnostics.executionRunway.deployDecision === 'deploy-only-on-change'
                                ? '避免无代码变更时重复构建。'
                                : '先跑窄口径诊断命令。',
                          },
                          {
                            label: '命令性质',
                            value: runtimeDiagnostics.executionRunway.commandLabel,
                            detail: runtimeDiagnostics.executionRunway.commandKind === 'profile-dry-run'
                              ? '只读预检，不写默认 profile。'
                              : runtimeDiagnostics.executionRunway.commandKind === 'profile-repair'
                                ? '先测候选 profile，通过后再提升默认。'
                                : runtimeDiagnostics.executionRunway.commandKind === 'runtime-pool-evidence'
                                  ? '只读采集 runtime pool 恢复证据。'
                                : runtimeDiagnostics.executionRunway.commandKind === 'provider-cycle'
                                  ? '完整闭环，受 provider opt-in 保护。'
                                  : runtimeDiagnostics.executionRunway.commandKind === 'doctor'
                                    ? '只读检查 runtime pool 和 profile。'
                                    : '用于收敛当前门禁证据。',
                          },
                          {
                            label: 'Provider 调用',
                            value: runtimeDiagnostics.executionRunway.providerCallLabel,
                            detail: runtimeDiagnostics.executionRunway.providerCallRisk === 'requires-explicit-opt-in'
                              ? '命令里必须显式设置 SMOKE_CDS_AGENT_ALLOW_PROVIDER_CALL=1。'
                              : '适合先在本地/远程快速确认方向。',
                          },
                        ].map((item) => (
                          <div
                            key={item.label}
                            className="min-h-[74px] rounded-md px-3 py-2"
                            style={{ background: 'rgba(15,23,42,0.48)', border: '1px solid rgba(148,163,184,0.14)' }}
                          >
                            <div className="text-[11px] font-semibold text-white/40">{item.label}</div>
                            <div className="mt-1 text-xs font-semibold text-white/78">{item.value}</div>
                            <div className="mt-1 text-xs leading-relaxed text-white/46">{item.detail}</div>
                          </div>
                        ))}
                      </div>
                      {runtimeDiagnostics.commercialNextCommand && (
                        <div className="mt-3 flex items-start gap-2">
                          <code className="min-w-0 flex-1 break-all rounded px-2 py-1.5 text-[11px] leading-relaxed text-amber-50/78" style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.07)' }}>
                            {runtimeDiagnostics.commercialNextCommand}
                          </code>
                          <button
                            type="button"
                            onClick={() => void copyText('当前下一步命令', runtimeDiagnostics.commercialNextCommand)}
                            className="shrink-0 rounded p-1.5 text-white/46 hover:text-white/86"
                            aria-label="复制当前下一步命令"
                          >
                            <Copy size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                    {runtimeDiagnostics.executionTaskBoard.length > 0 && (
                      <div className="mt-3 rounded-md px-3 py-3" style={{ background: 'rgba(8,13,28,0.46)', border: '1px solid rgba(125,211,252,0.16)' }}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-sky-100/58">
                              <ListChecks size={13} />
                              任务纵览与 ETA
                            </div>
                            <div className="mt-1 text-xs leading-relaxed text-white/48">
                              后端 runtime-status 汇总的当前周期看板；用于判断已完成、当前卡点和下一步耗时。
                            </div>
                          </div>
                          <span className="inline-flex min-h-7 items-center rounded-md px-2 text-xs font-semibold text-sky-100/78" style={{ background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.2)' }}>
                            {runtimeDiagnostics.executionTaskBoard.filter((item) => item.status === 'done').length}/{runtimeDiagnostics.executionTaskBoard.length}
                          </span>
                        </div>
                        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                          {runtimeDiagnostics.executionTaskBoard.map((item) => {
                            const isDone = item.status === 'done';
                            const isActive = item.status === 'active' || item.status === 'next';
                            const isBlocked = item.status === 'blocked';
                            const border = isDone
                              ? '1px solid rgba(34,197,94,0.2)'
                              : isActive
                                ? '1px solid rgba(56,189,248,0.24)'
                                : isBlocked
                                  ? '1px solid rgba(245,158,11,0.22)'
                                  : '1px solid rgba(148,163,184,0.14)';
                            const background = isDone
                              ? 'rgba(34,197,94,0.07)'
                              : isActive
                                ? 'rgba(14,165,233,0.09)'
                                : isBlocked
                                  ? 'rgba(245,158,11,0.08)'
                                  : 'rgba(15,23,42,0.62)';
                            return (
                              <div key={item.code} className="min-h-[136px] rounded-md px-3 py-2" style={{ background, border }}>
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="text-[11px] font-semibold text-white/40">
                                      {item.order}. {item.code}
                                    </div>
                                    <div className="mt-0.5 text-xs font-semibold text-white/78">{item.title}</div>
                                  </div>
                                  <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{
                                    background: isDone ? 'rgba(34,197,94,0.14)' : isActive ? 'rgba(56,189,248,0.14)' : isBlocked ? 'rgba(245,158,11,0.14)' : 'rgba(148,163,184,0.1)',
                                    color: isDone ? 'rgba(134,239,172,0.92)' : isActive ? 'rgba(186,230,253,0.9)' : isBlocked ? 'rgba(253,230,138,0.9)' : 'rgba(203,213,225,0.76)',
                                  }}>
                                    {item.status.toUpperCase()}
                                  </span>
                                </div>
                                <div className="mt-2 rounded px-2 py-1 text-[11px] font-semibold text-sky-50/74" style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.12)' }}>
                                  ETA · {item.estimatedDuration}
                                </div>
                                <div className="mt-2 line-clamp-2 text-xs leading-relaxed text-white/56">{item.nextAction}</div>
                                <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/38">{item.evidence}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {runtimeDiagnostics.executionRunbook.length > 0 && (
                      <div className="mt-3 rounded-md px-3 py-3" style={{ background: 'rgba(2,6,23,0.34)', border: '1px solid rgba(148,163,184,0.16)' }}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-white/46">
                              <Route size={13} />
                              执行 runbook
                            </div>
                            <div className="mt-1 text-xs leading-relaxed text-white/48">
                              后端 runtime-status 生成的机器可读步骤；标明只读、删除、部署和 provider 调用边界。
                            </div>
                          </div>
                          <span className="inline-flex min-h-7 items-center rounded-md px-2 text-xs font-semibold text-white/58" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                            {runtimeDiagnostics.executionRunbook.filter((item) => item.status === 'pass').length}/{runtimeDiagnostics.executionRunbook.length}
                          </span>
                        </div>
                        <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                          {runtimeDiagnostics.executionRunbook.map((item) => {
                            const isActive = item.status === 'active';
                            const isBlocked = item.status === 'blocked';
                            const isPass = item.status === 'pass';
                            const isDestructive = item.safety.includes('destructive');
                            const isProvider = item.safety.includes('provider');
                            const border = isActive
                              ? '1px solid rgba(56,189,248,0.28)'
                              : isBlocked || isDestructive
                                ? '1px solid rgba(245,158,11,0.22)'
                                : isPass
                                  ? '1px solid rgba(34,197,94,0.2)'
                                  : '1px solid rgba(148,163,184,0.14)';
                            const background = isActive
                              ? 'rgba(14,165,233,0.1)'
                              : isBlocked || isDestructive
                                ? 'rgba(245,158,11,0.08)'
                                : isPass
                                  ? 'rgba(34,197,94,0.07)'
                                  : 'rgba(15,23,42,0.62)';
                            return (
                              <div
                                key={item.code}
                                className="min-h-[126px] rounded-md px-3 py-2"
                                style={{ background, border }}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="text-[11px] font-semibold text-white/40">
                                      {item.order}. {item.code}
                                    </div>
                                    <div className="mt-0.5 text-xs font-semibold text-white/76">{item.title}</div>
                                  </div>
                                  <span
                                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold"
                                    style={{
                                      background: isActive ? 'rgba(56,189,248,0.14)' : isBlocked || isDestructive ? 'rgba(245,158,11,0.14)' : isPass ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.1)',
                                      color: isActive ? 'rgba(186,230,253,0.92)' : isBlocked || isDestructive ? 'rgba(253,230,138,0.9)' : isPass ? 'rgba(134,239,172,0.9)' : 'rgba(203,213,225,0.76)',
                                    }}
                                  >
                                    {item.status.toUpperCase()}
                                  </span>
                                </div>
                                {item.blockedBy && (
                                  <div className="mt-2 inline-flex max-w-full rounded px-1.5 py-0.5 text-[11px] font-semibold text-amber-50/82" style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.18)' }}>
                                    <span className="truncate">blocked by {item.blockedBy}</span>
                                  </div>
                                )}
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-sky-50/70" style={{ background: 'rgba(56,189,248,0.09)', border: '1px solid rgba(56,189,248,0.16)' }}>
                                    {item.commandCode}
                                  </span>
                                  {(isDestructive || isProvider) && (
                                    <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-amber-50/78" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.18)' }}>
                                      {isDestructive ? 'requires approval' : 'provider opt-in'}
                                    </span>
                                  )}
                                </div>
                                <div className="mt-2 line-clamp-3 text-xs leading-relaxed text-white/46">{item.safety}</div>
                                {item.applyManifest && (
                                  <div className="mt-2 space-y-1 rounded px-2 py-1.5 text-[11px] leading-relaxed text-white/46" style={{ background: 'rgba(2,6,23,0.32)', border: '1px solid rgba(245,158,11,0.14)' }}>
                                    <div className="font-semibold text-amber-50/72">
                                      {item.applyManifest.method} · {item.applyManifest.safety}
                                    </div>
                                    <div className="truncate text-white/42">{item.applyManifest.endpoint}</div>
                                    <div className="flex flex-wrap gap-1">
                                      {(item.applyManifest.preconditions ?? []).map((condition) => (
                                        <span
                                          key={condition.code}
                                          className="rounded px-1.5 py-0.5 font-semibold"
                                          style={{
                                            background: condition.passed ? 'rgba(34,197,94,0.1)' : 'rgba(245,158,11,0.1)',
                                            color: condition.passed ? 'rgba(134,239,172,0.85)' : 'rgba(253,230,138,0.85)',
                                          }}
                                        >
                                          {condition.code}:{condition.passed ? 'pass' : 'wait'}
                                        </span>
                                      ))}
                                    </div>
                                    {item.applyManifest.localPreflightCommand && (
                                      <div className="truncate text-white/42">
                                        preflight: {item.applyManifest.localPreflightCommand}
                                      </div>
                                    )}
                                    {!!item.applyManifest.reportFields?.length && (
                                      <div className="flex flex-wrap gap-1">
                                        {item.applyManifest.reportFields.slice(0, 6).map((field) => (
                                          <span key={field} className="rounded px-1.5 py-0.5 font-semibold text-sky-50/66" style={{ background: 'rgba(56,189,248,0.08)' }}>
                                            {field}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div className="mt-3 rounded-md px-3 py-3" style={{ background: 'rgba(2,6,23,0.34)', border: '1px solid rgba(148,163,184,0.16)' }}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-white/46">
                            <ShieldCheck size={13} />
                            商业级 readiness ledger
                          </div>
                          <div className="mt-1 text-xs leading-relaxed text-white/48">
                            与 smoke-cds-agent-commercial-readiness.sh 同口径；未全绿时不能宣称上手即用。
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="inline-flex min-h-7 items-center rounded-md px-2 text-xs font-semibold"
                            style={{
                              background: runtimeDiagnostics.commercialState === 'commercial-ready' ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)',
                              border: runtimeDiagnostics.commercialState === 'commercial-ready' ? '1px solid rgba(34,197,94,0.24)' : '1px solid rgba(245,158,11,0.22)',
                              color: runtimeDiagnostics.commercialState === 'commercial-ready' ? 'rgba(134,239,172,0.92)' : 'rgba(253,230,138,0.92)',
                            }}
                          >
                            {runtimeDiagnostics.commercialPassed}/{runtimeDiagnostics.commercialTotal} passed
                          </span>
                          <span className="inline-flex min-h-7 items-center rounded-md px-2 text-xs font-medium text-white/54" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                            {runtimeDiagnostics.commercialState === 'commercial-ready'
                              ? 'ready'
                              : runtimeDiagnostics.commercialState === 'provider-smokes-required'
                              ? '需要 S1/S2/S3'
                              : 'R1 profile 阻塞'}
                          </span>
                        </div>
                      </div>
                      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                        {runtimeDiagnostics.commercialReadinessGates.map((gate) => {
                          const isPass = gate.state === 'pass';
                          const isWarn = gate.state === 'warn';
                          return (
                            <div
                              key={gate.code}
                              className="min-h-[112px] rounded-md px-3 py-2"
                              style={{
                                background: isPass ? 'rgba(34,197,94,0.08)' : isWarn ? 'rgba(245,158,11,0.09)' : 'rgba(15,23,42,0.72)',
                                border: isPass ? '1px solid rgba(34,197,94,0.22)' : isWarn ? '1px solid rgba(245,158,11,0.22)' : '1px solid rgba(148,163,184,0.14)',
                              }}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="text-[11px] font-semibold text-white/42">{gate.code}</div>
                                  <div className="mt-0.5 text-xs font-semibold text-white/74">{gate.label}</div>
                                </div>
                                <span
                                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold"
                                  style={{
                                    background: isPass ? 'rgba(34,197,94,0.14)' : isWarn ? 'rgba(245,158,11,0.14)' : 'rgba(148,163,184,0.1)',
                                    color: isPass ? 'rgba(134,239,172,0.92)' : isWarn ? 'rgba(253,230,138,0.92)' : 'rgba(203,213,225,0.76)',
                                  }}
                                >
                                  {isPass ? 'PASS' : isWarn ? 'ACTION' : 'WAIT'}
                                </span>
                              </div>
                              <div className="mt-2 break-words text-xs font-medium text-white/82">{gate.value}</div>
                              {gate.reasonCode && (
                                <div className="mt-1 inline-flex max-w-full rounded px-1.5 py-0.5 text-[11px] font-semibold text-amber-50/82" style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.18)' }}>
                                  <span className="truncate">{gate.reasonCode}</span>
                                </div>
                              )}
                              <div className="mt-1 line-clamp-3 text-xs leading-relaxed text-white/46">{gate.detail}</div>
                            </div>
                          );
                        })}
                      </div>
                      {runtimeDiagnostics.commercialPending.length > 0 && (
                        <div className="mt-3 rounded-md px-3 py-2" style={{ background: 'rgba(245,158,11,0.09)', border: '1px solid rgba(245,158,11,0.2)' }}>
                          <div className="text-[11px] font-semibold uppercase tracking-normal text-amber-100/60">未关闭门禁</div>
                          <div className="mt-1 grid gap-1 md:grid-cols-2">
                            {runtimeDiagnostics.commercialPending.map((gate) => (
                              <div key={gate.code} className="text-xs leading-relaxed text-amber-50/76">
                                {gate.code} · {gate.reasonCode ? `${gate.reasonCode} · ` : ''}{gate.detail}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    {runtimeDiagnostics.nextCyclePlan && (
                      <div className="mt-3 rounded-md px-3 py-3" style={{ background: 'rgba(8,13,28,0.5)', border: '1px solid rgba(125,211,252,0.16)' }}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-sky-100/58">
                              <ListChecks size={13} />
                              下一周期最小闭环
                            </div>
                            <div className="mt-1 break-words text-xs leading-relaxed text-white/48">
                              {runtimeDiagnostics.nextCyclePlan.cycle} · {runtimeDiagnostics.nextCyclePlan.state}
                            </div>
                          </div>
                          <span className="inline-flex min-h-7 items-center rounded-md px-2 text-xs font-semibold text-sky-100/78" style={{ background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.2)' }}>
                            {runtimeDiagnostics.nextCyclePlan.items.filter((item) => item.status === 'pass').length}/{runtimeDiagnostics.nextCyclePlan.items.length}
                          </span>
                        </div>
                        <div className="mt-3 grid gap-2 lg:grid-cols-2">
                          {runtimeDiagnostics.nextCyclePlan.items.map((item) => {
                            const isPass = item.status === 'pass';
                            const isBlocked = item.status === 'blocked';
                            return (
                              <div
                                key={item.code}
                                className="min-h-[126px] rounded-md px-3 py-2"
                                style={{
                                  background: isPass ? 'rgba(34,197,94,0.08)' : isBlocked ? 'rgba(245,158,11,0.09)' : 'rgba(15,23,42,0.72)',
                                  border: isPass ? '1px solid rgba(34,197,94,0.22)' : isBlocked ? '1px solid rgba(245,158,11,0.22)' : '1px solid rgba(148,163,184,0.14)',
                                }}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="text-[11px] font-semibold text-white/40">{item.code}</div>
                                    <div className="mt-0.5 text-xs font-semibold text-white/76">{item.title}</div>
                                  </div>
                                  <span
                                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold"
                                    style={{
                                      background: isPass ? 'rgba(34,197,94,0.14)' : isBlocked ? 'rgba(245,158,11,0.14)' : 'rgba(56,189,248,0.1)',
                                      color: isPass ? 'rgba(134,239,172,0.92)' : isBlocked ? 'rgba(253,230,138,0.92)' : 'rgba(186,230,253,0.86)',
                                    }}
                                  >
                                    {isPass ? 'PASS' : isBlocked ? `BLOCK ${item.blockedBy || ''}`.trim() : 'NEXT'}
                                  </span>
                                </div>
                                <div className="mt-2 line-clamp-2 text-xs leading-relaxed text-white/56">{item.goal}</div>
                                <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/40">{item.evidence}</div>
                                {item.nextActions && item.nextActions.length > 0 && (
                                  <div className="mt-2 text-xs leading-relaxed text-sky-50/68">{item.nextActions[0]}</div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {runtimeDiagnostics.nextCyclePlan.stopConditions.length > 0 && (
                          <div className="mt-3 rounded-md px-3 py-2" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)' }}>
                            <div className="text-[11px] font-semibold uppercase tracking-normal text-white/40">停止条件</div>
                            <div className="mt-1 grid gap-1 md:grid-cols-2">
                              {runtimeDiagnostics.nextCyclePlan.stopConditions.map((item) => (
                                <div key={item} className="text-xs leading-relaxed text-white/55">{item}</div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                    {runtimeDiagnostics.debugCommands.length > 0 && (
                      <div className="mt-3 rounded-md px-3 py-3" style={{ background: 'rgba(2,6,23,0.32)', border: '1px solid rgba(148,163,184,0.14)' }}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-normal text-white/46">
                              <Terminal size={13} />
                              调试命令
                            </div>
                            <div className="mt-1 text-xs leading-relaxed text-white/48">
                              由 runtime-status 后端生成，和当前 R1/provider gate 状态一致。
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void copyText('调试命令', runtimeDiagnostics.debugCommands.map((item) => item.command).join('\n'))}
                            className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 text-xs text-white/55 hover:text-white/85"
                            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}
                          >
                            <Copy size={12} /> 复制全部
                          </button>
                        </div>
                        <div className="mt-3 grid gap-2 lg:grid-cols-2">
                          {runtimeDiagnostics.debugCommands.map((item) => {
                            const blocked = item.status === 'blocked';
                            const pass = item.status === 'pass';
                            return (
                              <div
                                key={item.code}
                                className="min-h-[104px] rounded-md px-3 py-2"
                                style={{
                                  background: blocked ? 'rgba(245,158,11,0.08)' : pass ? 'rgba(34,197,94,0.07)' : 'rgba(15,23,42,0.68)',
                                  border: blocked ? '1px solid rgba(245,158,11,0.2)' : pass ? '1px solid rgba(34,197,94,0.18)' : '1px solid rgba(148,163,184,0.14)',
                                }}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="text-xs font-semibold text-white/74">{item.label}</div>
                                    <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/44">{item.purpose}</div>
                                  </div>
                                  <span
                                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold"
                                    style={{
                                      background: blocked ? 'rgba(245,158,11,0.14)' : pass ? 'rgba(34,197,94,0.12)' : 'rgba(56,189,248,0.1)',
                                      color: blocked ? 'rgba(253,230,138,0.9)' : pass ? 'rgba(134,239,172,0.9)' : 'rgba(186,230,253,0.82)',
                                    }}
                                  >
                                    {blocked ? `BLOCK ${item.blockedBy || ''}`.trim() : item.status.toUpperCase()}
                                  </span>
                                </div>
                                <div className="mt-2 flex items-start gap-2">
                                  <code className="min-w-0 flex-1 break-all rounded px-2 py-1.5 text-[11px] leading-relaxed text-sky-50/76" style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.06)' }}>
                                    {item.command}
                                  </code>
                                  <button
                                    type="button"
                                    onClick={() => void copyText(item.label, item.command)}
                                    className="shrink-0 rounded p-1.5 text-white/42 hover:text-white/85"
                                    aria-label={`复制${item.label}`}
                                  >
                                    <Copy size={12} />
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <div className="mt-3 rounded-md px-3 py-3" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.07)' }}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="text-[11px] font-semibold uppercase tracking-normal text-white/42">技术诊断门禁</div>
                        <div className="text-xs text-white/38">
                          {runtimeDiagnostics.readinessGates.filter((gate) => gate.state === 'pass').length}/{runtimeDiagnostics.readinessGates.length} passed
                        </div>
                      </div>
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        {runtimeDiagnostics.readinessGates.map((gate) => {
                          const isPass = gate.state === 'pass';
                          const isWarn = gate.state === 'warn';
                          return (
                            <div
                              key={gate.label}
                              className="min-h-[82px] rounded-md px-3 py-2"
                              style={{
                                background: isPass ? 'rgba(34,197,94,0.08)' : isWarn ? 'rgba(245,158,11,0.09)' : 'rgba(15,23,42,0.68)',
                                border: isPass ? '1px solid rgba(34,197,94,0.22)' : isWarn ? '1px solid rgba(245,158,11,0.2)' : '1px solid rgba(148,163,184,0.14)',
                              }}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <div className="text-xs font-semibold text-white/70">{gate.label}</div>
                                  <div className="mt-1 break-all text-xs font-medium text-white/84">{gate.value}</div>
                                </div>
                                <span
                                  className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold"
                                  style={{
                                    background: isPass ? 'rgba(34,197,94,0.14)' : isWarn ? 'rgba(245,158,11,0.14)' : 'rgba(148,163,184,0.1)',
                                    color: isPass ? 'rgba(134,239,172,0.92)' : isWarn ? 'rgba(253,230,138,0.92)' : 'rgba(203,213,225,0.76)',
                                  }}
                                >
                                  {isPass ? 'PASS' : isWarn ? 'ACTION' : 'WAIT'}
                                </span>
                              </div>
                              <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/44">{gate.detail}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    {activeAdapterCompatibility && (
                      <div className="mt-3 rounded-md px-3 py-3" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <div className="text-[11px] font-semibold uppercase tracking-normal text-white/42">Adapter 兼容性</div>
                            <div className="mt-1 text-xs font-semibold text-white/72">{activeAdapterCompatibility.label}</div>
                          </div>
                          <span className="rounded px-2 py-1 text-[11px] font-semibold text-sky-100/80" style={{ background: 'rgba(56,189,248,0.1)', border: '1px solid rgba(56,189,248,0.2)' }}>
                            {activeAdapterCompatibility.status}
                          </span>
                        </div>
                        <div className="mt-2 grid gap-2 md:grid-cols-2">
                          <div className="rounded-md px-3 py-2" style={{ background: activeAdapterCompatibility.routableByDefault ? 'rgba(34,197,94,0.08)' : 'rgba(245,158,11,0.09)', border: activeAdapterCompatibility.routableByDefault ? '1px solid rgba(34,197,94,0.22)' : '1px solid rgba(245,158,11,0.22)' }}>
                            <div className="text-[11px] font-semibold text-white/38">默认路由</div>
                            <div className="mt-1 text-xs font-semibold text-white/74">
                              {activeAdapterCompatibility.routableByDefault ? '允许默认进入代码审查' : '禁止默认路由'}
                            </div>
                            <div className="mt-1 text-xs leading-relaxed text-white/42">
                              {(activeAdapterCompatibility.supportedTaskKinds.length > 0 ? activeAdapterCompatibility.supportedTaskKinds : ['未声明任务类型']).join(' / ')}
                            </div>
                          </div>
                          <div className="rounded-md px-3 py-2" style={{ background: 'rgba(15,23,42,0.68)', border: '1px solid rgba(148,163,184,0.14)' }}>
                            <div className="text-[11px] font-semibold text-white/38">证据门禁</div>
                            <div className="mt-1 text-xs leading-relaxed text-white/66">
                              {(activeAdapterCompatibility.requiredEvidenceGates.length > 0 ? activeAdapterCompatibility.requiredEvidenceGates : ['未声明']).join(' / ')}
                            </div>
                          </div>
                          <div className="rounded-md px-3 py-2" style={{ background: 'rgba(15,23,42,0.68)', border: '1px solid rgba(148,163,184,0.14)' }}>
                            <div className="text-[11px] font-semibold text-white/38">支持的 profile</div>
                            <div className="mt-1 text-xs leading-relaxed text-white/66">
                              {(activeAdapterCompatibility.supportedProfileProtocols.length > 0 ? activeAdapterCompatibility.supportedProfileProtocols : ['未声明']).join(' / ')}
                            </div>
                            <div className="mt-1 text-xs leading-relaxed text-white/42">
                              {activeAdapterCompatibility.modelHints.slice(0, 3).join(' · ') || '无模型提示'}
                            </div>
                          </div>
                          <div className="rounded-md px-3 py-2" style={{ background: 'rgba(15,23,42,0.68)', border: '1px solid rgba(148,163,184,0.14)' }}>
                            <div className="text-[11px] font-semibold text-white/38">不兼容形态</div>
                            <div className="mt-1 text-xs leading-relaxed text-white/66">
                              {activeAdapterCompatibility.knownIncompatibleProfilePatterns.slice(0, 2).join(' · ') || '未声明'}
                            </div>
                          </div>
                          <div className="rounded-md px-3 py-2 md:col-span-2" style={{ background: activeAdapterCompatibility.missingAdapterContracts.length > 0 ? 'rgba(245,158,11,0.09)' : 'rgba(34,197,94,0.08)', border: activeAdapterCompatibility.missingAdapterContracts.length > 0 ? '1px solid rgba(245,158,11,0.2)' : '1px solid rgba(34,197,94,0.18)' }}>
                            <div className="text-[11px] font-semibold text-white/38">缺失 adapter contract</div>
                            <div className="mt-1 text-xs leading-relaxed text-white/66">
                              {activeAdapterCompatibility.missingAdapterContracts.length > 0
                                ? activeAdapterCompatibility.missingAdapterContracts.join(' / ')
                                : '无缺失 contract'}
                            </div>
                          </div>
                        </div>
                        {adapterCompatibility.length > 1 && (
                          <div className="mt-2 rounded-md px-3 py-2" style={{ background: 'rgba(15,23,42,0.5)', border: '1px solid rgba(148,163,184,0.12)' }}>
                            <div className="text-[11px] font-semibold text-white/38">候选 adapter 边界</div>
                            <div className="mt-2 grid gap-2 lg:grid-cols-2">
                              {adapterCompatibility.map((item) => (
                                <div key={item.id} className="rounded-md px-2.5 py-2" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.07)' }}>
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                      <div className="truncate text-xs font-semibold text-white/72">{item.label}</div>
                                      <div className="mt-0.5 text-[11px] text-white/38">{item.id}</div>
                                    </div>
                                    <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ background: item.routableByDefault ? 'rgba(34,197,94,0.14)' : 'rgba(148,163,184,0.1)', color: item.routableByDefault ? 'rgba(134,239,172,0.92)' : 'rgba(203,213,225,0.76)' }}>
                                      {item.routableByDefault ? 'ROUTABLE' : item.status}
                                    </span>
                                  </div>
                                  <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/48">
                                    {(item.missingAdapterContracts.length > 0 ? item.missingAdapterContracts : item.supportedTaskKinds).join(' / ') || '未声明 contract'}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {adapterMatrix && (
                          <div className="mt-2 rounded-md px-3 py-2" style={{ background: 'rgba(15,23,42,0.58)', border: '1px solid rgba(148,163,184,0.14)' }}>
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <div className="text-[11px] font-semibold text-white/38">Adapter matrix</div>
                                <div className="mt-1 text-xs text-white/58">
                                  {adapterMatrix.summary.defaultRoutableAdapterCount} default / {adapterMatrix.summary.blockedAdapterCount} blocked · {adapterMatrix.summary.profileCount} profiles
                                </div>
                              </div>
                              <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-white/62" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
                                {adapterMatrix.desiredRuntimeAdapter}
                              </span>
                            </div>
                            <div className="mt-2 grid gap-2 lg:grid-cols-2">
                              {adapterMatrix.rows.map((row) => {
                                const compatibleProfiles = row.profileCandidates.filter((item) => item.compatible).length;
                                const blocked = row.routeState === 'planned-blocked' || row.routeState === 'blocked';
                                return (
                                  <div
                                    key={row.adapterId}
                                    className="rounded-md px-2.5 py-2"
                                    style={{
                                      background: row.isDesired ? 'rgba(56,189,248,0.08)' : blocked ? 'rgba(245,158,11,0.06)' : 'rgba(34,197,94,0.06)',
                                      border: row.isDesired ? '1px solid rgba(56,189,248,0.24)' : blocked ? '1px solid rgba(245,158,11,0.16)' : '1px solid rgba(34,197,94,0.16)',
                                    }}
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0">
                                        <div className="truncate text-xs font-semibold text-white/72">{row.label}</div>
                                        <div className="mt-0.5 text-[11px] text-white/38">{row.adapterId} · {row.routeState}</div>
                                      </div>
                                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ background: blocked ? 'rgba(245,158,11,0.14)' : 'rgba(34,197,94,0.14)', color: blocked ? 'rgba(253,230,138,0.9)' : 'rgba(134,239,172,0.9)' }}>
                                        {blocked ? 'BLOCKED' : 'ROUTABLE'}
                                      </span>
                                    </div>
                                    <div className="mt-1 text-xs leading-relaxed text-white/50">
                                      profiles {compatibleProfiles}/{row.profileCandidates.length} · gates {row.gates.filter((gate) => gate.status === 'pass').length}/{row.gates.length}
                                    </div>
                                    <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/42">
                                      {row.missingAdapterContracts.length > 0
                                        ? `missing ${row.missingAdapterContracts.join(' / ')}`
                                        : row.profileCandidates.find((item) => item.compatible)?.reason || row.nextActions[0] || 'contract ready'}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        <div className="mt-2 grid gap-2 xl:grid-cols-2">
                          {activeAdapterCompatibility.notes.length > 0 && (
                            <div className="rounded-md px-3 py-2" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)' }}>
                              <div className="text-[11px] font-semibold text-white/38">边界说明</div>
                              <div className="mt-1 space-y-1">
                                {activeAdapterCompatibility.notes.slice(0, 3).map((item) => (
                                  <div key={item} className="text-xs leading-relaxed text-white/58">{item}</div>
                                ))}
                              </div>
                            </div>
                          )}
                          {activeAdapterCompatibility.nextActions.length > 0 && (
                            <div className="rounded-md px-3 py-2" style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)' }}>
                              <div className="text-[11px] font-semibold text-sky-100/60">推荐动作</div>
                              <div className="mt-1 space-y-1">
                                {activeAdapterCompatibility.nextActions.slice(0, 3).map((item) => (
                                  <div key={item} className="text-xs leading-relaxed text-sky-50/74">{item}</div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {(runtimeDiagnostics.blockers.length > 0 || runtimeDiagnostics.nextActions.length > 0) && (
                      <div className="mt-3 grid gap-2 xl:grid-cols-2">
                        {runtimeDiagnostics.blockers.length > 0 && (
                          <div className="rounded-md px-3 py-2" style={{ background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.22)' }}>
                            <div className="text-[11px] font-semibold uppercase tracking-normal text-amber-100/60">阻塞项 · {runtimeDiagnostics.blockers.length}</div>
                            <div className="mt-1 max-h-40 space-y-1 overflow-auto pr-1">
                              {runtimeDiagnostics.blockers.map((item) => (
                                <div key={item} className="text-xs leading-relaxed text-amber-50/78">{item}</div>
                              ))}
                            </div>
                          </div>
                        )}
                        {runtimeDiagnostics.nextActions.length > 0 && (
                          <div className="rounded-md px-3 py-2" style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.2)' }}>
                            <div className="text-[11px] font-semibold uppercase tracking-normal text-sky-100/60">下一步 · {runtimeDiagnostics.nextActions.length}</div>
                            <div className="mt-1 max-h-40 space-y-1 overflow-auto pr-1">
                              {runtimeDiagnostics.nextActions.map((item) => (
                                <div key={item} className="text-xs leading-relaxed text-sky-50/74">{item}</div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </details>
	                <div className="order-2 min-h-[360px] space-y-3 overflow-auto rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-xs font-semibold text-white/60"><MessageSquare size={13} /> 对话</span>
                    <span className="text-xs text-white/35">{messages.length} 条</span>
                  </div>
                  {activeSessionProfileBlockReason && (
                    <div className="mb-3 rounded-lg px-3 py-2 text-sm leading-relaxed text-amber-100/85" style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.26)' }}>
                      {activeSessionProfileBlockReason}
                    </div>
                  )}
                  {messages.length === 0 ? (
                    <div className="flex min-h-[150px] items-center justify-center rounded-lg text-sm text-white/40" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
                      发送任务后，这里会按 user / Agent 消息展示多轮对话。
                    </div>
                  ) : (
                    messages.map((message) => {
                      const isUser = message.role === 'user';
                      return (
                        <article
                          key={message.id}
                          className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                        >
                          <div
                            className="max-w-[82%] rounded-lg px-3 py-2"
                            style={{
                              background: isUser ? 'rgba(99,179,237,0.15)' : 'rgba(255,255,255,0.045)',
                              border: isUser ? '1px solid rgba(99,179,237,0.32)' : '1px solid rgba(255,255,255,0.08)',
                            }}
                          >
                            <div className="mb-1 flex items-center justify-between gap-3 text-[11px] text-white/42">
                              <span>{messageRoleLabel(message.role)} · {message.status}</span>
                              <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
                            </div>
                            {message.role === 'assistant' ? (
                              <MarkdownContent content={displayMessageContent(message)} className="text-sm leading-relaxed text-white/76" />
                            ) : (
                              <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-white/76">{displayMessageContent(message)}</div>
                            )}
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>

	                <details className="order-6 rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <summary className="cursor-pointer select-none text-xs font-semibold text-white/60">
                    事件时间线 · {eventReplayMode ? `${displayedEvents.length} / ${events.length}` : `${events.length} 条`}
                  </summary>
                  <div className="mt-3 max-h-[420px] space-y-2 overflow-auto pr-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-2 text-xs font-semibold text-white/60"><Terminal size={13} /> 事件时间线</span>
                        <span className="text-xs text-white/35">
                          {eventReplayMode ? `${displayedEvents.length} / ${events.length}` : `${events.length} 条`}
                        </span>
                      </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void createApprovalCard()}
                        disabled={!activeSession || busy}
                        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-white/55 hover:text-white/85 disabled:opacity-40"
                        style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}
                      >
                        <ShieldCheck size={12} /> 生成审批卡
                      </button>
                      {events.length > 0 && (
                        <>
                        {eventReplayMode && (
                          <>
                            <button
                              type="button"
                              onClick={() => setEventReplayIndex((prev) => Math.max(1, prev - 1))}
                              className="rounded px-2 py-1 text-xs text-white/55 hover:text-white/85 disabled:opacity-40"
                              disabled={eventReplayIndex <= 1}
                            >
                              上一步
                            </button>
                            <input
                              type="range"
                              min={1}
                              max={events.length}
                              value={eventReplayIndex}
                              onChange={(e) => setEventReplayIndex(Number(e.target.value))}
                              className="h-1 w-28 accent-sky-300"
                              aria-label="事件回放进度"
                            />
                            <button
                              type="button"
                              onClick={() => setEventReplayIndex((prev) => Math.min(events.length, prev + 1))}
                              className="rounded px-2 py-1 text-xs text-white/55 hover:text-white/85 disabled:opacity-40"
                              disabled={eventReplayIndex >= events.length}
                            >
                              下一步
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setEventReplayMode((prev) => !prev);
                            setEventReplayIndex(1);
                          }}
                          className="rounded px-2 py-1 text-xs text-white/55 hover:text-white/85"
                          style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}
                        >
                          {eventReplayMode ? '退出回放' : '回放'}
                        </button>
                        </>
                      )}
                    </div>
                  </div>
                  {events.length === 0 ? (
                    <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-white/40">启动并发送任务后，这里会显示状态、流式输出、工具调用和审批结果。</div>
                  ) : (
                    displayedEvents.map((event) => {
                      const payload = parsePayload(event);
                      const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
                      const waitingApproval = event.type === 'tool_call' && approvalId && payload.status === 'waiting';
                      const runtimeBadge = readString(payload, 'runtimeAdapter') || readString(payload, 'source');
                      const runtimeInstance = readString(payload, 'runtimeInstance') || readString(payload, 'sidecar');
                      return (
                        <article key={event.id} className="rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)' }}>
                          <div className="flex items-center justify-between gap-3">
                            <span className="min-w-0 text-xs font-semibold text-white/65">
                              {event.type} #{event.seq} · {event.traceId}
                              {runtimeBadge && <span className="ml-2 text-white/35">{runtimeBadge}{runtimeInstance ? ` / ${runtimeInstance}` : ''}</span>}
                            </span>
                            <button type="button" onClick={() => void copyText('事件', renderPayload(event))} className="rounded p-1 text-white/40 hover:text-white/80" aria-label="复制事件">
                              <Copy size={12} />
                            </button>
                          </div>
                          <EventBody event={event} />
                          {waitingApproval && (
                            <div className="mt-2 flex gap-2">
                              <button type="button" onClick={() => void approveTool(approvalId, 'allow')} className="rounded-md px-2 py-1 text-xs" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.28)', color: 'rgba(134,239,172,0.95)' }}>允许</button>
                              <button type="button" onClick={() => void approveTool(approvalId, 'deny')} className="rounded-md px-2 py-1 text-xs" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(252,165,165,0.95)' }}>拒绝</button>
                            </div>
                          )}
                        </article>
                      );
                    })
                  )}
                  </div>
                </details>
	                <details className="order-4 rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.14)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <summary className="cursor-pointer select-none text-xs font-semibold text-white/62">
                    上下文
                  </summary>
                  <div className="mt-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="text-xs text-white/42">文件、网页、项目说明按需补充</div>
                    {hasContextDraft && (
                      <button
                        type="button"
                        onClick={() => setContextDraft({ files: '', urls: '', notes: '' })}
                        className="rounded px-2 py-1 text-xs text-white/42 hover:text-white/72"
                      >
                        清空
                      </button>
                    )}
                    </div>
                    <div className="grid gap-2 md:grid-cols-3">
                    <textarea
                      value={contextDraft.files}
                      onChange={(e) => setContextDraft((prev) => ({ ...prev, files: e.target.value }))}
                      rows={2}
                      className="min-h-[58px] resize-none rounded-md px-3 py-2 text-xs text-white outline-none"
                      style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.09)' }}
                      placeholder="文件路径"
                    />
                    <textarea
                      value={contextDraft.urls}
                      onChange={(e) => setContextDraft((prev) => ({ ...prev, urls: e.target.value }))}
                      rows={2}
                      className="min-h-[58px] resize-none rounded-md px-3 py-2 text-xs text-white outline-none"
                      style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.09)' }}
                      placeholder="网页地址"
                    />
                    <textarea
                      value={contextDraft.notes}
                      onChange={(e) => setContextDraft((prev) => ({ ...prev, notes: e.target.value }))}
                      rows={2}
                      className="min-h-[58px] resize-none rounded-md px-3 py-2 text-xs text-white outline-none"
                      style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.09)' }}
                      placeholder="项目文档 / 知识库"
                    />
                    </div>
                  </div>
                </details>
	                <div className="order-3 flex gap-2 rounded-xl p-2" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>
	                  <textarea
	                    value={prompt}
	                    onChange={(e) => setPrompt(e.target.value)}
	                    rows={3}
	                    placeholder="继续要求 Agent，例如：只读巡检当前仓库，找一个最值得修复的小问题"
	                    className="min-h-[76px] flex-1 resize-none rounded-lg px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
	                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.08)' }}
                  />
                  <button type="button" onClick={() => void sendPrompt()} disabled={!activeSession || busy || !prompt.trim() || (!canSendActiveSession && !canRecordManualInput)} className="inline-flex w-[112px] items-center justify-center gap-2 rounded-lg text-sm font-medium disabled:opacity-45" style={{ background: 'rgba(99,179,237,0.17)', border: '1px solid rgba(99,179,237,0.4)', color: 'rgba(186,230,253,0.96)' }}>
                    {busy ? <MapSpinner size={14} /> : activeSession?.manualTakeoverEnabled ? <UserCheck size={14} /> : <Send size={14} />} {activeSession?.manualTakeoverEnabled ? '记录' : '发送'}
                  </button>
                </div>
              </section>

              <aside className="min-h-0 space-y-3 rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <section>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-xs font-semibold text-white/60"><FileText size={13} /> 产物</span>
                    <span className="text-xs text-white/35">{artifacts.length}</span>
                  </div>
                  <div className="mb-2 grid grid-cols-1 gap-2 xl:grid-cols-3">
                    <button type="button" onClick={() => void collectArtifacts()} disabled={!activeSession || busy} className="inline-flex min-h-8 items-center justify-center gap-1 rounded px-2 py-1 text-xs text-white/56 hover:text-white/86 disabled:opacity-45" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {busy ? <MapSpinner size={12} /> : <FileSearch size={12} />} 生成只读产物
                    </button>
                    <button type="button" onClick={() => void runReadonlyChecks()} disabled={!activeSession || busy} className="inline-flex min-h-8 items-center justify-center gap-1 rounded px-2 py-1 text-xs text-white/56 hover:text-white/86 disabled:opacity-45" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {busy ? <MapSpinner size={12} /> : <Terminal size={12} />} 运行只读检查
                    </button>
                    <button type="button" onClick={() => void captureBrowserSnapshot()} disabled={!activeSession || busy} className="inline-flex min-h-8 items-center justify-center gap-1 rounded px-2 py-1 text-xs text-white/56 hover:text-white/86 disabled:opacity-45" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {busy ? <MapSpinner size={12} /> : <Globe2 size={12} />} 读取页面快照
                    </button>
                  </div>
                  <label className="mb-2 flex items-center gap-2 rounded px-2 py-1.5" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    <Globe2 size={12} className="text-white/35" />
                    <input
                      value={browserBranchId}
                      onChange={(e) => setBrowserBranchId(e.target.value)}
                      className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-white/32"
                      placeholder="CDS 分支 ID，例如 prd-agent-main"
                    />
                  </label>
                  <div className="mb-2 rounded-lg p-2" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-white/55">
                      <MousePointerClick size={12} />
                      远程页面动作
                    </div>
                    <div className="grid gap-2">
                      <select
                        value={browserAction}
                        onChange={(e) => setBrowserAction(e.target.value)}
                        className="w-full rounded px-2 py-1.5 text-xs text-white outline-none"
                        style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.08)' }}
                      >
                        <option value="spa-navigate">SPA 跳转</option>
                        <option value="click">点击元素</option>
                        <option value="type">输入文本</option>
                        <option value="scroll">滚动页面</option>
                        <option value="navigate">页面导航</option>
                        <option value="evaluate">执行脚本</option>
                      </select>
                      {(browserAction === 'click' || browserAction === 'type') && (
                        <input
                          value={browserTargetIndex}
                          onChange={(e) => setBrowserTargetIndex(e.target.value)}
                          className="w-full rounded px-2 py-1.5 text-xs text-white outline-none"
                          style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.08)' }}
                          placeholder="元素索引，例如 8"
                          type="number"
                          min={0}
                        />
                      )}
                      <input
                        value={browserActionText}
                        onChange={(e) => setBrowserActionText(e.target.value)}
                        className="w-full rounded px-2 py-1.5 text-xs text-white outline-none"
                        style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.08)' }}
                        placeholder={browserAction === 'type' ? '输入内容' : browserAction === 'scroll' ? 'down 或 up' : browserAction === 'evaluate' ? 'JS 表达式' : 'URL 或路径'}
                      />
                      <button type="button" onClick={() => void runBrowserAction()} disabled={!activeSession || busy} className="inline-flex min-h-8 items-center justify-center gap-1 rounded px-2 py-1 text-xs text-white/56 hover:text-white/86 disabled:opacity-45" style={{ background: 'rgba(99,179,237,0.1)', border: '1px solid rgba(99,179,237,0.22)' }}>
                        {busy ? <MapSpinner size={12} /> : <MousePointerClick size={12} />} 执行动作
                      </button>
                    </div>
                  </div>
                  <div className="max-h-[360px] space-y-2 overflow-auto pr-1">
                    {artifacts.length === 0 ? (
                      <div className="rounded-lg px-3 py-8 text-center text-sm text-white/38" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.06)' }}>
                        文件树、diff、命令输出和远程页面快照会自动汇总在这里。
                      </div>
                    ) : (
                      artifacts.map((artifact) => (
                        <article key={artifact.id} className="rounded-lg p-3" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)' }}>
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-xs font-semibold text-white/70">
                                {artifactIcon(artifact.kind)}
                                <span>{artifact.title}</span>
                              </div>
                              <div className="mt-1 truncate text-xs text-white/42">{artifact.summary}</div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button type="button" onClick={() => void copyText(artifact.title, artifact.body)} className="rounded p-1 text-white/40 hover:text-white/80" aria-label={`复制${artifact.title}`}>
                                <Copy size={12} />
                              </button>
                              <button type="button" onClick={() => downloadText(`${artifact.title}-${activeSession?.id ?? 'session'}.txt`, artifact.body)} className="rounded p-1 text-white/40 hover:text-white/80" aria-label={`下载${artifact.title}`}>
                                <Download size={12} />
                              </button>
                            </div>
                          </div>
                          <pre className="mt-2 max-h-[160px] overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-xs leading-relaxed text-white/58">{artifact.body || '暂无内容'}</pre>
                        </article>
                      ))
                    )}
                  </div>
                </section>

                <section>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-xs font-semibold text-white/60"><Terminal size={13} /> 运行日志</span>
                    <button type="button" onClick={() => void copyText('日志', logs)} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-white/45 hover:text-white/80"><Copy size={12} /> 复制</button>
                  </div>
                  <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-white/56">{logs || '暂无日志'}</pre>
                </section>
              </aside>
            </div>
          </main>
        </section>
      </div>
    </div>
  );
}
