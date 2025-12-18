import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Dialog } from '@/components/ui/Dialog';
import { getLlmLogDetail, getLlmLogs, getLlmLogsMeta } from '@/services';
import type { LlmRequestLog, LlmRequestLogListItem } from '@/types/admin';
import { Copy, RefreshCw, Search } from 'lucide-react';
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

function shellSingleQuote(text: string): string {
  // Bash/zsh 安全单引号转义：' -> '"'"'
  return `'${String(text).replace(/'/g, `'"'"'`)}'`;
}

function buildCurlFromLog(detail: LlmRequestLog): string {
  const apiBase = (detail.apiBase ?? '').trim();
  const path = (detail.path ?? '').trim();
  const url = `${apiBase}${path}` || 'https://api.example.com/v1/chat/completions';

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
      style={{ ...vars, ...style }}
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
          <span className="text-[11px] font-semibold shrink-0" style={{ color: '#E7CE97' }}>
            问题
          </span>
          <div className="min-w-0 flex-1">
            <NewsMarquee text={q ? `：${q}` : '：未记录（已脱敏）'} />
          </div>
        </div>

        <div className="min-w-0 flex items-center gap-2">
          <span className="text-[11px] font-semibold shrink-0" style={{ color: '#E7CE97', opacity: 0.9 }}>
            回答
          </span>
          <div className="min-w-0 flex-1">
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
    if (v === 'succeeded') return <Badge variant="success">成功</Badge>;
    if (v === 'failed') return <Badge variant="subtle">失败</Badge>;
    if (v === 'running') return <Badge variant="subtle">进行中</Badge>;
    return <Badge variant="subtle">{s || '-'}</Badge>;
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-input)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'var(--text-primary)',
  };

  const selectStyle: React.CSSProperties = {
    ...inputStyle,
    appearance: 'none',
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
          <select value={qProvider} onChange={(e) => setQProvider(e.target.value)} className="h-9 rounded-[12px] px-3 text-sm outline-none" style={selectStyle}>
            <option value="">provider（全部）</option>
            {metaProviders.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <select value={qModel} onChange={(e) => setQModel(e.target.value)} className="h-9 rounded-[12px] px-3 text-sm outline-none" style={selectStyle}>
            <option value="">model（全部）</option>
            {metaModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <select value={qStatus} onChange={(e) => setQStatus(e.target.value)} className="h-9 rounded-[12px] px-3 text-sm outline-none" style={selectStyle}>
            <option value="">status（全部）</option>
            {metaStatuses.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <input value={qGroupId} onChange={(e) => setQGroupId(e.target.value)} className="h-9 rounded-[12px] px-3 text-sm outline-none" style={inputStyle} placeholder="groupId" />
          <input value={qSessionId} onChange={(e) => setQSessionId(e.target.value)} className="h-9 rounded-[12px] px-3 text-sm outline-none" style={inputStyle} placeholder="sessionId" />
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
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
                      <div className="mt-1 text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                        requestId: {it.requestId}
                        {it.groupId ? ` · groupId: ${it.groupId}` : ''}
                        {it.sessionId ? ` · sessionId: ${it.sessionId}` : ''}
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
                    <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>body</div>
                    <pre style={codeBoxStyle()}>{prettyRequestBody || ''}</pre>
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
                <div className="mt-3 grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
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
                      className="rounded-[12px] px-3 py-2"
                      style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                    >
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {it.k}
                      </div>
                      <div className="mt-1">
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
    </div>
  );
}

