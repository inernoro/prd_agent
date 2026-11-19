import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getConsumptionAlerts, resolveConsumptionAlert } from '@/lib/api';
import type { ConsumptionAlert, ConsumptionAlertAction } from '@/lib/types';
import { fmtDate } from '@/lib/logsHelpers';
import { Button } from './ui';

const resolutionErrors: Record<string, string> = {
  RESOLUTION_FORBIDDEN: '当前账号无法执行此处理，请联系调用方负责人或网关管理员。',
  ALERT_RETRY_NOT_LINKED: '此预警没有可关联的批次，请从原业务入口补跑未完成项。',
  QUOTA_WINDOW_ENDED: '限流窗口已结束，请核对当前批次。',
  QUOTA_REQUEST_CHANGED: '临时额度已处理或到期，请查看最新结果。',
  QUOTA_INPUT_INVALID: '请核对额外次数和申请理由后再提交。',
};

const localTime = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });

export function ConsumptionAlertsPanel({ refreshToken }: { refreshToken: number }) {
  const [alerts, setAlerts] = useState<ConsumptionAlert[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const result = await getConsumptionAlerts();
        if (!active) return;
        if (result.success && result.data) {
          setAlerts(result.data.items ?? []);
          setError(null);
        } else {
          setError('请求预警暂时无法更新，请刷新请求记录。');
        }
      } catch {
        if (active) setError('请求预警暂时无法更新，请刷新请求记录。');
      } finally {
        if (active) {
          setNow(Date.now());
          if (expanded) timer = setTimeout(load, 12_000);
        }
      }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [refreshToken, revision, expanded]);

  if (error && alerts.length === 0) return <p role="status" style={{ color: 'var(--text-muted)', margin: 0 }}>{error}</p>;
  if (alerts.length === 0) return null;

  return (
    <details onToggle={(event) => setExpanded(event.currentTarget.open)}
      style={{ flexShrink: 0, border: '1px solid var(--warn)', borderRadius: 8, padding: '8px 12px' }}>
      <summary style={{ cursor: 'pointer', color: 'var(--warn)' }}>
        <AlertTriangle size={15} aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 8 }} />
        平台请求预警：{alerts.some((alert) => alert.kind === 'blocked') ? '已拦截超限调用' : alerts.some((alert) => alert.metric === 'request_rate_baseline') ? '检测到调用量异常增长' : '调用量接近保护上限'}，展开查看
      </summary>
      <p style={{ color: 'var(--text-secondary)', margin: '8px 0' }}>
        以下为最近 7 天预警。固定限制在对应窗口结束后恢复；动态增长预警仅提示历史基线变化，不修改现有限额。请先核对任务范围，避免重复重试。次数保护不代表实际费用上限。
      </p>
      {error && <p role="status">{error}</p>}
      <ul style={{ paddingLeft: 20, margin: 0, maxHeight: 'min(65vh, 600px)', overflowY: 'auto' }}>
        {alerts.map((alert) => (
          <li key={alert.id} style={{ marginBottom: 8, overflowWrap: 'anywhere' }}>
            <strong>{alert.kind === 'blocked' ? '已拦截' : alert.metric === 'request_rate_baseline' ? '动态增长' : '接近上限'}</strong>{' · '}
            {alert.scope === 'tenant' ? '租户合计' : <span title={alert.appCallerCode}>{alert.appCallerTitle || alert.appCallerCode}</span>}{' · '}
            <span title={alert.origin === 'automatic' ? undefined : '一般基线与自动基线独立；已明确配置的共享限额仍汇总全部调用。'}>
              {alert.origin === 'automatic' ? '后台自动任务' : '一般调用'}
            </span>{' · '}
            {alert.windowSeconds === 86400 ? '每日' : alert.windowSeconds === 3600 ? '每小时' : '每分钟'}{' '}
            {alert.count} / {alert.limit}{alert.metric === 'request_rate_baseline' ? '（动态触发线）' : ''}{' · '}{fmtDate(alert.windowStart)}
            {alert.metric === 'request_rate_baseline' ? <span> · 历史均值 {alert.baselineAverage ?? '未知'}，{alert.baselineSamples ?? 0} 个已结束窗口</span> : null}
            {alert.sourceDeployment ? <span title="触发此预警的来源标签；计数合并了全部实例与版本。" style={{ color: 'var(--text-muted)' }}> · 来源 {alert.sourceDeployment}</span> : null}
            {alert.owner && <span> · 负责人 {alert.owner}</span>}
            {alert.kind === 'blocked' && alert.restoresAt && (
              <AlertResolution alert={alert} restoresAt={alert.restoresAt} now={now} refresh={() => setRevision(value => value + 1)} />
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function AlertResolution({ alert, restoresAt, now, refresh }: {
  alert: ConsumptionAlert;
  restoresAt: string;
  now: number;
  refresh: () => void;
}) {
  const [quotaForm, setQuotaForm] = useState(false);
  const [units, setUnits] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<ConsumptionAlertAction['action'] | null>(null);
  const [message, setMessage] = useState('');
  const { retry, quota } = alert;
  const recovered = Date.parse(restoresAt) <= now;
  const quotaPending = quota?.state === 'pending' && !recovered;
  const quotaState = quota?.state === 'approved' ? (recovered ? '已到期' : '已生效')
    : quota?.state === 'denied' ? '未批准' : quotaPending ? '待审批' : '已到期';

  async function apply(action: ConsumptionAlertAction) {
    setBusy(action.action);
    setMessage('');
    try {
      const result = await resolveConsumptionAlert(alert.id, action);
      if (!result.success) {
        setMessage(resolutionErrors[result.error?.code ?? ''] ?? '未能确认处理结果，请查看最新状态后再操作。');
      } else {
        setQuotaForm(false);
        setMessage('处理已记录。');
      }
    } catch {
      setMessage('未能确认处理结果，请查看最新状态后再操作。');
    } finally {
      setBusy(null);
      refresh();
    }
  }

  function requestQuota(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void apply({ action: 'request-quota', units: Number(units), reason: reason.trim() });
  }

  const showActions = alert.canRequestResolution;
  const retryResult = [
    retry?.queued ? `${retry.queued} 个批次已安排，等待调用方回执` : '',
    retry?.running ? `${retry.running} 个批次已由调用方领取，正在补跑` : '',
    retry?.completed ? `${retry.completed} 个批次已完成，共补跑 ${retry.completedCount} 项` : '',
    retry?.failed ? `${retry.failed} 个批次补跑失败，请到原业务入口核对` : '',
    retry?.expired ? `${retry.expired} 个批次已超过补跑期限` : '',
  ].filter(Boolean).join('。');

  return (
    <div style={{ display: 'grid', gap: 6, margin: '6px 0 12px', color: 'var(--text-secondary)' }}>
      <div>
        <strong>{recovered ? '额度已恢复' : '不操作'}</strong>
        {' · '}{localTime(restoresAt)}{recovered ? ' 已结束本次限流窗口。' : ' 自动恢复本窗口额度。'}
        {' '}被拦截的请求保留原结果，有需要可补跑未完成项。
      </div>
      {retryResult && <div role="status">补跑 · {retryResult}。</div>}
      {!retry && showActions && <div>这条预警未关联可补跑的批次，可从原业务入口处理未完成项。</div>}
      {quota && (
        <div role="status">
          临时额度 · {quotaState} · +{quota.units} 次 · {localTime(quota.expiresAt)} 到期
          {quota.state === 'approved' && ` · 已使用 ${quota.used} 次`}
          {quota.reason && <div>{quota.reason}</div>}
        </div>
      )}
      {showActions && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          {retry?.available ? <Button size="sm" disabled={busy !== null} onClick={() => void apply({ action: 'retry' })}>
            {busy === 'retry' ? '登记中…' : `${recovered ? '补跑未完成项' : '恢复后补跑'}（${retry.available} 个批次）`}
          </Button> : null}
          {!recovered && !quota && !quotaForm && <Button size="sm" disabled={busy !== null} onClick={() => setQuotaForm(true)}>申请临时额度</Button>}
          {quotaPending && alert.canDecideQuota && <>
            <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => void apply({ action: 'approve-quota' })}>批准本窗口额度</Button>
            <Button size="sm" disabled={busy !== null} onClick={() => void apply({ action: 'deny-quota' })}>拒绝申请</Button>
          </>}
        </div>
      )}
      {quotaForm && !recovered && !quota && (
        <form onSubmit={requestQuota} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <label>额外次数 <input type="number" min={1} max={alert.limit} required value={units} onChange={event => setUnits(event.target.value)} style={{ maxWidth: 85 }} /></label>
          <label>申请理由 <input required maxLength={300} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <Button size="sm" type="submit" variant="primary" disabled={busy !== null || !reason.trim()}>
            {busy === 'request-quota' ? '提交中…' : '提交申请'}
          </Button>
          <Button size="sm" type="button" disabled={busy !== null} onClick={() => setQuotaForm(false)}>取消</Button>
        </form>
      )}
      {message && <div role="status">{message}</div>}
    </div>
  );
}
