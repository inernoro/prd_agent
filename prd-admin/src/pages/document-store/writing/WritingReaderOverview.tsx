import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { WritingPublication, WritingSection } from '@/services/contracts/writing';

/** Published facts stay verbatim; only the reader's current task changes. */
export function WritingReaderOverview({ publication: doc, type, role, onRole, onGo, onSources, readingSections, bodyPending, learningHref, duration }: {
  publication: WritingPublication;
  type?: string;
  role: string;
  onRole: (label: string) => void;
  onGo: (id: string) => void;
  onSources: () => void;
  readingSections: WritingSection[];
  bodyPending: boolean;
  learningHref: string;
  duration: number;
}) {
  const active = doc.roles.find(r => r.label === role) ?? doc.roles[0];
  const others = doc.roles.filter(r => r !== active);
  const readCount = doc.sources.filter(s => s.status === 'read').length;
  const scope = <div className="writing-scope-grid"><div className="writing-scope-in"><span className="cap">适用</span><div>{doc.scopeIn || '原文未单独说明，请结合正文判断。'}</div></div><div className="writing-scope-out"><span className="cap">不适用</span><div>{doc.scopeOut || '原文未单独说明。'}</div></div></div>;
  return <div data-section="top" className="writing-reader-overview">
    <div className="writing-reader-meta"><span className="tag t-l">{type ?? '文档'}</span><span>已发布 v{doc.version}</span><span>{doc.reviewerName} 审核 · {new Date(doc.publishedAt).toLocaleDateString('zh-CN')}</span>
      {doc.sources.length > 0 && <button className="writing-source-shortcut" onClick={onSources}>查看来源{readCount > 0 ? ` · ${readCount} 份` : '记录'}<ChevronRight size={12} /></button>}
    </div>
    <h1 className="writing-reader-title" tabIndex={-1}>{doc.title}</h1>
    {active && <section className="writing-actions-panel writing-focused-actions" aria-label="角色行动">
      <div className="writing-role-heading"><strong>你的下一步</strong>{doc.roles.length > 1 ? <div role="radiogroup" aria-label="我是">{doc.roles.map(r => <button className="role" role="radio" aria-checked={r === active} onClick={() => onRole(r.label)} key={r.label}>{r.label}</button>)}</div> : <span className="writing-current-role">{active.label}</span>}</div>
      {scope}
      <div className="act on"><div className="what">{active.action}{active.condition && <div className="cond"><span className="tag t-c">条件</span><span>{active.condition}</span></div>}</div></div>
      <nav className="writing-reading-order" aria-label={`${active.label}的阅读顺序`}><span className="hint">{active.label}的执行依据</span>{readingSections.map((s, i) => <button className="ord" disabled={bodyPending} onClick={() => onGo(s.id)} key={s.id}><span className="n">{i + 1}</span>{s.title}<ChevronRight size={13} /></button>)}<Link className="btn ghost" to={learningHref}>{duration >= 60 ? `或看 ${Math.floor(duration / 60)} 分钟教学` : '开始学习'}</Link></nav>
      {others.length > 0 && <details className="writing-other-roles" key={active.label}><summary>其他角色的行动<span>{others.length} 个角色</span></summary>{others.map(r => <div className="act" key={r.label}><button className="who" disabled={bodyPending} onClick={() => onGo(r.sectionId)}>{r.label}</button><div className="what">{r.action}{r.condition && <div className="cond"><span className="tag t-c">条件</span><span>{r.condition}</span></div>}</div></div>)}</details>}
    </section>}
    <section className="writing-reader-takeaways" aria-label="文档结论"><h2>结论</h2>{doc.conclusions.filter(Boolean).length ? <ol className="writing-conclusions">{doc.conclusions.filter(Boolean).map((c, i) => <li key={i}>{c}</li>)}</ol> : <p>{doc.summary || '正文开头：' + (doc.sections[0]?.paragraphs[0]?.text.slice(0, 60) ?? '')}</p>}</section>
    {!active && scope}
  </div>;
}
