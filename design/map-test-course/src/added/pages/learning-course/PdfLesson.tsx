import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Download, Maximize2, MoveHorizontal } from 'lucide-react';
import { Desk } from './Desk';
import type { PdfMedia } from './types';

/* PDF 教材：逐页图连续铺在点阵桌面上，伴读栏是带标题的页目录，本课页码用色条标出；可下载原文件。 */
export function PdfLesson({ pdf, head, keyPoints, ticket, onPage }: { pdf: PdfMedia; head: ReactNode; keyPoints: string[]; ticket: ReactNode; onPage: (page: number) => void }) {
  const total = pdf.pages.length;
  const [lo, hi] = pdf.lessonRange;
  const [page, setPage] = useState(pdf.lastPage ?? lo);
  const [fit, setFit] = useState<'width' | 'page'>('width');
  const box = useRef<HTMLDivElement>(null);
  const thumbs = useRef<HTMLDivElement>(null);
  const jumping = useRef(false);
  const savedPage = useRef(page);
  const inLesson = (p: number) => p >= lo && p <= hi;

  const goTo = (p: number, smooth = true) => {
    const n = Math.min(total, Math.max(1, p));
    const el = box.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (!el || !box.current) return;
    jumping.current = true;
    box.current.scrollTo({ top: el.offsetTop - 16, behavior: smooth ? 'smooth' : 'auto' });
    setPage(n);
    window.setTimeout(() => { jumping.current = false; }, smooth ? 500 : 0);
  };
  useEffect(() => { requestAnimationFrame(() => goTo(pdf.lastPage ?? lo, false)); }, [pdf.url, fit]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = box.current; if (!el) return;
    const onScroll = () => {
      if (jumping.current) return;
      const mid = el.scrollTop + el.clientHeight / 3; let cur = 1;
      el.querySelectorAll<HTMLElement>('[data-page]').forEach(x => { if (x.offsetTop <= mid) cur = Number(x.dataset.page); });
      setPage(cur);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const t = thumbs.current?.querySelector<HTMLElement>(`[data-thumb="${page}"]`);
    const list = thumbs.current?.parentElement;
    if (t && list) list.scrollTo({ top: Math.max(0, t.offsetTop - 60), behavior: 'smooth' });
    if (page === savedPage.current) return;
    const timer = window.setTimeout(() => { savedPage.current = page; onPage(page); }, 800);
    return () => window.clearTimeout(timer);
  }, [page, onPage]);

  const stage = (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 flex-wrap" style={{ borderBottom: '1px solid var(--line-2)' }}>
        <button type="button" className="lc-tool" aria-label="上一页" disabled={page <= 1} onClick={() => goTo(page - 1)}><ChevronLeft size={16} /></button>
        <span className="t-strong lc-num px-1" data-lc="pdf-page">第 {page} / {total} 页</span>
        <button type="button" className="lc-tool" aria-label="下一页" disabled={page >= total} onClick={() => goTo(page + 1)}><ChevronRight size={16} /></button>
        <span className="t-meta lc-ink3 px-2">{inLesson(page) ? '本课内容' : `本课在第 ${lo}–${hi} 页`}</span>
        {!inLesson(page) && <button type="button" className="lc-tool" style={{ color: 'var(--hi)' }} onClick={() => goTo(lo)}>回到本课</button>}
        <span className="flex-1" />
        <button type="button" className="lc-tool" aria-pressed={fit === 'width'} onClick={() => setFit('width')}><MoveHorizontal size={14} />适合宽度</button>
        <button type="button" className="lc-tool" aria-pressed={fit === 'page'} onClick={() => setFit('page')}><Maximize2 size={14} />整页</button>
      </div>
      <div ref={box} className="lc-scroll flex-1" data-lc="pdf-pages" style={{ position: 'relative' }}>
        <div className="lc-paper-stack" style={fit === 'page' ? { height: '100%' } : undefined}>
          {pdf.pages.map((p, i) => (
            <div key={p.imageUrl} data-page={i + 1} className="lc-page" style={fit === 'page' ? { height: '100%', width: 'auto', maxWidth: '100%' } : undefined}>
              <img src={p.imageUrl} alt={`第 ${i + 1} 页：${p.title}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
  const companion = (
    <div className="flex flex-col gap-0.5 relative" ref={thumbs}>
      {pdf.pages.map((p, i) => (
        <button key={p.imageUrl} type="button" className="lc-thumb" data-thumb={i + 1} aria-current={page === i + 1} data-in-lesson={inLesson(i + 1)} onClick={() => goTo(i + 1)}>
          <img src={p.imageUrl} alt="" loading="lazy" />
          <span><span className="t-meta t-mute block lc-num">第 {i + 1} 页{inLesson(i + 1) ? ' · 本课' : ''}</span>{p.title}</span>
        </button>
      ))}
      <a className="lc-tool mt-2 justify-start" href={pdf.url} download={`${pdf.title}.pdf`} data-lc="pdf-download"><Download size={14} />下载原文件 <span className="t-meta t-mute">{pdf.sizeLabel}</span></a>
    </div>
  );
  return <Desk ready="pdf" head={head} stage={stage} companionTitle={`教材目录 · ${total} 页`} companionHint={`本课 P${lo}${hi > lo ? `–${hi}` : ''}`} companion={companion} keyPoints={keyPoints} ticket={ticket} />;
}
