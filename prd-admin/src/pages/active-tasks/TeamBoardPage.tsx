/**
 * 大家在做什么 —— 管理视图，也是一个列表。
 *
 * 要看的排最上面（卡住 > 没活 > 堆太多），其余按名字排。
 * 不另做「需要出手」区块 —— 那会让同一个人在一屏里出现两次。
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
import { TaskSheet } from './TaskSheet';
import { TaskShell } from './TaskShell';
import { SuggestSheet } from './SuggestSheet';
import { BoardSettingsSheet } from './BoardSettingsSheet';
import { useVisiblePolling } from './usePolling';
import { whenLabel } from './taskTime';
import './activeTasks.css';

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
  // 提建议和派活是两码事：派活直接进对方队列，建议要对方自己吸取才算数
  const [suggestTo, setSuggestTo] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const [b, m] = await Promise.all([getTeamBoard(), getAssignableMembers()]);
    if (b.success && b.data) setBoard(b.data);
    else if (!silent) toast.error(b.error?.message ?? '加载失败');
    if (m.success && m.data) setMembers(m.data);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const refresh = useCallback(() => { void load(true); }, [load]);
  useVisiblePolling(refresh);

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
    return (
      <TaskShell title="大家在做什么" wide>
        <div className="atb-list" aria-busy="true" style={{ minHeight: 160 }} />
      </TaskShell>
    );
  }

  const heavy = board?.heavyStackThreshold ?? 8;
  const people = board?.people ?? [];
  const closed = board?.recentlyClosed ?? [];
  const serverNow = board?.serverNow;

  return (
    <TaskShell
      title="大家在做什么"
      wide
      headline={board?.headline}
      trailing={
        <div className="atb-headact">
          <button className="atb-link" onClick={() => setSuggestTo('')}>提建议</button>
          <button className="atb-link" onClick={() => openAssign()}>派一件</button>
          <button className="atb-link" onClick={() => setSettingsOpen(true)}>看板设置</button>
        </div>
      }
    >
      {people.length === 0 && <div className="atb-empty">还没有人在做什么</div>}

      {people.length > 0 && (
        <div className="atb-list" role="list">
          {people.map((p) => {
            const alert = p.status === 'blocked' || p.status === 'empty';
            const stackAlert = p.standbyCount === 0 || p.standbyCount >= heavy;
            return (
              <div className="atb-row atb-row--person" role="listitem" key={p.userId}>
                <span className={`atb-avatar${alert ? ' atb-avatar--alert' : ''}`} aria-hidden="true">
                  {p.displayName.slice(0, 1)}
                </span>
                <div className="atb-row__body">
                  <div className="atb-row__line">
                    <span className="atb-row__title">{p.displayName}</span>
                    {p.assignedByName && <span className="atb-tag">{p.assignedByName} 派的</span>}
                  </div>
                  <span className={`atb-row__sub${alert ? ' atb-row__sub--alert' : ''}`}>
                    {alert && <span className="atb-due__mark" aria-hidden="true">!</span>}
                    {p.task}
                  </span>
                </div>
                <span className={`atb-stack${stackAlert ? ' atb-stack--alert' : ''}`}>
                  {p.standbyCount === 0 ? '空了' : `堆 ${p.standbyCount} 件`}
                </span>
                <div className="atb-rowact">
                  <button className="atb-link" onClick={() => setSuggestTo(p.userId)}>提建议</button>
                  {p.status !== 'empty' && (
                    <button className="atb-link" onClick={() => openAssign(p.userId)}>派活</button>
                  )}
                </div>
                {p.status === 'empty' && (
                  <button className="atb-pill" onClick={() => openAssign(p.userId)}>派一件</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {closed.length > 0 && (
        <div className="atb-group">
          <span className="atb-group-label">刚结案</span>
          <div className="atb-list" role="list">
            {closed.map((c) => (
              <div className="atb-done-row" role="listitem" key={c.id}>
                <span className="atb-circle atb-circle--done" aria-hidden="true">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                </span>
                <div className="atb-done-row__body">
                  <div className="atb-done-row__line">
                    <span className="atb-done-row__title"><span className="sr-only">已完成：</span>{c.who} · {c.title}</span>
                    <span className="atb-when">{whenLabel(c.doneAt, serverNow)}</span>
                  </div>
                  {c.closingNote && <span className="atb-done-row__note">{c.closingNote}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {assignOpen && (
        <TaskSheet
          title="派一件"
          confirmLabel="派出去"
          confirmDisabled={busy || !assignTo || !assignTitle.trim()}
          onConfirm={() => void onAssign()}
          onClose={() => setAssignOpen(false)}
        >
          <select className="atb-input" aria-label="派给谁" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
            <option value="">派给谁</option>
            {members.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName} · {m.stackHint ?? (m.standbyCount === 0 ? '没活了' : `堆 ${m.standbyCount} 件`)}
              </option>
            ))}
          </select>
          <input
            className="atb-input"
            placeholder="任务内容"
            aria-label="任务内容"
            value={assignTitle}
            onChange={(e) => setAssignTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void onAssign(); }}
          />
          <DuePicker value={assignDue} onChange={setAssignDue} />
          <label className="atb-check">
            <input type="checkbox" checked={assignNext} onChange={(e) => setAssignNext(e.target.checked)} />
            <span>排在最前</span>
          </label>
        </TaskSheet>
      )}
      {suggestTo !== null && (
        <SuggestSheet presetUserId={suggestTo || undefined} onClose={() => setSuggestTo(null)} />
      )}
      {settingsOpen && (
        <BoardSettingsSheet onClose={() => setSettingsOpen(false)} onSaved={refresh} />
      )}
    </TaskShell>
  );
}

export default TeamBoardPage;
