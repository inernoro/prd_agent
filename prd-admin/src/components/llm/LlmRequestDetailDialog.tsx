import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/design/Button';
import { getLlmLogDetail, getLlmLogs } from '@/services';
import type { LlmRequestLog } from '@/types/admin';
import { Copy, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useEffect, useMemo, useRef, useState } from 'react';

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

function fmtMsSmart(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const ms = Math.round(v);
  if (Math.abs(ms) >= 10_000) {
    const s = ms / 1000;
    const s1 = Math.round(s * 10) / 10;
    return Number.isInteger(s1) ? `${s1.toFixed(0)}s` : `${s1.toFixed(1)}s`;
  }
  return `${ms}ms`;
}

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

export function LlmRequestDetailDialog({
  open,
  onOpenChange,
  requestId,
  jumpToLogsHref,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string | null;
  /** 可选：提供“去调用日志页”链接（例如带 requestId 过滤） */
  jumpToLogsHref?: string;
}) {
  const rid = (requestId ?? '').trim();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<LlmRequestLog | null>(null);
  const keyRef = useRef<string>('');

  useEffect(() => {
    if (!open) {
      keyRef.current = '';
      setLoading(false);
      setError('');
      setDetail(null);
      return;
    }
    if (!rid) {
      setLoading(false);
      setError('缺少 requestId，无法定位调用日志');
      setDetail(null);
      return;
    }

    const key = `rid:${rid}`;
    keyRef.current = key;
    setLoading(true);
    setError('');
    setDetail(null);

    void (async () => {
      try {
        const listRes = await getLlmLogs({ page: 1, pageSize: 1, requestId: rid });
        if (keyRef.current !== key) return;
        if (!listRes.success) {
          setError(listRes.error?.message || '加载日志列表失败');
          return;
        }
        const first = Array.isArray(listRes.data.items) ? listRes.data.items[0] : null;
        if (!first?.id) {
          setError('未找到对应调用日志（可能已清理或写入失败）');
          return;
        }

        const detailRes = await getLlmLogDetail(first.id);
        if (keyRef.current !== key) return;
        if (!detailRes.success) {
          setError(detailRes.error?.message || '加载日志详情失败');
          return;
        }
        setDetail(detailRes.data);
      } catch (e) {
        if (keyRef.current !== key) return;
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg || '加载失败');
      } finally {
        if (keyRef.current === key) setLoading(false);
      }
    })();
  }, [open, rid]);

  const requestBody = useMemo(() => (detail?.requestBodyRedacted ?? '').trim(), [detail?.requestBodyRedacted]);
  const answerText = useMemo(() => (detail?.answerText ?? '').trim(), [detail?.answerText]);
  const ttfb = useMemo(() => diffMs(detail?.startedAt ?? null, detail?.firstByteAt ?? null), [detail?.startedAt, detail?.firstByteAt]);
  const total = useMemo(() => (typeof detail?.durationMs === 'number' ? detail?.durationMs : diffMs(detail?.startedAt ?? null, detail?.endedAt ?? null)), [detail?.durationMs, detail?.startedAt, detail?.endedAt]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="LLM 请求详情"
      description={rid ? `requestId: ${rid}` : '点击 requestId 查看详情'}
      maxWidth={1200}
      contentStyle={{ height: '82vh' }}
      content={
        loading ? (
          <div className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>加载中...</div>
        ) : error ? (
          <div className="py-10 text-center" style={{ color: 'rgba(239,68,68,0.92)' }}>
            {error}
            {rid ? (
              <div className="mt-3">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(rid);
                    } catch {
                      // ignore
                    }
                  }}
                >
                  <Copy size={16} />
                  复制 requestId
                </Button>
              </div>
            ) : null}
          </div>
        ) : !detail ? (
          <div className="py-10 text-center" style={{ color: 'var(--text-muted)' }}>暂无详情</div>
        ) : (
          <div className="h-full min-h-0 grid gap-3 md:grid-cols-2">
            <div className="rounded-[16px] p-3 overflow-hidden flex flex-col min-h-0" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Request</div>
                <div className="flex items-center gap-2">
                  {jumpToLogsHref ? (
                    <a
                      href={jumpToLogsHref}
                      className="inline-flex items-center gap-1 text-xs font-semibold"
                      style={{ color: 'rgba(147, 197, 253, 0.95)' }}
                      target="_blank"
                      rel="noreferrer"
                      title="在新标签打开调用日志页"
                    >
                      <ExternalLink size={14} />
                      调用日志页
                    </a>
                  ) : null}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(rid);
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    <Copy size={16} />
                    复制 requestId
                  </Button>
                </div>
              </div>

              <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
                {[
                  { k: 'provider', v: detail.provider || '—' },
                  { k: 'model', v: detail.model || '—' },
                  { k: 'status', v: detail.status || '—' },
                  { k: 'requestType', v: detail.requestType || '—' },
                  { k: 'requestPurpose', v: detail.requestPurpose || '—' },
                  { k: 'groupId', v: detail.groupId || '—' },
                  { k: 'sessionId', v: detail.sessionId || '—' },
                  { k: 'startedAt', v: formatLocalTime(detail.startedAt) },
                  { k: 'firstByteAt', v: formatLocalTime(detail.firstByteAt ?? null) },
                  { k: 'time', v: `首字延时 ${fmtMsSmart(ttfb)} · 总时长 ${fmtMsSmart(total)}` },
                ].map((row) => (
                  <div
                    key={row.k}
                    className="rounded-[12px] px-2.5 py-1.5 min-w-0"
                    style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)', minWidth: 0 }}
                    title={String(row.v ?? '')}
                  >
                    <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{row.k}</div>
                    <div className="mt-1 text-[12px] font-semibold truncate" style={{ color: 'var(--text-secondary)' }}>
                      {String(row.v ?? '—')}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex-1 min-h-0 overflow-auto space-y-3">
                <div>
                  <div className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>body（脱敏/可能截断）</div>
                  <pre style={codeBoxStyle()}>{requestBody || '（未记录）'}</pre>
                </div>
              </div>
            </div>

            <div className="rounded-[16px] p-3 overflow-hidden flex flex-col min-h-0" style={{ border: '1px solid var(--border-subtle)', background: 'rgba(255,255,255,0.02)' }}>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Response</div>
              <div className="mt-2 flex-1 min-h-0 overflow-auto">
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
                  .prd-md a { color: rgba(147, 197, 253, 0.95); text-decoration: underline; }
                  .prd-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.10); padding: 0 6px; border-radius: 8px; }
                  .prd-md pre { background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.10); border-radius: 14px; padding: 12px; overflow: auto; }
                  .prd-md pre code { background: transparent; border: 0; padding: 0; }
                  .prd-md table { width: 100%; border-collapse: collapse; margin: 10px 0; }
                  .prd-md th,.prd-md td { border: 1px solid rgba(255,255,255,0.10); padding: 6px 8px; }
                  .prd-md th { color: var(--text-primary); background: rgba(255,255,255,0.03); }
                `}</style>
                <div
                  className="rounded-[14px] p-3"
                  style={{
                    background: 'rgba(0,0,0,0.22)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--text-secondary)',
                    overflow: 'auto',
                  }}
                >
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
                      {answerText || (detail.status === 'running' ? '（生成中…）' : '（无输出）')}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )
      }
    />
  );
}


