import { useState } from 'react';
import { ArrowRight, Check, Copy, MessageCircle, RotateCw, Star } from 'lucide-react';
import { copyWithFeedback } from '@/lib/clipboard';
import type { AskMessage } from './askTypes';
import './askAnswerFooter.css';

function questionKey(question: string) {
  return question.trim().replace(/\s+/g, ' ').replace(/[?？]+$/u, '').trim().toLocaleLowerCase();
}

// 开场题库控制起手展示；续问另提供正文阅读任务，不假定页面存在某个事实。
const PAGE_FOLLOWUPS = [
  '请总结本页最重要的结论，并给出原文依据。',
  '请展开解释刚才回答中的关键点，并引用相关原文。',
  '本页有哪些限制条件、例外或尚未说明的地方？',
  '请用表格梳理本页的主要内容及它们之间的关系。',
  '请列出本页明确提出的行动建议，没有提到的请说明。',
  '请区分本页已经确定的事实和计划中的内容。',
];
function nextQuestions(openingQuestions: string[], messages: AskMessage[]) {
  const seen = new Set(messages.filter((message) => message.role === 'user').map((message) => questionKey(message.content)));
  const result: string[] = [];
  for (const question of [...openingQuestions, ...PAGE_FOLLOWUPS]) {
    const text = question.trim();
    const key = questionKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
    if (result.length === 3) break;
  }
  return result;
}

/** 最新成功回答的下一步：复制原答案（含引用）、再问一次或从本页题库继续。 */
export function AskAnswerFooter({ answer, messages, openingQuestions, blocked, onAsk, onRate }: {
  answer: AskMessage;
  onRate?: (answerId: string, rating: number) => Promise<void>;
  messages: AskMessage[];
  openingQuestions: string[];
  blocked: boolean;
  onAsk: (question: string) => void;
}) {
  const [ratingBusy, setRatingBusy] = useState(false);
  const [ratingError, setRatingError] = useState('');
  const rate = async (value: number) => {
    if (ratingBusy || !onRate) return;
    setRatingBusy(true); setRatingError('');
    try { await onRate(answer.id, value); }
    catch (error) { setRatingError(error instanceof Error ? error.message : '评分未保存，请重试。'); }
    finally { setRatingBusy(false); }
  };
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const lastQuestion = [...messages].reverse().find((message) => message.role === 'user')?.content;
  const questions = nextQuestions(openingQuestions, messages);

  const copy = async () => {
    if (copying) return;
    setCopying(true);
    try {
      setCopied(await copyWithFeedback(answer.content, { successMessage: '已复制回答及引用', label: '回答' }));
    } finally { setCopying(false); }
  };

  return <section className="ask-answer-footer" aria-label="回答操作与后续问题">
    <div className="ask-answer-toolbar">
      <span className="ask-answer-complete"><Check size={13} aria-hidden="true" />回答完成</span>
      <span className="ask-answer-divider" aria-hidden="true" />
      <button type="button" onClick={() => void copy()} disabled={copying}
        aria-label={copied ? '已复制回答' : '复制回答'} title={copied ? '已复制回答及引用' : '复制回答及引用'}>
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
      {lastQuestion && <button type="button" onClick={() => onAsk(lastQuestion)} disabled={blocked}
        aria-label="再问一次" title="再次发送上一条问题，会消耗提问额度">
        <RotateCw size={14} aria-hidden="true" />
      </button>}
    </div>
    {onRate && answer.ratingToken && <div className="ask-answer-rating" role="group" aria-label="评价这条回答">
      <span>{ratingBusy ? '正在保存…' : answer.rating ? `已评 ${answer.rating} 分` : '这个回答怎么样？'}</span>
      <div>{[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} aria-label={`评 ${value} 分`}
        aria-pressed={answer.rating === value} disabled={ratingBusy} title={`${value} 分`}
        onClick={() => void rate(value)} className={value <= (answer.rating ?? 0) ? 'is-rated' : ''}>
        <Star size={15} fill={value <= (answer.rating ?? 0) ? 'currentColor' : 'none'} />
      </button>)}</div>
    </div>}
    {ratingError && <div className="ask-rating-error" role="alert">{ratingError}</div>}
    {questions.length > 0 && <div className="ask-answer-next" aria-label="本页后续问题">
      <div className="ask-answer-next-label" title="围绕本页内容继续提问">还可以问</div>
      {questions.map((question) => <button key={question} type="button" className="ask-answer-followup"
        onClick={() => onAsk(question)} disabled={blocked} title={question}>
        <MessageCircle size={13} aria-hidden="true" /><span>{question}</span><ArrowRight size={13} aria-hidden="true" />
      </button>)}
    </div>}
  </section>;
}
