/**
 * 我的任务 —— 一个列表，一条一条做完。
 *
 * 照「提醒事项」的行为契约，不只是照它的样子：
 * - 圆圈永远只有一个意思 —— 做完了。上一版正在做的那行点圆圈是结案、备用行点圆圈是切换，
 *   同一个符号两个动作，误触一下改掉两条任务的状态还没法反悔。切换搬到了行尾的「开始」。
 * - 点圆圈立刻就完成：行划掉、下一件顶上来，不再先弹一张问卷。那句「做成了什么样」改成
 *   完成之后底下升起来的一条，可写可不写，旁边永远有「撤销」。
 * - 加一件是行内长出来的一行，回车提交、接着再长一行 —— 连加五条是五次回车，不是十五次点击。
 *
 * 刻意没有的东西：跳秒的秒表、投入时长条、估准度、超期红灯。那些在衡量人，不在帮人沟通。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  blockActiveTask, createActiveTask, deleteActiveTask, dropActiveTask, finishActiveTask,
  getMyActiveTasks, promoteActiveTask, reopenActiveTask, startActiveTask, unblockActiveTask,
  updateActiveTask,
} from '@/services/real/activeTasks';
import type { ActiveTaskDto, MyActiveTasks } from '@/services/contracts/activeTasks';
import type { ApiResponse } from '@/types/api';
import { DuePicker } from './DuePicker';
import { parseDueFromTitle } from './dueParse';
import { TaskSheet } from './TaskSheet';
import { TaskShell } from './TaskShell';
import { WelcomeSheet, useFirstRun } from './WelcomeSheet';
import { whenLabel } from './taskTime';
import './activeTasks.css';

/** 刚结案那条：底下升起来的一条，用来补一句或者反悔 */
interface JustDone { id: string; title: string }

export function ActiveTasksPage() {
  const [data, setData] = useState<MyActiveTasks | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // 乐观完成：先让这几条看起来已经做完，再等后端回话
  const [completing, setCompleting] = useState<string[]>([]);
  const [justDone, setJustDone] = useState<JustDone | null>(null);
  const [note, setNote] = useState('');
  const noteTimer = useRef<number | null>(null);

  const [adding, setAdding] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addDue, setAddDue] = useState<string | null>(null);
  // 自己点过胶囊之后就不再自动认 —— 人手动定过的东西，机器不许再改
  const [dueTouched, setDueTouched] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);

  // 标题里写了「明天」「周五之前」就把时间认出来。只提示不偷改，人看得见才敢信。
  const detected = dueTouched ? null : parseDueFromTitle(addTitle);
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockedOn, setBlockedOn] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const res = await getMyActiveTasks();
    if (res.success && res.data) setData(res.data);
    else if (!silent) toast.error(res.error?.message ?? '加载失败');
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { if (noteTimer.current) window.clearTimeout(noteTimer.current); }, []);

  const [welcomeOpen, dismissWelcome] = useFirstRun(!loading);

  const run = useCallback(async <T,>(fn: () => Promise<ApiResponse<T>>, okMsg?: string) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res.success) {
      if (okMsg) toast.success(okMsg);
      await load(true);
      return true;
    }
    toast.error(res.error?.message ?? '操作失败');
    return false;
  }, [load]);

  /** 点圆圈 —— 立刻看起来做完了，那句话留到下面补 */
  const onComplete = useCallback(async (t: ActiveTaskDto) => {
    setCompleting((prev) => (prev.includes(t.id) ? prev : [...prev, t.id]));
    const res = await finishActiveTask(t.id);
    if (!res.success) {
      setCompleting((prev) => prev.filter((x) => x !== t.id));
      toast.error(res.error?.message ?? '没能结案');
      return;
    }
    setJustDone({ id: t.id, title: t.title });
    setNote('');
    await load(true);
    setCompleting((prev) => prev.filter((x) => x !== t.id));
  }, [load]);

  /** 撤销：那条放回「正在做」，顶替它的那条退回队首，等于什么都没发生过 */
  const onUndo = useCallback(async () => {
    if (!justDone) return;
    const id = justDone.id;
    setJustDone(null);
    setNote('');
    await run(() => reopenActiveTask(id));
  }, [justDone, run]);

  /** 补那句「做成了什么样」。停手 600ms 就存，不需要按任何按钮。 */
  const onNoteChange = useCallback((next: string) => {
    setNote(next);
    if (!justDone) return;
    const id = justDone.id;
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => {
      void updateActiveTask(id, { closingNote: next.trim() }).then(() => void load(true));
    }, 600);
  }, [justDone, load]);

  const onAddConfirm = useCallback(async () => {
    if (!addTitle.trim()) return;
    // 认出来的时间在这一刻才真正生效：标题摘掉时间词，时间填上
    const title = detected ? detected.rest : addTitle.trim();
    const dueAt = detected ? detected.iso : addDue;
    const ok = await run(() => createActiveTask({ title, dueAt }));
    // 回车之后不收起来，清空接着敲下一条 —— 这是提醒事项最核心的输入节奏
    if (ok) { setAddTitle(''); setAddDue(null); setDueTouched(false); addRef.current?.focus(); }
  }, [addTitle, addDue, detected, run]);

  const onBlockConfirm = useCallback(async () => {
    if (!data?.active || !blockedOn.trim()) return;
    const ok = await run(() => blockActiveTask(data.active!.id, blockedOn.trim()));
    if (ok) { setBlockOpen(false); setBlockedOn(''); }
  }, [data, blockedOn, run]);

  if (loading) {
    return <TaskShell title="我的任务"><div className="atb-list" aria-busy="true" style={{ minHeight: 160 }} /></TaskShell>;
  }

  const active = data?.active ?? null;
  const standby = data?.standby ?? [];
  const done = (data?.history ?? []).filter((h) => h.state === 'done');
  const total = (active ? 1 : 0) + standby.length;
  const serverNow = data?.serverNow;

  const rows: { task: ActiveTaskDto; now: boolean }[] = [
    ...(active ? [{ task: active, now: true }] : []),
    ...standby.map((t) => ({ task: t, now: false })),
  ];

  return (
    <TaskShell title="我的任务" trailing={<span className="atb-sub">{data?.displayName}</span>}>
      {total === 0 && !adding && <div className="atb-empty">没有任务</div>}

      {/* 一个列表：在做的 + 接下来的 + 加一件 */}
      <div className="atb-list" role="list">
        {rows.map(({ task: t, now }) => {
          const ghost = completing.includes(t.id);
          return (
            <div className={`atb-row${now ? ' atb-row--now' : ''}${ghost ? ' atb-row--going' : ''}`} role="listitem" key={t.id}>
              <button
                className={`atb-circle${now ? ' atb-circle--now' : ''}${ghost ? ' atb-circle--filled' : ''}`}
                disabled={busy || ghost}
                aria-label={`做完了：${t.title}`}
                onClick={() => void onComplete(t)}
              />
              <div className="atb-row__body">
                <div className="atb-row__line">
                  <span className={`atb-row__title${now ? ' atb-row__title--now' : ''}`}>{t.title}</span>
                  {t.assignedByName && <span className="atb-tag">{t.assignedByName} 派的</span>}
                </div>
                {now && (
                  <span className={`atb-row__sub${t.blocked ? ' atb-row__sub--alert' : ''}`}>
                    {t.blocked ? `卡住了 · 在等${t.blockedOn ?? '别人'}` : `做了 ${t.elapsedLabel}`}
                    {t.dueLabel && !t.blocked && ` · ${t.dueLabel}要`}
                  </span>
                )}
              </div>

              {!now && t.dueLabel && (
                <span className={`atb-due${t.overdue ? ' atb-due--overdue' : ''}`}>
                  {t.overdue && <span className="atb-due__mark" aria-hidden="true">!</span>}
                  {t.dueLabel}
                  {t.overdue && <span className="sr-only">（已过期）</span>}
                </span>
              )}

              {now ? (
                <button
                  className="atb-link"
                  disabled={busy}
                  onClick={() => (t.blocked ? void run(() => unblockActiveTask(t.id)) : setBlockOpen(true))}
                >
                  {t.blocked ? '不卡了' : '卡住了'}
                </button>
              ) : (
                <div className="atb-rowact">
                  <button className="atb-link" disabled={busy} onClick={() => void run(() => startActiveTask(t.id))}>
                    开始
                  </button>
                  <button className="atb-link" disabled={busy} onClick={() => void run(() => promoteActiveTask(t.id))}>
                    提前
                  </button>
                  {/* 投入过时间的走「放下」留痕，没投入过的直接删。控件永远在，只是做的事不同 ——
                      上一版是按钮自己消失，用户看不出规律。 */}
                  <button
                    className="atb-link atb-link--quiet"
                    disabled={busy}
                    onClick={() => void run<{ id: string }>(() => (t.elapsedSeconds > 0 ? dropActiveTask(t.id) : deleteActiveTask(t.id)))}
                  >
                    {t.elapsedSeconds > 0 ? '放下' : '删除'}
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {/* 加一件：行内长出来的一行，不是弹窗 */}
        {adding ? (
          <div className="atb-row atb-row--adding" role="listitem">
            <span className="atb-circle atb-circle--ghost" aria-hidden="true" />
            <div className="atb-row__body">
              <input
                ref={addRef}
                className="atb-inline-input"
                autoFocus
                placeholder="要做的是什么"
                aria-label="新任务"
                value={addTitle}
                onChange={(e) => setAddTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void onAddConfirm();
                  if (e.key === 'Escape') { setAdding(false); setAddTitle(''); setAddDue(null); setDueTouched(false); }
                }}
              />
              {detected ? (
                <div className="atb-detected">
                  <span className="atb-token">{detected.text}</span>
                  <button type="button" className="atb-link atb-link--quiet" onClick={() => { setDueTouched(true); setAddDue(null); }}>
                    不用
                  </button>
                </div>
              ) : (
                <DuePicker value={addDue} onChange={(v) => { setDueTouched(true); setAddDue(v); }} />
              )}
            </div>
            <button className="atb-link" disabled={busy || !addTitle.trim()} onClick={() => void onAddConfirm()}>
              加进去
            </button>
            <button className="atb-link atb-link--quiet" onClick={() => { setAdding(false); setAddTitle(''); setAddDue(null); setDueTouched(false); }}>
              完成
            </button>
          </div>
        ) : (
          <button className="atb-row atb-row--add" onClick={() => { setAddDue(null); setDueTouched(false); setAdding(true); }}>
            <span className="atb-circle atb-circle--ghost" aria-hidden="true">
              <Plus size={17} />
            </span>
            <span className="atb-row__title atb-row__title--quiet">加一件</span>
          </button>
        )}
      </div>

      {/* 做完的 */}
      {done.length > 0 && (
        <div className="atb-group">
          <div className="atb-group__head">
            <span className="atb-group-label">做完的</span>
            {done.length > 8 && <Link className="atb-link" to="/active-tasks/history">看全部</Link>}
          </div>
          <div className="atb-list" role="list">
            {done.slice(0, 8).map((d) => (
              <div className="atb-done-row" role="listitem" key={d.id}>
                <span className="atb-circle atb-circle--done" aria-hidden="true">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                </span>
                <div className="atb-done-row__body">
                  <div className="atb-done-row__line">
                    <span className="atb-done-row__title"><span className="sr-only">已完成：</span>{d.title}</span>
                    <span className="atb-when">{whenLabel(d.doneAt, serverNow)}</span>
                  </div>
                  {d.closingNote && <span className="atb-done-row__note">{d.closingNote}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 刚做完那条：补一句，或者反悔。不填就让它自己待着，不挡任何事。 */}
      {justDone && (
        <div className="atb-undo" role="status">
          <div className="atb-undo__body">
            <span className="atb-undo__title">做完了「{justDone.title}」</span>
            <input
              className="atb-undo__input"
              placeholder="做成了什么样？（可不填）"
              aria-label="做成了什么样"
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
          </div>
          <button className="atb-link" onClick={() => void onUndo()}>撤销</button>
          <button className="atb-link atb-link--quiet" onClick={() => { setJustDone(null); setNote(''); }}>收起</button>
        </div>
      )}

      {blockOpen && (
        <TaskSheet
          title="在等谁？"
          confirmLabel="就这样"
          confirmDisabled={busy || !blockedOn.trim()}
          onConfirm={() => void onBlockConfirm()}
          onClose={() => setBlockOpen(false)}
        >
          <input
            className="atb-input"
            placeholder="例如：王予重建那台机器"
            aria-label="在等谁"
            value={blockedOn}
            onChange={(e) => setBlockedOn(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void onBlockConfirm(); }}
          />
        </TaskSheet>
      )}

      {welcomeOpen && <WelcomeSheet onClose={dismissWelcome} />}
    </TaskShell>
  );
}

export default ActiveTasksPage;
