/**
 * 大家在做什么 —— 匿名只读（/board/active-tasks）。
 *
 * 默认脱敏：看得到谁在忙、谁卡住、谁没活、堆了多少，看不到任务标题正文。
 * 粒度由管理员配置，前端只按后端下发的 mode 渲染，不自作主张。
 */
import { useCallback, useEffect, useState } from 'react';
import { getPublicBoard } from '@/services/real/activeTasks';
import type { PublicBoard } from '@/services/contracts/activeTasks';
import './activeTasks.css';

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
    return <div className="atb-page" style={{ minHeight: '100vh', background: 'var(--bg-base)' }}><div className="atb-col"><div className="atb-empty">正在加载</div></div></div>;
  }

  if (closed || !data) {
    return (
      <div className="atb-page" style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
        <div className="atb-col"><div className="atb-empty">这个面板没有开放。</div></div>
      </div>
    );
  }

  const board = data.board;
  const masked = data.mode !== 'full';
  const heavy = board?.heavyStackThreshold ?? 8;

  return (
    <div className="atb-page" style={{ minHeight: '100vh', background: 'var(--bg-base)' }}>
      <div className="atb-col atb-col--wide">
        <div className="atb-head">
          <span className="atb-title">大家在做什么</span>
          {masked && <span className="atb-sub">任务内容已脱敏</span>}
        </div>

        <span className="atb-group-label">{board?.headline ?? data.headline}</span>

        {board ? (
          <div className="atb-list">
            {board.people.length === 0 && <div className="atb-empty">今天还没有人汇报在做什么。</div>}
            {board.people.map((p) => {
              const alert = p.status === 'blocked' || p.status === 'empty';
              const stackAlert = p.standbyCount === 0 || p.standbyCount >= heavy;
              return (
                <div className="atb-row" key={p.userId} style={{ minHeight: 62 }}>
                  <span className={`atb-avatar${alert ? ' atb-avatar--alert' : ''}`}>{p.displayName.slice(0, 1)}</span>
                  <div className="atb-row__body">
                    <span className="atb-row__title">{p.displayName}</span>
                    <span className={`atb-row__sub${alert ? ' atb-row__sub--alert' : ''}`}>{p.task}</span>
                  </div>
                  <span className={`atb-stack${stackAlert ? ' atb-stack--alert' : ''}`}>
                    {p.standbyCount === 0 ? '空了' : `堆 ${p.standbyCount} 件`}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="atb-list"><div className="atb-empty">这个看板当前只公开一句结论，不列成员明细。</div></div>
        )}
      </div>
    </div>
  );
}

export default PublicBoardPage;
