import { BeatNarration, SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { enterAt, useSceneTimeline } from './useSceneTimeline';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * ModelLayerScene —— 模型池，照 LLMGW 控制台 `/pools`（`llmgw/web/src/pages/ModelPoolsPage.tsx`）
 * 那张表画的缩微版。
 *
 * 列名逐字取自那一页的表头：状态 / 池·类型 / 证据 / 成员顺位 / 成功率·窗口 /
 * 平均耗时·窗口 / 请求·窗口。其中**成员顺位**是这张表的灵魂——池里成员排着队，
 * 第一顺位优先，挂了后面顶上；上一版自造的「成员 / 上游 / 健康 / 首字延迟」
 * 四列虽然看着像，但网关里没有那张表。
 *
 * 演三拍：六池就位 → chat-default 第二顺位挂掉、成功率掉、池转「观察」→
 * 第三顺位顶上、成功率回到原位。
 */

const HOLDS = [2100, 2400, 2600];
const B = { listed: 0, down: 1, promoted: 2 } as const;

const pine = inkTone(SCENE_HUE.pine);
const amber = inkTone(SCENE_HUE.amber);
const clay = inkTone(SCENE_HUE.clay);

/** 表格列宽照那一页的 grid-template-columns 收敛成六列（窄屏按同样的优先级往下砍）。 */
const GRID = 'minmax(58px,0.6fr) minmax(112px,1.2fr) minmax(150px,2.1fr) minmax(80px,0.8fr) minmax(88px,0.8fr) minmax(76px,0.7fr)';

export function ModelLayerScene() {
  const { t } = useLanguage();
  const s = t.tail.models;
  const { beat, ref } = useSceneTimeline(HOLDS);

  /** 出事的那一池在这一拍是什么状态 —— 三处（状态 chip、成功率、顺位）都读它，不各判各的 */
  const degraded = beat === B.down;
  const actingTone = degraded ? amber : pine;

  return (
    <SceneFrame
      id="scene-models"
      hue={SCENE_HUE.steel}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      <div ref={ref} className="relative">
        <div className="flex flex-col lg:flex-row gap-4" style={{ padding: '16px' }}>
          {/* 左：一层的规模，三个数说完 */}
          <div className="lg:w-[230px] lg:shrink-0 flex lg:flex-col gap-2.5">
            {s.counts.map((item, i) => (
              <span
                key={item.label}
                className="flex-1 flex flex-col gap-1"
                style={{
                  borderRadius: '11px',
                  background: SCENE.tile,
                  border: `1px solid ${SCENE.edge}`,
                  padding: '13px 14px',
                  ...enterAt(beat, B.listed, { rise: 8, delay: i * 90 }),
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(1.5rem, 2.4vw, 2rem)',
                    fontWeight: 500,
                    letterSpacing: '-0.02em',
                    color: SCENE.ink,
                    lineHeight: 1.1,
                  }}
                >
                  {item.value}
                </span>
                <span style={{ fontSize: '11.5px', color: SCENE.inkDim, whiteSpace: 'nowrap' }}>{item.label}</span>
              </span>
            ))}
          </div>

          {/* 右：池列表。这就是 /pools 那张表 */}
          <div
            className="flex-1 min-w-0 flex flex-col overflow-hidden rounded-2xl"
            style={{ border: `1px solid ${SCENE.edge}`, background: SCENE.editorSurface }}
          >
            <div
              className="flex items-center gap-2.5 shrink-0 flex-wrap"
              style={{ padding: '11px 16px', borderBottom: `1px solid ${SCENE.hair}` }}
            >
              <SceneIcon d="M12 2l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5" size={13} />
              <SceneMono style={{ letterSpacing: '0.16em', textTransform: 'uppercase' }}>{s.counts[2].label}</SceneMono>
              <SceneMono size={13} className="ml-auto" color={SCENE.inkGhost}>
                {s.counts[2].value} {s.countSuffix}
              </SceneMono>
            </div>

            {/* 表头：列名与那一页逐字一致，窗口后缀也带上 */}
            <div
              className="hidden sm:grid shrink-0"
              style={{
                gridTemplateColumns: GRID,
                gap: '10px',
                padding: '8px 16px',
                borderBottom: `1px solid ${SCENE.hair}`,
              }}
            >
              {[
                s.columns.status, s.columns.pool, s.columns.members,
                `${s.columns.success}·${s.windowText}`, `${s.columns.duration}·${s.windowText}`, `${s.columns.requests}·${s.windowText}`,
              ].map((c, i) => (
                // 表头写死不换行：带「·近 24h」后缀的两列一折行，整条表头就高出一截
                <SceneMono key={c} size={12} style={{ textAlign: i >= 3 ? 'right' : 'left', whiteSpace: 'nowrap' }}>{c}</SceneMono>
              ))}
            </div>

            <div className="flex flex-col">
              {s.pools.map((pool, pi) => {
                const acting = pool.acting === true;
                const tone = acting ? actingTone : pine;
                const success = acting && degraded ? (pool.successDegraded ?? pool.success) : pool.success;
                return (
                  <div
                    key={pool.name}
                    className="grid items-center"
                    style={{
                      gridTemplateColumns: GRID,
                      gap: '10px',
                      padding: '10px 16px',
                      borderBottom: pi < s.pools.length - 1 ? `1px solid ${SCENE.hair}` : undefined,
                      background: acting && degraded ? amber.faint : 'transparent',
                      transition: 'background .5s ease',
                      ...enterAt(beat, B.listed, { rise: 6, delay: pi * 70 }),
                    }}
                  >
                    <span className="flex items-center">
                      <span
                        className="flex items-center gap-1"
                        style={{
                          height: '19px', padding: '0 7px', borderRadius: '5px', fontSize: '10.5px',
                          background: tone.soft, color: tone.bright,
                          transition: 'background .5s ease, color .5s ease',
                        }}
                      >
                        <SceneIcon
                          d={acting && degraded ? 'M12 8v5M12 17h.01M10.3 3.9L2.6 17a1.6 1.6 0 0 0 1.4 2.4h16a1.6 1.6 0 0 0 1.4-2.4L13.7 3.9a1.6 1.6 0 0 0-2.8 0z' : 'M20 6L9 17l-5-5'}
                          size={10}
                          strokeWidth={2.2}
                        />
                        {acting && degraded ? s.statusLabels.watch : s.statusLabels.ok}
                      </span>
                    </span>

                    <span className="min-w-0 flex flex-col">
                      <span className="truncate" style={{ fontSize: '12.5px', color: SCENE.ink }}>{pool.name}</span>
                      <span className="truncate" style={{ fontSize: '10.5px', color: SCENE.inkGhost }}>
                        {pool.type} · {pool.evidence}
                      </span>
                    </span>

                    {/* 成员顺位：这一列是这张表和「一排 logo」的全部区别 */}
                    <span className="min-w-0 flex items-center gap-1 flex-wrap">
                      {pool.members.map((m, mi) => {
                        /* 第二顺位（索引 1）在 down 之后就挂了；第三顺位在 promoted 那拍顶上 */
                        const isDown = acting && mi === 1 && beat >= B.down;
                        const isPromoted = acting && mi === 2 && beat >= B.promoted;
                        return (
                          <span
                            key={m}
                            className="flex items-center gap-1"
                            style={{
                              height: '19px', padding: '0 6px', borderRadius: '5px', fontSize: '10.5px',
                              background: isPromoted ? pine.soft : isDown ? clay.faint : SCENE.tile,
                              border: `1px solid ${isPromoted ? pine.border : isDown ? clay.border : SCENE.edge}`,
                              color: isPromoted ? pine.bright : isDown ? SCENE.inkGhost : SCENE.inkDim,
                              textDecoration: isDown ? 'line-through' : undefined,
                              transition: 'background .5s ease, border-color .5s ease, color .5s ease',
                            }}
                          >
                            <SceneMono size={11} color={isPromoted ? pine.bright : SCENE.inkGhost}>{mi + 1}</SceneMono>
                            {m}
                            {isDown && <span style={{ fontSize: '9.5px' }}>{s.downTag}</span>}
                            {isPromoted && <span style={{ fontSize: '9.5px' }}>{s.promotedTag}</span>}
                          </span>
                        );
                      })}
                    </span>

                    <SceneMono
                      size={13}
                      color={acting && degraded ? amber.bright : SCENE.inkMid}
                      style={{ textAlign: 'right', transition: 'color .5s ease' }}
                    >
                      {success}
                    </SceneMono>
                    <SceneMono size={13} color={SCENE.inkMid} style={{ textAlign: 'right' }}>{pool.duration}</SceneMono>
                    <SceneMono size={13} color={SCENE.inkDim} style={{ textAlign: 'right' }}>{pool.requests}</SceneMono>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <BeatNarration beats={s.beats} beat={beat} hue={SCENE_HUE.steel} />
      </div>
    </SceneFrame>
  );
}
