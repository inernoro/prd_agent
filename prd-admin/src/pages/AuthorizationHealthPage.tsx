import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import {
  getAuthorizationHealth,
  type AuthorizationHealthItem,
  type AuthorizationHealthOverview,
  type AuthorizationHealthStatus,
} from '@/services/real/authorizationHealth';

const STATUS_STYLE: Record<AuthorizationHealthStatus, { icon: typeof ShieldCheck; color: string; background: string }> = {
  healthy: { icon: CheckCircle2, color: 'var(--accent-fg-success)', background: 'var(--bg-secondary)' },
  attention: { icon: AlertTriangle, color: 'var(--accent-fg-warning)', background: 'var(--bg-secondary)' },
  conditional: { icon: CircleDashed, color: 'var(--accent-primary)', background: 'var(--bg-secondary)' },
  blocked: { icon: ShieldAlert, color: 'var(--accent-fg-danger)', background: 'var(--bg-secondary)' },
};

function Metric({ label, value, hint }: { label: string; value: string | number; hint: string }) {
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: 'var(--text-primary)' }}>{value}</div>
      <div className="mt-1 text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>{hint}</div>
    </div>
  );
}

function HealthCard({ item }: { item: AuthorizationHealthItem }) {
  const style = STATUS_STYLE[item.status];
  const Icon = style.icon;
  return (
    <article className="rounded-xl p-4 flex flex-col gap-3" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: style.background, color: style.color }}>
          <Icon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>{item.label}</h3>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ color: style.color, background: style.background, border: '1px solid var(--border-subtle)' }}>
              {item.statusLabel}
            </span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>{item.audience}</span>
          </div>
          <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{item.summary}</p>
        </div>
      </div>
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>证据来源：{item.evidenceSource}</div>
      {item.recovery ? (
        <div className="rounded-lg px-3 py-2 text-[11px] leading-relaxed" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
          恢复动作：{item.recovery}
        </div>
      ) : null}
      <Link className="inline-flex items-center gap-1 text-[12px] font-medium self-start" style={{ color: 'var(--accent-primary)' }} to={item.actionUrl}>
        {item.actionLabel}<ArrowRight size={13} />
      </Link>
    </article>
  );
}

export default function AuthorizationHealthPage() {
  const [data, setData] = useState<AuthorizationHealthOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getAuthorizationHealth();
    if (result.success) setData(result.data);
    else setError(result.error.message || '授权健康检查未完成，请稍后重试。');
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const groups = useMemo(() => {
    if (!data) return [];
    return ['用户', 'Agent', '验收', '服务', '部署']
      .map((audience) => ({ audience, items: data.systems.filter((item) => item.audience === audience) }))
      .filter((group) => group.items.length > 0);
  }, [data]);

  return (
    <div className="h-full min-h-0 flex flex-col" style={{ color: 'var(--text-primary)' }}>
      <header className="shrink-0 px-5 py-4 flex items-start justify-between gap-4" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck size={20} style={{ color: 'var(--accent-primary)' }} />
            <h1 className="text-lg font-semibold">授权健康中心</h1>
          </div>
          <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>统一查看用户、Agent、验收、LLMGW 与部署身份；不集中保存任何明文凭据。</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-lg px-3 py-2 inline-flex items-center gap-2 text-[12px] font-medium disabled:opacity-60"
          style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
        >
          {loading ? <MapSpinner size={14} /> : <RefreshCw size={14} />}重新检查
        </button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-5" style={{ overscrollBehavior: 'contain' }}>
        {loading && !data ? (
          <div className="rounded-xl" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <MapSectionLoader text="正在回读当前会话、配置、密文和最近授权失败记录" />
          </div>
        ) : error ? (
          <div className="rounded-xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
            <div className="flex items-center gap-2 font-medium" style={{ color: 'var(--accent-fg-danger)' }}><ShieldAlert size={17} />授权健康检查未完成</div>
            <p className="mt-2 text-[12px]" style={{ color: 'var(--text-secondary)' }}>{error}</p>
            <button type="button" onClick={() => void load()} className="mt-3 text-[12px] font-medium" style={{ color: 'var(--accent-primary)' }}>重新检查</button>
          </div>
        ) : data ? (
          <div className="space-y-6">
            <section className="rounded-2xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
              <div className="text-[11px] uppercase tracking-[0.14em]" style={{ color: 'var(--text-muted)' }}>当前结论</div>
              <div className="mt-2 flex items-start gap-3">
                {data.verdict === 'blocked' ? <ShieldAlert size={24} style={{ color: 'var(--accent-fg-danger)' }} /> : <ShieldCheck size={24} style={{ color: data.verdict === 'healthy' ? 'var(--accent-fg-success)' : 'var(--accent-fg-warning)' }} />}
                <div>
                  <p className="text-[16px] font-semibold leading-relaxed">{data.conclusion}</p>
                  <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>生成于 {new Date(data.generatedAt).toLocaleString()}，观察窗口 {data.observationHours} 小时。</p>
                </div>
              </div>
            </section>

            <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Metric label="授权项" value={data.counts.total} hint={`${data.counts.healthy} 项正常`} />
              <Metric label="阻断项" value={data.counts.blocked} hint="必须先恢复再继续验收" />
              <Metric label="未分类 401" value={data.quality.genericUnauthorized} hint="目标值为 0" />
              <Metric label="诊断覆盖率" value={`${Math.round(data.quality.classifiedRate * 100)}%`} hint="401/403 已给出稳定诊断码" />
            </section>

            {groups.map((group) => (
              <section key={group.audience}>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-[13px] font-semibold">{group.audience}授权</h2>
                  <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{group.items.length} 项</span>
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">{group.items.map((item) => <HealthCard key={item.id} item={item} />)}</div>
              </section>
            ))}

            <section id="agent-probe" className="scroll-mt-4 rounded-xl p-5" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
              <h2 className="text-[13px] font-semibold">Agent 与验收预检</h2>
              <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                本机凭据只能由运行 Agent 的机器安全读取。预检必须输出诊断码、证据来源和恢复动作，禁止打印密钥；通过后再执行合成登录票据签发、消费与业务状态回读。
              </p>
              <div className="mt-3 rounded-lg px-3 py-2 font-mono text-[11px]" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                node scripts/authorization-health-preflight.mjs --json
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[13px] font-semibold">最近授权失败</h2>
                <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{data.recentFailures.length} 条</span>
              </div>
              {data.recentFailures.length === 0 ? (
                <div className="rounded-xl p-4 text-[12px]" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                  最近 {data.observationHours} 小时没有记录到 401/403。请继续执行一次可控错误凭据注入，确认告警链路本身可用。
                </div>
              ) : (
                <div className="rounded-xl overflow-x-auto" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
                  <table className="w-full min-w-[860px] text-[11px]">
                    <thead><tr style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}><th className="text-left p-3">时间</th><th className="text-left p-3">诊断码</th><th className="text-left p-3">路径</th><th className="text-left p-3">requestId</th><th className="text-left p-3">恢复动作</th></tr></thead>
                    <tbody>{data.recentFailures.map((item) => (
                      <tr key={`${item.requestId}-${item.occurredAt}`} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                        <td className="p-3 whitespace-nowrap">{new Date(item.occurredAt).toLocaleString()}</td>
                        <td className="p-3 font-mono">{item.code}</td>
                        <td className="p-3 font-mono max-w-[240px] truncate" title={item.path}>{item.path}</td>
                        <td className="p-3 font-mono">{item.requestId}</td>
                        <td className="p-3" style={{ color: 'var(--text-secondary)' }}>{item.action}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
