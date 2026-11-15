import { useEffect, useState } from 'react';
import { apiRequest } from '@/lib/api';
import { measurementView } from '@/lib/monitorMeasurement';
import type { UptimeSample, UptimeTargetSummary } from '@/lib/monitorCenter';

interface Observation {
  at: string; ok: boolean; elapsedMs: number; code?: number; requestBody?: string; err?: string;
  results: Array<{ path: string; op: string; expected?: string; actual?: string; ok: boolean }>;
  upstreamCalls?: Array<{ requestId: string; operation: string; endpoint: string; received: boolean; status?: number; elapsedMs: number; verdict: string; snapshot?: unknown }>;
}
const at = (value: number | string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const result = (sample: UptimeSample) => sample.noData ? '无有效观测' : sample.up ? '检查通过' : '检查未通过';

export function investigationPrompt(target: UptimeTargetSummary, samples: readonly UptimeSample[], instance = '当前 CDS 实例'): string {
  const facts = samples.slice(0, 20).map(sample => {
    const metric = measurementView(sample);
    return `${at(sample.t)} · ${result(sample)} · ${sample.ms} ms${sample.code ? ` · HTTP ${sample.code}` : ''}${metric ? ` · ${metric.name} 实际 ${metric.actual}，预期 ${metric.expected}` : ''}`;
  });
  return `请调查此监控，先区分采集链路失败、无观测与目标真实异常。\n实例：${instance}\n服务：${target.name}\n项目：${target.projectName || target.projectId || '系统级'}\n环境：${target.environmentLabel}\n目标ID：${target.id}\n检查方式：${target.observeMode === 'passive' ? '被动观测' : '主动检查'}；间隔 ${target.intervalSeconds} 秒\n最近保留的真实采样（最多20次，不代表固定20分钟）：\n${facts.join('\n') || '尚无保留采样'}\n请通过当前CDS授权接口核对该目标的history、observations、故障和事件报告；缺失的请求或响应正文不可推测。请先给证据、影响范围和建议，再准备可审核的修复。任何发布与变更须由用户审批。`;
}

export function MonitorSampleEvidence({ target, samples, busy, error, generatedAt }: { target: UptimeTargetSummary; samples: UptimeSample[]; busy: boolean; error: string; generatedAt: number }): JSX.Element {
  const [expanded, setExpanded] = useState<string>();
  const [open, setOpen] = useState(false);
  const [observations, setObservations] = useState<Observation[]>();
  const [observationError, setObservationError] = useState('');
  const [copyState, setCopyState] = useState('');
  useEffect(() => {
    if (!open || !target.monitorId) return;
    const controller = new AbortController(); setObservationError('');
    void apiRequest<{ observations: Observation[] }>(`/api/uptime/monitors/${encodeURIComponent(target.monitorId)}/observations`, { signal: controller.signal }).then(response => { if (!controller.signal.aborted) setObservations(response.observations); }).catch(error => { if (!controller.signal.aborted) setObservationError(error instanceof Error ? error.message : '观测证据读取失败'); });
    return () => controller.abort();
  }, [open, target.monitorId, generatedAt]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(investigationPrompt(target, samples, window.location.origin)); setCopyState('已复制排查提示词'); }
    catch { setCopyState('复制失败，请检查浏览器剪贴板权限'); }
  };
  return <section className="card monitor-sample-evidence">
    <div className="card-h"><h3>原始采样 · 最近 {samples.length} 次</h3><button className="btn ghost sm" onClick={() => void copy()}>复制排查提示词</button></div>
    <p className="note">未降采样，独立于上方图表范围。{samples.length ? `覆盖 ${at(samples[samples.length - 1].t)} 至 ${at(samples[0].t)}。` : '首次检查后出现。'}点击一行查看本次证据。</p>
    {copyState ? <p role="status" className="note">{copyState}</p> : null}
    {busy ? <div className="history-progress" role="status" aria-label="读取原始采样" /> : null}
    {error ? <p role="alert" className="detail-error">{error}</p> : null}
    <div className="sample-rows">{samples.map(sample => {
      const id = `${sample.t}:${sample.code ?? ''}:${sample.ms}`, metric = measurementView(sample), selected = expanded === id;
      return <div className="sample-row" key={id}><button className="sample-row-trigger" aria-expanded={selected} onClick={() => setExpanded(selected ? undefined : id)}><time>{at(sample.t)}</time><span className={sample.noData ? 'warn' : sample.up ? 'ok' : 'bad'}>{result(sample)}</span><span className="mono">{sample.code ? `HTTP ${sample.code}` : '无 HTTP 回执'}</span><span className="mono">{sample.ms} ms</span><span>{selected ? '收起' : '详情'}</span></button>{selected ? <div className="sample-receipt"><p>{sample.noData ? '没有有效业务观测，不能据此判断目标正常或已恢复。' : sample.up ? '本次满足检查判据。' : sample.code ? '已收到目标 HTTP 回执；请核对状态码和业务判据，HTTP 应答不代表业务正确。' : '本次检查未通过，未保留 HTTP 回执；仅凭此记录不能确认是采集链路还是目标故障。'}</p>{metric ? <p>{metric.name}：实际 <b>{metric.actual}</b> · 预期 <b>{metric.expected}</b> · {metric.gap}</p> : null}{sample.finding || sample.err ? <p>{sample.finding || sample.err}</p> : null}{sample.exchange ? <><h4>请求</h4><code>{sample.exchange.request.method} {sample.exchange.request.url}</code><h4>返回</h4><pre>{sample.exchange.response ? JSON.stringify(sample.exchange.response, null, 2) : '未取得响应回执'}</pre><p className="note">{sample.exchange.note}</p></> : <p className="note">此历史样本未保留请求／返回摘录。以下功能或 MCP 观测可能有额外证据，不补造旧回包。</p>}</div> : null}</div>;
    })}</div>
    {target.monitorId && (target.functional || target.observeMode === 'passive') ? <details className="observation-evidence" open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>请求／返回观测证据（功能检查与 MCP）</summary>{observationError ? <p role="alert" className="detail-error">{observationError}</p> : observations === undefined ? <div className="history-progress" role="status" aria-label="读取观测证据" /> : !observations.length ? <p className="note">尚无保留的功能观测记录。</p> : observations.map((observation, index) => <details key={`${observation.at}:${index}`}><summary>{at(observation.at)} · {observation.ok ? '判据通过' : '判据未通过'} · {observation.elapsedMs} ms</summary><p className="note">这份观测以自身时间标记，与上方采样不强行按行号配对。</p><h4>请求正文（脱敏）</h4><pre>{observation.requestBody || '未保留正文；MCP 只保留调用回执，不保存工具产物正文。'}</pre><h4>返回判据摘录</h4><pre>{JSON.stringify(observation.results, null, 2)}</pre>{observation.err ? <p>{observation.err}</p> : null}{observation.upstreamCalls?.map((call, callIndex) => <div key={`${call.requestId}:${call.operation}:${callIndex}`}><h4>MCP · {call.operation}</h4><p>{call.requestId} · {call.received ? `已收到 HTTP ${call.status ?? '—'}` : '未收到响应'} · {call.elapsedMs} ms · {call.verdict}</p><code>{call.endpoint}</code><pre>{JSON.stringify(call.snapshot ?? { note: '未保留响应摘录' }, null, 2)}</pre></div>)}</details>)}</details> : null}
  </section>;
}
