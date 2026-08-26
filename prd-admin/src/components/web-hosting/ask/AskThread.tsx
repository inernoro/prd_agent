import { useEffect, useRef } from 'react';
import { StreamingText } from '@/components/streaming/StreamingText';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { AskMarkdown } from './AskMarkdown';
import { AskRefusalCard, type AskRefusalKey } from './askRefusal';
import type { AskMessage } from './askTypes';

interface Props {
  messages: AskMessage[];
  /** 一条都还没问时的开场白；空则用站点标题兜底 */
  welcome?: string | null;
  title: string;
  /** 开场问题。起手长条已经把它们浮在上方时传空数组——同一批问题铺两遍是噪音 */
  openingQuestions: string[];
  onPick: (question: string) => void;
  refusal: AskRefusalKey | null;
  /** 后端这次给的原话（带真实数字），只在它确实对应当前这一档时才传进来 */
  refusalServerMessage?: string | null;
  onLogin: () => void;
  onRetry: () => void;
  isBusy: boolean;
  phaseMessage: string;
  /** 起手态（长条）下不渲染开场白那段引导——长条自己已经写了「只依据本页正文」 */
  hideIntro?: boolean;
}

/**
 * 对话流本体：开场白、开场问题、拒绝卡、消息、等待态。
 *
 * 从 AskPanel 里抽出来，是因为它现在有两个宿主——嵌在预览弹窗右侧的面板，
 * 和访客页那个会形变的浮层坞。抄两份的下场在 predicate-and-wiring-discipline
 * 形状 3 里写着：同一个渲染分裂成两份，改一处忘一处。
 *
 * 滚动容器由本组件持有：贴底逻辑（有新内容就贴住底部，用户正在往上翻时不抢）
 * 和消息列表是同一件事，拆开两边都要重写一遍。
 */
export default function AskThread({
  messages, welcome, title, openingQuestions, onPick,
  refusal, refusalServerMessage, onLogin, onRetry,
  isBusy, phaseMessage, hideIntro,
}: Props) {
  const innerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const empty = messages.length === 0;
  const showOpening = empty && openingQuestions.length > 0 && !refusal;

  return (
    <div
      ref={innerRef}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: 14 }}
    >
      {empty && !hideIntro && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
          {welcome?.trim() || `关于「${title}」，有什么想了解的？`}
          {/* 「只依据本页正文」是个约束，光说约束等于让人自己去猜后果。
              把后果写出来（问到没写的会直说没提到），他才知道该期待什么。 */}
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            回答<strong style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>只依据本页正文</strong>
            。问到正文没写的，它会直接说「页面里没有提到」，不会替作者猜。
          </div>
        </div>
      )}

      {showOpening && (
        <div style={{ marginTop: hideIntro ? 0 : 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* 没有这行标题时，几个按钮看着像 AI 现编的推荐；标明来自站点题库，
              用户才知道这是作者预备好的问题，点下去大概率有答案。 */}
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>开场问题 · 来自站点题库</div>
          {openingQuestions.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => onPick(q)}
              style={{
                textAlign: 'left', padding: '9px 12px', borderRadius: 10,
                border: '1px solid var(--border-subtle)', background: 'var(--bg-card)',
                color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', lineHeight: 1.5,
              }}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {refusal && (
        <AskRefusalCard
          refusal={refusal}
          serverMessage={refusalServerMessage}
          onLogin={onLogin}
          onRetry={onRetry}
        />
      )}

      {messages.map((m) => (
        // id 给历史面板做锚点：点一条历史要能滚回那一轮，而不是只把面板关掉
        <div key={m.id} id={`ask-msg-${m.id}`} style={{ marginTop: 16 }}>
          {m.role === 'user' ? (
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <div
                style={{
                  maxWidth: '85%', padding: '8px 12px', borderRadius: 12,
                  background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
                  fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                }}
              >
                {m.content}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
              {m.error ? (
                <span style={{ color: 'var(--accent-primary)' }}>{m.error}</span>
              ) : (
                <StreamingText
                  text={m.content}
                  streaming={!!m.streaming}
                  markdown
                  // 没有 renderMarkdown 的话 StreamingText 不会切到 markdown 视图，
                  // 完成后的答案会把 **加粗**、列表、链接的原始语法裸露出来
                  renderMarkdown={(c) => <AskMarkdown content={c} />}
                />
              )}
            </div>
          )}
        </div>
      ))}

      {/* 等待期不能静止（CLAUDE.md 规则 #6）：还没有第一个字时给阶段文案 + 转圈 */}
      {isBusy && !messages.some((m) => m.streaming && m.content) && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)' }}>
          <MapSpinner size={14} />
          {phaseMessage || '正在思考…'}
        </div>
      )}
    </div>
  );
}
