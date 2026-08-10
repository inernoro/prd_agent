import { useCallback, useEffect, useRef, useState } from 'react';
import { LogIn, Send, Sparkles, X } from 'lucide-react';
import { StreamingText } from '@/components/streaming/StreamingText';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { useAuthStore } from '@/stores/authStore';
import { ASK_ERROR_CODES, type AskSource } from './askTypes';
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
}

/**
 * 提问面板本体。用抽屉而不是气泡：气泡会盖住 PPT 类托管页右下角的翻页控件，
 * 而托管内容里 reveal.js 幻灯片恰恰是最常见的形态之一。
 */
export default function AskPanel({
  source, title, welcome, openingQuestions, allowAnonymous, onClose, isMobile, embedded,
}: Props) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { messages, status, phaseMessage, model, gateError, isBusy, ask } = useAskStream(source);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const needLogin = !isAuthenticated && !allowAnonymous;

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
      if (!q || isBusy || needLogin) return;
      setDraft('');
      void ask(q);
    },
    [ask, isBusy, needLogin],
  );

  const showOpening = messages.length === 0 && openingQuestions.length > 0 && !needLogin;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--panel-solid, var(--bg-elevated))',
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

      {/* 消息区 */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
        {messages.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            {welcome?.trim() || `关于「${title}」，有什么想了解的？`}
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>
              回答只依据这个页面的内容。
            </div>
          </div>
        )}

        {showOpening && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
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

        {needLogin && (
          <div
            style={{
              marginTop: 14, padding: 12, borderRadius: 10,
              border: '1px solid var(--border-subtle)', background: 'var(--bg-card)',
              fontSize: 13, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <LogIn size={15} style={{ flexShrink: 0 }} />
            这个页面需要登录后才能提问。
          </div>
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
                  <StreamingText text={m.content} streaming={!!m.streaming} markdown />
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

        {gateError && gateError.code === ASK_ERROR_CODES.quotaExceeded && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-muted)' }}>
            {gateError.message}
          </div>
        )}
      </div>

      {/* 输入区 */}
      <div style={{ padding: 12, borderTop: '1px solid var(--border-faint)', flexShrink: 0 }}>
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
            placeholder={needLogin ? '登录后即可提问' : '问点什么…'}
            disabled={needLogin}
            rows={1}
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
            disabled={!draft.trim() || isBusy || needLogin}
            aria-label="发送"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 38, height: 38, borderRadius: 10, border: 'none', flexShrink: 0,
              background: !draft.trim() || isBusy || needLogin ? 'var(--bg-tertiary)' : 'var(--button-primary-bg)',
              color: !draft.trim() || isBusy || needLogin ? 'var(--text-muted)' : 'var(--button-primary-fg)',
              cursor: !draft.trim() || isBusy || needLogin ? 'default' : 'pointer',
            }}
          >
            {isBusy ? <MapSpinner size={14} /> : <Send size={15} />}
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
          {status === 'error' && gateError && gateError.code !== ASK_ERROR_CODES.quotaExceeded
            ? gateError.message
            : '回答由 AI 生成，仅依据本页内容'}
        </div>
      </div>
    </div>
  );
}
