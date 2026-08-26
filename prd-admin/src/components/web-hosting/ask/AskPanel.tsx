import { useCallback, useEffect, useRef, useState } from 'react';
import { Send, Sparkles, X } from 'lucide-react';
import { ASK_REFUSAL_REGISTRY, AskRefusalCard, resolveAskRefusal } from './askRefusal';
import { StreamingText } from '@/components/streaming/StreamingText';
import { AskMarkdown } from './AskMarkdown';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import { ASK_MAX_QUESTION_LENGTH, type AskSource } from './askTypes';
import { useAskQuota } from './useAskQuota';
import { useAskStream } from './useAskStream';

interface Props {
  source: AskSource;
  /** 面板标题，通常是站点名 */
  title: string;
  welcome?: string | null;
  /** 服务端已算好的开场问题，前端直接渲染，不再自己合并 */
  openingQuestions: string[];
  /** 未登录访客能不能问；false 时空状态引导登录 */
  allowAnonymous: boolean;
  onClose: () => void;
  /** 移动端全屏 sheet，桌面端右侧抽屉 */
  isMobile: boolean;
  /**
   * 嵌入模式：面板由父容器（预览弹窗的右侧 aside）定位与开合，
   * 自己不再 fixed 定位、不出关闭按钮。
   */
  embedded?: boolean;
  /**
   * 收起时用 display:none 藏起来，而不是让父组件卸载本组件。
   *
   * 卸载会一并销毁 useAskStream 里的 messages 与 sessionId：重新打开就是一段空对话，
   * 而且如果是在回答流式输出中途关掉的，那次 fetch 没有卸载清理、会继续跑到底——
   * 钱花了、答案却没人看见。所以「关闭」只是藏起来。
   */
  hidden?: boolean;
}

/**
 * 提问面板本体。用抽屉而不是气泡：气泡会盖住 PPT 类托管页右下角的翻页控件，
 * 而托管内容里 reveal.js 幻灯片恰恰是最常见的形态之一。
 */
export default function AskPanel({
  source, title, welcome, openingQuestions, allowAnonymous, onClose, isMobile, embedded, hidden,
}: Props) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { messages, status, phaseMessage, model, gateError, isBusy, ask } = useAskStream(source);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // 几种「问不了」各有各的下一步，判定收在 resolveAskRefusal 里（有守卫）
  const refusal = resolveAskRefusal({ isAuthenticated, allowAnonymous, gateErrorCode: gateError?.code });
  // 被拒时输入区一并禁用：留一个能打字却发不出去的输入框，只会让人白写一段
  const blocked = refusal !== null;

  // 剩余额度。面板收起时不拉——藏起来的面板照样发请求是白烧一次。
  const { quota, refresh: refreshQuota } = useAskQuota(source, !hidden);
  // 每问完一次（成功或失败）都重算：失败里含「读不到正文」那档，后端会把额度退回来，
  // 只在成功时减一会让用户看到一个偏小的数，而他并没有被扣。
  useEffect(() => {
    if (status === 'done' || status === 'error') void refreshQuota();
  }, [status, refreshQuota]);

  // 新内容进来时贴住底部；用户正在往上翻看历史时不抢滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const submit = useCallback(
    (text: string) => {
      const q = text.trim();
      if (!q || isBusy || blocked) return;
      setDraft('');
      void ask(q);
    },
    [ask, isBusy, blocked],
  );

  const showOpening = messages.length === 0 && openingQuestions.length > 0 && !blocked;

  return (
    <div
      style={{
        display: hidden ? 'none' : 'flex',
        flexDirection: 'column',
        // 浮层模式必须**不透明**：--panel-solid 只有 92% 不透明度，抽屉压在访客页顶栏上时，
        // 「全屏演示 / 评论」那几个按钮会隔着面板幽幽透出来，看着像渲染坏了。
        // 嵌入模式由父容器给底，保留原来的半透观感。
        background: embedded ? 'var(--panel-solid, var(--bg-elevated))' : 'var(--bg-elevated)',
        color: 'var(--text-primary)',
        // 嵌入模式由父容器定位；浮层模式自己 fixed（移动端全屏、桌面端右侧抽屉）
        ...(embedded
          ? { position: 'relative', flex: 1, minHeight: 0, width: '100%' }
          : {
              position: 'fixed',
              zIndex: 60,
              ...(isMobile
                ? { inset: 0 }
                : {
                    top: 0,
                    right: 0,
                    bottom: 0,
                    width: 400,
                    borderLeft: '1px solid var(--border-subtle)',
                    boxShadow: 'var(--shadow-glass-drawer)',
                  }),
            }),
      }}
      aria-hidden={hidden || undefined}
      role="dialog"
      aria-label="向我提问"
    >
      {/* 顶栏：模型名必须可见（ai-model-visibility 规则第 1 条） */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 14px',
          borderBottom: '1px solid var(--border-faint)',
          flexShrink: 0,
        }}
      >
        <Sparkles size={16} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            向我提问
          </div>
          <div
            style={{
              fontSize: 11, color: 'var(--text-muted)', fontFamily: 'ui-monospace, monospace',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {model ? `${model.model}${model.platform ? ` · ${model.platform}` : ''}` : title}
          </div>
        </div>
        {/* 还剩几次。放顶栏而不是消息区顶部：消息区会随对话滚走，而「还能问几次」
            恰恰是问到第三条时最需要看见的。读不到就整块不渲染——宁可不说，
            也不给一个编的数（no-rootless-tree）。 */}
        {quota && (
          <div
            title="两层独立计数：站点每日总量 + 你这一小时的额度"
            style={{
              flexShrink: 0, textAlign: 'right', lineHeight: 1.45,
              fontFamily: 'var(--font-code, ui-monospace, monospace)', fontSize: 9.5,
              color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums',
            }}
          >
            本页今日剩 {quota.siteRemaining} / {quota.siteLimit}
            <br />
            你这小时剩 {quota.visitorRemaining} / {quota.visitorLimit}
          </div>
        )}
        {!embedded && (
          <button
            onClick={onClose}
            aria-label="关闭"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, borderRadius: 8, border: 'none',
              background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', flexShrink: 0,
            }}
          >
            <X size={16} />
          </button>
        )}
      </div>

      {/* 消息区。
          minHeight:0 不能省——flex 子元素的默认 min-height 是 auto，内容一多它就不肯收缩，
          overflow 没机会触发，输入区被顶出面板（frontend-modal.md 第 3 条硬约束）。 */}
      <div
        ref={scrollRef}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', padding: 14 }}
      >
        {messages.length === 0 && (
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
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* 没有这行标题时，几个按钮看着像 AI 现编的推荐；标明来自站点题库，
                用户才知道这是作者预备好的问题，点下去大概率有答案。 */}
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              开场问题 · 来自站点题库
            </div>
            {openingQuestions.map((q) => (
              <button
                key={q}
                onClick={() => submit(q)}
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
            // 后端这几档的原话带着真实数字（每小时几次、还剩多久），优先于注册表兜底文案。
            // 但只在错误码确实对应当前这一档时才用——未登录压过服务端错误码那条优先级里，
            // gateError 可能是上一次会话的残留，拿它的文案去配「需要登录」的标题就串了。
            serverMessage={resolveAskRefusal({
              isAuthenticated, allowAnonymous: true, gateErrorCode: gateError?.code,
            }) === refusal ? gateError?.message : null}
            onLogin={() => {
              // 带 redirect 回到当前这一页：登录完还得让他自己找回来就白做了
              const back = encodeURIComponent(window.location.pathname + window.location.search);
              window.location.href = `/login?redirect=${back}`;
            }}
            onRetry={() => {
              // 读不到正文时后端会 RefundAsync 把额度退回来，所以重试是安全的、不烧额度。
              // 重问最后一句用户问过的话；一句都还没问过就什么都不做。
              const lastAsked = [...messages].reverse().find((m) => m.role === 'user');
              if (lastAsked) void ask(lastAsked.content);
            }}
          />
        )}

        {messages.map((m) => (
          <div key={m.id} style={{ marginTop: 16 }}>
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

      {/* 输入区。
          手机端面板铺满视口，而 app 开了 viewport-fit=cover——不补安全区内边距的话，
          输入框和发送键会落进 iPhone 的手势条区域，主操作被挡住或点不准。
          与右下角 launcher 用同一套写法（AskWidget 已经这么做了）。 */}
      <div
        style={{
          padding: 12,
          paddingBottom: isMobile ? 'calc(12px + env(safe-area-inset-bottom, 0px))' : 12,
          borderTop: '1px solid var(--border-faint)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            // 「问点什么…」没说清能问什么，用户会拿它当通用聊天框问页面外的事然后吃一句
            // 「页面里没有提到」。把范围写进 placeholder，问之前就知道边界。
            placeholder={refusal ? ASK_REFUSAL_REGISTRY[refusal].placeholder : '就这一页提个问题'}
            disabled={blocked}
            rows={1}
            // 与后端同一个上限。后端超长直接 400（不静默截断），这里把边界前移到打字时，
            // 用户不会写完一大段才被拒。
            maxLength={ASK_MAX_QUESTION_LENGTH}
            style={{
              flex: 1, resize: 'none', maxHeight: 120,
              padding: '9px 11px', borderRadius: 10,
              border: '1px solid var(--border-subtle)', background: 'var(--bg-input)',
              color: 'var(--text-primary)',
              // 16px 是 iOS 的临界值：小于它 Safari 会在聚焦时自动放大整个页面
              fontSize: 16,
              lineHeight: 1.5, outline: 'none', fontFamily: 'inherit',
            }}
          />
          <button
            onClick={() => submit(draft)}
            disabled={!draft.trim() || isBusy || blocked}
            aria-label="发送"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 38, height: 38, borderRadius: 10, border: 'none', flexShrink: 0,
              background: !draft.trim() || isBusy || blocked ? 'var(--bg-tertiary)' : 'var(--button-primary-bg)',
              color: !draft.trim() || isBusy || blocked ? 'var(--text-muted)' : 'var(--button-primary-fg)',
              cursor: !draft.trim() || isBusy || blocked ? 'default' : 'pointer',
            }}
          >
            {isBusy ? <MapSpinner size={14} /> : <Send size={15} />}
          </button>
        </div>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            {status === 'error' && gateError && !blocked
              ? gateError.message
              : '回答由 AI 生成，仅依据本页内容'}
          </span>
          {/* 只在快到上限时才出现：平时显示字数是噪音，接近边界时它才是有用的预期管理 */}
          {draft.length >= ASK_MAX_QUESTION_LENGTH - 50 && (
            <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {draft.length} / {ASK_MAX_QUESTION_LENGTH}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
