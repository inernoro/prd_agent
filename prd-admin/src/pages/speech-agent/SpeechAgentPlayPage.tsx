import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { speechAgentApi } from '@/services/real/speechAgent';
import type { SpeechDeck, SpeechNode } from '@/services/contracts/speechAgent';
import { MapSectionLoader } from '@/components/ui/VideoLoader';

/**
 * 演讲播放态 — 全屏沉浸式分屏，键盘控制
 *
 * 屏序：root（封面）→ Level 1 章节逐屏 → 末屏（结束）
 * Level 2 子要点合并到该 Level 1 屏的次级列表。
 *
 * 键盘：→/Space=下一屏，←=上一屏，ESC=退出
 */
export default function SpeechAgentPlayPage() {
  const { deckId = '' } = useParams<{ deckId: string }>();
  const navigate = useNavigate();
  const [deck, setDeck] = useState<SpeechDeck | null>(null);
  const [nodes, setNodes] = useState<SpeechNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [slideIdx, setSlideIdx] = useState(0);
  const [animKey, setAnimKey] = useState(0);

  useEffect(() => {
    if (!deckId) return;
    let cancel = false;
    setLoading(true);
    speechAgentApi.getDeck(deckId).then((res) => {
      if (cancel) return;
      if (res.success && res.data) {
        setDeck(res.data.deck);
        setNodes(res.data.nodes);
      }
      setLoading(false);
    });
    return () => { cancel = true; };
  }, [deckId]);

  const slides = useMemo(() => buildSlides(nodes), [nodes]);
  const total = slides.length;

  const goExit = useCallback(() => navigate(`/speech-agent/${deckId}`), [navigate, deckId]);
  const goNext = useCallback(() => {
    setSlideIdx((i) => {
      const next = Math.min(total - 1, i + 1);
      if (next !== i) setAnimKey((k) => k + 1);
      return next;
    });
  }, [total]);
  const goPrev = useCallback(() => {
    setSlideIdx((i) => {
      const next = Math.max(0, i - 1);
      if (next !== i) setAnimKey((k) => k + 1);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); goExit(); return; }
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); goNext(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); goPrev(); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev, goExit]);

  if (loading) {
    return <div className="h-full"><MapSectionLoader text="加载演讲…" /></div>;
  }
  if (!deck || slides.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-6 text-center">
        <p className="text-white/70">演讲没有节点，无法播放。</p>
        <button onClick={goExit} className="mt-4 px-4 py-2 rounded-lg bg-violet-500/90 text-white text-sm">返回编辑器</button>
      </div>
    );
  }

  const slide = slides[slideIdx];
  const progressPct = total > 1 ? Math.round((slideIdx / (total - 1)) * 100) : 100;

  return (
    <div
      className="fixed inset-0 z-[100] bg-[#0a0a0c] flex flex-col"
      data-tour-id="speech-play-fullscreen"
    >
      <div className="absolute top-0 left-0 right-0 h-1 bg-white/[0.06]">
        <div
          className="h-full bg-gradient-to-r from-violet-400 to-fuchsia-400 transition-all duration-500"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      <header className="shrink-0 px-8 py-4 flex items-center justify-between text-xs text-white/45">
        <span className="font-mono">{deck.title}</span>
        <span>{slideIdx + 1} / {total}</span>
        <button
          type="button"
          onClick={goExit}
          aria-label="退出播放 (ESC)"
          className="p-1.5 rounded-md hover:bg-white/10 text-white/65"
        >
          <X size={16} />
        </button>
      </header>

      <main className="flex-1 min-h-0 flex items-center justify-center px-8 py-4">
        <div
          key={animKey}
          className="speech-slide w-full max-w-4xl flex flex-col"
        >
          {slide.kind === 'cover' && (
            <div className="text-center">
              <div className="text-[11px] uppercase tracking-[0.3em] text-violet-300/70 mb-6">演讲开场</div>
              <h1 className="text-5xl md:text-6xl font-semibold text-white/95 leading-tight tracking-tight">
                {slide.title}
              </h1>
              {slide.bulletPoints.length > 0 && (
                <div className="mt-10 space-y-3">
                  {slide.bulletPoints.map((bp, i) => (
                    <p key={i} className="text-lg md:text-xl text-white/65 leading-relaxed">{bp}</p>
                  ))}
                </div>
              )}
              <div className="mt-12 text-xs text-white/35">
                按空格 / → 开始
              </div>
            </div>
          )}

          {slide.kind === 'chapter' && (
            <div>
              <div className="text-[11px] uppercase tracking-[0.3em] text-violet-300/70 mb-4">
                第 {slide.chapterIndex} / {slide.chapterTotal} 章
              </div>
              <h2 className="text-4xl md:text-5xl font-semibold text-white/95 leading-tight tracking-tight mb-10">
                {slide.title}
              </h2>
              <ul className="space-y-5">
                {slide.bulletPoints.map((bp, i) => (
                  <li key={i} className="flex items-start gap-4 text-xl md:text-2xl text-white/85 leading-relaxed">
                    <span className="shrink-0 w-7 h-7 rounded-full bg-violet-500/20 border border-violet-400/40 text-violet-200 text-xs flex items-center justify-center font-mono mt-1">
                      {i + 1}
                    </span>
                    <span>{bp}</span>
                  </li>
                ))}
              </ul>
              {slide.subPoints.length > 0 && (
                <div className="mt-10 pl-11 space-y-2">
                  <div className="text-xs uppercase tracking-wider text-white/40">展开</div>
                  {slide.subPoints.map((sp, i) => (
                    <p key={i} className="text-base text-white/55 leading-relaxed">— {sp}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {slide.kind === 'end' && (
            <div className="text-center">
              <div className="text-[11px] uppercase tracking-[0.3em] text-violet-300/70 mb-6">END</div>
              <h2 className="text-4xl md:text-5xl font-semibold text-white/95 leading-tight">谢谢聆听</h2>
              <p className="mt-6 text-white/55">{deck.title}</p>
              <button
                onClick={goExit}
                className="mt-10 inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-violet-500/90 hover:bg-violet-400 text-white text-sm"
              >
                返回编辑器
              </button>
            </div>
          )}
        </div>
      </main>

      <footer className="shrink-0 px-8 py-5 flex items-center justify-between text-xs text-white/40">
        <button
          type="button"
          onClick={goPrev}
          disabled={slideIdx === 0}
          aria-label="上一屏 (←)"
          className="inline-flex items-center gap-1 px-3 py-2 rounded-md hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronLeft size={14} /> 上一屏
        </button>
        <div className="font-mono">
          空格 / → 下一屏 · ← 上一屏 · ESC 退出
        </div>
        <button
          type="button"
          onClick={goNext}
          disabled={slideIdx === total - 1}
          aria-label="下一屏 (→)"
          className="inline-flex items-center gap-1 px-3 py-2 rounded-md hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
        >
          下一屏 <ChevronRight size={14} />
        </button>
      </footer>

      <style>{`
        @keyframes speechSlideIn {
          from { opacity: 0; transform: translateY(24px); filter: blur(8px); }
          to { opacity: 1; transform: translateY(0); filter: blur(0); }
        }
        .speech-slide {
          animation: speechSlideIn 480ms cubic-bezier(0.22, 1, 0.36, 1);
        }
      `}</style>
    </div>
  );
}

type Slide =
  | { kind: 'cover'; title: string; bulletPoints: string[] }
  | { kind: 'chapter'; title: string; bulletPoints: string[]; subPoints: string[]; chapterIndex: number; chapterTotal: number }
  | { kind: 'end' };

function buildSlides(nodes: SpeechNode[]): Slide[] {
  if (nodes.length === 0) return [];
  const root = nodes.find((n) => n.depth === 0);
  const chapters = nodes
    .filter((n) => n.depth === 1)
    .sort((a, b) => a.order - b.order);
  const subByParent = new Map<string, SpeechNode[]>();
  for (const n of nodes) {
    if (n.depth >= 2 && n.parentId) {
      const arr = subByParent.get(n.parentId) ?? [];
      arr.push(n);
      subByParent.set(n.parentId, arr);
    }
  }
  const slides: Slide[] = [];
  if (root) {
    slides.push({ kind: 'cover', title: root.title, bulletPoints: root.bulletPoints });
  }
  chapters.forEach((c, i) => {
    const subs = (subByParent.get(c.id) ?? []).sort((a, b) => a.order - b.order);
    const subPoints: string[] = [];
    for (const s of subs) {
      subPoints.push(s.title);
      for (const bp of s.bulletPoints) subPoints.push(bp);
    }
    slides.push({
      kind: 'chapter',
      title: c.title,
      bulletPoints: c.bulletPoints,
      subPoints,
      chapterIndex: i + 1,
      chapterTotal: chapters.length,
    });
  });
  slides.push({ kind: 'end' });
  return slides;
}
