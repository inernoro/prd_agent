import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Lightbulb } from 'lucide-react';
import type { ArticleBlock, ArticleMedia } from './types';

const CALLOUT_ICON = { tip: Lightbulb, warn: AlertTriangle } as const;

function Block({ block }: { block: ArticleBlock }) {
  switch (block.type) {
    case 'h2': return <h2 id={block.id} data-toc={block.id}>{block.text}</h2>;
    case 'p': return <p>{block.text}</p>;
    case 'list': return <ul>{block.items.map(item => <li key={item}>{item}</li>)}</ul>;
    case 'code': return <figure><pre className="lc-mono"><code>{block.code}</code></pre>{block.caption && <figcaption>{block.caption}</figcaption>}</figure>;
    case 'figure': return <figure className="my-4"><img src={block.imageUrl} alt={block.caption} /><figcaption>{block.caption}</figcaption></figure>;
    case 'callout': {
      const Icon = CALLOUT_ICON[block.tone];
      return (
        <div className="lc-callout" data-tone={block.tone}>
          <div className="flex items-center gap-2 font-semibold text-[14px]" style={{ color: 'var(--text-primary)' }}><Icon size={15} />{block.title}</div>
          <div className="text-[14px] mt-1">{block.text}</div>
        </div>
      );
    }
  }
}

/* 图文：阅读栏 + 目录（随滚动高亮）。读到底记为读完。 */
export function ArticleLesson({ article, onFinished }: { article: ArticleMedia; onFinished: () => void }) {
  const toc = article.blocks.filter((b): b is Extract<ArticleBlock, { type: 'h2' }> => b.type === 'h2');
  const [active, setActive] = useState<string | undefined>(toc[0]?.id);
  const [finished, setFinished] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = () => {
      let current: string | undefined = toc[0]?.id;
      el.querySelectorAll<HTMLElement>('[data-toc]').forEach(h => { if (h.offsetTop - el.scrollTop <= 80) current = h.dataset.toc; });
      setActive(current);
      if (!finished && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) { setFinished(true); onFinished(); }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [finished, onFinished, toc]);

  return (
    <div className="flex gap-4 h-full min-h-0" data-lc-ready="article">
      <div ref={box} className="lc-scroll flex-1 lc-surface px-5 md:px-8 py-2" data-lc="article">
        <article className="lc-article pb-8">
          {article.blocks.map((b, i) => <Block key={i} block={b} />)}
          <div className="flex items-center gap-2 text-[13px] mt-8 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <button type="button" className="inline-flex items-center gap-2 min-h-[44px] px-1" data-lc="article-end" data-finished={finished}
              style={{ color: finished ? 'var(--accent-fg-success)' : 'var(--text-muted)' }}
              onClick={() => { if (!finished) { setFinished(true); onFinished(); } }}>
              <CheckCircle2 size={15} />{finished ? '本篇已读完，进度已记下' : '读到这里就算读完，也可以点这里记下'}
            </button>
          </div>
        </article>
      </div>
      {toc.length > 1 && (
        <nav className="hidden xl:flex flex-col shrink-0 pt-2" style={{ width: 180 }} aria-label="本篇目录">
          <div className="lc-eyebrow px-2.5 pb-2">本篇目录</div>
          {toc.map(h => (
            <a key={h.id} className="lc-toc-link" aria-current={active === h.id} href={`#${h.id}`} onClick={e => {
              e.preventDefault();
              const target = box.current?.querySelector<HTMLElement>(`[data-toc="${h.id}"]`);
              if (target && box.current) box.current.scrollTo({ top: target.offsetTop - 8, behavior: 'smooth' });
            }}>{h.text}</a>
          ))}
        </nav>
      )}
    </div>
  );
}
