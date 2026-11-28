import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, ChevronLeft, CircleAlert, Play, RefreshCw, RotateCcw, Send, Target } from 'lucide-react';
import { useIsMobile } from '@/hooks/useBreakpoint';
import {
  getPractice, getPracticeRun, reopenPracticeTriage, runPracticeReview, startPracticeRun, submitPracticeDecisions, submitPracticeDelivery,
} from '@/services/real/learningCourses';
import { FindingTicket } from './FindingTicket';
import { PracticeWorkbench } from './PracticeWorkbench';
import { Act, Busy, Kicker } from './primitives';
import { DECISION_REGISTRY, PRACTICE_STEPS, SKILL_REGISTRY } from './registry';
import { RunConsole } from './RunConsole';
import type { Decision, Practice, PracticeRun } from './types';
import './learningCourse.css';

const POLL_MS = 1500;
type StepKey = typeof PRACTICE_STEPS[number]['key'];

function Steps({ current }: { current: StepKey | 'done' }) {
  const at = current === 'done' ? PRACTICE_STEPS.length : PRACTICE_STEPS.findIndex(s => s.key === current);
  return (
    <ol className="lc-steps" aria-label="练习进度" data-lc="stepper">
      {PRACTICE_STEPS.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'todo';
        return (
          <li key={s.key} className="flex items-center">
            {i > 0 && <span className="lc-step-line" data-done={i <= at} aria-hidden />}
            <span className="lc-step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}><i>{state === 'done' ? <Check size={12} strokeWidth={3} /> : i + 1}</i>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/* 练习页（检验台）：左边是被检物，Agent 的意见作为编号旗标插在上面；右边是控制台——
 * 读任务、看 Agent 打日志、给工单盖章、看复测记分板、写交付单、领合格证。
 * 一次练习是一条服务端记录（?run=），评审与复测在服务端跑，离开再回来从原处继续。 */
export default function LearningPracticePage() {
  const { courseId = '', practiceId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const runId = params.get('run');
  const [practice, setPractice] = useState<Practice | null>(null);
  const [pr, setPr] = useState<PracticeRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [pane, setPane] = useState<'task' | 'bench'>('task');
  const synced = useRef('');

  useEffect(() => { void getPractice(courseId, practiceId).then(res => (res.success ? setPractice(res.data) : setError(res.error?.message ?? '练习没有加载出来'))); }, [courseId, practiceId]);

  /* 服务端记录是唯一事实；只在步骤变化时同步本地草稿，避免轮询冲掉正在写的内容 */
  const accept = useCallback((next: PracticeRun) => {
    setPr(next);
    const key = `${next.id}:${next.step}:${next.attempt}`;
    if (synced.current !== key) {
      synced.current = key;
      setDecisions(next.decisions); setReasons(next.reasons);
      if (next.deliveryDraft && !next.delivery?.submittedAt) setNote(next.delivery?.note ?? next.deliveryDraft);
    }
  }, []);
  useEffect(() => {
    if (!runId) { setPr(null); return; }
    let alive = true;
    void getPracticeRun(runId).then(res => { if (!alive) return; if (res.success) accept(res.data); else setError(res.error?.message ?? '没有找到这次练习'); });
    return () => { alive = false; };
  }, [runId, accept]);
  const running = pr?.run && (pr.run.status === 'queued' || pr.run.status === 'running');
  useEffect(() => {
    if (!running || !pr) return;
    const t = window.setTimeout(() => { void getPracticeRun(pr.id).then(res => { if (res.success) accept(res.data); }); }, POLL_MS);
    return () => window.clearTimeout(t);
  }, [running, pr, accept]);

  const act = async (fn: () => ReturnType<typeof getPracticeRun>, after?: (r: PracticeRun) => void) => {
    setBusy(true); setError(null);
    const res = await fn();
    setBusy(false);
    if (res.success) { accept(res.data); after?.(res.data); } else setError(res.error?.message ?? '这一步没有完成');
  };
  const start = () => act(() => startPracticeRun(courseId, practiceId), r => { const p = new URLSearchParams(params); p.set('run', r.id); setParams(p, { replace: true }); });

  const findings = useMemo(() => pr?.findings ?? [], [pr]);
  const step: StepKey | 'done' = pr ? pr.step : 'brief';
  const undecided = findings.filter(f => !decisions[f.id] || (decisions[f.id] === 'reject' && !(reasons[f.id] ?? '').trim()));
  const feedbackOf = (id: string) => (pr?.retest && !pr.retest.passed ? pr.retest.feedback.find(x => x.findingId === id)?.message : undefined);

  if (error && !practice) {
    return (
      <div className="lc-root h-full min-h-0 flex items-center justify-center lc-grid-bg">
        <div className="lc-panel p-6 max-w-md flex flex-col gap-3">
          <Kicker>练习暂时打不开</Kicker>
          <div className="text-[15px] font-semibold">{error}</div>
          <Act tone="primary" onClick={() => navigate(`/learning-center/courses/${courseId}`)}>回到课程</Act>
        </div>
      </div>
    );
  }
  if (!practice || (runId && !pr)) {
    return <div className="lc-root h-full min-h-0 flex flex-col gap-3" aria-busy="true"><div className="lc-skel" style={{ height: 64 }} /><div className="lc-bench flex-1"><div className="lc-skel" /><div className="lc-skel" /></div><Kicker>正在打开练习…</Kicker></div>;
  }

  const skill = SKILL_REGISTRY[practice.skill];
  const words = DECISION_REGISTRY[practice.skill];
  const SkillIcon = skill.icon;
  const retestFailed = step === 'retest' && pr?.retest && !pr.retest.passed && pr.run?.status === 'done';
  const accepted = Object.values(pr?.decisions ?? {}).filter(d => d === 'accept').length;

  /* ---------- 控制台：当前这一步 ---------- */
  let body: ReactNode = null;
  let dock: ReactNode = null;
  if (step === 'brief') {
    body = (
      <div className="flex flex-col gap-4" data-lc-ready="practice-brief">
        <p className="text-[14px] leading-relaxed">{practice.scenario}</p>
        <div className="lc-work flex flex-col gap-1.5" style={{ animation: 'none' }}>
          <div className="flex items-center gap-2 text-[13px] font-semibold"><Target size={15} style={{ color: 'var(--lc-hi)' }} />你要练的判断</div>
          <p className="text-[13px] leading-relaxed lc-ink2">{practice.focus}</p>
        </div>
        <div>
          <Kicker>交付验收单</Kicker>
          <ol className="mt-2 flex flex-col gap-1.5">
            {practice.acceptance.map((a, i) => <li key={a} className="grid gap-2 text-[13px] lc-ink2" style={{ gridTemplateColumns: '22px 1fr' }}><span className="lc-mono text-[11px]" style={{ color: 'var(--lc-hi)', paddingTop: 3 }}>□{i + 1}</span>{a}</li>)}
          </ol>
        </div>
        <div>
          <Kicker>流程</Kicker>
          <p className="text-[12.5px] leading-relaxed lc-ink3 mt-1.5">{practice.agentLabel}先{words.runLabel}，意见以编号旗标插在左边的{practice.subject.kind === 'code' ? '代码' : '截图'}上。你给每张工单盖「{words.accept}」或「{words.reject}」，然后复测、写交付单。约 {practice.minutes} 分钟。</p>
        </div>
      </div>
    );
    dock = <Act tone="primary" className="w-full" disabled={busy} onClick={() => void start()} data-lc="start-run">{busy ? <Busy /> : <Play size={15} />}让 Agent 开始{words.runLabel}</Act>;
  } else if (pr && step === 'review' && pr.run) {
    const failed = pr.run.status === 'failed';
    body = (
      <div className="flex flex-col gap-3" data-lc-ready={failed ? 'practice-review-failed' : 'practice-review'}>
        <RunConsole run={pr.run} findings={findings} title={failed ? `${practice.agentLabel}的${words.runLabel}停在第 ${pr.run.stages.findIndex(s => s.status === 'failed') + 1} 步` : `${practice.agentLabel}正在${words.runLabel}`} />
        {failed && pr.run.failure && (
          <div className="lc-work flex flex-col gap-1.5" style={{ borderColor: 'var(--lc-fail)' }} data-lc="run-failed">
            <div className="flex items-center gap-2 text-[13.5px] font-semibold"><CircleAlert size={15} style={{ color: 'var(--lc-fail)' }} />这次{words.runLabel}没有完成</div>
            <div className="text-[13px] lc-ink2 leading-relaxed">{pr.run.failure.message}</div>
          </div>
        )}
      </div>
    );
    if (failed && pr.run.failure?.retryable) dock = <Act tone="primary" className="w-full" disabled={busy} onClick={() => void act(() => runPracticeReview(pr.id))} data-lc="retry-run">{busy ? <Busy /> : <RotateCcw size={15} />}重新{words.runLabel}</Act>;
  } else if (pr && step === 'triage') {
    const before = pr.retest && !pr.retest.passed;
    body = (
      <div className="flex flex-col gap-3" data-lc-ready="practice-triage">
        <p className="text-[13px] leading-relaxed lc-ink2" data-lc={before ? 'retest-failed-banner' : undefined}>
          {before ? <><b style={{ color: 'var(--lc-warn)' }}>上次复测没通过。</b>{pr.retest!.summary} 看工单里的「复测看到」，改判后再复测。</>
            : <>{practice.agentLabel}开了 {findings.length} 张工单。逐张盖章：「{words.accept}」会应用它的修复，「{words.reject}」要写理由。Agent 也会误报，看证据，不看语气。</>}
        </p>
        {findings.map((f, i) => (
          <FindingTicket key={f.id} index={i + 1} finding={f} skill={practice.skill} decision={decisions[f.id]} reason={reasons[f.id]} feedback={feedbackOf(f.id)}
            selected={selected === f.id} locked={busy}
            onSelect={() => { setSelected(f.id); if (isMobile) setPane('bench'); }}
            onDecide={d => { setDecisions(x => ({ ...x, [f.id]: d })); setSelected(f.id); }}
            onReason={t => setReasons(x => ({ ...x, [f.id]: t }))} />
        ))}
      </div>
    );
    dock = (
      <div className="flex flex-col gap-1.5">
        <Act tone="primary" className="w-full" disabled={busy || undecided.length > 0} onClick={() => void act(() => submitPracticeDecisions(pr.id, decisions, reasons))} data-lc="submit-decisions">{busy ? <Busy /> : <RefreshCw size={15} />}应用修复并复测</Act>
        <div className="text-[12px] text-center lc-ink3" data-lc="undecided-hint" data-remaining={undecided.length}>
          {undecided.length > 0 ? `还有 ${undecided.length} 张工单没盖章（驳回的需要写理由）` : `${findings.length} 张都盖好了，复测会用同一组输入重跑`}
        </div>
      </div>
    );
  } else if (pr && step === 'retest' && pr.run) {
    body = (
      <div className="flex flex-col gap-3" data-lc-ready={retestFailed ? 'practice-retest-failed' : 'practice-retest'}>
        <RunConsole run={pr.run} title={retestFailed ? '复测没通过' : '正在应用修复并复测'} retest={pr.retest} />
        <div className="text-[12.5px] lc-ink3">你的判断：{words.accept} {accepted} 张 · {words.reject} {findings.length - accepted} 张</div>
        {retestFailed && <p className="text-[13px] leading-relaxed lc-ink2">{pr.retest!.summary} 回到判断后，判错的那张工单上会写明复测看到了什么；其余判断都保留。</p>}
      </div>
    );
    if (retestFailed) dock = <Act tone="primary" className="w-full" disabled={busy} onClick={() => void act(() => reopenPracticeTriage(pr.id))} data-lc="reopen-triage">{busy ? <Busy /> : <RotateCcw size={15} />}回到判断，看哪张判错了</Act>;
  } else if (pr && step === 'deliver') {
    body = (
      <div className="flex flex-col gap-3" data-lc-ready="practice-deliver">
        {pr.retest && (
          <div className="lc-board" data-lc="retest-passed">
            {pr.retest.checks.map(c => <div key={c.name}><span className="lc-verdict" style={{ color: 'var(--lc-pass)' }}>PASS</span><span>{c.name}{c.message && <span className="lc-ink3"> · {c.message}</span>}</span></div>)}
          </div>
        )}
        <div className="lc-slip">
          <div className="flex items-baseline justify-between"><Kicker>交付单</Kicker><span className="lc-mono text-[11px] lc-ink3">{pr.id.toUpperCase()}</span></div>
          <p className="text-[12px] lc-ink3 mt-1 mb-2">按你的判断和复测结果起草，三段式：能做什么 · 怎么证明 · 还没做到什么。可以直接改。</p>
          <textarea className="lc-input" rows={11} value={note} onChange={e => setNote(e.target.value)} disabled={busy} data-lc="delivery-note" style={{ resize: 'vertical' }} />
        </div>
      </div>
    );
    dock = <Act tone="primary" className="w-full" disabled={busy || !note.trim()} onClick={() => void act(() => submitPracticeDelivery(pr.id, note))} data-lc="submit-delivery">{busy ? <Busy /> : <Send size={15} />}提交交付</Act>;
  } else if (pr && step === 'done' && pr.outcome) {
    body = (
      <div className="flex flex-col gap-4" data-lc-ready="practice-done">
        <div className="lc-cert">
          <div className="lc-seal"><span>合格</span><span className="lc-mono" style={{ fontSize: 9, letterSpacing: '0.05em' }}>PASS</span></div>
          <div className="text-[17px] font-bold">练习完成</div>
          <div className="text-[13px] lc-ink2 mt-1">{practice.title}</div>
          <div className="text-[12.5px] lc-ink3 mt-2">检查 → 判断 → 修复 → 复测 → 交付 · <b style={{ color: 'var(--lc-pass)' }}>+{pr.outcome.xp} 经验</b> 已计入学习中心</div>
          <div className="lc-mono text-[10.5px] lc-ink3 mt-3">编号 {pr.id.toUpperCase()}</div>
        </div>
        <ol className="lc-log lc-panel" style={{ background: 'var(--lc-solid)' }} data-lc="timeline">
          {pr.outcome.timeline.map(t => <li key={t.at + t.text} className="lc-log-line"><span className="lc-t">{t.at}</span><span className="lc-log-tag" data-tone="ok">·</span><span style={{ color: 'var(--lc-ink)' }}>{t.text}</span></li>)}
        </ol>
      </div>
    );
    dock = (
      <div className="flex flex-col gap-1">
        <Act tone="primary" className="w-full" onClick={() => navigate(`/learning-center/courses/${courseId}`)} data-lc="back-course">回到课程，换一个练习<ArrowRight size={15} /></Act>
        <Act tone="ghost" className="w-full" onClick={() => setParams(new URLSearchParams(), { replace: true })}><RotateCcw size={15} />重新做一遍</Act>
      </div>
    );
  }

  return (
    <div className="lc-root h-full min-h-0 flex flex-col gap-3" data-lc-ready="practice" data-practice-id={practice.id}>
      <header className="lc-panel shrink-0 flex items-center gap-3 px-3 py-2 flex-wrap">
        <Link to={`/learning-center/courses/${courseId}`} className="lc-link" data-lc="back-to-course" aria-label="回到课程"><ChevronLeft size={15} /><span className="max-sm:hidden">自动化测试实践</span></Link>
        <span className="lc-glyph shrink-0"><SkillIcon size={16} /></span>
        <div className="min-w-0 flex-1">
          <div className="lc-kicker">练习 · {skill.label}</div>
          <h1 className="text-[15px] font-bold truncate">{practice.title}</h1>
        </div>
        {isMobile ? (
          <span className="lc-mono text-[12px] lc-ink2" data-lc="stepper-compact">{step === 'done' ? '已完成' : `${PRACTICE_STEPS.findIndex(s => s.key === step) + 1}/${PRACTICE_STEPS.length} · ${PRACTICE_STEPS.find(s => s.key === step)?.label}`}</span>
        ) : <Steps current={step} />}
      </header>

      {isMobile && (
        <div className="lc-panel shrink-0 grid grid-cols-2 p-1 gap-1" role="tablist" aria-label="练习页面切换">
          {(['task', 'bench'] as const).map(k => (
            <button key={k} type="button" role="tab" aria-selected={pane === k} className="lc-tool" aria-pressed={pane === k} onClick={() => setPane(k)}>
              {k === 'task' ? '这一步' : `${practice.subject.kind === 'code' ? '代码' : '截图'} · ${findings.length} 处标注`}
            </button>
          ))}
        </div>
      )}

      <div className="lc-bench flex-1">
        {(!isMobile || pane === 'bench') && (
          <div className="min-w-0 min-h-0" style={isMobile ? { height: '70vh' } : undefined}>
            <PracticeWorkbench practice={practice} findings={findings} decisions={decisions} selected={selected} onSelect={setSelected} showFixes={step === 'retest' || step === 'deliver' || step === 'done'} />
          </div>
        )}
        {(!isMobile || pane === 'task') && (
          <aside className="lc-panel lc-console" aria-label="当前步骤" data-tour-id="practice-step-panel">
            <div className="lc-console-head"><Kicker>控制台</Kicker><span className="flex-1" /><span className="text-[12px] lc-ink3">{step === 'done' ? '已完成' : PRACTICE_STEPS.find(s => s.key === step)?.label}</span></div>
            <div className="lc-scroll flex-1 p-4">
              {error && <div className="text-[12.5px] mb-3 px-3 py-2 rounded-[10px]" style={{ color: 'var(--lc-fail)', background: 'color-mix(in srgb, var(--lc-fail) 9%, transparent)' }} role="alert">{error}。已保存你的进度，可以再试一次。</div>}
              {body}
            </div>
            {dock && <div className="lc-dock">{dock}</div>}
          </aside>
        )}
      </div>
    </div>
  );
}
