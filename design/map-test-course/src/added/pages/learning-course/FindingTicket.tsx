import { Check, MapPin, X } from 'lucide-react';
import { DECISION_REGISTRY, SEVERITY_REGISTRY } from './registry';
import type { Decision, Finding, PracticeSkill } from './types';

/* 一张工单：证据在前、建议在后；学员盖「采纳」或「驳回」章，驳回要写理由（常用理由一键填入）。 */
export function FindingTicket({ index, finding, skill, decision, reason, feedback, selected, locked, onSelect, onDecide, onReason }: {
  index: number; finding: Finding; skill: PracticeSkill; decision?: Decision; reason?: string; feedback?: string;
  selected: boolean; locked: boolean; onSelect: () => void; onDecide: (d: Decision) => void; onReason: (t: string) => void;
}) {
  const sev = SEVERITY_REGISTRY[finding.severity];
  const words = DECISION_REGISTRY[skill];
  const where = finding.location.file ? `${finding.location.file.split('/').pop()}:${finding.location.line}` : '截图标注区';
  return (
    <article className="lc-work flex flex-col gap-2.5" data-selected={selected} data-lc="finding" data-finding={finding.id}>
      {decision && (
        <span className="lc-stamp" key={decision} style={{ color: decision === 'accept' ? 'var(--lc-pass)' : 'var(--lc-warn)' }}>{decision === 'accept' ? words.accept.slice(0, 2) : words.reject.slice(0, 2)}</span>
      )}
      <header className="flex items-center gap-2 pr-16">
        <span className="lc-mono text-[11px] lc-ink3">#{index}</span>
        <span className="lc-sev" style={{ background: sev.color }}>{finding.severity}</span>
        <button type="button" className="inline-flex items-center gap-1 lc-mono text-[11.5px] lc-ink3 hover:underline min-h-[28px]" onClick={onSelect} data-qc-touch-exempt><MapPin size={11} />{where}</button>
      </header>
      <h3 className="text-[14px] font-semibold leading-snug">{finding.title}</h3>
      <dl className="grid gap-x-3 gap-y-1.5 text-[12.5px] leading-relaxed" style={{ gridTemplateColumns: '40px 1fr' }}>
        <dt className="lc-kicker pt-0.5">证据</dt><dd className="lc-ink2">{finding.evidence}</dd>
        <dt className="lc-kicker pt-0.5">建议</dt><dd className="lc-ink2">{finding.suggestion}</dd>
      </dl>
      {feedback && (
        <div className="text-[12.5px] leading-relaxed px-3 py-2 rounded-[10px]" style={{ background: 'color-mix(in srgb, var(--lc-warn) 10%, transparent)' }} data-lc="finding-feedback">
          <b style={{ color: 'var(--lc-warn)' }}>复测看到：</b>{feedback}
        </div>
      )}
      <div className="lc-stamp-row" role="group" aria-label={`第 ${index} 条的判断`}>
        <button type="button" className="lc-stamp-btn" data-kind="accept" aria-pressed={decision === 'accept'} disabled={locked} onClick={() => onDecide('accept')} data-lc="decide-accept"><Check size={15} />{words.accept}</button>
        <button type="button" className="lc-stamp-btn" data-kind="reject" aria-pressed={decision === 'reject'} disabled={locked} onClick={() => onDecide('reject')} data-lc="decide-reject"><X size={15} />{words.reject}</button>
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
