/**
 * 内部版本「立项详情」— Agent 评审记录 + 线下评审会稿次回填。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { updateInitiationMeeting } from '@/services/real/productAgent';
import { getSubmission } from '@/services/real/reviewAgent';
import type { ReviewDimensionScore } from '@/services/real/reviewAgent';
import type { InitiationMeetingDraftRound, InitiationReviewAttempt, ProductInitiation } from './types';
import { WorkflowDetailCard } from './workflowDetailUi';
import {
  fromDatetimeLocalValue,
  meetingDraftLabel,
  normalizeMeetingRounds,
  toDatetimeLocalValue,
} from './initiationWorkflowUtils';

function fmtTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function AttemptBadge({ passed }: { passed?: boolean | null }) {
  if (passed == null) return <span className="text-white/40">待定</span>;
  return passed
    ? <span className="text-emerald-300">通过</span>
    : <span className="text-rose-300">未通过</span>;
}

function ReviewAttemptsSection({ attempts }: { attempts: InitiationReviewAttempt[] }) {
  const sorted = [...attempts].sort((a, b) => a.attemptNo - b.attemptNo);
  if (sorted.length === 0) {
    return <p className="text-sm text-white/35">尚未执行 Agent 评审</p>;
  }
  return (
    <div className="space-y-2">
      {sorted.map((a) => (
        <div key={a.id} className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-white/80">第 {a.attemptNo} 次评审</span>
            <AttemptBadge passed={a.reviewPassed} />
          </div>
          <div className="mt-1 grid gap-1 text-xs text-white/45 sm:grid-cols-2">
            <span>方案文件：{a.planFileName || '—'}</span>
            <span>得分：{a.reviewScore != null ? `${a.reviewScore}/100` : '—'}</span>
            <span>开始：{fmtTime(a.startedAt)}</span>
            <span>完成：{fmtTime(a.completedAt)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function DimensionList({ scores }: { scores: ReviewDimensionScore[] }) {
  if (scores.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-medium text-white/45">分项评分（最近一次）</p>
      {scores.map((dim) => (
        <div key={dim.key} className="flex items-center justify-between rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 text-sm">
          <span className="text-white/75">{dim.name}</span>
          <span className="tabular-nums text-cyan-200">{dim.score}/{dim.maxScore}</span>
        </div>
      ))}
    </div>
  );
}

function MeetingRoundsEditor({
  initiation,
  editable,
  onSaved,
}: {
  initiation: ProductInitiation;
  editable: boolean;
  onSaved: (next: ProductInitiation) => void;
}) {
  const [rounds, setRounds] = useState<InitiationMeetingDraftRound[]>(() => normalizeMeetingRounds(initiation));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRounds(normalizeMeetingRounds(initiation));
  }, [initiation]);

  const updateRound = (round: number, patch: Partial<InitiationMeetingDraftRound>) => {
    setRounds((prev) => prev.map((r) => (r.round === round ? { ...r, ...patch } : r)));
  };

  const save = async () => {
    setBusy(true);
    const payload = rounds.map((r) => ({
      round: r.round,
      heldAt: r.heldAt ?? undefined,
      passed: r.passed ?? undefined,
      notes: r.notes?.trim() || undefined,
    }));
    const res = await updateInitiationMeeting(initiation.id, { rounds: payload });
    setBusy(false);
    if (!res.success) {
      toast.error('保存失败', res.error?.message);
      return;
    }
    toast.success('已保存会议结果');
    onSaved(res.data);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-white/40">
        预计评审会：{fmtTime(initiation.expectedMeetingAt)}
        {initiation.meetingDraftCount ? ` · 共 ${initiation.meetingDraftCount} 稿` : ''}
      </p>
      {rounds.map((r) => (
        <div key={r.round} className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2">
          <div className="text-sm font-medium text-white/80">{meetingDraftLabel(r.round)}</div>
          <label className="block text-xs text-white/45">
            会议时间
            <input
              type="datetime-local"
              disabled={!editable}
              value={toDatetimeLocalValue(r.heldAt)}
              onChange={(e) => updateRound(r.round, { heldAt: fromDatetimeLocalValue(e.target.value) ?? null })}
              className="mt-1 w-full max-w-xs rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-sm text-white outline-none focus:border-cyan-400/50 disabled:opacity-50"
            />
          </label>
          <label className="block text-xs text-white/45">
            是否通过
            <select
              disabled={!editable}
              value={r.passed == null ? '' : r.passed ? 'yes' : 'no'}
              onChange={(e) => {
                const v = e.target.value;
                updateRound(r.round, { passed: v === '' ? null : v === 'yes' });
              }}
              className="mt-1 w-full max-w-xs rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-sm text-white outline-none focus:border-cyan-400/50 disabled:opacity-50"
            >
              <option value="">待回填</option>
              <option value="yes">通过</option>
              <option value="no">未通过</option>
            </select>
          </label>
          <label className="block text-xs text-white/45">
            会议记录
            <textarea
              disabled={!editable}
              value={r.notes ?? ''}
              onChange={(e) => updateRound(r.round, { notes: e.target.value })}
              rows={2}
              placeholder="纪要、决议、待办等（选填）"
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/20 px-2.5 py-1.5 text-sm text-white outline-none focus:border-cyan-400/50 disabled:opacity-50"
            />
          </label>
        </div>
      ))}
      {editable && (
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/15 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/25 disabled:opacity-50"
        >
          {busy ? <MapSpinner size={14} /> : null}
          保存会议结果
        </button>
      )}
    </div>
  );
}

export function InitiationWorkflowPanel({
  initiation,
  editableMeeting,
  onInitiationChange,
}: {
  initiation: ProductInitiation;
  editableMeeting: boolean;
  onInitiationChange: (next: ProductInitiation) => void;
}) {
  const [loadingReview, setLoadingReview] = useState(false);
  const [dimensionScores, setDimensionScores] = useState<ReviewDimensionScore[]>([]);
  const [latestScore, setLatestScore] = useState<number | null>(initiation.reviewScore ?? null);
  const [latestPassed, setLatestPassed] = useState<boolean | null>(initiation.reviewPassed ?? null);

  const attempts = useMemo(() => initiation.reviewAttempts ?? [], [initiation.reviewAttempts]);
  const submissionId = initiation.reviewSubmissionId;

  const loadLatestReview = useCallback(async () => {
    if (!submissionId) {
      setDimensionScores([]);
      return;
    }
    setLoadingReview(true);
    const res = await getSubmission(submissionId);
    setLoadingReview(false);
    if (!res.success) return;
    if (res.data.result?.dimensionScores) {
      setDimensionScores(res.data.result.dimensionScores);
    }
    if (res.data.result?.totalScore != null) setLatestScore(res.data.result.totalScore);
    if (res.data.result?.isPassed != null) setLatestPassed(res.data.result.isPassed);
    else if (res.data.submission.isPassed != null) setLatestPassed(res.data.submission.isPassed);
  }, [submissionId]);

  useEffect(() => {
    void loadLatestReview();
  }, [loadLatestReview]);

  return (
    <div className="flex flex-col gap-4">
      <WorkflowDetailCard title="Agent 评审">
        {loadingReview && (
          <div className="mb-2 flex items-center gap-2 text-xs text-white/40">
            <Loader2 size={14} className="animate-spin" /> 正在加载评审详情…
          </div>
        )}
        {latestScore != null && (
          <div className={`mb-3 rounded-lg border px-3 py-2 text-sm ${latestPassed ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200' : 'border-rose-400/30 bg-rose-400/10 text-rose-200'}`}>
            最近一次得分 {latestScore}/100 · {latestPassed ? '通过' : '未通过'}
          </div>
        )}
        <ReviewAttemptsSection attempts={attempts} />
        <DimensionList scores={dimensionScores} />
      </WorkflowDetailCard>

      <WorkflowDetailCard title="线下评审会">
        {initiation.reviewMeetingRequired ? (
          <MeetingRoundsEditor
            initiation={initiation}
            editable={editableMeeting}
            onSaved={onInitiationChange}
          />
        ) : (
          <p className="text-sm text-white/35">
            立项决策时选择「不需要开评审会」，无线下会议稿次需回填。
            {initiation.primaryOwnerId ? ' 已走负责人审批流程。' : ''}
          </p>
        )}
      </WorkflowDetailCard>
    </div>
  );
}
