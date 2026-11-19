import { useState } from 'react';
import { ArrowLeft, CircleCheck, CircleHelp, CircleX, Route } from 'lucide-react';
import { NotificationIncidentCard } from '@/components/notifications/NotificationIncidentCard';
import type { AdminNotificationItem, NotificationIncidentEvidence, NotificationIncidentFollowUp } from '@/services/contracts/notifications';

const FAILURE: NotificationIncidentEvidence = {
  outcome: 'request_failed', observedAt: '2026-11-19T08:04:00Z', requestId: 'exercise-image-1604',
};
const FALLBACK: NotificationIncidentEvidence = {
  outcome: 'fallback_succeeded', observedAt: '2026-11-19T08:11:00Z', requestId: 'exercise-image-1611',
};
const RECOVERY: NotificationIncidentEvidence = {
  outcome: 'recovered', observedAt: '2026-11-19T08:23:00Z', requestId: 'exercise-image-1623', routeLabel: '图片创作 · 生图主线路',
};
const RECURRENCE: NotificationIncidentEvidence = {
  outcome: 'request_failed', observedAt: '2026-11-19T08:31:00Z', requestId: 'exercise-image-1631',
};
const LEGACY: NotificationIncidentEvidence = {
  outcome: 'unknown', observedAt: '2026-11-19T07:48:00Z',
};

const STAGES = [
  { label: '额度耗尽', title: '上游额度耗尽，生图请求失败', icon: CircleX, color: 'var(--accent-fg-danger)',
    episode: 0, state: 'active', evidence: [FAILURE] },
  { label: '备用成功', title: '有请求失败，备用线路完成了后续生图', icon: Route, color: 'var(--accent-fg-warning)',
    episode: 0, state: 'active', evidence: [FAILURE, FALLBACK] },
  { label: '同线路恢复', title: '原线路已恢复，历史失败待核对', icon: CircleCheck, color: 'var(--accent-fg-success)',
    episode: 0, state: 'recovered', evidence: [FAILURE, FALLBACK, RECOVERY] },
  { label: '再次失败', title: '上游额度再次耗尽，生图请求失败', icon: CircleX, color: 'var(--accent-fg-danger)',
    episode: 1, state: 'active', evidence: [RECURRENCE] },
  { label: '旧告警缺证据', title: '历史额度告警，请求结果待核实', icon: CircleHelp, color: 'var(--text-secondary)',
    episode: 0, state: 'unknown', evidence: [LEGACY] },
] as const;

type ExerciseActions = { claimed?: boolean; confirmed?: boolean };

export default function NotificationHandoffExercise() {
  const [stageIndex, setStageIndex] = useState(1);
  const [actions, setActions] = useState<Record<string, ExerciseActions>>({});
  const stage = STAGES[stageIndex];
  const caseId = stage.state === 'unknown' ? 'exercise-legacy-quota' : 'exercise-image-quota';
  const actionKey = `${caseId}:${stage.episode}`;
  const currentActions = actions[actionKey];
  const updateActions = (update: ExerciseActions) => setActions(previous => ({
    ...previous, [actionKey]: { ...previous[actionKey], ...update },
  }));
  const item: AdminNotificationItem = {
    id: caseId, incidentId: caseId, title: stage.title, targetUserId: 'exercise',
    sourceLabel: '图片创作 · 演练数据', environment: stage.state === 'unknown' ? '待确认' : '演练', incidentCategory: 'quota',
    incidentState: stage.state, level: stage.state === 'recovered' ? 'success' : 'error',
    status: stage.state === 'recovered' ? 'closed' : currentActions?.confirmed ? 'handled' : 'open',
    createdAt: stage.evidence[0].observedAt,
    updatedAt: stage.evidence[stage.evidence.length - 1].observedAt,
  };
  const followUp: NotificationIncidentFollowUp = {
    episode: stage.episode, isRecurrence: stage.episode === 1, canAssign: stage.state === 'active', evidence: [...stage.evidence],
    owner: currentActions?.claimed ? { isMe: true } : null,
  };

  return <main className="min-h-screen bg-[var(--bg-base)] text-token-primary">
    <div className="mx-auto max-w-[1000px] px-4 pb-10 pt-5 sm:px-8 sm:pt-8">
      <a href="/notifications?view=incidents" className="inline-flex min-h-9 items-center gap-2 text-sm text-token-secondary hover-text-primary">
        <ArrowLeft size={16} aria-hidden="true" />返回真实故障
      </a>
      <header className="mb-5 mt-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-[30px]">故障接力演练</h1>
        <p className="mt-1 text-sm text-token-secondary">演练数据 · 操作仅在此页生效</p>
      </header>
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <section aria-label="模拟进展" className="min-w-0 rounded-xl border border-token-subtle bg-token-card p-3 sm:p-4">
          <h2 className="mb-2 text-sm font-semibold text-token-primary">模拟进展</h2>
          <div className="grid grid-cols-2 gap-1.5 md:grid-cols-1">
            {STAGES.map(({ label, icon: Icon, color }, index) => <button key={label} type="button"
              aria-pressed={stageIndex === index} onClick={() => setStageIndex(index)}
              className="inline-flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-token-subtle px-2.5 py-1.5 text-left text-sm hover-bg-soft"
              style={stageIndex === index ? { background: 'var(--bg-card-hover)', borderColor: 'var(--accent-fg-blue)' } : undefined}>
              <Icon size={16} aria-hidden="true" className="shrink-0" style={{ color }} />{label}
            </button>)}
          </div>
        </section>
        <section aria-label="样例故障详情" className="min-w-0 rounded-xl border border-token-subtle bg-token-card p-4 sm:p-5">
          <NotificationIncidentCard key={stageIndex} item={item} followUp={followUp} busy={false}
            assign={claimed => updateActions({ claimed })} confirm={() => updateActions({ confirmed: true })}
            nextStep={stage.state === 'active' ? '核对上游账户额度，再观察同一线路的恢复证据。' : undefined} />
        </section>
      </div>
    </div>
  </main>;
}
