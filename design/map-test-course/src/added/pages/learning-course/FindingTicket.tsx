import { Check, X } from 'lucide-react';
import { DECISION_REGISTRY, SEVERITY_REGISTRY } from './registry';
import type { Decision, Finding, PracticeSkill } from './types';

/* 一条意见：证据在前、建议在后；学员决定采纳或驳回，驳回要写理由（常用理由一键填入）。 */
export function FindingTicket({ index, finding, skill, decision, reason, feedback, selected, locked, onSelect, onDecide, onReason }: {
  index: number; finding: Finding; skill: PracticeSkill; decision?: Decision; reason?: string; feedback?: string;
  selected: boolean; locked: boolean; onSelect: () => void; onDecide: (d: Decision) => void; onReason: (t: string) => void;
}) {
  const sev = SEVERITY_REGISTRY[finding.severity];
  const words = DECISION_REGISTRY[skill];
  const where = finding.location.file ? `${finding.location.file.split('/').pop()}:${finding.location.line}` : '截图标注区';
  return (
    <article className="lc-work flex flex-col gap-3" data-selected={selected} data-lc="finding" data-finding={finding.id}>
      <header className="flex items-baseline gap-3 t-meta">
        <span className="lc-num t-mute">{index}</span>
        <span className="lc-sev" style={{ color: sev.color }}>{sev.label}</span>
        <button type="button" className="lc-mono t-mute hover:underline" onClick={onSelect} data-qc-touch-exempt>{where}</button>
        {decision && <span className="ml-auto t-strong" style={{ color: decision === 'accept' ? 'var(--pass)' : 'var(--warn)' }}>{decision === 'accept' ? '已采纳' : '已驳回'}</span>}
      </header>
      <h3 className="lc-work-title t-strong">{finding.title}</h3>
      <p className="t-mute">{finding.evidence}</p>
      <p><span className="t-mute">建议：</span>{finding.suggestion}</p>
      {feedback && <p className="pl-3" style={{ borderLeft: '2px solid var(--warn)' }} data-lc="finding-feedback"><span style={{ color: 'var(--warn)' }}>复测看到：</span>{feedback}</p>}
      <div className="lc-choice-row" role="group" aria-label={`第 ${index} 条的判断`}>
        <button type="button" className="lc-choice" data-kind="accept" aria-pressed={decision === 'accept'} disabled={locked} onClick={() => onDecide('accept')} data-lc="decide-accept"><Check size={15} />{words.accept}</button>
        <button type="button" className="lc-choice" data-kind="reject" aria-pressed={decision === 'reject'} disabled={locked} onClick={() => onDecide('reject')} data-lc="decide-reject"><X size={15} />{words.reject}</button>
      </div>
      {decision === 'reject' && (
        <div className="flex flex-col gap-2">
          <input className="lc-input" placeholder="写一句理由，复测时会核对它" value={reason ?? ''} disabled={locked} onChange={e => onReason(e.target.value)} data-lc="reject-reason" />
          {!locked && <div className="flex gap-2 flex-wrap">{words.quickReasons.map(q => <button key={q} type="button" className="lc-reason-chip" onClick={() => onReason(q)}>{q}</button>)}</div>}
        </div>
      )}
    </article>
  );
}
