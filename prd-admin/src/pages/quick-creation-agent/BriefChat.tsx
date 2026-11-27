import { useEffect, useRef } from 'react';
import { Check, Circle, Clapperboard, Play, Sparkles } from 'lucide-react';
import { Button } from '@/components/design/Button';
import { StreamingText } from '@/components/streaming';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { AgentTurn, UserTurn } from './Conversation';
import { StyleFrame } from './TemplateFrames';
import type { QcBriefSession, QcTemplate } from './types';

export const BRIEF_STARTERS = ['我想做一个宣传片', '给新同事做个培训短片', '不知道选什么风格'];

export function BriefStrip({ session }: { session: QcBriefSession }) {
  const { fields, ready, missing } = session.brief;
  return (
    <div className="mb-2 flex items-center gap-1.5 overflow-x-auto px-1 pb-1 text-[12px]" aria-label="创作简报"
      data-qc="brief" data-ready={ready} data-filled={3 - missing.length}>
      <span className="shrink-0 font-medium text-token-primary">{ready ? '可以开工' : `必填 ${3 - missing.length}/3`}</span>
      {fields.map(field => (
        <span key={field.key} data-brief-field={field.key} data-filled={!!field.value}
          title={field.value || (field.required ? '待补' : '可选')}
          className="inline-flex h-6 max-w-[190px] shrink-0 items-center gap-1 rounded-md border border-token-subtle px-1.5 text-token-secondary">
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
                {message.quickReplies.map(value => <Button key={value} variant="secondary" size="sm" className="max-md:min-h-11"
                  data-qc="quick-reply" data-value={value} disabled={disabled} onClick={() => onSend(value)}>{value}</Button>)}
              </div>
            )}
            {!!message.recommendations?.length && (
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-3" aria-label="推荐的风格">
                {message.recommendations.map((item, index) => {
                  const template = templates.find(style => style.id === item.templateId);
                  if (!template) return null;
                  return (
                    <div key={template.id} className="qc-card overflow-hidden" data-qc="rec-style" data-style={template.id}>
                      <StyleFrame template={{ ...template, frame: undefined }} />
                      <div className="space-y-1 p-2.5">
                        <div className="text-[13px] font-medium">{index + 1}. {template.name}</div>
                        <p className="m-0 text-[12px] leading-5 text-token-secondary">{item.reason}</p>
                        {message === lastMessage && <Button variant="secondary" size="xs" className="max-md:min-h-11" data-qc="rec-use"
                          disabled={disabled || session?.styleId === template.id} onClick={() => onPick(template.id)}>
                          {session?.styleId === template.id ? '已选' : '用这个'}
                        </Button>}
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
                <Button size="sm" data-qc="script-confirm" className="max-md:min-h-11" disabled={disabled} onClick={() => onGenerate('confirm')}>按这个脚本开始生成</Button>
                <span className="text-[12px] text-token-muted">想改的地方可以直接在对话里说</span>
              </div>
            </section>
          ) : (
            <section className="qc-card space-y-2 p-3" data-qc="ready-card">
              <div className="flex items-center gap-2 text-[14px] font-semibold"><Sparkles size={15} aria-hidden />准备好了</div>
              <p className="m-0 text-[13px] leading-5 text-token-secondary">{session.brief.summary.join(' · ')}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" data-qc="brief-start" className="max-md:min-h-11" disabled={disabled}
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
