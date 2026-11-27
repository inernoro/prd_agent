/**
 * 对话起稿：不知道选什么的人先和快速创作聊，聊到条件齐了再开工。
 * - 创作简报条：开工条件一眼可见（必填三项、建议两项），由服务端结构化给出；
 * - 助手每轮问一个问题，带可点的回答；推荐风格用卡片说明理由；
 * - 必填齐了出现「准备好了」卡，也可以直接说「可以开始了」；开工前先看分镜脚本，可一键跳过。
 * 只有最新一条助手消息的按钮可点，旧消息里的选项收起，避免点到过时的选择。
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Circle, Clapperboard, Play, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { StreamingText } from '@/components/streaming';
import { StyleFrame } from './TemplateFrames';
import { AgentTurn, UserTurn } from './Conversation';
import type { QcBrief, QcBriefSession, QcChatMessage, QcTemplate } from './types';

/** 创作简报条：放在输入框上方，聊到哪一条就勾哪一条 */
export function BriefStrip({ brief }: { brief: QcBrief }) {
  const required = brief.fields.filter(f => f.required);
  const filled = required.filter(f => f.value).length;
  return (
    <div className="mb-2 flex items-center gap-2 overflow-x-auto px-1 pb-0.5 text-[12px]" style={{ scrollbarWidth: 'none' }}
      data-qc="brief" data-ready={brief.ready ? 'true' : 'false'} data-filled={filled} aria-label="创作简报">
      <span className="shrink-0 font-medium text-token-secondary max-md:hidden">创作简报</span>
      <span className="shrink-0 rounded-full px-1.5 leading-[18px] tabular-nums"
        style={brief.ready ? { background: 'var(--semantic-success-soft)', color: 'var(--accent-fg-success)' } : { background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
        {brief.ready ? '可以开工' : `必填 ${filled}/${required.length}`}
      </span>
      {/* 手机只留一句：缺什么，或已经定下的三项 */}
      <span className="min-w-0 truncate text-token-secondary md:hidden" data-qc="brief-line">
        {brief.ready ? required.map(f => f.value?.replace(/（默认，可换）$/, '')).join(' · ') : `还缺${brief.missing.join('、')}`}
      </span>
      {brief.fields.map(f => (
        <span key={f.key} data-brief-field={f.key} data-filled={f.value ? 'true' : 'false'} title={f.value ? `${f.label}：${f.value}` : `${f.label}：待补`}
          className={cn('inline-flex h-6 max-w-[200px] shrink-0 items-center gap-1 rounded-md max-md:hidden',
            f.value ? 'px-0.5' : f.required ? 'border border-dashed border-[var(--border-default)] px-1.5' : 'px-0.5')}>
          {f.value ? <Check size={11} className="shrink-0 text-[color:var(--accent-fg-success)]" aria-hidden /> : <Circle size={11} className="shrink-0 text-token-muted" aria-hidden />}
          <span className="shrink-0 text-token-muted">{f.label}</span>
          <span className={cn('min-w-0 truncate', f.value ? 'text-token-primary' : 'text-token-muted')}>{f.value ?? (f.required ? '待补' : '可选')}</span>
        </span>
      ))}
    </div>
  );
}

/** 逐字显示助手的这一条（正式实现由 SSE 推送，原型按固定速度显示整条） */
function useReveal(text: string, active: boolean) {
  const [n, setN] = useState(active ? 0 : text.length);
  useEffect(() => {
    if (!active) { setN(text.length); return; }
    setN(0);
    const timer = window.setInterval(() => setN(v => { if (v >= text.length) { window.clearInterval(timer); return v; } return Math.min(text.length, v + 6); }), 16);
    return () => window.clearInterval(timer);
  }, [text, active]);
  return { shown: text.slice(0, n), done: n >= text.length };
}

function AgentMessage({ m, latest, revealing, templates, session, busy, onReply, onUseStyle, onStart, onSkipScript, onConfirmScript }: {
  m: QcChatMessage;
  latest: boolean;
  revealing: boolean;
  templates: QcTemplate[];
  session: QcBriefSession;
  busy: boolean;
  onReply: (text: string) => void;
  onUseStyle: (templateId: string) => void;
  onStart: () => void;
  onSkipScript: () => void;
  onConfirmScript: () => void;
}) {
  const { shown, done } = useReveal(m.text, revealing);
  const style = (id: string) => templates.find(t => t.id === id);
  const active = latest && done && !busy;
  /* 最新一条出完（含选项、推荐卡、准备好了卡、脚本卡）后滚到它的底部，新内容不落在视线外 */
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (latest && done) endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [latest, done]);
  return (
    <AgentTurn status={session.model ? <span className="font-mono text-[11px]">● {session.model.model} · {session.model.platform}</span> : undefined}>
      <div className={cn('whitespace-pre-wrap text-[13.5px] leading-6 text-token-primary', m.missingNote && 'text-token-primary')} data-qc={m.missingNote && latest ? 'missing-note' : undefined}>
        <StreamingText text={shown} streaming={!done} mode="typewriter" cursor={!done} />
      </div>
      {done && latest && !!m.quickReplies?.length && (
        <div className="flex flex-wrap gap-1.5" aria-label="可以直接点的回答">
          {m.quickReplies.map(q => (
            <button key={q} type="button" data-qc="quick-reply" data-value={q} disabled={!active} onClick={() => onReply(q)}
              className="qc-face qc-face-chip relative inline-flex items-center px-3 text-[12.5px] text-token-primary disabled:opacity-50">
              {q}
            </button>
          ))}
        </div>
      )}
      {done && !!m.recommendations?.length && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="推荐的风格">
          {m.recommendations.map((r, i) => {
            const st = style(r.templateId);
            if (!st) return null;
            const chosen = session.styleId === st.id && session.brief.fields.find(f => f.key === 'style')?.source === 'chat';
            return (
              <div key={r.templateId} data-qc="rec-style" data-style={r.templateId}
                className={cn('flex flex-col overflow-hidden rounded-[12px] border bg-[var(--bg-input)] max-sm:flex-row', chosen ? 'border-[color:var(--accent-primary)] shadow-[0_0_0_1px_var(--accent-primary)]' : 'border-token-subtle')}>
                <div className="max-sm:w-28 max-sm:shrink-0 max-sm:self-stretch max-sm:[&>div]:!aspect-auto max-sm:[&>div]:!h-full"><StyleFrame template={{ ...st, frame: undefined }} /></div>
                <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
                  <div className="flex items-center gap-1.5 text-[13px] font-medium text-token-primary"><span className="tabular-nums text-token-muted">{i + 1}</span>{st.name}</div>
                  <p className="m-0 flex-1 text-[12px] leading-[18px] text-token-secondary">{r.reason}</p>
                  {latest && (
                    <button type="button" data-qc="rec-use" disabled={!active || chosen} onClick={() => onUseStyle(st.id)}
                      className="-ml-1 mt-0.5 inline-flex h-7 items-center gap-1 self-start rounded-md px-1 text-[12.5px] font-medium text-[color:var(--accent-primary)] hover:underline disabled:cursor-default disabled:no-underline max-md:h-11 [&:disabled:not([data-chosen])]:opacity-50"
                      data-chosen={chosen ? '' : undefined}>
                      {chosen ? <><Check size={13} aria-hidden />已选这个</> : <>用这个风格<ArrowRight size={13} aria-hidden /></>}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {done && m.ready && latest && (
        <section className="qc-card qc-rise p-3.5" data-qc="ready-card">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-token-primary"><Sparkles size={15} className="text-[color:var(--accent-primary)]" aria-hidden />准备好了</div>
          {session.brief.summary && <p className="m-0 mt-1.5 whitespace-pre-line text-[12.5px] leading-5 text-token-secondary">{session.brief.summary}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" className="qc-face qc-face-primary relative px-3.5" data-qc="brief-start" disabled={!active} onClick={onStart}><Play size={14} />开始生成（约 30–60 分钟）</Button>
            <Button variant="ghost" size="sm" className="max-md:min-h-11" data-qc="brief-skip-script" disabled={!active} onClick={onSkipScript}>跳过脚本，直接开始</Button>
          </div>
          <p className="m-0 mt-2 text-[11.5px] text-token-muted">点「开始生成」会先花一两分钟出分镜脚本给你确认，再正式排队。</p>
        </section>
      )}
      {done && !!m.script?.length && (
        <section className="qc-card qc-rise overflow-hidden" data-qc={latest ? 'script-draft' : undefined}>
          <div className="flex items-center gap-2 border-b border-token-subtle px-3.5 py-2.5 text-[13.5px] font-semibold text-token-primary">
            <Clapperboard size={15} className="text-[color:var(--accent-primary)]" aria-hidden />分镜脚本 · {m.script.length} 幕
          </div>
          <ol className="m-0 list-none p-0">
            {m.script.map(sc => (
              <li key={sc.index} className="flex gap-3 border-b border-token-subtle px-3.5 py-2 text-[12.5px] last:border-b-0">
                <span className="w-4 shrink-0 tabular-nums text-token-muted">{sc.index}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-token-primary">{sc.visual}</div>
                  <div className="text-token-secondary">旁白：{sc.narration}</div>
                </div>
              </li>
            ))}
          </ol>
          {latest && (
            <div className="flex flex-wrap items-center gap-2 border-t border-token-subtle bg-[var(--bg-secondary)] px-3.5 py-2.5">
              <Button variant="primary" className="qc-face qc-face-primary relative px-3.5" data-qc="script-confirm" disabled={!active} onClick={onConfirmScript}><Play size={14} />按这个脚本开始生成</Button>
              <span className="text-[12px] text-token-muted">想改哪一幕，直接在下面说，例如「第 3 幕换成客户案例」</span>
            </div>
          )}
        </section>
      )}
      <div ref={endRef} aria-hidden />
    </AgentTurn>
  );
}

/** 对话流：你的消息靠右，助手的回复带头像与模型名；正在等回复时显示一条在动的占位 */
export function BriefConversation({ session, pendingText, revealId, templates, busy, onReply, onUseStyle, onStart, onSkipScript, onConfirmScript }: {
  session: QcBriefSession | null;
  pendingText: string | null;
  revealId: string | null;
  templates: QcTemplate[];
  busy: boolean;
  onReply: (text: string) => void;
  onUseStyle: (templateId: string) => void;
  onStart: () => void;
  onSkipScript: () => void;
  onConfirmScript: () => void;
}) {
  const messages = session?.messages ?? [];
  const lastAgent = [...messages].reverse().find(x => x.role === 'agent');
  return (
    <>
      {messages.map(m => m.role === 'user' ? (
        <UserTurn key={m.id}><p className="m-0 whitespace-pre-wrap px-1 text-[14px] leading-6 text-token-primary">{m.text}</p></UserTurn>
      ) : session && (
        <AgentMessage key={m.id} m={m} latest={m.id === lastAgent?.id && !pendingText} revealing={m.id === revealId} templates={templates} session={session} busy={busy}
          onReply={onReply} onUseStyle={onUseStyle} onStart={onStart} onSkipScript={onSkipScript} onConfirmScript={onConfirmScript} />
      ))}
      {pendingText && (
        <>
          <UserTurn><p className="m-0 whitespace-pre-wrap px-1 text-[14px] leading-6 text-token-primary">{pendingText}</p></UserTurn>
          <AgentTurn status="正在想">
            <div className="flex items-center gap-2 text-[13px] text-token-secondary" data-qc="agent-thinking"><MapSpinner size={13} />正在理解你的需求，马上回复</div>
          </AgentTurn>
        </>
      )}
    </>
  );
}
