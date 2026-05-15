import { useEffect, useMemo, useState } from 'react';
import { Archive, Copy, Download, FileSearch, FileText, GitCompare, Globe2, MessageSquare, MousePointerClick, PauseCircle, Play, Plus, RefreshCw, Search, Send, ShieldCheck, Square, Terminal, UserCheck } from 'lucide-react';

import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { listInfraConnections, type InfraConnectionPublicView } from '@/services/real/infraConnections';
import {
  approveInfraAgentTool,
  archiveInfraAgentSession,
  addInfraAgentManualInput,
  captureInfraAgentBrowserSnapshot,
  collectInfraAgentArtifacts,
  createInfraAgentRuntimeProfile,
  createInfraAgentSession,
  getInfraAgentLogs,
  importDefaultInfraAgentRuntimeProfile,
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
  testInfraAgentRuntimeProfile,
  updateInfraAgentRuntimeProfile,
  type InfraAgentEventView,
  type InfraAgentMessageView,
  type InfraAgentRuntimeProfileView,
  type InfraAgentSessionView,
} from '@/services/real/infraAgentSessions';

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
  const keyState = profile.hasApiKey ? '' : ' · 需重新保存 API key';
  return `${profile.name} · ${protocolLabel(profile.protocol)} · ${profile.model}${keyState}`;
}

function profileSummary(profile: InfraAgentRuntimeProfileView | null): string {
  if (!profile) return '未选择';
  const keyState = profile.hasApiKey ? '' : ' · API key 需重新保存';
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
  if (!profile.hasApiKey) return '当前模型配置的 API key 无法读取，请重新保存 API key 后再启动远程会话。';
  if (!profile.baseUrl || !profile.model) return '当前模型配置缺少 baseUrl 或 model，请补全后再启动远程会话。';
  return '';
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

function parseJsonString(value: unknown): Record<string, unknown> | null {
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

    if (typeof detail.diff === 'string' || (typeof detail.diffStat === 'string' && typeof detail.branch !== 'string')) {
      const diffStat = typeof detail.diffStat === 'string' ? detail.diffStat : '';
      const diff = typeof detail.diff === 'string' ? detail.diff : '';
      artifacts.push({
        id: `${event.id}-diff`,
        title: '代码 diff',
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
    if (detail && ('status' in detail || 'diffStat' in detail || 'diff' in detail)) {
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
          {typeof detail.diffStat === 'string' && detail.diffStat && (
            <pre className="max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-white/68">{detail.diffStat}</pre>
          )}
          {typeof detail.diff === 'string' && detail.diff && (
            <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 text-white/68">{detail.diff}</pre>
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
  const [sessions, setSessions] = useState<InfraAgentSessionView[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<InfraAgentMessageView[]>([]);
  const [events, setEvents] = useState<InfraAgentEventView[]>([]);
  const [logs, setLogs] = useState('');
  const [viewMode, setViewMode] = useState<'simple' | 'pro'>(readInitialViewMode);
  const [simpleExpandedEventId, setSimpleExpandedEventId] = useState<string | null>(null);
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
    toolPolicy: 'confirm-dangerous',
  });
  const [profileDraft, setProfileDraft] = useState({
    name: '自定义模型配置',
    runtime: 'claude-sdk',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-4-5',
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
  const activeProfileBlockReason = profileBlockReason(activeProfile);
  const activeSessionProfileBlockReason = activeSession ? profileBlockReason(activeSessionProfile) : '';
  const canUpdateActiveProfile = Boolean(activeProfile && profileDraft.apiKey.trim());
  const canCreateSession = Boolean(activeConnection && activeProfile && !activeProfileBlockReason);
  const canRunActiveSession = Boolean(activeSession && !activeSessionProfileBlockReason);
  const canStartActiveSession = Boolean(activeSession && !activeSession.manualTakeoverEnabled && canRunActiveSession && canStartFromStatus(activeSession.status));
  const canSendActiveSession = Boolean(activeSession && !activeSession.manualTakeoverEnabled && canRunActiveSession && (activeSession.status === 'running' || activeSession.status === 'idle'));
  const canRecordManualInput = Boolean(activeSession?.manualTakeoverEnabled && prompt.trim());
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
      ['资源限制', formatSessionResourcePolicy(activeSession)],
      ['工具策略', activeSession.toolPolicy],
      ['人工接管', activeSession.manualTakeoverEnabled ? `已接管 · ${activeSession.manualTakeoverReason ?? '未填写原因'}` : '未接管'],
      ['事件类型', eventTypes.length > 0 ? eventTypes.join(' / ') : '暂无事件'],
      ['审批相关事件', `${approvalEvents}`],
      ['凭据暴露', '不向前端显示 long token / API key'],
    ];
  }, [activeConnection, activeSession, activeSessionProfile, events]);

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
    void refreshDetail(activeSession.id);
  }, [activeSession?.id]);

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

  async function loadAll() {
    const [connRes, profileRes, sessionRes] = await Promise.all([
      listInfraConnections(),
      listInfraAgentRuntimeProfiles(),
      listInfraAgentSessions(100),
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
    if (sessionRes.success) {
      const items = sortSessions(sessionRes.data?.items ?? []);
      setSessions(items);
      setActiveSessionId((prev) => prev ?? items[0]?.id ?? null);
    }
  }

  async function refreshDetail(sessionId: string) {
    const [messagesRes, eventsRes, logsRes] = await Promise.all([
      listInfraAgentMessages(sessionId, 200),
      listInfraAgentEvents(sessionId, 0, 500),
      getInfraAgentLogs(sessionId),
    ]);
    if (messagesRes.success) setMessages(messagesRes.data?.items ?? []);
    if (eventsRes.success) setEvents(eventsRes.data?.items ?? []);
    if (logsRes.success) setLogs(logsRes.data?.logs ?? '');
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
    setBusy(true);
    try {
      const res = await createInfraAgentSession({
        connectionId: activeConnection.id,
        runtime: activeProfile?.runtime ?? 'claude-sdk',
        model: activeProfile?.model,
        runtimeProfileId: activeProfile?.id,
        title: draft.title,
        toolPolicy: draft.toolPolicy,
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
    const sessionId = activeSession.id;
    setBusy(true);
    try {
      const res = await sendInfraAgentMessage(sessionId, buildPromptWithContext(prompt, contextDraft));
      if (!res.success || !res.data?.item) {
        toast.error('发送失败', res.error?.message ?? '请稍后重试');
        await refreshDetail(sessionId);
        return;
      }
      upsertSession(res.data.item);
      await refreshDetail(res.data.item.id);
    } catch (err) {
      toast.error('发送失败', err instanceof Error ? err.message : '请稍后重试');
      await refreshDetail(sessionId);
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

  async function saveProfile() {
    if (!profileDraft.baseUrl.trim() || !profileDraft.model.trim() || !profileDraft.apiKey.trim()) {
      toast.warning('模型配置不完整', 'baseUrl、model 和 API key 都必填');
      return;
    }
    setBusy(true);
    const res = await createInfraAgentRuntimeProfile(profileDraft);
    setBusy(false);
    if (!res.success || !res.data?.item) {
      toast.error('保存模型配置失败', res.error?.message ?? '请检查 baseUrl、model 和 API key');
      return;
    }
    setProfiles((prev) => [res.data!.item, ...prev.filter((item) => item.id !== res.data!.item.id)]);
    setDraft((prev) => ({ ...prev, runtimeProfileId: res.data!.item.id }));
    setProfileDraft((prev) => ({ ...prev, apiKey: '' }));
    setProfileTest('');
    toast.success('模型配置已保存', '可以立即点击测试模型');
  }

  async function updateProfile() {
    if (!activeProfile) {
      toast.warning('没有可更新的模型配置');
      return;
    }
    if (!profileDraft.baseUrl.trim() || !profileDraft.model.trim() || !profileDraft.apiKey.trim()) {
      toast.warning('模型配置不完整', '更新当前配置需要重新输入 baseUrl、model 和 API key');
      return;
    }
    setBusy(true);
    const res = await updateInfraAgentRuntimeProfile(activeProfile.id, profileDraft);
    setBusy(false);
    if (!res.success || !res.data?.item) {
      toast.error('更新模型配置失败', res.error?.message ?? '请检查 baseUrl、model 和 API key');
      return;
    }
    setProfiles((prev) => [res.data!.item, ...prev.filter((item) => item.id !== res.data!.item.id)]);
    setDraft((prev) => ({ ...prev, runtimeProfileId: res.data!.item.id }));
    setProfileDraft((prev) => ({ ...prev, apiKey: '' }));
    setProfileTest('');
    toast.success('模型配置已更新', '这是一条系统级长期配置，后续会话会继续复用');
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

  function downloadText(filename: string, value: string) {
    const blob = new Blob([value], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
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
    const simpleEvents = displayedEvents.filter((event) =>
      event.type === 'tool_call'
      || event.type === 'tool_result'
      || event.type === 'error'
      || event.type === 'status');
    const sendDisabled = !activeSession || busy || !prompt.trim() || (!canSendActiveSession && !canRecordManualInput);
    return (
      <div className="h-full min-h-0 flex flex-col px-6 py-5 text-white" style={{ background: 'linear-gradient(180deg, #101116 0%, #17181d 100%)' }}>
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

        <div className="mt-4 grid min-h-0 flex-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)_300px]">
          <aside className="min-h-0 flex flex-col rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.09)' }}>
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
                {activeProfileBlockReason || '请先在专业模式选择 CDS 连接和模型配置。'}
              </div>
            )}
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
              {sortedSessions.length === 0 ? (
                <div className="flex h-full min-h-[120px] items-center justify-center rounded-lg text-center text-xs text-white/40" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  还没有任务，点「新任务」开始
                </div>
              ) : (
                sortedSessions.map((session) => {
                  const selected = session.id === activeSession?.id;
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
                      <div className="truncate text-sm text-white/78">{session.title}</div>
                      <div className="mt-1 text-xs text-white/42">{statusLabel(session.status)} · {new Date(session.updatedAt).toLocaleString()}</div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="min-h-0 flex flex-col rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.09)' }}>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-white/78">{activeSession ? activeSession.title : '未选择任务'}</div>
                <div className="mt-0.5 truncate text-xs text-white/42">
                  {activeSession ? `${statusLabel(activeSession.status)} · ${activeProfile?.model ?? '未配置模型'}` : '从左侧选择或新建一个任务'}
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

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)', overscrollBehavior: 'contain' }}>
              {messages.length === 0 && simpleEvents.length === 0 ? (
                <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 text-center text-sm text-white/40">
                  <MessageSquare size={20} className="text-white/30" />
                  <div>在下方输入要做的事，例如<br />“读一下 README 的前 20 行”</div>
                </div>
              ) : (
                <>
                  {messages.map((message) => {
                    const isUser = message.role === 'user';
                    return (
                      <article key={message.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className="max-w-[82%] rounded-lg px-3 py-2"
                          style={{
                            background: isUser ? 'rgba(99,179,237,0.15)' : 'rgba(255,255,255,0.045)',
                            border: isUser ? '1px solid rgba(99,179,237,0.32)' : '1px solid rgba(255,255,255,0.08)',
                          }}
                        >
                          <div className="mb-1 text-[11px] text-white/42">{messageRoleLabel(message.role)} · {new Date(message.createdAt).toLocaleTimeString()}</div>
                          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-white/78">{message.content}</div>
                        </div>
                      </article>
                    );
                  })}
                  {simpleEvents.map((event) => {
                    const payload = parsePayload(event);
                    const approvalId = typeof payload.approvalId === 'string' ? payload.approvalId : '';
                    const waitingApproval = event.type === 'tool_call' && approvalId && payload.status === 'waiting';
                    const toolName = String(payload.toolName ?? '');
                    const expanded = simpleExpandedEventId === event.id;
                    let label: string;
                    if (event.type === 'tool_call') label = toolActionLabel(toolName, payload);
                    else if (event.type === 'tool_result') label = `完成：${toolActionLabel(toolName, payload)}`;
                    else if (event.type === 'error') label = `出错：${String(payload.message ?? '未知错误')}`;
                    else label = statusLabel(String(payload.status ?? '状态更新'));
                    const tone = event.type === 'error'
                      ? { background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.24)', color: 'rgba(252,165,165,0.9)' }
                      : event.type === 'tool_result'
                        ? { background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: 'rgba(187,247,208,0.85)' }
                        : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.62)' };
                    const canExpand = event.type === 'tool_call' || event.type === 'tool_result';
                    return (
                      <div key={event.id} className="flex justify-start">
                        <div className="max-w-[88%] rounded-lg px-3 py-2 text-xs" style={tone}>
                          <button
                            type="button"
                            disabled={!canExpand}
                            onClick={() => setSimpleExpandedEventId((prev) => (prev === event.id ? null : event.id))}
                            className="flex items-center gap-2 text-left disabled:cursor-default"
                          >
                            {event.type === 'tool_call' && <Terminal size={12} />}
                            {event.type === 'tool_result' && <ShieldCheck size={12} />}
                            <span className="break-words">{label}</span>
                            {canExpand && <span className="text-white/35">{expanded ? '收起' : '详情'}</span>}
                          </button>
                          {expanded && canExpand && (
                            <div className="mt-1 border-t border-white/10 pt-1"><EventBody event={event} /></div>
                          )}
                          {waitingApproval && (
                            <div className="mt-2 flex gap-2">
                              <button type="button" onClick={() => void approveTool(approvalId, 'allow')} className="rounded-md px-2 py-1 text-xs" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.28)', color: 'rgba(134,239,172,0.95)' }}>允许</button>
                              <button type="button" onClick={() => void approveTool(approvalId, 'deny')} className="rounded-md px-2 py-1 text-xs" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.28)', color: 'rgba(252,165,165,0.95)' }}>拒绝</button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>

            <div className="mt-3 flex gap-2">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                placeholder="告诉 Agent 要做什么…"
                className="min-h-[76px] flex-1 resize-none rounded-lg px-3 py-2 text-sm text-white outline-none"
                style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
              <button
                type="button"
                onClick={() => void sendPrompt()}
                disabled={sendDisabled}
                className="inline-flex w-[112px] items-center justify-center gap-2 rounded-lg text-sm font-medium disabled:opacity-45"
                style={{ background: 'rgba(99,179,237,0.17)', border: '1px solid rgba(99,179,237,0.4)', color: 'rgba(186,230,253,0.96)' }}
              >
                {busy ? <MapSpinner size={14} /> : activeSession?.manualTakeoverEnabled ? <UserCheck size={14} /> : <Send size={14} />}
                {activeSession?.manualTakeoverEnabled ? '记录' : '发送'}
              </button>
            </div>
          </section>

          <aside className="min-h-0 flex flex-col rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.09)' }}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-xs font-semibold text-white/60"><FileText size={13} /> 产物</span>
              <span className="text-xs text-white/35">{artifacts.length}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto" style={{ overscrollBehavior: 'contain' }}>
              {artifacts.length === 0 ? (
                <div className="flex h-full min-h-[120px] items-center justify-center rounded-lg px-3 text-center text-xs text-white/40" style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  任务产生的文件、diff、命令结果会出现在这里
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
                  支持任意兼容服务：填入 baseUrl、model 和 API key 后保存为系统级配置，后续会话复用，不按 10 分钟过期。
                </div>
                {activeProfileBlockReason && (
                  <div className="mt-2 rounded-md px-2 py-2 text-xs leading-relaxed text-amber-100/85" style={{ background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.26)' }}>
                    {activeProfileBlockReason}
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
              <details open={Boolean(activeProfileBlockReason)} className="rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.16)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <summary className="cursor-pointer text-xs font-semibold text-white/60">保存新模型配置</summary>
                <div className="mt-3 grid gap-2">
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
                    placeholder="API key"
                    type="password"
                  />
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
                    更新会覆盖当前选中的系统级配置。API key 只保存加密值，不会回显；重新保存后长期复用。
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
                  {activeSession ? `${statusLabel(activeSession.status)} · ${activeSession.runtime} · ${activeSession.modelBaseUrl ?? activeProfile?.baseUrl ?? '未配置 baseUrl'} · trace ${activeSession.traceId}` : '选择或新建一个远程会话'}
                </div>
                {activeSession && primaryActionHint(activeSession.status) && (
                  <div className="mt-1 text-xs text-white/40">{primaryActionHint(activeSession.status)}</div>
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
                      return (
                        <article key={event.id} className="rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.035)', border: '1px solid rgba(255,255,255,0.07)' }}>
                          <div className="flex items-center justify-between gap-3">
                            <span className="text-xs font-semibold text-white/65">{event.type} #{event.seq} · {event.traceId}</span>
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
