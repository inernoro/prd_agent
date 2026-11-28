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
            <span className="lc-step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}><i />{s.label}</span>
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
      <div className="lc-root h-full min-h-0 flex items-center justify-center">
        <div className="lc-panel p-6 max-w-md flex flex-col gap-3">
          <Kicker>练习暂时打不开</Kicker>
          <div className="t-strong">{error}</div>
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

  /* ---------- 右栏：当前这一步 ---------- */
  let body: ReactNode = null;
  let dock: ReactNode = null;
  if (step === 'brief') {
    body = (
      <div className="flex flex-col gap-6" data-lc-ready="practice-brief">
        <p>{practice.scenario}</p>
        <section>
          <h3 className="t-strong flex items-center gap-2"><Target size={16} style={{ color: 'var(--hi)' }} />你要练的判断</h3>
          <p className="t-mute mt-1">{practice.focus}</p>
        </section>
        <section>
          <h3 className="t-strong">交付时要满足</h3>
          <ol className="mt-2 flex flex-col gap-1.5 t-mute" style={{ listStyle: 'decimal', paddingLeft: 20 }}>{practice.acceptance.map(a => <li key={a}>{a}</li>)}</ol>
        </section>
        <section>
          <h3 className="t-strong">怎么进行</h3>
          <p className="t-mute mt-1">{practice.agentLabel}先{words.runLabel}，意见会标在左边的{practice.subject.kind === 'code' ? '代码' : '截图'}上。你逐条决定「{words.accept}」还是「{words.reject}」，然后复测、写交付说明。约 {practice.minutes} 分钟。</p>
        </section>
      </div>
    );
    dock = <Act tone="primary" className="w-full" disabled={busy} onClick={() => void start()} data-lc="start-run">{busy ? <Busy /> : <Play size={15} />}让 Agent 开始{words.runLabel}</Act>;
  } else if (pr && step === 'review' && pr.run) {
    const failed = pr.run.status === 'failed';
    body = (
      <div className="flex flex-col gap-4" data-lc-ready={failed ? 'practice-review-failed' : 'practice-review'}>
        <RunConsole run={pr.run} findings={findings} title={failed ? `${practice.agentLabel}的${words.runLabel}停在第 ${pr.run.stages.findIndex(s => s.status === 'failed') + 1} 步` : `${practice.agentLabel}正在${words.runLabel}`} />
        {failed && pr.run.failure && (
          <div className="pl-3" style={{ borderLeft: '2px solid var(--fail)' }} data-lc="run-failed">
            <div className="t-strong flex items-center gap-2"><CircleAlert size={16} style={{ color: 'var(--fail)' }} />这次{words.runLabel}没有完成</div>
            <p className="t-mute mt-1">{pr.run.failure.message}</p>
          </div>
        )}
      </div>
    );
    if (failed && pr.run.failure?.retryable) dock = <Act tone="primary" className="w-full" disabled={busy} onClick={() => void act(() => runPracticeReview(pr.id))} data-lc="retry-run">{busy ? <Busy /> : <RotateCcw size={15} />}重新{words.runLabel}</Act>;
  } else if (pr && step === 'triage') {
    const before = pr.retest && !pr.retest.passed;
    body = (
      <div className="flex flex-col" data-lc-ready="practice-triage">
        <p className="t-mute pb-4" data-lc={before ? 'retest-failed-banner' : undefined}>
          {before ? <><span style={{ color: 'var(--warn)' }}>上次复测没通过。</span>{pr.retest!.summary} 看各条下面的「复测看到」，改判后再复测。</>
            : <>{practice.agentLabel}报了 {findings.length} 条意见。「{words.accept}」会应用它的修复，「{words.reject}」要写理由。Agent 也会误报，看证据，不看语气。</>}
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
      <div className="flex flex-col gap-2">
        <Act tone="primary" className="w-full" disabled={busy || undecided.length > 0} onClick={() => void act(() => submitPracticeDecisions(pr.id, decisions, reasons))} data-lc="submit-decisions">{busy ? <Busy /> : <RefreshCw size={15} />}应用修复并复测</Act>
        <div className="t-meta t-mute text-center" data-lc="undecided-hint" data-remaining={undecided.length}>
          {undecided.length > 0 ? `还有 ${undecided.length} 条没判断（驳回的需要写理由）` : `${findings.length} 条都判断了，复测会用同一组输入重跑`}
        </div>
      </div>
    );
  } else if (pr && step === 'retest' && pr.run) {
    body = (
      <div className="flex flex-col gap-4" data-lc-ready={retestFailed ? 'practice-retest-failed' : 'practice-retest'}>
        <RunConsole run={pr.run} title={retestFailed ? '复测没通过' : '正在应用修复并复测'} retest={pr.retest} />
        <p className="t-meta t-mute">你的判断：{words.accept} {accepted} 条，{words.reject} {findings.length - accepted} 条</p>
        {retestFailed && <p className="t-mute">{pr.retest!.summary} 回到判断后，判错的那条下面会写明复测看到了什么，其余判断都保留。</p>}
      </div>
    );
    if (retestFailed) dock = <Act tone="primary" className="w-full" disabled={busy} onClick={() => void act(() => reopenPracticeTriage(pr.id))} data-lc="reopen-triage">{busy ? <Busy /> : <RotateCcw size={15} />}回到判断，看哪条判错了</Act>;
  } else if (pr && step === 'deliver') {
    body = (
      <div className="flex flex-col gap-5" data-lc-ready="practice-deliver">
        {pr.retest && (
          <section>
            <h3 className="t-strong flex items-center gap-2"><Check size={16} style={{ color: 'var(--pass)' }} />复测通过</h3>
            <div className="lc-checks mt-2" data-lc="retest-passed">
              {pr.retest.checks.map(c => <div key={c.name}><span className="lc-verdict" style={{ color: 'var(--pass)' }}>PASS</span><span>{c.name}{c.message && <span className="t-mute"> · {c.message}</span>}</span></div>)}
            </div>
          </section>
        )}
        <label className="flex flex-col gap-2">
          <span className="t-strong">交付说明</span>
          <span className="t-meta t-mute">已按你的判断和复测结果起草：能做什么、怎么证明、还没做到什么。可以直接改。</span>
          <textarea className="lc-input" rows={11} value={note} onChange={e => setNote(e.target.value)} disabled={busy} data-lc="delivery-note" style={{ resize: 'vertical' }} />
        </label>
      </div>
    );
    dock = <Act tone="primary" className="w-full" disabled={busy || !note.trim()} onClick={() => void act(() => submitPracticeDelivery(pr.id, note))} data-lc="submit-delivery">{busy ? <Busy /> : <Send size={15} />}提交交付</Act>;
  } else if (pr && step === 'done' && pr.outcome) {
    body = (
      <div className="flex flex-col gap-6" data-lc-ready="practice-done">
        <section className="flex flex-col items-start gap-2 pt-2">
          <span className="inline-flex items-center justify-center rounded-full" style={{ width: 40, height: 40, border: '1.5px solid var(--pass)', color: 'var(--pass)' }}><Check size={20} /></span>
          <h3 className="t-title">练习完成</h3>
          <p className="t-mute">完整走了一遍：检查、判断、修复、复测、交付。获得 {pr.outcome.xp} 经验，已计入学习中心。</p>
        </section>
        <section>
          <h3 className="t-strong">过程记录</h3>
          <ol className="lc-log mt-2" data-lc="timeline">
            {pr.outcome.timeline.map(t => <li key={t.at + t.text} className="lc-log-line" style={{ gridTemplateColumns: '48px 1fr' }}><span>{t.at}</span><span style={{ color: 'var(--ink)' }}>{t.text}</span></li>)}
          </ol>
        </section>
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
    <div className="lc-root h-full min-h-0 flex flex-col gap-4" data-lc-ready="practice" data-practice-id={practice.id}>
      <header className="lc-panel shrink-0 flex items-center gap-4 px-4 py-2 flex-wrap">
        <Link to={`/learning-center/courses/${courseId}`} className="lc-link t-meta" data-lc="back-to-course" aria-label="回到课程"><ChevronLeft size={14} /><span className="max-sm:hidden">自动化测试实践</span></Link>
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <SkillIcon size={16} className="shrink-0" style={{ color: 'var(--ink-2)' }} />
          <h1 className="t-strong truncate">练习：{practice.title}</h1>
        </div>
        {isMobile ? (
          <span className="t-meta t-mute" data-lc="stepper-compact">{step === 'done' ? '已完成' : `第 ${PRACTICE_STEPS.findIndex(s => s.key === step) + 1}/${PRACTICE_STEPS.length} 步 · ${PRACTICE_STEPS.find(s => s.key === step)?.label}`}</span>
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
            <div className="lc-scroll flex-1 px-5 py-5">
              {error && <p className="mb-4 pl-3" style={{ borderLeft: '2px solid var(--fail)', color: 'var(--fail)' }} role="alert">{error}。已保存你的进度，可以再试一次。</p>}
              {body}
            </div>
            {dock && <div className="lc-dock">{dock}</div>}
          </aside>
        )}
      </div>
    </div>
  );
}
