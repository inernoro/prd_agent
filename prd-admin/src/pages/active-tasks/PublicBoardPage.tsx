/**
 * 活动任务面板 —— 匿名只读视图（/board/active-tasks）。
 *
 * 默认脱敏：看得到谁在忙、谁卡住、谁没活、今天投入多久，看不到任务标题正文。
 * 粒度与开关都由管理员在团队视图里配置，前端只按后端下发的 mode 渲染，不自作主张。
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getPublicBoard } from '@/services/real/activeTasks';
import type { PublicBoard, TeamPerson } from '@/services/contracts/activeTasks';
import './activeTasks.css';

const STATUS_LABEL: Record<TeamPerson['status'], string> = {
  running: '进行中',
  blocked: '卡住',
  overrun: '超期',
  idle: '未汇报',
};

const STATUS_COLOR: Record<TeamPerson['status'], string> = {
  running: 'var(--accent-fg-success)',
  blocked: 'var(--accent-fg-warning)',
  overrun: 'var(--accent-fg-error)',
  idle: 'var(--text-muted)',
};

export function PublicBoardPage() {
  const [data, setData] = useState<PublicBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [closed, setClosed] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const res = await getPublicBoard();
    if (res.success && res.data) setData(res.data);
    else setClosed(true);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const t = window.setInterval(() => void load(true), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (loading) {
    return (
      <div className="atb-page" style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
        <div className="atb-empty">
          <Loader2 size={20} className="atb-pulse" style={{ color: 'var(--accent-primary)' }} />
          <div className="atb-empty__desc">正在加载团队看板</div>
        </div>
      </div>
    );
  }

  if (closed || !data) {
    return (
      <div className="atb-page" style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
        <div className="atb-empty">
          <div className="atb-empty__title">这个面板没有开放</div>
          <div className="atb-empty__desc">管理员可以在团队视图的「匿名可见设置」里打开它。</div>
        </div>
      </div>
    );
  }

  const board = data.board;
  const headline = board?.headline ?? data.headline;
  const kpis = board?.kpis ?? data.kpis;
  const masked = data.mode !== 'full';

  return (
    <div className="atb-page" style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <div className="atb-head">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span className="atb-title">团队此刻</span>
          <span className="atb-eyebrow">公开看板 · 每 60 秒刷新</span>
        </div>
        {masked && <span className="atb-chip">任务内容已脱敏</span>}
      </div>

      <div className="atb-headline">
        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="atb-eyebrow">所以呢</span>
          <p className="atb-headline__text">{headline}</p>
        </div>
        {kpis && (
          <div className="atb-kpis">
            <div className="atb-kpi">
              <span className="atb-kpi__value">{kpis.onDuty}</span>
              <span className="atb-kpi__label">在岗</span>
            </div>
            <div className="atb-kpi">
              <span className="atb-kpi__value" style={{ color: kpis.blocked > 0 ? 'var(--accent-fg-warning)' : undefined }}>{kpis.blocked}</span>
              <span className="atb-kpi__label">卡住</span>
            </div>
            <div className="atb-kpi">
              <span className="atb-kpi__value" style={{ color: kpis.lowFuel > 0 ? 'var(--accent-fg-error)' : undefined }}>{kpis.lowFuel}</span>
              <span className="atb-kpi__label">备用见底</span>
            </div>
            <div className="atb-kpi">
              <span className="atb-kpi__value" style={{ color: 'var(--accent-fg-success)' }}>{kpis.doneWeek}</span>
              <span className="atb-kpi__label">本周交付</span>
            </div>
          </div>
        )}
      </div>

      {board ? (
        <div className="atb-card">
          <div className="atb-section-head">
            <span className="atb-section-title">谁在做什么</span>
            <span className="atb-meta">{masked ? '任务标题已打码，只公开状态与投入' : '全文可见'}</span>
          </div>
          {board.people.length === 0 ? (
            <div className="atb-empty">
              <div className="atb-empty__desc">今天还没有人汇报在做什么。</div>
            </div>
          ) : (
            board.people.map((p) => (
              <div key={p.userId} className={`atb-person${p.status === 'blocked' ? ' atb-person--blocked' : ''}`}>
                <span className="atb-avatar">{p.displayName.slice(0, 1)}</span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: 'var(--tracking-title)', color: 'var(--text-primary)' }}>
                    {p.displayName}
                  </span>
                  <span
                    style={{
                      fontSize: 12.5, color: 'var(--text-muted)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontFamily: masked ? 'var(--font-code)' : undefined,
                    }}
                  >
                    {p.current?.title ?? '还没说在做什么'}
                  </span>
                </div>
                <div className="atb-col atb-col--time">
                  <span className="atb-meta" style={{ fontSize: 11.5 }}>{p.todayLabel}</span>
                  <div className="atb-bar">
                    <div
                      className="atb-bar__fill"
                      style={{
                        width: `${Math.min(100, Math.round((p.todaySeconds / (8 * 3600)) * 100))}%`,
                        background: STATUS_COLOR[p.status],
                      }}
                    />
                  </div>
                </div>
                <div className="atb-col atb-col--fuel">
                  <span className={`atb-chip atb-chip--${p.fuelLevel}`}>{p.fuelLabel}</span>
                </div>
                <div className="atb-col atb-col--status">
                  <span className="atb-chip" style={{ color: STATUS_COLOR[p.status] }}>
                    {(p.status === 'running' || p.status === 'blocked') && <span className="atb-pulse" style={{ width: 5, height: 5 }} />}
                    {STATUS_LABEL[p.status]}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="atb-card atb-card--plain">
          <div className="atb-empty">
            <div className="atb-empty__desc">这个看板当前只公开结论与统计，不列成员明细。</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default PublicBoardPage;
