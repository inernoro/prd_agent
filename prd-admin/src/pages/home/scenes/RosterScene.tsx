import { useMemo } from 'react';
import { BeatNarration, SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { useSceneTimeline, useTypewriter } from './useSceneTimeline';
import { useLanguage } from '../contexts/LanguageContext';
import type { RosterItem } from '../i18n/landing';

/**
 * RosterScene —— Agent 全家福：照百宝箱（`stores/toolboxStore.ts` 的 BUILTIN_TOOLS）画的台面。
 *
 * 取代了原来的「六段 Agent 深潜」（5828px，占整页三分之一，且头两段和前面两幕
 * 讲的是同一个视觉/文学）+「十五位 Agent」网格。那两块合起来 7213px 说的事，
 * 一屏密排就说完了，而且说得更全：真实注册表里是三十几个，不是六个。
 *
 * 名字、一句话、图标、预览标记全部取自那份注册表——不编。
 *
 * 演一次搜索：输入「配图」→ 相关的浮上来、其余淡下去。这是这一幕的命题
 * （"想干什么就搜什么"），也是它和「一堆卡片摆在那儿」的区别。
 */

const HOLDS = [1800, 1500, 2400, 1900];
const B = { grid: 0, typing: 1, filtered: 2, pick: 3 } as const;

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
  FileBarChart: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 17v-3M12 17v-6M16 17v-2',
  FileText: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4',
  AudioLines: 'M2 12h2M6 8v8M10 5v14M14 8v8M18 10v4M22 12h-2',
  Blocks: 'M4 4h7v7H4zM13 13h7v7h-7zM13 4h7v7h-7zM4 13h7v7H4z',
  Swords: 'M14 4h6v6M20 4l-8 8M4 14l6 6M4 20h6v-6M10 4H4v6M20 20h-6v-6',
  PaSecretary: 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21a8 8 0 0 1 16 0',
};
const FALLBACK_ICON = 'M4 4h16v16H4z';

/** 搜到「配图」时该浮上来的条目 —— 判定放在一处，别让每个卡片各判各的。 */
function matchesQuery(item: RosterItem, query: string): boolean {
  if (!query) return true;
  const hay = `${item.name} ${item.desc}`.toLowerCase();
  return hay.includes(query.toLowerCase());
}

export function RosterScene() {
  const { t } = useLanguage();
  const s = t.tail.roster;
  const { beat, ref } = useSceneTimeline(HOLDS);
  const typed = useTypewriter(s.searchWord, beat === B.typing, 900);

  /** 打字那一拍跟着已输入的部分实时筛，筛完的两拍保持筛后状态 */
  const query = beat === B.typing ? typed : beat >= B.filtered ? s.searchWord : '';
  const total = useMemo(() => s.groups.reduce((n, g) => n + g.items.length, 0), [s.groups]);
  const hitCount = useMemo(
    () => s.groups.reduce((n, g) => n + g.items.filter((i) => matchesQuery(i, query)).length, 0),
    [s.groups, query],
  );

  return (
    <SceneFrame
      id="scene-roster"
      hue={SCENE_HUE.amber}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      <div ref={ref}>
        {/* 台面顶部：搜索条 + 计数。搜索是这一幕的主角，摆在最上面 */}
        <div
          className="relative flex items-center gap-2.5 flex-wrap"
          style={{ padding: '13px 16px', borderBottom: `1px solid ${SCENE.hair}` }}
        >
          <div
            className="flex-1 min-w-[220px] flex items-center gap-2"
            style={{
              height: '34px', padding: '0 11px', borderRadius: '9px',
              background: SCENE.tile,
              border: `1px solid ${beat === B.typing ? inkTone(SCENE_HUE.amber).border : SCENE.edge}`,
              fontSize: '12.5px',
              color: query ? SCENE.ink : SCENE.inkFaint,
              transition: 'border-color .35s ease',
            }}
          >
            <SceneIcon d="M11 17a6 6 0 1 0 0-12 6 6 0 0 0 0 12M21 21l-5.2-5.2" size={14} />
            {query || s.searchPlaceholder}
            {beat === B.typing && (
              <span
                className="inline-block map-scene-anim"
                style={{
                  width: '2px', height: '13px', background: inkTone(SCENE_HUE.amber).solid,
                  animation: 'mapSceneCaret 1s steps(1) infinite',
                }}
              />
            )}
          </div>
          <SceneMono size={14} color={SCENE.inkDim} style={{ whiteSpace: 'nowrap' }}>
            {query ? `${hitCount} / ${total}` : `${total}`}
          </SceneMono>
        </div>

        {/* 四组密排。命中的抬起来，没命中的压下去——不是隐藏，是让位 */}
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

                {group.items.map((item, ii) => {
                  const hit = matchesQuery(item, query);
                  const picked = beat >= B.pick && hit;
                  const entered = beat >= B.grid;
                  const enterDelay = (gi * 4 + ii) * 45;
                  return (
                    <div
                      key={item.name}
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
                        <SceneIcon d={ICON_PATHS[item.icon] ?? FALLBACK_ICON} size={15} />
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
