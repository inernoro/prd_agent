/**
 * 大家在做什么 —— 管理侧，也是一个列表。
 *
 * 要你管的排最上面（卡住 > 没活 > 堆太多），其余按名字排。
 * 不另做「需要你出手」区块 —— 那会让同一个人在一屏里出现两次。
 *
 * 每人带一个堆积量：那是负载不是绩效，所以只给数字，两端标色（空了 / 堆太多），
 * 中间的人不标 —— 正常就是正常，不该费看的人的眼睛。
 * 刻意没有完成率、准时率、人均产出：那些一出现，下面的人就开始为数字干活。
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@/lib/toast';
import { assignActiveTask, getAssignableMembers, getTeamBoard } from '@/services/real/activeTasks';
import type { AssignableMember, TeamBoard } from '@/services/contracts/activeTasks';
import { DuePicker } from './DuePicker';
import './activeTasks.css';

function whenLabel(iso?: string | null): string {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

export function TeamBoardPage() {
  const [board, setBoard] = useState<TeamBoard | null>(null);
  const [members, setMembers] = useState<AssignableMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTo, setAssignTo] = useState('');
  const [assignTitle, setAssignTitle] = useState('');
  const [assignNext, setAssignNext] = useState(false);
  const [assignDue, setAssignDue] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const [b, m] = await Promise.all([getTeamBoard(), getAssignableMembers()]);
    if (b.success && b.data) setBoard(b.data);
    else if (!silent) toast.error(b.error?.message ?? '加载失败');
    if (m.success && m.data) setMembers(m.data);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => void load(true), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const openAssign = useCallback((userId?: string) => {
    setAssignTo(userId ?? '');
    setAssignTitle('');
    setAssignNext(false);
    setAssignDue(null);
    setAssignOpen(true);
  }, []);

  const onAssign = useCallback(async () => {
    if (!assignTo || !assignTitle.trim()) return;
    setBusy(true);
    const res = await assignActiveTask({ userId: assignTo, title: assignTitle.trim(), urgent: assignNext, dueAt: assignDue });
    setBusy(false);
    if (res.success) {
      const who = members.find((x) => x.userId === assignTo)?.displayName ?? '对方';
      toast.success(`派给 ${who} 了`);
      setAssignOpen(false);
      await load(true);
    } else {
      toast.error(res.error?.message ?? '派活失败');
    }
  }, [assignTo, assignTitle, assignNext, assignDue, members, load]);

  if (loading) {
    return <div className="atb-page"><div className="atb-col atb-col--wide"><div className="atb-empty">正在看大家在做什么</div></div></div>;
  }

  const heavy = board?.heavyStackThreshold ?? 8;
  const people = board?.people ?? [];
  const closed = board?.recentlyClosed ?? [];

  return (
    <div className="atb-page">
      <div className="atb-col atb-col--wide">
        <div className="atb-head">
          <span className="atb-title">大家在做什么</span>
          <button className="atb-link" onClick={() => openAssign()}>派一件</button>
        </div>

        {board?.headline && <span className="atb-group-label">{board.headline}</span>}

        <div className="atb-list">
          {people.length === 0 && <div className="atb-empty">还没有人汇报在做什么。</div>}

          {people.map((p) => {
            const alert = p.status === 'blocked' || p.status === 'empty';
            const stackAlert = p.standbyCount === 0 || p.standbyCount >= heavy;
            return (
              <div className="atb-row" key={p.userId} style={{ minHeight: 62 }}>
                <span className={`atb-avatar${alert ? ' atb-avatar--alert' : ''}`}>{p.displayName.slice(0, 1)}</span>
                <div className="atb-row__body">
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
                    <span className="atb-row__title">{p.displayName}</span>
                    {p.assignedByName && <span className="atb-tag">{p.assignedByName} 派的</span>}
                  </div>
                  <span className={`atb-row__sub${alert ? ' atb-row__sub--alert' : ''}`}>{p.task}</span>
                </div>
                <span className={`atb-stack${stackAlert ? ' atb-stack--alert' : ''}`}>
                  {p.standbyCount === 0 ? '空了' : `堆 ${p.standbyCount} 件`}
                </span>
                {p.status === 'empty' && (
                  <button className="atb-pill" onClick={() => openAssign(p.userId)}>派一件</button>
                )}
              </div>
            );
          })}
        </div>

        {closed.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <span className="atb-group-label">刚结案</span>
            <div className="atb-list">
              {closed.map((c) => (
                <div className="atb-done-row" key={c.id}>
                  <span className="atb-circle atb-circle--done" aria-hidden="true">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  </span>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 14 }}>
                      <span className="atb-done-row__title">{c.who} · {c.title}</span>
                      <span className="atb-when">{whenLabel(c.doneAt)}</span>
                    </div>
                    {c.closingNote && <span className="atb-done-row__note">{c.closingNote}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {assignOpen && (
        <div className="atb-sheet-backdrop" onClick={() => setAssignOpen(false)}>
          <div className="atb-sheet" onClick={(e) => e.stopPropagation()}>
            <span className="atb-sheet__title">派一件</span>
            <select className="atb-input" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
              <option value="">派给谁</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName} · {m.stackHint ?? (m.standbyCount === 0 ? '没活了' : `堆 ${m.standbyCount} 件`)}
                </option>
              ))}
            </select>
            <input
              className="atb-input"
              placeholder="让他做什么"
              value={assignTitle}
              onChange={(e) => setAssignTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void onAssign(); }}
            />
            <DuePicker value={assignDue} onChange={setAssignDue} />
            <label className="atb-check">
              <span>让他下一件就做</span>
              <input type="checkbox" checked={assignNext} onChange={(e) => setAssignNext(e.target.checked)} />
            </label>
            <span className="atb-sheet__hint">不勾就排在他队尾，不打断他手上那件。派过去带着你的名字。</span>
            <div className="atb-actions">
              <button className="atb-btn atb-btn--quiet" onClick={() => setAssignOpen(false)}>取消</button>
              <button className="atb-btn" disabled={busy || !assignTo || !assignTitle.trim()} onClick={() => void onAssign()}>派出去</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TeamBoardPage;
