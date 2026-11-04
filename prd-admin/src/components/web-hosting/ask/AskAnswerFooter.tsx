import { useState } from 'react';
import { ArrowRight, Check, Copy, MessageCircle, RotateCw } from 'lucide-react';
import { copyWithFeedback } from '@/lib/clipboard';
import type { AskMessage } from './askTypes';
import './askAnswerFooter.css';

function questionKey(question: string) {
  return question.trim().replace(/\s+/g, ' ').replace(/[?？]+$/u, '').trim().toLocaleLowerCase();
}

/** 只用当前入口实际下发的题库；不越过分享自选范围，也不编造页面未提供的问题。 */
function nextQuestions(openingQuestions: string[], messages: AskMessage[]) {
  const seen = new Set(messages.filter((message) => message.role === 'user').map((message) => questionKey(message.content)));
  const result: string[] = [];
  for (const question of openingQuestions) {
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
export function AskAnswerFooter({ answer, messages, openingQuestions, blocked, onAsk }: {
  answer: AskMessage;
  messages: AskMessage[];
  openingQuestions: string[];
  blocked: boolean;
  onAsk: (question: string) => void;
}) {
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
    {questions.length > 0 && <div className="ask-answer-next" aria-label="本页后续问题">
      <div className="ask-answer-next-label" title="来自本页已配置的题库">还可以问</div>
      {questions.map((question) => <button key={question} type="button" className="ask-answer-followup"
        onClick={() => onAsk(question)} disabled={blocked} title={question}>
        <MessageCircle size={13} aria-hidden="true" /><span>{question}</span><ArrowRight size={13} aria-hidden="true" />
      </button>)}
    </div>}
  </section>;
}
