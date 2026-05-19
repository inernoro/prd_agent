import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Copy, Cpu, Download, FileSearch, FileText, GitCompare, GitPullRequest, Globe2, KeyRound, ListChecks, MessageSquare, MousePointerClick, Network, PauseCircle, Play, Plus, RefreshCw, Route, Search, Send, Server, ShieldCheck, Square, Terminal, UserCheck } from 'lucide-react';

import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming/StreamingText';
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
  getInfraAgentLogs,
  getInfraAgentRuntimeStatus,
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
  type InfraAgentRuntimeAdapterCompatibilityView,
  type InfraAgentRuntimeDiagnostics,
  type InfraAgentRuntimeProfileTemplateView,
  type InfraAgentRuntimeProfileView,
  type InfraAgentSessionView,
} from '@/services/real/infraAgentSessions';
import { resolveExecutionRunway, resolveProviderEvidenceState } from './cdsAgentReadiness';

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
  return `${profile.name} · ${protocolLabel(profile.protocol)} · ${profile.model}${keyState}`;
}

function profileSummary(profile: InfraAgentRuntimeProfileView | null): string {
  if (!profile) return '未选择';
  const keyState = profile.hasApiKey ? '' : ' · provider secret 需重新保存';
  return `${protocolLabel(profile.protocol)} · ${profile.model} @ ${profile.baseUrl}${keyState}`;
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
  if (!profile) return '请先保存一个模型配置。';
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
  return [...items].sort((a, b) => {
    const rank = statusRank(a.status) - statusRank(b.status);
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

function renderPayload(event: InfraAgentEventView): string {
  const payload = parsePayload(event);
  if (event.type === 'text_delta' && typeof payload.text === 'string') return payload.text;
  if (event.type === 'done' && typeof payload.finalText === 'string') return payload.finalText;
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

const SIMPLE_VIEW_STORAGE_KEY = 'cds-agent:view-mode';

function readInitialViewMode(): 'simple' | 'pro' {
  try {
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

export default function CdsAgentPage() {
  const [connections, setConnections] = useState<InfraConnectionPublicView[]>([]);
  const [profiles, setProfiles] = useState<InfraAgentRuntimeProfileView[]>([]);
  const [profileTemplates, setProfileTemplates] = useState<InfraAgentRuntimeProfileTemplateView[]>([]);
  const [adapterCompatibility, setAdapterCompatibility] = useState<InfraAgentRuntimeAdapterCompatibilityView[]>([]);
  const [sessions, setSessions] = useState<InfraAgentSessionView[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<InfraAgentMessageView[]>([]);
  const [events, setEvents] = useState<InfraAgentEventView[]>([]);
  const [logs, setLogs] = useState('');
  const [runtimeStatus, setRuntimeStatus] = useState<InfraAgentRuntimeDiagnostics | null>(null);
  const [runtimeDiscoveryRefreshed, setRuntimeDiscoveryRefreshed] = useState<boolean | null>(null);
  const [runtimeStatusLoadedAt, setRuntimeStatusLoadedAt] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'simple' | 'pro'>(readInitialViewMode);
  const [simpleExpandedEventId, setSimpleExpandedEventId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [nowTick, setNowTick] = useState(() => Date.now());
  const timelineRef = useRef<HTMLDivElement>(null);
  const eventsRef = useRef<InfraAgentEventView[]>([]);
  const [eventStreamHealthy, setEventStreamHealthy] = useState(false);
  const [sessionQuery, setSessionQuery] = useState('');
  const [eventReplayMode, setEventReplayMode] = useState(false);
  const [eventReplayIndex, setEventReplayIndex] = useState(1);
  const [busy, setBusy] = useState(false);
  const [testingProfile, setTestingProfile] = useState(false);
  const [profileTest, setProfileTest] = useState<string>('');
  const [prompt, setPrompt] = useState('巡检当前仓库，找出最值得修复的一个小问题，并说明准备如何提交 PR');
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
    title: '远程巡检任务',
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
  const activeProfile = useMemo(
    () => profiles.find((item) => item.id === draft.runtimeProfileId) ?? profiles.find((item) => item.isDefault) ?? profiles[0] ?? null,
    [profiles, draft.runtimeProfileId],
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
    () => sessions.filter((item) => item.status === 'running' || item.status === 'creating' || item.status === 'idle').length,
    [sessions],
  );
  const activeSession = sessions.find((item) => item.id === activeSessionId) ?? sortedSessions[0] ?? null;
  const activeSessionProfile = activeSession?.runtimeProfileId
    ? profiles.find((item) => item.id === activeSession.runtimeProfileId) ?? null
    : activeProfile;
  const desiredRuntimeAdapterForProfile = runtimeStatus?.desiredRuntimeAdapter || '';
  const activeProfileBlockReason = profileBlockReason(activeProfile)
    || profileCompatibilityBlockReason(activeProfile, desiredRuntimeAdapterForProfile);
  const activeSessionProfileBlockReason = activeSession
    ? profileBlockReason(activeSessionProfile)
      || profileCompatibilityBlockReason(activeSessionProfile, desiredRuntimeAdapterForProfile)
    : '';
  const activeRuntimePoolBlockReason = runtimePoolBlockReason(runtimeStatus);
  const canReuseActiveProfileSecret = Boolean(activeProfile?.hasApiKey && !profileDraft.apiKey.trim());
  const canUpdateActiveProfile = Boolean(
    activeProfile
    && profileDraft.baseUrl.trim()
    && profileDraft.model.trim()
    && (profileDraft.apiKey.trim() || activeProfile.hasApiKey),
  );
  const canCreateSession = Boolean(activeConnection && activeProfile && !activeProfileBlockReason && !activeRuntimePoolBlockReason);
  const canRunActiveSession = Boolean(activeSession && !activeSessionProfileBlockReason && !activeRuntimePoolBlockReason);
  const canStartActiveSession = Boolean(activeSession && !activeSession.manualTakeoverEnabled && canRunActiveSession && canStartFromStatus(activeSession.status));
  const canSendActiveSession = Boolean(activeSession && !activeSession.manualTakeoverEnabled && canRunActiveSession && (activeSession.status === 'running' || activeSession.status === 'idle'));
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
    const running = sessions.filter((item) => item.status === 'running' || item.status === 'creating').length;
    const failed = sessions.filter((item) => item.status === 'failed').length;
    const stopped = sessions.filter((item) => item.status === 'stopped').length;
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
  }, [artifacts.length, events, sessions]);
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
        state: runId ? 'pass' : activeSession?.status === 'running' ? 'warn' : 'pending',
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
  }, [activeAdapterCompatibility, activeProfile, activeSession, activeSessionProfile, anthropicOfficialProfileTemplate, eventStreamHealthy, events, messages, runtimeDiscoveryRefreshed, runtimeStatus, runtimeStatusLoadedAt]);
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
        status: activeSession?.status ?? null,
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
  }, [activeSession, artifacts, events, logs, messages, runtimeDiagnosticBundle, runtimeDiagnostics, runtimeStatus, viewMode]);
  const activeRuntimeProfile = activeSessionProfile ?? activeProfile;
  const runtimeReady = Boolean(activeRuntimeProfile && activeRuntimeProfile.hasApiKey && activeRuntimeProfile.baseUrl && activeRuntimeProfile.model);
  const activeRuntimeProfileWarning = profileCompatibilityBlockReason(activeRuntimeProfile, runtimeStatus?.desiredRuntimeAdapter)
    || runtimeStatus?.defaultRuntimeProfile?.warning
    || '';
  const prArtifact = artifacts.find((item) => /github\.com\/.+\/pull\/\d+/.test(item.body)) ?? null;
  const runwaySteps = [
    {
      label: 'MAP 会话',
      value: activeSession ? statusLabel(activeSession.status) : '未创建',
      detail: activeSession ? `trace ${activeSession.traceId.slice(0, 12)}` : '先新建远程任务',
      icon: MessageSquare,
      state: activeSession ? 'pass' : 'pending',
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
      state: activeSession && ['creating', 'running'].includes(activeSession.status) ? 'pass' : 'pending',
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
                onClick={() => void applyAnthropicOfficialTemplate()}
                disabled={!anthropicOfficialProfileTemplate}
                className="inline-flex min-h-8 items-center justify-center gap-2 rounded-md px-2 text-xs font-semibold disabled:opacity-45"
                style={{ background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.32)', color: 'rgba(253,230,138,0.95)' }}
              >
                <KeyRound size={12} /> 准备默认 Claude 配置
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

  // 简洁模式时间线：新内容在底部，自动滚到底，符合 IM 习惯。
  useEffect(() => {
    if (viewMode !== 'simple') return;
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [viewMode, activeSessionId, messages.length, events.length]);

  // 运行中自动刷新会话元数据；事件优先走 SSE afterSeq 续读，异常时由 refreshDetail 兜底。
  const activeSessionForPoll = sessions.find((item) => item.id === activeSessionId) ?? null;
  const isLiveStatus = activeSessionForPoll?.status === 'running' || activeSessionForPoll?.status === 'creating';
  useEffect(() => {
    if (!isLiveStatus || !activeSessionId) return;
    const tick = window.setInterval(() => {
      setNowTick(Date.now());
      void refreshDetail(activeSessionId, { skipEvents: eventStreamHealthy });
      void listInfraAgentSessions(100).then((res) => {
        if (res.success && res.data?.items) setSessions(sortSessions(res.data.items));
      });
    }, 3000);
    return () => window.clearInterval(tick);
  }, [isLiveStatus, activeSessionId, eventStreamHealthy, refreshDetail]);

  useEffect(() => {
    if (!isLiveStatus || !activeSessionId) {
      setEventStreamHealthy(false);
      return;
    }

    const controller = new AbortController();
    let stopped = false;

    const sleep = (ms: number) => new Promise<void>((resolve) => {
      const timer = window.setTimeout(resolve, ms);
      controller.signal.addEventListener('abort', () => {
        window.clearTimeout(timer);
        resolve();
      }, { once: true });
    });

    const mergeStreamEvent = (event: InfraAgentEventView) => {
      setEvents((prev) => {
        const next = mergeEventsBySeq(prev, [event]);
        eventsRef.current = next;
        return next;
      });
    };

    const pump = async () => {
      setEventStreamHealthy(false);
      while (!controller.signal.aborted && !stopped) {
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
          await sleep(received ? 250 : 1200);
        } catch {
          if (!controller.signal.aborted && !stopped) {
            setEventStreamHealthy(false);
            await sleep(3000);
          }
        }
      }
    };

    void pump();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [isLiveStatus, activeSessionId]);

  useEffect(() => {
    if (!activeSession?.id) {
      setMessages([]);
      setEvents([]);
      setLogs('');
      setEventReplayMode(false);
      setEventReplayIndex(1);
      return;
    }
    setEventReplayMode(false);
    setEventReplayIndex(1);
    eventsRef.current = [];
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
    const [connRes, profileRes, profileTemplateRes, adapterCompatibilityRes, sessionRes, runtimeRes] = await Promise.all([
      listInfraConnections(),
      listInfraAgentRuntimeProfiles(),
      listInfraAgentRuntimeProfileTemplates(),
      listInfraAgentRuntimeAdapterCompatibility(),
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
      setAdapterCompatibility(adapterCompatibilityRes.data?.items ?? []);
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
  }

  async function createSession() {
    if (!activeConnection) {
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
        connectionId: activeConnection.id,
        runtime: activeProfile?.runtime ?? 'claude-sdk',
        model: activeProfile?.model,
        runtimeProfileId: activeProfile?.id,
        title: draft.title,
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

    let session = activeSession;
    if (!session && !activeConnection) {
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

    setBusy(true);
    try {
      if (!session) {
        const title = prompt.trim().slice(0, 28) || '只读代码巡检';
        const createRes = await createInfraAgentSession({
          connectionId: activeConnection!.id,
          runtime: activeProfile?.runtime ?? 'claude-sdk',
          model: activeProfile?.model,
          runtimeProfileId: activeProfile?.id,
          title,
          toolPolicy: draft.toolPolicy,
          gitRepository: draft.gitRepository.trim() || undefined,
          gitRef: draft.gitRef.trim() || undefined,
          workspaceRoot: draft.workspaceRoot.trim() || undefined,
        });
        if (!createRes.success || !createRes.data?.item) {
          toast.error('新建会话失败', createRes.error?.message ?? '请检查 CDS 连接和模型配置');
          return;
        }
        session = createRes.data.item;
        upsertSession(session);
      }

      if (canStartFromStatus(session.status)) {
        const startRes = await startInfraAgentSession(session.id);
        if (!startRes.success || !startRes.data?.item) {
          toast.error('启动失败', startRes.error?.message ?? '请检查 CDS runtime');
          await refreshDetail(session.id);
          return;
        }
        session = startRes.data.item;
        upsertSession(session);
      }

      const messageRes = await sendInfraAgentMessage(session.id, buildPromptWithContext(prompt, contextDraft));
      if (!messageRes.success || !messageRes.data?.item) {
        toast.error('发送失败', messageRes.error?.message ?? '请稍后重试');
        await refreshDetail(session.id);
        return;
      }
      setPrompt('');
      upsertSession(messageRes.data.item);
      await refreshDetail(messageRes.data.item.id);
    } catch (err) {
      toast.error('启动巡检失败', err instanceof Error ? err.message : '请稍后重试');
      if (session?.id) await refreshDetail(session.id);
    } finally {
      setBusy(false);
    }
  }

  async function stopSession() {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    setBusy(true);
    try {
      const res = await stopInfraAgentSession(sessionId);
      if (!res.success || !res.data?.item) {
        toast.error('停止失败', res.error?.message ?? '请稍后重试');
        await refreshDetail(sessionId);
        return;
      }
      upsertSession(res.data.item);
      await refreshDetail(res.data.item.id);
    } catch (err) {
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

  function applyAnthropicOfficialTemplate() {
    const template = anthropicOfficialProfileTemplate;
    if (!template) {
      toast.warning('官方模板未加载', '请刷新运行状态后重试');
      return;
    }
    setProfileDraft((prev) => ({
      ...prev,
      name: template.name,
      runtime: template.runtime,
      protocol: template.protocol,
      baseUrl: template.baseUrl,
      model: template.model,
      resourceCpuCores: template.resourceCpuCores,
      resourceMemoryMb: template.resourceMemoryMb,
      timeoutSeconds: template.timeoutSeconds,
      networkPolicy: template.networkPolicy,
      autoCleanupMinutes: template.autoCleanupMinutes,
      isDefault: template.isDefaultRecommended,
      apiKey: prev.apiKey,
    }));
    setProfileTest('');
    toast.success('已套用 Anthropic 官方模板', '保存 provider secret 后设为默认配置');
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
      toast.error('同步系统模型失败', res.error?.message ?? '请先在模型设置中配置可用主模型');
      return;
    }
    setProfiles((prev) => [res.data!.item, ...prev.filter((item) => item.id !== res.data!.item.id)]);
    setDraft((prev) => ({ ...prev, runtimeProfileId: res.data!.item.id }));
    setProfileTest('');
    toast.success('已同步系统主模型', '可以直接测试并用于新的远程会话');
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
      | { kind: 'evt'; at: number; seq: number; key: string; ev: InfraAgentEventView };
    const timelineItems: TimelineItem[] = [
      ...messages.map((m): TimelineItem => ({ kind: 'msg', at: new Date(m.createdAt).getTime(), key: `m-${m.id}`, msg: m })),
      ...displayedEvents
        .filter((e) => PROCESS_TYPES.has(e.type))
        .map((e): TimelineItem => ({ kind: 'evt', at: new Date(e.createdAt).getTime(), seq: e.seq, key: `e-${e.id}`, ev: e })),
    ].sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at; // 旧 → 新
      if (a.kind !== b.kind) return a.kind === 'msg' ? -1 : 1;
      if (a.kind === 'evt' && b.kind === 'evt') return a.seq - b.seq;
      return 0;
    });
    type TimelineBlock =
      | { type: 'msg'; key: string; msg: InfraAgentMessageView }
      | { type: 'group'; key: string; events: InfraAgentEventView[] };
    const timelineBlocks: TimelineBlock[] = [];
    for (const item of timelineItems) {
      if (item.kind === 'msg') {
        timelineBlocks.push({ type: 'msg', key: item.key, msg: item.msg });
        continue;
      }
      const last = timelineBlocks[timelineBlocks.length - 1];
      if (last && last.type === 'group') last.events.push(item.ev);
      else timelineBlocks.push({ type: 'group', key: item.key, events: [item.ev] });
    }
    const hasTimeline = timelineBlocks.length > 0;
    const canRunSimplePrompt = Boolean(
      prompt.trim()
      && !busy
      && (
        (activeSession && (canSendActiveSession || canStartActiveSession || canRecordManualInput))
        || (!activeSession && canCreateSession)
      ),
    );
    const sendDisabled = !canRunSimplePrompt;

    // 左侧任务分组：运行中 vs 已完成。
    const runningSessions = visibleSessions.filter((s) => s.status === 'running' || s.status === 'creating' || s.status === 'idle');
    const finishedSessions = visibleSessions.filter((s) => s.status === 'stopped' || s.status === 'failed' || s.status === 'stopping');
    const promptPresets = [
      '巡检当前仓库，找一个小问题并给出修复计划',
      '读取 README 和最近 changelog，总结这个功能怎么验收',
      '运行只读检查，整理失败原因和下一步动作',
    ];

    // 运行中且最后一块不是 Agent 回复 = 还在干活，给"已等待 Xs"反馈（规则 #6）。
    const lastBlock = timelineBlocks[timelineBlocks.length - 1];
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant') ?? null;
    const awaitingAgent = isLiveStatus
      && (!lastBlock || lastBlock.type !== 'msg' || lastBlock.msg.role !== 'assistant');
    let waitedSec = 0;
    if (awaitingAgent) {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const base = lastUser ? new Date(lastUser.createdAt).getTime() : nowTick;
      waitedSec = Math.max(0, Math.round((nowTick - base) / 1000));
    }
    const sessionStartedAt = activeSession?.startedAt ? new Date(activeSession.startedAt) : activeSession?.createdAt ? new Date(activeSession.createdAt) : null;
    const sessionEndedAt = activeSession?.stoppedAt ? new Date(activeSession.stoppedAt) : null;
    const elapsedSeconds = sessionStartedAt
      ? Math.max(0, Math.round(((sessionEndedAt?.getTime() ?? nowTick) - sessionStartedAt.getTime()) / 1000))
      : 0;
    const timeoutSeconds = activeSession?.timeoutSeconds ?? activeRuntimeProfile?.timeoutSeconds ?? 900;
    const timeoutAt = sessionStartedAt ? new Date(sessionStartedAt.getTime() + timeoutSeconds * 1000) : null;
    const timeoutReached = Boolean(timeoutAt && nowTick >= timeoutAt.getTime() && ['running', 'creating', 'stopping'].includes(activeSession?.status ?? ''));
    const lastSeq = latestEventSeq(events);
    const stopState = activeSession?.status === 'stopping'
      ? '停止中'
      : activeSession?.status === 'stopped'
        ? '已停止'
        : runtimeDiagnostics.cancelEvidence.eventCount > 0
          ? runtimeDiagnostics.cancelEvidence.latestMessage || '已有取消事件'
          : '未触发';
    const timeoutState = timeoutReached
      ? '已到达 timeout'
      : timeoutAt
        ? `${formatDuration(Math.max(0, Math.round((timeoutAt.getTime() - nowTick) / 1000)))} 后超时`
        : `启动后 ${formatDuration(timeoutSeconds)}`;
    const simpleTelemetry = [
      { label: '任务状态', value: activeSession ? statusLabel(activeSession.status) : '未创建', detail: activeSession?.currentRuntimeRunId ? `run ${shortId(activeSession.currentRuntimeRunId, 10)}` : '可一键创建并运行' },
      { label: 'traceId', value: activeSession ? shortId(activeSession.traceId, 14) : '待生成', detail: activeSession?.cdsSessionId ? `CDS ${shortId(activeSession.cdsSessionId, 10)}` : 'MAP/CDS 全链路定位' },
      { label: '耗时', value: sessionStartedAt ? formatDuration(elapsedSeconds) : '未启动', detail: sessionStartedAt ? `started ${formatClockTime(sessionStartedAt)}` : '启动后开始计时' },
      { label: 'timeoutAt', value: timeoutAt ? formatClockTime(timeoutAt) : '待计算', detail: timeoutState },
      { label: 'lastEventSeq', value: String(lastSeq), detail: eventStreamHealthy ? 'SSE live' : events.length > 0 ? '分页回放' : '暂无事件' },
      { label: 'Stop', value: stopState, detail: runtimeDiagnostics.cancelEvidence.eventCount > 0 ? runtimeDiagnostics.cancelEvidence.latestMessage || runtimeDiagnostics.cancelState : runtimeDiagnostics.cancelState },
      { label: '产物入口', value: `${artifacts.length}`, detail: artifacts.length > 0 ? '右侧可查看和复制' : '等待 diff / 日志 / 快照' },
    ];
    return (
      <div className="h-full min-h-0 flex flex-col overflow-y-auto px-4 py-5 text-white sm:px-6" style={{ background: '#0F172A' }}>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">CDS Agent</h1>
            <p className="mt-1 text-sm text-white/55">告诉它要做什么，它会在远程沙箱里读代码、改文件、跑测试，过程实时可见。</p>
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

        <div className="mt-4">
          {executionRunway}
        </div>

        <section className="mt-3 rounded-xl p-3" style={{ background: '#111827', border: '1px solid rgba(148,163,184,0.18)' }}>
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_160px]">
            <div className="min-w-0 rounded-lg p-3" style={{ background: 'rgba(15,23,42,0.72)', border: '1px solid rgba(148,163,184,0.12)' }}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-white/36">1. 目标</div>
              <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_96px]">
                <input
                  value={draft.gitRepository}
                  onChange={(e) => setDraft((prev) => ({ ...prev, gitRepository: e.target.value }))}
                  placeholder="仓库 URL，可留空使用默认 workspace"
                  className="min-h-10 rounded-md px-3 text-sm text-white outline-none placeholder:text-white/30"
                  style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.08)' }}
                />
                <input
                  value={draft.gitRef}
                  onChange={(e) => setDraft((prev) => ({ ...prev, gitRef: e.target.value }))}
                  placeholder="main"
                  className="min-h-10 rounded-md px-3 text-sm text-white outline-none placeholder:text-white/30"
                  style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.08)' }}
                />
              </div>
            </div>
            <div className="min-w-0 rounded-lg p-3" style={{ background: 'rgba(15,23,42,0.72)', border: '1px solid rgba(148,163,184,0.12)' }}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-white/36">2. 任务</div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={2}
                placeholder="例如：巡检当前仓库，找一个小问题并给出修复计划"
                className="mt-2 min-h-[56px] w-full resize-none rounded-md px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
                style={{ background: 'rgba(0,0,0,0.22)', border: '1px solid rgba(255,255,255,0.08)' }}
              />
            </div>
            <div className="rounded-lg p-3" style={{ background: 'rgba(15,23,42,0.72)', border: '1px solid rgba(148,163,184,0.12)' }}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-white/36">3. 运行</div>
              <button
                type="button"
                onClick={() => void runSimpleReadonlyReview()}
                disabled={sendDisabled}
                className="mt-2 inline-flex min-h-[56px] w-full items-center justify-center gap-2 rounded-md text-sm font-semibold disabled:opacity-45"
                style={{ background: 'rgba(34,197,94,0.13)', border: '1px solid rgba(34,197,94,0.34)', color: 'rgba(134,239,172,0.98)' }}
              >
                {busy ? <MapSpinner size={15} /> : <Play size={15} />}
                运行只读巡检
              </button>
            </div>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-3 xl:grid-cols-7">
            {simpleTelemetry.map((item) => (
              <div key={item.label} className="min-h-[72px] rounded-lg p-2.5" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <div className="text-[11px] text-white/36">{item.label}</div>
                <div className="mt-1 truncate text-sm font-semibold text-white/78">{item.value}</div>
                <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-white/42">{item.detail}</div>
              </div>
            ))}
          </div>
        </section>

        <div className="mt-3 grid min-h-0 flex-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
          <aside className="min-h-0 flex flex-col rounded-xl p-3" style={{ background: '#111827', border: '1px solid rgba(148,163,184,0.18)' }}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-white/60">我的任务</span>
              <button
                type="button"
                onClick={() => void createSession()}
                disabled={!canCreateSession || busy}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs disabled:opacity-45"
                style={{ background: 'rgba(99,179,237,0.15)', border: '1px solid rgba(99,179,237,0.34)', color: 'rgba(186,230,253,0.95)' }}
              >
                <Plus size={12} /> 新任务
              </button>
            </div>
            {!canCreateSession && (
              <div className="mb-2 rounded-md px-2 py-1.5 text-xs leading-relaxed text-amber-100/80" style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.24)' }}>
                {activeProfileBlockReason || activeRuntimePoolBlockReason || '请先在专业模式选择 CDS 连接和模型配置。'}
                {activeProfileBlockReason && (
                  <button
                    type="button"
                    onClick={() => void applyAnthropicOfficialTemplate()}
                    className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs"
                    style={{ background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.34)', color: 'rgba(253,230,138,0.95)' }}
                  >
                    <Server size={12} /> Anthropic 官方模板
                  </button>
                )}
              </div>
            )}
            <label className="mb-3 flex items-center gap-2 rounded-md px-2 py-1.5" style={{ background: 'rgba(15,23,42,0.82)', border: '1px solid rgba(148,163,184,0.14)' }}>
              <Search size={13} className="text-white/35" />
              <input
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-white/32"
                placeholder="搜索任务、模型、状态"
              />
            </label>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
              {sortedSessions.length === 0 ? (
                <div className="flex h-full min-h-[120px] items-center justify-center rounded-lg text-center text-xs text-white/40" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  还没有任务，点「新任务」开始
                </div>
              ) : visibleSessions.length === 0 ? (
                <div className="flex min-h-[120px] items-center justify-center rounded-lg text-center text-xs text-white/40" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  没有匹配的任务
                </div>
              ) : (
                ([
                  ['运行中', runningSessions],
                  ['已完成', finishedSessions],
                ] as const).filter(([, list]) => list.length > 0).map(([groupLabel, list]) => (
                  <div key={groupLabel} className="space-y-1.5">
                    <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-white/35">{groupLabel} · {list.length}</div>
                    {list.map((session) => {
                      const selected = session.id === activeSession?.id;
                      const live = session.status === 'running' || session.status === 'creating';
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => setActiveSessionId(session.id)}
                          className="block w-full rounded-lg px-3 py-2 text-left"
                          style={{
                            background: selected ? 'rgba(99,179,237,0.14)' : 'rgba(0,0,0,0.16)',
                            border: selected ? '1px solid rgba(99,179,237,0.32)' : '1px solid rgba(255,255,255,0.06)',
                          }}
                        >
                          <div className="flex items-center gap-1.5">
                            {live && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />}
                            <span className="truncate text-sm text-white/78">{session.title}</span>
                          </div>
                          <div className="mt-1 text-xs text-white/42">{statusLabel(session.status)} · {new Date(session.updatedAt).toLocaleString()}</div>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </aside>

          <section className="min-h-0 flex flex-col rounded-xl p-3" style={{ background: '#111827', border: '1px solid rgba(148,163,184,0.18)' }}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white/78">{activeSession ? activeSession.title : '未选择任务'}</div>
                <div className="mt-0.5 truncate text-xs text-white/42">
                  {activeSession ? `${statusLabel(activeSession.status)} · ${activeSessionProfile?.model ?? activeProfile?.model ?? '未配置模型'}` : '从左侧选择或新建一个任务'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {activeSession && canStartActiveSession && (
                  <button
                    type="button"
                    onClick={() => void startSession()}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm disabled:opacity-45"
                    style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: 'rgba(134,239,172,0.95)' }}
                  >
                    <Play size={14} /> {primaryActionLabel(activeSession.status)}
                  </button>
                )}
                {activeSession && (activeSession.status === 'running' || activeSession.status === 'creating') && (
                  <button
                    type="button"
                    onClick={() => void stopSession()}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm disabled:opacity-45"
                    style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(252,165,165,0.95)' }}
                  >
                    <Square size={14} /> 停止
                  </button>
                )}
              </div>
            </div>

            <div ref={timelineRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-lg p-3" style={{ background: 'rgba(15,23,42,0.78)', border: '1px solid rgba(148,163,184,0.12)', overscrollBehavior: 'contain' }}>
              {!hasTimeline ? (
                <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                  <MessageSquare size={20} className="text-white/30" />
                  <div>在下方输入要做的事，例如<br />“读一下 README 的前 20 行”</div>
                </div>
              ) : (
                timelineBlocks.map((block) => {
                  if (block.type === 'msg') {
                    const isUser = block.msg.role === 'user';
                    return (
                      <article key={block.key} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className="max-w-[82%] rounded-lg px-3 py-2"
                          style={{
                            background: isUser ? 'rgba(99,179,237,0.15)' : 'rgba(255,255,255,0.045)',
                            border: isUser ? '1px solid rgba(99,179,237,0.32)' : '1px solid rgba(255,255,255,0.08)',
                          }}
                        >
                          <div className="mb-1 text-[11px] text-white/42">{messageRoleLabel(block.msg.role)} · {new Date(block.msg.createdAt).toLocaleTimeString()}</div>
                          {block.msg.role === 'assistant' && lastAssistant && block.msg.id === lastAssistant.id ? (
                            <div className="text-sm leading-relaxed text-white/78">
                              <StreamingText text={block.msg.content} streaming={isLiveStatus} mode="blur" />
                            </div>
                          ) : (
                            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-white/78">{block.msg.content}</div>
                          )}
                        </div>
                      </article>
                    );
                  }
                  const events = block.events;
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
                  const lastPayload = parsePayload(events[events.length - 1]);
                  const lastLabel = events[events.length - 1].type === 'error'
                    ? `出错：${String(lastPayload.message ?? '未知错误')}`
                    : toolActionLabel(String(lastPayload.toolName ?? ''), lastPayload);
                  const hasError = events.some((e) => e.type === 'error');
                  const headerTone = hasError
                    ? { background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.24)' }
                    : pendingApproval
                      ? { background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)' }
                      : { background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.09)' };
                  return (
                    <div key={block.key} className="flex justify-start">
                      <div className="w-full max-w-[92%] rounded-lg" style={headerTone}>
                        <button
                          type="button"
                          onClick={() => setExpandedGroups((prev) => {
                            const next = new Set(prev);
                            if (next.has(block.key)) next.delete(block.key); else next.add(block.key);
                            return next;
                          })}
                          disabled={forcedOpen}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-white/70 disabled:cursor-default"
                        >
                          <Terminal size={12} className="shrink-0" />
                          <span className="shrink-0 font-semibold">
                            {pendingApproval ? '等待审批' : hasError ? '执行过程（含错误）' : '执行过程'}
                          </span>
                          <span className="shrink-0 text-white/40">{events.length} 步 · 用时 {durationSec}s</span>
                          <span className="min-w-0 flex-1 truncate text-white/40">{open ? '' : lastLabel}</span>
                          {!forcedOpen && <span className="shrink-0 text-white/35">{open ? '收起' : '展开'}</span>}
                        </button>
                        {open && (
                          <div className="space-y-1.5 border-t border-white/10 px-3 py-2">
                            {events.map((event) => {
                              const payload = parsePayload(event);
                              const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
                              const waitingApproval = event.type === 'tool_call' && approvalId && payload.status === 'waiting';
                              const toolName = String(payload.toolName ?? '');
                              const stepOpen = simpleExpandedEventId === event.id;
                              let label: string;
                              if (event.type === 'tool_call') label = toolActionLabel(toolName, payload);
                              else if (event.type === 'tool_result') label = `完成：${toolActionLabel(toolName, payload)}`;
                              else if (event.type === 'error') label = `出错：${String(payload.message ?? '未知错误')}`;
                              else label = statusLabel(String(payload.status ?? event.type));
                              const canExpand = event.type === 'tool_call' || event.type === 'tool_result';
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
                  <div className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-white/55" style={{ background: 'rgba(99,179,237,0.1)', border: '1px solid rgba(99,179,237,0.24)' }}>
                    <MapSpinner size={13} />
                    <span>Agent 正在执行… 已等待 {waitedSec}s</span>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {promptPresets.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setPrompt(item)}
                  className="rounded-md px-2 py-1 text-xs text-white/48 hover:text-white/76"
                  style={{ background: 'rgba(15,23,42,0.72)', border: '1px solid rgba(148,163,184,0.12)' }}
                >
                  {item}
                </button>
              ))}
            </div>

            <div className="mt-2 flex gap-2">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder="告诉 Agent 要做什么…"
                className="min-h-[76px] flex-1 resize-none rounded-lg px-3 py-2 text-sm text-white outline-none"
                style={{ background: 'rgba(15,23,42,0.82)', border: '1px solid rgba(148,163,184,0.16)' }}
              />
              <button
                type="button"
                onClick={() => void runSimpleReadonlyReview()}
                disabled={sendDisabled}
                className="inline-flex w-[112px] items-center justify-center gap-2 rounded-lg text-sm font-medium disabled:opacity-45"
                style={{ background: 'rgba(99,179,237,0.17)', border: '1px solid rgba(99,179,237,0.4)', color: 'rgba(186,230,253,0.96)' }}
              >
                {busy ? <MapSpinner size={14} /> : activeSession?.manualTakeoverEnabled ? <UserCheck size={14} /> : <Send size={14} />}
                {activeSession?.manualTakeoverEnabled ? '记录' : activeSession ? '发送' : '运行'}
              </button>
            </div>
          </section>

          <aside className="min-h-0 flex flex-col gap-3 rounded-xl p-3" style={{ background: '#111827', border: '1px solid rgba(148,163,184,0.18)' }}>
            <div className="rounded-lg p-3" style={{ background: 'rgba(15,23,42,0.78)', border: gitContext.prUrl ? '1px solid rgba(34,197,94,0.24)' : '1px solid rgba(148,163,184,0.12)' }}>
              <div className="flex items-center justify-between gap-2">
                <div className="inline-flex items-center gap-2 text-xs font-semibold text-white/66"><GitPullRequest size={13} /> Pull Request</div>
                <span className="rounded px-2 py-0.5 text-[11px]" style={{ background: gitContext.prUrl ? 'rgba(34,197,94,0.13)' : 'rgba(148,163,184,0.1)', color: gitContext.prUrl ? 'rgba(134,239,172,0.95)' : 'rgba(148,163,184,0.9)' }}>
                  {gitContext.prUrl ? 'Ready' : 'Pending'}
                </span>
              </div>
              <div className="mt-3 space-y-1.5 text-xs">
                <div className="flex justify-between gap-2"><span className="text-white/40">分支</span><span className="truncate text-white/72">{gitContext.branch || '等待 Agent 创建'}</span></div>
                <div className="flex justify-between gap-2"><span className="text-white/40">提交</span><span className="truncate font-mono text-white/72">{gitContext.commit ? gitContext.commit.slice(0, 12) : 'n/a'}</span></div>
                {gitContext.prUrl ? (
                  <a href={gitContext.prUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.28)', color: 'rgba(134,239,172,0.95)' }}>
                    <Globe2 size={12} /> 打开 Pull Request
                  </a>
                ) : (
                  <div className="mt-2 rounded-md px-2 py-2 text-white/38" style={{ background: 'rgba(0,0,0,0.16)' }}>
                    Agent 产生 diff 并通过审批后，PR 会固定出现在这里。
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-xs font-semibold text-white/60"><FileText size={13} /> 产物</span>
              <button
                type="button"
                onClick={() => void collectArtifacts()}
                disabled={!activeSession || busy}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-white/55 hover:text-white/85 disabled:opacity-45"
                style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                {busy ? <MapSpinner size={11} /> : <FileSearch size={11} />} 生成产物
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
              {artifacts.length === 0 ? (
                <div className="rounded-lg px-3 py-4 text-xs text-white/42" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  <div className="font-semibold text-white/58">等待证据</div>
                  <div className="mt-2 space-y-1.5 leading-relaxed">
                    <div>1. 文件树和仓库状态会证明它看过代码。</div>
                    <div>2. diff、命令输出和日志会证明它真的执行过。</div>
                    <div>3. PR 链接或页面快照会成为最终交付物。</div>
                  </div>
                </div>
              ) : (
                artifacts.map((artifact) => (
                  <div key={artifact.id} className="rounded-lg p-2.5" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-white/72">{artifactIcon(artifact.kind)} {artifact.title}</span>
                      <button type="button" onClick={() => void copyText(artifact.title, artifact.body)} className="rounded p-1 text-white/40 hover:text-white/80" aria-label={`复制${artifact.title}`}>
                        <Copy size={12} />
                      </button>
                    </div>
                    <div className="mt-1 truncate text-xs text-white/45">{artifact.summary}</div>
                    <pre className="mt-2 max-h-[200px] overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-xs text-white/62">{artifact.body}</pre>
                  </div>
                ))
              )}
            </div>
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-5 text-white" style={{ background: 'linear-gradient(180deg, #101116 0%, #17181d 100%)' }}>
      <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
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

        <section className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
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

        {executionRunway}

        {activeSession && (
          <section
            className="rounded-xl px-4 py-3"
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

        <section className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
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
                      onClick={() => void applyAnthropicOfficialTemplate()}
                      className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs"
                      style={{ background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.34)', color: 'rgba(253,230,138,0.95)' }}
                    >
                      <Server size={12} /> 套用 Anthropic 官方模板
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
                      onClick={() => void applyAnthropicOfficialTemplate()}
                      disabled={!anthropicOfficialProfileTemplate}
                      className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs disabled:opacity-45"
                      style={{ background: 'rgba(245,158,11,0.14)', border: '1px solid rgba(245,158,11,0.34)', color: 'rgba(253,230,138,0.95)' }}
                    >
                      <KeyRound size={12} /> 准备默认 Claude 配置
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
              <div className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="inline-flex items-center gap-2 text-xs font-semibold text-white/65">
                  <ShieldCheck size={13} /> 远程页面安全边界
                </div>
                <div className="mt-2 text-xs leading-relaxed text-white/45">
                  `cds_bridge_snapshot` 只读查看远程浏览器，`cds_bridge_action` 统一走危险工具审批；navigate / spa-navigate 默认拦截 localhost、内网、链路本地和 metadata 地址，命中时返回 `bridge_url_blocked`。
                </div>
              </div>
              <div className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <div className="inline-flex items-center gap-2 text-xs font-semibold text-white/65">
                  <GitCompare size={13} /> Git 产物与 PR
                </div>
                <div className="mt-2 text-xs leading-relaxed text-white/45">
                  `repo_git_status`、`repo_git_diff` 和 `repo_create_pull_request` 会把分支、diff、测试输出和 PR 链接沉淀到事件与产物面板；`repo_create_pull_request` 属于危险工具，默认需要人工审批后才会提交分支并创建 PR。
                </div>
              </div>
              <details open={Boolean(activeProfileBlockReason || r1DefaultProfileBlocked)} className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <summary className="cursor-pointer text-xs font-semibold text-white/60">保存新模型配置</summary>
                <div className="mt-3 grid gap-2">
                  <button
                    type="button"
                    onClick={() => void applyAnthropicOfficialTemplate()}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md px-3 py-2 text-xs"
                    style={{ background: 'rgba(99,179,237,0.12)', border: '1px solid rgba(99,179,237,0.28)', color: 'rgba(186,230,253,0.92)' }}
                  >
                    <Server size={13} /> Anthropic 官方模板
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
                className="w-full rounded-md px-3 py-2 text-sm text-white outline-none"
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
                    <div className="mt-1 text-xs text-white/45">{statusLabel(session.status)} · {session.model ?? '未配置模型'}</div>
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
                  {activeSession ? `${statusLabel(activeSession.status)} · ${activeSession.runtime} · ${runtimeDiagnostics.adapter} · ${activeSession.modelBaseUrl ?? activeProfile?.baseUrl ?? '未配置 baseUrl'} · trace ${activeSession.traceId}` : '选择或新建一个远程会话'}
                </div>
                {activeSession && primaryActionHint(activeSession.status) && (
                  <div className="mt-1 text-xs text-white/40">{primaryActionHint(activeSession.status)}</div>
                )}
                {activeRuntimePoolBlockReason && (
                  <div className="mt-1 max-w-[760px] text-xs leading-relaxed text-amber-100/75">
                    {activeRuntimePoolBlockReason}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void startSession()} disabled={!activeSession || busy || !canStartActiveSession} className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm disabled:opacity-45" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: 'rgba(134,239,172,0.95)' }}>
                  <Play size={13} /> {activeSession ? primaryActionLabel(activeSession.status) : '启动'}
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
                  <div className="rounded-lg p-3" style={{ background: activeSession.manualTakeoverEnabled ? 'rgba(99,179,237,0.1)' : 'rgba(0,0,0,0.14)', border: activeSession.manualTakeoverEnabled ? '1px solid rgba(99,179,237,0.28)' : '1px solid rgba(255,255,255,0.06)' }}>
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
                <div className="rounded-lg p-3" style={{ background: 'rgba(15,23,42,0.82)', border: '1px solid rgba(148,163,184,0.16)' }}>
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
                <div className="min-h-[220px] space-y-3 overflow-auto rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)' }}>
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
                            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-white/76">{message.content}</div>
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>

                <div className="min-h-0 flex-1 space-y-2 overflow-auto rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)' }}>
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
                <div className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.14)', border: '1px solid rgba(255,255,255,0.06)' }}>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="text-xs font-semibold text-white/62">上下文</div>
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
                <div className="flex gap-2">
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                    className="min-h-[76px] flex-1 resize-none rounded-lg px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.1)' }}
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
