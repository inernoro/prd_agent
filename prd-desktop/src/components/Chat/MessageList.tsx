import { useRef, useEffect } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import { usePrdCitationPreviewStore } from '../../stores/prdCitationPreviewStore';
import { usePrdPreviewNavStore } from '../../stores/prdPreviewNavStore';
import type { MessageBlock } from '../../types';
import MarkdownRenderer from '../Markdown/MarkdownRenderer';

const phaseText: Record<string, string> = {
  requesting: '正在请求大模型…',
  connected: '已连接，等待首包…',
  receiving: '正在接收信息…',
  typing: '开始输出…',
};

function ThinkingIndicator({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-text-secondary">
      <span className="inline-flex items-center gap-1" aria-label={label || '处理中'}>
        <span className="h-1.5 w-1.5 rounded-full bg-primary-500 animate-bounce" style={{ animationDelay: '0ms' }} />
        <span className="h-1.5 w-1.5 rounded-full bg-primary-500 animate-bounce" style={{ animationDelay: '120ms' }} />
        <span className="h-1.5 w-1.5 rounded-full bg-primary-500 animate-bounce" style={{ animationDelay: '240ms' }} />
      </span>
      {label ? <span>{label}</span> : null}
    </div>
  );
}

function unwrapMarkdownFences(text: string) {
  if (!text) return text;
  // 兼容：LLM 常用 ```markdown / ```md 包裹“本来就想渲染的 Markdown”，会被当作代码块显示
  // 这里仅解包 markdown/md 语言标记，其它代码块保持不动
  return text.replace(/```(?:markdown|md)\s*\n([\s\S]*?)\n```/g, '$1');
}

function injectSectionNumberLinks(raw: string) {
  if (!raw) return raw;
  // 避免重复注入
  if (raw.includes('](prd-nav:') || raw.includes('](prd-nav://')) return raw;

  // 支持形如：
  // - （章节4.2，4.3）
  // - (章节 4.2, 4.3)
  // - （4.2，4.3）
  // 目标：把每个章节号变成内部链接，点击后用 title 去预览页匹配（包含匹配即可命中 “4.2 xxx”）
  const re = /[（(]\s*(?:章节\s*)?(\d+(?:\.\d+){0,3})(?:\s*[,，、]\s*(\d+(?:\.\d+){0,3}))*\s*[）)]/g;
  return raw.replace(re, (m) => {
    // 抽取全部数字（不依赖捕获组数量）
    const nums = (m.match(/\d+(?:\.\d+){0,3}/g) || []).slice(0, 8);
    if (nums.length === 0) return m;
    const left = m.trim().startsWith('(') ? '(' : '（';
    const right = m.trim().endsWith(')') ? ')' : '）';
    const sep = m.includes('、') ? '、' : (m.includes('，') ? '，' : ', ');
    const prefix = /章节/.test(m) ? '章节' : '';
    const linked = nums.map((n, i) => {
      const label = `${prefix}${n}`;
      const href = `prd-nav:${n}`;
      // prefix 只在第一个展示，避免 “章节4.2，章节4.3”
      const show = i === 0 ? label : n;
      return `[${show}](${href})`;
    }).join(sep);
    return `${left}${linked}${right}`;
  });
}

/**
 * 将回答中的“来源：...”行改造成可点击的章节来源标记（chip）。
 * 目标形态（示例）：
 *   来源： [1.2.3](prd-nav:1.2.3) 文本理解的天然效率上限。
 *   来源： [7.3](prd-nav:7.3) LLM支持、[4.1](prd-nav:4.1) 文档上传与解析…
 *
 * 说明：不依赖后端 citations；若 citations 存在，仍可通过点击底部“来源”或引用抽屉导航查看摘录。
 */
function injectSourceLines(raw: string) {
  if (!raw) return raw;
  // 避免重复注入
  if (raw.includes('prd-source-line:1')) return raw;

  const toChip = (numRaw: string, titleRaw?: string) => {
    const num = String(numRaw || '').trim().replace(/\.$/, ''); // 兼容 "11."
    if (!num) return numRaw;
    const title = String(titleRaw || '').trim();
    // markdown link title：ReactMarkdown 会传到 a renderer 的 title
    const titlePart = title ? ` "${title.replace(/"/g, '\\"')}"` : '';
    return `[${num}](prd-nav:${num}${titlePart})`;
  };

  const lines = String(raw).split('\n');
  const out: string[] = [];
  for (const line of lines) {
    // 允许缩进/列表项前缀：- 来源： / • 来源： / * 来源：
    const m = /^(\s*(?:[-*•]\s*)?)来源\s*[:：]\s*(.+)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const prefix = m[1] || '';
    const rest = (m[2] || '').trim();
    if (!rest) {
      out.push(line);
      continue;
    }

    // 策略：优先匹配 “编号 + 空格 + 标题片段”
    // - 编号形态：11 / 7.3 / 1.2.3 / 11.
    // - 标题片段：直到遇到分隔符（，、,；;）或行尾
    const re = /(\d+(?:\.\d+){0,3}\.?)\s*([^\s，、,；;]+[^\n，、,；;]*)?/g;
    let next = rest;
    // 仅对来源行做替换：把每个编号替换成 chip；如果紧跟着标题，则把标题放到 chip 的 title 里
    next = next.replace(re, (all, n, t) => {
      // 防止误把年份/数量当来源：来源行里一般不会出现 2025 这种，但仍限制长度
      const num = String(n || '').trim();
      if (!num) return all;
      // 如果标题看起来是“纯连接词”，忽略
      const title = String(t || '').trim();
      return toChip(num, title);
    });

    // 用 data 行标记避免重复注入
    out.push(`${prefix}来源： ${next} <!-- prd-source-line:1 -->`);
  }
  return out.join('\n');
}

function parseCitationIndexFromHref(href: string) {
  const h = String(href || '');
  if (!h.startsWith('prd-citation:') && !h.startsWith('prd-citation://')) return null;
  const idxStr = h.replace('prd-citation://', 'prd-citation:').split(':')[1] || '';
  const idx = Number(idxStr);
  return Number.isFinite(idx) ? idx : null;
}

function parseNavTitleFromHref(href: string) {
  const h = String(href || '');
  if (!h.startsWith('prd-nav:') && !h.startsWith('prd-nav://')) return null;
  const t = h.replace('prd-nav://', 'prd-nav:').slice('prd-nav:'.length);
  const title = String(t || '').trim();
  return title ? title : null;
}

export default function MessageList() {
  const { messages, isStreaming, streamingMessageId, streamingPhase, isPinnedToBottom, setPinnedToBottom } = useMessageStore();
  const { sessionId, activeGroupId, document: prdDocument } = useSessionStore();
  const openCitationDrawer = usePrdCitationPreviewStore((s) => s.open);
  const openWithCitations = usePrdPreviewNavStore((s) => s.openWithCitations);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const extractNavNumbers = (content: string) => {
    const s = String(content || '');
    const re = /prd-nav:(\d+(?:\.\d+){0,3})/g;
    const set = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      const n = String(m[1] || '').trim();
      if (n) set.add(n);
      if (set.size >= 30) break;
    }
    return Array.from(set);
  };

  // 记录用户是否“锁定在底部”：用于从预览页返回时恢复到最新对话
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let raf: number | null = null;
    const onScroll = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        // 近底阈值稍微放宽，避免用户轻微滚动就“解锁”
        setPinnedToBottom(distanceToBottom < 180);
      });
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    // mount 时立即同步一次（防止初始状态不一致）
    onScroll();
    return () => {
      el.removeEventListener('scroll', onScroll as EventListener);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [setPinnedToBottom]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // 若用户“锁底”，则无条件滚到最新；否则沿用“接近底部才滚动”的策略
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distanceToBottom < 140;
    if (!isPinnedToBottom && !isNearBottom) return;

    // 流式期间使用 auto，避免高频 smooth scroll 导致主线程卡顿
    bottomRef.current?.scrollIntoView({ behavior: isStreaming ? 'auto' : 'smooth' });
  }, [messages, isStreaming, streamingMessageId, isPinnedToBottom]);

  // 重挂载（例如从预览页返回）时：如果用户此前锁底，则直接滚到最新
  useEffect(() => {
    if (!isPinnedToBottom) return;
    if (!messages || messages.length === 0) return;
    const raf = requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={containerRef} className="h-full overflow-y-auto p-4 space-y-4">
      {messages.map((message) => {
        const assistantCitations =
          message.role === 'Assistant' && Array.isArray(message.citations) ? message.citations : [];

        const renderedAssistantContent = message.role === 'Assistant'
          ? injectSourceLines(injectSectionNumberLinks(unwrapMarkdownFences(message.content)))
          : message.content;

        const navNumbers = message.role === 'Assistant' ? extractNavNumbers(renderedAssistantContent) : [];
        const citationsCount = Math.min(assistantCitations.length, 30);
        const sourcesCount = citationsCount > 0 ? citationsCount : navNumbers.length;
        const hasSources = message.role === 'Assistant' && sourcesCount > 0;

        return (
          <div
            key={message.id}
            className={`flex ${message.role === 'User' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] p-4 rounded-2xl ${
                message.role === 'User'
                  ? 'bg-primary-500 text-white rounded-br-md'
                  : 'bg-surface-light dark:bg-surface-dark border border-border rounded-bl-md'
              }`}
            >
            {message.role === 'User' ? (
              <p className="whitespace-pre-wrap">{message.content}</p>
            ) : (
              <div>
                {isStreaming &&
                streamingMessageId === message.id &&
                streamingPhase &&
                streamingPhase !== 'typing' ? (
                  <div className="mb-2">
                    <ThinkingIndicator label={phaseText[streamingPhase] || '处理中…'} />
                  </div>
                ) : null}
                {/* Block Protocol：按块渲染，流式期间也能稳定 Markdown 排版 */}
                {Array.isArray(message.blocks) && message.blocks.length > 0 ? (
                  // 非流式阶段：用整段 message.content 统一渲染，避免分块导致“列表/编号/段落上下文”丢失
                  !(isStreaming && streamingMessageId === message.id) ? (
                    <MarkdownRenderer
                      className="prose prose-sm dark:prose-invert max-w-none"
                      content={renderedAssistantContent}
                      citations={assistantCitations ?? []}
                      onOpenCitation={(idx) => {
                        if (!activeGroupId || !prdDocument?.id) return;
                        const citations = assistantCitations ?? [];
                        if (!citations.length) return;
                        const safeIdx = Math.max(0, Math.min(citations.length - 1, idx));
                        const c = citations[safeIdx];
                        const targetHeadingId = (c?.headingId || '').trim();
                        const targetHeadingTitle = (c?.headingTitle || '').trim();
                        openWithCitations({
                          targetHeadingId: targetHeadingId || null,
                          targetHeadingTitle: targetHeadingTitle || null,
                          citations,
                          activeCitationIndex: safeIdx,
                        });
                        openCitationDrawer({
                          documentId: prdDocument.id,
                          groupId: activeGroupId,
                          targetHeadingId: targetHeadingId || null,
                          targetHeadingTitle: targetHeadingTitle || null,
                          citations,
                          activeCitationIndex: safeIdx,
                        });
                      }}
                      onInternalLinkClick={(href) => {
                        const idx = parseCitationIndexFromHref(href);
                        const navTitle = parseNavTitleFromHref(href);
                        if (idx == null && !navTitle) return;
                        const citations = assistantCitations ?? [];
                        if (!activeGroupId || !prdDocument?.id) return true;
                        if (idx != null && citations.length > 0) {
                          const c = citations[Math.max(0, Math.min(citations.length - 1, idx))];
                          const targetHeadingId = (c?.headingId || '').trim();
                          const targetHeadingTitle = (c?.headingTitle || '').trim();
                          openWithCitations({
                            targetHeadingId: targetHeadingId || null,
                            targetHeadingTitle: targetHeadingTitle || null,
                            citations: citations ?? [],
                            activeCitationIndex: idx,
                          });
                          openCitationDrawer({
                            documentId: prdDocument.id,
                            groupId: activeGroupId,
                            targetHeadingId: targetHeadingId || null,
                            targetHeadingTitle: targetHeadingTitle || null,
                            citations: citations ?? [],
                            activeCitationIndex: idx,
                          });
                          return true;
                        }
                        // 无 citations：按章节号/文本跳转
                        openWithCitations({
                          targetHeadingId: null,
                          targetHeadingTitle: navTitle || null,
                          citations: citations ?? [],
                          activeCitationIndex: 0,
                        });
                        openCitationDrawer({
                          documentId: prdDocument.id,
                          groupId: activeGroupId,
                          targetHeadingId: null,
                          targetHeadingTitle: navTitle || null,
                          citations: citations ?? [],
                          activeCitationIndex: 0,
                        });
                        return true;
                      }}
                    />
                  ) : (
                    <div className="space-y-2">
                      {message.blocks.map((b: MessageBlock) => (
                        <div key={b.id} className="prose prose-sm dark:prose-invert max-w-none">
                          {b.kind === 'codeBlock' ? (
                            // 如果后端/模型标记为 markdown 代码块，用户通常期望“按 Markdown 渲染”而不是当代码展示
                            (b.language === 'markdown' || b.language === 'md') ? (
                              <MarkdownRenderer content={unwrapMarkdownFences(b.content)} />
                            ) : (
                              <pre className="overflow-x-auto rounded-md border border-border bg-gray-50 dark:bg-gray-900 p-3">
                                <code className="whitespace-pre">{b.content}</code>
                              </pre>
                            )
                          ) : (
                            // 流式过程中 markdown 语法常常未闭合（列表/表格/引用等），会导致样式“缺一截”
                            // 因此：未完成的 block 先纯文本展示，blockEnd 后再用 ReactMarkdown 渲染
                            b.isComplete === false ? (
                              <p className="whitespace-pre-wrap break-words">{b.content}</p>
                            ) : (
                              <MarkdownRenderer content={unwrapMarkdownFences(b.content)} />
                            )
                          )}
                        </div>
                      ))}
                    </div>
                  )
                ) : (
                  // 兼容旧协议：无 blocks 时沿用原逻辑（流式阶段先纯文本，done 后 markdown）
                  isStreaming && streamingMessageId === message.id ? (
                    <div>
                      <p className="whitespace-pre-wrap break-words">{message.content}</p>
                    </div>
                  ) : (
                    <MarkdownRenderer
                      className="prose prose-sm dark:prose-invert max-w-none"
                      content={renderedAssistantContent}
                      citations={assistantCitations ?? []}
                      onOpenCitation={(idx) => {
                        if (!activeGroupId || !prdDocument?.id) return;
                        const citations = assistantCitations ?? [];
                        if (!citations.length) return;
                        const safeIdx = Math.max(0, Math.min(citations.length - 1, idx));
                        const c = citations[safeIdx];
                        const targetHeadingId = (c?.headingId || '').trim();
                        const targetHeadingTitle = (c?.headingTitle || '').trim();
                        openWithCitations({
                          targetHeadingId: targetHeadingId || null,
                          targetHeadingTitle: targetHeadingTitle || null,
                          citations,
                          activeCitationIndex: safeIdx,
                        });
                        openCitationDrawer({
                          documentId: prdDocument.id,
                          groupId: activeGroupId,
                          targetHeadingId: targetHeadingId || null,
                          targetHeadingTitle: targetHeadingTitle || null,
                          citations,
                          activeCitationIndex: safeIdx,
                        });
                      }}
                      onInternalLinkClick={(href) => {
                        const idx = parseCitationIndexFromHref(href);
                        const navTitle = parseNavTitleFromHref(href);
                        if (idx == null && !navTitle) return;
                        const citations = assistantCitations ?? [];
                        if (!activeGroupId || !prdDocument?.id) return true;
                        if (idx != null && citations.length > 0) {
                          const c = citations[Math.max(0, Math.min(citations.length - 1, idx))];
                          const targetHeadingId = (c?.headingId || '').trim();
                          const targetHeadingTitle = (c?.headingTitle || '').trim();
                          openWithCitations({
                            targetHeadingId: targetHeadingId || null,
                            targetHeadingTitle: targetHeadingTitle || null,
                            citations: citations ?? [],
                            activeCitationIndex: idx,
                          });
                          openCitationDrawer({
                            documentId: prdDocument.id,
                            groupId: activeGroupId,
                            targetHeadingId: targetHeadingId || null,
                            targetHeadingTitle: targetHeadingTitle || null,
                            citations: citations ?? [],
                            activeCitationIndex: idx,
                          });
                          return true;
                        }
                        // 无 citations：按章节号/文本跳转
                        openWithCitations({
                          targetHeadingId: null,
                          targetHeadingTitle: navTitle || null,
                          citations: citations ?? [],
                          activeCitationIndex: 0,
                        });
                        openCitationDrawer({
                          documentId: prdDocument.id,
                          groupId: activeGroupId,
                          targetHeadingId: null,
                          targetHeadingTitle: navTitle || null,
                          citations: citations ?? [],
                          activeCitationIndex: 0,
                        });
                        return true;
                      }}
                    />
                  )
                )}
              </div>
            )}

            {hasSources ? (
              <div className="mt-3 pt-2">
                <button
                  type="button"
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] leading-5 border border-border bg-background-light/40 dark:bg-background-dark/30 text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 hover:bg-gray-50 dark:hover:bg-white/10"
                  title="查看本条回复的来源（右侧展开）"
                  onClick={() => {
                    if (!activeGroupId || !prdDocument?.id) return;
                    const citations = assistantCitations ?? [];
                    if (citations.length > 0) {
                      const c0 = citations[0];
                      const targetHeadingId = (c0?.headingId || '').trim();
                      const targetHeadingTitle = (c0?.headingTitle || '').trim();
                      openWithCitations({
                        targetHeadingId: targetHeadingId || null,
                        targetHeadingTitle: targetHeadingTitle || null,
                        citations,
                        activeCitationIndex: 0,
                      });
                      openCitationDrawer({
                        documentId: prdDocument.id,
                        groupId: activeGroupId,
                        targetHeadingId: targetHeadingId || null,
                        targetHeadingTitle: targetHeadingTitle || null,
                        citations,
                        activeCitationIndex: 0,
                      });
                      return;
                    }
                    const first = (navNumbers[0] || '').trim();
                    if (!first) return;
                    openWithCitations({
                      targetHeadingId: null,
                      targetHeadingTitle: first,
                      citations: [],
                      activeCitationIndex: 0,
                    });
                    openCitationDrawer({
                      documentId: prdDocument.id,
                      groupId: activeGroupId,
                      targetHeadingId: null,
                      targetHeadingTitle: first,
                      citations: [],
                      activeCitationIndex: 0,
                    });
                  }}
                >
                  来源（{sourcesCount}）
                </button>
              </div>
            ) : null}

            {isStreaming && streamingMessageId === message.id && (
              <span className="inline-block w-2 h-4 bg-primary-500 animate-pulse ml-1" />
            )}
            
            {message.senderName && (
              <p className="text-xs opacity-70 mt-2">
                {message.senderName} · {message.viewRole}
              </p>
            )}
            </div>
          </div>
        );
      })}

      {messages.length === 0 && !isStreaming && (
        <div className="h-full flex items-center justify-center text-text-secondary">
          <div className="text-center">
            <div className="w-12 h-12 mx-auto mb-3 bg-primary-100 dark:bg-primary-900/30 rounded-full flex items-center justify-center">
              <svg className="w-6 h-6 text-primary-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
              </svg>
            </div>
            {!sessionId && activeGroupId ? (
              <>
                <p className="text-lg mb-2">待上传</p>
                <p className="text-sm">该群组未绑定 PRD，无法进行对话。</p>
                <p className="text-xs mt-2 text-text-secondary">
                  请在左侧选择/上传 PRD，并点击{' '}
                  <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event('prdAgent:openBindPrdPicker'))}
                    className="underline hover:text-primary-500"
                    title="上传并绑定 PRD"
                  >
                    上传 PRD 并绑定到当前群组
                  </button>
                </p>
              </>
            ) : (
              <>
                <p className="text-lg mb-2">你好!</p>
                <p className="text-sm">有什么关于这份PRD的问题，尽管问我</p>
              </>
            )}
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
