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

const CURRENCY_SYMBOL: Record<string, string> = { USD: '$', CNY: '¥', EUR: '€' };

/** 去掉小数尾部无意义的 0；带指数的科学计数法原样返回，避免裁掉指数位。 */
function trimZeros(text: string): string {
  if (text.includes('e') || text.includes('E')) return text;
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * 费用格式：符号前缀 + 有效位截断，而不是定长 8 位小数。
 * `USD 0.00509750`(14 字符) → `$0.005098`(9 字符)——列宽直接省一半，且小数位不再淹没量级。
 */
export function fmtCost(value?: number | null, currency?: string | null): string {
  if (value == null || !isFinite(value)) return DASH;
  const code = currency?.trim().toUpperCase() || '';
  const symbol = CURRENCY_SYMBOL[code] ?? (code ? `${code} ` : '');
  const abs = Math.abs(value);
  let amount: string;
  if (abs === 0) amount = '0';
  else if (abs >= 1) amount = value.toFixed(2);
  else if (abs >= 0.01) amount = trimZeros(value.toFixed(4));
  else {
    // 小额：保留 4 位有效数字，去掉尾部无意义的 0（0.00509750 → 0.005098）。
    // toPrecision 在极小值（如 1e-10）下会输出科学计数法 1.000e-10，
    // 此时绝不能裁尾零——那会把指数的 0 也吃掉，1.000e-10 变成 1.000e-1，金额差 9 个数量级。
    amount = trimZeros(value.toPrecision(4));
  }
  return `${symbol}${amount}`;
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
  required?: boolean;
  defaultVisible?: boolean;
}

export const GENERATIONS_COLUMNS: ColumnDef[] = [
  // 列宽 = minmax(内容下限, 按下限等比的 fr)。
  // 关键在 fr 权重与下限成正比：宽屏多出来的空间按比例摊给每一列，
  // 于是每列都有 30~50% 的均匀富余（OpenRouter 那一屏就是这个比例），
  // 而不是把余量全塞进某一列、在表格中间撑出一个空洞。
  // 全部左对齐——右对齐 + 富余会在每列中间再撑出一条空白山谷。
  { key: 'date', label: '时间', width: 'minmax(104px, 1.04fr)', required: true },
  { key: 'generation', label: '请求 ID', width: 'minmax(150px, 1.5fr)', defaultVisible: false },
  { key: 'model', label: '模型', width: 'minmax(158px, 1.58fr)' },
  { key: 'provider', label: 'Provider', width: 'minmax(140px, 1.4fr)' },
  { key: 'app', label: 'App', width: 'minmax(190px, 1.9fr)', tip: '点击查看 appCaller 摘要与治理入口' },
  { key: 'input', label: '输入', width: 'minmax(72px, 0.72fr)' },
  { key: 'output', label: '输出', width: 'minmax(72px, 0.72fr)' },
  { key: 'cost', label: '费用', width: 'minmax(88px, 0.88fr)' },
  { key: 'usage', label: '用途', width: 'minmax(84px, 0.84fr)', defaultVisible: false },
  { key: 'speed', label: '速度', width: 'minmax(88px, 0.88fr)' },
  { key: 'finish', label: '结束原因', width: 'minmax(88px, 0.88fr)', defaultVisible: false },
  { key: 'user', label: '客户端用户', width: 'minmax(120px, 1.2fr)', defaultVisible: false },
  { key: 'status', label: '状态', width: '52px', align: 'center', required: true },
];

export const UPSTREAM_COLUMNS: ColumnDef[] = [
  { key: 'date', label: '时间', width: '1.4fr', required: true },
  { key: 'model', label: '模型', width: '1.6fr' },
  { key: 'provider', label: '最终 Provider', width: '1.3fr' },
  { key: 'genId', label: '请求 ID', width: '1.8fr' },
  { key: 'status', label: '状态', width: '0.8fr', align: 'center' },
  { key: 'attempts', label: '尝试次数', width: '0.8fr', align: 'center', tip: '未记录每次重试历史，仅有最终回退标记' },
  { key: 'fallback', label: '是否回退', width: '0.9fr' },
  { key: 'latency', label: '耗时', width: '0.9fr', align: 'right' },
];

export const SESSIONS_COLUMNS: ColumnDef[] = [
  { key: 'date', label: '时间', width: '1.6fr', required: true },
  { key: 'sessionId', label: '会话 ID', width: '1.8fr' },
  { key: 'app', label: '应用', width: '1.4fr' },
  { key: 'primaryModel', label: '主要模型', width: '1.5fr' },
  { key: 'primaryProvider', label: '主要 Provider', width: '1.3fr' },
  { key: 'supporting', label: '辅助模型', width: '1.6fr' },
  { key: 'requests', label: '请求数', width: '0.8fr', align: 'right' },
];

export type LogTableDensity = 'compact' | 'balanced' | 'comfortable';

export type LogTablePreferences = {
  visibleKeys: string[];
  order: string[];
  density: LogTableDensity;
};

export const LOG_TABLE_DENSITIES: Array<{
  key: LogTableDensity;
  label: string;
  description: string;
  rowHeight: number;
}> = [
  { key: 'compact', label: '紧凑', description: '同屏查看更多请求', rowHeight: 40 },
  { key: 'balanced', label: '均衡', description: '信息密度与可读性平衡', rowHeight: 46 },
  { key: 'comfortable', label: '舒适', description: '增加行间距，便于阅读', rowHeight: 54 },
];

export function defaultLogTablePreferences(columns: ColumnDef[]): LogTablePreferences {
  const keys = columns.map((column) => column.key);
  const visibleKeys = columns
    .filter((column) => column.defaultVisible !== false)
    .map((column) => column.key);
  return { visibleKeys, order: keys, density: 'balanced' };
}

export function normalizeLogTablePreferences(
  columns: ColumnDef[],
  value?: Partial<LogTablePreferences> | null,
): LogTablePreferences {
  const keys = columns.map((column) => column.key);
  const keySet = new Set(keys);
  const requiredKeys = columns.filter((column) => column.required).map((column) => column.key);
  const ordered = (value?.order ?? []).filter((key) => keySet.has(key));
  const order = [...ordered, ...keys.filter((key) => !ordered.includes(key))];
  const requestedVisible = (value?.visibleKeys ?? defaultLogTablePreferences(columns).visibleKeys)
    .filter((key) => keySet.has(key));
  const visibleKeys = Array.from(new Set([...requestedVisible, ...requiredKeys]));
  const density = LOG_TABLE_DENSITIES.some((item) => item.key === value?.density)
    ? value!.density as LogTableDensity
    : 'balanced';
  return { visibleKeys, order, density };
}

export function resolveLogTableColumns(columns: ColumnDef[], preferences: LogTablePreferences): ColumnDef[] {
  const byKey = new Map(columns.map((column) => [column.key, column]));
  return preferences.order
    .filter((key) => preferences.visibleKeys.includes(key))
    .map((key) => byKey.get(key))
    .filter((column): column is ColumnDef => Boolean(column));
}

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
