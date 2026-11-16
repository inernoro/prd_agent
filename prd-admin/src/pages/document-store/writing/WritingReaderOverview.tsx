import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { WritingPublication, WritingSection } from '@/services/contracts/writing';

/** v14 reader: conclusions, scope, then every role's action and condition. */
export function WritingReaderOverview({ publication: doc, type, role, onRole, onGo, onSources, readingSections, bodyPending, learningHref, duration, onIntent }: {
  publication: WritingPublication;
  type?: string;
  role: string;
  onRole: (label: string) => void;
  onGo: (id: string) => void;
  onSources: () => void;
  onIntent?: (paragraphId: string) => void;
  readingSections: WritingSection[];
  bodyPending: boolean;
  learningHref: string;
  duration: number;
}) {
  const active = doc.roles.find(r => r.label === role) ?? doc.roles[0];
  const roles = active ? [active, ...doc.roles.filter(r => r !== active)] : [];
  const readCount = doc.sources.filter(s => s.status === 'read').length;
  const scope = <div className="writing-scope-grid"><div className="writing-scope-in"><span className="cap">适用</span><div>{doc.scopeIn || '原文未单独说明，请结合正文判断。'}</div></div><div className="writing-scope-out"><span className="cap">不适用</span><div>{doc.scopeOut || '原文未单独说明。'}</div></div></div>;
  return <div data-section="top" className="writing-reader-overview">
    <div className="writing-reader-meta"><span className="tag t-l">{type ?? '文档'}</span><span className="mono">v{doc.version} · {doc.authorName} · {doc.reviewerName} 审核 · {new Date(doc.publishedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }).replace('/', '-')}</span>
      {doc.sources.length > 0 && <button className="writing-source-shortcut" onClick={onSources}>来源{readCount > 0 ? ` · ${readCount} 份` : '记录'}<ChevronRight size={12} /></button>}
    </div>
    <h1 className="writing-reader-title" tabIndex={-1}>{doc.title}</h1>
    <WritingTakeaways publication={doc} disabled={bodyPending} onLocate={onIntent} />
    {scope}
    {active && <>
      <section className="writing-actions-panel writing-focused-actions" aria-label="角色行动">
        <div className="writing-role-heading"><strong><span className="writing-next-desktop">下一步</span><span className="writing-next-mobile">下一步 · 我是</span></strong>{doc.roles.length > 1 ? <div role="radiogroup" aria-label="我是"><span className="hint">我是</span>{doc.roles.map(r => <button className="role" role="radio" aria-checked={r === active} onClick={() => onRole(r.label)} key={r.label}>{r.label}</button>)}</div> : <span className="writing-current-role">{active.label}</span>}</div>
        {roles.map(r => <div className={`act${r === active ? ' on' : ''}`} key={r.label}>
          <span className="who">{r.label}</span>
          <div><div className="what">{r.action}</div>{r.condition && <div className="cond"><span className="tag t-c">条件</span><span>{r.condition}</span></div>}</div>
          <button className="btn ghost sm" disabled={bodyPending} onClick={() => onGo(r.sectionId)}><span>{String(doc.sections.findIndex(s => s.id === r.sectionId) + 1).padStart(2, '0')}</span><span>{doc.sections.find(s => s.id === r.sectionId)?.title}</span></button>
        </div>)}
      </section>
      <nav className="writing-reading-order" aria-label={`${active.label}的阅读顺序`}><span className="hint">{active.label}建议按这个顺序读</span>{readingSections.map((s, i) => <button className="ord" disabled={bodyPending} onClick={() => onGo(s.id)} key={s.id}><span className="n">{i + 1}</span><span>{s.title}</span></button>)}<Link className="btn ghost sm" to={learningHref}>{duration >= 60 ? `或看 ${Math.floor(duration / 60)} 分钟教学` : '开始学习'}</Link></nav>
    </>}
  </div>;
}

/** 同一呈现用于作者预览和接收者首屏，作者原句不会被再次压缩。 */
export function WritingTakeaways({ publication: doc, disabled = false, onLocate, preview = false }: {
  publication: Pick<WritingPublication, 'intentPoints' | 'intentCoverage' | 'conclusions' | 'summary' | 'sections'>;
  disabled?: boolean; onLocate?: (paragraphId: string) => void; preview?: boolean;
}) {
  const points = doc.intentPoints?.map((text, index) => ({ text, index })).filter(p => p.text.trim()) ?? [];
  const title = points.length ? '作者要点' : '结论';
  return <section className="writing-reader-takeaways" aria-label={points.length ? '作者要点' : '文档结论'}>
    {preview ? <div className="cap writing-review-conclusion-label">{title}</div> : <h2>{title}</h2>}
    {points.length ? <><ol className="writing-conclusions">{points.map(point => {
      const target = doc.intentCoverage?.find(c => c.intentIndex === point.index)?.paragraphIds[0];
      return <li key={point.index}><span>{point.text}</span>{target && onLocate && <button className="btn ghost sm writing-intent-location" disabled={disabled} onClick={() => onLocate(target)}>查看正文</button>}</li>;
    })}</ol>{(doc.conclusions.some(Boolean) || doc.summary) && <details className="writing-full-conclusions"><summary>完整结论</summary>{doc.conclusions.some(Boolean) ? <ol>{doc.conclusions.filter(Boolean).map((text, i) => <li key={i}>{text}</li>)}</ol> : <p>{doc.summary}</p>}</details>}</>
      : doc.conclusions.some(Boolean) ? <ol className="writing-conclusions">{doc.conclusions.filter(Boolean).map((text, i) => <li key={i}>{text}</li>)}</ol> : <p>{doc.summary || '正文开头：' + (doc.sections[0]?.paragraphs[0]?.text.slice(0, 60) ?? '')}</p>}
  </section>;
}
