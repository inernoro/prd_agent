import { useState } from 'react';
import { X } from 'lucide-react';
import type { WritingParagraph, WritingQuestion, WritingSource } from '@/services/contracts/writing';

export function WritingQuestionPanel({ question, questions, sources, paragraphs, answer, openAnswer, busy, locked, onAnswer, onOpenAnswer, onConfirm, onPrevious, onClose, onLocate }: {
  question: WritingQuestion; questions: WritingQuestion[]; sources: WritingSource[]; paragraphs: WritingParagraph[];
  answer: string; openAnswer: boolean; busy: boolean; locked: boolean;
  onAnswer: (value: string) => void; onOpenAnswer: (value: boolean) => void; onConfirm: () => void;
  onPrevious: () => void; onClose: () => void; onLocate: (id: string, quote: string) => void;
}) {
  const choices = question.choices?.length ? question.choices : question.options.map((text, i) => ({ key: String(i), label: text, text }));
  const [mode, setMode] = useState<'choice' | 'other' | 'open' | ''>(() => openAnswer ? 'open' : !answer ? '' : choices.some(choice => choice.text === answer) ? 'choice' : 'other');
  const index = questions.indexOf(question);
  const evidence = question.evidence?.length ? question.evidence : question.citations.map(sourceId => ({ sourceId, location: '', quote: paragraphs.find(p => p.id === question.paragraphId)?.quotes?.[sourceId] ?? sources.find(s => s.id === sourceId)?.content.slice(0, 240) ?? '' }));
  return <>
    <div className="col-h"><span className="h3"><span className="writing-mobile-only">补充 · </span>第 {index + 1} / {questions.length} 项</span><button className="btn ghost sm" aria-label="关闭补充面板（Esc）" onClick={onClose}><X size={12} />关闭</button></div>
    <div className="scroll writing-question-detail">
      <div className="prog" aria-label={`已处理 ${questions.filter(q => q.status !== 'pending').length} / ${questions.length} 项`}>{questions.map(q => <span key={q.id} className={q.status !== 'pending' ? 'd' : q.id === question.id ? 'c' : ''} />)}</div>
      <div className="writing-question-meta"><span className={`tag ${question.kind === 'conf' ? 't-d' : 't-c'}`}>{question.kind === 'conf' ? '资料冲突' : '待确认'}</span><span className="mono">影响「{question.sectionTitle}」</span></div>
      <h3 id="writing-question-title" className="serif">{question.title}</h3><p className="hint">{question.why}</p>
      {question.kind === 'conf' && <div className="writing-question-evidence">{evidence.map((item, i) => { const source = sources.find(s => s.id === item.sourceId); return source && <div className="side" key={`${item.sourceId}-${i}`}><button className="sc" title={item.location || undefined} onClick={() => onLocate(source.id, item.quote)}>{source.id}</button><span>{item.quote}<span className="mono writing-block">{source.title} · {new Date(source.updatedAt).toLocaleDateString('sv-SE')}</span></span></div>; })}</div>}
      <div role="radiogroup" aria-labelledby="writing-question-title" className="writing-question-options">
        {choices.map(choice => <button className="opt" role="radio" aria-checked={mode === 'choice' && answer === choice.text} key={choice.key} disabled={locked} onClick={() => { setMode('choice'); onAnswer(choice.text); onOpenAnswer(false); }}><span className="rd" /><span><span className="ol">{choice.label}</span>{choice.text && <span className="ot">{choice.text}</span>}</span></button>)}
        <button className="opt" role="radio" aria-checked={mode === 'other'} disabled={locked} onClick={() => { setMode('other'); onOpenAnswer(false); onAnswer(''); }}><span className="rd" /><span className="ol">其他，自己写</span></button>
        <button className="opt" role="radio" aria-checked={mode === 'open'} disabled={locked} onClick={() => { setMode('open'); onOpenAnswer(true); onAnswer(`待确认：${question.title}`); }}><span className="rd" /><span><span className="ol">暂不确定，写入开放问题</span><span className="ot">不影响提交审核；读者页会把它列在「开放问题」里。</span></span></button>
      </div>
      {mode === 'other' && <textarea className="field writing-question-other" aria-label="其他，自己写" autoFocus disabled={locked} value={answer} onChange={e => onAnswer(e.target.value)} placeholder="写下你的结论，会作为作者补充显示" />}
    </div>
    <footer className="writing-question-footer"><button className="btn" disabled={index === 0 || busy} onClick={onPrevious}>上一项</button><button className="btn pri" disabled={!answer.trim() || busy || locked} onClick={onConfirm}><span className="writing-desktop-only">{index === questions.length - 1 ? '确认并完成' : '确认并下一项'}</span><span className="writing-mobile-only">{index === questions.length - 1 ? '确认，完成补充' : '确认，下一项'}</span></button></footer>
  </>;
}
