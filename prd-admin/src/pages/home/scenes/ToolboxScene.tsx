import { useMemo } from 'react';
import { BeatNarration, SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { useSceneTimeline, useTypewriter } from './useSceneTimeline';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { SceneCursor, type CursorSpot } from '../components/SceneCursor';
import { useLanguage } from '../contexts/LanguageContext';
import type { RosterItem } from '../i18n/landing';

/**
 * ToolboxScene —— 百宝箱，照 `pages/ai-toolbox/AiToolboxPage.tsx` 画的缩微版。
 *
 * 页面上有什么，这里就有什么：
 *   - 权属 tab（全部 / 我的 / 别人的 / 收藏）    → 该页 CATEGORY_TABS
 *   - 类型 tab（全部类型 / 智能体 / 工具）        → 该页 KIND_TABS
 *   - 搜索框 placeholder「搜索工具名称、描述或标签...」→ 与该页逐字一致
 *   - 计数 pill / 展示方式切换 / 最近使用条        → toolbox-count-pill、
 *     toolbox-display-switch、toolbox-recent-strip
 * 条目本身取自 `stores/toolboxStore.ts` 的 BUILTIN_TOOLS（含 wip 标记）。
 *
 * 上一版只画了「一个搜索框 + 一片卡片」——样式对，但系统里没有那个界面。
 * 用户原话：「不够真实，首先得需要我们的真实页面」。
 *
 * 演一次搜索：输入「配图」→ 相关的浮上来、其余淡下去。
 */

const HOLDS = [1800, 1500, 2400, 1900];
const B = { grid: 0, typing: 1, filtered: 2, pick: 3 } as const;

/** 要等手真的落到目标上才开始的拍（理由见 useSceneTimeline 的 gates 说明）。 */
const GATED = new Set<number>([B.pick]);

/**
 * 指针走位表。第 1 拍手停在搜索框上（旁白是「想干什么就搜什么」——打字不该按下去，
 * 按下去反而是假动作）；第 2 拍筛完结果、手提前移到即将点的那张卡上；
 * 第 3 拍才按下，卡片才被选中。
 */
const CURSOR_AT: Record<number, CursorSpot> = {
  [B.typing]: { target: 'search-box', ax: 0.3 },
  [B.filtered]: { target: 'picked-card' },
  [B.pick]: { target: 'picked-card', press: true },
};

/** 四组各一支墨色：创作陶土 / 交付焦糖 / 沉淀橄榄 / 协同钢青。 */
const GROUP_HUES = [SCENE_HUE.clay, 32, SCENE_HUE.olive, SCENE_HUE.steel];

/**
 * 图标：这一幕只需要形，不引 lucide 全量（首页是未登录页，能省一个包就省一个）。
 * key 用注册表里的图标名，对不上就落到通用方块，不留空。
 */
const ICON_PATHS: Record<string, string> = {
  Palette: 'M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2v-1a2 2 0 0 1 2-2h1c1.1 0 2-.9 2-2a10 10 0 0 0-7-11M7.5 11.5h.01M12 7.5h.01M16.5 9.5h.01',
  PenTool: 'M18.4 2.6a2 2 0 0 1 3 3L9 18l-4 1 1-4zM14 6l4 4',
  Clapperboard: 'M4 11h16v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 11l1.5-5 15 1.5L19 11',
  Video: 'M3 6h12v12H3zM15 10l6-3v10l-6-3',
  Bug: 'M8 6h8v3a4 4 0 0 1-8 0zM6 13h12M4 10h2M18 10h2M5 17h3M16 17h3',
  GitPullRequest: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9v6a3 3 0 0 1-3 3h-3',
  FolderKanban: 'M4 5a2 2 0 0 1 2-2h3l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM9 11v4M15 11v2',
  Terminal: 'M5 7l4 4-4 4M12 15h7',
  BookOpen: 'M4 5a2 2 0 0 1 2-2h11v18H6a2 2 0 0 1-2-2zM17 3v18',
  Share2: 'M18 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M6 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M18 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5M8.2 10.9l7.6-3.8M8.2 13.1l7.6 3.8',
  FileBarChart: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 17v-3M12 17v-6M16 17v-2',
  FileText: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4',
  AudioLines: 'M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h-2',
  Blocks: 'M4 4h7v7H4zM13 13h7v7h-7zM13 4h7v7h-7zM4 13h7v7H4z',
  Swords: 'M14 4h6v6M20 4l-8 8M4 14l6 6M4 20h6v-6M10 4H4v6M20 20h-6v-6',
  PaSecretary: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21a8 8 0 0 1 16 0',
};
export const FALLBACK_ICON = 'M4 4h16v16H4z';

/**
 * 名字 → 图标路径。查不到就落到通用方块，不留空。
 *
 * 导出这一个函数、而不是导出上面那张表，是为了让守卫**跑一次真值**而不是扫源码：
 * 键存在不等于画得出来（值可能是空串、可能就等于兜底方块），而换个写法（加引号的键、
 * 展开一张共享表）又会让扫源码的判据无谓地红。判据要读的是这里的返回值。
 */
export function toolboxIconPath(icon: string): string {
  return ICON_PATHS[icon] ?? FALLBACK_ICON;
}

/** 权属 / 类型 tab 的图标，对齐 AiToolboxPage 里 CATEGORY_TABS、KIND_TABS 的 lucide 选型。 */
const TAB_ICONS = [
  'M4 4h7v7H4zM13 13h7v7h-7zM13 4h7v7h-7zM4 13h7v7H4z',              // Boxes 全部
  'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21a8 8 0 0 1 16 0',            // User 我的
  'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18', // Globe2 别人的
  'M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8z', // Star 收藏
];
const KIND_ICONS = [
  'M4 4h7v7H4zM13 13h7v7h-7zM13 4h7v7h-7zM4 13h7v7H4z',               // Boxes 全部类型
  'M9 3h6v3h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3zM9 12h.01M15 12h.01', // Bot 智能体
  'M13 2L4 14h6l-1 8 9-12h-6z',                                        // Zap 工具
];

/** 搜到「配图」时该浮上来的条目 —— 判定放在一处，别让每个卡片各判各的。 */
function matchesQuery(item: RosterItem, query: string): boolean {
  if (!query) return true;
  const hay = `${item.name} ${item.desc}`.toLowerCase();
  return hay.includes(query.toLowerCase());
}

export function ToolboxScene() {
  const { t } = useLanguage();
  const s = t.tail.toolbox;
  // 必须在节拍器之前取：gates 要用它决定启不启用（不画指针就没人 release）
  const { isDesktop } = useBreakpoint();
  const { beat, ref, armed, release } = useSceneTimeline(HOLDS, { gates: isDesktop ? GATED : undefined });
  const typed = useTypewriter(s.searchWord, beat === B.typing, 900);
  const amber = inkTone(SCENE_HUE.amber);

  /** 打字那一拍跟着已输入的部分实时筛，筛完的两拍保持筛后状态 */
  const query = beat === B.typing ? typed : beat >= B.filtered ? s.searchWord : '';
  const total = useMemo(() => s.groups.reduce((n, g) => n + g.items.length, 0), [s.groups]);
  const hitCount = useMemo(
    () => s.groups.reduce((n, g) => n + g.items.filter((i) => matchesQuery(i, query)).length, 0),
    [s.groups, query],
  );

  return (
    <SceneFrame
      id="scene-toolbox"
      hue={SCENE_HUE.amber}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      <div ref={ref} className="relative">
        {/* 演示指针：打字那一拍停在搜索框上（停，不按 —— 按下去就成了假动作），
            「选一个」那一拍才真的按在卡片上。窄屏不画。 */}
        {isDesktop && <SceneCursor spot={CURSOR_AT[armed ?? beat] ?? null} beat={armed ?? beat} onArrive={release} />}
        {/* 控制条：权属 tab + 类型 tab + 搜索 + 计数 + 展示切换，照真实那一页的顺序摆 */}
        <div
          className="relative flex items-center gap-2 flex-wrap"
          style={{ padding: '12px 16px', borderBottom: `1px solid ${SCENE.hair}` }}
        >
          <div className="flex items-center gap-0.5 shrink-0" style={{ padding: '2px', borderRadius: '9px', background: SCENE.tile }}>
            {s.tabs.map((tab, i) => (
              <span
                key={tab}
                className="flex items-center gap-1.5"
                style={{
                  height: '26px', padding: '0 9px', borderRadius: '7px', fontSize: '11.5px',
                  background: i === 0 ? SCENE.tileHi : 'transparent',
                  color: i === 0 ? SCENE.ink : SCENE.inkFaint,
                }}
              >
                <SceneIcon d={TAB_ICONS[i]} size={12} />
                {tab}
              </span>
            ))}
          </div>
          <div className="hidden xl:flex items-center gap-0.5 shrink-0" style={{ padding: '2px', borderRadius: '9px', background: SCENE.tile }}>
            {s.kindTabs.map((tab, i) => (
              <span
                key={tab}
                className="flex items-center gap-1.5"
                style={{
                  height: '26px', padding: '0 9px', borderRadius: '7px', fontSize: '11.5px',
                  background: i === 0 ? SCENE.tileHi : 'transparent',
                  color: i === 0 ? SCENE.ink : SCENE.inkFaint,
                }}
              >
                <SceneIcon d={KIND_ICONS[i]} size={12} />
                {tab}
              </span>
            ))}
          </div>

          <div
            data-cursor-target="search-box"
            className="flex-1 min-w-[190px] flex items-center gap-2"
            style={{
              height: '30px', padding: '0 10px', borderRadius: '9px',
              background: SCENE.tile,
              border: `1px solid ${beat === B.typing ? amber.border : SCENE.edge}`,
              fontSize: '12px',
              color: query ? SCENE.ink : SCENE.inkGhost,
              transition: 'border-color .35s ease',
            }}
          >
            <SceneIcon d="M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12M21 21l-5.2-5.2" size={13} />
            <span className="truncate">{query || s.searchPlaceholder}</span>
            {beat === B.typing && (
              <span
                className="inline-block map-scene-anim shrink-0"
                style={{ width: '2px', height: '12px', background: amber.solid, animation: 'mapSceneCaret 1s steps(1) infinite' }}
              />
            )}
          </div>

          <SceneMono size={13} color={SCENE.inkDim} className="shrink-0" style={{ whiteSpace: 'nowrap' }}>
            {query ? `${hitCount} / ${total}` : `${total} ${s.countSuffix}`}
          </SceneMono>

          {/* 展示方式切换（网格 / 列表），真实那页在计数右边 */}
          <div className="hidden sm:flex items-center gap-0.5 shrink-0" style={{ padding: '2px', borderRadius: '8px', background: SCENE.tile }}>
            {['M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', 'M4 6h16M4 12h16M4 18h16'].map((d, i) => (
              <span
                key={d}
                className="flex items-center justify-center"
                style={{
                  width: '24px', height: '24px', borderRadius: '6px',
                  background: i === 0 ? SCENE.tileHi : 'transparent',
                  color: i === 0 ? SCENE.ink : SCENE.inkGhost,
                }}
              >
                <SceneIcon d={d} size={12} />
              </span>
            ))}
          </div>
        </div>

        {/* 最近使用条 —— 真实那页在控制条与网格之间 */}
        <div
          className="relative flex items-center gap-2 flex-wrap"
          style={{ padding: '9px 16px', borderBottom: `1px solid ${SCENE.hair}` }}
        >
          <SceneMono size={13} color={SCENE.inkGhost} className="shrink-0">{s.recentLabel}</SceneMono>
          {s.recent.map((name) => (
            <span
              key={name}
              style={{
                height: '22px', padding: '0 9px', borderRadius: '999px', fontSize: '11px',
                display: 'inline-flex', alignItems: 'center',
                background: SCENE.tile, border: `1px solid ${SCENE.edge}`, color: SCENE.inkDim,
              }}
            >
              {name}
            </span>
          ))}
        </div>

        {/* 四组密排。命中的抬起来，没命中的压下去——不是隐藏，是让位 */}
        {/*
          * 手机上四组各自纵向排、整列一路铺下去 = 16 张卡叠成一千多像素。
          * 组内改两列（组标题仍占满一行），手机端这一段砍掉一半高度。
          */}
        <div className="relative grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3.5" style={{ padding: '16px' }}>
          {s.groups.map((group, gi) => {
            const tone = inkTone(GROUP_HUES[gi]);
            return (
              <div key={group.label} className="flex flex-col gap-2.5">
                <SceneMono
                  className="flex items-center gap-2"
                  style={{ letterSpacing: '0.16em', textTransform: 'uppercase' }}
                >
                  <span className="block w-[5px] h-[5px] rounded-full" style={{ background: tone.solid }} />
                  {group.label}
                </SceneMono>

                <div className="grid grid-cols-2 md:grid-cols-1 gap-2.5">
                {group.items.map((item, ii) => {
                  const hit = matchesQuery(item, query);
                  const picked = beat >= B.pick && hit;
                  const entered = beat >= B.grid;
                  const enterDelay = (gi * 4 + ii) * 45;
                  return (
                    <div
                      key={item.name}
                      // 「选一个，直接开工」点的就是筛完之后剩下的第一张卡。
                      // 命中多张时指针取第一个，确定、可复现。
                      data-cursor-target={hit ? 'picked-card' : undefined}
                      className="flex items-start gap-2.5"
                      style={{
                        padding: '11px 12px',
                        borderRadius: '11px',
                        background: picked ? tone.soft : SCENE.tile,
                        border: `1px solid ${picked ? tone.border : SCENE.edge}`,
                        /*
                         * 进场与筛选是**两个都作用在 opacity/transform 上**的效果，必须合成一次写出来。
                         * 第一版把 enterAt 摊在筛选之后，后写的 opacity: 1 把 0.26 覆盖掉了，
                         * 筛选看着在跑（旁白都换句了）实际一张卡都没暗——
                         * 正是 predicate-and-wiring-discipline 形状 6：读到的不是真正生效的那个值。
                         */
                        opacity: entered ? (hit ? 1 : 0.26) : 0,
                        transform: entered ? (hit ? 'translateY(0)' : 'translateY(2px)') : 'translateY(8px) scale(.985)',
                        transition: `opacity .45s cubic-bezier(.19,1,.22,1) ${enterDelay}ms, transform .45s cubic-bezier(.19,1,.22,1) ${enterDelay}ms, background .35s ease, border-color .35s ease`,
                      }}
                    >
                      <span
                        className="flex items-center justify-center shrink-0"
                        style={{
                          width: '30px', height: '30px', borderRadius: '9px',
                          background: tone.faint, color: tone.solid,
                        }}
                      >
                        <SceneIcon d={toolboxIconPath(item.icon)} size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span style={{ fontSize: '12.5px', color: SCENE.ink }}>{item.name}</span>
                          {item.preview && (
                            <span
                              style={{
                                height: '15px', padding: '0 5px', borderRadius: '4px', fontSize: '9.5px',
                                display: 'inline-flex', alignItems: 'center',
                                background: SCENE.tileHi, color: SCENE.inkDim,
                              }}
                            >
                              {s.previewTag}
                            </span>
                          )}
                        </span>
                        <span
                          className="block"
                          style={{ marginTop: '3px', fontSize: '11px', lineHeight: 1.6, color: SCENE.inkDim }}
                        >
                          {item.desc}
                        </span>
                      </span>
                    </div>
                  );
                })}
                </div>
              </div>
            );
          })}
        </div>

        <div
          className="relative flex items-center gap-2"
          style={{ padding: '0 16px 14px', fontSize: '11.5px', color: SCENE.inkFaint }}
        >
          <SceneIcon d="M5 12h14M13 6l6 6-6 6" size={12} strokeWidth={1.8} />
          {beat >= B.filtered ? s.emptyHint : s.footer}
        </div>

        <BeatNarration beats={s.beats} beat={beat} hue={SCENE_HUE.amber} />
      </div>
    </SceneFrame>
  );
}
