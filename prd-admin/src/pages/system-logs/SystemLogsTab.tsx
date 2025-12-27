import { Badge } from '@/components/design/Badge';
import { Button } from '@/components/design/Button';
import { Card } from '@/components/design/Card';
import { Dialog } from '@/components/ui/Dialog';
import { getApiLogDetail, getApiLogs, getApiLogsMeta } from '@/services';
import type { ApiLogsListItem, ApiRequestLog } from '@/services/contracts/apiLogs';
import { CheckCircle, Clock, Copy, Filter, Hash, Loader2, RefreshCw, Server, Users, XCircle } from 'lucide-react';
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

function fmtNum(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : '—';
}

function statusBadge(statusCode: number) {
  if (statusCode >= 200 && statusCode < 300) return <Badge variant="success" size="sm" icon={<CheckCircle size={10} />}>成功</Badge>;
  if (statusCode >= 400 && statusCode < 500) return <Badge variant="subtle" size="sm" icon={<XCircle size={10} />}>失败</Badge>;
  if (statusCode >= 500) return <Badge variant="subtle" size="sm" icon={<XCircle size={10} />}>异常</Badge>;
  return <Badge variant="subtle" size="sm">{statusCode}</Badge>;
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // ignore
  }
}

export default function SystemLogsTab() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<ApiLogsListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(30);

  const [qUserId, setQUserId] = useState('');
  const [qPath, setQPath] = useState('');
  const [qRequestId, setQRequestId] = useState('');

  const [metaClientTypes, setMetaClientTypes] = useState<string[]>([]);
  const [metaMethods, setMetaMethods] = useState<string[]>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  const [qClientType, setQClientType] = useState('');
  const [qMethod, setQMethod] = useState('');

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ApiRequestLog | null>(null);
  const [copiedHint, setCopiedHint] = useState('');

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / pageSize)), [total, pageSize]);

  const loadMeta = async () => {
    const res = await getApiLogsMeta();
    if (res.success) {
      setMetaClientTypes(res.data.clientTypes ?? []);
      setMetaMethods(res.data.methods ?? metaMethods);
    }
  };

  const load = async (opts?: { resetPage?: boolean }) => {
    if (opts?.resetPage) setPage(1);
    setLoading(true);
    try {
      const res = await getApiLogs({
        page: opts?.resetPage ? 1 : page,
        pageSize,
        userId: qUserId || undefined,
        path: qPath || undefined,
        requestId: qRequestId || undefined,
        clientType: qClientType || undefined,
        method: qMethod || undefined,
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
    setDetailOpen(true);
    setDetailLoading(true);
    setDetail(null);
    setCopiedHint('');
    try {
      const res = await getApiLogDetail(id);
      if (res.success) setDetail(res.data);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadMeta();
    void load({ resetPage: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-input)',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'var(--text-primary)',
  };

  return (
    <div className="h-full min-h-0 flex flex-col gap-4">
      <div>
        <div className="text-2xl font-semibold" style={{ color: 'var(--text-primary)' }}>系统日志</div>
        <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          API 请求日志（已剔除 prompt/messages/systemPrompt 等提示词字段）；desktop 在线/请求会在下一步接入。
        </div>
      </div>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>API 请求日志</div>
          <Button variant="secondary" size="sm" onClick={() => load()} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            刷新
          </Button>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-6">
          <div className="relative">
            <Users size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={qUserId}
              onChange={(e) => setQUserId(e.target.value)}
              className="h-9 w-full rounded-[12px] pl-9 pr-3 text-sm outline-none"
              style={inputStyle}
              placeholder="userId"
            />
          </div>
          <div className="relative md:col-span-2">
            <Server size={16} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
            <input
              value={qPath}
              onChange={(e) => setQPath(e.target.value)}
              className="h-9 w-full rounded-[12px] pl-9 pr-3 text-sm outline-none"
              style={inputStyle}
              placeholder="path（例如 /api/v1/sessions/xxx/messages）"
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
          <select
            value={qMethod}
            onChange={(e) => setQMethod(e.target.value)}
            className="h-9 w-full rounded-[12px] px-3 text-sm outline-none"
            style={inputStyle}
          >
            <option value="">method（全部）</option>
            {metaMethods.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <select
            value={qClientType}
            onChange={(e) => setQClientType(e.target.value)}
            className="h-9 w-full rounded-[12px] px-3 text-sm outline-none"
            style={inputStyle}
          >
            <option value="">clientType（全部）</option>
            {metaClientTypes.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
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
                setQUserId('');
                setQPath('');
                setQRequestId('');
                setQClientType('');
                setQMethod('');
              }}
              disabled={loading}
            >
              清空
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={loading || page <= 1}>
              上一页
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={loading || page >= totalPages}>
              下一页
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-2">
          {loading && (
            <div className="text-sm flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
              <Loader2 size={16} className="animate-spin" />
              加载中…
            </div>
          )}
          {!loading && items.length === 0 && (
            <div className="text-sm" style={{ color: 'var(--text-muted)' }}>暂无数据</div>
          )}
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              onClick={() => void loadDetail(it.id)}
              className="text-left rounded-[14px] px-3 py-2 transition-colors hover:bg-white/5"
              style={{ border: '1px solid var(--border-subtle)' }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex items-center gap-2">
                  {statusBadge(it.statusCode)}
                  <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {it.method} {it.path}
                  </span>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {it.clientType ? ` · ${it.clientType}` : ''}{it.clientId ? `(${it.clientId})` : ''}
                  </span>
                </div>
                <div className="text-[11px] flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
                  <Clock size={12} />
                  {formatLocalTime(it.startedAt)} · {fmtNum(it.durationMs)}ms
                </div>
              </div>
              <div className="mt-1 text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                userId={it.userId}{it.groupId ? ` · groupId=${it.groupId}` : ''}{it.sessionId ? ` · sessionId=${it.sessionId}` : ''}{it.apiSummary ? ` · ${it.apiSummary}` : ''}
              </div>
              {(it.requestBodyPreview || it.curlPreview) && (
                <div className="mt-2 text-[11px] grid gap-1">
                  {it.requestBodyPreview && (
                    <div className="truncate" style={{ color: 'rgba(231,206,151,0.85)' }}>
                      body：{it.requestBodyPreview}{it.requestBodyTruncated ? '（已截断）' : ''}
                    </div>
                  )}
                  {it.curlPreview && (
                    <div className="truncate" style={{ color: 'rgba(231,206,151,0.75)' }}>
                      curl：{it.curlPreview}
                    </div>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      </Card>

      <Dialog
        open={detailOpen}
        onOpenChange={(open) => setDetailOpen(open)}
        title="API 请求日志详情"
        maxWidth={980}
        content={
          <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                {detail?.method || '-'} {detail?.path || '-'}
              </div>
              <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                id={selectedId || '-'} · requestId={detail?.requestId || '-'} · userId={detail?.userId || '-'}
              </div>
            </div>
            {detail?.curl && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void copyToClipboard(detail.curl || '');
                  setCopiedHint('已复制 curl');
                  setTimeout(() => setCopiedHint(''), 1200);
                }}
              >
                <Copy size={16} />
                复制 curl
              </Button>
            )}
          </div>

          {copiedHint && (
            <div className="text-xs" style={{ color: 'rgba(34,197,94,0.95)' }}>{copiedHint}</div>
          )}

          {detailLoading && (
            <div className="text-sm flex items-center gap-2" style={{ color: 'var(--text-muted)' }}>
              <Loader2 size={16} className="animate-spin" />
              加载详情中…
            </div>
          )}

          {!detailLoading && detail && (
            <>
              <div className="grid gap-2 md:grid-cols-3">
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  status：{detail.statusCode} · durationMs：{fmtNum(detail.durationMs)}
                </div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  startedAt：{formatLocalTime(detail.startedAt)}
                </div>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  client：{detail.clientType || '—'}{detail.clientId ? `(${detail.clientId})` : ''}
                </div>
              </div>

              {detail.requestBody && (
                <div>
                  <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
                    Request body{detail.requestBodyTruncated ? '（已截断）' : ''}
                  </div>
                  <div style={codeBoxStyle()}>{detail.requestBody}</div>
                </div>
              )}

              {detail.curl && (
                <div>
                  <div className="text-xs font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>cURL</div>
                  <div style={codeBoxStyle()}>{detail.curl}</div>
                </div>
              )}
            </>
          )}
          </div>
        }
      />
    </div>
  );
}


