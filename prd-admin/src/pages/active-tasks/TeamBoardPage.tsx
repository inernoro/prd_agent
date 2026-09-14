/**
 * 团队此刻 —— 老板侧。
 *
 * 不给老板一堆进度条让他自己读：第一屏是一句挂着数字的判断，右侧只列「需要你出手的几件」，
 * 节奏正常的人自动从那份清单里消失、不堆成待办（见 .claude/rules/conclusion-before-numbers.md）。
 * 委派默认进对方备用队列，不打断他手上那件 —— 打断要有意识，不是默认行为。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock, Loader2, Send, Settings2, UserPlus } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  assignActiveTask, getAssignableMembers, getBoardSettings, getTeamBoard, saveBoardSettings,
} from '@/services/real/activeTasks';
import type { AssignableMember, TeamBoard, TeamPerson } from '@/services/contracts/activeTasks';
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

export function TeamBoardPage() {
  const navigate = useNavigate();
  const [board, setBoard] = useState<TeamBoard | null>(null);
  const [members, setMembers] = useState<AssignableMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTo, setAssignTo] = useState('');
  const [assignTitle, setAssignTitle] = useState('');
  const [assignNote, setAssignNote] = useState('');
  const [assignHours, setAssignHours] = useState('');
  const [assignUrgent, setAssignUrgent] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [anonMode, setAnonMode] = useState('masked');
  const [anonEnabled, setAnonEnabled] = useState(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const [b, m] = await Promise.all([getTeamBoard(), getAssignableMembers()]);
    if (b.success && b.data) setBoard(b.data);
    else if (!silent) toast.error(b.error?.message ?? '加载团队看板失败');
    if (m.success && m.data) setMembers(m.data);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 老板这一屏是「此刻」，60 秒静默刷新一次，不让他手动按刷新
  useEffect(() => {
    const t = window.setInterval(() => void load(true), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const openAssign = useCallback((userId?: string) => {
    setAssignTo(userId ?? '');
    setAssignTitle('');
    setAssignNote('');
    setAssignHours('');
    setAssignUrgent(false);
    setAssignOpen(true);
  }, []);

  const onAssign = useCallback(async () => {
    if (!assignTo || !assignTitle.trim()) return;
    setBusy(true);
    const res = await assignActiveTask({
      userId: assignTo,
      title: assignTitle.trim(),
      note: assignNote.trim() || undefined,
      estimateMinutes: Number(assignHours) > 0 ? Math.round(Number(assignHours) * 60) : 0,
      urgent: assignUrgent,
    });
    setBusy(false);
    if (res.success) {
      const who = members.find((x) => x.userId === assignTo)?.displayName ?? '对方';
      toast.success(`已派给 ${who}，进了他的备用队列`);
      setAssignOpen(false);
      await load(true);
    } else {
      toast.error(res.error?.message ?? '委派失败');
    }
  }, [assignTo, assignTitle, assignNote, assignHours, assignUrgent, members, load]);

  const openSettings = useCallback(async () => {
    const res = await getBoardSettings();
    if (res.success && res.data) {
      setAnonMode(res.data.anonymousMode);
      setAnonEnabled(res.data.anonymousEnabled);
    }
    setSettingsOpen(true);
  }, []);

  const onSaveSettings = useCallback(async () => {
    setBusy(true);
    const res = await saveBoardSettings({ anonymousMode: anonMode, anonymousEnabled: anonEnabled });
    setBusy(false);
    if (res.success) { toast.success('已保存'); setSettingsOpen(false); await load(true); }
    else toast.error(res.error?.message ?? '保存失败');
  }, [anonMode, anonEnabled, load]);

  if (loading) {
    return (
      <div className="atb-page">
        <div className="atb-empty">
          <Loader2 size={20} className="atb-pulse" style={{ color: 'var(--accent-primary)' }} />
          <div className="atb-empty__desc">正在汇总团队此刻的状态</div>
        </div>
      </div>
    );
  }

  const kpis = board?.kpis;

  return (
    <div className="atb-page">
      <div className="atb-head">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span className="atb-title">团队此刻</span>
          <span className="atb-eyebrow">WHO IS DOING WHAT</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="atb-btn atb-btn--primary" onClick={() => openAssign()}>
            <UserPlus size={15} />
            派个活
          </button>
          <button className="atb-btn" onClick={() => void openSettings()}>
            <Settings2 size={15} />
            匿名可见设置
          </button>
        </div>
      </div>

      {/* 先给结论，再给数字 */}
      <div className="atb-headline">
        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="atb-eyebrow">所以呢</span>
          <p className="atb-headline__text">{board?.headline}</p>
          {(board?.actions.length ?? 0) > 0 && (
            <span className="atb-meta">右侧 {board?.actions.length} 件需要你出手；其余的人不用管。</span>
          )}
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

      <div className="atb-team">
        {/* 全员此刻 */}
        <div className="atb-card">
          <div className="atb-section-head">
            <span className="atb-section-title">谁在做什么</span>
            <span className="atb-meta">每 60 秒自动刷新</span>
          </div>

          {(board?.people.length ?? 0) === 0 ? (
            <div className="atb-empty">
              <div className="atb-empty__title">今天还没有人汇报在做什么</div>
              <div className="atb-empty__desc">员工在「我的任务台」开始第一件事之后，这里就会有人。</div>
            </div>
          ) : (
            board?.people.map((p) => (
              <div key={p.userId} className={`atb-person${p.status === 'blocked' ? ' atb-person--blocked' : p.status === 'overrun' ? ' atb-person--overrun' : p.fuelLevel === 'empty' ? ' atb-person--idle' : ''}`}>
                <span className="atb-avatar">{p.displayName.slice(0, 1)}</span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: 'var(--tracking-title)', color: 'var(--text-primary)' }}>
                      {p.displayName}
                    </span>
                    {p.assignedByName && <span className="atb-meta">{p.assignedByName} 派的</span>}
                  </div>
                  <div
                    style={{
                      fontSize: 12.5, color: 'var(--text-secondary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {p.current?.title ?? '还没说在做什么'}
                    {p.current?.blocked && p.current.blockedOn ? ` —— 在等${p.current.blockedOn}` : ''}
                  </div>
                </div>

                <div className="atb-col atb-col--time">
                  <span
                    className="atb-meta"
                    style={{ fontSize: 11.5, color: p.status === 'blocked' ? 'var(--accent-fg-warning)' : 'var(--text-secondary)' }}
                  >
                    {p.todayLabel}
                    {p.doneTodayCount > 0 ? ` · 交付 ${p.doneTodayCount} 件` : ''}
                  </span>
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
                  <span className="atb-chip" style={{ color: STATUS_COLOR[p.status], background: 'var(--bg-tertiary)' }}>
                    {(p.status === 'running' || p.status === 'blocked') && <span className="atb-pulse" style={{ width: 5, height: 5 }} />}
                    {STATUS_LABEL[p.status]}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 需要你出手 */}
        <div className="atb-stack">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span className="atb-section-title">需要你出手</span>
            <span className="atb-meta">{board?.actions.length ?? 0} 件 · 其余不用管</span>
          </div>

          {(board?.actions.length ?? 0) === 0 ? (
            <div className="atb-card atb-card--plain">
              <div className="atb-empty">
                <div className="atb-empty__title">没有需要你介入的事</div>
                <div className="atb-empty__desc">有人卡住超时、备用见底或严重超期时，才会出现在这里。</div>
              </div>
            </div>
          ) : (
            board?.actions.map((a, i) => (
              <div key={`${a.userId}-${a.kind}-${i}`} className={`atb-action atb-action--${a.kind === '催一句' ? 1 : a.kind === '派活' ? 2 : 3}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span
                    className="atb-eyebrow"
                    style={{ color: a.kind === '催一句' ? 'var(--accent-fg-warning)' : a.kind === '派活' ? 'var(--accent-fg-error)' : 'var(--text-muted)' }}
                  >
                    {a.kind}
                  </span>
                  <span className="atb-meta">{a.who}</span>
                </div>
                <div className="atb-action__text">{a.text}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="atb-btn atb-btn--sm"
                    onClick={() => (a.kind === '派活' ? openAssign(a.userId) : navigate(`/active-tasks/history?userId=${encodeURIComponent(a.userId)}`))}
                  >
                    {a.kind === '派活' ? <Send size={13} /> : <Clock size={13} />}
                    {a.cta}
                  </button>
                </div>
              </div>
            ))
          )}

          {(board?.silentMembers.length ?? 0) > 0 && (
            <div className="atb-card atb-card--plain" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 9 }}>
              <span className="atb-eyebrow">还没汇报的人</span>
              <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                {board?.silentMembers.map((m) => (
                  <span key={m.userId} className="atb-chip">{m.displayName}</span>
                ))}
              </div>
              <span className="atb-meta">近 7 天活跃但今天没有在途任务。不一定是问题，也可能只是没填。</span>
            </div>
          )}
        </div>
      </div>

      {/* 委派 */}
      {assignOpen && (
        <div className="atb-modal-backdrop" onClick={() => setAssignOpen(false)}>
          <div className="atb-modal" onClick={(e) => e.stopPropagation()}>
            <span className="atb-section-title">派个活</span>
            <select className="atb-input" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
              <option value="">派给谁</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.displayName}
                  {m.busy ? ` · 在做「${m.currentTitle}」` : ' · 手上没活'}
                  {` · 备用 ${m.standbyCount} 件`}
                </option>
              ))}
            </select>
            <input className="atb-input" placeholder="要他做什么" value={assignTitle} onChange={(e) => setAssignTitle(e.target.value)} />
            <input className="atb-input" placeholder="为什么做这件（选填，对方会看到）" value={assignNote} onChange={(e) => setAssignNote(e.target.value)} />
            <input className="atb-input" placeholder="预估几小时（选填）" value={assignHours} onChange={(e) => setAssignHours(e.target.value)} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={assignUrgent} onChange={(e) => setAssignUrgent(e.target.checked)} />
              插到他备用队首（下一件就做它，但不打断他手上这件）
            </label>
            <div className="atb-empty__desc" style={{ maxWidth: 'none', textAlign: 'left' }}>
              派过去的活会带上你的名字，对方在自己的任务台上看得见是谁派的。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="atb-btn" onClick={() => setAssignOpen(false)}>取消</button>
              <button className="atb-btn atb-btn--primary" disabled={busy || !assignTo || !assignTitle.trim()} onClick={() => void onAssign()}>派出去</button>
            </div>
          </div>
        </div>
      )}

      {/* 匿名可见设置 */}
      {settingsOpen && (
        <div className="atb-modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="atb-modal" onClick={(e) => e.stopPropagation()}>
            <span className="atb-section-title">匿名可见设置</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={anonEnabled} onChange={(e) => setAnonEnabled(e.target.checked)} />
              开放匿名访问（关掉后公开地址直接 404）
            </label>
            <select className="atb-input" value={anonMode} onChange={(e) => setAnonMode(e.target.value)} disabled={!anonEnabled}>
              <option value="masked">脱敏 · 看得到谁在忙、谁卡住、谁没活，看不到任务标题</option>
              <option value="full">全文 · 与登录员工看到的一致</option>
              <option value="headline">仅头条 · 只给那句判断和统计数字，不列人名</option>
            </select>
            <div className="atb-empty__desc" style={{ maxWidth: 'none', textAlign: 'left' }}>
              默认脱敏，因为任务标题常带项目代号和缺陷细节。公开地址：/board/active-tasks
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="atb-btn" onClick={() => setSettingsOpen(false)}>取消</button>
              <button className="atb-btn atb-btn--primary" disabled={busy} onClick={() => void onSaveSettings()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default TeamBoardPage;
