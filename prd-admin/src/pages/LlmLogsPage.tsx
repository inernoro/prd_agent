import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { SearchableSelect, Select } from '@/components/design';
import { Dialog } from '@/components/ui/Dialog';
import { getLlmLogDetail, getLlmLogs, getLlmLogsMeta } from '@/services';
import type { LlmRequestLog, LlmRequestLogListItem } from '@/types/admin';
import { CheckCircle, Clock, Copy, Database, Eraser, Filter, Hash, HelpCircle, ImagePlus, Loader2, MessageSquare, RefreshCw, Reply, ScanEye, Search, Server, Sparkles, StopCircle, Users, XCircle, Zap } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function codeBoxStyle(): React.CSSProperties {
  return {
    background: 'rgba(0,0,0,0.28)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 14,
    padding: 12,
    overflow: 'auto',
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
    fontSize: 12,
    lineHeight: 1.5,
    color: 'var(--text-secondary)',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };
}

const PROMPT_TOKEN_RE = /\[[A-Z0-9_]+\]/g;

function splitTextByPromptTokens(text: string): Array<{ type: 'text' | 'token'; value: string }> {
  const s = text ?? '';
  const parts: Array<{ type: 'text' | 'token'; value: string }> = [];
  if (!s) return parts;

  let lastIndex = 0;
  PROMPT_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROMPT_TOKEN_RE.exec(s)) !== null) {
    const idx = m.index;
    if (idx > lastIndex) parts.push({ type: 'text', value: s.slice(lastIndex, idx) });
    parts.push({ type: 'token', value: m[0] });
    lastIndex = idx + m[0].length;
  }
  if (lastIndex < s.length) parts.push({ type: 'text', value: s.slice(lastIndex) });
  return parts;
}

function BodyWithPromptTokens({
  text,
  onTokenClick,
}: {
  text: string;
  onTokenClick: (token: string) => void;
}) {
  const parts = useMemo(() => splitTextByPromptTokens(text), [text]);

  return (
    <div style={codeBoxStyle()}>
      {parts.map((p, i) =>
        p.type === 'token' ? (
          <span
            key={`${p.type}-${p.value}-${i}`}
            role="button"
            tabIndex={0}
            onClick={() => onTokenClick(p.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onTokenClick(p.value);
            }}
            title={`点击预览 system prompt：${p.value}`}
            style={{
              cursor: 'pointer',
              color: 'rgba(77, 163, 255, 0.95)',
              fontWeight: 800,
              textDecoration: 'underline',
              textUnderlineOffset: 2,
            }}
          >
            {p.value}
          </span>
        ) : (
          <span key={`${p.type}-${i}`}>{p.value}</span>
        )
      )}
    </div>
  );
}

function formatLocalTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function diffMs(fromIso: string | null | undefined, toIso: string | null | undefined): number | null {
  if (!fromIso || !toIso) return null;
  const a = new Date(fromIso);
  const b = new Date(toIso);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return b.getTime() - a.getTime();
}

function fmtNum(v: number | null | undefined): string {
  // 重要：null/undefined 表示“未知/未上报”，不应显示为 0
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';
}

function fmtHashOrHidden(v: string | null | undefined): string {
  const s = (v ?? '').trim();
  if (!s) return '—';
  // 超长哈希会破坏布局：按需求显示“前几位 + …”
  return s.length > 24 ? `${s.slice(0, 18)}…` : s;
}

type RequestTypeTone = 'gold' | 'green' | 'blue' | 'purple' | 'muted';

function normalizeRequestType(t: string | null | undefined): string {
  return (t ?? '').trim().toLowerCase();
}

function requestTypeToBadge(t: string | null | undefined): { label: string; title: string; tone: RequestTypeTone; icon: JSX.Element | null } {
  const v = normalizeRequestType(t);
  if (v === 'intent') return { label: '意图', title: '意图', tone: 'green', icon: <Sparkles size={12} /> };
  if (v === 'vision' || v === 'image' || v === 'imagevision') return { label: '识图', title: '识图', tone: 'blue', icon: <ScanEye size={12} /> };
  if (v === 'imagegen' || v === 'image_gen' || v === 'image-generate') return { label: '生图', title: '生图', tone: 'purple', icon: <ImagePlus size={12} /> };
  if (v === 'reasoning' || v === 'main' || v === 'chat') return { label: '推理', title: '推理', tone: 'gold', icon: <Zap size={12} /> };
  if (!v || v === 'unknown') return { label: '未知', title: '未知', tone: 'muted', icon: null };
  return { label: '未知', title: v, tone: 'muted', icon: null };
}

function requestTypeChipStyle(tone: RequestTypeTone): React.CSSProperties {
  if (tone === 'green') return { background: 'rgba(34, 197, 94, 0.12)', border: '1px solid rgba(34, 197, 94, 0.28)', color: 'rgba(34, 197, 94, 0.95)' };
  if (tone === 'blue') return { background: 'rgba(59, 130, 246, 0.12)', border: '1px solid rgba(59, 130, 246, 0.28)', color: 'rgba(59, 130, 246, 0.95)' };
  if (tone === 'purple') return { background: 'rgba(168, 85, 247, 0.12)', border: '1px solid rgba(168, 85, 247, 0.28)', color: 'rgba(168, 85, 247, 0.95)' };
  if (tone === 'gold') return { background: 'color-mix(in srgb, var(--accent-gold) 18%, transparent)', border: '1px solid color-mix(in srgb, var(--accent-gold) 35%, transparent)', color: 'var(--accent-gold-2)' };
  return { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--text-muted)' };
}

function tryPrettyJsonText(text: string): string {
  const raw = (text ?? '').trim();
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw) as unknown;
    return JSON.stringify(obj, null, 2);
  } catch {
    return text;
  }
}

function normalizeStrictJsonCandidate(raw: string): { ok: true; json: string } | { ok: false; reason: string } {
  const t0 = (raw ?? '').trim();
  if (!t0) return { ok: false, reason: '空内容' };

  // 允许 ```json ... ``` 这种“整体代码块包裹”的返回
  if (t0.startsWith('```')) {
    const m = t0.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
    if (!m) return { ok: false, reason: '代码块格式不完整（缺少闭合 ```）' };
    const inner = (m[1] ?? '').trim();
    if (!inner) return { ok: false, reason: '代码块为空' };
    if (!inner.startsWith('{') && !inner.startsWith('[')) return { ok: false, reason: '代码块内容不是 JSON（未以 { 或 [ 开头）' };
    if (!(inner.endsWith('}') || inner.endsWith(']'))) return { ok: false, reason: '代码块内容不是 JSON（未以 } 或 ] 结尾）' };
    return { ok: true, json: inner };
  }

  if (!t0.startsWith('{') && !t0.startsWith('[')) return { ok: false, reason: '不是 JSON（未以 { 或 [ 开头）' };
  if (!(t0.endsWith('}') || t0.endsWith(']'))) return { ok: false, reason: '不是 JSON（未以 } 或 ] 结尾）' };
  return { ok: true, json: t0 };
}

function validateStrictJson(raw: string): { ok: true } | { ok: false; reason: string } {
  const c = normalizeStrictJsonCandidate(raw);
  if (!c.ok) return c;
  try {
    JSON.parse(c.json);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `JSON.parse 失败：${msg}` };
  }
}

function shellSingleQuote(text: string): string {
  // Bash/zsh 安全单引号转义：' -> '"'"'
  return `'${String(text).replace(/'/g, `'"'"'`)}'`;
}

function joinBaseAndPath(apiBase: string, path: string) {
  const b = (apiBase ?? '').trim();
  const p = (path ?? '').trim();
  if (!b) return p;
  if (!p) return b;
  return `${b.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`;
}

function buildCurlFromLog(detail: LlmRequestLog): string {
  const apiBase = (detail.apiBase ?? '').trim();
  const path = (detail.path ?? '').trim();
  const url = joinBaseAndPath(apiBase, path) || 'https://api.example.com/v1/chat/completions';

  const headers: Record<string, string> = { ...(detail.requestHeadersRedacted ?? {}) };
  // 清理不适合重放的 header
  Object.keys(headers).forEach((k) => {
    const key = k.toLowerCase();
    if (key === 'content-length' || key === 'host') delete headers[k];
  });

  // 强制 API Key 占位符（避免任何真实值泄露）
  const hasAuthorization = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  const hasXApiKey = Object.keys(headers).some((k) => k.toLowerCase() === 'x-api-key');

  if (hasAuthorization || detail.provider.toLowerCase().includes('openai')) {
    headers.Authorization = 'Bearer YOUR_API_KEY';
  }
  if (hasXApiKey || detail.provider.toLowerCase().includes('claude') || detail.provider.toLowerCase().includes('anthropic')) {
    headers['x-api-key'] = 'YOUR_API_KEY';
  }

  // 默认 JSON
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  const bodyPretty = tryPrettyJsonText(detail.requestBodyRedacted || '');
  const headerArgs = Object.entries(headers)
    .filter(([k, v]) => String(k).trim() && v !== undefined && v !== null)
    .map(([k, v]) => `-H ${shellSingleQuote(`${k}: ${v}`)}`)
    .join(' \\\n  ');

  const dataArg = bodyPretty ? ` \\\n  --data-raw ${shellSingleQuote(bodyPretty)}` : '';

  return `curl -X POST ${shellSingleQuote(url)} \\\n  ${headerArgs}${dataArg}`;
}

// rawSse 已移除：管理后台仅展示最终 AnswerText 与统计信息

const MARQUEE_GAP_PX = 28;
const MARQUEE_SPEED_PX_PER_SEC = 64;

function NewsMarquee({
  text,
  title,
  align = 'left',
  style,
  className,
}: {
  text: string;
  title?: string;
  align?: 'left' | 'right';
  style?: React.CSSProperties;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLSpanElement | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [shiftPx, setShiftPx] = useState(0);
  const [durationSec, setDurationSec] = useState(0);

  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const recompute = () => {
      const containerW = container.clientWidth;
      const contentW = measure.offsetWidth;
      const need = contentW > containerW + 2; // 避免临界抖动
      const shift = contentW + MARQUEE_GAP_PX;
      setEnabled(need);
      setShiftPx(shift);
      setDurationSec(Math.max(6, shift / MARQUEE_SPEED_PX_PER_SEC));
    };

    recompute();
    const ro = new ResizeObserver(() => recompute());
    ro.observe(container);
    return () => ro.disconnect();
  }, [normalized]);

  const vars = useMemo(
    () => {
      const v: Record<'--prd-marquee-shift' | '--prd-marquee-duration' | '--prd-marquee-gap', string> = {
        '--prd-marquee-shift': `${shiftPx}px`,
        '--prd-marquee-duration': `${durationSec}s`,
        '--prd-marquee-gap': `${MARQUEE_GAP_PX}px`,
      };
      return v as unknown as React.CSSProperties;
    },
    [durationSec, shiftPx]
  );

  return (
    <div
      ref={containerRef}
      className={['prd-marquee', align === 'right' ? 'prd-marquee--right' : '', className || ''].filter(Boolean).join(' ')}
      title={title || normalized}
      // 关键：在 Grid/Flex 内必须允许收缩，否则超长不换行内容会撑爆布局
      style={{ minWidth: 0, width: '100%', ...vars, ...style }}
    >
      <div className={enabled ? 'prd-marquee__track' : 'prd-marquee__track prd-marquee__track--static'}>
        <span ref={measureRef} className="prd-marquee__item">
          {normalized || '—'}
        </span>
        {enabled ? (
          <span aria-hidden className="prd-marquee__item">
            {normalized || '—'}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function PreviewTickerRow({ it }: { it: LlmRequestLogListItem }) {
  const q = (it.questionPreview ?? '').trim();
  const a = (it.answerPreview ?? '').trim();
  const ttfb = diffMs(it.startedAt, it.firstByteAt ?? null);
  const rightText =
    it.durationMs
      ? `${it.durationMs}ms${ttfb !== null ? ` · TTFB ${ttfb}ms` : ''}`
      : ttfb !== null
        ? `TTFB ${ttfb}ms`
        : formatLocalTime(it.startedAt);

  return (
    <div
      className="mt-2 rounded-[12px] px-3 py-2"
      style={{
        border: '1px solid rgba(231,206,151,0.18)',
        background: 'rgba(231,206,151,0.045)',
      }}
    >
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: '2fr 3fr 1fr' }}>
        <div className="min-w-0 flex items-center gap-2">
          <span className="text-[11px] font-semibold shrink-0 flex items-center gap-1" style={{ color: '#E7CE97' }}>
            <HelpCircle size={12} />
            问题
          </span>
          <div className="min-w-0 flex-1 text-[11px]">
            <NewsMarquee text={q ? `：${q}` : '：未记录（已脱敏）'} />
          </div>
        </div>

        <div className="min-w-0 flex items-center gap-2">
          <span className="text-[11px] font-semibold shrink-0 flex items-center gap-1" style={{ color: '#E7CE97', opacity: 0.9 }}>
            <Reply size={12} />
            回答
          </span>
          <div className="min-w-0 flex-1 text-[11px]">
            <NewsMarquee text={a ? `：${a}` : it.status === 'running' ? '：生成中…' : '：未记录'} />
          </div>
        </div>

        <div className="min-w-0 text-right text-[11px] truncate" style={{ color: 'rgba(231,206,151,0.75)' }}>
          {rightText}
        </div>
      </div>
    </div>
  );
}

export default function LlmLogsPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<LlmRequestLogListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(30);
  const [answerView, setAnswerView] = useState<'preview' | 'raw'>('preview');
  const [answerHint, setAnswerHint] = useState<string>('');

  const [qProvider, setQProvider] = useState('');
  const [qModel, setQModel] = useState('');
  const [qStatus, setQStatus] = useState('');
  const [qRequestId, setQRequestId] = useState('');
  const [qGroupId, setQGroupId] = useState('');
  const [qSessionId, setQSessionId] = useState('');

  const [metaProviders, setMetaProviders] = useState<string[]>([]);
  const [metaModels, setMetaModels] = useState<string[]>([]);
  const [metaStatuses, setMetaStatuses] = useState<string[]>(['running', 'succeeded', 'failed', 'cancelled']);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detail, setDetail] = useState<LlmRequestLog | null>(null);
  const [copiedHint, setCopiedHint] = useState<string>('');
  const [detailOpen, setDetailOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptToken, setPromptToken] = useState<string>('');

  const load = async (opts?: { resetPage?: boolean }) => {
    if (opts?.resetPage) setPage(1);
    setLoading(true);
    try {
      const res = await getLlmLogs({
        page: opts?.resetPage ? 1 : page,
        pageSize,
        provider: qProvider || undefined,
        model: qModel || undefined,
        status: qStatus || undefined,
        requestId: qRequestId || undefined,
        groupId: qGroupId || undefined,
        sessionId: qSessionId || undefined,
      });
      if (res.success) {
        setItems(res.data.items);
        setTotal(res.data.total);
      }
    } finally {
      setLoading(false);
    }
  };

  const loadDetail = async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    setDetail(null);
    setCopiedHint('');
    try {
      const res = await getLlmLogDetail(id);
      if (res.success) setDetail(res.data);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    (async () => {
      const res = await getLlmLogsMeta();
      if (res.success) {
        setMetaProviders(res.data.providers ?? []);
        setMetaModels(res.data.models ?? []);
        setMetaStatuses(res.data.statuses ?? ['running', 'succeeded', 'failed', 'cancelled']);
      }
    })();
  }, []);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize]);
  const prettyRequestBody = useMemo(() => (detail ? tryPrettyJsonText(detail.requestBodyRedacted || '') : ''), [detail]);
  const curlText = useMemo(() => (detail ? buildCurlFromLog(detail) : ''), [detail]);
  const answerText = useMemo(() => (detail?.answerText ?? '').trim(), [detail]);
  const assembledSummary = useMemo(() => {
    if (!detail) return '';
    const chars = detail.assembledTextChars;
    const hash = (detail.assembledTextHash ?? '').trim();
    if ((chars === null || chars === undefined || chars === 0) && !hash) return '';
    return `用户可见输出（摘要字段）\nchars=${fmtNum(chars)}\nhash=${hash ? fmtHashOrHidden(hash) : '—'}\n\n说明：这里仅保留长度与哈希用于对照；具体内容请查看下方 Answer。`;
  }, [detail]);

  const statusBadge = (s: string) => {
    const v = (s || '').toLowerCase();
    if (v === 'succeeded') return <Badge variant="success" size="sm" icon={<CheckCircle size={10} />}>成功</Badge>;
    if (v === 'failed') return <Badge variant="subtle" size="sm" icon={<XCircle size={10} />}>失败</Badge>;
    if (v === 'running') return <Badge variant="subtle" size="sm" icon={<Loader2 size={10} className="animate-spin" />}>进行中</Badge>;
    if (v === 'cancelled') return <Badge variant="subtle" size="sm" icon={<StopCircle size={10} />}>已取消</Badge>;
    return <Badge variant="subtle" size="sm">{s || '-'}</Badge>;
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-input)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'var(--text-primary)',
  };

  return (
    <div className="space-y-4">
      <style>{`
        .prd-marquee{position:relative;overflow:hidden;white-space:nowrap}
        .prd-marquee__track{display:flex;align-items:center;gap:var(--prd-marquee-gap);width:max-content;will-change:transform;animation:prd-marquee var(--prd-marquee-duration) linear infinite}
        .prd-marquee__track--static{animation:none;width:100%}
        .prd-marquee--right .prd-marquee__track--static{justify-content:flex-end}
        .prd-marquee__item{display:inline-block;white-space:nowrap;font-size:inherit;line-height:inherit;color:inherit;font-family:inherit}
        @keyframes prd-marquee{from{transform:translateX(0)}to{transform:translateX(calc(-1 * var(--prd-marquee-shift)))}}
        @media (prefers-reduced-motion: reduce){.prd-marquee__track{animation:none}}
      `}</style>
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>LLM 请求日志</div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
            仅展示后端发往大模型 Provider 的请求与流式响应（仅隐藏密钥/Token；请求正文仍按后端落库策略保留摘要）
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => load()}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          刷新
        </Button>
      </div>

      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-6">
          <Select
            value={qProvider}
            onChange={(e) => setQProvider(e.target.value)}
            uiSize="sm"
            style={inputStyle}
            leftIcon={<Server size={16} />}
          >
            <option value="">provider（全部）</option>
            {metaProviders.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </Select>
          <SearchableSelect
            value={qModel}
            onValueChange={setQModel}
            options={[
              { value: '', label: 'model（全部）' },
              ...metaModels.map((m) => ({ value: m, label: m })),
            ]}
            placeholder="model（全部）"
            leftIcon={<Database size={16} />}
            uiSize="sm"
            style={inputStyle}
          />
          <Select
            value={qStatus}
            onChange={(e) => setQStatus(e.target.value)}
            uiSize="sm"
            style={inputStyle}
            leftIcon={<CheckCircle size={16} />}
          >
            <option value="">status（全部）</option>
            {metaStatuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </Select>
          <div className="relative">
            <Users size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={qGroupId}
              onChange={(e) => setQGroupId(e.target.value)}
              className="h-9 w-full rounded-[12px] pl-9 pr-3 text-sm outline-none"
              style={inputStyle}
              placeholder="groupId"
            />
          </div>
          <div className="relative">
            <Clock size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={qSessionId}
              onChange={(e) => setQSessionId(e.target.value)}
              className="h-9 w-full rounded-[12px] pl-9 pr-3 text-sm outline-none"
              style={inputStyle}
              placeholder="sessionId"
            />
          </div>
          <div className="relative">
            <Hash size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={qRequestId}
              onChange={(e) => setQRequestId(e.target.value)}
              className="h-9 w-full rounded-[12px] pl-9 pr-3 text-sm outline-none"
              style={inputStyle}
              placeholder="requestId"
            />
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            共 {total} 条 · 第 {page}/{totalPages} 页
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => load({ resetPage: true })} disabled={loading}>
              <Filter size={16} />
              应用过滤
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQProvider('');
                setQModel('');
                setQStatus('');
                setQRequestId('');
                setQGroupId('');
                setQSessionId('');
                setPage(1);
                // 立即刷新
                setTimeout(() => load({ resetPage: true }), 0);
              }}
              disabled={loading}
            >
              <Eraser size={16} />
              清空
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        <div className="p-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>请求列表</div>
        </div>
        <div className="divide-y divide-white/10">
          {loading ? (
            <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>暂无日志</div>
          ) : (
            items.map((it) => {
              const active = selectedId === it.id;
              const ttfb = diffMs(it.startedAt, it.firstByteAt ?? null);
              return (
                <div
                  key={it.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setDetailOpen(true);
                    loadDetail(it.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setDetailOpen(true);
                      loadDetail(it.id);
                    }
                  }}
                  className="px-4 py-3 cursor-pointer hover:bg-white/2"
                  style={{
                    background: active ? 'rgba(255,255,255,0.03)' : 'transparent',
                  }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                          {it.provider} · {it.model}
                        </div>
                        {statusBadge(it.status)}
                      </div>
                      <div className="mt-1 text-xs truncate flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                        <Hash size={12} />
                        <span>
                          requestId: {it.requestId}
                          {it.groupId ? ` · groupId: ${it.groupId}` : ''}
                          {it.sessionId ? ` · sessionId: ${it.sessionId}` : ''}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 min-w-0">
                        {(() => {
                          const b = requestTypeToBadge(it.requestType);
                          return (
                            <label
                              className="inline-flex items-center gap-1 rounded-full px-2.5 h-5 text-[11px] font-semibold tracking-wide shrink-0"
                              title={b.title}
                              style={requestTypeChipStyle(b.tone)}
                            >
                              {b.icon}
                              {b.label}
                            </label>
                          );
                        })()}
                        {(() => {
                          const p = String(it.requestPurpose ?? '').trim();
                          if (!p) return null;
                          return (
                            <div className="min-w-0 text-[11px] font-semibold truncate" style={{ color: 'var(--text-muted)' }} title={p}>
                              {p}
                            </div>
                          );
                        })()}
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {it.durationMs ? `${it.durationMs}ms` : '-'}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {formatLocalTime(it.startedAt)}
                        {ttfb !== null ? ` · TTFB ${ttfb}ms` : ''}
                      </div>
                      <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        in {it.inputTokens ?? '-'} / out {it.outputTokens ?? '-'}
                      </div>
                      {(it.cacheReadInputTokens || it.cacheCreationInputTokens) ? (
                        <div className="mt-1 text-[11px]" style={{ color: 'rgba(34,197,94,0.95)' }}>
                          cache read {it.cacheReadInputTokens ?? 0} · create {it.cacheCreationInputTokens ?? 0}
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {/* 底部：问题/回答滚动条（新闻样式） */}
                  <PreviewTickerRow it={it} />
                  {it.error ? (
                    <div className="mt-2 text-xs" style={{ color: 'rgba(239,68,68,0.95)' }}>
                      {it.error}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
        <div className="p-3 flex items-center justify-between" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={loading || page <= 1}>
            上一页
          </Button>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{page}/{totalPages}</div>
          <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={loading || page >= totalPages}>
            下一页
          </Button>
        </div>
      </Card>

      <Dialog
        open={detailOpen}
        onOpenChange={(open) => {
          setDetailOpen(open);
          if (!open) {
            setDetail(null);
            setSelectedId(null);
            setCopiedHint('');
            setAnswerView('preview');
            setAnswerHint('');
            setPromptOpen(false);
            setPromptToken('');
          }
        }}
        title="LLM 请求详情"
        description={detail ? `requestId: ${detail.requestId}` : '点击列表项查看详情'}
        maxWidth={1200}
        contentStyle={{ height: '82vh' }}
        content={
          detailLoading ? (
            <div className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>加载详情...</div>
          ) : !detail ? (
            <div className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>暂无详情</div>
          ) : (
            <div className="h-full min-h-0 grid gap-3 md:grid-cols-2">
              <Card className="p-3 overflow-hidden flex flex-col min-h-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Request（密钥已隐藏）</div>
                  <div className="flex items-center gap-2">
                    {copiedHint ? (
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{copiedHint}</div>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(curlText || '');
                          setCopiedHint('curl 已复制');
                          setTimeout(() => setCopiedHint(''), 1200);
                        } catch {
                          setCopiedHint('复制失败（浏览器权限）');
                          setTimeout(() => setCopiedHint(''), 2000);
                        }
                      }}
                      disabled={!detail || !curlText}
                    >
                      <Copy size={16} />
                      复制 curl
                    </Button>
                  </div>
                </div>
                <div className="mt-1 grid gap-1.5" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
                  {[
                    { k: 'provider', v: detail.provider || '—' },
                    { k: 'model', v: detail.model || '—' },
                    { k: 'status', v: detail.status || '—' },
                    { k: 'requestId', v: detail.requestId || '—' },
                    { k: 'requestType', v: detail.requestType || '—' },
                    { k: 'requestPurpose', v: detail.requestPurpose || '—' },
                    { k: 'groupId', v: detail.groupId || '—' },
                    { k: 'sessionId', v: detail.sessionId || '—' },
                    { k: 'startedAt', v: formatLocalTime(detail.startedAt) },
                    { k: 'firstByteAt', v: formatLocalTime(detail.firstByteAt ?? null) },
                    { k: 'endedAt', v: formatLocalTime(detail.endedAt ?? null) },
                    {
                      k: 'TTFB',
                      v: diffMs(detail.startedAt, detail.firstByteAt ?? null) !== null ? `${diffMs(detail.startedAt, detail.firstByteAt ?? null)}ms` : '—',
                    },
                  ].map((row) => (
                    <div
                      key={row.k}
                      className="rounded-[12px] px-2.5 py-1.5 min-w-0"
                      style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', minWidth: 0 }}
                    >
                      <div className="flex items-center gap-2">
                        <div className="text-[11px] font-medium shrink-0" style={{ color: 'var(--text-muted)' }}>
                          {row.k}
                        </div>
                        <NewsMarquee
                          align="right"
                          text={String(row.v ?? '—')}
                          title={String(row.v ?? '')}
                          className="flex-1 min-w-0"
                          style={{
                            color: 'var(--text-secondary)',
                            fontSize: 12,
                            lineHeight: '1.2',
                            fontWeight: 700,
                            fontFamily:
                              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif',
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex-1 min-h-0 overflow-auto space-y-3">
                  <div>
                    <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>headers</div>
                    <pre style={codeBoxStyle()}>{JSON.stringify(detail.requestHeadersRedacted ?? {}, null, 2)}</pre>
                  </div>
                  <div>
                    {(() => {
                      const raw = detail.requestBodyRedacted || '';
                      const isTruncated = Boolean(detail.requestBodyTruncated) || raw.includes('[TRUNCATED]');
                      const orig = detail.requestBodyChars ?? null;
                      const stored = raw.length;
                      const hint = isTruncated ? `（已截断：stored ${stored}${orig != null ? ` / original ${orig}` : ''} chars）` : `（${stored} chars）`;
                      return (
                        <div className="text-xs mb-2 flex items-center justify-between gap-2" style={{ color: 'var(--text-muted)' }}>
                          <span>body</span>
                          <span className={isTruncated ? 'text-[11px] font-semibold' : 'text-[11px]'} style={{ color: isTruncated ? 'rgba(255, 160, 160, 0.95)' : 'var(--text-muted)' }}>
                            {hint}
                          </span>
                        </div>
                      );
                    })()}
                    <BodyWithPromptTokens
                      text={prettyRequestBody || ''}
                      onTokenClick={(token) => {
                        setPromptToken(token);
                        setPromptOpen(true);
                      }}
                    />
                  </div>
                </div>
                <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  systemPromptChars: {detail.systemPromptChars ?? '-'} · documentChars: {detail.documentChars ?? '-'}
                </div>
              </Card>

              <Card className="p-3 overflow-hidden flex flex-col min-h-0">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Response</div>
                <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  statusCode: {detail.statusCode ?? '-'} · duration: {detail.durationMs ?? '-'}ms
                </div>
                <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
                  {[
                    { k: 'Input tokens（输入）', v: fmtNum(detail.inputTokens) },
                    { k: 'Output tokens（输出）', v: fmtNum(detail.outputTokens) },
                    { k: 'Cache read（缓存命中读入）', v: fmtNum(detail.cacheReadInputTokens) },
                    { k: 'Cache create（缓存写入/创建）', v: fmtNum(detail.cacheCreationInputTokens) },
                    { k: 'Assembled chars（拼接字符数）', v: fmtNum(detail.assembledTextChars) },
                    // 这里用完整 hash，超长由 marquee 自动循环滚动
                    { k: 'Assembled hash（拼接哈希）', v: (detail.assembledTextHash ?? '').trim() || '—' },
                  ].map((it) => (
                    <div
                      key={it.k}
                      className="rounded-[12px] px-3 py-2 min-w-0 overflow-hidden"
                      style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', minWidth: 0 }}
                    >
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {it.k}
                      </div>
                      <div className="mt-1 min-w-0">
                        <NewsMarquee
                          text={String(it.v ?? '—')}
                          title={String(it.v ?? '')}
                          style={{
                            color: 'var(--text-primary)',
                            fontSize: 14,
                            lineHeight: '1.2',
                            fontWeight: 700,
                            fontFamily:
                              'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  说明：`—` 表示未上报/未知；`0` 表示真实为 0。
                </div>
                <div className="mt-3 flex-1 min-h-0 overflow-auto">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Answer（最终拼接文本）</div>
                    <div className="flex items-center gap-2">
                      {answerHint ? (
                        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          {answerHint}
                        </div>
                      ) : null}
                      <div className="flex items-center rounded-[12px] p-1" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
                        <button
                          type="button"
                          onClick={() => setAnswerView('preview')}
                          className="h-8 px-3 rounded-[10px] text-xs font-semibold"
                          style={{
                            color: answerView === 'preview' ? 'var(--text-primary)' : 'var(--text-muted)',
                            background: answerView === 'preview' ? 'rgba(231,206,151,0.10)' : 'transparent',
                            border: answerView === 'preview' ? '1px solid rgba(231,206,151,0.22)' : '1px solid transparent',
                          }}
                        >
                          预览
                        </button>
                        <button
                          type="button"
                          onClick={() => setAnswerView('raw')}
                          className="h-8 px-3 rounded-[10px] text-xs font-semibold"
                          style={{
                            color: answerView === 'raw' ? 'var(--text-primary)' : 'var(--text-muted)',
                            background: answerView === 'raw' ? 'rgba(231,206,151,0.10)' : 'transparent',
                            border: answerView === 'raw' ? '1px solid rgba(231,206,151,0.22)' : '1px solid transparent',
                          }}
                        >
                          Raw
                        </button>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={async () => {
                          const text = answerText || '';
                          try {
                            await navigator.clipboard.writeText(text || '');
                            setCopiedHint('已复制');
                            setTimeout(() => setCopiedHint(''), 1200);
                          } catch {
                            setCopiedHint('复制失败（浏览器权限）');
                            setTimeout(() => setCopiedHint(''), 2000);
                          }
                        }}
                      >
                        <Copy size={16} />
                        复制
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          const raw = (detail?.answerText ?? '').trim();
                          const res = validateStrictJson(raw);
                          if (res.ok) {
                            setAnswerHint('JSON 合法');
                            setTimeout(() => setAnswerHint(''), 1600);
                          } else {
                            setAnswerHint(`JSON 不合法：${res.reason}`);
                            setTimeout(() => setAnswerHint(''), 2800);
                          }
                        }}
                        disabled={!((detail?.answerText ?? '').trim())}
                        title="对模型原始返回（Answer）做严格 JSON 校验"
                      >
                        JSON检查
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3">
                    {answerView === 'raw' ? (
                      <pre style={codeBoxStyle()}>
                        {answerText || (detail?.status === 'running' ? '（生成中…）' : '（无输出）')}
                      </pre>
                    ) : (
                      <div
                        className="rounded-[14px] p-3"
                        style={{
                          background: 'rgba(0,0,0,0.22)',
                          border: '1px solid var(--border-subtle)',
                          color: 'var(--text-secondary)',
                          overflow: 'auto',
                        }}
                      >
                        <style>{`
                          .prd-md { font-size: 13px; line-height: 1.65; color: var(--text-secondary); }
                          .prd-md h1,.prd-md h2,.prd-md h3 { color: var(--text-primary); font-weight: 700; margin: 14px 0 8px; }
                          .prd-md h1 { font-size: 18px; }
                          .prd-md h2 { font-size: 16px; }
                          .prd-md h3 { font-size: 14px; }
                          .prd-md p { margin: 8px 0; }
                          .prd-md ul,.prd-md ol { margin: 8px 0; padding-left: 18px; }
                          .prd-md li { margin: 4px 0; }
                          .prd-md hr { border: 0; border-top: 1px solid rgba(255,255,255,0.10); margin: 12px 0; }
                          .prd-md blockquote { margin: 10px 0; padding: 6px 10px; border-left: 3px solid rgba(231,206,151,0.35); background: rgba(231,206,151,0.06); color: rgba(231,206,151,0.92); border-radius: 10px; }
                          .prd-md a { color: #E7CE97; text-decoration: underline; }
                          .prd-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); padding: 0 6px; border-radius: 8px; }
                          .prd-md pre { background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.10); border-radius: 14px; padding: 12px; overflow: auto; }
                          .prd-md pre code { background: transparent; border: 0; padding: 0; }
                          .prd-md table { width: 100%; border-collapse: collapse; margin: 10px 0; }
                          .prd-md th,.prd-md td { border: 1px solid rgba(255,255,255,0.10); padding: 6px 8px; }
                          .prd-md th { color: var(--text-primary); background: rgba(255,255,255,0.03); }
                        `}</style>
                        <div className="prd-md">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              a: ({ href, children, ...props }) => (
                                <a href={href} target="_blank" rel="noreferrer" {...props}>
                                  {children}
                                </a>
                              ),
                            }}
                          >
                            {answerText || (detail?.status === 'running' ? '（生成中…）' : '（无输出）')}
                          </ReactMarkdown>
                        </div>
                      </div>
                    )}
                  </div>

                  {assembledSummary ? (
                    <div className="mt-3">
                      <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>用户可见输出（摘要字段）</div>
                      <pre style={codeBoxStyle()}>{assembledSummary}</pre>
                    </div>
                  ) : null}
                </div>
              </Card>
            </div>
          )
        }
      />

      <Dialog
        open={promptOpen}
        onOpenChange={(open) => setPromptOpen(open)}
        title="System Prompt 预览"
        description={detail ? `${promptToken || '[SYSTEM_PROMPT]'} · requestId: ${detail.requestId}` : promptToken || ''}
        maxWidth={980}
        contentStyle={{ height: '76vh' }}
        content={
          !detail ? (
            <div className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>暂无详情</div>
          ) : (
            <div className="h-full min-h-0 flex flex-col">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  点击 body 中的占位符可预览（旧数据可能未记录）
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText((detail.systemPromptText ?? '').trim());
                      setCopiedHint('system prompt 已复制');
                      setTimeout(() => setCopiedHint(''), 1200);
                    } catch {
                      setCopiedHint('复制失败（浏览器权限）');
                      setTimeout(() => setCopiedHint(''), 2000);
                    }
                  }}
                  disabled={!((detail.systemPromptText ?? '').trim())}
                >
                  <Copy size={16} />
                  复制
                </Button>
              </div>
              {copiedHint ? (
                <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {copiedHint}
                </div>
              ) : null}
              <div className="mt-3 flex-1 min-h-0 overflow-auto">
                <pre style={codeBoxStyle()}>
                  {((detail.systemPromptText ?? '').trim() || '未记录 system prompt（可能为旧日志或后端未写入该字段）')}
                </pre>
              </div>
            </div>
          )
        }
      />
    </div>
  );
}

