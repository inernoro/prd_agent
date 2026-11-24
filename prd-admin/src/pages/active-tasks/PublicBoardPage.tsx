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
    // 成功要把「没有开放」撤回来：这一屏每分钟轮询一次，中间任何一次网络抖动
    // 都会把 closed 置上，而它原来再也不会被放下 —— 面板明明开着，
    // 这一屏却永久停在「这个面板没有开放」，只能靠用户自己刷新页面。
    if (res.success && res.data) { setData(res.data); setClosed(false); }
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
          <div className="atb-list" role="list">
            {board.people.length === 0 && <div className="atb-empty">还没有人在做什么</div>}
            {board.people.map((p) => {
              // 与「大家在做什么」同一口径：卡够时长才算要人管，判定由后端下发
              const alert = (p.status === 'blocked' && p.escalated) || p.status === 'empty';
              const stackAlert = p.standbyCount === 0 || p.standbyCount >= heavy;
              return (
                <div className="atb-row atb-row--person" role="listitem" key={p.userId}>
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
