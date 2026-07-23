// 右侧详情抽屉（createPortal 到 body + inline 高度 + 滚动区 minHeight:0 + overscroll contain）。
// 移植自 prd-admin GenerationDetailsDrawer，主题 token，缺字段统一「—」。

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowUpRight, Clock3, Coins, Copy, Gauge, RotateCcw, Timer, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getLogDetail } from '@/lib/api';
import type { LlmLogDetail } from '@/lib/types';
import { SectionLoader } from './ui';
import { AppEntityIcon, ModelEntityIcon, ProviderEntityIcon } from './LogEntityIcon';
import { DASH, computeTokPerSec, fmtCost, fmtMs, deriveLifecycle, getProtocolMeta } from '@/lib/logsHelpers';

function MetricCard({ title, value, note, icon }: { title: string; value: string; note?: string; icon: ReactNode }) {
  return (
    <div
      style={{
        flexShrink: 0,
        borderRadius: 'var(--radius-sm)',
        padding: '8px 9px',
        minWidth: 0,
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-input)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-muted)' }}>{icon}{title}</div>
      <div className="tabular" style={{ marginTop: 4, fontSize: 15, fontWeight: 650, color: 'var(--text-primary)' }}>{value}</div>
      {note ? <div style={{ fontSize: 12, marginTop: 3, color: 'var(--text-muted)' }}>{note}</div> : null}
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
        padding: '5px 0',
        borderBottom: '1px solid var(--border-subtle)',
      }}
    >
      <span style={{ fontSize: 14, flexShrink: 0, color: 'var(--text-muted)' }}>{k}</span>
      <span
        style={{
          fontSize: 14,
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
            <Copy size={14} />
          </button>
        ) : null}
      </span>
    </div>
  );
}

function CodeBlock({ body, empty = '暂无数据' }: { body?: string | null; empty?: string }) {
  return (
    <pre
      style={{
        margin: 0,
        minHeight: 220,
        maxHeight: 420,
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        fontSize: 13,
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

function RouterTracePanel({ detail }: { detail: LlmLogDetail }) {
  const trace = detail.routerTrace;
  const steps = trace?.steps?.length
    ? trace.steps
    : [
        { order: 1, stage: 'provider', label: 'actual model', value: detail.model, status: 'info' },
        { order: 2, stage: 'transport', label: 'transport', value: detail.transport, status: 'info' },
      ].filter((step) => step.value);
  return (
    <div
      style={{
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-surface)',
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>路由过程</div>
          <div style={{ marginTop: 2, fontSize: 11, color: 'var(--text-muted)' }}>
            {trace?.mode || detail.modelResolutionType || 'unknown'} · {trace?.transport || detail.transport || 'unknown transport'}
          </div>
        </div>
        {trace?.isFallback || detail.isFallback ? (
          <span style={{ borderRadius: 999, padding: '2px 8px', fontSize: 10, fontWeight: 650, color: '#f59e0b', background: 'rgba(245,158,11,0.15)' }}>
            fallback
          </span>
        ) : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8, marginBottom: 10 }}>
        <TraceMini label="来源" value={trace?.sourceSystem || detail.sourceSystem} />
        <TraceMini label="入口" value={trace?.ingressProtocol || detail.ingressProtocol} />
        <TraceMini label="运行 ID" value={trace?.runId || detail.runId} mono />
        <TraceMini label="路由策略" value={trace?.modelPolicy || detail.modelPolicy || trace?.mode || detail.modelResolutionType} />
        <TraceMini label="期望模型" value={trace?.requestedModel || detail.expectedModel} mono />
        <TraceMini label="逻辑模型" value={trace?.logicalModelPublicId || detail.logicalModelPublicId || trace?.logicalModelId || detail.logicalModelId} mono />
        <TraceMini label="Offering" value={trace?.offeringId || detail.offeringId} mono />
        <TraceMini label="实际模型" value={trace?.actualModel || detail.model} mono />
        <TraceMini label="请求模型池" value={trace?.modelPoolId || detail.modelPoolId} mono />
        <TraceMini label="实际模型池" value={trace?.modelGroupName || detail.modelGroupName || trace?.modelGroupId || detail.modelGroupId} />
        <TraceMini label="Provider" value={trace?.platformName || detail.platformName || trace?.platformId || detail.platformId} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {steps.map((step) => {
          const warning = step.status === 'warning' || step.stage === 'fallback';
          return (
            <div key={`${step.order}-${step.stage}-${step.label}`} style={{ display: 'grid', gridTemplateColumns: '78px 120px minmax(0, 1fr)', gap: 8, alignItems: 'start' }}>
              <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{step.stage}</span>
              <span style={{ fontSize: 11, color: warning ? '#f59e0b' : 'var(--text-secondary)' }}>{step.label}</span>
              <span style={{ fontSize: 11, color: 'var(--text-primary)', wordBreak: 'break-word', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {step.value || DASH}
              </span>
            </div>
          );
        })}
      </div>
      {trace?.fallbackReason || detail.fallbackReason ? (
        <div style={{ marginTop: 10, fontSize: 11, color: '#f59e0b', wordBreak: 'break-word' }}>
          {trace?.fallbackReason || detail.fallbackReason}
        </div>
      ) : null}
    </div>
  );
}

function ProviderResponses({ detail }: { detail: LlmLogDetail }) {
  const attempts: NonNullable<LlmLogDetail['providerAttempts']> = detail.providerAttempts?.length
    ? detail.providerAttempts
    : [{
        order: 1,
        stage: 'provider',
        status: detail.status,
        statusCode: detail.statusCode,
        provider: detail.provider,
        platformName: detail.platformName,
        platformId: detail.platformId,
        model: detail.model,
        durationMs: detail.durationMs,
        transport: detail.transport,
        error: detail.error,
        reason: detail.resolutionReason,
      }];
  const maxDuration = Math.max(1, ...attempts.map((attempt) => attempt.durationMs ?? 0));
  return (
    <section>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>上游响应</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {attempts.map((attempt) => {
          const warning = attempt.status === 'skipped' || attempt.status === 'failed';
          const provider = attempt.platformName || attempt.provider || attempt.platformId || DASH;
          const pool = attempt.modelGroupName || attempt.modelGroupId;
          return (
            <div
              className="lg-provider-response-row"
              key={`${attempt.order}-${attempt.stage}-${attempt.model || provider}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '32px minmax(0, 1fr) auto',
                gap: 12,
                alignItems: 'start',
                borderRadius: 'var(--radius-sm)',
                padding: '11px 12px',
                background: warning ? 'rgba(245,158,11,0.08)' : 'var(--bg-input)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>#{attempt.order || 1}</span>
              <span className="lg-provider-response-main">
                <span className="lg-provider-response-provider">{provider}</span>
                <span className="lg-provider-response-model">{attempt.model || DASH}</span>
                <span className="lg-provider-response-track" aria-hidden="true">
                  <span
                    className={warning ? 'is-warning' : ''}
                    style={{ width: `${Math.max(5, ((attempt.durationMs ?? 0) / maxDuration) * 100)}%` }}
                  />
                </span>
                {pool ? <span className="lg-provider-response-pool">模型池：{pool}</span> : null}
                {attempt.error || attempt.reason ? (
                  <span className="lg-provider-response-reason" style={{ color: warning ? 'var(--warn)' : 'var(--text-muted)' }}>
                    {attempt.error || attempt.reason}
                  </span>
                ) : null}
              </span>
              <span className="tabular" style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {attempt.statusCode ? `HTTP ${attempt.statusCode}` : attempt.status || '待响应'}
                <span style={{ display: 'block', marginTop: 2 }}>{attempt.durationMs == null ? DASH : fmtMs(attempt.durationMs)}</span>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TraceMini({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', padding: '7px 8px', minWidth: 0 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}</div>
      <div
        style={{
          marginTop: 2,
          fontSize: 11,
          color: 'var(--text-secondary)',
          wordBreak: 'break-word',
          fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
        }}
      >
        {value || DASH}
      </div>
    </div>
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

function generationAppName(detail: LlmLogDetail): string {
  const code = detail.appCallerCode?.trim();
  if (code) return code.startsWith('G-') ? code : `G-${code}`;
  return detail.appCallerCodeDisplayName?.trim() || detail.appCallerTitle?.trim() || DASH;
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

export function GenerationDetailsDrawer({
  logId,
  onClose,
  presentation = 'drawer',
}: {
  logId: string;
  onClose: () => void;
  presentation?: 'drawer' | 'page';
}) {
  const isPage = presentation === 'page';
  const [detail, setDetail] = useState<LlmLogDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewTab, setViewTab] = useState<'overview' | 'content' | 'routing' | 'audit'>('overview');
  const [bodyTab, setBodyTab] = useState<'request' | 'response' | 'raw'>('request');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    setViewTab('overview');
    setBodyTab('request');
    getLogDetail(logId).then((res) => {
      if (!alive) return;
      if (res.success && res.data) {
        setDetail(res.data);
      } else {
        setDetail(null);
        setLoadError(res.error?.message || '请求详情加载失败，请稍后重试');
      }
      setLoading(false);
    }).catch(() => {
      if (!alive) return;
      setDetail(null);
      setLoadError('请求详情加载失败，请稍后重试');
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [logId]);

  useEffect(() => {
    if (isPage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPage, onClose]);

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
      className={isPage ? 'lg-generation-page' : undefined}
      style={isPage
        ? { position: 'relative', height: '100%', minHeight: 0, background: 'var(--bg-page)' }
        : { position: 'fixed', inset: 0, zIndex: 100, background: 'rgba(0,0,0,0.58)', backdropFilter: 'blur(2px)' }}
      onClick={isPage ? undefined : onClose}
    >
      <div
        role={isPage ? undefined : 'dialog'}
        aria-modal={isPage ? undefined : true}
        aria-label={isPage ? undefined : '请求详情'}
        onClick={(e) => e.stopPropagation()}
        style={isPage ? {
          position: 'relative',
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-page)',
        } : {
          position: 'absolute',
          top: 0,
          right: 0,
          height: '100vh',
          width: 'min(820px, 96vw)',
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
          padding: '12px 14px',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div>
            {isPage ? (
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 650, color: 'var(--text-primary)' }}>请求详情</h1>
            ) : (
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 650, color: 'var(--text-primary)' }}>请求详情</h2>
            )}
            {detail ? <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', border: '1px solid var(--border-subtle)', borderRadius: 999, color: 'var(--text-primary)', fontSize: 13 }} title={detail.logicalModelPublicId ? `实际上游模型：${detail.model}` : undefined}><ModelEntityIcon model={detail.logicalModelPublicId || detail.model} />{detail.logicalModelPublicId || detail.model || DASH}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', border: '1px solid var(--border-subtle)', borderRadius: 999, color: 'var(--text-secondary)', fontSize: 13 }}><ProviderEntityIcon provider={detail.platformName || detail.provider} />{detail.platformName || detail.provider || DASH}</span>
              {detail.appCallerCode ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px', border: '1px solid var(--border-subtle)', borderRadius: 999, color: 'var(--text-secondary)', fontSize: 13 }}><AppEntityIcon app={detail.appCallerCode} sourceSystem={detail.sourceSystem} />{detail.appCallerCode.startsWith('G-') ? detail.appCallerCode : `G-${detail.appCallerCode}`}</span> : null}
              <span className="tabular" style={{ color: 'var(--text-muted)', fontSize: 13 }}>{new Date(detail.startedAt).toLocaleString('zh-CN', { hour12: false })}</span>
            </div> : <div style={{ marginTop: 3, fontSize: 13, color: 'var(--text-muted)' }}>{logId}</div>}
          </div>
          <div className="lg-generation-header-actions">
            {!isPage ? <Link to={`/logs/${encodeURIComponent(logId)}`} title="在独立页面打开">独立页面<ArrowUpRight size={14} /></Link> : null}
            <button aria-label={isPage ? '返回请求记录' : '关闭详情'} onClick={onClose} style={{ width: isPage ? 'auto' : 44, minWidth: 44, height: 44, padding: isPage ? '0 10px' : 0, gap: 7, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: isPage ? '1px solid var(--border-subtle)' : 'none', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', fontSize: 13 }}>
              {isPage ? <><ArrowLeft size={16} />返回请求记录</> : <X size={18} />}
            </button>
          </div>
        </div>

        <div className={isPage ? 'lg-generation-page-body' : undefined} style={{ flex: 1, padding: isPage ? '18px 20px 28px' : '12px 14px 18px', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {loading ? (
            <SectionLoader text="正在加载详情…" />
          ) : loadError || !detail ? (
            <div className="lg-generation-load-error" role="alert">
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>无法打开这条生成记录</div>
              <div style={{ marginTop: 6, fontSize: 14, color: 'var(--text-muted)' }}>{loadError || '这条记录不存在，或当前租户无权查看。'}</div>
              <button type="button" onClick={onClose}>返回请求记录</button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
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
                        height: 22,
                        fontSize: 11,
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
                      height: 22,
                      fontSize: 11,
                      fontWeight: 600,
                      color: c.color,
                      background: c.bg,
                    }}
                  >
                    {c.label}
                  </span>
                ))}
              </div>

              <div className="lg-generation-view-tabs" role="tablist" aria-label="生成详情分类">
                {[
                  ['overview', '概览'],
                  ['content', '请求与响应'],
                  ['routing', '路由'],
                  ['audit', '审计'],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={viewTab === key}
                    onClick={() => setViewTab(key as typeof viewTab)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {viewTab === 'overview' ? (
                <div className="lg-generation-tab-panel" role="tabpanel">
                  <div className="lg-generation-metrics" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 7 }}>
                    <MetricCard title="上游耗时" value={fmtMs(detail.durationMs)} icon={<Clock3 size={15} aria-hidden="true" />} />
                    <MetricCard title="首字节" value={detail.firstByteAt ? fmtMs(Date.parse(detail.firstByteAt) - Date.parse(detail.startedAt)) : DASH} icon={<Timer size={15} aria-hidden="true" />} />
                    <MetricCard title="生成速度" value={tps == null ? DASH : `${tps} tok/s`} icon={<Gauge size={15} aria-hidden="true" />} />
                    <MetricCard
                      title="费用"
                      value={detail.providerReportedCost == null
                        ? fmtCost(detail.estimatedCost, detail.estimatedCostCurrency)
                        : fmtCost(detail.providerReportedCost, detail.providerCostCurrency)}
                      note={detail.providerReportedCost != null
                        ? `Provider 实际${detail.reconciliationStatus ? ` · ${detail.reconciliationStatus}` : ''}`
                        : detail.estimatedCost == null ? '未知：缺 token 或价格快照' : 'Gateway 估算 · 等待 Provider 对账'}
                      icon={<Coins size={15} aria-hidden="true" />}
                    />
                    <MetricCard title="Token" value={`${detail.inputTokens ?? DASH} → ${detail.outputTokens ?? DASH}`} note="输入 → 输出" icon={<Coins size={15} aria-hidden="true" />} />
                    <MetricCard
                      title="回退"
                      value={detail.isFallback ? '是' : '否'}
                      note={detail.isFallback ? detail.fallbackReason ?? undefined : undefined}
                      icon={<RotateCcw size={15} aria-hidden="true" />}
                    />
                  </div>
                  <section>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>本次生成</div>
                    <Row k="实际模型" v={detail.model} mono copy />
                    <Row k="期望模型" v={detail.expectedModel} mono />
                    <Row k="Provider" v={detail.platformName || detail.provider} />
                    <Row k="应用" v={generationAppName(detail)} />
                    <Row k="协议" v={detail.protocol || detail.ingressProtocol} />
                    <Row k="状态" v={detail.statusCode == null ? detail.status : `${detail.status} · HTTP ${detail.statusCode}`} />
                    <Row k="结束原因" v={detail.finishReason} />
                  </section>
                  <ProviderResponses detail={detail} />
                  {detail.error ? (
                    <div className="lg-generation-error">
                      <div>错误</div>
                      <pre>{detail.error}</pre>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {viewTab === 'content' ? (
                <div className="lg-generation-tab-panel" role="tabpanel">
                  <section>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>请求身份</div>
                    <Row k="应用" v={generationAppName(detail)} />
                    <Row k="接入密钥" v={detail.serviceKeyPrefix || detail.serviceKeyId} mono copy />
                    <Row k="Request ID" v={detail.requestId} mono copy />
                    <Row k="Generation ID" v={detail.id} mono copy />
                    <Row k="流式响应" v={streaming} />
                  </section>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div className="lg-generation-body-tabs" role="tablist" aria-label="请求响应内容">
                      {[
                        ['request', '请求内容'],
                        ['response', '响应内容'],
                        ['raw', '原始数据'],
                      ].map(([key, label]) => (
                        <button
                          key={key}
                          type="button"
                          role="tab"
                          aria-selected={bodyTab === key}
                          onClick={() => setBodyTab(key as typeof bodyTab)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {bodyTab === 'request' ? <CodeBlock body={promptBody || prettyJson(detail.requestBodyRedacted)} empty="未记录请求内容" /> : null}
                    {bodyTab === 'response' ? <CodeBlock body={responseBody} empty="未记录响应内容" /> : null}
                    {bodyTab === 'raw' ? <CodeBlock body={rawBody} empty="未记录原始数据" /> : null}
                  </div>
                  {detail.responseToolCalls ? (
                    <div className="lg-generation-tool-calls">
                      <div>函数调用 tool_calls{typeof detail.toolCallCount === 'number' ? ` ×${detail.toolCallCount}` : ''}</div>
                      <pre>{prettyJson(detail.responseToolCalls)}</pre>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {viewTab === 'routing' ? (
                <div className="lg-generation-tab-panel" role="tabpanel">
                  <RouterTracePanel detail={detail} />
                  <section>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>治理策略</div>
                    <Row k="模型策略" v={detail.modelPolicy} />
                    <Row k="请求模型池" v={detail.modelPoolId} mono />
                    <Row k="解析原因" v={detail.resolutionReason} />
                    <Row k="参数策略" v={detail.parameterPolicy} />
                    <Row k="被丢弃参数" v={detail.droppedParameters?.length ? detail.droppedParameters.join(', ') : null} mono />
                    <Row k="提示词策略" v={detail.promptPolicyId ? `${detail.promptPolicyId} / v${detail.promptPolicyVersion ?? '—'}` : null} mono />
                    <Row k="提示词策略 hash" v={detail.promptPolicyHash} mono />
                  </section>
                </div>
              ) : null}

              {viewTab === 'audit' ? (
                <div className="lg-generation-tab-panel" role="tabpanel">
                  <section>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>费用与对账</div>
                    <Row k="价格币种" v={detail.priceCurrency} />
                    <Row k="输入价格 / 1M" v={detail.inputPricePerMillion == null ? null : String(detail.inputPricePerMillion)} />
                    <Row k="输出价格 / 1M" v={detail.outputPricePerMillion == null ? null : String(detail.outputPricePerMillion)} />
                    <Row k="单次价格" v={detail.pricePerCall == null ? null : String(detail.pricePerCall)} />
                    <Row k="Gateway 输入估算" v={fmtCost(detail.estimatedInputCost, detail.estimatedCostCurrency)} />
                    <Row k="Gateway 输出估算" v={fmtCost(detail.estimatedOutputCost, detail.estimatedCostCurrency)} />
                    <Row k="Gateway 单次估算" v={fmtCost(detail.estimatedCallCost, detail.estimatedCostCurrency)} />
                    <Row k="Provider 实际费用" v={fmtCost(detail.providerReportedCost, detail.providerCostCurrency)} />
                    <Row k="对账状态" v={detail.reconciliationStatus} />
                    <Row k="对账差额" v={fmtCost(detail.reconciliationDelta, detail.estimatedCostCurrency)} />
                    <Row k="汇率快照" v={detail.fxSnapshotId} mono />
                    <Row k="价格快照 hash" v={detail.priceSnapshotHash} mono copy />
                  </section>
                  <section>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>身份与时间</div>
                    <Row k="appCallerCode" v={detail.appCallerCode} mono />
                    <Row k="业务标题" v={detail.appCallerTitle || detail.appCallerCodeDisplayName} />
                    <Row k="团队" v={detail.teamId} mono />
                    <Row k="Client code" v={detail.clientCode} mono />
                    <Row k="环境" v={detail.environment} />
                    <Row k="Service key ID" v={detail.serviceKeyId} mono copy />
                    <Row k="密钥前缀快照" v={detail.serviceKeyPrefix} mono />
                    <Row k="来源系统" v={detail.sourceSystem} />
                    <Row k="入口协议" v={detail.ingressProtocol} />
                    <Row k="Provider request ID" v={detail.providerRequestId} mono copy />
                    <Row k="开始时间" v={detail.startedAt} mono />
                    <Row k="首字节时间" v={detail.firstByteAt} mono />
                    <Row k="结束时间" v={detail.endedAt} mono />
                  </section>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return isPage ? node : createPortal(node, document.body);
}
