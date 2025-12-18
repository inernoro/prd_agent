import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Dialog } from '@/components/ui/Dialog';
import { getLlmLogDetail, getLlmLogs, getLlmLogsMeta } from '@/services';
import type { LlmRequestLog, LlmRequestLogListItem } from '@/types/admin';
import { Copy, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

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

function fmtText(v: string | null | undefined): string {
  const s = (v ?? '').trim();
  return s ? s : '—';
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

function splitSseLine(line: string): string[] {
  const raw = String(line ?? '').trim();
  if (!raw) return [];

  // 兼容“一个字符串里拼了多个 data: ...”的情况
  const parts = raw.split(/(?=data:\s)/g).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) return parts;
  return [raw];
}

function formatRawSse(lines: string[] | null | undefined): string {
  const src = (lines ?? []).flatMap(splitSseLine);
  if (src.length === 0) return '';

  const out: string[] = [];
  src.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('data:')) {
      const payload = t.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        out.push(`#${String(i + 1).padStart(3, '0')} data: [DONE]`);
        out.push('');
        return;
      }
      try {
        const obj = JSON.parse(payload) as unknown;
        out.push(`#${String(i + 1).padStart(3, '0')} data:`);
        out.push(JSON.stringify(obj, null, 2));
        out.push('');
        return;
      } catch {
        out.push(`#${String(i + 1).padStart(3, '0')} ${t}`);
        out.push('');
        return;
      }
    }

    out.push(`#${String(i + 1).padStart(3, '0')} ${t}`);
    out.push('');
  });

  return out.join('\n');
}

type ParsedSseRow = {
  idx: number;
  kind: string;
  finish?: string | null;
  deltaKeys?: string;
  hasUsage: boolean;
  usage?: string;
  note?: string;
};

function extractDeltaText(lines: string[] | null | undefined): string {
  const src = (lines ?? []).flatMap(splitSseLine);
  const out: string[] = [];

  src.forEach((line) => {
    const t = String(line ?? '').trim();
    if (!t.startsWith('data:')) return;
    const payload = t.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') return;

    try {
      const obj = JSON.parse(payload) as any;
      // OpenAI: choices[0].delta.content
      const openAiDelta = obj?.choices?.[0]?.delta?.content;
      if (typeof openAiDelta === 'string' && openAiDelta) {
        out.push(openAiDelta);
        return;
      }

      // Claude: content_block_delta.delta.text 或 delta.text
      const claudeDelta1 = obj?.content_block_delta?.delta?.text;
      const claudeDelta2 = obj?.delta?.text;
      const claudeDelta = typeof claudeDelta1 === 'string' ? claudeDelta1 : (typeof claudeDelta2 === 'string' ? claudeDelta2 : null);
      if (claudeDelta) {
        out.push(claudeDelta);
        return;
      }

      // 兜底：如果后端把内容直接放在 content 字段（自定义 SSE）
      if (typeof obj?.content === 'string' && obj.content) {
        out.push(obj.content);
        return;
      }
    } catch {
      // ignore
    }
  });

  return out.join('');
}

function parseSseToRows(lines: string[] | null | undefined): { rows: ParsedSseRow[]; stats: { total: number; done: boolean; hasUsage: boolean } } {
  const src = (lines ?? []).flatMap(splitSseLine);
  const rows: ParsedSseRow[] = [];
  let done = false;
  let hasUsage = false;

  src.forEach((line, i) => {
    const t = String(line ?? '').trim();
    if (!t) return;

    if (t.startsWith('data:')) {
      const payload = t.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        done = true;
        rows.push({ idx: i + 1, kind: 'DONE', hasUsage: false });
        return;
      }

      try {
        const obj = JSON.parse(payload) as any;
        const kind = String(obj?.type ?? obj?.object ?? 'data');

        // OpenAI chat.completion.chunk
        const choice0 = obj?.choices?.[0];
        const delta = choice0?.delta;
        const finish = choice0?.finish_reason ?? null;
        const deltaKeys = delta && typeof delta === 'object' ? Object.keys(delta).join(',') : undefined;

        // usage（OpenAI / Claude）
        const usageObj = obj?.usage ?? obj?.message?.usage ?? null;
        let usage: string | undefined;
        let rowHasUsage = false;
        if (usageObj && typeof usageObj === 'object') {
          rowHasUsage = true;
          hasUsage = true;
          const inTok = usageObj?.input_tokens ?? usageObj?.prompt_tokens ?? usageObj?.prompt_tokens_total ?? undefined;
          const outTok = usageObj?.output_tokens ?? usageObj?.completion_tokens ?? usageObj?.completion_tokens_total ?? undefined;
          const totalTok = usageObj?.total_tokens ?? undefined;
          const parts = [
            inTok !== undefined ? `in=${inTok}` : null,
            outTok !== undefined ? `out=${outTok}` : null,
            totalTok !== undefined ? `total=${totalTok}` : null,
          ].filter(Boolean);
          usage = parts.length ? parts.join(' ') : 'usage=present';
        }

        // Claude event 兼容：content_block_delta 等
        const noteParts: string[] = [];
        if (obj?.delta && typeof obj.delta === 'object') noteParts.push(`deltaKeys=${Object.keys(obj.delta).join(',')}`);
        if (obj?.content_block_delta?.delta && typeof obj.content_block_delta.delta === 'object') {
          noteParts.push(`contentDeltaKeys=${Object.keys(obj.content_block_delta.delta).join(',')}`);
        }

        rows.push({
          idx: i + 1,
          kind,
          finish,
          deltaKeys,
          hasUsage: rowHasUsage,
          usage,
          note: noteParts.length ? noteParts.join(' ') : undefined,
        });
        return;
      } catch {
        rows.push({ idx: i + 1, kind: 'data', hasUsage: false, note: 'json=invalid' });
        return;
      }
    }

    // 非 data 行
    rows.push({ idx: i + 1, kind: 'line', hasUsage: false, note: t.slice(0, 160) });
  });

  return { rows, stats: { total: rows.length, done, hasUsage } };
}

export default function LlmLogsPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<LlmRequestLogListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(30);

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
  const [respView, setRespView] = useState<'parsed' | 'raw'>('parsed');

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
  const formattedRawSse = useMemo(() => formatRawSse(detail?.rawSse), [detail]);
  const parsedSse = useMemo(() => parseSseToRows(detail?.rawSse), [detail]);
  const parsedDeltaText = useMemo(() => extractDeltaText(detail?.rawSse), [detail]);
  const assembledSummary = useMemo(() => {
    if (!detail) return '';
    const chars = detail.assembledTextChars;
    const hash = (detail.assembledTextHash ?? '').trim();
    if ((chars === null || chars === undefined || chars === 0) && !hash) return '';
    return `用户可见输出（摘要字段）\nchars=${fmtNum(chars)}\nhash=${hash || '—'}\n\n说明：这里仅保留长度与哈希用于对照；如需排查具体输出内容，请查看右侧响应流（raw/解析视图）。`;
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
                  <div className="flex items-center justify-between gap-3">
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
            setRespView('parsed');
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
                <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  provider（服务商）: {detail.provider} · model（模型）: {detail.model} · status（状态）: {detail.status}
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  requestId: {detail.requestId}
                  {detail.groupId ? ` · groupId: ${detail.groupId}` : ''}
                  {detail.sessionId ? ` · sessionId: ${detail.sessionId}` : ''}
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  startedAt: {formatLocalTime(detail.startedAt)} · firstByteAt: {formatLocalTime(detail.firstByteAt ?? null)} · endedAt: {formatLocalTime(detail.endedAt ?? null)}
                  {diffMs(detail.startedAt, detail.firstByteAt ?? null) !== null ? ` · TTFB ${diffMs(detail.startedAt, detail.firstByteAt ?? null)}ms` : ''}
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
                    { k: 'Assembled hash（拼接哈希）', v: fmtText(detail.assembledTextHash) },
                  ].map((it) => (
                    <div
                      key={it.k}
                      className="rounded-[12px] px-3 py-2"
                      style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}
                    >
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {it.k}
                      </div>
                      <div
                        className="mt-1 text-sm font-semibold"
                        style={{
                          color: 'var(--text-primary)',
                          fontFamily:
                            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                        }}
                      >
                        {it.v}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  说明：`—` 表示未上报/未知；`0` 表示真实为 0。
                </div>
                <div className="mt-3 flex-1 min-h-0 overflow-auto">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>响应流（仅隐藏密钥/Token）</div>
                    <div className="flex items-center gap-2">
                      <div
                        className="inline-flex p-[3px] rounded-[12px]"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.10)' }}
                      >
                        <button
                          type="button"
                          onClick={() => setRespView('parsed')}
                          aria-pressed={respView === 'parsed'}
                          className="h-[35px] px-3 rounded-[10px] text-[13px] font-semibold transition-colors"
                          style={{
                            color: 'var(--text-primary)',
                            background: respView === 'parsed' ? 'rgba(255,255,255,0.08)' : 'transparent',
                            border: respView === 'parsed' ? '1px solid rgba(255,255,255,0.16)' : '1px solid transparent',
                          }}
                        >
                          解析视图
                        </button>
                        <button
                          type="button"
                          onClick={() => setRespView('raw')}
                          aria-pressed={respView === 'raw'}
                          className="h-[35px] px-3 rounded-[10px] text-[13px] font-semibold transition-colors"
                          style={{
                            color: 'var(--text-primary)',
                            background: respView === 'raw' ? 'rgba(255,255,255,0.08)' : 'transparent',
                            border: respView === 'raw' ? '1px solid rgba(255,255,255,0.16)' : '1px solid transparent',
                          }}
                        >
                          raw
                        </button>
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={async () => {
                          const shortParsed = [
                            `events: ${parsedSse.stats.total}`,
                            `done: ${parsedSse.stats.done ? 'yes' : 'no'}`,
                            `usageInStream: ${parsedSse.stats.hasUsage ? 'yes' : 'no'}`,
                          ].join('\n');

                          const text =
                            respView === 'raw'
                              ? formattedRawSse
                              : (parsedDeltaText
                                ? parsedDeltaText
                                : `${shortParsed}\n\n（未能从流中提取可见文本：可能是 Provider 格式不匹配或仅返回结构信息）`);
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

                  {respView === 'parsed' ? (
                    <>
                      <div className="mt-3">
                        <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>解析输出（拼接后的 delta 文本）</div>
                        <pre style={codeBoxStyle()}>{parsedDeltaText || '（未能从流中提取可见文本：可能是 Provider 格式不匹配或仅返回结构信息）'}</pre>
                      </div>

                      <div className="mt-3">
                        <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>统计（Stats）</div>
                        <pre style={codeBoxStyle()}>
                          {[
                            `events: ${parsedSse.stats.total}`,
                            `done: ${parsedSse.stats.done ? 'yes' : 'no'}`,
                            `usageInStream: ${parsedSse.stats.hasUsage ? 'yes' : 'no'}`,
                          ].join('\n')}
                        </pre>
                        <details className="mt-3">
                          <summary className="text-xs cursor-pointer select-none" style={{ color: 'var(--text-muted)' }}>
                            调试信息（Debug：事件摘要）
                          </summary>
                          <pre className="mt-2" style={codeBoxStyle()}>
                            {parsedSse.rows.map((r) => {
                              const bits = [
                                `#${String(r.idx).padStart(3, '0')}`,
                                r.kind,
                                r.deltaKeys ? `delta=[${r.deltaKeys}]` : null,
                                r.finish ? `finish=${r.finish}` : null,
                                r.hasUsage ? (r.usage ? `usage(${r.usage})` : 'usage') : null,
                                r.note ? r.note : null,
                              ].filter(Boolean);
                              return bits.join(' ');
                            }).join('\n')}
                          </pre>
                        </details>
                      </div>
                    </>
                  ) : null}

                  {assembledSummary ? (
                    <div className="mt-3">
                      <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>用户可见输出（摘要字段）</div>
                      <pre style={codeBoxStyle()}>{assembledSummary}</pre>
                    </div>
                  ) : null}

                  {respView === 'raw' ? (
                    <div className="mt-3">
                      <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>raw SSE（已格式化换行）</div>
                      <pre style={codeBoxStyle()}>{formattedRawSse}</pre>
                      {detail.rawSseTruncated ? (
                        <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                          raw SSE 已截断（保留最近一部分）
                        </div>
                      ) : null}
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

