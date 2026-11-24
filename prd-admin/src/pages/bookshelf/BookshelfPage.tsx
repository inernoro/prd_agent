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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Power, Ruler, Compass, Blocks, ShieldCheck, Cpu, Presentation,
  BookOpen, Check, ArrowRight, type LucideIcon,
} from 'lucide-react';
import { VOLUMES, PAIN_REMEDIES, ALL_BOOKS, findVolume } from '@/lib/bookshelf/catalog';
import { QUESTIONS, questionsOf } from '@/lib/bookshelf/exams';
import { stanceOf, countsAsPassed, examEntryLabel } from '@/lib/bookshelf/examContext';
import { useBookshelfStore } from '@/stores/bookshelfStore';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { BookshelfMobile } from './mobile/BookshelfMobile';
import { CoverBanner } from './covers';
import { useImageryAsset } from '@/hooks/useImagery';
import { bookshelfVolumeSlot } from '@/lib/imagery';
import type { Track, Volume, BookEntry } from '@/lib/bookshelf/types';
import { ExamDialog } from './ExamDialog';
import { TeamBoard } from './TeamBoard';
import { SyncStatusBar } from './SyncStatusBar';

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

/*
 * 手机档（< 640px）的版式纪律，对齐 lib/appStoreTokens 那套 iOS 骨架：
 *   - 一条 20px 基准线（AS_SPACE.gutter）：页眉、标题、正文、卡片左边缘全部对齐到它
 *   - 间距只在 8 的倍数上走（8 / 16 / 24 / 32），不出现 14、18、22 这种随手值
 *   - 圆角三档且外大内小：容器 22 / 内部块 12 / pill 999（AS_SPACE 同档）
 *   - 墨边与硬投影在小屏减半——粗野骨架在 390 宽会把每个块都放大成噪音
 * 桌面档（sm: 以上）保持原来的粗野骨架不变，两套互不干扰。
 * 「不整齐」的根因就是手机上每个元素各有各的边距、圆角和间距，没有共同的刻度。
 */
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

/**
 * 页面入口：按视口分流成两套**结构不同**的实现。
 *
 * 不是 CSS 断点能办的事——手机档按 390 终稿改成了两级导航（落地页 ↔ 卷页），
 * 渲染的节点树与桌面根本不是一棵。所以在渲染时判，而不是靠 `sm:` 类名。
 * `useIsMobile` 用 useSyncExternalStore，只在跨 768px 时翻转，首帧就是准的，没有闪烁。
 *
 * 进度加载放在这一层：两套实现都要它，放在任一侧都会让另一侧漏掉。
 */
export default function BookshelfPage() {
  const isMobile = useIsMobile();
  const loadProgress = useBookshelfStore((s) => s.loadFromServer);
  useEffect(() => { void loadProgress(); }, [loadProgress]);

  if (isMobile) {
    return (
      /*
       * 手机档全出血：`w-screen` + `ml-[calc(50%-50vw)]` 让这块从视口左边缘起算，
       * 不受外壳左右 padding 影响（外壳给的是 `px-[var(--mobile-padding)]`，
       * 值随断点在 10/8px 之间变，写死任何一个数都等着下次漂移）。
       * 竖向用 `-my-3` **精确抵消**外壳的 `py-3`——差一档就会在顶部留一条色带。
       * 左右内边距由内部各屏自己按 20px 基准线给。
       *
       * 背景是纯 --bg-base：终稿把 30px 网格连同墨边、硬投影一起去掉了，
       * 分层只靠 --bg-card 与 --bg-base 的明度差。
       */
      <div
        className="w-screen ml-[calc(50%-50vw)] -my-3 min-h-full"
        style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
      >
        {/* 手机档也要看得见同步失败：这条以前只画在桌面那一半，
            手机用户会一路标着勾、写着心得，而那些改动只在这台设备上（见 SyncStatusBar 注释）。 */}
        <SyncStatusBar className="mx-5 mt-3" />
        <BookshelfMobile skinOf={skinOf} />
      </div>
    );
  }
  return <BookshelfDesktop />;
}

function BookshelfDesktop() {
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

  /*
   * 桌面档点痛点卡/卷卡之后，必须把人带到书目区。
   *
   * 2026-09-14 用户点了「去 懂业务 →」后反馈「除了变了颜色，没有效果呢」——
   * 真正变化的书目区在下面两屏之外，屏幕上确实什么都没动。卡片上写着「去」，
   * 却只换了个选中色，这是拿视觉反馈冒充导航（miduo-review-lens 镜头 4：
   * 变化必须可感知；expectation-management：点了要看得见发生了什么）。
   *
   * 手机档没这个问题——那边点进去是另一屏。
   */
  const booksRef = useRef<HTMLElement>(null);
  const reducedMotion = useReducedMotion();
  function gotoVolume(id: string) {
    setActiveVolumeId(id);
    booksRef.current?.scrollIntoView({
      behavior: reducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  }

  // 别人改地址栏或从另一条深链跳进来时，跟着 URL 走
  useEffect(() => {
    /*
     * 判据是「URL 解析出来的那一卷」，不是「URL 上那一卷认得出吗」。
     *
     * 原先多守了一层 `volFromUrl && resolved === volFromUrl`，于是从侧栏点「藏书阁」
     * 回到没有 ?vol= 的地址时，回落值到不了 state：地址栏显示的是默认入口，
     * 屏幕上还停在上一次选的那一卷，两者对不上。?vol= 写了个认不出的值时同样如此。
     * resolveVolumeFromUrl 本来就负责「缺省与认不出都回落首卷」，这里照用它的结论即可。
     */
    const resolved = resolveVolumeFromUrl(volFromUrl);
    if (resolved !== activeVolumeId) setActiveVolumeIdRaw(resolved);
  }, [volFromUrl, activeVolumeId]);
  const [examVolume, setExamVolume] = useState<Volume | null>(null);

  const readBookIds = useBookshelfStore((s) => s.readBookIds);
  const examResults = useBookshelfStore((s) => s.examResults);
  const toggleRead = useBookshelfStore((s) => s.toggleRead);
  const bookNotes = useBookshelfStore((s) => s.bookNotes);
  const setNote = useBookshelfStore((s) => s.setNote);
  // 正在编辑哪本书的心得（同时只开一个，避免一屏十个输入框）
  const [notingBookId, setNotingBookId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  /*
   * 用户有没有真的动过这个编辑框。手机档修过同一个 bug，桌面这一半当时没修：
   *
   *   刚登录就点「写一句」（此时 loadFromServer 还在路上，bookNotes 里没有这本书，
   *   所以显示的是「写一句」而不是已有的那条）→ 草稿是空串
   *   → hydration 落地，服务端那条笔记到了，而编辑框还是空的
   *   → 点「记下」→ setNote(id, '') → 把那条笔记删了并同步出去
   *
   * 用户一个字没打，笔记没了。所以未编辑时跟随服务端；动过之后以他手上那份为准
   * （「写了又清空」是真实的删除意图，不该被服务端那份盖回去）。
   */
  const noteDraftTouchedRef = useRef(false);

  // 编辑框开着、用户还没动过时，跟随服务端那条（见上面的注释）
  const notingServerNote = notingBookId ? (bookNotes[notingBookId] ?? '') : '';
  useEffect(() => {
    if (!notingBookId || noteDraftTouchedRef.current) return;
    setNoteDraft(notingServerNote);
  }, [notingBookId, notingServerNote]);

  const visibleBooks = useMemo(() => ALL_BOOKS.filter((b) => matchTrack(b, track)), [track]);
  const readCount = visibleBooks.filter((b) => readBookIds.includes(b.id)).length;
  const noteCount = visibleBooks.filter((b) => (bookNotes[b.id] ?? '').trim().length > 0).length;
  // 与看板同一口径：裸考通过不算通关（examContext.countsAsPassed 是唯一判据）
  const passedCount = VOLUMES.filter((v) => {
    const r = examResults[v.id];
    return r ? countsAsPassed(r.passed, r.readAtExam, r.totalAtExam) : false;
  }).length;

  const activeVolume = findVolume(activeVolumeId) ?? VOLUMES[0];
  /* 这一卷的卷面图；没生成就不渲染那一条，卡片回到原来的样子 */
  const activeCover = useImageryAsset(bookshelfVolumeSlot(activeVolume.id) ?? '');
  const activeBooks = activeVolume.books.filter((b) => matchTrack(b, track));
  const activeSkin = skinOf(activeVolume.id);
  const activeResult = examResults[activeVolume.id];
  const examCount = questionsOf(activeVolume.id).length;
  // 按整卷算读了几本（不受开发/产品筛选影响）：一本没读时这不是「赴考」，是摸底。
  const activeTotalBooks = activeVolume.books.length;
  const activeReadBooks = activeVolume.books.filter((b) => readBookIds.includes(b.id)).length;
  const activeStance = stanceOf(activeReadBooks, activeTotalBooks);

  return (
    <div
      // 桌面档：粗野骨架原样保留（3px 墨边 + 硬投影 + 30px 网格 + 整卡五色）。
      // <768px 走的是 BookshelfMobile，两套互不干扰。
      className="w-full -m-6 p-8 min-h-full"
      style={{ background: GRID_BG, color: 'var(--text-primary)' }}
    >
      {/* ── 悬浮 navbar ── */}
      <div className="flex justify-start sm:justify-center">
        <div
          className="w-full sm:w-auto flex items-center gap-3 sm:gap-6 px-4 sm:pl-5 sm:pr-2 py-2 rounded-[14px] sm:rounded-full flex-wrap justify-start sm:justify-center"
          style={{ background: 'var(--shelf-surface)', border: EDGE, boxShadow: HARD_SM }}
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

      {/* 同步状态：只在没同步上时出现，判据与文案在 SyncStatusBar 里（手机档共用同一份）。 */}
      <SyncStatusBar className="mt-4" />

      {/* ── Hero ── */}
      <section className="mt-6 sm:mt-10 flex flex-col lg:flex-row gap-6 sm:gap-10 items-start lg:items-center">
        <div className="flex-1 min-w-0">
          <div
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full text-[12.5px] font-bold"
            style={{ background: 'var(--shelf-surface)', border: EDGE }}
          >
            <span className="w-2 h-2 rounded-full" style={{ background: VOLUME_SKIN[0].fg }} />
            开发者 · 产品经理 · 已读 {readCount}/{visibleBooks.length} · 心得 {noteCount} · 通关 {passedCount}/{VOLUMES.length}
          </div>

          <h1
            className="mt-4 sm:mt-5 font-black leading-[1.0] tracking-[-0.04em]"
            style={{ fontSize: 'clamp(34px, 6vw, 84px)' }}
          >
            看到我，<br />算你有福了
          </h1>

          <p className="mt-4 sm:mt-5 max-w-[470px] text-[15px] font-medium leading-[1.72]" style={{ color: 'var(--text-secondary)' }}>
            七卷不按学科排，按你会在哪一步卡住排。每卷钉着一种团队真实卡住过的处境——从最像你的那条进去。
          </p>
        </div>

        {/* 当前卷卡 */}
        <div
          // 墨边与硬投影在手机档减半：同一套骨架在 390 宽会把每个块都放大成噪音。
          // 走 Tailwind 断点而不是 JS 判断，省掉一次 matchMedia 与首帧闪烁。
          // 通栏卷面图要贴到墨边内沿，所以 padding 下沉到内容层，外层只留 overflow-hidden。
          // 圆角写在外层，图靠 overflow 裁出同样的角，不用再把圆角复制一遍到图上。
          className="w-full lg:w-[390px] shrink-0 overflow-hidden rounded-[22px] sm:rounded-[28px] border-[2.5px] sm:border-4 shadow-[4px_4px_0_var(--vol-skin)] sm:shadow-[8px_8px_0_var(--vol-skin)]"
          style={{
            background: 'var(--shelf-surface)',
            borderColor: 'var(--shelf-edge)',
            ['--vol-skin' as string]: activeSkin.fg,
          }}
        >
          <CoverBanner src={activeCover} height={150} radius={0} />
          <div className={activeCover ? 'px-5 pb-5 sm:px-6 sm:pb-6' : 'p-5 sm:p-6'}>
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
          <div className="text-[26px] sm:text-[32px] font-black tracking-[-0.03em] leading-[1.1]">{activeVolume.name}</div>
          <div
            className="mt-4 px-4 py-3 rounded-[12px] sm:rounded-[15px] border-[2.5px] sm:border-[3px]"
            style={{ background: 'var(--bg-base)', borderColor: 'var(--shelf-edge)' }}
          >
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
              {activeResult
                ? `再考 · ${activeResult.correct}/${activeResult.total}`
                : examEntryLabel(activeReadBooks, activeTotalBooks, examCount)}
            </button>
          )}
          </div>
        </div>
      </section>

      {/* ── 痛点药方 ── */}
      <section className="mt-14">
        <div className="text-center">
          <div className="inline-block px-4 py-1.5 rounded-full text-[12.5px] font-bold" style={{ background: 'var(--shelf-surface)', border: EDGE }}>
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
                onClick={() => gotoVolume(r.volumeId)}
                className="text-left p-4 sm:p-5 rounded-[18px] sm:rounded-[22px] transition-transform duration-150 hover:-translate-y-0.5"
                style={{
                  background: 'var(--shelf-surface)',
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
          <div className="inline-block px-4 py-1.5 rounded-full text-[12.5px] font-bold" style={{ background: 'var(--shelf-surface)', border: EDGE }}>
            七卷
          </div>
          <h2 className="mt-4 font-black tracking-[-0.03em]" style={{ fontSize: 'clamp(28px, 3.4vw, 44px)' }}>
            从开机到上台面
          </h2>
        </div>

        <div className="mt-6 sm:mt-7 grid gap-2 sm:gap-3 grid-cols-2 sm:grid-cols-4 xl:grid-cols-7">
          {VOLUMES.map((vol, i) => {
            const Icon = VOLUME_ICON_MAP[vol.icon] ?? BookOpen;
            const skin = VOLUME_SKIN[i % VOLUME_SKIN.length];
            const books = vol.books.filter((b) => matchTrack(b, track));
            const read = books.filter((b) => readBookIds.includes(b.id)).length;
            const r = examResults[vol.id];
            const passed = r ? countsAsPassed(r.passed, r.readAtExam, r.totalAtExam) : false;
            const active = vol.id === activeVolumeId;
            return (
              <button
                key={vol.id}
                type="button"
                onClick={() => gotoVolume(vol.id)}
                className="text-left p-4 rounded-[20px] transition-transform duration-150 hover:-translate-y-0.5"
                style={{
                  background: 'var(--shelf-surface)',
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
      <section
        ref={booksRef}
        // scroll-mt：滚到这里时顶上留 24px，别让标题贴着视口上沿
        className="mt-6 p-6 sm:p-7 rounded-[28px] scroll-mt-6"
        style={{ background: 'var(--shelf-surface)', border: '4px solid var(--shelf-edge)', boxShadow: `8px 8px 0 ${activeSkin.fg}` }}
      >
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
                className="flex gap-3.5 items-start p-4 rounded-[14px] sm:rounded-[16px]"
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
                    ? <Check size={12} strokeWidth={3.4} style={{ color: 'var(--shelf-surface)' }} />
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

                  {/*
                    唯一的「学习」动作。在此之前藏书阁只有「我点了已读」这个自我声明——
                    一个勾证明不了什么，看板上的「已读 N 本」也就没有分量。
                    写一句「打算在哪用它」才是真读过的痕迹。不设门槛：不写照样能标已读、能考。
                  */}
                  {notingBookId === b.id ? (
                    <div className="mt-2.5">
                      <textarea
                        autoFocus
                        value={noteDraft}
                        maxLength={200}
                        onChange={(e) => { noteDraftTouchedRef.current = true; setNoteDraft(e.target.value); }}
                        placeholder="打算在哪用它？一句话就够。"
                        className="w-full px-3 py-2 text-[12.5px] font-medium leading-[1.6] rounded-[12px] resize-none outline-none"
                        rows={2}
                        style={{ background: 'var(--bg-base)', border: EDGE_THIN, color: 'var(--text-primary)' }}
                      />
                      <div className="mt-1.5 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => { setNote(b.id, noteDraft); setNotingBookId(null); }}
                          className="px-3 py-1 rounded-full text-[11.5px] font-bold"
                          style={{ background: activeSkin.fg, color: 'var(--shelf-surface)', border: EDGE_THIN }}
                        >记下</button>
                        <button
                          type="button"
                          onClick={() => setNotingBookId(null)}
                          className="px-3 py-1 rounded-full text-[11.5px] font-bold"
                          style={{ background: 'transparent', color: 'var(--text-muted)', border: EDGE_THIN }}
                        >取消</button>
                        <span className="text-[11px] font-medium ml-auto" style={{ color: 'var(--text-muted)' }}>
                          {noteDraft.trim().length}/200
                        </span>
                      </div>
                    </div>
                  ) : bookNotes[b.id] ? (
                    <button
                      type="button"
                      onClick={() => { noteDraftTouchedRef.current = false; setNotingBookId(b.id); setNoteDraft(bookNotes[b.id] ?? ''); }}
                      className="mt-2.5 w-full text-left px-3 py-2 rounded-[12px]"
                      style={{ background: 'var(--bg-base)', border: EDGE_THIN }}
                    >
                      <span className="text-[11px] font-bold" style={{ color: 'var(--text-muted)' }}>我的一句话</span>
                      <span className="block mt-0.5 text-[12.5px] font-medium leading-[1.6]">{bookNotes[b.id]}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { noteDraftTouchedRef.current = false; setNotingBookId(b.id); setNoteDraft(''); }}
                      className="mt-2 text-[11.5px] font-bold underline underline-offset-[3px]"
                      style={{ color: 'var(--text-muted)' }}
                    >写一句：打算在哪用它</button>
                  )}
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
                  ? `上次 ${activeResult.correct}/${activeResult.total}${
                      stanceOf(activeResult.readAtExam, activeResult.totalAtExam) === 'blind'
                        ? `（当时这一卷一本没读，不计入通关）`
                        : activeResult.passed
                          ? '，已通关。错题解析随时能再看。'
                          : '，还没过。错的地方正是这一卷要治的。'
                    }`
                  : activeStance === 'blind'
                    ? `这一卷还没开始读。${examCount} 道判断题先摸个底，做完就知道该从哪本入手。`
                    : `${examCount} 道判断题，答对 ${Math.ceil(examCount * 0.6)} 道及格。考的是判断，不是记忆。`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setExamVolume(activeVolume)}
              className="shrink-0 px-7 py-3 rounded-full text-[14px] font-bold tracking-[0.14em] transition-transform duration-150 hover:-translate-y-[1px]"
              style={{ background: activeSkin.fg, color: 'var(--shelf-surface)', border: EDGE, boxShadow: HARD_SM }}
            >
              {activeResult ? '再考一次' : activeStance === 'blind' ? '先摸个底' : '赴 考'}
            </button>
          </div>
        )}
      </section>

      <TeamBoard volumeSkin={VOLUME_SKIN} />

      <ExamDialog volume={examVolume} open={!!examVolume} onOpenChange={(v) => !v && setExamVolume(null)} />
    </div>
  );
}
