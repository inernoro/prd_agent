import { useEffect, useRef } from 'react';
import { ArrowRight, Check, Circle, Clapperboard, Play, Sparkles } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { StreamingText } from '@/components/streaming';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { AgentTurn, UserTurn } from './Conversation';
import { StyleFrame } from './TemplateFrames';
import type { QcBriefSession, QcTemplate } from './types';

export const BRIEF_STARTERS = ['我想做一个宣传片', '给新同事做个培训短片', '不知道选什么风格'];

export function BriefStrip({ session }: { session: QcBriefSession }) {
  const { fields, ready, missing } = session.brief;
  const required = fields.filter(field => field.required);
  return (
    <div className="mb-2 flex items-center gap-2 overflow-x-auto px-1 pb-0.5 text-[12px] [scrollbar-width:none]" aria-label="创作简报"
      data-qc="brief" data-ready={ready} data-filled={3 - missing.length}>
      <span className="shrink-0 font-medium text-token-secondary max-md:hidden">创作简报</span>
      <span className={`shrink-0 rounded-full px-1.5 leading-[18px] tabular-nums ${ready ? 'bg-[var(--semantic-success-soft)] text-[color:var(--accent-fg-success)]' : 'bg-[var(--bg-tertiary)] text-token-secondary'}`}>{ready ? '可以开工' : `必填 ${3 - missing.length}/3`}</span>
      <span className="min-w-0 truncate text-token-secondary md:hidden" data-qc="brief-line">
        {ready ? required.map(field => field.value).join(' · ') : `还缺${missing.join('、')}`}
      </span>
      {fields.map(field => (
        <span key={field.key} data-brief-field={field.key} data-filled={!!field.value}
          title={field.value || (field.required ? '待补' : '可选')}
          className={`inline-flex h-6 max-w-[190px] shrink-0 items-center gap-1 rounded-md text-token-secondary max-md:hidden ${!field.value && field.required ? 'border border-dashed border-[var(--border-default)] px-1.5' : 'px-0.5'}`}>
          {field.value ? <Check size={12} aria-hidden /> : <Circle size={10} aria-hidden />}
          <span className="shrink-0 text-token-muted">{field.label}</span>
          <span className="truncate">{field.value || (field.required ? '待补' : '可选')}{field.source === 'default' && '（默认）'}</span>
        </span>
      ))}
    </div>
  );
}

export interface BriefPending {
  mode: 'message' | 'script';
  text: string;
  reply: string;
  phase: string;
  model?: string;
  platform?: string;
}

export function BriefConversation({ session, pending, error, templates, disabled, onRetry, onSend, onPick, onScript, onGenerate }: {
  session: QcBriefSession | null;
  pending: BriefPending | null;
  error: string | null;
  templates: QcTemplate[];
  disabled: boolean;
  onRetry: () => void;
  onSend: (text: string) => void;
  onPick: (styleId: string) => void;
  onScript: () => void;
  onGenerate: (mode: 'skip' | 'confirm') => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const hasPending = !!pending;
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [session?.revision, hasPending, error]);
  const messages = session?.messages ?? [];
  const lastMessage = messages.at(-1);
  return (
    <>
      {messages.map(message => message.role === 'user'
        ? <UserTurn key={message.id}><p className="m-0 whitespace-pre-wrap text-[14px]">{message.text}</p></UserTurn>
        : (
          <AgentTurn key={message.id} status={message.model && [message.model, message.platform].filter(Boolean).join(' · ')}>
            <p className="m-0 whitespace-pre-wrap text-[14px] leading-6">{message.text}</p>
            {message === lastMessage && !pending && !!message.quickReplies?.length && (
              <div className="flex flex-wrap gap-1.5" aria-label="可以直接点的回答">
                {message.quickReplies.map(value => <button key={value} type="button" className="qc-face qc-face-chip relative inline-flex items-center px-3 text-[12.5px] text-token-primary disabled:opacity-50"
                  data-qc="quick-reply" data-value={value} disabled={disabled} onClick={() => onSend(value)}>{value}</button>)}
              </div>
            )}
            {!!message.recommendations?.length && (
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-3" aria-label="推荐的风格">
                {message.recommendations.map((item, index) => {
                  const template = templates.find(style => style.id === item.templateId);
                  if (!template) return null;
                  return (
                    <div key={template.id} className={`qc-card flex flex-col overflow-hidden max-sm:flex-row ${session?.styleId === template.id ? 'ring-1 ring-[color:var(--accent-primary)]' : ''}`} data-qc="rec-style" data-style={template.id}>
                      <div className="max-sm:w-28 max-sm:shrink-0 max-sm:self-stretch max-sm:[&>div]:!aspect-auto max-sm:[&>div]:!h-full"><StyleFrame template={{ ...template, frame: undefined }} /></div>
                      <div className="min-w-0 flex-1 space-y-1 p-2.5">
                        <div className="text-[13px] font-medium">{index + 1}. {template.name}</div>
                        <p className="m-0 text-[12px] leading-5 text-token-secondary">{item.reason}</p>
                        {message === lastMessage && <button type="button" className="-ml-1 inline-flex h-7 items-center gap-1 rounded-md px-1 text-[12.5px] font-medium text-[color:var(--accent-primary)] hover:underline disabled:no-underline max-md:h-11" data-qc="rec-use"
                          disabled={disabled || session?.styleId === template.id} onClick={() => onPick(template.id)}>
                          {session?.styleId === template.id ? <><Check size={13} aria-hidden />已选这个</> : <>用这个风格<ArrowRight size={13} aria-hidden /></>}
                        </button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </AgentTurn>
        ))}
      {pending && <>
        {pending.mode === 'message' && <UserTurn><p className="m-0 whitespace-pre-wrap text-[14px]">{pending.text}</p></UserTurn>}
        <AgentTurn status={[pending.model, pending.platform].filter(Boolean).join(' · ')}>
          {pending.reply
            ? <StreamingText text={pending.reply} streaming />
            : <span className="inline-flex items-center gap-2 text-[13px] text-token-secondary" role="status"><MapSpinner size={14} />{pending.phase}</span>}
        </AgentTurn>
      </>}
      {!pending && !error && session?.brief.ready && (
        <AgentTurn>
          {session.script.length ? (
            <section className="qc-card overflow-hidden" data-qc="script-draft">
              <header className="flex items-center gap-2 border-b border-token-subtle px-3 py-2 text-[14px] font-semibold"><Clapperboard size={15} />分镜脚本 · {session.script.length} 幕</header>
              <ol className="m-0 list-none p-0">
                {session.script.map(scene => <li key={scene.index} className="border-b border-token-subtle p-2.5 text-[13px]">
                  <p className="m-0">{scene.index}. {scene.visual}</p>
                  <p className="m-0 mt-0.5 text-token-secondary">旁白 · {scene.narration}</p>
                </li>)}
              </ol>
              <div className="flex flex-wrap items-center gap-2 p-2.5">
                <Button size="sm" data-qc="script-confirm" className="qc-face qc-face-primary relative px-3.5" disabled={disabled} onClick={() => onGenerate('confirm')}><Play size={14} aria-hidden />按这个脚本开始生成</Button>
                <span className="text-[12px] text-token-muted">想改的地方可以直接在对话里说</span>
              </div>
            </section>
          ) : (
            <section className="qc-card space-y-2 p-3" data-qc="ready-card">
              <div className="flex items-center gap-2 text-[14px] font-semibold"><Sparkles size={15} aria-hidden />准备好了</div>
              <p className="m-0 text-[13px] leading-5 text-token-secondary">{session.brief.summary.join(' · ')}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" data-qc="brief-start" className="qc-face qc-face-primary relative px-3.5" disabled={disabled}
                  onClick={session.kind === 'video' ? onScript : () => onGenerate('skip')}><Play size={14} />开始生成</Button>
                {session.kind === 'video' && <Button size="sm" variant="ghost" data-qc="brief-skip-script" className="max-md:min-h-11"
                  disabled={disabled} onClick={() => onGenerate('skip')}>跳过脚本，直接开始</Button>}
              </div>
              <p className="m-0 text-[12px] text-token-muted">预计耗时会按实际排队和历史完成时间显示</p>
            </section>
          )}
        </AgentTurn>
      )}
      {error && <AgentTurn><div role="status" className="text-[13px]">{error}</div><Button size="sm" variant="secondary" onClick={onRetry}>重试</Button></AgentTurn>}
      <div ref={end} aria-hidden />
    </>
  );
}
