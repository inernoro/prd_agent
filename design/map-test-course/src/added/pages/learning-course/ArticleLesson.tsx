import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Lightbulb } from 'lucide-react';
import { Desk } from './Desk';
import type { ArticleBlock, ArticleMedia } from './types';

const NOTE_ICON = { tip: Lightbulb, warn: AlertTriangle } as const;

function Block({ block, first, no }: { block: ArticleBlock; first: boolean; no?: number }) {
  switch (block.type) {
    case 'h2': return <h2 id={block.id} data-toc={block.id} data-no={no}>{block.text.replace(/^[一二三四五六七八九十]+、/, '')}</h2>;
    case 'p': return <p className={first ? 'lc-lede' : undefined}>{block.text}</p>;
    case 'list': return <ul>{block.items.map(x => <li key={x}>{x}</li>)}</ul>;
    case 'code': return <figure><pre className="lc-mono"><code>{block.code}</code></pre>{block.caption && <figcaption>{block.caption}</figcaption>}</figure>;
    case 'figure': return <figure className="my-5"><img src={block.imageUrl} alt={block.caption} /><figcaption>{block.caption}</figcaption></figure>;
    case 'callout': {
      const Icon = NOTE_ICON[block.tone];
      return <div className="lc-note" data-tone={block.tone}><div className="flex items-center gap-2 t-strong"><Icon size={16} />{block.title}</div><div className="mt-1 t-mute">{block.text}</div></div>;
    }
  }
}

/* 图文：舒展的阅读栏；伴读栏是编号目录与阅读进度。读到底或点文末记为读完。 */
export function ArticleLesson({ article, head, keyPoints, ticket, onFinished }: { article: ArticleMedia; head: ReactNode; keyPoints: string[]; ticket: ReactNode; onFinished: () => void }) {
  const toc = article.blocks.filter((b): b is Extract<ArticleBlock, { type: 'h2' }> => b.type === 'h2');
  const [active, setActive] = useState<string | undefined>(toc[0]?.id);
  const [pct, setPct] = useState(0);
  const [finished, setFinished] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const finish = () => { if (!finished) { setFinished(true); onFinished(); } };

  useEffect(() => {
    const el = box.current; if (!el) return;
    const onScroll = () => {
      let cur: string | undefined = toc[0]?.id;
      el.querySelectorAll<HTMLElement>('[data-toc]').forEach(h => { if (h.offsetTop - el.scrollTop <= 90) cur = h.dataset.toc; });
      setActive(cur);
      const max = el.scrollHeight - el.clientHeight;
      setPct(max > 0 ? Math.round((el.scrollTop / max) * 100) : 100);
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) finish();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  });

  let h = 0;
  const stage = (
    <div ref={box} className="lc-scroll h-full" data-lc="article">
      <article className="lc-article">
        {article.blocks.map((b, i) => <Block key={i} block={b} first={i === 0} no={b.type === 'h2' ? ++h : undefined} />)}
        <button type="button" className="lc-finish" data-lc="article-end" data-finished={finished} onClick={finish}>
          <CheckCircle2 size={18} />{finished ? '本篇已读完，进度已记下' : '读到这里就算读完，也可以点这里记下'}
        </button>
      </article>
    </div>
  );
  const companion = (
    <div className="flex flex-col gap-0.5">
      {toc.map(t => (
        <button key={t.id} type="button" className="lc-toc" aria-current={active === t.id} onClick={() => {
          const target = box.current?.querySelector<HTMLElement>(`[data-toc="${t.id}"]`);
          if (target && box.current) box.current.scrollTo({ top: target.offsetTop - 12, behavior: 'smooth' });
        }}>{t.text.replace(/^[一二三四五六七八九十]+、/, '')}</button>
      ))}
      <div className="px-3 pt-3">
        <div className="flex justify-between t-meta lc-ink3 mb-1.5"><span>已读</span><span className="lc-num">{finished ? 100 : pct}%</span></div>
        <div className="lc-meter" style={{ borderRadius: 4 }}><span style={{ width: `${finished ? 100 : pct}%` }} /></div>
      </div>
    </div>
  );
  return <Desk ready="article" head={head} stage={stage} companionTitle={`本篇 · ${article.readMinutes} 分钟`} companionHint={`${toc.length} 节`} companion={companion} keyPoints={keyPoints} ticket={ticket} />;
}
