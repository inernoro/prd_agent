import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Award } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { toast } from '@/lib/toast';
import { evaluatePmProject } from '@/services';
import type { PmStakeholder, PmEvaluation } from '@/services/contracts/pmAgent';
import { STAKEHOLDER_ROLE_REGISTRY, GRADE_REGISTRY, NPSS_GLOBAL_BASELINE } from './pmConstants';

interface Props {
  projectId: string;
  stakeholders: PmStakeholder[];
  existing?: PmEvaluation | null;
  onClose: () => void;
  onEvaluated: (evaluation: PmEvaluation) => void;
}

/**
 * 结案评价（NPSS）面板。
 * 干系人 0-10 打分 → 后端加权（受益方权重 2×）计算满意度 + 等级。
 */
export function EvaluatePanel({ projectId, stakeholders, existing, onClose, onEvaluated }: Props) {
  const [scores, setScores] = useState<Record<string, number>>(() => {
    const init: Record<string, number> = {};
    for (const s of stakeholders) if (s.score != null) init[s.id] = s.score;
    return init;
  });
  const [result, setResult] = useState<PmEvaluation | null>(existing ?? null);
  const [saving, setSaving] = useState(false);

  // 本地预估满意度（与后端同算法，给即时反馈）
  const preview = useMemo(() => {
    const scored = stakeholders.filter((s) => scores[s.id] != null);
    if (scored.length === 0) return null;
    const byRole: Record<string, number[]> = {};
    for (const s of scored) (byRole[s.role] ||= []).push(scores[s.id]);
    const weights: Record<string, number> = { beneficiary: 0.5, management: 0.2, team: 0.2, other: 0.1 };
    const present = Object.keys(byRole);
    const wsum = present.reduce((a, r) => a + (weights[r] ?? 0.1), 0) || 1;
    const w10 = present.reduce((a, r) => {
      const avg = byRole[r].reduce((x, y) => x + y, 0) / byRole[r].length;
      return a + avg * ((weights[r] ?? 0.1) / wsum);
    }, 0);
    return Math.round(w10 * 10 * 10) / 10;
  }, [scores, stakeholders]);

  const submit = async () => {
    if (Object.keys(scores).length === 0) { toast.warning('请打分', '至少一位干系人打分'); return; }
    setSaving(true);
    const res = await evaluatePmProject(projectId, scores);
    setSaving(false);
    if (res.success) { setResult(res.data.evaluation); toast.success('评价完成', ''); onEvaluated(res.data.evaluation); }
    else toast.error('评价失败', res.error?.message || '');
  };

  const grade = result ? GRADE_REGISTRY[result.grade] : null;

  const modal = (
    <div className="surface-backdrop fixed inset-0 z-[100] flex items-center justify-center p-4" onClick={onClose}>
      <div className="rounded-xl border flex flex-col w-full" style={{ maxWidth: 560, maxHeight: '88vh', background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 px-5 py-4 shrink-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
          <Award size={17} style={{ color: '#10B981' }} />
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>结案评价 · NPSS</div>
          <button onClick={onClose} className="ml-auto p-1 rounded hover:opacity-70" style={{ color: 'var(--text-muted)' }}><X size={18} /></button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3" style={{ minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
          <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
            打分核心标准：这个项目交付的价值，是否值得投入的时间和成本？（0-10 分，受益方权重为其他 2 倍）
          </div>

          {stakeholders.map((s) => {
            const roleMeta = STAKEHOLDER_ROLE_REGISTRY[s.role];
            const v = scores[s.id];
            return (
              <div key={s.id} className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-base)' }}>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>{s.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: `${roleMeta.color}22`, color: roleMeta.color }}>{roleMeta.label} {roleMeta.weightLabel}</span>
                  <span className="text-[13px] font-mono ml-auto" style={{ color: v != null ? '#10B981' : 'var(--text-muted)' }}>{v != null ? v : '—'}</span>
                </div>
                <input
                  type="range" min={0} max={10} step={1}
                  value={v ?? 0}
                  onChange={(e) => setScores((prev) => ({ ...prev, [s.id]: Number(e.target.value) }))}
                  className="w-full mt-2"
                  style={{ accentColor: '#10B981' }}
                />
              </div>
            );
          })}

          {/* 结果 / 预估 */}
          {result ? (
            <div className="rounded-lg border p-4 text-center" style={{ borderColor: grade!.color, background: `${grade!.color}12` }}>
              <div className="text-[30px] font-bold" style={{ color: grade!.color }}>{result.satisfactionScore}</div>
              <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>干系人满意度（/100）</div>
              <div className="text-[15px] font-semibold mt-2" style={{ color: grade!.color }}>{grade!.label}</div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>{grade!.desc}</div>
            </div>
          ) : preview != null ? (
            <div className="rounded-lg p-3 text-center" style={{ background: 'var(--bg-base)' }}>
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>预估满意度：</span>
              <span className="text-[16px] font-bold" style={{ color: 'var(--text-primary)' }}>{preview}</span>
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}> / 100</span>
            </div>
          ) : null}

          <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
            NPSS = 成功项目占比 − 失败项目占比（组织级，全球基线 {NPSS_GLOBAL_BASELINE}）。本面板计算单项目满意度与等级。
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3.5 shrink-0 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button variant="primary" onClick={submit} disabled={saving}>{saving ? <MapSpinner size={14} /> : <Award size={14} />}{result ? '重新评价' : '提交评价'}</Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
