import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, Check, CheckCircle2, ChevronLeft, CircleAlert, FileCheck2, GraduationCap, Play, RefreshCw, RotateCcw, Send, Target, X } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { SegmentedTabs } from '@/components/design/SegmentedTabs';
import { MapSectionLoader, MapSpinner } from '@/components/ui/VideoLoader';
import { useIsMobile } from '@/hooks/useBreakpoint';
import {
  getPractice, getPracticeRun, reopenPracticeTriage, runPracticeReview, startPracticeRun, submitPracticeDecisions, submitPracticeDelivery,
} from '@/services/real/learningCourses';
import { AgentRunPanel } from './AgentRunPanel';
import { FindingCard } from './FindingCard';
import { PracticeWorkbench } from './PracticeWorkbench';
import { DECISION_REGISTRY, PRACTICE_STEPS, SKILL_REGISTRY } from './registry';
import type { Decision, Practice, PracticeRun } from './types';
import './learningCourse.css';

const POLL_MS = 1500;
type StepKey = typeof PRACTICE_STEPS[number]['key'];

function Stepper({ current }: { current: StepKey | 'done' }) {
  const at = current === 'done' ? PRACTICE_STEPS.length : PRACTICE_STEPS.findIndex(s => s.key === current);
  return (
    <ol className="lc-stepper" aria-label="练习进度" data-lc="stepper">
      {PRACTICE_STEPS.map((s, i) => {
        const state = i < at ? 'done' : i === at ? 'current' : 'todo';
        return (
          <li key={s.key} className="flex items-center gap-1">
            {i > 0 && <span className="lc-step-sep" aria-hidden />}
            <span className="lc-step" data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="lc-step-dot">{state === 'done' ? <Check size={12} /> : i + 1}</span>{s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* 练习页：左边是工作台（代码或截图，Agent 的意见直接标在上面），右边是当前这一步要做的事。
 * 一次练习就是一条服务端记录（?run=），评审与复测在服务端跑，离开再回来从原处继续。 */
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
  const syncedFor = useRef<string>('');

  useEffect(() => {
    void getPractice(courseId, practiceId).then(res => (res.success ? setPractice(res.data) : setError(res.error?.message ?? '练习没有加载出来')));
  }, [courseId, practiceId]);

  /* 服务端记录是唯一事实：每次拿到新记录，只在步骤变化时同步本地草稿，避免轮询冲掉正在写的内容 */
  const accept = useCallback((next: PracticeRun) => {
    setPr(next);
    const key = `${next.id}:${next.step}:${next.attempt}`;
    if (syncedFor.current !== key) {
      syncedFor.current = key;
      setDecisions(next.decisions);
      setReasons(next.reasons);
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
  const feedbackOf = (id: string) => pr?.retest && !pr.retest.passed ? pr.retest.feedback.find(x => x.findingId === id)?.message : undefined;

  if (error && !practice) {
    return (
      <div className="lc-page h-full min-h-0 flex items-center justify-center">
        <div className="lc-surface p-6 max-w-md text-center flex flex-col gap-3 items-center">
          <div className="text-[15px] font-semibold">练习暂时打不开</div>
          <div className="text-[13px] lc-secondary">{error}。</div>
          <Button variant="primary" onClick={() => navigate(`/learning-center/courses/${courseId}`)}>回到课程</Button>
        </div>
      </div>
    );
  }
  if (!practice || (runId && !pr)) return <div className="lc-page h-full min-h-0"><MapSectionLoader text="正在打开练习…" /></div>;

  const skill = SKILL_REGISTRY[practice.skill];
  const words = DECISION_REGISTRY[practice.skill];
  const SkillIcon = skill.icon;

  /* ---------- 右栏：当前这一步 ---------- */
  const panel = (() => {
    if (step === 'brief') {
      return (
        <div className="flex flex-col gap-4" data-lc-ready="practice-brief">
          <section className="flex flex-col gap-1.5">
            <div className="lc-eyebrow">场景</div>
            <p className="text-[13.5px] leading-relaxed lc-secondary">{practice.scenario}</p>
          </section>
          <section className="lc-nested p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2 text-[13px] font-semibold"><Target size={14} style={{ color: 'var(--accent-primary)' }} />你要练的判断</div>
            <p className="text-[13px] leading-relaxed lc-secondary">{practice.focus}</p>
          </section>
          <section className="flex flex-col gap-2">
            <div className="lc-eyebrow">交付时要满足</div>
            {practice.acceptance.map(a => <div key={a} className="lc-check lc-secondary"><CheckCircle2 size={15} className="shrink-0 mt-0.5 lc-muted" />{a}</div>)}
          </section>
          <section className="flex flex-col gap-1">
            <div className="lc-eyebrow">怎么进行</div>
            <p className="text-[12.5px] leading-relaxed lc-muted">{practice.agentLabel}先{words.runLabel}，意见会直接标在左边的{practice.subject.kind === 'code' ? '代码' : '截图'}上。你逐条决定「{words.accept}」还是「{words.reject}」，然后复测、写交付说明。大约 {practice.minutes} 分钟。</p>
          </section>
          <Button variant="primary" className="w-full" disabled={busy} onClick={() => void start()} data-lc="start-run">
            {busy ? <MapSpinner size={15} /> : <Play size={15} />}让 Agent 开始{words.runLabel}
          </Button>
        </div>
      );
    }
    if (!pr) return null;

    if (step === 'review' && pr.run) {
      return (
        <div className="flex flex-col gap-3" data-lc-ready={pr.run.status === 'failed' ? 'practice-review-failed' : 'practice-review'}>
          <AgentRunPanel run={pr.run} title={pr.run.status === 'failed' ? `${practice.agentLabel}的${words.runLabel}停在第 ${pr.run.stages.findIndex(s => s.status === 'failed') + 1} 步` : `${practice.agentLabel}正在${words.runLabel}`} foundCount={findings.length} />
          {pr.run.status === 'failed' && pr.run.failure && (
            <div className="lc-nested p-3 flex flex-col gap-2.5" style={{ borderLeft: '3px solid var(--accent-fg-error)' }} data-lc="run-failed">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold"><CircleAlert size={15} style={{ color: 'var(--accent-fg-error)' }} />这次{words.runLabel}没有完成</div>
              <div className="text-[13px] lc-secondary leading-relaxed">{pr.run.failure.message}</div>
              {pr.run.failure.retryable && (
                <Button variant="primary" disabled={busy} onClick={() => void act(() => runPracticeReview(pr.id))} data-lc="retry-run">{busy ? <MapSpinner size={15} /> : <RotateCcw size={15} />}重新{words.runLabel}</Button>
              )}
            </div>
          )}
          {findings.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="lc-eyebrow">已发现，{words.runLabel}完成后逐条判断</div>
              {findings.map((f, i) => (
                <button key={f.id} type="button" className="lc-finding lc-finding-enter text-left flex items-center gap-2 min-h-[44px]" data-selected={selected === f.id} onClick={() => setSelected(f.id)}>
                  <span className="text-[11px] font-bold lc-muted w-5">{i + 1}</span><span className="text-[13px] truncate">{f.title}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (step === 'triage') {
      const failedBefore = pr.retest && !pr.retest.passed;
      return (
        <div className="flex flex-col gap-3" data-lc-ready="practice-triage">
          {failedBefore ? (
            <div className="lc-nested p-3 text-[13px] leading-relaxed" style={{ borderLeft: '3px solid var(--accent-fg-warning)' }} data-lc="retest-failed-banner">
              <span className="font-semibold">上次复测没通过。</span>{pr.retest!.summary} 看每条下面的「复测反馈」，改完判断再复测。
            </div>
          ) : (
            <p className="text-[13px] leading-relaxed lc-secondary">
              {practice.agentLabel}报了 {findings.length} 处。逐条判断：「{words.accept}」会应用它的修复，「{words.reject}」要写一句理由。Agent 也会误报，看证据，不看语气。
            </p>
          )}
          {findings.map((f, i) => (
            <FindingCard
              key={f.id}
              index={i + 1}
              finding={f}
              skill={practice.skill}
              decision={decisions[f.id]}
              reason={reasons[f.id]}
              feedback={feedbackOf(f.id)}
              selected={selected === f.id}
              locked={busy}
              onSelect={() => { setSelected(f.id); if (isMobile) setPane('bench'); }}
              onDecide={d => { setDecisions(x => ({ ...x, [f.id]: d })); setSelected(f.id); }}
              onReason={text => setReasons(x => ({ ...x, [f.id]: text }))}
            />
          ))}
          <div className="sticky bottom-0 -mx-3.5 -mb-3.5 px-3.5 pt-3 pb-3 flex flex-col gap-1.5" style={{ background: 'var(--panel-solid)', borderTop: '1px solid var(--border-subtle)' }}>
            <Button variant="primary" className="w-full" disabled={busy || undecided.length > 0} onClick={() => void act(() => submitPracticeDecisions(pr.id, decisions, reasons))} data-lc="submit-decisions">
              {busy ? <MapSpinner size={15} /> : <RefreshCw size={15} />}应用修复并复测
            </Button>
            <div className="text-[12px] text-center lc-muted" data-lc="undecided-hint" data-remaining={undecided.length}>
              {undecided.length > 0 ? `还有 ${undecided.length} 处没判断完（驳回的需要写理由）` : `已判断 ${findings.length}/${findings.length} 处，复测会用同一组输入重跑`}
            </div>
          </div>
        </div>
      );
    }

    if (step === 'retest' && pr.run) {
      return (
        <div className="flex flex-col gap-3" data-lc-ready="practice-retest">
          <AgentRunPanel run={pr.run} title="正在应用修复并复测" />
          <Summary pr={pr} words={words} />
        </div>
      );
    }

    if (step === 'deliver') {
      return (
        <div className="flex flex-col gap-3" data-lc-ready="practice-deliver">
          {pr.retest && (
            <div className="lc-nested p-3 flex flex-col gap-1.5" style={{ borderLeft: '3px solid var(--accent-fg-success)' }} data-lc="retest-passed">
              <div className="flex items-center gap-2 text-[13.5px] font-semibold"><CheckCircle2 size={15} style={{ color: 'var(--accent-fg-success)' }} />复测通过</div>
              {pr.retest.checks.map(c => <div key={c.name} className="lc-check lc-secondary"><Check size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--accent-fg-success)' }} />{c.name}{c.message && <span className="lc-muted"> · {c.message}</span>}</div>)}
            </div>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold">交付说明</span>
            <span className="text-[12px] lc-muted">已按你的判断和复测结果起草，三段式：能做什么 · 怎么证明 · 还没做到什么。可以直接改。</span>
            <textarea className="lc-input lc-mono" rows={10} value={note} onChange={e => setNote(e.target.value)} disabled={busy} data-lc="delivery-note" style={{ resize: 'vertical', fontSize: 12.5 }} />
          </label>
          <Button variant="primary" className="w-full" disabled={busy || !note.trim()} onClick={() => void act(() => submitPracticeDelivery(pr.id, note))} data-lc="submit-delivery">
            {busy ? <MapSpinner size={15} /> : <Send size={15} />}提交交付
          </Button>
        </div>
      );
    }

    if (step === 'done' && pr.outcome) {
      return (
        <div className="flex flex-col gap-4" data-lc-ready="practice-done">
          <div className="flex flex-col items-center text-center gap-2 py-3">
            <span className="lc-nested inline-flex items-center justify-center" style={{ width: 52, height: 52, borderRadius: 999 }}><GraduationCap size={24} style={{ color: 'var(--accent-fg-success)' }} /></span>
            <div className="text-[16px] font-bold">练习完成</div>
            <div className="text-[13px] lc-secondary">这次完整走了一遍：检查 → 判断 → 修复 → 复测 → 交付。+{pr.outcome.xp} 经验，已计入学习中心。</div>
          </div>
          <ol className="flex flex-col gap-0 lc-nested p-3" data-lc="timeline">
            {pr.outcome.timeline.map(t => (
              <li key={t.at + t.text} className="flex gap-3 text-[12.5px] min-h-[30px] items-baseline"><span className="lc-mono lc-muted shrink-0">{t.at}</span><span className="lc-secondary">{t.text}</span></li>
            ))}
          </ol>
          <div className="flex flex-col gap-2">
            <Button variant="primary" className="w-full" onClick={() => navigate(`/learning-center/courses/${courseId}`)} data-lc="back-course"><ArrowRight size={15} />回到课程，换一个练习</Button>
            <Button variant="ghost" className="w-full" onClick={() => setParams(new URLSearchParams(), { replace: true })}><RotateCcw size={15} />重新做一遍</Button>
          </div>
        </div>
      );
    }
    return null;
  })();

  const retestFailed = step === 'retest' && pr?.retest && !pr.retest.passed && pr.run?.status === 'done';

  return (
    <div className="lc-page h-full min-h-0 flex flex-col gap-3" data-lc-ready="practice">
      <header className={`lc-surface lc-topbar shrink-0 ${isMobile ? '' : 'flex-wrap'}`}>
        <Link to={`/learning-center/courses/${courseId}`} className="lc-crumb shrink-0" data-lc="back-to-course" aria-label="回到课程"><ChevronLeft size={15} /><span className="hidden sm:inline">自动化测试实践</span></Link>
        <span className="lc-muted shrink-0 hidden sm:inline" aria-hidden>/</span>
        <div className="min-w-0 flex-1 flex items-center gap-2">
          <SkillIcon size={16} className="shrink-0" style={{ color: 'var(--accent-primary)' }} />
          <h1 className="text-[15px] font-bold truncate">{isMobile ? practice.title : `练习 · ${practice.title}`}</h1>
        </div>
        {isMobile ? (
          <span className="text-[12px] lc-secondary shrink-0" data-lc="stepper-compact">
            {step === 'done' ? '已完成' : `第 ${PRACTICE_STEPS.findIndex(s => s.key === step) + 1}/${PRACTICE_STEPS.length} 步 · ${PRACTICE_STEPS.find(s => s.key === step)?.label}`}
          </span>
        ) : <div className="w-full lg:w-auto"><Stepper current={step} /></div>}
      </header>

      {isMobile && (
        <div className="shrink-0" data-qc-touch-exempt>
          <SegmentedTabs ariaLabel="练习页面切换" items={[{ key: 'task', label: '这一步' }, { key: 'bench', label: practice.subject.kind === 'code' ? `代码 · ${findings.length} 处标注` : `截图 · ${findings.length} 处标注` }]} value={pane} onChange={setPane} />
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-3">
        {(!isMobile || pane === 'bench') && (
          <div className="flex-1 min-w-0 min-h-0">
            <PracticeWorkbench practice={practice} findings={findings} decisions={decisions} selected={selected} onSelect={setSelected} showFixes={step === 'retest' || step === 'deliver' || step === 'done'} />
          </div>
        )}
        {(!isMobile || pane === 'task') && (
          <aside className={`lc-surface lc-scroll ${isMobile ? 'flex-1' : 'shrink-0'} p-3.5`} style={isMobile ? undefined : { width: 420 }} aria-label="当前步骤" data-tour-id="practice-step-panel">
            {error && <div className="text-[12.5px] mb-3 lc-nested px-3 py-2" style={{ color: 'var(--accent-fg-error)' }} role="alert">{error}。已保存你的进度，可以再试一次。</div>}
            {retestFailed ? (
              <div className="flex flex-col gap-3" data-lc-ready="practice-retest-failed">
                <div className="lc-nested p-3 flex flex-col gap-2" style={{ borderLeft: '3px solid var(--accent-fg-warning)' }}>
                  <div className="flex items-center gap-2 text-[13.5px] font-semibold"><CircleAlert size={15} style={{ color: 'var(--accent-fg-warning)' }} />复测没通过</div>
                  <div className="text-[13px] lc-secondary leading-relaxed">{pr!.retest!.summary}</div>
                  {pr!.retest!.checks.map(c => (
                    <div key={c.name} className="lc-check lc-secondary">
                      {c.status === 'pass' ? <Check size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--accent-fg-success)' }} /> : <X size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--accent-fg-error)' }} />}
                      <span>{c.name}{c.message && <span className="lc-muted"> · {c.message}</span>}</span>
                    </div>
                  ))}
                </div>
                <Button variant="primary" className="w-full" disabled={busy} onClick={() => void act(() => reopenPracticeTriage(pr!.id))} data-lc="reopen-triage">
                  {busy ? <MapSpinner size={15} /> : <RotateCcw size={15} />}回到判断，看哪条判错了
                </Button>
                <Summary pr={pr!} words={words} />
                <p className="text-[12px] lc-muted leading-relaxed">回到判断后，判错的那条下面会写明复测看到了什么。已作的判断都保留，只改判错的即可。</p>
              </div>
            ) : panel}
          </aside>
        )}
      </div>
    </div>
  );
}

function Summary({ pr, words }: { pr: PracticeRun; words: { accept: string; reject: string } }) {
  const acc = Object.values(pr.decisions).filter(d => d === 'accept').length;
  const rej = Object.values(pr.decisions).filter(d => d === 'reject').length;
  return (
    <div className="flex items-center gap-3 text-[12.5px] lc-secondary">
      <FileCheck2 size={14} />你的判断：{words.accept} {acc} 处 · {words.reject} {rej} 处
    </div>
  );
}
