import { Check, MapPin, X } from 'lucide-react';
import { DECISION_REGISTRY, SEVERITY_REGISTRY } from './registry';
import type { Decision, Finding, PracticeSkill } from './types';

/* 一条 Agent 意见：证据在前，建议在后；学员逐条决定，驳回必须写理由（可点常用理由一键填入）。 */
export function FindingCard({ index, finding, skill, decision, reason, feedback, selected, locked, onSelect, onDecide, onReason }: {
  index: number;
  finding: Finding;
  skill: PracticeSkill;
  decision?: Decision;
  reason?: string;
  feedback?: string;
  selected: boolean;
  locked: boolean;
  onSelect: () => void;
  onDecide: (d: Decision) => void;
  onReason: (text: string) => void;
}) {
  const sev = SEVERITY_REGISTRY[finding.severity];
  const words = DECISION_REGISTRY[skill];
  const where = finding.location.file ? `${finding.location.file}:${finding.location.line}` : '截图上的标注区域';
  return (
    <article className="lc-finding lc-finding-enter flex flex-col gap-2.5" data-selected={selected} data-lc="finding" data-finding={finding.id}>
      <header className="flex items-start gap-2">
        <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-[6px] shrink-0 mt-0.5" style={{ color: sev.color, border: '1.5px solid currentColor' }}>{index}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-semibold leading-snug">{finding.title}</div>
          <div className="flex items-center gap-x-2 flex-wrap mt-1 text-[11.5px]">
            <span className="font-semibold whitespace-nowrap" style={{ color: sev.color }}>{sev.label}</span>
            <button type="button" className="inline-flex items-center gap-1 lc-muted lc-mono hover:underline min-h-[28px]" onClick={onSelect} data-qc-touch-exempt><MapPin size={11} />{where}</button>
          </div>
        </div>
      </header>
      <div className="text-[12.5px] leading-relaxed lc-secondary"><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>证据：</span>{finding.evidence}</div>
      <div className="text-[12.5px] leading-relaxed lc-secondary"><span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Agent 建议：</span>{finding.suggestion}</div>
      {feedback && (
        <div className="text-[12.5px] leading-relaxed lc-nested px-3 py-2" style={{ borderLeft: '3px solid var(--accent-fg-warning)' }} data-lc="finding-feedback">
          <span className="font-semibold" style={{ color: 'var(--accent-fg-warning)' }}>复测反馈：</span>{feedback}
        </div>
      )}
      <div className="flex gap-2" role="group" aria-label={`第 ${index} 条的判断`}>
        <button type="button" className="lc-choice" data-kind="accept" aria-pressed={decision === 'accept'} disabled={locked} onClick={() => onDecide('accept')} data-lc="decide-accept"><Check size={14} />{words.accept}</button>
        <button type="button" className="lc-choice" data-kind="reject" aria-pressed={decision === 'reject'} disabled={locked} onClick={() => onDecide('reject')} data-lc="decide-reject"><X size={14} />{words.reject}</button>
      </div>
      {decision === 'reject' && (
        <div className="flex flex-col gap-2">
          <input className="lc-input" placeholder="写一句理由，复测时会核对它" value={reason ?? ''} disabled={locked} onChange={e => onReason(e.target.value)} data-lc="reject-reason" />
          {!locked && (
            <div className="flex gap-2 flex-wrap">
              {words.quickReasons.map(q => <button key={q} type="button" className="lc-chip-btn" onClick={() => onReason(q)}>{q}</button>)}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
