import { BeatNarration, SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { enterAt, useSceneTimeline } from './useSceneTimeline';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * CdsScene —— CDS 的分支页 + 部署记录，缩微版。
 *
 * 这一幕只讲一个概念：**分支即环境**。
 *
 * 上一版把 CDS 塞在「三层一体」里当三分之一块，只够说一句「推一个分支就有一个
 * 能打开的地址」——那是结论，不是解释。用户要求「做成一句话到马上预览、仅需要
 * 一步，然后把分支即环境的概念讲清楚」，所以拆出独立一幕，按真实那两页画：
 *
 *   - 左：分支列表（BranchListPage）—— 每条分支一行，带 commit、容器数、状态
 *   - 右：本次部署记录（部署 run 的阶段日志）—— **日志逐字取自这个首页自己
 *     某一次真实部署**（`cdscli deployment-run show` 拉的 message），不是编的
 *   - 底：这条分支独占什么（域名 / 容器 / 队列前缀 / 库）—— 这才是「分支即环境」
 *
 * 演五拍：push → 拉代码 → 分层构建 → 就绪 + 域名下发 → 摊开独占的四样东西。
 */

const HOLDS = [1900, 2000, 2100, 2000, 3000];
const B = { push: 0, pull: 1, build: 2, ready: 3, own: 4 } as const;

const pine = inkTone(SCENE_HUE.pine);
const amber = inkTone(SCENE_HUE.amber);
const clay = inkTone(SCENE_HUE.clay);

const OWN_ICONS = [
  'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18', // 域名
  'M4 4h7v7H4zM13 13h7v7h-7zM13 4h7v7h-7zM4 13h7v7H4z',                                       // 容器
  'M3 6h18M3 12h18M3 18h11',                                                                   // 队列
  'M12 3c4.4 0 8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3', // 库
];

export function CdsScene() {
  const { t } = useLanguage();
  const s = t.tail.cds;
  const { beat, ref } = useSceneTimeline(HOLDS);
  const deployed = beat >= B.ready;

  return (
    <SceneFrame
      id="scene-cds"
      hue={SCENE_HUE.pine}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      <div ref={ref} className="relative">
        {/* 唯一的那一步：一行 git push。整幕的前提就摆在最上面 */}
        <div
          className="flex items-center gap-2.5 flex-wrap"
          style={{ padding: '12px 16px', borderBottom: `1px solid ${SCENE.hair}` }}
        >
          <span
            className="flex items-center gap-2 min-w-0"
            style={{
              height: '30px', padding: '0 11px', borderRadius: '8px',
              background: SCENE.inset, border: `1px solid ${SCENE.edge}`,
            }}
          >
            <SceneMono size={13} color={clay.bright}>$</SceneMono>
            <SceneMono size={13} color={SCENE.inkSoft} className="truncate">{s.oneStep}</SceneMono>
          </span>
          <span
            className="flex items-center gap-1.5 shrink-0"
            style={{
              height: '24px', padding: '0 9px', borderRadius: '999px', fontSize: '11px',
              background: pine.soft, border: `1px solid ${pine.border}`, color: pine.bright,
            }}
          >
            <span
              className="block w-1.5 h-1.5 rounded-full map-scene-anim"
              style={{ background: pine.solid, animation: 'mapSceneTwinkle 1.9s ease-in-out infinite' }}
            />
            {s.autoChip}
          </span>
          <SceneMono size={13} color={SCENE.inkGhost} className="ml-auto shrink-0">
            {s.projectLabel}
          </SceneMono>
        </div>

        <div className="flex flex-col lg:flex-row gap-4" style={{ padding: '16px' }}>
          {/* 左：分支列表。一行一条分支，这就是 CDS 的主页 */}
          <div className="lg:w-[268px] lg:shrink-0 flex flex-col gap-2">
            <SceneMono size={13} color={SCENE.inkGhost} style={{ letterSpacing: '0.16em', textTransform: 'uppercase' }}>
              {s.branchesLabel}
            </SceneMono>
            {s.branches.map((br, i) => {
              /* 主角那条分支跟着拍子走：前面在构建，就绪那拍起变绿 */
              const state = br.acting ? (deployed ? 'ready' : 'building') : br.state;
              const tone = state === 'ready' ? pine : amber;
              return (
                <div
                  key={br.name}
                  className="flex flex-col gap-1.5"
                  style={{
                    padding: '11px 12px', borderRadius: '11px',
                    background: br.acting ? tone.faint : SCENE.tile,
                    border: `1px solid ${br.acting ? tone.border : SCENE.edge}`,
                    transition: 'background .5s ease, border-color .5s ease',
                    ...enterAt(beat, B.push, { rise: 8, delay: i * 90 }),
                  }}
                >
                  <span className="flex items-center gap-2">
                    <SceneIcon d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 9v6a3 3 0 0 1-3 3h-3" size={12} />
                    <span className="min-w-0 truncate" style={{ fontSize: '12px', color: SCENE.ink }}>{br.name}</span>
                    <span
                      className="ml-auto shrink-0 flex items-center gap-1"
                      style={{
                        height: '18px', padding: '0 7px', borderRadius: '5px', fontSize: '10px',
                        background: tone.soft, color: tone.bright,
                        transition: 'background .5s ease, color .5s ease',
                      }}
                    >
                      {state === 'ready' && <SceneIcon d="M20 6L9 17l-5-5" size={9} strokeWidth={2.6} />}
                      {s.stateLabels[state]}
                    </span>
                  </span>
                  <SceneMono size={11} color={SCENE.inkGhost} className="truncate">{br.meta}</SceneMono>
                </div>
              );
            })}

            {/*
              * 不可变版本：环境能被重建，是「分支即环境」敢这么用的另一半——
              * 代码没变就复用成功版本、出事回滚到标记过的那一版。
              * 顺带把左栏填满：只放三张分支卡时，下面空出近 180px。
              */}
            <div
              className="flex flex-col gap-2 flex-1"
              style={{
                marginTop: '4px', padding: '11px 12px', borderRadius: '11px',
                background: SCENE.ghost, border: `1px solid ${SCENE.hair}`,
                ...enterAt(beat, B.ready, { rise: 8 }),
              }}
            >
              <SceneMono size={12} color={SCENE.inkGhost} style={{ letterSpacing: '0.14em', textTransform: 'uppercase' }}>
                {s.versionsLabel}
              </SceneMono>
              {s.versions.map((v) => (
                <span key={v.id} className="flex items-center gap-2">
                  <SceneMono size={11} color={SCENE.inkDim} className="truncate">{v.id}</SceneMono>
                  <SceneMono size={11} color={SCENE.inkGhost} className="min-w-0 truncate">{v.note}</SceneMono>
                  <span
                    className="ml-auto shrink-0"
                    style={{
                      height: '17px', padding: '0 6px', borderRadius: '4px', fontSize: '9.5px',
                      display: 'inline-flex', alignItems: 'center',
                      background: SCENE.tile, border: `1px solid ${SCENE.edge}`, color: SCENE.inkDim,
                    }}
                  >
                    {v.action}
                  </span>
                </span>
              ))}
              <span style={{ marginTop: '2px', fontSize: '10.5px', lineHeight: 1.6, color: SCENE.inkFaint }}>
                {s.versionsNote}
              </span>
            </div>
          </div>

          {/* 右：本次部署记录 + 就绪后下发的预览地址 */}
          <div
            className="flex-1 min-w-0 flex flex-col overflow-hidden rounded-2xl"
            style={{ border: `1px solid ${SCENE.edge}`, background: SCENE.editorSurface }}
          >
            <div
              className="flex items-center gap-2.5 shrink-0"
              style={{ padding: '10px 14px', borderBottom: `1px solid ${SCENE.hair}` }}
            >
              <SceneIcon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8v4l3 2" size={13} />
              <SceneMono style={{ letterSpacing: '0.16em', textTransform: 'uppercase' }}>{s.runLabel}</SceneMono>
              <SceneMono size={12} className="ml-auto" color={deployed ? pine.bright : amber.bright}>
                {deployed ? s.stateLabels.ready : s.stateLabels.building}
              </SceneMono>
            </div>

            {/* 真实日志逐拍流出来。行首是这一步的序号，跟真实部署记录一样 */}
            <div className="flex flex-col gap-[3px]" style={{ padding: '11px 14px', minHeight: '218px' }}>
              {s.logs.map((log, i) => {
                if (beat < log.at) return null;
                const isLast = i === s.logs.length - 1;
                return (
                  <span
                    key={log.text}
                    className="flex items-baseline gap-2 map-scene-anim"
                    style={{ animation: 'mapSceneBeatIn .4s cubic-bezier(.19,1,.22,1) both' }}
                  >
                    <SceneMono size={11} color={SCENE.inkGhost} style={{ whiteSpace: 'nowrap' }}>
                      {String(i + 1).padStart(2, '0')}
                    </SceneMono>
                    <span
                      className="min-w-0"
                      style={{ fontSize: '11.5px', lineHeight: 1.55, color: isLast ? pine.bright : SCENE.inkMid }}
                    >
                      {log.text}
                    </span>
                  </span>
                );
              })}
            </div>

            {/* 域名下发：这一条出来了，「马上预览」才算兑现 */}
            <div
              className="mt-auto overflow-hidden"
              style={{
                maxHeight: deployed ? '110px' : '0px',
                opacity: deployed ? 1 : 0,
                visibility: deployed ? undefined : 'hidden',
                borderTop: `1px solid ${deployed ? SCENE.hair : 'transparent'}`,
                transition: 'max-height .6s cubic-bezier(.19,1,.22,1), opacity .5s ease',
              }}
            >
              <div className="flex flex-col gap-2" style={{ padding: '11px 14px' }}>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <SceneMono size={12} color={SCENE.inkGhost}>{s.previewLabel}</SceneMono>
                  <span
                    className="min-w-0 flex items-center gap-2"
                    style={{
                      height: '27px', padding: '0 10px', borderRadius: '7px',
                      background: pine.soft, border: `1px solid ${pine.border}`,
                    }}
                  >
                    <SceneIcon d="M9 15l6-6M11 6l1-1a4 4 0 1 1 6 6l-1 1M13 18l-1 1a4 4 0 1 1-6-6l1-1" size={12} />
                    <SceneMono size={12} color={pine.bright} className="truncate">{s.previewShape}</SceneMono>
                  </span>
                  <span
                    className="shrink-0 flex items-center gap-1.5"
                    style={{
                      height: '27px', padding: '0 11px', borderRadius: '7px', fontSize: '11.5px',
                      background: SCENE.tileHi, border: `1px solid ${SCENE.edge}`, color: SCENE.inkSoft,
                    }}
                  >
                    {s.openLabel}
                    <SceneIcon d="M5 12h14M13 6l6 6-6 6" size={11} strokeWidth={2} />
                  </span>
                </div>
                <span style={{ fontSize: '11px', color: SCENE.inkFaint, lineHeight: 1.6 }}>{s.previewNote}</span>
              </div>
            </div>
          </div>
        </div>

        {/*
          * 「分支即环境」的正文：四样这条分支独占的东西。
          * 前面四拍讲的是"怎么来的"，这一拍才是"它到底是什么"——概念落在这里，
          * 不摊开就只剩一句结论。
          */}
        <div
          className="overflow-hidden"
          style={{
            maxHeight: beat >= B.own ? '340px' : '0px',
            opacity: beat >= B.own ? 1 : 0,
            visibility: beat >= B.own ? undefined : 'hidden',
            transition: 'max-height .7s cubic-bezier(.19,1,.22,1), opacity .5s ease',
          }}
        >
          <div style={{ padding: '0 16px 14px' }}>
            <SceneMono className="flex items-center gap-2" style={{ letterSpacing: '0.16em', textTransform: 'uppercase', marginBottom: '9px' }}>
              <span className="block w-[5px] h-[5px] rounded-full" style={{ background: pine.solid }} />
              {s.ownLabel}
            </SceneMono>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2.5">
              {s.own.map((item, i) => (
                <div
                  key={item.title}
                  className="flex flex-col gap-1.5"
                  style={{
                    padding: '12px 13px', borderRadius: '11px',
                    background: SCENE.tile, border: `1px solid ${SCENE.edge}`,
                    ...enterAt(beat, B.own, { rise: 10, delay: i * 90 }),
                  }}
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="flex items-center justify-center shrink-0"
                      style={{ width: '24px', height: '24px', borderRadius: '7px', background: pine.faint, color: pine.solid }}
                    >
                      <SceneIcon d={OWN_ICONS[i]} size={13} />
                    </span>
                    <span style={{ fontSize: '12.5px', color: SCENE.ink }}>{item.title}</span>
                  </span>
                  <span style={{ fontSize: '11px', lineHeight: 1.65, color: SCENE.inkDim }}>{item.desc}</span>
                </div>
              ))}
            </div>
            <div className="flex items-start gap-2" style={{ marginTop: '10px', fontSize: '11.5px', lineHeight: 1.7, color: SCENE.inkFaint }}>
              <SceneIcon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8v5M12 16h.01" size={13} strokeWidth={1.8} />
              <span className="min-w-0">{s.gone}</span>
            </div>
          </div>
        </div>

        <BeatNarration beats={s.beats} beat={beat} hue={SCENE_HUE.pine} />
      </div>
    </SceneFrame>
  );
}
