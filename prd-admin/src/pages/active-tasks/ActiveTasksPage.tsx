/**
 * 我的任务台 —— 员工侧。
 *
 * 回答老板固定问的三个问题：此刻在做什么、做完接着做什么、走过哪些。
 * 刻意不做成第四块看板（pm-agent 已有看板/甘特/里程碑），它是一张汇报卡：
 * - 此刻正在做同时只允许一条（WIP=1），多线程等于没有焦点；
 * - 零表单：完成一次点击、队首自动顶上、时长自动记；
 * - 右上角「老板此刻看到的你」让员工看见自己汇报出去长什么样 —— 这条闭环是维护准确性的动力来源。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowUp, Check, ClipboardPaste, Clock, Eye, Loader2, Plus, Trash2, X,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import {
  blockActiveTask, createActiveTask, deleteActiveTask, dropActiveTask, finishActiveTask,
  getMyActiveTasks, pasteActiveTasks, promoteActiveTask, startActiveTask, unblockActiveTask,
} from '@/services/real/activeTasks';
import { ActiveTaskSourceLabels, type ActiveTaskDto, type MyActiveTasks } from '@/services/contracts/activeTasks';
import type { ApiResponse } from '@/types/api';
import './activeTasks.css';

/** 秒 → HH:MM:SS，等宽数字下不跳动。 */
function fmtClock(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** 秒 → 人话。不足一小时给分钟，避免「0 小时」这种量纲退化。 */
function fmtHuman(total: number): string {
  const s = Math.max(0, Math.floor(total));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

export function ActiveTasksPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<MyActiveTasks | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const loadedAtRef = useRef<number>(Date.now());

  const [addOpen, setAddOpen] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addEstimate, setAddEstimate] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockedOn, setBlockedOn] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const res = await getMyActiveTasks();
    if (res.success && res.data) {
      setData(res.data);
      loadedAtRef.current = Date.now();
    } else if (!silent) {
      toast.error(res.error?.message ?? '加载失败');
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 本地秒表：服务端只给起点，前端自己往前走，不轮询
  useEffect(() => {
    const t = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  const active = data?.active ?? null;

  /** 实时投入 = 服务端快照 + 本地流逝（用本地时间差，避开服务端/客户端时钟偏差）。 */
  const liveElapsed = useMemo(() => {
    if (!active) return 0;
    if (!active.running) return active.elapsedSeconds;
    void tick;
    return active.elapsedSeconds + Math.floor((Date.now() - loadedAtRef.current) / 1000);
  }, [active, tick]);

  const liveBlocked = useMemo(() => {
    if (!active?.blocked) return active?.blockedSeconds ?? 0;
    void tick;
    return active.blockedSeconds + Math.floor((Date.now() - loadedAtRef.current) / 1000);
  }, [active, tick]);

  const progressPct = useMemo(() => {
    if (!active || active.estimateMinutes <= 0) return null;
    return Math.min(100, Math.round((liveElapsed / (active.estimateMinutes * 60)) * 100));
  }, [active, liveElapsed]);

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

  const onFinish = useCallback(async () => {
    if (!active) return;
    await run(() => finishActiveTask(active.id), '已完成，队首那件顶上来了');
  }, [active, run]);

  const onBlockConfirm = useCallback(async () => {
    if (!active || !blockedOn.trim()) return;
    const ok = await run(() => blockActiveTask(active.id, blockedOn.trim()));
    if (ok) { setBlockOpen(false); setBlockedOn(''); }
  }, [active, blockedOn, run]);

  const onAddConfirm = useCallback(async () => {
    if (!addTitle.trim()) return;
    const minutes = Number(addEstimate) > 0 ? Math.round(Number(addEstimate) * 60) : 0;
    const ok = await run(() => createActiveTask({ title: addTitle.trim(), estimateMinutes: minutes }), '已加进备用队列');
    if (ok) { setAddOpen(false); setAddTitle(''); setAddEstimate(''); }
  }, [addTitle, addEstimate, run]);

  const onPasteConfirm = useCallback(async () => {
    if (!pasteText.trim()) return;
    setBusy(true);
    const res = await pasteActiveTasks(pasteText);
    setBusy(false);
    if (res.success && res.data) {
      toast.success(`切出 ${res.data.created} 条，已进备用队列`);
      setPasteOpen(false);
      setPasteText('');
      await load(true);
    } else {
      toast.error(res.error?.message ?? '没能从这段文字里切出任务');
    }
  }, [pasteText, load]);

  if (loading) {
    return (
      <div className="atb-page">
        <div className="atb-empty">
          <Loader2 size={20} className="atb-pulse" style={{ color: 'var(--accent-primary)' }} />
          <div className="atb-empty__desc">正在拉取你的任务台</div>
        </div>
      </div>
    );
  }

  const standby = data?.standby ?? [];
  const history = data?.history ?? [];

  return (
    <div className="atb-page">
      <div className="atb-head">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span className="atb-title">我的任务台</span>
          <span className="atb-eyebrow">ACTIVE TASKS</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="atb-btn" onClick={() => setPasteOpen(true)}>
            <ClipboardPaste size={15} />
            从聊天记录粘贴
          </button>
          <button className="atb-btn" onClick={() => navigate('/active-tasks/history')}>
            <Clock size={15} />
            走过的路
          </button>
        </div>
      </div>

      <div className="atb-split">
        <div className="atb-stack">
          {/* 此刻正在做 */}
          {active ? (
            <div className={`atb-now${active.blocked ? ' atb-now--blocked' : active.overrun ? ' atb-now--overrun' : ''}`}>
              <div className="atb-now__main">
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                  <span
                    className="atb-eyebrow"
                    style={{ color: active.blocked ? 'var(--accent-fg-warning)' : 'var(--accent-primary)' }}
                  >
                    {active.blocked ? '卡住了 · 正在等人' : '此刻正在做'}
                  </span>
                  <span className="atb-meta">
                    {ActiveTaskSourceLabels[active.source] ?? '自己加的'}
                    {active.assignedByName ? ` · ${active.assignedByName} 派的` : ''}
                  </span>
                </div>

                <h2 className="atb-now__heading">{active.title}</h2>

                {active.blocked && active.blockedOn ? (
                  <p className="atb-now__desc">
                    在等「{active.blockedOn}」，已经等了 {fmtHuman(liveBlocked)}。这条已经推到老板的「需要你出手」里了。
                  </p>
                ) : active.note ? (
                  <p className="atb-now__desc">{active.note}</p>
                ) : null}

                {progressPct !== null && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                    <div className="atb-progress">
                      <div
                        className="atb-progress__fill"
                        style={{
                          width: `${progressPct}%`,
                          background: active.overrun ? 'var(--accent-fg-error)' : 'var(--accent-primary)',
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span className="atb-meta">预估 {fmtHuman(active.estimateMinutes * 60)}</span>
                      <span className="atb-meta" style={{ color: active.overrun ? 'var(--accent-fg-error)' : undefined }}>
                        {active.overrun ? '已超出预估一倍以上' : `已用 ${progressPct}%`}
                      </span>
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginTop: 4 }}>
                  <button className="atb-btn atb-btn--primary" disabled={busy} onClick={onFinish}>
                    <Check size={15} />
                    完成，切下一件
                  </button>
                  {active.blocked ? (
                    <button className="atb-btn atb-btn--warn" disabled={busy} onClick={() => void run(() => unblockActiveTask(active.id), '继续计时')}>
                      <AlertTriangle size={15} />
                      不卡了，继续
                    </button>
                  ) : (
                    <button className="atb-btn" disabled={busy} onClick={() => setBlockOpen(true)}>
                      <AlertTriangle size={15} />
                      我卡住了
                    </button>
                  )}
                  <button
                    className="atb-btn"
                    disabled={busy}
                    onClick={() => void run(() => dropActiveTask(active.id, '中途放弃'), '已归入历史，保留放弃记录')}
                  >
                    <X size={15} />
                    放弃这件
                  </button>
                </div>
              </div>

              <div className="atb-now__clock" style={{ color: active.blocked ? 'var(--accent-fg-warning)' : 'var(--accent-primary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span className="atb-pulse" />
                  <span className="atb-eyebrow" style={{ color: 'inherit' }}>{active.blocked ? 'BLOCKED' : 'RUNNING'}</span>
                </div>
                <div className="atb-clock__value">{fmtClock(active.blocked ? liveBlocked : liveElapsed)}</div>
                <div className="atb-clock__note">{active.blocked ? '这段时间算空转，不计入投入' : `累计投入 ${fmtHuman(liveElapsed)}`}</div>
              </div>
            </div>
          ) : (
            <div className="atb-card">
              <div className="atb-empty">
                <Plus size={22} style={{ color: 'var(--accent-primary)' }} />
                <div className="atb-empty__title">还没说你在做什么</div>
                <div className="atb-empty__desc">
                  老板那边现在显示「未汇报」。从下面的备用队列挑一件开始，或者直接加一条。
                </div>
                <button className="atb-btn atb-btn--primary" onClick={() => setAddOpen(true)}>
                  <Plus size={15} />
                  加一件并开始
                </button>
              </div>
            </div>
          )}

          {/* 备用任务 */}
          <div className="atb-card">
            <div className="atb-section-head">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span className="atb-section-title">备用任务</span>
                <span className="atb-meta">按优先级排队 · 做完上面那件自动顶上来</span>
              </div>
              <span className={`atb-chip atb-chip--${data?.fuelLevel ?? 'ok'}`}>{data?.fuelLabel}</span>
            </div>

            {standby.length === 0 ? (
              <div className="atb-empty">
                <AlertTriangle size={22} style={{ color: 'var(--accent-fg-error)' }} />
                <div className="atb-empty__title">备用任务已经见底</div>
                <div className="atb-empty__desc">
                  手上这件做完你就没活了。老板那边此刻已经亮红灯 —— 先挑两件垫上。
                </div>
              </div>
            ) : (
              standby.map((t, i) => (
                <div className="atb-row" key={t.id}>
                  <span className="atb-row__no">{String(i + 1).padStart(2, '0')}</span>
                  <div className="atb-row__body">
                    <div className="atb-row__title">{t.title}</div>
                    <div className="atb-row__sub">
                      <span className={`atb-chip${t.source === 'assigned' ? ' atb-chip--accent' : ''}`}>
                        {ActiveTaskSourceLabels[t.source] ?? '自己加的'}
                        {t.assignedByName ? ` · ${t.assignedByName}` : ''}
                      </span>
                      {t.estimateMinutes > 0 && <span className="atb-meta">预估 {fmtHuman(t.estimateMinutes * 60)}</span>}
                      {t.elapsedSeconds > 0 && <span className="atb-meta">已投入 {t.elapsedLabel}</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 7, flexShrink: 0 }}>
                    {i > 0 && (
                      <button className="atb-btn atb-btn--sm" disabled={busy} onClick={() => void run(() => promoteActiveTask(t.id))}>
                        <ArrowUp size={13} />
                        置顶
                      </button>
                    )}
                    <button className="atb-btn atb-btn--sm" disabled={busy} onClick={() => void run(() => startActiveTask(t.id), '换成做这件了')}>
                      开始做
                    </button>
                    {t.elapsedSeconds === 0 && (
                      <button className="atb-btn atb-btn--sm" disabled={busy} onClick={() => void run(() => deleteActiveTask(t.id))}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}

            <button
              className="atb-btn"
              style={{ width: '100%', borderRadius: 0, borderLeft: 'none', borderRight: 'none', borderBottom: 'none', height: 42, justifyContent: 'center', background: 'transparent' }}
              onClick={() => setAddOpen(true)}
            >
              <Plus size={14} />
              加一件备用任务
            </button>
          </div>
        </div>

        {/* 侧栏 */}
        <div className="atb-stack">
          <div className="atb-mirror">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Eye size={14} style={{ color: 'var(--accent-primary)' }} />
              <span className="atb-eyebrow" style={{ color: 'var(--accent-primary)' }}>老板此刻看到的你</span>
            </div>
            <div className="atb-mirror__text">{data?.bossMirror}</div>
            <div style={{ paddingTop: 9, borderTop: '1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)' }}>
              <span className="atb-meta">这句话由你上面的操作自动生成，不用手写</span>
            </div>
          </div>

          <div className="atb-card">
            <div className="atb-section-head">
              <span className="atb-section-title">刚刚走过的</span>
              <button className="atb-btn atb-btn--sm" onClick={() => navigate('/active-tasks/history')}>全部历史</button>
            </div>
            {history.length === 0 ? (
              <div className="atb-empty">
                <div className="atb-empty__desc">还没有已结束的任务。完成第一件之后，这里会按时间倒序留下流水。</div>
              </div>
            ) : (
              <div style={{ padding: '4px 17px 13px' }}>
                {history.slice(0, 6).map((h: ActiveTaskDto) => (
                  <div key={h.id} style={{ display: 'flex', gap: 11, padding: '9px 0', borderTop: '1px solid var(--border-secondary)' }}>
                    <span
                      style={{
                        width: 7, height: 7, borderRadius: '50%', marginTop: 6, flexShrink: 0,
                        background: h.state === 'dropped' ? 'var(--text-muted)' : 'var(--accent-fg-success)',
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <div
                        style={{
                          fontSize: 12.5, lineHeight: 1.4, textWrap: 'pretty',
                          color: h.state === 'dropped' ? 'var(--text-muted)' : 'var(--text-secondary)',
                          textDecoration: h.state === 'dropped' ? 'line-through' : undefined,
                        }}
                      >
                        {h.title}
                      </div>
                      <span className="atb-meta">
                        {h.state === 'dropped' ? '放弃' : '完成'} · 用了 {h.elapsedLabel}
                        {h.blockedSeconds > 0 ? ` · 空转 ${h.blockedLabel}` : ''}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 加任务 */}
      {addOpen && (
        <div className="atb-modal-backdrop" onClick={() => setAddOpen(false)}>
          <div className="atb-modal" onClick={(e) => e.stopPropagation()}>
            <span className="atb-section-title">加一件备用任务</span>
            <input
              className="atb-input"
              autoFocus
              placeholder="要做的是什么"
              value={addTitle}
              onChange={(e) => setAddTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void onAddConfirm(); }}
            />
            <input
              className="atb-input"
              placeholder="预估几小时（选填，不填就不判断超期）"
              value={addEstimate}
              onChange={(e) => setAddEstimate(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="atb-btn" onClick={() => setAddOpen(false)}>取消</button>
              <button className="atb-btn atb-btn--primary" disabled={busy || !addTitle.trim()} onClick={() => void onAddConfirm()}>加进队列</button>
            </div>
          </div>
        </div>
      )}

      {/* 粘贴聊天记录 */}
      {pasteOpen && (
        <div className="atb-modal-backdrop" onClick={() => setPasteOpen(false)}>
          <div className="atb-modal" onClick={(e) => e.stopPropagation()}>
            <span className="atb-section-title">从聊天记录粘贴</span>
            <div className="atb-empty__desc" style={{ maxWidth: 'none', textAlign: 'left' }}>
              把聊天里那段话整段贴进来，按行切成任务。序号、项目符号、发言人前缀会自动剥掉。
            </div>
            <textarea
              className="atb-input"
              autoFocus
              placeholder={'张三：1. 把 P2 静默失败补上告警\n2. 分支级 env 覆盖\n- 生图超时兜底动画'}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="atb-btn" onClick={() => setPasteOpen(false)}>取消</button>
              <button className="atb-btn atb-btn--primary" disabled={busy || !pasteText.trim()} onClick={() => void onPasteConfirm()}>切成任务</button>
            </div>
          </div>
        </div>
      )}

      {/* 标记卡住 */}
      {blockOpen && (
        <div className="atb-modal-backdrop" onClick={() => setBlockOpen(false)}>
          <div className="atb-modal" onClick={(e) => e.stopPropagation()}>
            <span className="atb-section-title">你在等谁？</span>
            <div className="atb-empty__desc" style={{ maxWidth: 'none', textAlign: 'left' }}>
              只说「卡住了」老板没法处理。写清在等谁、等什么，这条会带着等待时长推到他的待办里。
            </div>
            <input
              className="atb-input"
              autoFocus
              placeholder="例如：等王予重建旧构建容器"
              value={blockedOn}
              onChange={(e) => setBlockedOn(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void onBlockConfirm(); }}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="atb-btn" onClick={() => setBlockOpen(false)}>取消</button>
              <button className="atb-btn atb-btn--warn" disabled={busy || !blockedOn.trim()} onClick={() => void onBlockConfirm()}>标记卡住</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ActiveTasksPage;
