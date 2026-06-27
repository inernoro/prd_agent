// OpenRouter 风格大模型日志页 —— 自包含工具/注册表（不依赖 LlmLogsPage 内部）。
// 注册表模式（frontend-architecture.md）：列定义/时间段/指标卡集中一处，禁组件内 switch。

import type { LlmRequestLogListItem } from '@/types/admin';

export const DASH = '—';

/** tok/s = outputTokens / durationMs * 1000；不可算返回 null */
export function computeTokPerSec(outputTokens?: number | null, durationMs?: number | null): number | null {
  if (outputTokens == null || durationMs == null || durationMs <= 0) return null;
  const v = (outputTokens / durationMs) * 1000;
  if (!isFinite(v) || v <= 0) return null;
  return Math.round(v * 10) / 10;
}

/** 首字延时 ms = firstByteAt - startedAt */
export function computeTtfbMs(startedAt?: string | null, firstByteAt?: string | null): number | null {
  if (!startedAt || !firstByteAt) return null;
  const a = Date.parse(startedAt);
  const b = Date.parse(firstByteAt);
  if (isNaN(a) || isNaN(b) || b < a) return null;
  return b - a;
}

/** 紧凑毫秒/秒 */
export function fmtMs(ms?: number | null): string {
  if (ms == null || !isFinite(ms)) return DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

/** 紧凑数字（token 数）：1.2k / 12k */
export function fmtCompact(n?: number | null): string {
  if (n == null) return DASH;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}

/** 本地短时间 MM-DD HH:mm */
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

// ── 时间范围段控（写 from/to 到查询）──
export interface TimeRangePreset { key: string; label: string; days: number; }
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

// ── 状态徽章配色 ──
export function statusBadgeStyle(status?: string | null, statusCode?: number | null): { label: string; color: string; bg: string } {
  const code = statusCode ?? 0;
  if (status === 'succeeded' || (code >= 200 && code < 300)) return { label: code ? String(code) : '成功', color: '#34d399', bg: 'rgba(52,211,153,0.15)' };
  if (status === 'failed' || code >= 400) return { label: code ? String(code) : '失败', color: '#f87171', bg: 'rgba(248,113,113,0.15)' };
  if (status === 'running') return { label: '进行中', color: '#60a5fa', bg: 'rgba(96,165,250,0.15)' };
  if (status === 'cancelled') return { label: '已取消', color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' };
  return { label: status || DASH, color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' };
}

// ── 子 tab ──
export type LogsSubTab = 'generations' | 'upstream' | 'sessions' | 'apps' | 'jobs';
export const LOGS_SUBTABS: { key: LogsSubTab; label: string }[] = [
  { key: 'generations', label: 'Generations' },
  { key: 'upstream', label: 'Upstream Requests' },
  { key: 'sessions', label: 'Sessions' },
  { key: 'apps', label: '应用' },
  { key: 'jobs', label: 'Jobs' },
];

// ── 成功率配色（注册表：低于 80% 橙、低于 50% 红，否则绿）──
// frontend-architecture.md 注册表模式：着色逻辑集中一处，禁组件内散落阈值判断。
export interface SuccessRateStyle { color: string; bg: string }
const SUCCESS_RATE_THRESHOLDS: { max: number; color: string; bg: string }[] = [
  { max: 0.5, color: '#f87171', bg: 'rgba(248,113,113,0.15)' },
  { max: 0.8, color: '#fbbf24', bg: 'rgba(251,191,36,0.16)' },
  { max: Infinity, color: '#34d399', bg: 'rgba(52,211,153,0.15)' },
];

export function successRateStyle(rate?: number | null): SuccessRateStyle {
  const r = rate == null || !isFinite(rate) ? 1 : rate;
  const hit = SUCCESS_RATE_THRESHOLDS.find((t) => r < t.max) ?? SUCCESS_RATE_THRESHOLDS[SUCCESS_RATE_THRESHOLDS.length - 1];
  return { color: hit.color, bg: hit.bg };
}

/** 成功率 0-1 → 百分比文案 */
export function fmtRate(rate?: number | null): string {
  if (rate == null || !isFinite(rate)) return DASH;
  return `${(rate * 100).toFixed(rate >= 0.995 || rate <= 0.005 ? 0 : 1)}%`;
}

// ── 列定义（注册表）。render 返回字符串或 {chip} 由组件解释 ──
export interface ColumnDef {
  key: string;
  label: string;
  /** flex 基准宽度（用 minmax 网格） */
  width: string;
  align?: 'left' | 'right' | 'center';
  /** 列头 tooltip（对「—」列注明原因） */
  tip?: string;
}

// Generations 列（对标 OpenRouter）。Cost/APIKey 我们无字段 → 显示 — 并注明。
export const GENERATIONS_COLUMNS: ColumnDef[] = [
  { key: 'date', label: 'Date', width: '1.4fr' },
  { key: 'model', label: 'Model', width: '1.6fr' },
  { key: 'provider', label: 'Provider', width: '1.2fr' },
  { key: 'app', label: 'App', width: '1.8fr' },
  { key: 'input', label: 'Input', width: '0.7fr', align: 'right' },
  { key: 'output', label: 'Output', width: '0.7fr', align: 'right' },
  { key: 'cost', label: 'Cost', width: '0.7fr', align: 'right', tip: '成本计算需后端聚合模型价格，暂未提供（统一显示 —）' },
  { key: 'usage', label: 'Usage Type', width: '0.9fr', tip: '请求业务类型（chat/vision/generation 等）' },
  { key: 'speed', label: 'Speed', width: '0.8fr', align: 'right', tip: '吞吐 = outputTokens / durationMs（tok/s）' },
  { key: 'finish', label: 'Finish', width: '0.8fr', tip: '完成原因 finish_reason（旧日志未记录显示 —）' },
  { key: 'user', label: 'User', width: '1.1fr' },
  { key: 'stream', label: 'Stream', width: '0.6fr', align: 'center', tip: '是否流式（旧日志未记录显示 —）' },
];

// Upstream Requests 列。Attempts/Key 无 per-attempt 历史 → —。
export const UPSTREAM_COLUMNS: ColumnDef[] = [
  { key: 'date', label: 'Date', width: '1.4fr' },
  { key: 'model', label: 'Model', width: '1.6fr' },
  { key: 'provider', label: 'Final Provider', width: '1.3fr' },
  { key: 'genId', label: 'Generation ID', width: '1.8fr' },
  { key: 'status', label: 'Status', width: '0.8fr', align: 'center' },
  { key: 'attempts', label: 'Attempts', width: '0.8fr', align: 'center', tip: '未记录每次重试历史，仅有最终回退标记（isFallback）' },
  { key: 'fallback', label: 'Fallback', width: '0.9fr' },
  { key: 'latency', label: 'Latency', width: '0.9fr', align: 'right' },
];

// Sessions 列。Cost 无价格 → —。
export const SESSIONS_COLUMNS: ColumnDef[] = [
  { key: 'date', label: 'Date', width: '1.6fr' },
  { key: 'sessionId', label: 'Session ID', width: '1.8fr' },
  { key: 'app', label: 'App', width: '1.4fr' },
  { key: 'primaryModel', label: 'Primary Model', width: '1.5fr' },
  { key: 'primaryProvider', label: 'Primary Provider', width: '1.3fr' },
  { key: 'supporting', label: 'Supporting Models', width: '1.6fr' },
  { key: 'requests', label: 'Requests', width: '0.8fr', align: 'right' },
];

export function userLabel(it: LlmRequestLogListItem): string {
  return (it.displayName || it.username || it.userId || DASH) as string;
}

// ── 请求生命周期派生（治"不知道没发送还是没收到"）──
// 纯读侧派生：从 status/startedAt/firstByteAt/endedAt 组合出可视阶段，区分
// "已发送但还没收到首字"(sent-no-response) 与 "正在接收"(receiving)。
// 注：完全"没发出去"(StartAsync 失败/黑洞)不会有日志记录，需后端补 blackhole 落库（后续波次）。
export interface LifecycleInfo { key: string; label: string; color: string; bg: string; pulse?: boolean }

/** 阈值：已发送但超过该秒数仍无首字 → 标记"等待响应"（疑似没收到） */
const SENT_NO_FIRSTBYTE_SECONDS = 20;

export function deriveLifecycle(it: { status?: string | null; startedAt?: string | null; firstByteAt?: string | null; endedAt?: string | null }): LifecycleInfo {
  const status = it.status || '';
  if (status === 'succeeded') return { key: 'completed', label: '已完成', color: '#34d399', bg: 'rgba(52,211,153,0.15)' };
  if (status === 'failed') return { key: 'failed', label: '失败', color: '#f87171', bg: 'rgba(248,113,113,0.15)' };
  if (status === 'cancelled') return { key: 'cancelled', label: '已取消', color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' };
  if (status === 'blackhole') return { key: 'blackhole', label: '未发出', color: '#fb7185', bg: 'rgba(251,113,133,0.18)' };
  // running 态：靠 firstByteAt 区分"已收首字 / 已发未收"
  if (status === 'running') {
    if (it.firstByteAt) return { key: 'receiving', label: '接收中', color: '#60a5fa', bg: 'rgba(96,165,250,0.16)', pulse: true };
    const startedMs = it.startedAt ? Date.parse(it.startedAt) : NaN;
    const elapsedSec = isNaN(startedMs) ? 0 : (Date.now() - startedMs) / 1000;
    if (elapsedSec >= SENT_NO_FIRSTBYTE_SECONDS) return { key: 'sent-no-response', label: '已发·等响应', color: '#fbbf24', bg: 'rgba(251,191,36,0.16)', pulse: true };
    return { key: 'sending', label: '发送中', color: '#a5b4fc', bg: 'rgba(165,180,252,0.16)', pulse: true };
  }
  return { key: status || 'unknown', label: status || DASH, color: '#94a3b8', bg: 'rgba(148,163,184,0.14)' };
}

// ── 手机端核心列（mobile-first-density.md：只留核心信息，列用 fr 撑满视口、不横滚）──
// 手机寸土寸金：每个表只保留「这一行是什么 + 一个关键指标」。
export const GENERATIONS_COLUMNS_MOBILE: ColumnDef[] = [
  { key: 'model', label: 'Model', width: '2fr' },
  { key: 'output', label: 'Out', width: '0.7fr', align: 'right' },
  { key: 'speed', label: 'tok/s', width: '0.8fr', align: 'right' },
];

export const UPSTREAM_COLUMNS_MOBILE: ColumnDef[] = [
  { key: 'model', label: 'Model', width: '2fr' },
  { key: 'status', label: 'Status', width: '0.9fr', align: 'center' },
  { key: 'latency', label: 'Latency', width: '1fr', align: 'right' },
];

export const SESSIONS_COLUMNS_MOBILE: ColumnDef[] = [
  { key: 'primaryModel', label: 'Model', width: '2fr' },
  { key: 'app', label: 'App', width: '1.4fr' },
  { key: 'requests', label: 'Req', width: '0.7fr', align: 'right' },
];

// 应用聚合矩阵列：每行 = 一个应用前缀 + 类型。直接回应「按应用看混在一张表的日志」。
export const APP_SUMMARY_COLUMNS: ColumnDef[] = [
  { key: 'app', label: '应用', width: '2fr' },
  { key: 'type', label: '类型', width: '1.1fr' },
  { key: 'requests', label: '请求数', width: '0.9fr', align: 'right' },
  { key: 'successRate', label: '成功率', width: '1fr', align: 'right', tip: '成功数 / 请求数（低于 80% 橙、低于 50% 红）' },
  { key: 'failCount', label: '失败', width: '0.8fr', align: 'right' },
  { key: 'median', label: '中位时延', width: '1fr', align: 'right', tip: '该应用 + 类型请求耗时中位数' },
];

// 手机端：只留「应用 + 成功率 + 中位时延」三核心列（mobile-first-density.md）。
export const APP_SUMMARY_COLUMNS_MOBILE: ColumnDef[] = [
  { key: 'app', label: '应用', width: '1.6fr' },
  { key: 'successRate', label: '成功率', width: '0.9fr', align: 'right' },
  { key: 'median', label: '时延', width: '0.9fr', align: 'right' },
];
