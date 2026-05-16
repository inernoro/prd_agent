import { useEffect, useMemo, useRef, useState } from 'react';
import { List } from 'lucide-react';
import { parseMarkdownToc } from '@/lib/markdownToc';

/**
 * F1：知识库文档预览右侧"本页章节"导航。
 *
 * - 解析当前 markdown 正文 h1-h6 生成目录（slug 规则复用 markdownToc，与正文 heading id 一致）
 * - 点击平滑滚动到对应标题
 * - 当前可视标题高亮（IntersectionObserver 观察 scrollContainer 内的 heading 元素）
 * - 无标题时不渲染该栏（空状态隐藏，符合 guided-exploration）
 * - 全部走主题 token，暗黑/白天均正常；窄屏由调用方隐藏
 */
export function DocToc({
  content,
  scrollContainerRef,
}: {
  content: string | null | undefined;
  scrollContainerRef: React.RefObject<HTMLElement>;
}) {
  const headings = useMemo(() => parseMarkdownToc(content), [content]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  useEffect(() => {
    if (headings.length === 0) return;
    const root = scrollContainerRef.current;
    if (!root) return;

    // 收集正文里实际存在的 heading 元素
    const elements = headings
      .map(h => root.querySelector<HTMLElement>(`#${cssEscape(h.id)}`))
      .filter((el): el is HTMLElement => !!el);
    if (elements.length === 0) return;

    // 记录每个 heading 当前是否在视口内，取最靠上的可见项为 active
    const visible = new Map<string, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          visible.set(entry.target.id, entry.isIntersecting);
        }
        // 选第一个仍可见的标题
        const firstVisible = elements.find(el => visible.get(el.id));
        if (firstVisible && firstVisible.id !== activeIdRef.current) {
          setActiveId(firstVisible.id);
        } else if (!firstVisible && elements.length > 0) {
          // 没有可见标题时（滚动在两个标题之间），保留最近经过的：
          // 取容器顶部之上最后一个标题
          const rootTop = root.getBoundingClientRect().top;
          let candidate: HTMLElement | null = null;
          for (const el of elements) {
            if (el.getBoundingClientRect().top <= rootTop + 80) candidate = el;
            else break;
          }
          if (candidate && candidate.id !== activeIdRef.current) {
            setActiveId(candidate.id);
          }
        }
      },
      {
        root,
        // 顶部留一点偏移，标题刚进入即视为 active
        rootMargin: '-8px 0px -70% 0px',
        threshold: 0,
      },
    );
    elements.forEach(el => observer.observe(el));
    // 初始化 active 为第一个
    setActiveId(prev => prev ?? elements[0].id);
    return () => observer.disconnect();
  }, [headings, scrollContainerRef]);

  if (headings.length === 0) return null;

  const minLevel = Math.min(...headings.map(h => h.level));

  const handleClick = (id: string) => {
    const root = scrollContainerRef.current;
    const target = root?.querySelector<HTMLElement>(`#${cssEscape(id)}`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveId(id);
    }
  };

  return (
    <nav
      className="hidden xl:flex flex-shrink-0 flex-col"
      style={{
        width: '210px',
        borderLeft: '1px solid var(--border-subtle)',
        minHeight: 0,
      }}
      aria-label="本页章节导航"
    >
      <div
        className="flex items-center gap-1.5 px-4 py-3"
        style={{ borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
      >
        <List size={12} />
        <span className="text-[11px] font-semibold tracking-wide">本页章节</span>
      </div>
      <div
        className="flex-1 overflow-y-auto py-2"
        style={{ minHeight: 0, overscrollBehavior: 'contain' }}
      >
        {headings.map((h, i) => {
          const isActive = h.id === activeId;
          return (
            <button
              key={`${h.id}-${i}`}
              onClick={() => handleClick(h.id)}
              className="block w-full text-left text-[11px] leading-snug truncate transition-colors duration-150 cursor-pointer"
              style={{
                paddingLeft: `${12 + (h.level - minLevel) * 12}px`,
                paddingRight: '12px',
                paddingTop: '4px',
                paddingBottom: '4px',
                borderLeft: isActive
                  ? '2px solid var(--accent-primary, var(--accent-gold))'
                  : '2px solid transparent',
                color: isActive ? 'var(--text-primary)' : 'var(--text-muted)',
                fontWeight: isActive ? 600 : 400,
                background: isActive ? 'var(--bg-input-hover)' : 'transparent',
              }}
              title={h.text}
            >
              {h.text}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** CSS.escape 兜底（部分老环境无 CSS.escape） */
function cssEscape(id: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(id);
  }
  return id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}
