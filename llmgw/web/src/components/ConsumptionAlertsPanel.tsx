import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getConsumptionAlerts } from '@/lib/api';
import type { ConsumptionAlert } from '@/lib/types';
import { fmtDate } from '@/lib/logsHelpers';

export function ConsumptionAlertsPanel({ refreshToken }: { refreshToken: number }) {
  const [alerts, setAlerts] = useState<ConsumptionAlert[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getConsumptionAlerts().then((res) => {
      if (!active) return;
      if (res.success && res.data) {
        setAlerts(res.data.items ?? []);
        setError(null);
      } else {
        setAlerts([]);
        setError(res.error?.message || '请求预警暂时无法读取，请刷新重试。');
      }
    }).catch(() => {
      if (!active) return;
      setAlerts([]);
      setError('请求预警暂时无法读取，请刷新重试。');
    });
    return () => { active = false; };
  }, [refreshToken]);

  if (error) return <p role="status" style={{ color: 'var(--text-muted)', margin: 0 }}>{error}</p>;
  if (alerts.length === 0) return null;

  return (
    <details style={{ flexShrink: 0, border: '1px solid var(--warn)', borderRadius: 8, padding: '8px 12px' }}>
      <summary style={{ cursor: 'pointer', color: 'var(--warn)' }}>
        <AlertTriangle size={15} aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 8 }} />
        平台请求预警：{alerts.some((alert) => alert.kind === 'blocked') ? '已拦截超限调用' : '调用量接近保护上限'}，展开查看
      </summary>
      <p style={{ color: 'var(--text-secondary)', margin: '8px 0' }}>
        以下为最近 7 天预警。限制会在对应窗口结束后恢复；请先核对任务范围，避免重复重试。次数保护不代表实际费用上限。
      </p>
      <ul style={{ paddingLeft: 20, margin: 0, maxHeight: 160, overflowY: 'auto' }}>
        {alerts.map((alert) => (
          <li key={alert.id} style={{ marginBottom: 8, overflowWrap: 'anywhere' }}>
            <strong>{alert.kind === 'blocked' ? '已拦截' : '接近上限'}</strong>{' · '}
            {alert.scope === 'tenant' ? '租户合计' : alert.appCallerCode}{' · '}
            <span title={alert.origin === 'automatic' ? undefined : '一般基线与自动基线独立；已明确配置的共享限额仍汇总全部调用。'}>
              {alert.origin === 'automatic' ? '后台自动任务' : '一般调用'}
            </span>{' · '}
            {alert.windowSeconds === 86400 ? '每日' : alert.windowSeconds === 3600 ? '每小时' : '每分钟'}{' '}
            {alert.count} / {alert.limit}{' · '}{fmtDate(alert.windowStart)}
            {alert.sourceDeployment ? <span title="触发此预警的来源标签；计数合并了全部实例与版本。" style={{ color: 'var(--text-muted)' }}> · 来源 {alert.sourceDeployment}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
