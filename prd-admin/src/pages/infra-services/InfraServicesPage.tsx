/**
 * 基础设施服务管理（v1：CDS 配对连接已落地）
 *
 * v1 落地能力：
 *   - 通过剪贴板配对密钥连接 CDS（spec.cds-map-pairing-protocol）
 *   - 列出 / 探活 / 删除已建立的 InfraConnection
 *
 * 后续路线（roadmap）：
 *   - 实例只读列表（合并 CDS API + 主系统配置）
 *   - 路由策略（tag-weighted / sticky-by-runId / 加权）配置
 *   - 业务级监听（active runs / 平均延迟 / 错误率）
 *   - 「去 CDS 部署」深链
 */
import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Link2, MessageSquare, Play, Plus, RefreshCw, Send, Server, ShieldCheck, Square, Terminal, Trash2 } from 'lucide-react';

import { Dialog } from '@/components/ui/Dialog';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import {
  deleteInfraConnection,
  completeCdsAuthorization,
  listInfraConnections,
  parseClipboardPreview,
  pasteInfraConnection,
  probeInfraConnection,
  startCdsAuthorization,
  type ClipboardPayloadPreview,
  type InfraConnectionPublicView,
} from '@/services/real/infraConnections';
import {
  createInfraAgentSession,
  getInfraAgentLogs,
  listInfraAgentEvents,
  listInfraAgentSessions,
  sendInfraAgentMessage,
  startInfraAgentSession,
  stopInfraAgentSession,
  type InfraAgentEventView,
  type InfraAgentSessionView,
} from '@/services/real/infraAgentSessions';

const RESPONSIBILITY_SPLIT = [
  {
    side: 'CDS（部署 / 编排 / 健康 / 升级）',
    color: 'rgba(99,179,237,0.85)',
    items: [
      'RemoteHost 远程主机登记（SSH 凭据加密存储）',
      'shared-service Project 类型（绑定 git tag/release）',
      '部署引擎：SSH + docker compose pull / up',
      '健康监控 + docker logs 聚合',
      '蓝绿 / 滚动升级 / 回滚',
      '实例发现 API 供主系统消费',
    ],
  },
  {
    side: '本系统（路由 / 调度 / 业务监听）',
    color: 'rgba(167,243,208,0.85)',
    items: [
      'ClaudeSidecarRouter 多实例路由（tag/sticky/加权）',
      'DynamicSidecarRegistry 拉 CDS 实例发现 + 静态兜底',
      'profile / 上游切换（cc-switch / DeepSeek / Kimi 等）',
      '本页：实例只读列表 + 路由策略 + 业务级监控',
      'LlmRequestLogs 写入（已有）',
    ],
  },
];

const ROADMAP_TABS = [
  { name: '实例', desc: '所有 sidecar 实例（来自 CDS + 静态配置合并），含状态/版本/region/uptime' },
  { name: '路由', desc: '配置 tag-weighted / sticky-by-runId / 加权策略，看每条 run 落到哪台' },
  { name: '监控', desc: 'active runs / p50/p99 延迟 / 错误率 / 上游分布（按 profile 聚合）' },
  { name: '配置', desc: 'profile yaml 编辑（DeepSeek / Kimi / cc-switch 等命名上游）' },
];

function formatRelative(input?: string | null): string {
  if (!input) return '从未';
  const t = new Date(input).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 0) return new Date(input).toLocaleString();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(input).toLocaleDateString();
}

function statusChipStyle(status: string): React.CSSProperties {
  switch (status) {
    case 'active':
      return {
        background: 'rgba(34,197,94,0.12)',
        color: 'rgba(134,239,172,0.95)',
        border: '1px solid rgba(34,197,94,0.35)',
      };
    case 'unreachable':
      return {
        background: 'rgba(245,158,11,0.12)',
        color: 'rgba(252,211,77,0.95)',
        border: '1px solid rgba(245,158,11,0.35)',
      };
    case 'revoked':
    default:
      return {
        background: 'rgba(239,68,68,0.12)',
        color: 'rgba(252,165,165,0.95)',
        border: '1px solid rgba(239,68,68,0.35)',
      };
  }
}

function statusLabel(status: string): string {
  if (status === 'active') return '已连接';
  if (status === 'unreachable') return '不可达';
  if (status === 'revoked') return '已撤销';
  return status;
}

function agentStatusLabel(status: string): string {
  if (status === 'creating') return '准备中';
  if (status === 'running') return '运行中';
  if (status === 'idle') return '待启动';
  if (status === 'stopping') return '停止中';
  if (status === 'stopped') return '已停止';
  if (status === 'failed') return '失败';
  return status;
}

function formatEventPayload(event: InfraAgentEventView): string {
  try {
    const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
    if (event.type === 'text_delta' && typeof payload.text === 'string') return payload.text;
    if (event.type === 'done' && typeof payload.finalText === 'string') return payload.finalText;
    return JSON.stringify(payload, null, 2);
  } catch {
    return event.payloadJson;
  }
}

export default function InfraServicesPage() {
  const [connections, setConnections] = useState<InfraConnectionPublicView[]>([]);
  const [loading, setLoading] = useState(true);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [completingAuthorization, setCompletingAuthorization] = useState(false);
  const [agentSessions, setAgentSessions] = useState<InfraAgentSessionView[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [agentEvents, setAgentEvents] = useState<InfraAgentEventView[]>([]);
  const [agentLogs, setAgentLogs] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [prompt, setPrompt] = useState('用一句话介绍这个会话');

  async function loadConnections() {
    setLoading(true);
    const res = await listInfraConnections();
    if (res.success) {
      setConnections(res.data?.items ?? []);
    } else {
      toast.error('读取连接列表失败', res.error?.message ?? '请稍后重试');
    }
    setLoading(false);
  }

  useEffect(() => {
    void loadConnections();
    void loadAgentSessions();
  }, []);

  async function loadAgentSessions() {
    const res = await listInfraAgentSessions();
    if (res.success) {
      const items = res.data?.items ?? [];
      setAgentSessions(items);
      setActiveSessionId((prev) => prev ?? items[0]?.id ?? null);
    } else {
      toast.error('读取 Agent 会话失败', res.error?.message ?? '请稍后重试');
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('cds_code');
    const state = params.get('state');
    if (!code || !state) return;

    const marker = `${code}:${state}`;
    if (sessionStorage.getItem('infra.cdsAuthorize.marker') === marker) return;
    sessionStorage.setItem('infra.cdsAuthorize.marker', marker);

    setCompletingAuthorization(true);
    completeCdsAuthorization(code, state)
      .then((res) => {
        if (res.success && res.data?.item) {
          onPasted(res.data.item);
          toast.success('CDS 连接已建立', `${res.data.item.partnerName || res.data.item.partnerId} · ${res.data.item.partnerBaseUrl}`);
          void loadConnections();
        } else {
          toast.error('CDS 授权连接失败', res.error?.message ?? '请重新发起连接');
        }
      })
      .finally(() => {
        setCompletingAuthorization(false);
        params.delete('cds_code');
        params.delete('state');
        params.delete('cds_base_url');
        const qs = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
      });
  }, []);

  async function onProbe(id: string) {
    setBusyId(id);
    const res = await probeInfraConnection(id);
    setBusyId(null);
    if (res.success) {
      const item = res.data?.item;
      if (item) {
        setConnections((prev) => prev.map((c) => (c.id === item.id ? item : c)));
      }
      if (item?.lastProbeOk) {
        toast.success('对端可达', '连接探活成功');
      } else {
        toast.warning('对端不可达', item?.lastProbeError ?? '探活失败，请检查 CDS 状态');
      }
    } else {
      toast.error('探活失败', res.error?.message ?? '请稍后重试');
    }
  }

  async function onDelete(id: string, name: string) {
    if (!window.confirm(`确认删除连接「${name}」？删除后本地无法继续调用对端，但对端的密钥需要在对端自行清理。`)) {
      return;
    }
    setBusyId(id);
    const res = await deleteInfraConnection(id);
    setBusyId(null);
    if (res.success) {
      setConnections((prev) => prev.filter((c) => c.id !== id));
      toast.success('已删除连接');
    } else {
      toast.error('删除失败', res.error?.message ?? '请稍后重试');
    }
  }

  function onPasted(item: InfraConnectionPublicView) {
    setConnections((prev) => {
      const filtered = prev.filter((c) => c.id !== item.id);
      return [item, ...filtered];
    });
  }

  const usableConnections = connections.filter((c) => c.status !== 'revoked');
  const revokedConnections = connections.filter((c) => c.status === 'revoked');
  const activeConnection = usableConnections.find((c) => c.status === 'active') ?? usableConnections[0] ?? null;
  const activeSession = agentSessions.find((s) => s.id === activeSessionId) ?? agentSessions[0] ?? null;
  const activeSessionResolvedId = activeSession?.id ?? null;

  useEffect(() => {
    if (!activeSessionResolvedId) {
      setAgentEvents([]);
      setAgentLogs('');
      return;
    }
    void refreshAgentSessionDetail(activeSessionResolvedId);
  }, [activeSessionResolvedId]);

  async function refreshAgentSessionDetail(sessionId: string) {
    const [eventsRes, logsRes] = await Promise.all([
      listInfraAgentEvents(sessionId, 0, 300),
      getInfraAgentLogs(sessionId),
    ]);
    if (eventsRes.success) setAgentEvents(eventsRes.data?.items ?? []);
    if (logsRes.success) setAgentLogs(logsRes.data?.logs ?? '');
  }

  async function onCreateAgentSession() {
    if (!activeConnection) {
      toast.warning('没有可用 CDS 连接', '请先连接或重新授权 CDS');
      return;
    }
    setAgentBusy(true);
    const res = await createInfraAgentSession({
      connectionId: activeConnection.id,
      runtime: 'claude-sdk',
      title: 'CDS Agent 测试会话',
      toolPolicy: 'confirm-dangerous',
    });
    setAgentBusy(false);
    if (!res.success || !res.data?.item) {
      toast.error('新建会话失败', res.error?.message ?? '请稍后重试');
      return;
    }
    setAgentSessions((prev) => [res.data!.item, ...prev.filter((s) => s.id !== res.data!.item.id)]);
    setActiveSessionId(res.data.item.id);
    toast.success('会话已创建');
  }

  async function onStartAgentSession() {
    if (!activeSession) return;
    setAgentBusy(true);
    const res = await startInfraAgentSession(activeSession.id);
    setAgentBusy(false);
    if (!res.success || !res.data?.item) {
      toast.error('启动会话失败', res.error?.message ?? '请确认 CDS 连接可用');
      return;
    }
    upsertSession(res.data.item);
    await refreshAgentSessionDetail(res.data.item.id);
  }

  async function onSendPrompt() {
    if (!activeSession || !prompt.trim()) return;
    setAgentBusy(true);
    const res = await sendInfraAgentMessage(activeSession.id, prompt.trim());
    setAgentBusy(false);
    if (!res.success || !res.data?.item) {
      toast.error('发送失败', res.error?.message ?? '请稍后重试');
      return;
    }
    upsertSession(res.data.item);
    await refreshAgentSessionDetail(res.data.item.id);
  }

  async function onStopAgentSession() {
    if (!activeSession) return;
    setAgentBusy(true);
    const res = await stopInfraAgentSession(activeSession.id);
    setAgentBusy(false);
    if (!res.success || !res.data?.item) {
      toast.error('停止失败', res.error?.message ?? '请稍后重试');
      return;
    }
    upsertSession(res.data.item);
    await refreshAgentSessionDetail(res.data.item.id);
  }

  function upsertSession(item: InfraAgentSessionView) {
    setAgentSessions((prev) => [item, ...prev.filter((s) => s.id !== item.id)]);
    setActiveSessionId(item.id);
  }

  function renderConnectionCard(c: InfraConnectionPublicView, allowProbe: boolean) {
    return (
      <li
        key={c.id}
        className="rounded-lg p-4 flex flex-col md:flex-row md:items-center gap-3"
        style={{
          background: 'rgba(255,255,255,0.025)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-white truncate">{c.partnerName || c.partnerId}</span>
            <span
              className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-medium"
              style={statusChipStyle(c.status)}
            >
              {statusLabel(c.status)}
            </span>
            <span className="text-[11px] text-white/40 uppercase tracking-wider">{c.partner}</span>
          </div>
          <div className="text-xs text-white/55 mt-0.5 font-mono truncate">{c.partnerBaseUrl}</div>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {c.projectId && (
              <span className="text-xs text-white/55">
                项目: <code className="px-1 py-0.5 rounded bg-white/5 text-white/80">{c.projectId}</code>
              </span>
            )}
            {c.scopes.length > 0 && (
              <div className="flex items-center gap-1 flex-wrap">
                {c.scopes.map((s) => (
                  <span
                    key={s}
                    className="text-[11px] px-1.5 py-0.5 rounded"
                    style={{
                      background: 'rgba(255,255,255,0.06)',
                      color: 'rgba(255,255,255,0.7)',
                    }}
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="text-[11px] text-white/40 mt-1.5">
            创建于 {formatRelative(c.createdAt)}
            {c.lastProbedAt
              ? ` · 上次探活${c.lastProbeOk === false ? '失败' : ''} ${formatRelative(c.lastProbedAt)}`
              : ' · 尚未探活'}
            {c.lastProbeOk === false && c.lastProbeError ? ` · ${c.lastProbeError}` : ''}
            {c.status === 'revoked' ? ' · 需删除后重新授权' : ''}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {allowProbe && (
            <button
              type="button"
              onClick={() => void onProbe(c.id)}
              disabled={busyId === c.id}
              className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: 'rgba(255,255,255,0.85)',
              }}
            >
              {busyId === c.id ? <MapSpinner size={12} /> : <RefreshCw size={12} />} 探活
            </button>
          )}
          <button
            type="button"
            onClick={() => void onDelete(c.id, c.partnerName || c.partnerId)}
            disabled={busyId === c.id}
            className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs transition-colors"
            style={{
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              color: 'rgba(252,165,165,0.95)',
            }}
          >
            <Trash2 size={12} /> 删除
          </button>
        </div>
      </li>
    );
  }

  return (
    <div
      className="flex flex-col gap-5 h-full min-h-0 overflow-y-auto"
      style={{ overscrollBehavior: 'contain', padding: '24px 28px' }}
    >
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-white">基础设施服务</h1>
          <p className="text-sm text-white/60 mt-1.5 max-w-2xl">
            shared 基础设施服务（如 claude-sdk sidecar）的连接管理、实例分布、路由策略与业务监控。
            部署 / 编排能力由 CDS 提供，本页通过 CDS 地址授权建立信任连接，配对密钥作为兜底路径保留。
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPasteOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors"
          style={{
            background: 'rgba(99,179,237,0.18)',
            color: 'rgba(186,230,253,0.98)',
            border: '1px solid rgba(99,179,237,0.45)',
          }}
        >
          <Plus size={14} /> 连接 CDS
        </button>
      </header>

      <section
        className="rounded-xl p-5"
        style={{
          background: 'rgba(34,197,94,0.06)',
          border: '1px solid rgba(34,197,94,0.25)',
        }}
      >
        <div className="flex items-start gap-3">
          <ShieldCheck size={18} style={{ color: 'rgba(134,239,172,0.95)', marginTop: 2 }} />
          <div className="text-sm text-white/85 leading-relaxed">
            <strong className="text-white">v1 已上线：</strong>
            输入 CDS 地址后跳转授权，授权完成自动回到 MAP 建立连接；无法跳转时仍可使用配对密钥兜底（
            <code className="mx-1 px-1 py-0.5 rounded bg-white/10 text-white/90">
              doc/spec.cds-map-pairing-protocol.md
            </code>
            ）。
            后续将逐步迁入实例只读列表 / 路由策略 / 业务监控等能力。
          </div>
        </div>
      </section>

      {completingAuthorization && (
        <section
          className="rounded-xl p-4 flex items-center gap-3"
          style={{
            background: 'rgba(99,179,237,0.08)',
            border: '1px solid rgba(99,179,237,0.28)',
          }}
        >
          <MapSpinner size={16} />
          <div className="text-sm text-white/80">正在完成 CDS 授权连接...</div>
        </section>
      )}

      {/* 连接列表 */}
      <section
        className="rounded-xl p-5"
        style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-2">
            <Link2 size={16} style={{ color: 'rgba(186,230,253,0.95)' }} />
            <h3 className="text-sm font-semibold text-white">已建立的连接</h3>
            <span className="text-xs text-white/40">({usableConnections.length})</span>
          </div>
          <button
            type="button"
            onClick={() => void loadConnections()}
            disabled={loading}
            className="inline-flex items-center gap-1 text-xs text-white/55 hover:text-white/85"
            title="刷新列表"
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> 刷新
          </button>
        </div>

        {loading ? (
          <div className="py-12 flex items-center justify-center">
            <MapSpinner size={20} />
          </div>
        ) : connections.length === 0 ? (
          <EmptyState onClickPaste={() => setPasteOpen(true)} />
        ) : (
          <div className="space-y-4">
            {usableConnections.length > 0 ? (
              <ul className="space-y-3">
                {usableConnections.map((c) => renderConnectionCard(c, true))}
              </ul>
            ) : (
              <div
                className="rounded-lg px-4 py-5 text-sm text-white/55"
                style={{
                  background: 'rgba(255,255,255,0.025)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                当前没有可用连接，请重新连接 CDS。
              </div>
            )}

            {revokedConnections.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 pt-1 text-xs font-semibold text-white/55">
                  <span>失效连接</span>
                  <span className="text-white/35">({revokedConnections.length})</span>
                </div>
                <ul className="space-y-3">
                  {revokedConnections.map((c) => renderConnectionCard(c, false))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <section
        className="rounded-xl p-5"
        style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-2">
            <MessageSquare size={16} style={{ color: 'rgba(167,243,208,0.9)' }} />
            <h3 className="text-sm font-semibold text-white">CDS Agent 测试台</h3>
            {activeSession && (
              <span className="text-xs text-white/45">
                {activeSession.runtime}
                {activeSession.cdsContainerName ? ` · ${activeSession.cdsContainerName}` : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadAgentSessions()}
              className="inline-flex items-center gap-1 text-xs text-white/55 hover:text-white/85"
              title="刷新会话"
            >
              <RefreshCw size={12} /> 刷新
            </button>
            <button
              type="button"
              onClick={() => void onCreateAgentSession()}
              disabled={agentBusy || !activeConnection}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-45"
              style={{
                background: 'rgba(99,179,237,0.16)',
                border: '1px solid rgba(99,179,237,0.35)',
                color: 'rgba(186,230,253,0.96)',
              }}
            >
              <Plus size={13} /> 新建会话
            </button>
          </div>
        </div>

        {!activeConnection ? (
          <div
            className="rounded-lg px-4 py-5 text-sm text-white/60"
            style={{
              background: 'rgba(245,158,11,0.08)',
              border: '1px solid rgba(245,158,11,0.22)',
            }}
          >
            当前没有 active CDS 连接。请先完成 CDS 授权；失效连接不会参与 Agent 测试。
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
            <div
              className="rounded-lg p-3 min-h-[280px]"
              style={{
                background: 'rgba(255,255,255,0.025)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}
            >
              <div className="text-xs font-semibold text-white/60 mb-2">会话列表</div>
              {agentSessions.length === 0 ? (
                <div className="text-sm text-white/45 leading-relaxed py-8">
                  还没有会话。点击“新建会话”后，MAP 会创建本地会话并在启动时绑定 CDS worker。
                </div>
              ) : (
                <div className="space-y-2">
                  {agentSessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      onClick={() => setActiveSessionId(session.id)}
                      className="w-full text-left rounded-md px-3 py-2 transition-colors"
                      style={{
                        background: session.id === activeSession?.id ? 'rgba(99,179,237,0.14)' : 'rgba(255,255,255,0.03)',
                        border: session.id === activeSession?.id ? '1px solid rgba(99,179,237,0.35)' : '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-white truncate">{session.title}</span>
                        <span className="text-[11px] text-white/55">{agentStatusLabel(session.status)}</span>
                      </div>
                      <div className="text-[11px] text-white/40 font-mono truncate mt-1">
                        {session.cdsSessionId ?? session.id}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="min-w-0 space-y-3">
              <div
                className="rounded-lg p-3"
                style={{
                  background: 'rgba(255,255,255,0.025)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-sm font-semibold text-white">{activeSession?.title ?? '未选择会话'}</div>
                    <div className="text-xs text-white/45 mt-1">
                      {activeSession
                        ? `状态 ${agentStatusLabel(activeSession.status)} · 项目 ${activeSession.cdsProjectId}`
                        : '请选择或新建一个会话'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void onStartAgentSession()}
                      disabled={agentBusy || !activeSession || activeSession.status === 'running'}
                      className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs disabled:opacity-45"
                      style={{
                        background: 'rgba(34,197,94,0.12)',
                        border: '1px solid rgba(34,197,94,0.3)',
                        color: 'rgba(134,239,172,0.96)',
                      }}
                    >
                      <Play size={12} /> 启动
                    </button>
                    <button
                      type="button"
                      onClick={() => void onStopAgentSession()}
                      disabled={agentBusy || !activeSession || activeSession.status === 'stopped'}
                      className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs disabled:opacity-45"
                      style={{
                        background: 'rgba(239,68,68,0.08)',
                        border: '1px solid rgba(239,68,68,0.28)',
                        color: 'rgba(252,165,165,0.95)',
                      }}
                    >
                      <Square size={12} /> 停止
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex gap-2">
                  <input
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    disabled={!activeSession || agentBusy}
                    className="flex-1 min-w-0 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/35 outline-none"
                    style={{
                      background: 'rgba(0,0,0,0.22)',
                      border: '1px solid rgba(255,255,255,0.1)',
                    }}
                    placeholder="输入 prompt"
                  />
                  <button
                    type="button"
                    onClick={() => void onSendPrompt()}
                    disabled={!activeSession || agentBusy || !prompt.trim()}
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-45"
                    style={{
                      background: 'rgba(99,179,237,0.16)',
                      border: '1px solid rgba(99,179,237,0.35)',
                      color: 'rgba(186,230,253,0.96)',
                    }}
                  >
                    {agentBusy ? <MapSpinner size={13} /> : <Send size={13} />} 发送
                  </button>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <div
                  className="rounded-lg p-3 min-h-[260px]"
                  style={{
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <div className="text-xs font-semibold text-white/60 mb-2">事件时间线</div>
                  <div className="space-y-2 max-h-[360px] overflow-auto pr-1">
                    {agentEvents.length === 0 ? (
                      <div className="text-sm text-white/40 py-8">暂无事件。启动或发送消息后会出现状态、工具调用和输出事件。</div>
                    ) : (
                      agentEvents.map((event) => (
                        <div
                          key={event.id}
                          className="rounded-md px-3 py-2"
                          style={{
                            background: 'rgba(0,0,0,0.18)',
                            border: '1px solid rgba(255,255,255,0.06)',
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-white/80">{event.type}</span>
                            <span className="text-[11px] text-white/35">#{event.seq}</span>
                          </div>
                          <pre className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-white/55">
                            {formatEventPayload(event)}
                          </pre>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div
                  className="rounded-lg p-3 min-h-[260px]"
                  style={{
                    background: 'rgba(255,255,255,0.025)',
                    border: '1px solid rgba(255,255,255,0.08)',
                  }}
                >
                  <div className="flex items-center gap-2 text-xs font-semibold text-white/60 mb-2">
                    <Terminal size={13} /> 日志
                  </div>
                  <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed text-white/55">
                    {agentLogs || '暂无日志。'}
                  </pre>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        {RESPONSIBILITY_SPLIT.map((block) => (
          <div
            key={block.side}
            className="rounded-xl p-5"
            style={{
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="w-1 h-4 rounded-sm" style={{ background: block.color }} />
              <h3 className="text-sm font-semibold text-white">{block.side}</h3>
            </div>
            <ul className="space-y-1.5 text-sm text-white/70">
              {block.items.map((it) => (
                <li key={it} className="flex gap-2">
                  <span className="text-white/30 select-none">·</span>
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section
        className="rounded-xl p-5"
        style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <div className="flex items-center gap-2 mb-4">
          <Server size={16} style={{ color: 'rgba(167,243,208,0.9)' }} />
          <h3 className="text-sm font-semibold text-white">路线图：本页未来 4 个 tab</h3>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {ROADMAP_TABS.map((t) => (
            <div
              key={t.name}
              className="rounded-lg px-3.5 py-3"
              style={{
                background: 'rgba(255,255,255,0.025)',
                border: '1px dashed rgba(255,255,255,0.08)',
              }}
            >
              <div className="text-sm font-medium text-white/85 mb-1">{t.name}</div>
              <div className="text-xs text-white/55 leading-relaxed">{t.desc}</div>
            </div>
          ))}
        </div>
      </section>

      <section
        className="rounded-xl p-5"
        style={{
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <h3 className="text-sm font-semibold text-white mb-3">相关文档</h3>
        <ul className="space-y-2 text-sm">
          <li>
            <a
              href="/doc/spec.cds-map-pairing-protocol.md"
              className="inline-flex items-center gap-1.5 text-blue-300 hover:text-blue-200"
            >
              spec.cds-map-pairing-protocol.md
              <ExternalLink size={12} />
            </a>
            <span className="text-white/45 ml-2">配对协议 v1（已落地）</span>
          </li>
          <li>
            <a
              href="/doc/plan.cds-shared-service-extension.md"
              className="inline-flex items-center gap-1.5 text-blue-300 hover:text-blue-200"
            >
              plan.cds-shared-service-extension.md
              <ExternalLink size={12} />
            </a>
            <span className="text-white/45 ml-2">CDS 端扩展提案</span>
          </li>
          <li>
            <a
              href="/doc/design.claude-sdk-executor.md"
              className="inline-flex items-center gap-1.5 text-blue-300 hover:text-blue-200"
            >
              design.claude-sdk-executor.md
              <ExternalLink size={12} />
            </a>
            <span className="text-white/45 ml-2">claude-sdk 执行器架构</span>
          </li>
        </ul>
      </section>

      <PasteDialog
        open={pasteOpen}
        onClose={() => setPasteOpen(false)}
        onSuccess={(item) => {
          onPasted(item);
          setPasteOpen(false);
          toast.success('CDS 连接已建立', `${item.partnerName || item.partnerId} · ${item.partnerBaseUrl}`);
        }}
      />
    </div>
  );
}

function EmptyState({ onClickPaste }: { onClickPaste: () => void }) {
  return (
    <div
      className="rounded-lg py-10 px-6 flex flex-col items-center text-center"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: '1px dashed rgba(255,255,255,0.12)',
      }}
    >
      <Link2 size={28} style={{ color: 'rgba(186,230,253,0.7)' }} />
      <div className="mt-3 text-sm font-semibold text-white/90">还没有连接</div>
      <div className="mt-1.5 text-xs text-white/55 max-w-md leading-relaxed">
        在 CDS「系统设置 → 对接 MAP」生成一条连接密钥，复制到剪贴板，然后回到这里粘贴即可建立连接。
        密钥有效期 10 分钟，仅含一次性配对凭据。
      </div>
      <button
        type="button"
        onClick={onClickPaste}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium"
        style={{
          background: 'rgba(99,179,237,0.18)',
          color: 'rgba(186,230,253,0.98)',
          border: '1px solid rgba(99,179,237,0.45)',
        }}
      >
        <Plus size={14} /> 连接 CDS
      </button>
    </div>
  );
}

function PasteDialog({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: (item: InfraConnectionPublicView) => void;
}) {
  const [text, setText] = useState('');
  const [cdsBaseUrl, setCdsBaseUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setText('');
      setCdsBaseUrl('');
      setErrorMsg(null);
      setSubmitting(false);
      setAuthorizing(false);
    }
  }, [open]);

  const preview = useMemo<ClipboardPayloadPreview | null>(() => parseClipboardPreview(text), [text]);
  const previewExpired = useMemo(() => {
    if (!preview?.expiresAt) return false;
    const t = new Date(preview.expiresAt).getTime();
    if (Number.isNaN(t)) return false;
    return t < Date.now();
  }, [preview]);

  const trimmed = text.trim();
  const looksLikePrefix = trimmed.startsWith('cds-connect:');
  const formatHint = !trimmed
    ? null
    : !looksLikePrefix
      ? '不像 CDS 配对密钥（应以 cds-connect:v1: 开头）'
      : !preview
        ? '密钥解析失败，请检查复制是否完整'
        : null;

  async function handleSubmit() {
    if (!preview) {
      setErrorMsg(formatHint ?? '密钥格式不对，请重新复制');
      return;
    }
    if (previewExpired) {
      setErrorMsg('密钥已过期，请回到 CDS 重新生成');
      return;
    }
    setSubmitting(true);
    setErrorMsg(null);
    const res = await pasteInfraConnection(trimmed);
    setSubmitting(false);
    if (res.success && res.data?.item) {
      onSuccess(res.data.item);
    } else {
      setErrorMsg(res.error?.message ?? '连接失败，请稍后重试');
    }
  }

  async function handleAuthorize() {
    const value = cdsBaseUrl.trim();
    if (!value) {
      setErrorMsg('请输入 CDS 地址');
      return;
    }
    setAuthorizing(true);
    setErrorMsg(null);
    const res = await startCdsAuthorization(value, window.location.origin);
    setAuthorizing(false);
    if (res.success && res.data?.authorizeUrl) {
      window.location.href = res.data.authorizeUrl;
    } else {
      setErrorMsg(res.error?.message ?? '发起 CDS 授权失败，请检查地址');
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      maxWidth={620}
      title="连接 CDS"
      description="输入 CDS 地址跳转授权；无法跳转时可继续使用配对密钥兜底。"
      content={
        <div className="flex flex-col gap-4">
          <div
            className="rounded-lg p-3"
            style={{
              background: 'rgba(99,179,237,0.06)',
              border: '1px solid rgba(99,179,237,0.22)',
            }}
          >
            <label className="block text-xs font-medium text-white/70 mb-1.5">CDS 地址</label>
            <div className="flex gap-2">
              <input
                value={cdsBaseUrl}
                onChange={(e) => setCdsBaseUrl(e.target.value)}
                placeholder="https://cds.example.com"
                autoFocus
                spellCheck={false}
                className="flex-1 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none"
                style={{
                  background: 'rgba(0,0,0,0.25)',
                  border: '1px solid rgba(255,255,255,0.12)',
                  color: 'rgba(255,255,255,0.92)',
                }}
              />
              <button
                type="button"
                onClick={() => void handleAuthorize()}
                disabled={authorizing}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium"
                style={{
                  background: 'rgba(99,179,237,0.22)',
                  color: 'rgba(186,230,253,0.98)',
                  border: '1px solid rgba(99,179,237,0.5)',
                  opacity: authorizing ? 0.6 : 1,
                }}
              >
                {authorizing ? <MapSpinner size={12} /> : <ExternalLink size={12} />}
                授权
              </button>
            </div>
            <div className="text-[11px] text-white/45 mt-2 leading-relaxed">
              MAP 会跳转到 CDS 授权页，授权完成后自动回到本页建立连接。
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-white/70 mb-1.5">CDS 配对密钥（兜底）</label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="cds-connect:v1:eyJ2ZXJzaW9uIjox..."
              spellCheck={false}
              rows={6}
              className="w-full rounded-lg px-3 py-2.5 text-sm font-mono leading-relaxed resize-none focus:outline-none"
              style={{
                background: 'rgba(0,0,0,0.25)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: 'rgba(255,255,255,0.92)',
              }}
            />
            {formatHint && (
              <div className="text-xs mt-1.5" style={{ color: 'rgba(252,211,77,0.95)' }}>
                {formatHint}
              </div>
            )}
          </div>

          {preview && (
            <div
              className="rounded-lg p-3 text-sm"
              style={{
                background: 'rgba(99,179,237,0.06)',
                border: '1px solid rgba(99,179,237,0.25)',
              }}
            >
              <div className="text-xs font-medium text-white/60 mb-1.5">请确认对端 CDS 信息：</div>
              <div className="text-xs text-white/85 space-y-0.5">
                <div>
                  <span className="text-white/55">名称：</span>
                  {preview.cdsName ?? '(未提供)'}
                </div>
                <div className="font-mono">
                  <span className="text-white/55">base URL：</span>
                  {preview.cdsBaseUrl}
                </div>
                {preview.cdsId && (
                  <div className="font-mono text-white/55">
                    <span className="text-white/55">cdsId：</span>
                    {preview.cdsId}
                  </div>
                )}
                {preview.scopes && preview.scopes.length > 0 && (
                  <div className="text-white/55">
                    <span className="text-white/55">scopes：</span>
                    {preview.scopes.join(', ')}
                  </div>
                )}
                {preview.expiresAt && (
                  <div className={previewExpired ? 'text-red-300' : 'text-white/55'}>
                    <span className="text-white/55">有效期至：</span>
                    {new Date(preview.expiresAt).toLocaleString()} {previewExpired ? '(已过期)' : ''}
                  </div>
                )}
              </div>
              <div className="text-[11px] text-white/45 mt-2 leading-relaxed">
                如果 base URL 不是你预期的 CDS 地址，请关闭弹窗并核对——切勿粘贴来源不明的密钥。
              </div>
            </div>
          )}

          {errorMsg && (
            <div
              className="rounded-lg px-3 py-2 text-xs"
              style={{
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.3)',
                color: 'rgba(252,165,165,0.98)',
              }}
            >
              {errorMsg}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md px-3 py-1.5 text-sm"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: 'rgba(255,255,255,0.85)',
              }}
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || !preview || previewExpired}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
              style={{
                background: 'rgba(99,179,237,0.22)',
                color: 'rgba(186,230,253,0.98)',
                border: '1px solid rgba(99,179,237,0.5)',
                opacity: submitting || !preview || previewExpired ? 0.6 : 1,
              }}
            >
              {submitting ? <MapSpinner size={12} /> : <Link2 size={12} />} 连接
            </button>
          </div>
        </div>
      }
    />
  );
}
