/**
 * 公共藏书阁 —— 从新手到高手的心路历程书目 + 结业考。
 *
 * 编排逻辑：一句真实的抱怨 → 病根诊断 → 这一卷书 → 结业考验证你真的懂了。
 *
 * 视觉基准是 Linear（用户 2026-09-09 指定）。Linear 的四个字是「密、小、灰、快」，
 * 落到具体度量上：
 *   圆角 6px（不是 20px）· 正文 13px（不是 16px）· 列表行 36-40px（不是 60px）
 *   边框 1px 白 6%（不靠阴影分层）· 强调色只出现在选中态与主按钮
 *   hover 是提亮 120ms（不是位移 + 大投影）
 * 上一版栽在「仿 Linear 却把每个数都放大一倍」——那是仿冒品不是 Linear。
 * 改这个页面前先量一遍上面那行数，别凭手感放大。
 *
 * 内容 SSOT：src/lib/bookshelf/catalog.ts（书目）、exams.ts（考题）。
 * 个人进度落 localStorage（见 stores/bookshelfStore.ts 的边界说明）。
 */
import { useMemo, useState } from 'react';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import {
  Power, Ruler, Compass, Blocks, ShieldCheck, Cpu, Presentation, BookOpen,
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
const LEVEL_LABEL: Record<number, string> = { 1: '入门', 2: '进阶', 3: '硬骨头' };

type TrackFilter = 'all' | 'dev' | 'pm';
const TRACK_FILTERS: { key: TrackFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'dev', label: '开发' },
  { key: 'pm', label: '产品' },
];

function matchTrack(book: BookEntry, f: TrackFilter): boolean {
  return f === 'all' || book.track === f || book.track === 'both';
}

export default function BookshelfPage() {
  const [track, setTrack] = useState<TrackFilter>('all');
  const [activeVolumeId, setActiveVolumeId] = useState<string>(VOLUMES[0].id);
  const [examVolume, setExamVolume] = useState<Volume | null>(null);
  const [expandedBook, setExpandedBook] = useState<string | null>(null);

  const readBookIds = useBookshelfStore((s) => s.readBookIds);
  const examResults = useBookshelfStore((s) => s.examResults);
  const toggleRead = useBookshelfStore((s) => s.toggleRead);

  const visibleBooks = useMemo(() => ALL_BOOKS.filter((b) => matchTrack(b, track)), [track]);
  const readCount = visibleBooks.filter((b) => readBookIds.includes(b.id)).length;
  const passedVolumes = VOLUMES.filter((v) => examResults[v.id]?.passed).length;

  const activeVolume = findVolume(activeVolumeId) ?? VOLUMES[0];
  const activeBooks = activeVolume.books.filter((b) => matchTrack(b, track));
  const activeResult = examResults[activeVolume.id];
  const examCount = questionsOf(activeVolume.id).length;
  const nextVolume = VOLUMES[VOLUMES.findIndex((v) => v.id === activeVolume.id) + 1] ?? null;

  function jumpTo(volumeId: string) {
    setActiveVolumeId(volumeId);
    setExpandedBook(null);
  }

  return (
    <div className="w-full min-h-full flex flex-col" style={{ color: 'var(--text-primary)' }}>

      {/* ── 顶栏：一行装下标题、筛选、进度 ── */}
      <header
        className="flex items-center justify-between gap-4 px-1 pb-3"
        style={{ borderBottom: '1px solid var(--border-secondary)' }}
      >
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-[15px] font-semibold tracking-tight shrink-0">公共藏书阁</h1>
          <span className="text-[12px] truncate" style={{ color: 'var(--text-muted)' }}>
            {VOLUMES.length} 卷 · {ALL_BOOKS.length} 本 · {QUESTIONS.length} 问
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div
            className="flex items-center p-[2px] rounded-[7px]"
            style={{ background: 'var(--bg-secondary)' }}
          >
            {TRACK_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setTrack(f.key)}
                className="px-2.5 h-[24px] rounded-[5px] text-[12px] font-medium transition-colors duration-[120ms]"
                style={{
                  background: track === f.key ? 'var(--bg-card-hover)' : 'transparent',
                  color: track === f.key ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="text-[12px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
            已读 {readCount}/{visibleBooks.length} · 通关 {passedVolumes}/{VOLUMES.length}
          </span>
        </div>
      </header>

      {/* ── 标题区：全页唯一的大字，但仍在 Linear 的量级里 ── */}
      <section className="px-1 pt-7 pb-6">
        <h2 className="text-[38px] font-semibold leading-[1.12] tracking-[-0.02em]">
          看到我，算你有福了
        </h2>
        <p className="mt-2.5 text-[13px] leading-[1.7] max-w-[620px]" style={{ color: 'var(--text-secondary)' }}>
          七卷不按学科排，按你会在哪一步卡住排。每卷钉着一句团队里真实说过的话——
          从最像你处境的那句进去，比从第一页啃起有用得多。
        </p>

        {/* 痛点入口：横向 chip，密而不吵 */}
        <div className="mt-4 flex flex-wrap gap-1.5">
          {PAIN_REMEDIES.map((r) => {
            const vol = findVolume(r.volumeId);
            if (!vol) return null;
            const active = r.volumeId === activeVolumeId;
            return (
              <button
                key={r.quote}
                type="button"
                onClick={() => jumpTo(r.volumeId)}
                title={r.diagnosis}
                className="group flex items-center gap-1.5 pl-2.5 pr-2 h-[26px] rounded-[6px] text-[12px] transition-colors duration-[120ms]"
                style={{
                  background: active ? 'var(--bg-card-hover)' : 'var(--bg-secondary)',
                  border: `1px solid ${active ? 'var(--border-default)' : 'var(--border-secondary)'}`,
                  color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                }}
              >
                <span className="truncate max-w-[280px]">{r.quote.replace(/[。」「]/g, '')}</span>
                <ChevronRight size={12} style={{ color: 'var(--text-muted)' }} />
              </button>
            );
          })}
        </div>
      </section>

      {/* ── 主体：左卷列表 + 右书目，Linear 的 list-detail ── */}
      <div className="flex-1 flex gap-5 px-1 pb-10 min-h-0">

        {/* 左：七卷 */}
        <nav className="w-[236px] shrink-0 flex flex-col gap-[2px]">
          {VOLUMES.map((vol) => {
            const Icon = VOLUME_ICON_MAP[vol.icon] ?? BookOpen;
            const books = vol.books.filter((b) => matchTrack(b, track));
            const read = books.filter((b) => readBookIds.includes(b.id)).length;
            const active = vol.id === activeVolumeId;
            const passed = examResults[vol.id]?.passed;
            return (
              <button
                key={vol.id}
                type="button"
                onClick={() => jumpTo(vol.id)}
                className="flex items-center gap-2.5 h-[36px] px-2.5 rounded-[6px] text-left transition-colors duration-[120ms]"
                style={{ background: active ? 'var(--bg-card-hover)' : 'transparent' }}
              >
                <Icon
                  size={15}
                  strokeWidth={1.6}
                  style={{ color: active ? 'var(--text-primary)' : 'var(--text-muted)' }}
                  className="shrink-0"
                />
                <span
                  className="text-[13px] font-medium flex-1 truncate"
                  style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                >
                  {vol.name}
                </span>
                {passed && (
                  <span
                    className="text-[10px] px-1.5 h-[16px] leading-[16px] rounded-[4px] shrink-0 font-medium"
                    style={{ background: 'var(--bg-tertiary)', color: 'var(--accent-fg-emerald)' }}
                  >
                    通关
                  </span>
                )}
                <span className="text-[11px] tabular-nums shrink-0" style={{ color: 'var(--text-muted)' }}>
                  {read}/{books.length}
                </span>
              </button>
            );
          })}
        </nav>

        {/* 右：选中卷 */}
        <main className="flex-1 min-w-0">
          {/* 卷抬头 */}
          <div className="pb-4" style={{ borderBottom: '1px solid var(--border-secondary)' }}>
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="text-[20px] font-semibold tracking-tight">{activeVolume.name}</h3>
                  <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    {activeVolume.subtitle}
                  </span>
                </div>
                <p
                  className="mt-2.5 text-[13px] leading-[1.7] pl-2.5"
                  style={{ color: 'var(--text-secondary)', borderLeft: '2px solid var(--border-default)' }}
                >
                  {activeVolume.painQuote}
                </p>
                <p className="mt-2 text-[12.5px] leading-[1.7]" style={{ color: 'var(--text-muted)' }}>
                  {activeVolume.cure}
                </p>
              </div>

              {examCount > 0 && (
                <button
                  type="button"
                  onClick={() => setExamVolume(activeVolume)}
                  className="shrink-0 h-[26px] px-2.5 rounded-[6px] text-[12px] font-medium transition-colors duration-[120ms]"
                  style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-secondary)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {activeResult ? `再考 ${activeResult.correct}/${activeResult.total}` : `结业考 ${examCount} 题`}
                </button>
              )}
            </div>
          </div>

          {/* 书目：一行一本，展开才看细节 */}
          <div className="flex flex-col">
            {activeBooks.map((b, i) => {
              const read = readBookIds.includes(b.id);
              const open = expandedBook === b.id;
              return (
                <div key={b.id} style={{ borderBottom: '1px solid var(--border-secondary)' }}>
                  <div
                    className="flex items-center gap-2.5 h-[40px] px-1.5 rounded-[6px] cursor-pointer transition-colors duration-[120ms]"
                    style={{ background: open ? 'var(--bg-secondary)' : 'transparent' }}
                    onClick={() => setExpandedBook(open ? null : b.id)}
                  >
                    <button
                      type="button"
                      title={read ? '取消已读' : '标记已读'}
                      onClick={(e) => { e.stopPropagation(); toggleRead(b.id); }}
                      className="w-[16px] h-[16px] rounded-[4px] grid place-items-center shrink-0 transition-colors duration-[120ms]"
                      style={{
                        background: read ? 'var(--accent-fg-emerald)' : 'transparent',
                        border: `1px solid ${read ? 'var(--accent-fg-emerald)' : 'var(--border-default)'}`,
                      }}
                    >
                      {read && <Check size={11} strokeWidth={3} style={{ color: 'var(--bg-base)' }} />}
                    </button>

                    <span className="text-[11px] tabular-nums w-[14px] shrink-0" style={{ color: 'var(--text-muted)' }}>
                      {i + 1}
                    </span>

                    <span
                      className="text-[13px] font-medium truncate"
                      style={{ color: read ? 'var(--text-muted)' : 'var(--text-primary)' }}
                    >
                      《{b.title}》
                    </span>

                    <span className="text-[12px] truncate shrink-0" style={{ color: 'var(--text-muted)' }}>
                      {b.author}
                    </span>

                    <div className="flex-1" />

                    <span className="text-[11px] shrink-0 hidden sm:inline" style={{ color: 'var(--text-muted)' }}>
                      {TRACK_LABEL[b.track]}
                    </span>
                    <span
                      className="text-[10px] px-1.5 h-[17px] leading-[17px] rounded-[4px] shrink-0"
                      style={{ background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
                    >
                      {LEVEL_LABEL[b.level]}
                    </span>
                    <ChevronRight
                      size={13}
                      className="shrink-0 transition-transform duration-[120ms]"
                      style={{ color: 'var(--text-muted)', transform: open ? 'rotate(90deg)' : 'none' }}
                    />
                  </div>

                  {open && (
                    <div className="pl-[46px] pr-2 pb-3.5 pt-0.5 flex flex-col gap-1.5">
                      {b.original && (
                        <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>{b.original}</div>
                      )}
                      <p className="text-[13px] leading-[1.72]" style={{ color: 'var(--text-secondary)' }}>
                        {b.why}
                      </p>
                      <p className="text-[12.5px] leading-[1.7]" style={{ color: 'var(--accent-fg-emerald)' }}>
                        读完你能：{b.takeaway}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 卷尾：读完之后往哪走。也顺带填掉书少时的下半屏空白。 */}
          {examCount > 0 && (
            <div className="mt-6 flex items-center justify-between gap-6 px-3.5 py-3 rounded-[7px]"
              style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-secondary)' }}>
              <div className="min-w-0">
                <div className="text-[13px] font-medium">读过和站得住是两回事</div>
                <div className="mt-1 text-[12.5px] leading-[1.7]" style={{ color: 'var(--text-muted)' }}>
                  {activeResult
                    ? `上次 ${activeResult.correct}/${activeResult.total}${activeResult.passed ? '，已通关。错题解析随时能再看一遍。' : '，还没过。错的地方正是这一卷要治的。'}`
                    : `${examCount} 道判断题，答对 ${Math.ceil(examCount * 0.6)} 道及格。考的是判断，不是记忆。`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setExamVolume(activeVolume)}
                className="shrink-0 h-[30px] px-4 rounded-[6px] text-[12.5px] font-medium transition-opacity duration-[120ms] hover:opacity-90"
                style={{ background: 'var(--accent-gold)', color: 'var(--accent-on-gold)' }}
              >
                {activeResult ? '再考一次' : '开始结业考'}
              </button>
            </div>
          )}

          {nextVolume && (
            <button
              type="button"
              onClick={() => jumpTo(nextVolume.id)}
              className="mt-2 w-full flex items-center gap-2 px-3.5 h-[38px] rounded-[7px] text-left transition-colors duration-[120ms]"
              style={{ border: '1px solid var(--border-secondary)' }}
            >
              <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>下一卷</span>
              <span className="text-[13px] font-medium">{nextVolume.name}</span>
              <span className="text-[12px] truncate" style={{ color: 'var(--text-muted)' }}>{nextVolume.subtitle}</span>
              <ChevronRight size={13} className="ml-auto shrink-0" style={{ color: 'var(--text-muted)' }} />
            </button>
          )}
        </main>
      </div>

      <ExamDialog volume={examVolume} open={!!examVolume} onOpenChange={(v) => !v && setExamVolume(null)} />
    </div>
  );
}
