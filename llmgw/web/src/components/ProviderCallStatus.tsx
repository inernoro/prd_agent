import { Link } from 'react-router-dom';
import { formatPlatformTime } from '@/lib/platformTime';
import type { PlatformItem } from '@/lib/types';

const outcomes = {
  quota_exhausted: '余额或额度不足', rate_limited: '请求限流', rejected: '请求被拒绝',
  service_error: '上游服务异常', succeeded: '调用成功', failed: '调用失败',
};

/** 启停是管理配置；这里仅展示有时间依据的历史调用，不推断实时可用性。 */
export function ProviderCallStatus({ platform }: { platform: PlatformItem }) {
  const status = platform.recentCallStatus;
  const observed = platform.recentCallAt ? new Date(platform.recentCallAt) : null;
  const knownTime = observed !== null && Number.isFinite(observed.getTime());
  const updated = platform.updatedAt ? new Date(platform.updatedAt).getTime() : NaN;
  const beforeUpdate = knownTime && Number.isFinite(updated) && observed!.getTime() < updated;
  const failed = status && status !== 'succeeded';
  return <div className="lg-provider-call-status">
    <span style={{ color: failed ? 'var(--warn)' : 'var(--text-primary)' }}>{status ? outcomes[status] : '暂无近期调用'}</span>
    {status ? <>
      {knownTime ? <time dateTime={observed!.toISOString()}>{formatPlatformTime(platform.recentCallAt)}</time> : <span className="lg-provider-call-note">调用时间未知</span>}
      {beforeUpdate ? <span className="lg-provider-call-note">配置更新前的记录</span> : null}
      {status === 'quota_exhausted' ? <span className="lg-provider-call-note">历史结果，非实时余额</span> : null}
      <Link to={`/logs?platformId=${encodeURIComponent(platform.id)}${failed ? '&status=failed' : ''}`}>{failed ? '查看失败请求' : '查看调用记录'}</Link>
    </> : <span className="lg-provider-call-note">当前配置近 7 天无真实请求</span>}
  </div>;
}
