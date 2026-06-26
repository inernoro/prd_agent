// OpenRouter 风格「Generation details」右侧抽屉。
// frontend-modal.md：createPortal 到 body + inline 高度 + 滚动区 minHeight:0 + overscroll contain。
// 主题 token，不写死暗/浅色。DB 无字段的项统一「—」+ 注明（no-rootless-tree）。

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getLlmLogDetail } from '@/services';
import type { LlmRequestLog } from '@/types/admin';
import { MapSectionLoader } from '@/components/ui/VideoLoader';
import { getProtocolMeta } from '@/lib/protocolRegistry';
import { Copy, X } from 'lucide-react';
import { DASH, computeTokPerSec, fmtMs } from './llmLogsView.helpers';

function MetricCard({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <div
      className="shrink-0 rounded-[12px] px-3 py-2 min-w-[150px]"
      style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-card, rgba(255,255,255,0.03))' }}
    >
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{title}</div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{value}</div>
      {note ? <div className="text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{note}</div> : null}
    </div>
  );
}

function Row({ k, v, mono, copy }: { k: string; v?: string | null; mono?: boolean; copy?: boolean }) {
  const val = v && v.trim() ? v : DASH;
  return (
    <div className="flex items-start justify-between gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
      <span className="text-[12px] shrink-0" style={{ color: 'var(--text-muted)' }}>{k}</span>
      <span className={`text-[12px] text-right break-all ${mono ? 'font-mono' : ''}`} style={{ color: 'var(--text-secondary)' }}>
        {val}
        {copy && v ? (
          <button
            className="ml-1.5 align-middle opacity-60 hover:opacity-100"
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

function Collapsible({ title, body }: { title: string; body?: string | null }) {
  const [open, setOpen] = useState(false);
  if (!body) return null;
  return (
    <div className="rounded-[10px]" style={{ border: '1px solid var(--border-subtle)' }}>
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-[12px] font-semibold"
        style={{ color: 'var(--text-secondary)' }}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{title}</span>
        <span style={{ color: 'var(--text-muted)' }}>{open ? '收起' : `展开 (${body.length} 字符)`}</span>
      </button>
      {open ? (
        <pre
          className="px-3 pb-3 text-[11px] whitespace-pre-wrap break-all"
          style={{ color: 'var(--text-secondary)', maxHeight: 320, overflow: 'auto', margin: 0 }}
        >
          {body}
        </pre>
      ) : null}
    </div>
  );
}

// 解析请求体里的保真参数 chips
function fidelityChips(detail: LlmRequestLog): { label: string; color: string; bg: string }[] {
  const chips: { label: string; color: string; bg: string }[] = [];
  const proto = getProtocolMeta(detail.protocol);
  if (proto) chips.push({ label: proto.label, color: proto.color, bg: proto.bg });
  try {
    const body = JSON.parse(detail.requestBodyRedacted || '{}');
    let vd: string | null = null;
    for (const m of Array.isArray(body?.messages) ? body.messages : []) {
      if (Array.isArray(m?.content)) for (const p of m.content) { if (typeof p?.image_url?.detail === 'string') { vd = p.image_url.detail; break; } }
      if (vd) break;
    }
    if (vd) chips.push({ label: `detail=${vd}`, color: '#34d399', bg: 'rgba(52,211,153,0.14)' });
    if (typeof body?.top_p === 'number') chips.push({ label: `top_p=${body.top_p}`, color: '#a5b4fc', bg: 'rgba(165,180,252,0.16)' });
    if (typeof body?.top_k === 'number') chips.push({ label: `top_k=${body.top_k}`, color: '#a5b4fc', bg: 'rgba(165,180,252,0.16)' });
    const tools = Array.isArray(body?.tools) ? body.tools.length : 0;
    if (tools > 0) chips.push({ label: `tools=${tools}`, color: '#38bdf8', bg: 'rgba(56,189,248,0.16)' });
  } catch { /* ignore */ }
  return chips;
}

export function GenerationDetailsDrawer({ logId, onClose }: { logId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<LlmRequestLog | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getLlmLogDetail(logId).then((res) => {
      if (!alive) return;
      if (res.success && res.data) setDetail(res.data);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [logId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const tps = detail ? computeTokPerSec(detail.outputTokens, detail.durationMs) : null;
  const streaming = detail?.isStreaming == null ? DASH : detail.isStreaming ? '是' : '否';

  const node = (
    <div className="fixed inset-0 z-[100]" onClick={onClose} style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}>
      <div
        className="absolute top-0 right-0 flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{
          height: '100vh',
          width: 'min(720px, 94vw)',
          // 必须用「完全不透明」surface：--bg-card 在暗色主题是 rgba(255,255,255,0.08) 几乎透明，
          // 会把背后表格透出来（看不清）。--bg-elevated 是不透明的（暗 #1e1e24 / 亮 #F0EEE8）。
          background: 'var(--bg-elevated, #1e1e24)',
          borderLeft: '1px solid var(--border-subtle)',
          boxShadow: '-8px 0 40px rgba(0,0,0,0.5)',
        }}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>Generation details</div>
          <button onClick={onClose} className="opacity-70 hover:opacity-100" style={{ color: 'var(--text-secondary)' }}><X size={18} /></button>
        </div>

        <div className="flex-1 px-4 py-3 space-y-4" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {loading || !detail ? (
            <MapSectionLoader text="正在加载详情…" />
          ) : (
            <>
              {/* 顶部模型/协议 chips */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{detail.model || DASH}</span>
                {detail.provider ? <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>· {detail.provider}</span> : null}
                {fidelityChips(detail).map((c, i) => (
                  <span key={i} className="inline-flex items-center rounded-full px-2 h-5 text-[10px] font-semibold" style={{ color: c.color, background: c.bg }}>{c.label}</span>
                ))}
              </div>

              {/* 6 指标卡（横排，手机端横滚） */}
              <div className="flex gap-2 overflow-x-auto pb-1">
                <MetricCard title="Provider latency" value={fmtMs(detail.durationMs)} />
                <MetricCard title="Throughput" value={tps == null ? DASH : `${tps} tok/s`} />
                <MetricCard title="Cost" value={DASH} note="暂无价格" />
                <MetricCard title="Tokens" value={`${detail.inputTokens ?? DASH} → ${detail.outputTokens ?? DASH}`} />
                <MetricCard title="Fallbacks" value={detail.isFallback ? '是' : '否'} note={detail.isFallback ? (detail.fallbackReason ?? undefined) : undefined} />
                <MetricCard title="Fallback latency" value={detail.isFallback ? fmtMs(detail.durationMs) : DASH} />
              </div>

              {/* Overview */}
              <div>
                <div className="text-[12px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Overview</div>
                <Row k="Model ID" v={detail.model} mono />
                <Row k="Protocol" v={detail.protocol} />
                <Row k="Canonical ID" v={null} />
                <Row k="Data policy" v={null} />
              </div>

              {/* Request */}
              <div>
                <div className="text-[12px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Request</div>
                <Row k="App" v={detail.appCallerCodeDisplayName ?? detail.appCallerCode} />
                <Row k="Request ID" v={detail.requestId} mono copy />
                <Row k="Generation ID" v={detail.id} mono copy />
                <Row k="Finish reason" v={detail.finishReason} />
                <Row k="Streaming" v={streaming} />
                <Row k="Resolution" v={detail.resolutionReason} />
              </div>

              {/* Provider Responses（partial：仅最终一条 + 进度条） */}
              <div>
                <div className="text-[12px] font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>Provider Responses</div>
                <div className="rounded-[10px] px-3 py-2" style={{ border: '1px solid var(--border-subtle)' }}>
                  <div className="flex items-center justify-between text-[12px]">
                    <span style={{ color: 'var(--text-secondary)' }}>{detail.provider || DASH}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{fmtMs(detail.durationMs)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base, rgba(255,255,255,0.06))' }}>
                    <div className="h-full rounded-full" style={{ width: '100%', background: 'rgba(56,189,248,0.7)' }} />
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>无逐次上游分解（仅最终响应耗时）</div>
                </div>
              </div>

              {/* tool_calls */}
              {detail.responseToolCalls ? (
                <div className="rounded-[10px] px-3 py-2" style={{ background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.22)' }}>
                  <div className="text-[12px] font-semibold mb-1" style={{ color: 'rgba(56,189,248,0.95)' }}>
                    函数调用 tool_calls{typeof detail.toolCallCount === 'number' ? ` ×${detail.toolCallCount}` : ''}
                  </div>
                  <pre className="text-[11px] whitespace-pre-wrap break-all" style={{ color: 'var(--text-secondary)', maxHeight: 240, overflow: 'auto', margin: 0 }}>
                    {(() => { try { return JSON.stringify(JSON.parse(detail.responseToolCalls!), null, 2); } catch { return detail.responseToolCalls; } })()}
                  </pre>
                </div>
              ) : null}

              {/* Prompt / Completion */}
              <div className="space-y-2">
                <Collapsible title="Prompt（用户输入 + 系统提示）" body={[detail.questionText, detail.systemPromptText].filter(Boolean).join('\n\n---\n\n') || null} />
                <Collapsible title="Completion（模型输出）" body={detail.answerText} />
                <Collapsible title="Thinking（思考过程）" body={detail.thinkingText} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
