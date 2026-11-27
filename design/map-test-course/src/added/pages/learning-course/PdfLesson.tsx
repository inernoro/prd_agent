import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Maximize2, MoveHorizontal } from 'lucide-react';
import type { PdfMedia } from './types';

type Fit = 'width' | 'page';

/* PDF 教材：逐页图连续阅读（手机与桌面显示一致），缩略图标出本课页码，可下载原文件。
 * 打开时定位到上次读到的页，没有记录则定位到本课第一页。 */
export function PdfLesson({ pdf, onPage }: { pdf: PdfMedia; onPage: (page: number) => void }) {
  const total = pdf.pages.length;
  const [lo, hi] = pdf.lessonRange;
  const [page, setPage] = useState(pdf.lastPage ?? lo);
  const [fit, setFit] = useState<Fit>('width');
  const scroller = useRef<HTMLDivElement>(null);
  const programmatic = useRef(false);
  const savedPage = useRef(page);

  const goTo = (p: number, smooth = true) => {
    const n = Math.min(total, Math.max(1, p));
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    if (!el || !scroller.current) return;
    programmatic.current = true;
    scroller.current.scrollTo({ top: el.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
    setPage(n);
    window.setTimeout(() => { programmatic.current = false; }, smooth ? 500 : 0);
  };

  useEffect(() => { requestAnimationFrame(() => goTo(pdf.lastPage ?? lo, false)); }, [pdf.url]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const onScroll = () => {
      if (programmatic.current) return;
      const mid = box.scrollTop + box.clientHeight / 3;
      let current = 1;
      box.querySelectorAll<HTMLElement>('[data-page]').forEach(el => { if (el.offsetTop <= mid) current = Number(el.dataset.page); });
      setPage(current);
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => box.removeEventListener('scroll', onScroll);
  }, []);

  const thumbs = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = thumbs.current?.querySelector<HTMLElement>(`[data-thumb="${page}"]`);
    if (el && thumbs.current) thumbs.current.scrollTo({ top: Math.max(0, el.offsetTop - 40), behavior: 'smooth' });
  }, [page]);

  useEffect(() => {
    if (page === savedPage.current) return;
    const t = window.setTimeout(() => { savedPage.current = page; onPage(page); }, 800);
    return () => window.clearTimeout(t);
  }, [page, onPage]);

  const inLesson = (p: number) => p >= lo && p <= hi;

  return (
    <div className="flex flex-col gap-2 h-full min-h-0" data-lc-ready="pdf">
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" className="lc-media-btn" aria-label="上一页" disabled={page <= 1} onClick={() => goTo(page - 1)}><ChevronLeft size={16} /></button>
        <span className="text-[13px] font-semibold tabular-nums" data-lc="pdf-page">第 {page} / {total} 页</span>
        <button type="button" className="lc-media-btn" aria-label="下一页" disabled={page >= total} onClick={() => goTo(page + 1)}><ChevronRight size={16} /></button>
        <span className="text-[12px] lc-muted">{inLesson(page) ? '本课内容' : `本课在第 ${lo}–${hi} 页`}</span>
        {!inLesson(page) && (
          <button type="button" className="lc-chip-btn" onClick={() => goTo(lo)}>回到本课</button>
        )}
        <span className="flex-1" />
        <div className="lc-media-switch" role="group" aria-label="缩放">
          <button type="button" className="lc-media-btn" aria-pressed={fit === 'width'} onClick={() => setFit('width')}><MoveHorizontal size={14} />适合宽度</button>
          <button type="button" className="lc-media-btn" aria-pressed={fit === 'page'} onClick={() => setFit('page')}><Maximize2 size={14} />整页</button>
        </div>
        <a className="lc-media-btn" href={pdf.url} download={`${pdf.title}.pdf`} data-lc="pdf-download" style={{ border: '1px solid var(--border-subtle)' }}>
          <Download size={14} />下载 PDF<span className="lc-unit">{pdf.sizeLabel}</span>
        </a>
      </div>

      <div className="flex gap-3 flex-1 min-h-0">
        <div ref={thumbs} className="lc-scroll hidden md:flex flex-col gap-1.5 shrink-0 pr-1 relative" style={{ width: 104 }} aria-label="页面缩略图">
          {pdf.pages.map((p, i) => (
            <button key={p.imageUrl} type="button" className="lc-thumb shrink-0" data-thumb={i + 1} aria-current={page === i + 1} data-in-lesson={inLesson(i + 1)} onClick={() => goTo(i + 1)} title={p.title}>
              <img src={p.imageUrl} alt="" loading="lazy" />
              <span className="block mt-1">{i + 1}{inLesson(i + 1) ? ' · 本课' : ''}</span>
            </button>
          ))}
        </div>
        <div ref={scroller} className="lc-scroll flex-1 lc-nested p-3 flex flex-col gap-4" data-lc="pdf-pages" style={{ position: 'relative' }}>
          {pdf.pages.map((p, i) => (
            <div key={p.imageUrl} data-page={i + 1} className="lc-pdf-page" style={fit === 'width' ? { width: '100%', maxWidth: 860, flex: 'none', aspectRatio: '794 / 1123' } : { height: '100%', aspectRatio: '794 / 1123', maxWidth: '100%', flex: 'none' }}>
              <img src={p.imageUrl} alt={`第 ${i + 1} 页：${p.title}`} style={fit === 'page' ? { height: '100%', width: 'auto', margin: '0 auto' } : undefined} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
