/**
 * 走过的路 —— 历史任务回溯。
 *
 * 刻意保留难看的东西：放弃的方案、空转的时间。粉饰过的历史没人会回来看第二次。
 * 右侧两块才是这一屏的价值：他估得准吗、时间漏在哪 —— 这两个结论能直接变成管理动作。
 */
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Clock, Loader2 } from 'lucide-react';
import { toast } from '@/lib/toast';
import { getActiveTaskHistory } from '@/services/real/activeTasks';
import type { ActiveTaskDto, ActiveTaskHistory } from '@/services/contracts/activeTasks';
import './activeTasks.css';

const RANGES = [
  { days: 7, label: '本周' },
  { days: 14, label: '近两周' },
  { days: 90, label: '本季' },
];

function dayKey(iso?: string | null): string {
  if (!iso) return '未结束';
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ActiveTaskHistoryPage() {
  const [params] = useSearchParams();
  const userId = params.get('userId') ?? undefined;
  const [days, setDays] = useState(14);
  const [data, setData] = useState<ActiveTaskHistory | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getActiveTaskHistory(days, userId);
    if (res.success && res.data) setData(res.data);
    else toast.error(res.error?.message ?? '加载历史失败');
    setLoading(false);
  }, [days, userId]);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return (
      <div className="atb-page">
        <div className="atb-empty">
          <Loader2 size={20} className="atb-pulse" style={{ color: 'var(--accent-primary)' }} />
          <div className="atb-empty__desc">正在翻历史</div>
        </div>
      </div>
    );
  }

  const s = data?.summary;
  const items = data?.items ?? [];

  // 按天分组，保持后端给的倒序
  const groups: { key: string; items: ActiveTaskDto[] }[] = [];
  for (const it of items) {
    const k = dayKey(it.doneAt ?? it.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.items.push(it);
    else groups.push({ key: k, items: [it] });
  }

  return (
    <div className="atb-page">
      <div className="atb-head">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span className="atb-title">走过的路</span>
          <span className="atb-eyebrow">{userId ? '他人历史' : '我的历史'} · 近 {data?.days} 天</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {RANGES.map((r) => (
            <button
              key={r.days}
              className="atb-btn atb-btn--sm"
              style={days === r.days ? { background: 'var(--bg-tertiary)', color: 'var(--text-primary)' } : undefined}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="atb-headline">
        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="atb-eyebrow">所以呢</span>
          <p className="atb-headline__text">{s?.headline}</p>
        </div>
        {s && (
          <div className="atb-kpis">
            <div className="atb-kpi">
              <span className="atb-kpi__value" style={{ color: 'var(--accent-fg-success)' }}>{s.doneCount}</span>
              <span className="atb-kpi__label">交付</span>
            </div>
            <div className="atb-kpi">
              <span className="atb-kpi__value">{s.droppedCount}</span>
              <span className="atb-kpi__label">放弃</span>
            </div>
            <div className="atb-kpi">
              <span className="atb-kpi__value" style={{ fontSize: 18 }}>{s.avgLabel}</span>
              <span className="atb-kpi__label">平均每件</span>
            </div>
            <div className="atb-kpi">
              <span className="atb-kpi__value" style={{ fontSize: 18, color: s.idleSeconds > 0 ? 'var(--accent-fg-warning)' : undefined }}>{s.idleLabel}</span>
              <span className="atb-kpi__label">空转</span>
            </div>
          </div>
        )}
      </div>

      <div className="atb-team">
        <div className="atb-card">
          <div className="atb-section-head">
            <span className="atb-section-title">一天一天翻回去</span>
            <span className="atb-meta">放弃和空转也留着，不粉饰</span>
          </div>

          {groups.length === 0 ? (
            <div className="atb-empty">
              <div className="atb-empty__title">这段时间还没有结束的任务</div>
              <div className="atb-empty__desc">完成或放弃一件之后，这里会按天留下流水。</div>
            </div>
          ) : (
            <div style={{ padding: '6px 18px 16px' }}>
              {groups.map((g) => (
                <div key={g.key} style={{ display: 'flex', gap: 16, paddingTop: 12 }}>
                  <div style={{ width: 58, flexShrink: 0, paddingTop: 14 }}>
                    <span className="atb-meta" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{g.key}</span>
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 7, borderLeft: '1px solid var(--border-faint)', paddingLeft: 16, paddingBottom: 4 }}>
                    {g.items.map((it) => {
                      const dropped = it.state === 'dropped';
                      const running = it.state === 'active';
                      return (
                        <div
                          key={it.id}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 12, minHeight: 46, padding: '8px 13px',
                            borderRadius: 'var(--radius-field)',
                            background: running ? 'color-mix(in srgb, var(--accent-primary) 6%, transparent)' : 'var(--bg-nested)',
                            border: `1px solid ${running ? 'color-mix(in srgb, var(--accent-primary) 26%, transparent)' : 'var(--border-secondary)'}`,
                          }}
                        >
                          <span
                            style={{
                              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                              background: running ? 'var(--accent-primary)' : dropped ? 'var(--text-muted)' : 'var(--accent-fg-success)',
                            }}
                          />
                          <span
                            style={{
                              flex: 1, minWidth: 0, fontSize: 12.5, letterSpacing: 'var(--tracking-title)',
                              color: dropped ? 'var(--text-muted)' : 'var(--text-primary)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}
                          >
                            {it.title}
                          </span>
                          <span className="atb-meta" style={{ flexShrink: 0 }}>
                            {it.estimateMinutes > 0 ? `实 ${it.elapsedLabel} / 估 ${Math.round(it.estimateMinutes / 60 * 10) / 10} 小时` : it.elapsedLabel}
                          </span>
                          <span
                            className="atb-chip"
                            style={{
                              flexShrink: 0,
                              color: running ? 'var(--accent-gold-2)' : dropped ? 'var(--text-muted)' : 'var(--accent-fg-success)',
                            }}
                          >
                            {running ? '进行中' : dropped ? '放弃' : '已完成'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="atb-stack">
          <div className="atb-card" style={{ padding: '16px 17px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span className="atb-section-title">估得准吗</span>
              <span className="atb-meta">只统计估过的 {s?.estimatedCount ?? 0} 件</span>
            </div>
            {(s?.estimatedCount ?? 0) === 0 ? (
              <div className="atb-empty__desc" style={{ maxWidth: 'none', textAlign: 'left' }}>
                这段时间没有一件任务填过预估，所以算不出估准度。填了预估才能判断超期 —— 没有基准的「超期」是编出来的。
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 20 }}>
                  <div className="atb-kpi">
                    <span className="atb-kpi__value" style={{ color: 'var(--accent-fg-success)' }}>{s?.accurateCount}</span>
                    <span className="atb-kpi__label">估得准</span>
                  </div>
                  <div className="atb-kpi">
                    <span className="atb-kpi__value" style={{ color: 'var(--accent-fg-error)' }}>{s?.overrunCount}</span>
                    <span className="atb-kpi__label">超一倍以上</span>
                  </div>
                </div>
                <span className="atb-meta">超一倍以上的那几件值得回头看看是范围变了还是估低了。</span>
              </>
            )}
          </div>

          <div className="atb-card" style={{ padding: '16px 17px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <span className="atb-section-title">时间漏在哪</span>
              <span className="atb-meta">合计 {s?.idleLabel} 空转</span>
            </div>
            {(s?.leaks.length ?? 0) === 0 ? (
              <div className="atb-empty__desc" style={{ maxWidth: 'none', textAlign: 'left' }}>
                这段时间没有记录到等待损耗。标记卡住时写清在等谁，这里才会有归因。
              </div>
            ) : (
              s?.leaks.map((l) => {
                const max = s.leaks[0].seconds || 1;
                return (
                  <div key={l.name} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                      <span style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>{l.name}</span>
                      <span className="atb-meta" style={{ fontSize: 11, color: 'var(--accent-fg-warning)' }}>{l.label}</span>
                    </div>
                    <div className="atb-bar" style={{ height: 6 }}>
                      <div className="atb-bar__fill" style={{ width: `${Math.round((l.seconds / max) * 100)}%`, background: 'var(--accent-fg-warning)' }} />
                    </div>
                    <span className="atb-meta">{l.note}</span>
                  </div>
                );
              })
            )}
            {(s?.leaks.length ?? 0) > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, paddingTop: 10, borderTop: '1px solid var(--border-secondary)' }}>
                <Clock size={15} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)', textWrap: 'pretty' }}>
                  排第一的那项如果反复出现，值得单独立一个事去修，而不是每次都等。
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ActiveTaskHistoryPage;
