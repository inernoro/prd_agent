import { Fragment, memo, useMemo, type ReactNode } from 'react';
import './streaming.css';

export type StreamingMode = 'blur' | 'wordFade' | 'typewriter' | 'rise';

export interface StreamingTextProps {
  /** 已累积的全量文本 (不是 delta) */
  text: string;
  /** 是否仍在流式输出中, 控制光标与最终 markdown 切换 */
  streaming?: boolean;
  /** 动效模式, 默认 blur (Blur focus) */
  mode?: StreamingMode;
  /**
   * 是否为 markdown 内容:
   * - streaming=true 时仍按词级动画渲染纯文本 (避免每个 chunk 全量 markdown reflow)
   * - streaming=false 时调用 renderMarkdown 渲染最终 markdown
   */
  markdown?: boolean;
  /** 自定义 markdown 渲染器 (适配各页面已有的 ReactMarkdown 配置) */
  renderMarkdown?: (content: string) => ReactNode;
  /** 是否在末尾显示闪烁光标, 默认跟随 streaming */
  cursor?: boolean;
  /**
   * 自定义 cursor 内容 (替换默认 2px 竖条)
   * 传 ReactNode 即用该节点; 传 'bar' (默认) 用内置竖条; 传 'dot' 用圆点
   * 业务可传 SVG / lucide icon / 任意 JSX
   */
  cursorContent?: 'bar' | 'dot' | ReactNode;
  /** 外层 className */
  className?: string;
}

type Token = { kind: 'word' | 'ws' | 'br'; value: string; offset: number };

/**
 * 把全量文本拆成 token 序列, 每个 word 携带其在原文中的起始 offset 作为稳定 key
 * 这样当上游文本增长时, 已有的 span 不会被 React 当作新节点 remount, 不会重复触发动画
 */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      out.push({ kind: 'br', value: '\n', offset: i });
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      let j = i;
      while (j < text.length && text[j] !== '\n' && /\s/.test(text[j])) j += 1;
      out.push({ kind: 'ws', value: text.slice(i, j), offset: i });
      i = j;
      continue;
    }
    // 词边界: 累积到下一个空白/换行/标点为止; 但中文等表意文字按字符切, 让动画更细腻
    let j = i;
    while (j < text.length && !/\s/.test(text[j]) && text[j] !== '\n') {
      // 中日韩表意文字按单字切
      const code = text.charCodeAt(j);
      const isCJK =
        (code >= 0x3400 && code <= 0x9fff) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0x20000 && code <= 0x2ffff);
      if (isCJK && j > i) break;
      j += 1;
      if (isCJK) break;
    }
    out.push({ kind: 'word', value: text.slice(i, j), offset: i });
    i = j;
  }
  return out;
}

/**
 * 流式文本统一渲染组件
 *
 * 用法:
 * ```tsx
 * <StreamingText text={accumulated} streaming={isStreaming} />
 * <StreamingText text={accumulated} streaming={isStreaming} markdown renderMarkdown={c => <MyMd>{c}</MyMd>} />
 * <StreamingText text={accumulated} streaming={isStreaming} mode="wordFade" />
 * ```
 *
 * 设计来源: Claude Design Streaming text - Blur focus pattern
 */
function renderCursor(content: 'bar' | 'dot' | ReactNode): ReactNode {
  if (content === 'bar' || content == null) {
    return <span className="streaming-text-caret streaming-text-caret--bar" aria-hidden />;
  }
  if (content === 'dot') {
    return <span className="streaming-text-caret streaming-text-caret--dot" aria-hidden />;
  }
  return (
    <span className="streaming-text-caret streaming-text-caret--custom" aria-hidden>
      {content}
    </span>
  );
}

export const StreamingText = memo(function StreamingText({
  text,
  streaming = false,
  mode = 'blur',
  markdown = false,
  renderMarkdown,
  cursor,
  cursorContent = 'bar',
  className,
}: StreamingTextProps) {
  const showFinalMarkdown = markdown && !streaming && !!renderMarkdown;
  const tokens = useMemo(() => (showFinalMarkdown ? [] : tokenize(text || '')), [text, showFinalMarkdown]);
  const showCursor = cursor ?? streaming;

  if (showFinalMarkdown) {
    return (
      <div className={className}>
        {renderMarkdown!(text || '')}
      </div>
    );
  }

  return (
    <span className={`streaming-text streaming-text--${mode} ${className ?? ''}`.trim()}>
      {tokens.map((tok) => {
        if (tok.kind === 'br') return <br key={`br-${tok.offset}`} />;
        if (tok.kind === 'ws') return <Fragment key={`ws-${tok.offset}`}>{tok.value}</Fragment>;
        return (
          <span className="streaming-u" key={`w-${tok.offset}`}>
            {tok.value}
          </span>
        );
      })}
      {showCursor ? renderCursor(cursorContent) : null}
    </span>
  );
});
