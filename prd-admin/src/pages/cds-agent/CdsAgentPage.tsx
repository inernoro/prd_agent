import { useEffect, useMemo, useState } from 'react';
import { Archive, Copy, Download, FileSearch, FileText, GitCompare, Globe2, MessageSquare, Play, Plus, RefreshCw, Search, Send, Square, Terminal } from 'lucide-react';

import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { listInfraConnections, type InfraConnectionPublicView } from '@/services/real/infraConnections';
import {
  approveInfraAgentTool,
  archiveInfraAgentSession,
  collectInfraAgentArtifacts,
  createInfraAgentRuntimeProfile,
  createInfraAgentSession,
  getInfraAgentLogs,
  importDefaultInfraAgentRuntimeProfile,
  listInfraAgentEvents,
  listInfraAgentMessages,
  listInfraAgentRuntimeProfiles,
  listInfraAgentSessions,
  runInfraAgentReadonlyChecks,
  sendInfraAgentMessage,
  startInfraAgentSession,
  stopInfraAgentSession,
  testInfraAgentRuntimeProfile,
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

function messageRoleLabel(role: string): string {
  if (role === 'user') return '用户';
  if (role === 'assistant') return 'Agent';
  if (role === 'tool') return '工具';
  if (role === 'system') return '系统';
  return role;
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
  const [sessionQuery, setSessionQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [testingProfile, setTestingProfile] = useState(false);
  const [profileTest, setProfileTest] = useState<string>('');
  const [prompt, setPrompt] = useState('巡检当前仓库，找出最值得修复的一个小问题，并说明准备如何提交 PR');
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
  const canCreateSession = Boolean(activeConnection && activeProfile && !activeProfileBlockReason);
  const canRunActiveSession = Boolean(activeSession && !activeSessionProfileBlockReason);
  const artifacts = useMemo(() => buildArtifacts(events, logs), [events, logs]);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (!activeSession?.id) {
      setMessages([]);
      setEvents([]);
      setLogs('');
      return;
    }
    void refreshDetail(activeSession.id);
  }, [activeSession?.id]);

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
    if (activeSessionProfileBlockReason) {
      toast.warning('模型配置不可用', activeSessionProfileBlockReason);
      return;
    }
    const sessionId = activeSession.id;
    setBusy(true);
    try {
      const res = await sendInfraAgentMessage(sessionId, prompt.trim());
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

  return (
    <div className="h-full min-h-0 overflow-y-auto px-6 py-5 text-white" style={{ background: 'linear-gradient(180deg, #101116 0%, #17181d 100%)' }}>
      <div className="mx-auto flex max-w-[1500px] flex-col gap-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">CDS Agent</h1>
            <p className="mt-1 text-sm text-white/55">在远程 CDS sandbox 中运行 Claude Code / Codex 类任务，过程、工具审批和日志都留在 MAP。</p>
          </div>
          <button
            type="button"
            onClick={() => void loadAll()}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-white/70"
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
          >
            <RefreshCw size={14} /> 刷新
          </button>
        </header>

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
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => void startSession()} disabled={!activeSession || busy || !canRunActiveSession} className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm disabled:opacity-45" style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: 'rgba(134,239,172,0.95)' }}>
                  <Play size={13} /> 启动
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
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-xs font-semibold text-white/60"><Terminal size={13} /> 事件时间线</span>
                    <span className="text-xs text-white/35">{events.length} 条</span>
                  </div>
                  {events.length === 0 ? (
                    <div className="flex h-full min-h-[220px] items-center justify-center text-sm text-white/40">启动并发送任务后，这里会显示状态、流式输出、工具调用和审批结果。</div>
                  ) : (
                    events.map((event) => {
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
                <div className="flex gap-2">
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                    className="min-h-[76px] flex-1 resize-none rounded-lg px-3 py-2 text-sm text-white outline-none"
                    style={{ background: 'rgba(0,0,0,0.24)', border: '1px solid rgba(255,255,255,0.1)' }}
                  />
                  <button type="button" onClick={() => void sendPrompt()} disabled={!activeSession || busy || !prompt.trim() || !canRunActiveSession} className="inline-flex w-[112px] items-center justify-center gap-2 rounded-lg text-sm font-medium disabled:opacity-45" style={{ background: 'rgba(99,179,237,0.17)', border: '1px solid rgba(99,179,237,0.4)', color: 'rgba(186,230,253,0.96)' }}>
                    {busy ? <MapSpinner size={14} /> : <Send size={14} />} 发送
                  </button>
                </div>
              </section>

              <aside className="min-h-0 space-y-3 rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.18)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <section>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-xs font-semibold text-white/60"><FileText size={13} /> 产物</span>
                    <span className="text-xs text-white/35">{artifacts.length}</span>
                  </div>
                  <div className="mb-2 grid grid-cols-1 gap-2 xl:grid-cols-2">
                    <button type="button" onClick={() => void collectArtifacts()} disabled={!activeSession || busy} className="inline-flex min-h-8 items-center justify-center gap-1 rounded px-2 py-1 text-xs text-white/56 hover:text-white/86 disabled:opacity-45" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {busy ? <MapSpinner size={12} /> : <FileSearch size={12} />} 生成只读产物
                    </button>
                    <button type="button" onClick={() => void runReadonlyChecks()} disabled={!activeSession || busy} className="inline-flex min-h-8 items-center justify-center gap-1 rounded px-2 py-1 text-xs text-white/56 hover:text-white/86 disabled:opacity-45" style={{ background: 'rgba(255,255,255,0.045)', border: '1px solid rgba(255,255,255,0.08)' }}>
                      {busy ? <MapSpinner size={12} /> : <Terminal size={12} />} 运行只读检查
                    </button>
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
