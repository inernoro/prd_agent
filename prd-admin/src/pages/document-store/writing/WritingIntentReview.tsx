import type { WritingState } from '@/services/contracts/writing';

export function WritingIntentReview({ state, locked, busy, dirty, onConfirm, onLocate, onReconcile }: {
  state: WritingState; locked: boolean; busy: boolean; dirty: boolean;
  onConfirm: (index: number) => Promise<void>; onLocate?: (paragraphId: string) => void; onReconcile?: () => Promise<void>;
}) {
  if (!state.intentPoints?.length) return null;
  const confirmed = state.intentPoints.filter((_, index) => state.intentCoverage?.find(c => c.intentIndex === index)?.confirmed).length;
  const paragraphs = state.sections.flatMap(s => s.paragraphs);
  return <section className="rv writing-intent-review"><h4>作者必达点 · 已核对 {confirmed} / {state.intentPoints.length}</h4>
    <p className="hint">系统建议承载位置，请核对原意、条件和例外；正文有变化时需要重新过目。</p>
    {state.intentPoints.map((point, index) => {
      const coverage = state.intentCoverage?.find(c => c.intentIndex === index);
      const targets = coverage?.paragraphIds.map(id => paragraphs.find(p => p.id === id)).filter(p => !!p) ?? [];
      const complete = coverage?.confirmed === true;
      return <div className="writing-intent-item" key={index}><strong>{index + 1}. {point}</strong>
        {targets.length ? targets.map(p => <div key={p.id}><p>{p.text}</p>{onLocate && <button className="btn ghost sm" onClick={() => onLocate(p.id)}>定位正文</button>}</div>) : <p className="hint">未定位到正文，请补充内容后重新整理。</p>}
        <label><input type="checkbox" checked={complete} disabled={locked || busy || dirty || !targets.length || complete}
          onChange={() => void onConfirm(index)} />已核对这一重点及其限制</label>
      </div>;
    })}
    {onReconcile && !locked && <button className="btn ghost sm" disabled={busy || dirty} onClick={() => void onReconcile()}>重新整理重点与读者表达</button>}
    {dirty && <p className="hint">请先保存修改，再确认必达点。</p>}
  </section>;
}
