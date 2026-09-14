/**
 * 我的任务 —— 一个列表，一条一条做完。
 *
 * 心智照「提醒事项」：每行一个圆圈，实心的那条是我在做的，点它就是结案。
 * 结案会问一句「做成了什么样」——这是结案与打勾的唯一区别：打勾一周后翻回来
 * 只有一串对号，那句话才是老板要看的、写周报要抄的、下个人接手要读的。
 *
 * 刻意没有的东西：跳秒的秒表、投入时长条、估准度、超期红灯。那些在衡量人，不在帮人沟通。
 */
import { useCallback, useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  blockActiveTask, createActiveTask, deleteActiveTask, finishActiveTask,
  getMyActiveTasks, promoteActiveTask, startActiveTask, unblockActiveTask,
} from '@/services/real/activeTasks';
import type { ActiveTaskDto, MyActiveTasks } from '@/services/contracts/activeTasks';
import type { ApiResponse } from '@/types/api';
import './activeTasks.css';

function whenLabel(iso?: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

export function ActiveTasksPage() {
  const [data, setData] = useState<MyActiveTasks | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [closeFor, setCloseFor] = useState<ActiveTaskDto | null>(null);
  const [closingNote, setClosingNote] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addTitle, setAddTitle] = useState('');
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

  const onCloseConfirm = useCallback(async () => {
    if (!closeFor) return;
    const ok = await run(() => finishActiveTask(closeFor.id, closingNote.trim() || undefined), '结案了，下一件顶上来了');
    if (ok) { setCloseFor(null); setClosingNote(''); }
  }, [closeFor, closingNote, run]);

  const onAddConfirm = useCallback(async () => {
    if (!addTitle.trim()) return;
    const ok = await run(() => createActiveTask({ title: addTitle.trim() }));
    if (ok) { setAddOpen(false); setAddTitle(''); }
  }, [addTitle, run]);

  const onBlockConfirm = useCallback(async () => {
    if (!data?.active || !blockedOn.trim()) return;
    const ok = await run(() => blockActiveTask(data.active!.id, blockedOn.trim()));
    if (ok) { setBlockOpen(false); setBlockedOn(''); }
  }, [data, blockedOn, run]);

  if (loading) {
    return <div className="atb-page"><div className="atb-col"><div className="atb-empty">正在拉你的任务</div></div></div>;
  }

  const active = data?.active ?? null;
  const standby = data?.standby ?? [];
  const done = (data?.history ?? []).filter((h) => h.state === 'done');
  const total = (active ? 1 : 0) + standby.length;

  return (
    <div className="atb-page">
      <div className="atb-col">
        <div className="atb-head">
          <span className="atb-title">我的任务</span>
          <span className="atb-sub">{data?.displayName}</span>
        </div>

        {/* 一个列表：在做的 + 接下来的 + 加一件 */}
        <div className="atb-list">
          {total === 0 && (
            <div className="atb-empty">还没有任务。加一件，点圆圈就开始。</div>
          )}

          {active && (
            <div className="atb-row atb-row--now">
              <button
                className="atb-circle atb-circle--now"
                disabled={busy}
                aria-label="结案"
                title="点一下结案"
                onClick={() => { setCloseFor(active); setClosingNote(''); }}
              />
              <div className="atb-row__body">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
                  <span className="atb-row__title atb-row__title--now">{active.title}</span>
                  {active.assignedByName && <span className="atb-tag">{active.assignedByName} 派的</span>}
                </div>
                <span className={`atb-row__sub${active.blocked ? ' atb-row__sub--alert' : ''}`}>
                  {active.blocked
                    ? `卡住了 · 在等${active.blockedOn ?? '别人'}`
                    : `做了 ${active.elapsedLabel}`}
                </span>
              </div>
              <button
                className="atb-link"
                disabled={busy}
                onClick={() => (active.blocked
                  ? void run(() => unblockActiveTask(active.id))
                  : setBlockOpen(true))}
              >
                {active.blocked ? '不卡了' : '卡住了'}
              </button>
            </div>
          )}

          {standby.map((t) => (
            <div className="atb-row" key={t.id}>
              <button
                className="atb-circle"
                disabled={busy}
                aria-label="开始做这件"
                title="点一下开始做这件"
                onClick={() => void run(() => startActiveTask(t.id), '换成做这件了')}
              />
              <div className="atb-row__body">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
                  <span className="atb-row__title">{t.title}</span>
                  {t.assignedByName && <span className="atb-tag">{t.assignedByName} 派的</span>}
                </div>
              </div>
              <button className="atb-link" disabled={busy} onClick={() => void run(() => promoteActiveTask(t.id))}>
                提前
              </button>
              {t.elapsedSeconds === 0 && (
                <button
                  className="atb-link"
                  style={{ color: 'var(--text-muted)' }}
                  disabled={busy}
                  onClick={() => void run(() => deleteActiveTask(t.id))}
                >
                  删除
                </button>
              )}
            </div>
          ))}

          <button className="atb-row" onClick={() => setAddOpen(true)}>
            <span className="atb-circle" style={{ border: 'none', color: 'var(--text-muted)' }} aria-hidden="true">
              <Plus size={17} />
            </span>
            <span className="atb-row__title" style={{ color: 'var(--text-muted)' }}>加一件</span>
          </button>
        </div>

        {/* 做完的 */}
        {done.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <span className="atb-group-label">做完的</span>
            <div className="atb-list">
              {done.slice(0, 8).map((d) => (
                <div className="atb-done-row" key={d.id}>
                  <span className="atb-circle atb-circle--done" aria-hidden="true">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  </span>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 14 }}>
                      <span className="atb-done-row__title">{d.title}</span>
                      <span className="atb-when">{whenLabel(d.doneAt)}</span>
                    </div>
                    {d.closingNote && <span className="atb-done-row__note">{d.closingNote}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 结案 */}
      {closeFor && (
        <div className="atb-sheet-backdrop" onClick={() => setCloseFor(null)}>
          <div className="atb-sheet" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="atb-sheet__title">做成了什么样？</span>
              <span className="atb-sheet__hint">{closeFor.title}</span>
            </div>
            <textarea
              className="atb-input"
              autoFocus
              placeholder="一句话就行"
              value={closingNote}
              onChange={(e) => setClosingNote(e.target.value)}
            />
            <span className="atb-sheet__hint">
              以后你和老板翻回来看的是这句，不是打勾。不写也能结，但那条历史就只剩一个标题。
            </span>
            <div className="atb-actions">
              <button className="atb-btn atb-btn--quiet" onClick={() => setCloseFor(null)}>再想想</button>
              <button className="atb-btn" disabled={busy} onClick={() => void onCloseConfirm()}>结案</button>
            </div>
          </div>
        </div>
      )}

      {/* 加一件 */}
      {addOpen && (
        <div className="atb-sheet-backdrop" onClick={() => setAddOpen(false)}>
          <div className="atb-sheet" onClick={(e) => e.stopPropagation()}>
            <span className="atb-sheet__title">加一件</span>
            <input
              className="atb-input"
              autoFocus
              placeholder="要做的是什么"
              value={addTitle}
              onChange={(e) => setAddTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void onAddConfirm(); }}
            />
            <span className="atb-sheet__hint">排在队尾。想先做它，加完点一下「提前」。</span>
            <div className="atb-actions">
              <button className="atb-btn atb-btn--quiet" onClick={() => setAddOpen(false)}>取消</button>
              <button className="atb-btn" disabled={busy || !addTitle.trim()} onClick={() => void onAddConfirm()}>加进去</button>
            </div>
          </div>
        </div>
      )}

      {/* 卡住了 */}
      {blockOpen && (
        <div className="atb-sheet-backdrop" onClick={() => setBlockOpen(false)}>
          <div className="atb-sheet" onClick={(e) => e.stopPropagation()}>
            <span className="atb-sheet__title">在等谁？</span>
            <input
              className="atb-input"
              autoFocus
              placeholder="例如：王予重建那台机器"
              value={blockedOn}
              onChange={(e) => setBlockedOn(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void onBlockConfirm(); }}
            />
            <span className="atb-sheet__hint">只说「卡住了」老板没法处理。说清在等谁，这条会排到他那屏最上面。</span>
            <div className="atb-actions">
              <button className="atb-btn atb-btn--quiet" onClick={() => setBlockOpen(false)}>取消</button>
              <button className="atb-btn" disabled={busy || !blockedOn.trim()} onClick={() => void onBlockConfirm()}>就这样</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ActiveTasksPage;
