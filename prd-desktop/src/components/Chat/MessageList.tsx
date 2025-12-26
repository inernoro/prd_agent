import { useRef, useEffect } from 'react';
import { useMessageStore } from '../../stores/messageStore';
import { useSessionStore } from '../../stores/sessionStore';
import { usePrdCitationPreviewStore } from '../../stores/prdCitationPreviewStore';
import { usePrdPreviewNavStore } from '../../stores/prdPreviewNavStore';
import type { DocCitation, MessageBlock } from '../../types';
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

function escRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 将 LLM 输出中的「(标题) / （标题）」替换为可点击的 markdown 链接，
 * 以便点击后打开右侧“引用预览抽屉”。
 */
function injectCitationLinks(raw: string, citations: DocCitation[]) {
  const list = Array.isArray(citations) ? citations.slice(0, 30) : [];
  if (!raw || list.length === 0) return raw;
  // 避免重复注入（例如 message 复渲染）
  if (raw.includes('](prd-citation:') || raw.includes('](prd-citation://')) return raw;

  let next = raw;
  // 先按标题长度降序，避免短标题先替换导致长标题匹配失败
  const items = list
    .map((c, idx) => ({ idx, title: String(c?.headingTitle || '').trim(), hid: String(c?.headingId || '').trim() }))
    .filter((x) => x.title || x.hid)
    .sort((a, b) => (b.title.length + b.hid.length) - (a.title.length + a.hid.length));

  for (const it of items) {
    const variants = Array.from(
      new Set(
        [it.title, it.hid]
          .map((s) => String(s || '').trim())
          .filter(Boolean)
          .flatMap((s) => [`（${s}）`, `(${s})`])
      )
    );
    for (const v of variants) {
      // 仅替换“完整括号项”，减少误伤
      const re = new RegExp(escRegExp(v), 'g');
      // 链接文本保留原括号形式，href 只带索引
      next = next.replace(re, `[${v}](prd-citation:${it.idx})`);
    }
  }
  return next;
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
      {messages.map((message) => (
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
                      content={injectCitationLinks(
                        injectSectionNumberLinks(unwrapMarkdownFences(message.content)),
                        message.role === 'Assistant' ? (message.citations ?? []) : []
                      )}
                      onInternalLinkClick={(href) => {
                        const idx = parseCitationIndexFromHref(href);
                        const navTitle = parseNavTitleFromHref(href);
                        if (idx == null && !navTitle) return;
                        const citations = Array.isArray(message.citations) ? message.citations : [];
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
                      content={injectCitationLinks(
                        injectSectionNumberLinks(unwrapMarkdownFences(message.content)),
                        message.role === 'Assistant' ? (message.citations ?? []) : []
                      )}
                      onInternalLinkClick={(href) => {
                        const idx = parseCitationIndexFromHref(href);
                        const navTitle = parseNavTitleFromHref(href);
                        if (idx == null && !navTitle) return;
                        const citations = Array.isArray(message.citations) ? message.citations : [];
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

            {message.role === 'Assistant' && Array.isArray(message.citations) && message.citations.length > 0 ? (
              <div className="mt-3 pt-2">
                <button
                  type="button"
                  className="text-[11px] text-text-secondary hover:text-primary-600 dark:hover:text-primary-300 underline underline-offset-2"
                  title="查看本条回复引用内容（右侧展开）"
                  onClick={() => {
                    const citations = Array.isArray(message.citations) ? message.citations : [];
                    if (citations.length === 0) return;
                    const c0 = citations[0];
                    const targetHeadingId = (c0?.headingId || '').trim();
                    const targetHeadingTitle = (c0?.headingTitle || '').trim();
                    if (!activeGroupId || !prdDocument?.id) return;
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
                  }}
                >
                  查看引用（{Math.min(message.citations.length, 30)}）
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
      ))}

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
