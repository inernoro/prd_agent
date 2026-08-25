import { BeatNarration, SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { enterAt, useSceneTimeline } from './useSceneTimeline';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * ModelLayerScene —— 模型这一层：LLMGW 模型池的真实切片。
 *
 * 取代了原来的「一套配置，连接你用过的所有大模型」——那一幕是一排 logo，
 * 着墨率 0.32、纵向覆盖 47%，是全页最空的一块，而且 logo 墙说明不了任何事。
 *
 * 真实的样子是**模型池**：一池若干成员，各自的上游、健康、首字延迟；
 * 某个成员坏了转隔离，请求自动落到下一个，调用方无感。这才是「一套配置连所有模型」
 * 这句话背后真正在发生的事。
 *
 * 演三拍：五个成员就位 → DeepSeek 转半开（用受限真实请求探它，不发合成探测）→
 * Kimi 隔离、流量落到 Claude。健康态的切换是这一幕唯一要讲的动作。
 */

const HOLDS = [2000, 2200, 2600];
const B = { listed: 0, half: 1, isolated: 2 } as const;

const steel = inkTone(SCENE_HUE.steel);
const pine = inkTone(SCENE_HUE.pine);
const amber = inkTone(SCENE_HUE.amber);
const clay = inkTone(SCENE_HUE.clay);

type Health = 'ok' | 'half' | 'down';

/** 这一拍某个成员的健康：前面几拍都还好，后面逐个转坏，好让人看清"换人"这件事。 */
function healthAt(declared: Health, beat: number): Health {
  if (declared === 'half') return beat >= B.half ? 'half' : 'ok';
  if (declared === 'down') return beat >= B.isolated ? 'down' : 'ok';
  return declared;
}

const HEALTH_TONE: Record<Health, ReturnType<typeof inkTone>> = {
  ok: pine,
  half: amber,
  down: clay,
};
const HEALTH_ICON: Record<Health, string> = {
  ok: 'M20 6L9 17l-5-5',
  // 半开画成"圆里一条竖线"：只画右半弧会被读成字母 D
  half: 'M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18M12 3v18',
  down: 'M18 6L6 18M6 6l12 12',
};

export function ModelLayerScene() {
  const { t } = useLanguage();
  const s = t.tail.models;
  const { beat, ref } = useSceneTimeline(HOLDS);

  /** 隔离之后，流量落到第一个仍然健康的成员——这条线要指到具体的人 */
  const fallbackTo = s.members.find((m) => healthAt(m.health, beat) === 'ok')?.model;

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
          {/* 左：配置概览计数 —— 一层的规模，三个数说完 */}
          <div className="lg:w-[260px] lg:shrink-0 flex lg:flex-col gap-2.5">
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

          {/* 右：一个池的成员表 */}
          <div
            className="flex-1 min-w-0 flex flex-col overflow-hidden rounded-2xl"
            style={{ border: `1px solid ${SCENE.edge}`, background: SCENE.editorSurface }}
          >
            <div
              className="flex items-center gap-2.5 shrink-0 flex-wrap"
              style={{ padding: '12px 16px', borderBottom: `1px solid ${SCENE.hair}` }}
            >
              <SceneMono style={{ letterSpacing: '0.16em', textTransform: 'uppercase' }}>{s.poolLabel}</SceneMono>
              <span
                className="flex items-center gap-1.5"
                style={{
                  height: '25px', padding: '0 10px', borderRadius: '7px',
                  background: steel.soft, border: `1px solid ${steel.border}`,
                  color: steel.bright, fontSize: '12px',
                }}
              >
                <SceneIcon d="M12 2l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5" size={12} />
                {s.poolName}
              </span>
              <SceneMono size={13} className="ml-auto" color={SCENE.inkGhost}>
                {s.members.length}
              </SceneMono>
            </div>

            {/* 表头 */}
            <div
              className="hidden sm:grid shrink-0"
              style={{
                gridTemplateColumns: '1.4fr 1fr 0.9fr 0.8fr',
                gap: '10px',
                padding: '9px 16px',
                borderBottom: `1px solid ${SCENE.hair}`,
              }}
            >
              {[s.columns.model, s.columns.upstream, s.columns.health, s.columns.latency].map((c, i) => (
                <SceneMono key={c} size={13} style={{ textAlign: i >= 2 ? 'right' : 'left' }}>{c}</SceneMono>
              ))}
            </div>

            <div className="flex flex-col">
              {s.members.map((m, i) => {
                const health = healthAt(m.health, beat);
                const tone = HEALTH_TONE[health];
                const down = health === 'down';
                return (
                  <div
                    key={m.model}
                    className="grid items-center"
                    style={{
                      gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr) minmax(0,0.9fr) minmax(0,0.8fr)',
                      gap: '10px',
                      padding: '11px 16px',
                      borderBottom: i < s.members.length - 1 ? `1px solid ${SCENE.hair}` : undefined,
                      background: down ? clay.faint : 'transparent',
                      // 被隔离的那行整体压暗，但不删——"它还在池里，只是不接活了"
                      opacity: down ? 0.62 : 1,
                      transition: 'background .45s ease, opacity .45s ease',
                      ...enterAt(beat, B.listed, { rise: 6, delay: i * 70 }),
                    }}
                  >
                    <span className="min-w-0 truncate" style={{ fontSize: '12.5px', color: SCENE.ink }}>{m.model}</span>
                    <span className="min-w-0 truncate" style={{ fontSize: '11.5px', color: SCENE.inkDim }}>{m.upstream}</span>
                    <span className="flex items-center justify-end gap-1.5">
                      <span
                        className="flex items-center gap-1"
                        style={{
                          height: '19px', padding: '0 7px', borderRadius: '5px', fontSize: '10.5px',
                          background: tone.soft, color: tone.bright,
                          transition: 'background .45s ease, color .45s ease',
                        }}
                      >
                        <SceneIcon d={HEALTH_ICON[health]} size={10} strokeWidth={2.4} />
                        {s.healthLabels[health]}
                      </span>
                    </span>
                    {/*
                      * 延迟跟着健康走：隔离之后它不接活了，自然量不到首字延迟。
                      * 上一版把 '—' 写死进 i18n，于是前两拍 Kimi 显示「正常 / —」——
                      * 一个自相矛盾的行，正是判据与被判据对象时序对不上的样子。
                      */}
                    <SceneMono size={13} color={SCENE.inkMid} style={{ textAlign: 'right' }}>
                      {down ? '—' : m.latency}
                    </SceneMono>
                  </div>
                );
              })}
            </div>

            {/* 兜底说明：隔离之后流量去哪了，指到具体的人 */}
            <div
              className="flex items-center gap-2 mt-auto overflow-hidden"
              style={{
                padding: beat >= B.isolated ? '11px 16px' : '0 16px',
                height: beat >= B.isolated ? undefined : 0,
                opacity: beat >= B.isolated ? 1 : 0,
                // 折叠时一并 visibility:hidden——否则这句话在别的拍子里仍留在无障碍树和
                // innerText 里，读屏软件会念一条画面上根本不存在的「已隔离」
                visibility: beat >= B.isolated ? undefined : 'hidden',
                borderTop: `1px solid ${beat >= B.isolated ? SCENE.hair : 'transparent'}`,
                fontSize: '11.5px',
                color: pine.bright,
                transition: 'opacity .45s ease, height .45s ease, padding .45s ease',
              }}
            >
              <SceneIcon d="M4 12h10m0 0l-3-3m3 3l-3 3M18 5v14" size={13} strokeWidth={1.9} />
              {fallbackTo ? s.fallback.replace('Claude 4.6', fallbackTo) : s.fallback}
            </div>
          </div>
        </div>

        <BeatNarration beats={s.beats} beat={beat} hue={SCENE_HUE.steel} />
      </div>
    </SceneFrame>
  );
}
