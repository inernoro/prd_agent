import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getLogTrace } from '@/lib/api';
import type { LogTraceData } from '@/lib/types';
import { Button, Card, Spinner } from '@/components/ui';
import { fmtCost, fmtDate } from '@/lib/logsHelpers';
import './LogTracePage.css';

const operations: Record<string, string> = { invoke: '调用', submit: '提交作业', status: '查询作业', download: '下载产物', cancel: '取消作业', probe: '探测' };
const statuses: Record<string, string> = { running: '进行中', unknown: '结果未知', succeeded: '成功', success: '成功', failed: '失败', cancelled: '已取消', sent: '已发送', skipped: '未发送' };

export function LogTracePage() {
  const [params, setParams] = useSearchParams();
  const reference = params.get('reference') || '';
  const anchorId = params.get('anchorId') || undefined;
  const page = Number(params.get('page') || 1);
  const [draft, setDraft] = useState(reference);
  const [data, setData] = useState<LogTraceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { setDraft(reference); }, [reference]);
  useEffect(() => {
    let active = true;
    setData(null); setError(null);
    if (!reference) { setBusy(false); return; }
    setBusy(true);
    getLogTrace(reference, anchorId, page).then(result => {
      if (!active) return;
      if (result.success && result.data) setData(result.data);
      else setError(result.error?.message || '暂时无法读取关联记录');
    }).catch(() => { if (active) setError('连接失败，请刷新重试'); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [reference, anchorId, page, refresh]);
  function selectPage(next: number) {
    const query = new URLSearchParams(params);
    query.set('page', String(next)); setParams(query);
  }
  return <div className="lg-log-trace" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div><Link to="/logs">返回调用记录</Link><h1 className="lg-title">调用链排查</h1>
      <p>从业务操作或请求编号查回已保留的关联记录。</p></div>
    <form onSubmit={event => { event.preventDefault(); if (draft.trim()) setParams({ reference: draft.trim() }); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <input aria-label="业务操作或请求编号" maxLength={256} value={draft} onChange={event => setDraft(event.target.value)} placeholder="Run ID / Request ID / 上游作业编号" style={{ flex: 1, minWidth: 220 }} />
      <Button type="submit" disabled={busy || !draft.trim()}>查找调用链</Button>
      <Button type="button" variant="ghost" disabled={busy || !reference} onClick={() => setRefresh(value => value + 1)}>刷新</Button>
    </form>
    {busy ? <div role="status"><Spinner size={16} /> 正在读取关联记录…</div> : null}
    {error ? <div role="alert">{error}</div> : null}
    {data?.ambiguous ? <Card style={{ padding: 16 }}><h2>编号对应多个独立请求，请选择记录</h2><p>相同请求编号不能证明重试或重复记账。</p>
      {data.candidates?.map(candidate => <p key={candidate.id}><Button variant="ghost" onClick={() => setParams({ reference, anchorId: candidate.id })}>
        {candidate.runId || candidate.logicalRequestId || candidate.requestId || candidate.id} · {candidate.id}
      </Button></p>)}
      {data.hasMoreCandidates ? <p>仅显示前 100 个候选，请使用更明确的日志或业务操作编号。</p> : null}
    </Card> : null}
    {data && !data.ambiguous ? <>
      <Card style={{ padding: 16 }}><p>共 {data.total} 条关联记录 · 第 {data.page} 页</p>
        <p>每条记录代表一次网关请求；其下按顺序列出调度尝试。相似正文、同一模型和时间接近均不作为重试证据。</p>
        <p>费用逐项保留来源，不累加作业回执或历史汇总。未返回的实际费用显示未知，估算与实际费用分别展示。</p>
        {data.business ? <div><h2>MAP 视频业务结果</h2>
          <p>业务操作：{data.business.runId} · 状态：{data.business.status || '未知'}</p>
          <p>上游作业：{data.business.providerTaskId || '未记录'} · 上游状态：{data.business.upstreamStatus || '未知'}</p>
          <p style={{ overflowWrap: 'anywhere' }}>最终产物 SHA256：{data.business.artifactSha256 || '未记录，请用运行编号核对业务产物'}</p>
        </div> : <p>暂无授权范围内的 MAP 视频产物证据。</p>}
      </Card>
      {data.items?.map(item => {
        const log = item.log;
        return <Card key={log.id} style={{ padding: 16 }}>
          <h2>{operations[log.operation || 'invoke'] || log.operation} · {item.evidenceGap ? '结果待核实（历史 running）' : statuses[log.status] || log.status} <Link to={`/logs/${encodeURIComponent(log.id)}`}>查看详情</Link></h2>
          <p>{fmtDate(log.startedAt)} · {log.appCallerCodeDisplayName || log.appCallerCode || '调用用途未知'} · {log.model}</p>
          <p>用户 {log.userId || '未知'} · 团队 {log.teamId || '未知'} · 接入身份 {log.clientCode || log.serviceKeyPrefix || log.serviceKeyId || '未知'}</p>
          <p style={{ overflowWrap: 'anywhere' }}>请求 {log.requestId} · 日志 {log.id} · 逻辑请求 {log.logicalRequestId || '未记录'} · 业务操作 {log.runId || '未记录'}</p>
          <p style={{ overflowWrap: 'anywhere' }}>上游作业 {log.providerTaskId || '未记录'} · 上游回执 {log.providerRequestId || '未记录'}</p>
          {item.recordKind === 'legacy-summary' ? <p>历史业务汇总：不代表物理调用，不计入调用与用量统计。</p> : <>
            <p>实际费用：{log.providerReportedCost == null ? '未知' : fmtCost(log.providerReportedCost, log.providerCostCurrency)}{log.providerReportedCost != null && !log.providerCostCurrency ? '（币种未知）' : ''} · Gateway 估算：{log.estimatedCost == null ? '未知' : fmtCost(log.estimatedCost, log.estimatedCostCurrency)}</p>
            <p>输入 / 输出 token：{log.inputTokens ?? '未知'} / {log.outputTokens ?? '未知'} · 用量来源：{log.tokenUsageSource || '未记录'}</p>
            {item.sameReceiptRecords > 1 ? <p>同一上游回执出现在 {item.sameReceiptRecords} 条记录中，需核对重复回执／记账；不能据此认定发生了多次收费。</p> : null}
            {item.attempts.length ? <ol>{item.attempts.map((attempt, index) => <li key={`${attempt.order}-${index}`}>
              第 {attempt.order} 次尝试 · {attempt.stage} · {attempt.platformName || attempt.provider || '上游未知'} / {attempt.model || '型号未知'} · {statuses[attempt.status] || attempt.status}
              {attempt.reachedProvider === true ? ' · 已尝试访问上游' : attempt.reachedProvider === false ? ' · 未记录发送证据' : ' · 访问状态未记录'}
              {attempt.statusCode != null ? ` · HTTP ${attempt.statusCode}` : ''}
              <p style={{ overflowWrap: 'anywhere' }}>尝试编号 {attempt.attemptId || '历史记录未保存'} · 上游回执 {attempt.providerRequestId || '未记录'} · 作业 {attempt.providerTaskId || log.providerTaskId || '未记录'}</p>
              <p>本次尝试实际费用：{attempt.providerReportedCost == null ? '未知' : fmtCost(attempt.providerReportedCost, attempt.providerCostCurrency)} · 输入 / 输出 token：{attempt.inputTokens ?? '未知'} / {attempt.outputTokens ?? '未知'}</p>
              {attempt.error || attempt.reason ? <p>{attempt.error || attempt.reason}</p> : null}
            </li>)}</ol> : <p>缺少逐次上游尝试证据，无法确定物理调用次数。</p>}
          </>}
          {log.error ? <p>失败原因：{log.error}</p> : null}
          {item.lifecycleReason ? <p>收口依据：{item.lifecycleReason}</p> : null}
          {item.evidenceGap ? <p>{item.evidenceGap}</p> : null}
        </Card>;
      })}
      <div style={{ display: 'flex', gap: 8 }}><Button disabled={busy || data.page === 1} onClick={() => selectPage(data.page - 1)}>上一页</Button>
        <Button disabled={busy || data.page * data.pageSize >= data.total} onClick={() => selectPage(data.page + 1)}>下一页</Button></div>
    </> : null}
  </div>;
}
