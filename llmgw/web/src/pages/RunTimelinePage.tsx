// 任务诊断时间线：把一次业务任务（一个 RunId）在网关留下的全部上游调用排成一条链。
//
// 存在的理由：客服和开发此前拿着一个 RunId 在请求记录页反复筛选、逐条点开对时间，
// 才能拼出「卡在哪一步、重试了几次、总共等了多久」。这一页把那三个问题直接答在最上面，
// 深链可直接发给同事（/logs/runs/{runId}）。
//
// 数据只到定位层（操作类型 / 时间 / 耗时 / 状态 / 模型 / 错误摘要），不含提示词与回答正文，
// 与请求记录列表同为 LogsRead 权限。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, ArrowUpRight, Check, Copy, RefreshCw, Search } from 'lucide-react';
import { getRunTimeline } from '@/lib/api';
import type { RunTimelineData, RunTimelineStep } from '@/lib/types';
import { DetailsBlock, PageBody, PageHeader, PageShell } from '@/components/PageShell';
import { Button, Card, Chip, InlineAlert, SectionLoader } from '@/components/ui';
import { DASH, deriveLifecycle, fmtDate, fmtMs, getOperationMeta } from '@/lib/logsHelpers';

/** 整体状态的中文口径：用户要的是「这条任务现在什么下场」，不是英文枚举。 */
const TIMELINE_STATUS_META: Record<string, { label: string; color: string; bg: string; hint: string }> = {
  succeeded: { label: '已完成', color: 'var(--ok)', bg: 'var(--ok-bg)', hint: '全部步骤成功。' },
  recovered: { label: '重试后完成', color: 'var(--warn)', bg: 'var(--warn-bg)', hint: '中途失败过，重试后跑通。' },
  failed: { label: '失败', color: 'var(--err)', bg: 'var(--err-bg)', hint: '末步失败，卡点见下方高亮。' },
  running: { label: '进行中', color: 'var(--info)', bg: 'var(--info-bg)', hint: '仍有步骤未结束。' },
  empty: { label: '无记录', color: 'var(--text-muted)', bg: 'var(--bg-elevated)', hint: '该时间窗内没有记录。' },
};

function statusMeta(status: string) {
  return TIMELINE_STATUS_META[status] ?? { label: status || DASH, color: 'var(--text-muted)', bg: 'var(--bg-elevated)', hint: '' };
}

function Metric({ title, value, note }: { title: string; value: string; note?: string }) {
  return (
    <div
      style={{
        minWidth: 0,
        padding: '10px 12px',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border-subtle)',
        background: 'var(--bg-input)',
      }}
    >
      <div style={{ fontSize: 'var(--fs-secondary)', color: 'var(--text-muted)' }}>{title}</div>
      <div className="tabular" style={{ marginTop: 4, fontSize: 'var(--fs-heading)', fontWeight: 650, color: 'var(--text-primary)' }}>{value}</div>
      {note ? <div style={{ marginTop: 3, fontSize: 'var(--fs-caption)', color: 'var(--text-muted)' }}>{note}</div> : null}
    </div>
  );
}

function StepRow({ step, isStuck }: { step: RunTimelineStep; isStuck: boolean }) {
  const operation = getOperationMeta(step.operation);
  const lifecycle = deriveLifecycle(step);
  const failed = step.status?.toLowerCase() === 'failed' || (step.statusCode != null && step.statusCode >= 400);

  return (
    <li style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr)', gap: 10, listStyle: 'none' }}>
      {/* 序号 + 竖直连接线：一眼看出这是一条链而不是一堆并列卡片 */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span
          className="tabular"
          style={{
            width: 24,
            height: 24,
            flexShrink: 0,
            borderRadius: 999,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 'var(--fs-micro)',
            fontWeight: 650,
            color: failed ? 'var(--err)' : 'var(--text-secondary)',
            background: failed ? 'var(--err-bg)' : 'var(--bg-elevated)',
            border: `1px solid ${failed ? 'var(--err)' : 'var(--border-subtle)'}`,
          }}
        >
          {step.order}
        </span>
        <span style={{ flex: 1, width: 1, minHeight: 8, background: 'var(--border-subtle)' }} />
      </div>

      <div
        style={{
          minWidth: 0,
          marginBottom: 8,
          padding: '10px 12px',
          borderRadius: 'var(--radius-sm)',
          border: `1px solid ${isStuck ? 'var(--err)' : 'var(--border-subtle)'}`,
          background: isStuck ? 'var(--err-bg)' : 'var(--bg-surface)',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Chip label={operation.label} color={operation.color} bg={operation.bg} />
          <Chip label={lifecycle.label} color={lifecycle.color} bg={lifecycle.bg} />
          {step.isRetry ? <Chip label="重试" color="var(--warn)" bg="var(--warn-bg)" /> : null}
          {isStuck ? <Chip label="卡点" color="var(--err)" bg="var(--err-bg)" /> : null}
          <span className="tabular" style={{ fontSize: 'var(--fs-secondary)', color: 'var(--text-muted)' }}>
            {fmtDate(step.startedAt)}
          </span>
          <span className="tabular" style={{ fontSize: 'var(--fs-secondary)', color: 'var(--text-secondary)' }}>
            耗时 {fmtMs(step.durationMs)}
          </span>
          {step.gapMsFromPrevious != null && step.gapMsFromPrevious > 0 ? (
            <span className="tabular" style={{ fontSize: 'var(--fs-secondary)', color: 'var(--text-muted)' }}>
              距上一步 {fmtMs(step.gapMsFromPrevious)}
            </span>
          ) : null}
          <Link
            to={`/logs/${encodeURIComponent(step.logId)}`}
            style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--fs-secondary)', color: 'var(--accent)' }}
          >
            请求详情
            <ArrowUpRight size={13} />
          </Link>
        </div>

        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 'var(--fs-secondary)', color: 'var(--text-muted)' }}>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{step.model || DASH}</span>
          <span>{step.provider || DASH}</span>
          {step.statusCode != null ? <span className="tabular">HTTP {step.statusCode}</span> : null}
          {step.logicalRequestId ? (
            <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{step.logicalRequestId}</span>
          ) : null}
        </div>

        {step.error ? (
          <div
            style={{
              marginTop: 6,
              fontSize: 'var(--fs-secondary)',
              color: 'var(--err)',
              wordBreak: 'break-word',
              lineHeight: 'var(--lh-body)',
            }}
          >
            {step.error}
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function RunTimelinePage() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const from = searchParams.get('from') ?? undefined;
  const to = searchParams.get('to') ?? undefined;

  const [data, setData] = useState<RunTimelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState(runId ?? '');
  const [copied, setCopied] = useState(false);

  useEffect(() => { setDraftId(runId ?? ''); }, [runId]);

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    const res = await getRunTimeline(runId, { from, to });
    if (res.success && res.data) {
      setData(res.data);
    } else {
      setData(null);
      setError(res.error?.message || '时间线加载失败');
    }
    setLoading(false);
  }, [runId, from, to]);

  useEffect(() => { void load(); }, [load]);

  const pollCount = useMemo(
    () => data?.operationCounts.find((c) => c.operation === 'status')?.count ?? 0,
    [data],
  );

  const meta = statusMeta(data?.status ?? 'empty');

  const copyLink = () => {
    void navigator.clipboard?.writeText(window.location.href);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const submitDraft = (event: React.FormEvent) => {
    event.preventDefault();
    const next = draftId.trim();
    if (next && next !== runId) navigate(`/logs/runs/${encodeURIComponent(next)}`);
  };

  if (!runId) {
    return (
      <PageShell>
        <PageHeader title="任务诊断时间线" subtitle="按时间串起一次任务的全部上游调用。" />
        <PageBody>
          <InlineAlert tone="info">缺少任务 ID。</InlineAlert>
          <DetailsBlock title="从哪里进来">
            请求记录页填「运行 ID」筛选框后点「查看任务时间线」，或在任一条请求详情的「路由过程」里点「查看任务时间线」。
          </DetailsBlock>
        </PageBody>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="任务诊断时间线"
        subtitle="按时间串起一次任务的全部上游调用。"
        summary={
          <>
            任务 ID <span style={{ fontFamily: 'var(--font-mono)' }}>{runId}</span>
            {data && data.stepCount > 0 ? ` · 共 ${data.stepCount} 步` : ''}
            {data?.appCallerCode ? ` · ${data.appCallerCode}` : ''}
          </>
        }
        actions={
          <>
            <form onSubmit={submitDraft} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                aria-label="任务 ID"
                value={draftId}
                onChange={(event) => setDraftId(event.target.value)}
                placeholder="换一个任务 ID"
                spellCheck={false}
                style={{ width: 220 }}
              />
              <Button type="submit" size="sm" variant="secondary"><Search size={14} />查看</Button>
            </form>
            <Button size="sm" variant="secondary" onClick={copyLink}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? '已复制' : '复制链接'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} />刷新
            </Button>
          </>
        }
      />

      <PageBody>
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}

        {loading && !data ? (
          <SectionLoader text="正在按任务 ID 汇总上游调用" />
        ) : null}

        {data ? (
          <>
            <Card style={{ padding: 14 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <Chip label={meta.label} color={meta.color} bg={meta.bg} />
                <span style={{ fontSize: 'var(--fs-body)', color: 'var(--text-secondary)' }}>{meta.hint}</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
                <Metric
                  title="总共等了多久"
                  value={fmtMs(data.totalDurationMs)}
                  note={`上游实际处理 ${fmtMs(data.upstreamDurationMs)}`}
                />
                <Metric title="步骤数" value={String(data.stepCount)} note={data.startedAt ? `始于 ${fmtDate(data.startedAt)}` : undefined} />
                <Metric title="重试次数" value={String(data.retryCount)} note={data.failedStepCount > 0 ? `失败步骤 ${data.failedStepCount}` : '无失败步骤'} />
                <Metric title="状态查询次数" value={String(pollCount)} note="轮询次数多说明上游处理慢" />
                <Metric
                  title="卡在哪一步"
                  value={data.stuckStepOrder != null ? `第 ${data.stuckStepOrder} 步` : '未卡住'}
                  note={data.stuckStepOperation ? getOperationMeta(data.stuckStepOperation).label : undefined}
                />
              </div>
              {data.firstError ? (
                <div style={{ marginTop: 10, display: 'flex', gap: 6, alignItems: 'flex-start', fontSize: 'var(--fs-body)', color: 'var(--err)' }}>
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
                  <span style={{ wordBreak: 'break-word' }}>首个错误：{data.firstError}</span>
                </div>
              ) : null}
              {data.models.length > 0 ? (
                <div style={{ marginTop: 10, fontSize: 'var(--fs-secondary)', color: 'var(--text-muted)' }}>
                  涉及模型：<span style={{ fontFamily: 'var(--font-mono)' }}>{data.models.join('、')}</span>
                </div>
              ) : null}
            </Card>

            {data.stepCount === 0 ? (
              <>
                <InlineAlert tone="info">最近 90 天内没有这个任务的记录。</InlineAlert>
                <DetailsBlock title="可能的原因">
                  任务 ID 抄错；或该任务超出 90 天默认窗口（在地址后追加 from / to 参数可放宽）；
                  或它属于你当前角色看不到的团队。可先回请求记录页用「运行 ID」筛选核对一次。
                </DetailsBlock>
              </>
            ) : (
              <Card style={{ padding: 14 }}>
                <ul style={{ margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
                  {data.steps.map((step) => (
                    <StepRow key={step.logId} step={step} isStuck={data.stuckStepOrder === step.order} />
                  ))}
                </ul>
              </Card>
            )}

            <DetailsBlock title="怎么读这条时间线">
              每一步是一次真实的上游调用：「任务提交」发起，「状态查询」是等结果时的轮询，「结果下载」取回产物。
              「距上一步」是两次调用之间的空档，等待主要花在这里；「重试」标记同一逻辑请求的第二次及以后的提交。
              点任一步的「请求详情」可看该次调用的完整记录。
            </DetailsBlock>
          </>
        ) : null}
      </PageBody>
    </PageShell>
  );
}
