import { useId, useState } from 'react';
import { Check, Copy, Sparkles } from 'lucide-react';
import type { PlanningBriefCitation, PlanningDebtBrief } from '../../../../src/shared/engineering-planning';

function citationKey(cite: PlanningBriefCitation) {
  return cite.kind === 'record' ? `${cite.kind}:${cite.id}:${cite.target}` : `${cite.kind}:${cite.id}`;
}

export function DebtHandoffCard({ brief, onCitation }: { brief: PlanningDebtBrief; onCitation: (cite: PlanningBriefCitation) => void }) {
  const [expanded, setExpanded] = useState(true);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'manual'>('idle');
  const contentId = useId();
  const numbers = new Map<string, number>();
  for (const section of brief.sections) for (const line of section.lines) for (const cite of line.cites) {
    const key = citationKey(cite);
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
  }

  async function copyBrief() {
    try {
      await navigator.clipboard.writeText(brief.markdown);
      setCopy('copied');
    } catch {
      setCopy('manual');
    }
  }

  return <section className="ep-brief" aria-label="接手卡">
    <div className="ep-brief-brand"><Sparkles aria-hidden="true" />CDS 助手</div>
    <h2>接手卡</h2>
    <p className="ep-caption">从当前记录和历史整理，点击出处可核对原文。</p>
    <div className="ep-brief-tools">
      <details className="ep-brief-readiness">
        <summary><strong>{brief.readiness.score}/{brief.readiness.max}</strong> 接手就绪度</summary>
        <ul>{brief.readiness.items.map(item => <li key={item.label}>
          {item.ok ? <Check aria-hidden="true" /> : null}<span>{item.ok ? '已具备' : '缺少'} · {item.label}</span>
        </li>)}</ul>
      </details>
      <button type="button" className="ep-button" onClick={() => { void copyBrief(); }}><Copy aria-hidden="true" />复制给智能体</button>
      <button type="button" className="ep-button ep-brief-toggle" aria-expanded={expanded} aria-controls={contentId}
        onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : '展开'}接手卡</button>
    </div>
    {copy === 'copied' && <p className="ep-caption" role="status">已复制接手卡</p>}
    {copy === 'manual' && <label className="ep-field"><span>请选择并复制接手卡内容</span>
      <textarea readOnly value={brief.markdown} onFocus={event => event.currentTarget.select()} />
    </label>}
    <div id={contentId} className="ep-brief-body" hidden={!expanded}>
      {brief.sections.map(section => <section key={section.id}>
        <h3>{section.title}</h3>
        <ul>{section.lines.map((line, index) => <li key={index}>
          {line.kind !== 'fact' && <span className="ep-brief-label" data-kind={line.kind}>{line.kind === 'inference' ? '推测' : '缺口'}</span>}
          {line.text}{line.cites.map(cite => {
            const key = citationKey(cite);
            const number = numbers.get(key);
            return <button type="button" className="ep-citation" key={key} title={cite.label}
              aria-label={`查看出处 ${number} · ${cite.label}`} onClick={() => onCitation(cite)}>{number}</button>;
          })}
        </li>)}</ul>
      </section>)}
      {(brief.next.length > 0 || brief.gaps.length > 0) && <section className="ep-brief-next">
        {brief.next.length > 0 && <><h3>建议的下一步</h3>
          <ol>{brief.next.map(line => <li key={line}>{line}</li>)}</ol></>}
        {brief.gaps.length > 0 && <p className="ep-caption">记录里还缺 {brief.gaps.join('、')}</p>}
      </section>}
    </div>
  </section>;
}
