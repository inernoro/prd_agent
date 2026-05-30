import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Award, Check, Clock, Play } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { useAuthStore } from '@/stores/authStore';
import { startPmEvaluation, submitPmScore, finalizePmEvaluation } from '@/services';
import type { PmProject } from '@/services/contracts/pmAgent';
import { STAKEHOLDER_ROLE_REGISTRY, GRADE_REGISTRY, NPSS_GLOBAL_BASELINE } from './pmConstants';

interface Props {
  project: PmProject;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * 结案评价（NPSS）—— 多人独立打分流程。
 * 立项人/Leader 发起 → 各干系人各自打分（互相不可见）→ 全部评完后汇总出加权满意度与等级。
 */
export function EvaluatePanel({ project, onClose, onChanged }: Props) {
  const me = useAuthStore((s) => s.user?.userId ?? '');
  const isOwner = project.ownerId === me || project.leaderId === me;
  const round = project.evaluationRound ?? null;
  const result = round?.status === 'finalized' ? round.result : (round ? null : project.evaluation);
  const collecting = round?.status === 'collecting';

  // 我可编辑的打分草稿（本人 / owner 代录外部）
  const [scores, setScores] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    round?.participants.forEach((p) => { if (p.score != null) init[p.stakeholderId] = p.score; });
    return init;
  });
  const [busy, setBusy] = useState(false);

  const scoredCount = round?.participants.filter((p) => p.score != null).length ?? 0;
  const total = round?.participants.length ?? 0;

  const canEdit = (p: { userId?: string | null }) =>
    !p.userId ? isOwner : p.userId === me;

  const grade = result ? GRADE_REGISTRY[result.grade] : null;

  const start = async () => {
    setBusy(true);
    const res = await startPmEvaluation(project.id);
    setBusy(false);
    if (res.success) { toast.success('已发起评价', '请各干系人打分'); onChanged(); }
    else toast.error('发起失败', res.error?.message || '');
  };
  const submit = async (stakeholderId: string) => {
    setBusy(true);
    const res = await submitPmScore(project.id, stakeholderId, scores[stakeholderId] ?? 0);
    setBusy(false);
    if (res.success) { toast.success('已提交评分', ''); onChanged(); }
    else toast.error('提交失败', res.error?.message || '');
  };
  const finalize = async () => {
    setBusy(true);
    const res = await finalizePmEvaluation(project.id);
    setBusy(false);
    if (res.success) { toast.success('已汇总', '评价完成'); onChanged(); }
    else toast.error('汇总失败', res.error?.message || '');
  };

  const myPending = useMemo(
    () => collecting && round!.participants.some((p) => canEdit(p) && p.score == null),
    [collecting, round], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 580, maxHeight: '88vh', background: 'var(--bg-elevated)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Award size={17} style={{ color: '#10B981' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>结案评价 · NPSS</div>
          {collecting && <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(245,158,11,0.15)', color: '#F59E0B' }}>收集中 {scoredCount}/{total}</span>}
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          {/* 已汇总：展示结果 */}
          {result && (
            <div className="rounded-lg border p-4 text-center" style={{ borderColor: grade!.color, background: `${grade!.color}12` }}>
              <div className="text-[30px] font-bold" style={{ color: grade!.color }}>{result.satisfactionScore}</div>
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>干系人满意度（/100）</div>
              <div className="text-[15px] font-semibold mt-2" style={{ color: grade!.color }}>{grade!.label}</div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>{grade!.desc}</div>
            </div>
          )}

          {/* 未发起 */}
          {!collecting && !result && (
            <div className="text-center py-6">
              <div className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>尚未发起结案评价</div>
              <div className="text-[12px] mt-1" style={{ color: 'var(--text-muted)' }}>
                {isOwner ? '点下方「发起评价」，系统将通知各干系人独立打分，全部评完后汇总。' : '请等待立项人发起评价。'}
              </div>
            </div>
          )}

          {/* 收集中：参评人列表 */}
          {collecting && (
            <>
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                打分标准：项目交付的价值是否值得投入的时间和成本？（0-10 分，受益方权重为其他 2 倍，分数互相不可见）
              </div>
              {round!.participants.map((p) => {
                const roleMeta = STAKEHOLDER_ROLE_REGISTRY[p.role];
                const editable = canEdit(p);
                const v = scores[p.stakeholderId];
                return (
                  <div key={p.stakeholderId} className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{p.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${roleMeta.color}22`, color: roleMeta.color }}>{roleMeta.label} {roleMeta.weightLabel}</span>
                      {p.isRepresentative && <span className="text-[10px]" style={{ color: '#F59E0B' }} title={p.note ?? ''}>代表{p.note ? `·${p.note}` : ''}</span>}
                      <span className="ml-auto text-[11px] inline-flex items-center gap-1" style={{ color: p.score != null ? '#10B981' : 'var(--text-muted)' }}>
                        {p.score != null ? <><Check size={12} />已评</> : <><Clock size={12} />待评</>}
                      </span>
                    </div>
                    {editable ? (
                      <div className="flex items-center gap-2 mt-2">
                        <input type="range" min={0} max={10} step={1} value={v ?? 0}
                          onChange={(e) => setScores((prev) => ({ ...prev, [p.stakeholderId]: Number(e.target.value) }))}
                          className="flex-1" style={{ accentColor: '#10B981' }} />
                        <span className="text-[13px] font-mono w-5 text-right" style={{ color: '#10B981' }}>{v ?? 0}</span>
                        <Button variant="secondary" size="xs" onClick={() => submit(p.stakeholderId)} disabled={busy}>{p.score != null ? '更新' : '提交'}</Button>
                      </div>
                    ) : (
                      <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>{p.score != null ? '该干系人已提交评分（互相不可见）' : '等待该干系人打分'}</div>
                    )}
                  </div>
                );
              })}
              {myPending && <div className="text-[11px]" style={{ color: '#10B981' }}>你有待提交的评分，请拖动滑块后点「提交」。</div>}
            </>
          )}

          <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
            NPSS = 成功项目占比 − 失败项目占比（组织级，全球基线 {NPSS_GLOBAL_BASELINE}）。本面板按角色加权计算单项目满意度与等级。
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          {!collecting && isOwner && (
            <Button variant="primary" onClick={start} disabled={busy || project.stakeholders.length === 0}>
              {busy ? <MapSpinner size={14} /> : <Play size={14} />}{result ? '重新发起评价' : '发起评价'}
            </Button>
          )}
          {collecting && isOwner && (
            <Button variant="primary" onClick={finalize} disabled={busy || scoredCount < total}>
              {busy ? <MapSpinner size={14} /> : <Award size={14} />}汇总（{scoredCount}/{total}）
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
