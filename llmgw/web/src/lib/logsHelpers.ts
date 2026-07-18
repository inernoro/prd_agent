// OpenRouter 风格日志视图的自包含工具/注册表（移植自 prd-admin llmLogsView.helpers + protocolRegistry）。
// 注册表模式：列定义/时间段/指标/协议色集中一处，禁组件内 switch 硬编码。

import type { LlmLogListItem } from './types';

export const DASH = '—';

// ── 数值/时间格式化 ──
export function computeTokPerSec(outputTokens?: number | null, durationMs?: number | null): number | null {
  if (outputTokens == null || durationMs == null || durationMs <= 0) return null;
  const v = (outputTokens / durationMs) * 1000;
  if (!isFinite(v) || v <= 0) return null;
  return Math.round(v * 10) / 10;
}

export function fmtMs(ms?: number | null): string {
  if (ms == null || !isFinite(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

export function fmtCompact(n?: number | null): string {
  if (n == null) return DASH;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

export function fmtCost(value?: number | null, currency?: string | null): string {
  if (value == null || !isFinite(value)) return DASH;
  const prefix = currency?.trim().toUpperCase() || '';
  const amount = Math.abs(value) >= 1 ? value.toFixed(4) : value.toFixed(8);
  return prefix ? `${prefix} ${amount}` : amount;
}

export function fmtShortTime(iso?: string | null): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return DASH;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return DASH;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return DASH;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── 时间范围段控 ──
export interface TimeRangePreset {
  key: string;
  label: string;
  days: number;
}
export const TIME_RANGE_PRESETS: TimeRangePreset[] = [
  { key: '1d', label: '今天', days: 1 },
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '30d', label: '近 30 天', days: 30 },
];

export function rangeFromPreset(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

// ── 状态徽章配色（走 token 变量值）──
export function statusBadgeStyle(
  status?: string | null,
  statusCode?: number | null,
): { label: string; color: string; bg: string } {
  const code = statusCode ?? 0;
  if (status === 'succeeded' || (code >= 200 && code < 300))
    return { label: code ? String(code) : '成功', color: 'var(--ok)', bg: 'var(--ok-bg)' };
  if (status === 'failed' || code >= 400)
    return { label: code ? String(code) : '失败', color: 'var(--err)', bg: 'var(--err-bg)' };
  if (status === 'running') return { label: '进行中', color: 'var(--info)', bg: 'var(--info-bg)' };
  if (status === 'cancelled') return { label: '已取消', color: 'var(--text-muted)', bg: 'rgba(148,163,184,0.15)' };
  return { label: status || DASH, color: 'var(--text-muted)', bg: 'rgba(148,163,184,0.15)' };
}

// ── 仅注册后端有真实数据来源的视图 ──
export type LogsSubTab = 'generations' | 'upstream' | 'sessions';
export const LOGS_SUBTABS: { key: LogsSubTab; label: string }[] = [
  { key: 'generations', label: '请求' },
  { key: 'upstream', label: '上游调用' },
  { key: 'sessions', label: '会话' },
];

// ── 列定义（注册表）──
export interface ColumnDef {
  key: string;
  label: string;
  width: string;
  align?: 'left' | 'right' | 'center';
  tip?: string;
}

export const GENERATIONS_COLUMNS: ColumnDef[] = [
  { key: 'date', label: '时间', width: '1.1fr' },
  { key: 'generation', label: '请求 ID', width: '1.65fr' },
  { key: 'model', label: '模型', width: '1.8fr' },
  { key: 'provider', label: 'Provider', width: '1.1fr' },
  { key: 'app', label: '应用', width: '1.35fr' },
  { key: 'tokens', label: 'Token', width: '0.9fr', align: 'right' },
  { key: 'cost', label: '费用', width: '0.7fr', align: 'right', tip: '来自平台模型池价格快照与本次 token / 按次费用的估算成本；缺价格显示 —' },
  { key: 'latency', label: '耗时', width: '0.85fr', align: 'right' },
  { key: 'status', label: '状态', width: '0.75fr', align: 'center' },
  { key: 'finish', label: '结束原因', width: '0.85fr', tip: '上游返回的 finish_reason；旧记录未采集时显示 —' },
];

export const UPSTREAM_COLUMNS: ColumnDef[] = [
  { key: 'date', label: '时间', width: '1.4fr' },
  { key: 'model', label: '模型', width: '1.6fr' },
  { key: 'provider', label: '最终 Provider', width: '1.3fr' },
  { key: 'genId', label: '请求 ID', width: '1.8fr' },
  { key: 'status', label: '状态', width: '0.8fr', align: 'center' },
  { key: 'attempts', label: '尝试次数', width: '0.8fr', align: 'center', tip: '未记录每次重试历史，仅有最终回退标记' },
  { key: 'fallback', label: '是否回退', width: '0.9fr' },
  { key: 'latency', label: '耗时', width: '0.9fr', align: 'right' },
];

export const SESSIONS_COLUMNS: ColumnDef[] = [
  { key: 'date', label: '时间', width: '1.6fr' },
  { key: 'sessionId', label: '会话 ID', width: '1.8fr' },
  { key: 'app', label: '应用', width: '1.4fr' },
  { key: 'primaryModel', label: '主要模型', width: '1.5fr' },
  { key: 'primaryProvider', label: '主要 Provider', width: '1.3fr' },
  { key: 'supporting', label: '辅助模型', width: '1.6fr' },
  { key: 'requests', label: '请求数', width: '0.8fr', align: 'right' },
];

export function userLabel(it: LlmLogListItem): string {
  return (it.displayName || it.username || it.userId || DASH) as string;
}

// ── 协议 chip 注册表 ──
export interface ProtocolMeta {
  label: string;
  color: string;
  bg: string;
}

const PROTOCOL_REGISTRY: Record<string, ProtocolMeta> = {
  openai: { label: 'OpenAI', color: '#34d399', bg: 'rgba(52,211,153,0.14)' },
  claude: { label: 'Claude', color: '#c084fc', bg: 'rgba(192,132,252,0.16)' },
  exchange: { label: 'Exchange', color: '#fbbf24', bg: 'rgba(251,191,36,0.16)' },
  gemini: { label: 'Gemini', color: '#60a5fa', bg: 'rgba(96,165,250,0.16)' },
  'gemini-native': { label: 'Gemini', color: '#60a5fa', bg: 'rgba(96,165,250,0.16)' },
};

const PROTOCOL_FALLBACK: ProtocolMeta = { label: '', color: '#94a3b8', bg: 'rgba(148,163,184,0.16)' };

export function getProtocolMeta(protocol?: string | null): ProtocolMeta | null {
  if (!protocol || !protocol.trim()) return null;
  const key = protocol.trim().toLowerCase();
  const hit = PROTOCOL_REGISTRY[key];
  if (hit) return hit;
  return { ...PROTOCOL_FALLBACK, label: protocol.trim() };
}

// ── 请求生命周期派生（治"不知道没发送还是没收到"）──
export interface LifecycleInfo {
  key: string;
  label: string;
  color: string;
  bg: string;
  pulse?: boolean;
}

const SENT_NO_FIRSTBYTE_SECONDS = 20;

export function deriveLifecycle(it: {
  status?: string | null;
  startedAt?: string | null;
  firstByteAt?: string | null;
  endedAt?: string | null;
}): LifecycleInfo {
  const status = it.status || '';
  if (status === 'succeeded') return { key: 'completed', label: '已完成', color: '#34d399', bg: 'rgba(52,211,153,0.15)' };
  if (status === 'failed') return { key: 'failed', label: '失败', color: '#f87171', bg: 'rgba(248,113,113,0.15)' };
  if (status === 'cancelled') return { key: 'cancelled', label: '已取消', color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' };
  // blackhole = 日志写入失败：请求仍照常发起，但完整结果未被可靠记录。标"记录降级"而非"未发出"。
  if (status === 'blackhole') return { key: 'blackhole', label: '记录降级', color: '#fb7185', bg: 'rgba(251,113,133,0.18)' };
  if (status === 'running') {
    if (it.firstByteAt) return { key: 'receiving', label: '接收中', color: '#60a5fa', bg: 'rgba(96,165,250,0.16)', pulse: true };
    const startedMs = it.startedAt ? Date.parse(it.startedAt) : NaN;
    const elapsedSec = isNaN(startedMs) ? 0 : (Date.now() - startedMs) / 1000;
    if (elapsedSec >= SENT_NO_FIRSTBYTE_SECONDS)
      return { key: 'sent-no-response', label: '已发·等响应', color: '#fbbf24', bg: 'rgba(251,191,36,0.16)', pulse: true };
    return { key: 'sending', label: '发送中', color: '#a5b4fc', bg: 'rgba(165,180,252,0.16)', pulse: true };
  }
  return { key: status || 'unknown', label: status || DASH, color: '#94a3b8', bg: 'rgba(148,163,184,0.14)' };
}
