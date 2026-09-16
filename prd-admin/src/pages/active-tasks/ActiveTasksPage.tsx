/**
 * 我的任务 —— 一个列表，一条一条做完。
 *
 * 照「提醒事项」的行为契约，不只是照它的样子：
 * - 圆圈永远只有一个意思 —— 做完了。切换当前任务在行尾的「开始」。
 * - 点圆圈立刻完成，那句「做成了什么样」在底下补，旁边永远有撤销。
 * - 加一件是行内长出来的一行，回车提交、接着再长一行。
 * - 队列可以拖着排；点行进去改标题、时间、备注；删错了能撤回来。
 *
 * 三个入口，三种「活是怎么来的」：
 * - 加一件：我自己想到的
 * - 粘一段话：会议纪要 / 聊天记录，AI 拆成一条条（拆完要我勾了才建）
 * - 建议：别人觉得我也许该做点什么，吸取之后才变成我的活
 *
 * 刻意没有的东西：跳秒的秒表、投入时长条、估准度、超期红灯。那些在衡量人，不在帮人沟通。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Inbox, Plus, Sparkles } from 'lucide-react';
import {
  DndContext, PointerSensor, KeyboardSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * 只许上下拖。@dnd-kit/modifiers 那个包本仓库没装，而这条修饰符本身就是一行 ——
 * 为了一行代码多拉一个包不划算。
 */
const verticalOnly = ({ transform }: { transform: { x: number; y: number; scaleX: number; scaleY: number } }) => ({ ...transform, x: 0 });
import { toast } from '@/lib/toast';
import {
  blockActiveTask, createActiveTask, deleteActiveTask, dropActiveTask, finishActiveTask,
  getMyActiveTasks, getSuggestionInbox, promoteActiveTask, reopenActiveTask, reorderActiveTask,
  startActiveTask, unblockActiveTask, updateActiveTask,
} from '@/services/real/activeTasks';
import type { ActiveTaskDto, MyActiveTasks } from '@/services/contracts/activeTasks';
import type { ApiResponse } from '@/types/api';
import { DuePicker } from './DuePicker';
import { parseDueFromTitle } from './dueParse';
import { TaskSheet } from './TaskSheet';
import { TaskShell } from './TaskShell';
import { EditTaskSheet } from './EditTaskSheet';
import { ImportSheet } from './ImportSheet';
import { SuggestSheet } from './SuggestSheet';
import { SuggestionsSheet } from './SuggestionsSheet';
import { DebtSection } from './DebtSection';
import { WelcomeSheet, useFirstRun } from './WelcomeSheet';
import { useVisiblePolling } from './usePolling';
import { whenLabel } from './taskTime';
import './activeTasks.css';

/** 刚结案那条：底下升起来的一条，用来补一句或者反悔 */
interface JustDone { id: string; title: string }
/** 刚删掉/放下那条：留着原样，撤销时按原位置建回去 */
interface JustGone { title: string; dueAt?: string | null; orderKey: number; dropped: boolean; id: string }

function StandbyRow({ task, children }: { task: ActiveTaskDto; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id });
  return (
    <div
      ref={setNodeRef}
      className={`atb-row${isDragging ? ' atb-row--dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      role="listitem"
    >
      {children}
    </div>
  );
}

export function ActiveTasksPage() {
  const [data, setData] = useState<MyActiveTasks | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [suggestCount, setSuggestCount] = useState(0);

  // 乐观完成：先让这几条看起来已经做完，再等后端回话
  const [completing, setCompleting] = useState<string[]>([]);
  const [justDone, setJustDone] = useState<JustDone | null>(null);
  const [justGone, setJustGone] = useState<JustGone | null>(null);
  const [note, setNote] = useState('');
  const noteTimer = useRef<number | null>(null);

  const [adding, setAdding] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addDue, setAddDue] = useState<string | null>(null);
  // 自己点过胶囊之后就不再自动认 —— 人手动定过的东西，机器不许再改
  const [dueTouched, setDueTouched] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);

  const detected = dueTouched ? null : parseDueFromTitle(addTitle);
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockedOn, setBlockedOn] = useState('');
  const [editing, setEditing] = useState<ActiveTaskDto | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const res = await getMyActiveTasks();
    if (res.success && res.data) setData(res.data);
    else if (!silent) toast.error(res.error?.message ?? '加载失败');
    setLoading(false);
  }, []);

  const loadInbox = useCallback(async () => {
    const res = await getSuggestionInbox();
    if (res.success && res.data) setSuggestCount(res.data.items.length);
  }, []);

  const refresh = useCallback(() => { void load(true); void loadInbox(); }, [load, loadInbox]);

  useEffect(() => { void load(); void loadInbox(); }, [load, loadInbox]);
  useEffect(() => () => { if (noteTimer.current) window.clearTimeout(noteTimer.current); }, []);

  // 别人派了活、提了建议，这一屏自己会跟上，不用手动刷浏览器
  useVisiblePolling(refresh);

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
    setJustGone(null);
    setNote('');
    await load(true);
    setCompleting((prev) => prev.filter((x) => x !== t.id));
  }, [load]);

  /** 撤销结案：那条放回「正在做」，顶替它的那条退回队首，等于什么都没发生过 */
  const onUndoDone = useCallback(async () => {
    if (!justDone) return;
    const id = justDone.id;
    // 先撤掉还没落地的那次「做成了什么样」自动保存：用户敲完字 600ms 内点撤销的话，
    // 那次保存会在 reopen 之后才发出去，把结案说明又写回这条已经回到「正在做」的活上。
    if (noteTimer.current) { window.clearTimeout(noteTimer.current); noteTimer.current = null; }
    setJustDone(null);
    setNote('');
    await run(() => reopenActiveTask(id));
  }, [justDone, run]);

  /**
   * 补那句「做成了什么样」。停手 600ms 就存，不需要按任何按钮。
   *
   * 存失败必须说出来：这是这句话**唯一**的落盘动作，没有第二次机会。
   * 原来只 `.then(() => load())`，连 res.success 都不看 —— 网络抖一下，用户接着关掉
   * 这条提示或者走开，那句话就没了，而他全程以为存上了（自动保存本来就不给回执）。
   */
  const onNoteChange = useCallback((next: string) => {
    setNote(next);
    if (!justDone) return;
    const id = justDone.id;
    if (noteTimer.current) window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => {
      void updateActiveTask(id, { closingNote: next.trim() }).then((res) => {
        if (!res.success) { toast.error(res.error?.message ?? '这句话没存上，再改一个字会重试'); return; }
        void load(true);
      });
    }, 600);
  }, [justDone, load]);

  /** 删除 / 放下 —— 两条路都能撤回来，所以按钮永远在 */
  const onRemove = useCallback(async (t: ActiveTaskDto) => {
    // 正在做的那条一律走「放下」留痕：它刚开始计时时 elapsedSeconds 还是 0，
    // 光看这个数会走到「真删」那条路上去，而后端只允许删备用队列里的 —— 400 回来的
    // 那句话还会让人一头雾水。按状态判，不按秒数判。
    const dropped = t.state === 'active' || t.elapsedSeconds > 0;
    const ok = await run<{ id: string }>(() => (dropped ? dropActiveTask(t.id) : deleteActiveTask(t.id)));
    if (ok) {
      setJustGone({ id: t.id, title: t.title, dueAt: t.dueAt, orderKey: t.orderKey, dropped });
      setJustDone(null);
    }
  }, [run]);

  /**
   * 撤销删除。投入过时间的那条是软删（放下），reopen 就能原样回来；
   * 没投入过的是真删，只能按原来的标题、时间和位置重建一条 —— id 变了，
   * 但人要的是「那行回来了、还在原来的位置」，这一点做到了。
   */
  const onUndoGone = useCallback(async () => {
    if (!justGone) return;
    const g = justGone;
    // 成功了才把这条提示收起来。真删那条已经不在库里了，justGone 是它的标题、
    // 时间和位置仅存的一份副本 —— 先清掉再去重建，请求一失败它就没了，
    // 用户连再点一次撤销的机会都没有。
    const ok = g.dropped
      ? await run(() => reopenActiveTask(g.id))
      : await run(() => createActiveTask({ title: g.title, dueAt: g.dueAt ?? null, orderKey: g.orderKey }));
    if (ok) setJustGone(null);
  }, [justGone, run]);

  const onAddConfirm = useCallback(async () => {
    if (!addTitle.trim()) return;
    const title = detected ? detected.rest : addTitle.trim();
    const dueAt = detected ? detected.iso : addDue;
    const ok = await run(() => createActiveTask({ title, dueAt }));
    // 回车之后不收起来，清空接着敲下一条
    if (ok) { setAddTitle(''); setAddDue(null); setDueTouched(false); addRef.current?.focus(); }
  }, [addTitle, addDue, detected, run]);

  const onBlockConfirm = useCallback(async () => {
    if (!data?.active || !blockedOn.trim()) return;
    const ok = await run(() => blockActiveTask(data.active!.id, blockedOn.trim()));
    if (ok) { setBlockOpen(false); setBlockedOn(''); }
  }, [data, blockedOn, run]);

  const sensors = useSensors(
    // 按住挪 6px 才算拖 —— 否则点一下「开始」都会被当成拖拽起手
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // useMemo 而不是裸的 ?? []：每次渲染新建一个空数组会让下面 onDragEnd 的依赖每次都变
  const standby = useMemo(() => data?.standby ?? [], [data]);

  const onDragEnd = useCallback(async (e: DragEndEvent) => {
    const { active: from, over } = e;
    if (!over || from.id === over.id) return;
    const oldIndex = standby.findIndex((x) => x.id === from.id);
    const newIndex = standby.findIndex((x) => x.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    // 乐观重排：手一松列表就到位，不等网络
    const next = [...standby];
    next.splice(newIndex, 0, ...next.splice(oldIndex, 1));
    setData((p) => (p ? { ...p, standby: next } : p));

    // 往下挪时落点是「被挤下去的那条的后面」，也就是它现在的下一条之前
    const beforeId = newIndex + 1 < next.length ? next[newIndex + 1].id : null;
    const res = await reorderActiveTask(String(from.id), beforeId);
    if (!res.success) { toast.error(res.error?.message ?? '没排上'); await load(true); }
  }, [standby, load]);

  if (loading) {
    return <TaskShell title="我的任务"><div className="atb-list" aria-busy="true" style={{ minHeight: 160 }} /></TaskShell>;
  }

  const active = data?.active ?? null;
  const done = (data?.history ?? []).filter((h) => h.state === 'done');
  const total = (active ? 1 : 0) + standby.length;
  const serverNow = data?.serverNow;

  const rowBody = (t: ActiveTaskDto, now: boolean) => (
    <>
      <button
        className={`atb-circle${now ? ' atb-circle--now' : ''}${completing.includes(t.id) ? ' atb-circle--filled' : ''}`}
        disabled={busy || completing.includes(t.id)}
        aria-label={`做完了：${t.title}`}
        onClick={() => void onComplete(t)}
      />
      <button className="atb-row__body atb-row__open" onClick={() => setEditing(t)} aria-label={`改这条：${t.title}`}>
        <span className="atb-row__line">
          <span className={`atb-row__title${now ? ' atb-row__title--now' : ''}`}>{t.title}</span>
          {t.assignedByName && <span className="atb-tag">{t.assignedByName} 派的</span>}
        </span>
        {now ? (
          <span className={`atb-row__sub${t.blocked ? ' atb-row__sub--alert' : ''}`}>
            {t.blocked ? `卡住了 · 在等${t.blockedOn ?? '别人'}` : `做了 ${t.elapsedLabel}`}
            {t.dueLabel && !t.blocked && ` · ${t.dueLabel}要`}
          </span>
        ) : (
          t.note && <span className="atb-row__sub">{t.note}</span>
        )}
      </button>

      {!now && t.dueLabel && (
        <span className={`atb-due${t.overdue ? ' atb-due--overdue' : ''}`}>
          {t.overdue && <span className="atb-due__mark" aria-hidden="true">!</span>}
          {t.dueLabel}
          {t.overdue && <span className="sr-only">（已过期）</span>}
        </span>
      )}

      {now ? (
        <div className="atb-rowact atb-rowact--now">
          <button
            className="atb-link"
            disabled={busy}
            onClick={() => (t.blocked ? void run(() => unblockActiveTask(t.id)) : setBlockOpen(true))}
          >
            {t.blocked ? '不卡了' : '卡住了'}
          </button>
          {/* 做到一半决定不做了，直接放下。上一版这里没有这个入口，
              人得先切到另一件、再回头把它放下 —— 画状态机时才看出来这条绕路。 */}
          <button className="atb-link atb-link--quiet" disabled={busy} onClick={() => void onRemove(t)}>
            放下
          </button>
        </div>
      ) : (
        <div className="atb-rowact">
          <button className="atb-link" disabled={busy} onClick={() => void run(() => startActiveTask(t.id))}>开始</button>
          <button className="atb-link" disabled={busy} onClick={() => void run(() => promoteActiveTask(t.id))}>提前</button>
          <button className="atb-link atb-link--quiet" disabled={busy} onClick={() => void onRemove(t)}>
            {t.elapsedSeconds > 0 ? '放下' : '删除'}
          </button>
        </div>
      )}
    </>
  );

  return (
    <TaskShell
      title="我的任务"
      trailing={
        <div className="atb-headact">
          <button className="atb-link" onClick={() => setSuggestOpen(true)}>提建议</button>
          <span className="atb-sub">{data?.displayName}</span>
        </div>
      }
    >
      {/* 别人提的建议：提了什么都不会发生，等我自己吸取 */}
      {suggestCount > 0 && (
        <button className="atb-banner" onClick={() => setInboxOpen(true)}>
          <Inbox size={17} className="atb-banner__icon" aria-hidden="true" />
          <span className="atb-banner__text">{suggestCount} 条建议等你吸取</span>
          <span className="atb-link">看看</span>
        </button>
      )}

      {total === 0 && !adding && <div className="atb-empty">没有任务</div>}

      <div className="atb-list" role="list">
        {active && (
          <div className={`atb-row atb-row--now${completing.includes(active.id) ? ' atb-row--going' : ''}`} role="listitem">
            {rowBody(active, true)}
          </div>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[verticalOnly]} onDragEnd={(e) => void onDragEnd(e)}>
          <SortableContext items={standby.map((x) => x.id)} strategy={verticalListSortingStrategy}>
            {standby.map((t) => (
              <StandbyRow task={t} key={t.id}>{rowBody(t, false)}</StandbyRow>
            ))}
          </SortableContext>
        </DndContext>

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
                  <button type="button" className="atb-link atb-link--quiet" onClick={() => { setDueTouched(true); setAddDue(null); }}>不用</button>
                </div>
              ) : (
                <DuePicker value={addDue} onChange={(v) => { setDueTouched(true); setAddDue(v); }} />
              )}
            </div>
            <button className="atb-link" disabled={busy || !addTitle.trim()} onClick={() => void onAddConfirm()}>加进去</button>
            <button className="atb-link atb-link--quiet" onClick={() => { setAdding(false); setAddTitle(''); setAddDue(null); setDueTouched(false); }}>完成</button>
          </div>
        ) : (
          <button className="atb-row atb-row--add" onClick={() => { setAddDue(null); setDueTouched(false); setAdding(true); }}>
            <span className="atb-circle atb-circle--ghost" aria-hidden="true"><Plus size={17} /></span>
            <span className="atb-row__title atb-row__title--quiet">加一件</span>
          </button>
        )}

        {/* 一段话进来，AI 拆成一条条。拆完要勾了才建。 */}
        <button className="atb-row atb-row--add" onClick={() => setImportOpen(true)}>
          <span className="atb-circle atb-circle--ghost" aria-hidden="true"><Sparkles size={16} /></span>
          <span className="atb-row__title atb-row__title--quiet">粘一段话，AI 帮你拆</span>
        </button>
      </div>

      {/*
        下半屏：我们欠着什么。
        位置在「做完的」之前 —— 债务是还能动手的，做完的是存档，能动手的东西不该排在存档后面。
        第一版放在了最后，真机截图里它掉到了六屏之外（队列 111 条 + 做完的 8 条全在它上面）。
      */}
      <DebtSection onConverted={refresh} />

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

      {/* 刚做完那条：补一句，或者反悔 */}
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
          <button className="atb-link" onClick={() => void onUndoDone()}>撤销</button>
          <button className="atb-link atb-link--quiet" onClick={() => { setJustDone(null); setNote(''); }}>收起</button>
        </div>
      )}

      {/* 刚删掉那条：撤回来 */}
      {justGone && (
        <div className="atb-undo" role="status">
          <span className="atb-undo__title" style={{ flex: 1 }}>
            {justGone.dropped ? '放下了' : '删掉了'}「{justGone.title}」
          </span>
          <button className="atb-link" onClick={() => void onUndoGone()}>撤销</button>
          <button className="atb-link atb-link--quiet" onClick={() => setJustGone(null)}>收起</button>
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

      {editing && <EditTaskSheet task={editing} onClose={() => setEditing(null)} onSaved={() => void load(true)} />}
      {importOpen && <ImportSheet onClose={() => setImportOpen(false)} onCreated={refresh} />}
      {inboxOpen && <SuggestionsSheet onClose={() => { setInboxOpen(false); void loadInbox(); }} onCreated={refresh} />}
      {suggestOpen && <SuggestSheet onClose={() => setSuggestOpen(false)} />}
      {welcomeOpen && <WelcomeSheet onClose={dismissWelcome} />}
    </TaskShell>
  );
}

export default ActiveTasksPage;
