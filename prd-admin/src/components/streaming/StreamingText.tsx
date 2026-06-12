import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { MapCursor } from './MapCursor';
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
   * 自定义 cursor 内容 (替换默认 MAP 品牌 M)
   * - 'map' (默认): <MapCursor /> 品牌 M 字母 + 发光, 全系统统一
   * - 'bar': 旧的 2px 竖条 (退化场景)
   * - 'dot': 0.55em 圆点
   * - ReactNode: 任意自定义 (SVG / lucide icon)
   *
   * 历史: 之前默认 'bar', 但用户反馈"|" 不够 brand identity, 全局改成 'map'
   * 让 17 处接入点自动品牌统一, 不再漏改。
   */
  cursorContent?: 'map' | 'bar' | 'dot' | ReactNode;
  /**
   * 只渲染文本最后 N 个字符 (尾部窗口). 超过时显示 "…<尾部>". key 仍使用绝对 offset
   * 防止 token span 因 substring offset 漂移导致内容互换 (闪烁) 或重复动画。
   *
   * 适用场景: 节点卡片 / 通知条等"只关心最新输出"的小框, 避免大文本导致几千 span 堆积。
   * 设计来源: EmergenceNode 修复"全文 span 爆炸把父节点挤飞" 这条 bug (2026-05-13)。
   */
  maxTailChars?: number;
  /**
   * 只对尾部 N 个字符做词级动画, 前缀作为稳定纯文本渲染。
   * 和 maxTailChars 不同: 它不截断内容, 只减少长文本流式输出时的 span 数量。
   */
  animateTailChars?: number;
  /** 块级渲染模式, 用于聊天气泡等需要明确换行/收缩边界的长文本容器 */
  block?: boolean;
  /** 外层 className */
  className?: string;
}

type Token = { kind: 'word' | 'ws' | 'br'; value: string; offset: number };

/**
 * 把全量文本拆成 token 序列, 每个 word 携带其在原文中的起始 offset 作为稳定 key
 * 这样当上游文本增长时, 已有的 span 不会被 React 当作新节点 remount, 不会重复触发动画
 *
 * offsetBase: 当 text 是某个更大文本的尾部子串时, 传入起始 offset
 * (让 token key 全局唯一, 避免滑窗时同 key 上挂不同内容)
 */
function tokenize(text: string, offsetBase = 0): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      out.push({ kind: 'br', value: '\n', offset: offsetBase + i });
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      let j = i;
      while (j < text.length && text[j] !== '\n' && /\s/.test(text[j])) j += 1;
      out.push({ kind: 'ws', value: text.slice(i, j), offset: offsetBase + i });
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
    out.push({ kind: 'word', value: text.slice(i, j), offset: offsetBase + i });
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
function renderCursor(content: 'map' | 'bar' | 'dot' | ReactNode): ReactNode {
  if (content === 'map' || content == null) {
    return (
      <span className="streaming-text-caret streaming-text-caret--custom" aria-hidden>
        <MapCursor />
      </span>
    );
  }
  if (content === 'bar') {
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

function renderPlainText(text: string): ReactNode {
  if (!text) return null;
  const lines = text.split('\n');
  return lines.map((line, index) => (
    <Fragment key={`plain-${index}`}>
      {index > 0 ? <br /> : null}
      {line}
    </Fragment>
  ));
}

export const StreamingText = memo(function StreamingText({
  text,
  streaming = false,
  mode = 'blur',
  markdown = false,
  renderMarkdown,
  cursor,
  cursorContent = 'map',
  maxTailChars,
  animateTailChars,
  block = false,
  className,
}: StreamingTextProps) {
  const showFinalMarkdown = markdown && !streaming && !!renderMarkdown;

  // 计算实际要 tokenize 的文本 + offset 基准
  // - 不限制时: tokenize 全文, offset 从 0 起
  // - 限制时: 只 tokenize 尾部 maxTailChars 个字符, 但 token offset 从 text.length - tail.length 起
  //   这样滑窗时 React 用绝对 offset 作 key, 已 mount 的 span 不会被复用造成"内容互换闪烁"
  const { staticPrefix, tokens } = useMemo(() => {
    if (showFinalMarkdown) return { staticPrefix: '', tokens: [] };
    const full = text || '';
    if (!maxTailChars || full.length <= maxTailChars) {
      if (animateTailChars && animateTailChars > 0 && full.length > animateTailChars) {
        const base = full.length - animateTailChars;
        return {
          staticPrefix: full.slice(0, base),
          tokens: tokenize(full.slice(base), base),
        };
      }
      return { staticPrefix: '', tokens: tokenize(full, 0) };
    }
    const base = full.length - maxTailChars;
    const tail = '…' + full.slice(base);
    // 首字符 '…' 占 1 字符, 后续真实字符 offset 从 base 开始
    // 用 base - 1 让 '…' 拿到稳定的负数 key, 后续 token offset 就是 absolute
    return { staticPrefix: '', tokens: tokenize(tail, base - 1) };
  }, [text, showFinalMarkdown, maxTailChars, animateTailChars]);

  const showCursor = cursor ?? streaming;

  if (showFinalMarkdown) {
    return (
      <div className={className}>
        {renderMarkdown!(text || '')}
      </div>
    );
  }

  return (
    <span
      className={`streaming-text streaming-text--${mode} ${block ? 'streaming-text--block' : ''} ${className ?? ''}`.trim()}
    >
      {renderPlainText(staticPrefix)}
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
