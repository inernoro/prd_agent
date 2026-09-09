/**
 * 公共藏书阁 —— 从新手到高手的心路历程书目 + 结业考。
 *
 * 它不是「程序员必读 50 本」那种平铺书单。编排逻辑是：
 *   一句真实的抱怨 → 病根诊断 → 这一卷书 → 结业考验证你真的懂了
 *
 * 之所以这么设计：团队里那些「什么都不跟我说」「AI 都在乱写」「审也审不出来」
 * 的抱怨，单独看是牢骚，合起来是一张清晰的能力缺口图。藏书阁按这张图排卷，
 * 让人从自己的痛处进来，而不是从书单第一页开始啃。
 *
 * 内容 SSOT：src/lib/bookshelf/catalog.ts（书目）、exams.ts（考题）。
 * 个人进度落 localStorage（见 stores/bookshelfStore.ts 的边界说明）。
 */
import { useMemo, useState } from 'react';
import {
  Power, Ruler, Compass, Blocks, ShieldCheck, Cpu, Presentation,
  BookOpen, ChevronDown, Check, GraduationCap, Quote, ArrowRight, type LucideIcon,
} from 'lucide-react';
import { VOLUMES, PAIN_REMEDIES, ALL_BOOKS, findVolume } from '@/lib/bookshelf/catalog';
import { QUESTIONS, questionsOf } from '@/lib/bookshelf/exams';
import { useBookshelfStore } from '@/stores/bookshelfStore';
import type { Track, Volume, BookEntry } from '@/lib/bookshelf/types';
import { ExamDialog } from './ExamDialog';

/** 卷图标注册表（frontend-architecture.md：类型→图标映射走注册表，不写 switch）。 */
const VOLUME_ICON_MAP: Record<string, LucideIcon> = {
  Power, Ruler, Compass, Blocks, ShieldCheck, Cpu, Presentation,
};

const TRACK_LABEL: Record<Track, string> = { dev: '开发', pm: '产品', both: '通用' };
const LEVEL_LABEL: Record<number, string> = { 1: '入门可读', 2: '有经验再读', 3: '硬骨头' };
const CN_NUM = '一二三四五六七';

type TrackFilter = 'all' | 'dev' | 'pm';

const TRACK_FILTERS: { key: TrackFilter; label: string; hint: string }[] = [
  { key: 'all', label: '全部', hint: '七卷全览' },
  { key: 'dev', label: '开发者', hint: '只看开发线' },
  { key: 'pm', label: '产品经理', hint: '只看产品线' },
];

function matchTrack(book: BookEntry, f: TrackFilter): boolean {
  if (f === 'all') return true;
  return book.track === f || book.track === 'both';
}

export default function BookshelfPage() {
  const [track, setTrack] = useState<TrackFilter>('all');
  const [openVolumes, setOpenVolumes] = useState<Set<string>>(() => new Set([VOLUMES[0].id]));
  const [examVolume, setExamVolume] = useState<Volume | null>(null);

  const readBookIds = useBookshelfStore((s) => s.readBookIds);
  const examResults = useBookshelfStore((s) => s.examResults);
  const toggleRead = useBookshelfStore((s) => s.toggleRead);

  const visibleBooks = useMemo(
    () => ALL_BOOKS.filter((b) => matchTrack(b, track)),
    [track],
  );
  const readCount = visibleBooks.filter((b) => readBookIds.includes(b.id)).length;
  const passedVolumes = VOLUMES.filter((v) => examResults[v.id]?.passed).length;

  // 结论先行（conclusion-before-numbers.md）：第一屏给一句挂着数字的判断，
  // 而不是让人自己读一排指标去算「我到底走到哪了」。
  const verdict = (() => {
    if (readCount === 0) return '你还没开始。从下面那句最像你处境的抱怨点进去，就是第一步。';
    if (passedVolumes === 0) return `已读 ${readCount} 本，但还没通过任何一卷的结业考——读过和站得住是两回事，去考一卷试试。`;
    if (passedVolumes >= VOLUMES.length) return `七卷全部通关，已读 ${readCount} 本。现在你是那个该给别人立规矩的人了。`;
    return `已读 ${readCount} 本，通关 ${passedVolumes} / ${VOLUMES.length} 卷。继续往下一卷走。`;
  })();

  function toggleVolume(id: string) {
    setOpenVolumes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function jumpToVolume(volumeId: string) {
    setOpenVolumes((prev) => new Set(prev).add(volumeId));
    // 展开动画与滚动同帧会打架，让出一帧再滚（变化可感知，不闪现）。
    requestAnimationFrame(() => {
      document.getElementById(`vol-${volumeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  return (
    <div className="w-full min-h-full flex flex-col gap-10 pb-16">
      {/* ── Hero ── */}
      <header className="pt-8 sm:pt-14">
        <div
          className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[12px] font-semibold mb-5"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
        >
          <BookOpen size={13} />
          公共藏书阁
        </div>

        <h1
          className="font-black leading-[0.95] tracking-tight"
          style={{
            fontSize: 'clamp(40px, 8.5vw, 104px)',
            color: 'var(--text-primary)',
          }}
        >
          看到我，算你有福了
        </h1>

        <p
          className="mt-6 max-w-3xl text-[16px] sm:text-[18px] leading-relaxed"
          style={{ color: 'var(--text-secondary)' }}
        >
          从新手到高手的心路历程书目，开发者与产品经理各一条线。
          七卷书不按学科排，按<strong style={{ color: 'var(--text-primary)' }}>你会在哪一步卡住</strong>排——
          每一卷都钉着一句团队里真实说过的抱怨，读完再考一遍，确认你是真的站得住。
        </p>

        {/* 结论行：一句判断 + 支撑数字 */}
        <div
          className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 rounded-2xl"
          style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-secondary)' }}
        >
          <p className="text-[15px] font-semibold flex-1 min-w-[260px]" style={{ color: 'var(--text-primary)' }}>
            {verdict}
          </p>
          <div className="flex items-center gap-6">
            <Stat value={VOLUMES.length} unit="卷" label="心路阶段" />
            <Stat value={visibleBooks.length} unit="本" label={track === 'all' ? '在架书目' : `${TRACK_FILTERS.find((t) => t.key === track)?.label}线`} />
            <Stat value={QUESTIONS.length} unit="题" label="结业考题" />
          </div>
        </div>

        {/* 角色筛选 */}
        <div className="mt-5 flex items-center gap-2 flex-wrap">
          {TRACK_FILTERS.map((f) => {
            const active = track === f.key;
            return (
              <button
                key={f.key}
                type="button"
                onClick={() => setTrack(f.key)}
                title={f.hint}
                className="px-4 h-9 rounded-xl text-[13px] font-semibold transition-all duration-200"
                style={{
                  background: active ? 'var(--gold-gradient)' : 'var(--bg-secondary)',
                  color: active ? 'var(--accent-on-gold)' : 'var(--text-secondary)',
                  border: `1px solid ${active ? 'transparent' : 'var(--border-secondary)'}`,
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </header>

      {/* ── 痛点药方表 ── */}
      <section>
        <SectionTitle
          kicker="从你的痛处进来"
          title="这些话，是不是很耳熟"
          desc="左边是团队里真实说出口的抱怨，原话没美化。每一条都指向一卷能治它的书——不必从第一页开始啃。"
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {PAIN_REMEDIES.map((r) => {
            const vol = findVolume(r.volumeId);
            if (!vol) return null;
            return (
              <button
                key={r.quote}
                type="button"
                onClick={() => jumpToVolume(r.volumeId)}
                className="group text-left p-5 rounded-2xl transition-all duration-200 hover:-translate-y-0.5"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border-secondary)' }}
              >
                <Quote size={15} style={{ color: 'var(--text-muted)' }} />
                <p className="mt-2 text-[15px] font-semibold leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                  {r.quote}
                </p>
                <p className="mt-2.5 text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                  {r.diagnosis}
                </p>
                <span
                  className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-bold"
                  style={{ color: 'var(--accent-fg-amber)' }}
                >
                  去卷{CN_NUM[vol.index - 1]} · {vol.name}
                  <ArrowRight size={13} className="transition-transform duration-200 group-hover:translate-x-1" />
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── 七卷 ── */}
      <section>
        <SectionTitle
          kicker="七卷"
          title="从开机到上台面"
          desc="每一卷是一次身份升级。卷内书目按「先读哪本」排序，第一本通常是这一卷最该先读的那本。"
        />
        <div className="flex flex-col gap-4">
          {VOLUMES.map((vol) => (
            <VolumeCard
              key={vol.id}
              volume={vol}
              track={track}
              open={openVolumes.has(vol.id)}
              onToggle={() => toggleVolume(vol.id)}
              readBookIds={readBookIds}
              onToggleRead={toggleRead}
              result={examResults[vol.id]}
              onExam={() => setExamVolume(vol)}
            />
          ))}
        </div>
      </section>

      <ExamDialog volume={examVolume} open={!!examVolume} onOpenChange={(v) => !v && setExamVolume(null)} />
    </div>
  );
}

function Stat({ value, unit, label }: { value: number; unit: string; label: string }) {
  return (
    <div className="shrink-0">
      <div className="flex items-baseline gap-0.5">
        <span className="text-[26px] font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
          {value}
        </span>
        <span className="text-[13px] font-semibold" style={{ color: 'var(--text-secondary)' }}>{unit}</span>
      </div>
      <div className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>{label}</div>
    </div>
  );
}

function SectionTitle({ kicker, title, desc }: { kicker: string; title: string; desc: string }) {
  return (
    <div className="mb-5">
      <div className="text-[11px] font-bold uppercase tracking-[0.14em] mb-1.5" style={{ color: 'var(--accent-fg-amber)' }}>
        {kicker}
      </div>
      <h2 className="text-[26px] sm:text-[32px] font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
        {title}
      </h2>
      <p className="mt-2 max-w-3xl text-[14px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {desc}
      </p>
    </div>
  );
}

function VolumeCard({
  volume, track, open, onToggle, readBookIds, onToggleRead, result, onExam,
}: {
  volume: Volume;
  track: TrackFilter;
  open: boolean;
  onToggle: () => void;
  readBookIds: string[];
  onToggleRead: (id: string) => void;
  result?: { correct: number; total: number; passed: boolean };
  onExam: () => void;
}) {
  const Icon = VOLUME_ICON_MAP[volume.icon] ?? BookOpen;
  const books = volume.books.filter((b) => matchTrack(b, track));
  const readInVol = books.filter((b) => readBookIds.includes(b.id)).length;
  const pct = books.length > 0 ? Math.round((readInVol / books.length) * 100) : 0;
  const examCount = questionsOf(volume.id).length;

  return (
    <div
      id={`vol-${volume.id}`}
      className="rounded-3xl overflow-hidden transition-all duration-300"
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${result?.passed ? 'var(--accent-fg-emerald)' : 'var(--border-secondary)'}`,
        scrollMarginTop: '16px',
      }}
    >
      <button type="button" onClick={onToggle} className="w-full text-left p-5 sm:p-6 flex items-start gap-4">
        <div
          className="shrink-0 w-12 h-12 rounded-2xl grid place-items-center"
          style={{ background: 'var(--bg-tertiary)' }}
        >
          <Icon size={22} style={{ color: 'var(--accent-fg-amber)' }} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[20px] sm:text-[24px] font-black tracking-tight" style={{ color: 'var(--text-primary)' }}>
              卷{CN_NUM[volume.index - 1]} · {volume.name}
            </h3>
            <span className="text-[13px] font-medium" style={{ color: 'var(--text-muted)' }}>
              {volume.subtitle}
            </span>
            {result && (
              <span
                className="text-[11px] font-bold px-2 py-0.5 rounded-md"
                style={{
                  background: 'var(--bg-tertiary)',
                  color: result.passed ? 'var(--accent-fg-emerald)' : 'var(--text-secondary)',
                }}
              >
                结业考 {result.correct}/{result.total}{result.passed ? ' 已通过' : ''}
              </span>
            )}
          </div>

          <p
            className="mt-3 text-[14px] italic leading-relaxed pl-3"
            style={{ color: 'var(--text-secondary)', borderLeft: '2px solid var(--border-default)' }}
          >
            「{volume.painQuote}」
          </p>
          <p className="mt-2.5 text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            {volume.cure}
          </p>

          <div className="mt-4 flex items-center gap-3">
            <div className="h-1.5 rounded-full flex-1 max-w-[220px] overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${pct}%`, background: 'var(--gold-gradient)' }}
              />
            </div>
            <span className="text-[12px] font-semibold" style={{ color: 'var(--text-muted)' }}>
              {readInVol} / {books.length} 本
            </span>
          </div>
        </div>

        <ChevronDown
          size={20}
          className="shrink-0 transition-transform duration-300"
          style={{ color: 'var(--text-muted)', transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>

      {open && (
        <div className="px-5 sm:px-6 pb-6 flex flex-col gap-2.5">
          {books.map((b, i) => {
            const read = readBookIds.includes(b.id);
            return (
              <div
                key={b.id}
                className="flex items-start gap-3 p-4 rounded-2xl transition-all duration-200"
                style={{
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-secondary)',
                  opacity: read ? 0.72 : 1,
                }}
              >
                <button
                  type="button"
                  onClick={() => onToggleRead(b.id)}
                  title={read ? '取消已读' : '标记已读'}
                  className="shrink-0 w-6 h-6 mt-0.5 rounded-lg grid place-items-center transition-all duration-200"
                  style={{
                    background: read ? 'var(--gold-gradient)' : 'transparent',
                    border: `1px solid ${read ? 'transparent' : 'var(--border-default)'}`,
                  }}
                >
                  {read ? <Check size={13} color="var(--accent-on-gold)" /> : (
                    <span className="text-[11px] font-bold" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className="text-[15px] font-bold"
                      style={{ color: 'var(--text-primary)', textDecoration: read ? 'line-through' : 'none' }}
                    >
                      《{b.title}》
                    </span>
                    <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{b.author}</span>
                    <Chip>{TRACK_LABEL[b.track]}</Chip>
                    <Chip>{LEVEL_LABEL[b.level]}</Chip>
                  </div>
                  {b.original && (
                    <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--text-muted)' }}>{b.original}</div>
                  )}
                  <p className="mt-2 text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    {b.why}
                  </p>
                  <p className="mt-1.5 text-[13px] leading-relaxed" style={{ color: 'var(--accent-fg-emerald)' }}>
                    读完你能：{b.takeaway}
                  </p>
                </div>
              </div>
            );
          })}

          {examCount > 0 && (
            <button
              type="button"
              onClick={onExam}
              className="mt-2 self-start flex items-center gap-2 px-5 h-10 rounded-xl text-[13.5px] font-bold transition-transform duration-200 hover:-translate-y-0.5"
              style={{ background: 'var(--gold-gradient)', color: 'var(--accent-on-gold)' }}
            >
              <GraduationCap size={16} />
              {result ? '再考一次' : '考这一卷'}（{examCount} 题）
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-[11px] font-semibold px-1.5 py-0.5 rounded-md"
      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}
    >
      {children}
    </span>
  );
}
