// 右侧详情抽屉（createPortal 到 body + inline 高度 + 滚动区 minHeight:0 + overscroll contain）。
// 移植自 prd-admin GenerationDetailsDrawer，主题 token，缺字段统一「—」。

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, X } from 'lucide-react';
import { getLogDetail } from '@/lib/api';
import type { LlmLogDetail } from '@/lib/types';
import { SectionLoader } from './ui';
import { DASH, computeTokPerSec, fmtMs, deriveLifecycle, getProtocolMeta } from '@/lib/logsHelpers';

function MetricCard({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <div
      style={{
        flexShrink: 0,
        borderRadius: 'var(--radius-sm)',
        padding: '8px 10px',
        minWidth: 132,
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-input)',
      }}
    >
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{title}</div>
      <div className="tabular" style={{ marginTop: 3, fontSize: 14, fontWeight: 650, color: 'var(--text-primary)' }}>{value}</div>
      {note ? <div style={{ fontSize: 10, marginTop: 2, color: 'var(--text-muted)' }}>{note}</div> : null}
    </div>
  );
}

function Row({ k, v, mono, copy }: { k: string; v?: string | null; mono?: boolean; copy?: boolean }) {
  const val = v && v.trim() ? v : DASH;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        padding: '6px 0',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <span style={{ fontSize: 12, flexShrink: 0, color: 'var(--text-muted)' }}>{k}</span>
      <span
        style={{
          fontSize: 12,
          textAlign: 'right',
          wordBreak: 'break-all',
          color: 'var(--text-secondary)',
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
        }}
      >
        {val}
        {copy && v ? (
          <button
            style={{ marginLeft: 6, verticalAlign: 'middle', opacity: 0.6, background: 'none', border: 'none', color: 'inherit' }}
            onClick={() => navigator.clipboard?.writeText(v)}
            title="复制"
          >
            <Copy size={11} />
          </button>
        ) : null}
      </span>
    </div>
  );
}

function CodeBlock({ body, empty = 'No data' }: { body?: string | null; empty?: string }) {
  return (
    <pre
      style={{
        margin: 0,
        minHeight: 220,
        maxHeight: 420,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: 11,
        lineHeight: 1.55,
        color: body ? 'var(--text-secondary)' : 'var(--text-muted)',
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        padding: 12,
      }}
    >
      {body || empty}
    </pre>
  );
}

function prettyJson(body?: string | null): string | null {
  if (!body) return null;
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function transportLabel(transport?: string | null): string {
  return transport && transport.trim() ? transport.trim() : DASH;
}

function fidelityChips(detail: LlmLogDetail): { label: string; color: string; bg: string }[] {
  const chips: { label: string; color: string; bg: string }[] = [];
  const proto = getProtocolMeta(detail.protocol);
  if (proto) chips.push({ label: proto.label, color: proto.color, bg: proto.bg });
  if (detail.transport) chips.push({ label: transportLabel(detail.transport), color: 'var(--accent)', bg: 'var(--accent-soft)' });
  try {
    const body = JSON.parse(detail.requestBodyRedacted || '{}');
    if (typeof body?.top_p === 'number') chips.push({ label: `top_p=${body.top_p}`, color: '#a5b4fc', bg: 'rgba(165,180,252,0.16)' });
    if (typeof body?.top_k === 'number') chips.push({ label: `top_k=${body.top_k}`, color: '#a5b4fc', bg: 'rgba(165,180,252,0.16)' });
    const tools = Array.isArray(body?.tools) ? body.tools.length : 0;
    if (tools > 0) chips.push({ label: `tools=${tools}`, color: '#38bdf8', bg: 'rgba(56,189,248,0.16)' });
  } catch {
    /* ignore */
  }
  return chips;
}

export function GenerationDetailsDrawer({ logId, onClose }: { logId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<LlmLogDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [bodyTab, setBodyTab] = useState<'request' | 'response' | 'raw'>('request');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getLogDetail(logId).then((res) => {
      if (!alive) return;
      if (res.success && res.data) setDetail(res.data);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [logId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tps = detail ? computeTokPerSec(detail.outputTokens, detail.durationMs) : null;
  const streaming = detail?.isStreaming == null ? DASH : detail.isStreaming ? '是' : '否';
  const promptBody = detail ? [detail.questionText, detail.systemPromptText].filter(Boolean).join('\n\n---\n\n') || null : null;
  const responseBody = detail
    ? [detail.answerText, detail.thinkingText ? `Thinking\n${detail.thinkingText}` : null, detail.responseToolCalls ? `Tool calls\n${prettyJson(detail.responseToolCalls)}` : null]
        .filter(Boolean)
        .join('\n\n---\n\n') || null
    : null;
  const rawBody = detail
    ? [
        `id: ${detail.id}`,
        `requestId: ${detail.requestId}`,
        `status: ${detail.status}`,
        `model: ${detail.model}`,
        `provider: ${detail.provider}`,
        '',
        prettyJson(detail.requestBodyRedacted) || '',
      ].join('\n')
    : null;

  const node = (
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.58)', backdropFilter: 'blur(2px)' }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          height: '100vh',
          width: 'min(760px, 94vw)',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-page)',
          borderLeft: '1px solid var(--border-subtle)',
          boxShadow: 'var(--shadow-drawer)',
        }}
      >
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div>
            <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--text-primary)' }}>Generation</div>
            <div style={{ marginTop: 2, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
              {detail?.requestId || logId}
            </div>
          </div>
          <button aria-label="关闭详情" onClick={onClose} style={{ background: 'none', border: 'none', opacity: 0.7, color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ flex: 1, padding: '12px 16px', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {loading || !detail ? (
            <SectionLoader text="正在加载详情…" />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 16, fontWeight: 650, color: 'var(--text-primary)' }}>{detail.model || DASH}</span>
                {detail.provider ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· {detail.provider}</span> : null}
                {(() => {
                  const lc = deriveLifecycle(detail);
                  return (
                    <span
                      className={lc.pulse ? 'lg-pulse' : undefined}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        borderRadius: 999,
                        padding: '0 8px',
                        height: 20,
                        fontSize: 10,
                        fontWeight: 600,
                        color: lc.color,
                        background: lc.bg,
                      }}
                      title="请求生命周期：区分已发送未收到 / 接收中 / 已完成"
                    >
                      <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: lc.color }} />
                      {lc.label}
                    </span>
                  );
                })()}
                {fidelityChips(detail).map((c, i) => (
                  <span
                    key={i}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      borderRadius: 999,
                      padding: '0 8px',
                      height: 20,
                      fontSize: 10,
                      fontWeight: 600,
                      color: c.color,
                      background: c.bg,
                    }}
                  >
                    {c.label}
                  </span>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
                <MetricCard title="Provider latency" value={fmtMs(detail.durationMs)} />
                <MetricCard title="First byte" value={detail.firstByteAt ? fmtMs(Date.parse(detail.firstByteAt) - Date.parse(detail.startedAt)) : DASH} />
                <MetricCard title="Throughput" value={tps == null ? DASH : `${tps} tok/s`} />
                <MetricCard title="Cost" value={DASH} note="暂无价格" />
                <MetricCard title="Tokens" value={`${detail.inputTokens ?? DASH} → ${detail.outputTokens ?? DASH}`} />
                <MetricCard
                  title="Fallbacks"
                  value={detail.isFallback ? '是' : '否'}
                  note={detail.isFallback ? detail.fallbackReason ?? undefined : undefined}
                />
              </div>

              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 2 }}>
                <div style={{ fontSize: 12, fontWeight: 650, margin: '8px 0 4px', color: 'var(--text-primary)' }}>Overview</div>
                <Row k="Model ID" v={detail.model} mono />
                <Row k="Protocol" v={detail.protocol} />
                <Row k="Transport" v={transportLabel(detail.transport)} />
                <Row k="Status" v={detail.status} />
                <Row k="Status code" v={detail.statusCode == null ? null : String(detail.statusCode)} />
                <Row k="Expected model" v={detail.expectedModel} mono />
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 650, marginBottom: 4, color: 'var(--text-primary)' }}>Request metadata</div>
                <Row k="App" v={detail.appCallerCodeDisplayName ?? detail.appCallerCode} />
                <Row k="Request ID" v={detail.requestId} mono copy />
                <Row k="Generation ID" v={detail.id} mono copy />
                <Row k="Started" v={detail.startedAt} mono />
                <Row k="First byte" v={detail.firstByteAt} mono />
                <Row k="Ended" v={detail.endedAt} mono />
                <Row k="Finish reason" v={detail.finishReason} />
                <Row k="Streaming" v={streaming} />
                <Row k="Resolution" v={detail.resolutionReason} />
              </div>

              {detail.error ? (
                <div
                  style={{
                    borderRadius: 10,
                    padding: '8px 12px',
                    background: 'var(--err-bg)',
                    border: '1px solid rgba(248,113,113,0.28)',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'var(--err)' }}>Error</div>
                  <pre
                    style={{
                      fontSize: 11,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      color: 'var(--text-secondary)',
                      maxHeight: 180,
                      overflow: 'auto',
                      margin: 0,
                    }}
                  >
                    {detail.error}
                  </pre>
                </div>
              ) : null}

              {detail.responseToolCalls ? (
                <div
                  style={{
                    borderRadius: 10,
                    padding: '8px 12px',
                    background: 'rgba(56,189,248,0.06)',
                    border: '1px solid rgba(56,189,248,0.22)',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, color: 'rgba(56,189,248,0.95)' }}>
                    函数调用 tool_calls{typeof detail.toolCallCount === 'number' ? ` ×${detail.toolCallCount}` : ''}
                  </div>
                  <pre
                    style={{
                      fontSize: 11,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      color: 'var(--text-secondary)',
                      maxHeight: 240,
                      overflow: 'auto',
                      margin: 0,
                    }}
                  >
                    {(() => {
                      try {
                        return JSON.stringify(JSON.parse(detail.responseToolCalls!), null, 2);
                      } catch {
                        return detail.responseToolCalls;
                      }
                    })()}
                  </pre>
                </div>
              ) : null}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-subtle)' }}>
                  {[
                    ['request', 'Request'],
                    ['response', 'Response'],
                    ['raw', 'Raw'],
                  ].map(([key, label]) => {
                    const active = bodyTab === key;
                    return (
                      <button
                        key={key}
                        onClick={() => setBodyTab(key as typeof bodyTab)}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          borderBottom: active ? '1px solid var(--text-primary)' : '1px solid transparent',
                          color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                          fontSize: 12,
                          fontWeight: active ? 650 : 500,
                          padding: '9px 10px',
                          marginBottom: -1,
                        }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                {bodyTab === 'request' ? <CodeBlock body={promptBody || prettyJson(detail.requestBodyRedacted)} empty="No request payload recorded" /> : null}
                {bodyTab === 'response' ? <CodeBlock body={responseBody} empty="No response payload recorded" /> : null}
                {bodyTab === 'raw' ? <CodeBlock body={rawBody} empty="No raw payload recorded" /> : null}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
