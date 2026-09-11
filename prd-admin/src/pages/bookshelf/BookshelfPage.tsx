/**
 * 公共藏书阁 —— 从新手到高手的心路历程书目 + 结业考。
 *
 * 编排逻辑：一句真实的抱怨 → 病根诊断 → 这一卷书 → 结业考验证你真的懂了。
 *
 * 视觉借自站内「智识殿堂」（pages/library/LibraryLandingPage.tsx）的粗野骨架，
 * 度量逐条对齐：3px 墨边（强调 4px、小元素 2.5px）· 纯偏移硬投影（无模糊）
 * · 大圆角 20-28px · font-weight 900 · 字距 -0.02~-0.04em · hover 上移 0.5。
 * 与它的差别只在配色：奶油黄底换成系统暖纸 + 30px 细网格，四色图标盒换成
 * 「五色分卷」——七卷各有身份色，痛点卡的色 = 目标卷的色，找卷不用读字。
 *
 * 改这个页面前先记住两件事：
 *  1. 颜色一律走 token（--shelf-* 与 --accent-*），硬编码会被双皮肤棘轮拦下；
 *  2. 网格线暗档必须是浅色——暗底上画墨线是看不见的，两档值不能照搬。
 *
 * 内容 SSOT：src/lib/bookshelf/catalog.ts（书目）、exams.ts（考题）。
 * 个人进度落 localStorage（见 stores/bookshelfStore.ts 的边界说明）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Power, Ruler, Compass, Blocks, ShieldCheck, Cpu, Presentation,
  BookOpen, Check, ArrowRight, CloudOff, RefreshCw, type LucideIcon,
} from 'lucide-react';
import { VOLUMES, PAIN_REMEDIES, ALL_BOOKS, findVolume } from '@/lib/bookshelf/catalog';
import { QUESTIONS, questionsOf } from '@/lib/bookshelf/exams';
import { useBookshelfStore } from '@/stores/bookshelfStore';
import type { Track, Volume, BookEntry } from '@/lib/bookshelf/types';
import { ExamDialog } from './ExamDialog';
import { TeamBoard } from './TeamBoard';

const VOLUME_ICON_MAP: Record<string, LucideIcon> = {
  Power, Ruler, Compass, Blocks, ShieldCheck, Cpu, Presentation,
};

/**
 * 五色分卷：卷序 → 身份色 + 图标盒底。两者都是 token，暗浅双档已在
 * tokens.css 双写。顺序与 VOLUMES 一一对应，改卷序要一起改。
 */
export const VOLUME_SKIN: { fg: string; box: string }[] = [
  { fg: 'var(--accent-fg-emerald)', box: 'var(--shelf-box-emerald)' },
  { fg: 'var(--accent-gold)',       box: 'var(--shelf-box-gold)' },
  { fg: 'var(--accent-fg-blue)',    box: 'var(--shelf-box-blue)' },
  { fg: 'var(--accent-fg-violet)',  box: 'var(--shelf-box-violet)' },
  { fg: 'var(--accent-fg-amber)',   box: 'var(--shelf-box-amber)' },
  { fg: 'var(--accent-fg-emerald)', box: 'var(--shelf-box-emerald)' },
  { fg: 'var(--accent-fg-blue)',    box: 'var(--shelf-box-blue)' },
];
function skinOf(volumeId: string) {
  const i = VOLUMES.findIndex((v) => v.id === volumeId);
  return VOLUME_SKIN[i >= 0 ? i % VOLUME_SKIN.length : 0];
}

/** 30px 细网格（用户 2026-09-10 指定）。线色走 token，暗档自动翻成浅线。 */
const GRID_BG =
  'linear-gradient(var(--shelf-grid-line) 1px, transparent 1px) 0 0 / 100% 30px,' +
  'linear-gradient(90deg, var(--shelf-grid-line) 1px, transparent 1px) 0 0 / 30px 100%,' +
  'var(--bg-base)';

const TRACK_LABEL: Record<Track, string> = { dev: '开发', pm: '产品', both: '通用' };
const LEVEL_LABEL: Record<number, string> = { 1: '入门', 2: '进阶', 3: '硬骨头' };

type TrackFilter = 'all' | 'dev' | 'pm';
const TRACK_FILTERS: { key: TrackFilter; label: string }[] = [
  { key: 'all', label: '全部' }, { key: 'dev', label: '开发' }, { key: 'pm', label: '产品' },
];
function matchTrack(b: BookEntry, f: TrackFilter) {
  return f === 'all' || b.track === f || b.track === 'both';
}

const EDGE = '3px solid var(--shelf-edge)';
const EDGE_THIN = '2.5px solid var(--shelf-edge)';
const HARD_SM = '0 4px 0 var(--shelf-edge)';
const HARD_MD = '6px 6px 0 var(--shelf-edge)';

/**
 * 深链 ?vol= 的唯一解析规则。认得出的卷就用它，否则回落首卷。
 *
 * 导出是为了让守卫测试**导入这一份**，而不是在测试里复刻一遍——复刻出来的
 * 判据只能证明副本自洽，改坏真实现它照样绿（predicate-and-wiring-discipline
 * 形状 3：判据分裂成多份，然后各自漂移）。本文件写这条时就先栽过一次。
 */
export function resolveVolumeFromUrl(raw: string | null): string {
  return raw && findVolume(raw) ? raw : VOLUMES[0].id;
}

export default function BookshelfPage() {
  const [track, setTrack] = useState<TrackFilter>('all');
  const [searchParams, setSearchParams] = useSearchParams();

  // 深链 ?vol=<volumeId>：这页存在的用法之一是「谁说了那句话，就把对应那卷甩给他」，
  // 所以链接点开必须直接落在那一卷。未知或缺省的 vol 回落到卷一，不报错。
  const volFromUrl = searchParams.get('vol');
  const [activeVolumeId, setActiveVolumeIdRaw] = useState(
    () => resolveVolumeFromUrl(volFromUrl),
  );

  /** 切卷时同步进 URL（replace，不给浏览器后退键塞一堆中间态）。 */
  function setActiveVolumeId(id: string) {
    setActiveVolumeIdRaw(id);
    const next = new URLSearchParams(searchParams);
    next.set('vol', id);
    setSearchParams(next, { replace: true });
  }

  // 别人改地址栏或从另一条深链跳进来时，跟着 URL 走
  useEffect(() => {
    const resolved = resolveVolumeFromUrl(volFromUrl);
    if (volFromUrl && resolved === volFromUrl && resolved !== activeVolumeId) {
      setActiveVolumeIdRaw(resolved);
    }
  }, [volFromUrl, activeVolumeId]);
  const [examVolume, setExamVolume] = useState<Volume | null>(null);

  const readBookIds = useBookshelfStore((s) => s.readBookIds);
  const syncState = useBookshelfStore((s) => s.syncState);
  const retrySync = useBookshelfStore((s) => s.retrySync);
  const loadProgress = useBookshelfStore((s) => s.loadFromServer);
  useEffect(() => { void loadProgress(); }, [loadProgress]);
  const examResults = useBookshelfStore((s) => s.examResults);
  const toggleRead = useBookshelfStore((s) => s.toggleRead);

  const visibleBooks = useMemo(() => ALL_BOOKS.filter((b) => matchTrack(b, track)), [track]);
  const readCount = visibleBooks.filter((b) => readBookIds.includes(b.id)).length;
  const passedCount = VOLUMES.filter((v) => examResults[v.id]?.passed).length;

  const activeVolume = findVolume(activeVolumeId) ?? VOLUMES[0];
  const activeBooks = activeVolume.books.filter((b) => matchTrack(b, track));
  const activeSkin = skinOf(activeVolume.id);
  const activeResult = examResults[activeVolume.id];
  const examCount = questionsOf(activeVolume.id).length;

  return (
    <div
      className="w-full min-h-full -m-4 sm:-m-6 p-4 sm:p-8"
      style={{ background: GRID_BG, color: 'var(--text-primary)' }}
    >
      {/* ── 悬浮 navbar ── */}
      <div className="flex justify-center">
        <div
          className="flex items-center gap-4 sm:gap-6 pl-5 pr-2 py-2 rounded-full flex-wrap justify-center"
          style={{ background: 'var(--bg-card)', border: EDGE, boxShadow: HARD_SM }}
        >
          <span className="text-[15px] font-black tracking-[-0.02em]">公共藏书阁</span>
          <span className="text-[12.5px] font-bold" style={{ color: 'var(--text-muted)' }}>
            {VOLUMES.length} 卷 · {ALL_BOOKS.length} 本 · {QUESTIONS.length} 问
          </span>
          <div className="flex items-center gap-1">
            {TRACK_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setTrack(f.key)}
                className="px-3 py-1.5 rounded-full text-[12.5px] font-bold transition-transform duration-150 hover:-translate-y-[1px]"
                style={{
                  background: track === f.key ? 'var(--accent-gold)' : 'transparent',
                  color: track === f.key ? 'var(--accent-on-gold)' : 'var(--text-secondary)',
                  border: track === f.key ? EDGE_THIN : '2.5px solid transparent',
                  boxShadow: track === f.key ? '0 3px 0 var(--shelf-edge)' : 'none',
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 同步状态：只在没同步上时出现。沉默失败比报错更伤——页面显示打了勾、
          实际只在本机，用户换台设备发现没了就再也不信这个功能了。 */}
      {(syncState === 'failed' || syncState === 'local') && (
        <div
          className="mt-4 flex items-center gap-3 px-4 py-2.5 rounded-[16px] flex-wrap"
          style={{ background: 'var(--bg-card)', border: EDGE_THIN }}
        >
          <CloudOff size={16} strokeWidth={2.6} style={{ color: 'var(--accent-fg-amber)' }} className="shrink-0" />
          <span className="text-[12.5px] font-bold">
            {syncState === 'failed' ? '本次改动没同步上，只存在这台设备' : '当前是本机记录，没连上服务端'}
          </span>
          <span className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>
            {syncState === 'failed' ? '网络恢复或下次操作会自动重试' : '登录后进度会跨设备保留'}
          </span>
          {syncState === 'failed' && (
            <button
              type="button"
              onClick={() => { void retrySync(); }}
              className="ml-auto shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold transition-transform duration-150 hover:-translate-y-[1px]"
              style={{ background: 'var(--bg-base)', border: EDGE_THIN }}
            >
              <RefreshCw size={12} strokeWidth={2.8} />
              立即重试
            </button>
          )}
        </div>
      )}

      {/* ── Hero ── */}
      <section className="mt-10 flex flex-col lg:flex-row gap-10 items-start lg:items-center">
        <div className="flex-1 min-w-0">
          <div
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-[12.5px] font-bold"
            style={{ background: 'var(--bg-card)', border: EDGE }}
          >
            <span className="w-2 h-2 rounded-full" style={{ background: VOLUME_SKIN[0].fg }} />
            开发者 · 产品经理 · 已读 {readCount}/{visibleBooks.length} · 通关 {passedCount}/{VOLUMES.length}
          </div>

          <h1
            className="mt-5 font-black leading-[1.0] tracking-[-0.04em]"
            style={{ fontSize: 'clamp(40px, 6vw, 84px)' }}
          >
            看到我，<br />算你有福了
          </h1>

          <p className="mt-5 max-w-[470px] text-[15px] font-medium leading-[1.72]" style={{ color: 'var(--text-secondary)' }}>
            七卷不按学科排，按你会在哪一步卡住排。每卷钉着一种团队真实卡住过的处境——从最像你的那条进去。
          </p>
        </div>

        {/* 当前卷卡 */}
        <div
          className="w-full lg:w-[390px] shrink-0 p-6 rounded-[28px]"
          style={{ background: 'var(--bg-card)', border: '4px solid var(--shelf-edge)', boxShadow: `8px 8px 0 ${activeSkin.fg}` }}
        >
          <div className="flex items-center justify-between mb-4">
            <div className="w-[50px] h-[50px] rounded-[15px] grid place-items-center" style={{ background: activeSkin.box, border: EDGE }}>
              {(() => {
                const Icon = VOLUME_ICON_MAP[activeVolume.icon] ?? BookOpen;
                return <Icon size={23} strokeWidth={2.5} style={{ color: activeSkin.fg }} />;
              })()}
            </div>
            <span className="px-3 py-1 rounded-full text-[11.5px] font-bold" style={{ background: 'var(--bg-base)', border: EDGE_THIN }}>
              {activeBooks.length} 本
            </span>
          </div>
          <div className="text-[12px] font-bold" style={{ color: 'var(--text-muted)' }}>
            卷{'一二三四五六七'[VOLUMES.findIndex((v) => v.id === activeVolume.id)]}
          </div>
          <div className="text-[32px] font-black tracking-[-0.03em] leading-[1.1]">{activeVolume.name}</div>
          <div className="mt-3.5 px-4 py-3 rounded-[15px]" style={{ background: 'var(--bg-base)', border: EDGE }}>
            <div className="text-[13.5px] font-bold leading-[1.6]">{activeVolume.painQuote}</div>
          </div>
          <div className="mt-4 flex items-center gap-2.5">
            <div className="flex-1 h-3 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)', border: EDGE_THIN }}>
              <div
                className="h-full transition-[width] duration-500"
                style={{
                  width: `${activeBooks.length ? Math.round(activeBooks.filter((b) => readBookIds.includes(b.id)).length / activeBooks.length * 100) : 0}%`,
                  background: activeSkin.fg,
                }}
              />
            </div>
            <span className="text-[12.5px] font-bold shrink-0">
              {activeBooks.filter((b) => readBookIds.includes(b.id)).length} / {activeBooks.length} 本
            </span>
          </div>
          {examCount > 0 && (
            <button
              type="button"
              onClick={() => setExamVolume(activeVolume)}
              className="mt-4 w-full py-3 rounded-full text-[13.5px] font-bold tracking-[0.16em] transition-transform duration-150 hover:-translate-y-[1px]"
              style={{ background: 'var(--text-primary)', color: 'var(--bg-base)', border: EDGE, boxShadow: `0 3px 0 ${activeSkin.fg}` }}
            >
              {activeResult ? `再考 · ${activeResult.correct}/${activeResult.total}` : `赴 考 · ${examCount} 题`}
            </button>
          )}
        </div>
      </section>

      {/* ── 痛点药方 ── */}
      <section className="mt-14">
        <div className="text-center">
          <div className="inline-block px-4 py-1.5 rounded-full text-[12.5px] font-bold" style={{ background: 'var(--bg-card)', border: EDGE }}>
            从你的痛处进来
          </div>
          <h2 className="mt-4 font-black tracking-[-0.03em]" style={{ fontSize: 'clamp(28px, 3.4vw, 44px)' }}>
            这些处境，是不是很眼熟
          </h2>
        </div>

        <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {PAIN_REMEDIES.map((r) => {
            const vol = findVolume(r.volumeId);
            if (!vol) return null;
            const skin = skinOf(r.volumeId);
            const active = r.volumeId === activeVolumeId;
            const Icon = VOLUME_ICON_MAP[vol.icon] ?? BookOpen;
            return (
              <button
                key={r.quote}
                type="button"
                onClick={() => setActiveVolumeId(r.volumeId)}
                className="text-left p-5 rounded-[22px] transition-transform duration-150 hover:-translate-y-0.5"
                style={{
                  background: 'var(--bg-card)',
                  border: active ? '4px solid var(--shelf-edge)' : EDGE,
                  boxShadow: active ? `8px 8px 0 ${skin.fg}` : HARD_MD,
                }}
              >
                <div className="w-[38px] h-[38px] rounded-[12px] grid place-items-center mb-3" style={{ background: skin.box, border: EDGE_THIN }}>
                  <Icon size={18} strokeWidth={2.5} style={{ color: skin.fg }} />
                </div>
                <div className="text-[15px] font-black leading-[1.5] tracking-[-0.01em]">{r.quote}</div>
                <div className="mt-2.5 text-[12.5px] font-medium leading-[1.68]" style={{ color: 'var(--text-secondary)' }}>
                  {r.diagnosis}
                </div>
                <div className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-bold" style={{ color: skin.fg }}>
                  去 {vol.name}
                  <ArrowRight size={13} strokeWidth={2.6} />
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── 七卷 ── */}
      <section className="mt-14">
        <div className="text-center">
          <div className="inline-block px-4 py-1.5 rounded-full text-[12.5px] font-bold" style={{ background: 'var(--bg-card)', border: EDGE }}>
            七卷
          </div>
          <h2 className="mt-4 font-black tracking-[-0.03em]" style={{ fontSize: 'clamp(28px, 3.4vw, 44px)' }}>
            从开机到上台面
          </h2>
        </div>

        <div className="mt-7 grid gap-3 grid-cols-2 sm:grid-cols-4 xl:grid-cols-7">
          {VOLUMES.map((vol, i) => {
            const Icon = VOLUME_ICON_MAP[vol.icon] ?? BookOpen;
            const skin = VOLUME_SKIN[i % VOLUME_SKIN.length];
            const books = vol.books.filter((b) => matchTrack(b, track));
            const read = books.filter((b) => readBookIds.includes(b.id)).length;
            const passed = examResults[vol.id]?.passed;
            const active = vol.id === activeVolumeId;
            return (
              <button
                key={vol.id}
                type="button"
                onClick={() => setActiveVolumeId(vol.id)}
                className="text-left p-4 rounded-[20px] transition-transform duration-150 hover:-translate-y-0.5"
                style={{
                  background: 'var(--bg-card)',
                  border: active ? '4px solid var(--shelf-edge)' : EDGE,
                  boxShadow: active ? `7px 7px 0 ${skin.fg}` : '5px 5px 0 var(--shelf-edge)',
                }}
              >
                <div className="flex items-center justify-between mb-3 min-h-[36px]">
                  <div className="w-9 h-9 rounded-[11px] grid place-items-center" style={{ background: skin.box, border: EDGE_THIN }}>
                    <Icon size={17} strokeWidth={2.6} style={{ color: skin.fg }} />
                  </div>
                  {passed && <span className="text-[11px] font-bold" style={{ color: skin.fg }}>通关</span>}
                </div>
                <div className="text-[11px] font-bold" style={{ color: 'var(--text-muted)' }}>卷{'一二三四五六七'[i]}</div>
                <div className="text-[19px] font-black tracking-[-0.02em] leading-[1.2]">{vol.name}</div>
                <div className="mt-1.5 h-[34px] overflow-hidden text-[11.5px] font-medium leading-[1.5]" style={{ color: 'var(--text-muted)' }}>
                  {vol.subtitle}
                </div>
                <div className="mt-2.5 flex items-center gap-1.5">
                  <div className="flex-1 h-2.5 rounded-full overflow-hidden" style={{ background: 'var(--bg-base)', border: EDGE_THIN }}>
                    <div className="h-full transition-[width] duration-500" style={{ width: `${books.length ? Math.round(read / books.length * 100) : 0}%`, background: skin.fg }} />
                  </div>
                  <span className="text-[11px] font-bold shrink-0">{read}/{books.length}</span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── 选中卷的书目 ── */}
      <section className="mt-6 p-6 sm:p-7 rounded-[28px]" style={{ background: 'var(--bg-card)', border: '4px solid var(--shelf-edge)', boxShadow: `8px 8px 0 ${activeSkin.fg}` }}>
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="min-w-0">
            <div className="text-[12px] font-bold" style={{ color: 'var(--text-muted)' }}>书目 · 按先读哪本排序</div>
            <div className="text-[26px] font-black tracking-[-0.03em] leading-[1.15]">{activeVolume.name}</div>
            <p className="mt-2 max-w-[640px] text-[13px] font-medium leading-[1.72]" style={{ color: 'var(--text-secondary)' }}>
              {activeVolume.cure}
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 lg:grid-cols-2">
          {activeBooks.map((b, i) => {
            const read = readBookIds.includes(b.id);
            return (
              <div
                key={b.id}
                className="flex gap-3.5 items-start p-4 rounded-[16px]"
                style={{ background: read ? 'var(--bg-base)' : 'transparent', border: EDGE_THIN }}
              >
                <button
                  type="button"
                  title={read ? '取消已读' : '标记已读'}
                  onClick={() => toggleRead(b.id)}
                  className="w-[22px] h-[22px] mt-0.5 rounded-[7px] grid place-items-center shrink-0 transition-transform duration-150 hover:-translate-y-[1px]"
                  style={{ background: read ? activeSkin.fg : 'transparent', border: EDGE_THIN }}
                >
                  {read
                    ? <Check size={12} strokeWidth={3.4} style={{ color: 'var(--bg-card)' }} />
                    : <span className="text-[11px] font-bold" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>}
                </button>
                <div className="min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-[15px] font-black tracking-[-0.01em]">《{b.title}》</span>
                    <span className="text-[12px] font-medium" style={{ color: 'var(--text-muted)' }}>{b.author}</span>
                    <span className="text-[10.5px] font-bold px-1.5 py-0.5 rounded-md" style={{ background: 'var(--bg-base)', color: 'var(--text-muted)' }}>
                      {TRACK_LABEL[b.track]} · {LEVEL_LABEL[b.level]}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] font-medium leading-[1.68]" style={{ color: 'var(--text-secondary)' }}>{b.why}</p>
                  <p className="mt-1.5 text-[12.5px] font-bold leading-[1.6]" style={{ color: activeSkin.fg }}>读完你能：{b.takeaway}</p>
                </div>
              </div>
            );
          })}
        </div>

        {examCount > 0 && (
          <div className="mt-5 flex items-center justify-between gap-5 flex-wrap px-5 py-4 rounded-[18px]" style={{ background: 'var(--bg-base)', border: EDGE }}>
            <div className="min-w-0">
              <div className="text-[14px] font-black">读过和站得住是两回事</div>
              <div className="mt-1 text-[12.5px] font-medium leading-[1.68]" style={{ color: 'var(--text-secondary)' }}>
                {activeResult
                  ? `上次 ${activeResult.correct}/${activeResult.total}${activeResult.passed ? '，已通关。错题解析随时能再看。' : '，还没过。错的地方正是这一卷要治的。'}`
                  : `${examCount} 道判断题，答对 ${Math.ceil(examCount * 0.6)} 道及格。考的是判断，不是记忆。`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setExamVolume(activeVolume)}
              className="shrink-0 px-7 py-3 rounded-full text-[14px] font-bold tracking-[0.14em] transition-transform duration-150 hover:-translate-y-[1px]"
              style={{ background: activeSkin.fg, color: 'var(--bg-card)', border: EDGE, boxShadow: HARD_SM }}
            >
              {activeResult ? '再考一次' : '赴 考'}
            </button>
          </div>
        )}
      </section>

      <TeamBoard volumeSkin={VOLUME_SKIN} />

      <ExamDialog volume={examVolume} open={!!examVolume} onOpenChange={(v) => !v && setExamVolume(null)} />
    </div>
  );
}
