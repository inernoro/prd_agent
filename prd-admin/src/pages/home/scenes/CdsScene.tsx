import { BeatNarration, SceneFrame, SceneIcon, SceneMono } from './SceneFrame';
import type { SceneVariant } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { useSceneTimeline } from './useSceneTimeline';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { SceneCursor, type CursorSpot } from '../components/SceneCursor';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * CdsScene —— 一天。
 *
 * 上一版这一幕是 CDS 的分支页 + 十三行真实部署日志 + 四张「独占什么」的卡。
 * 每一样都真，合起来太满——用户原话「太复杂了，可以抽象一点」。日志是证据，
 * 证据留在部署页；首页要讲的是故事。
 *
 * 于是只剩一条时间轴：早上你说一句话，中午它改完，下午地址就位，你打开点通过。
 * 五个时刻里两头是人、中间三个是机器——**这个形状本身就是结论**，不用再解释
 * 一遍「自动化」。「分支即环境」压进一句描述：每句话长成一条分支，一条分支就是
 * 一整套环境，说完就有，丢掉就没。
 *
 * 沿用一条纪律：预览地址只给形状不给域名。每个人的 CDS 域名不一样，编一个具体
 * 的既是假的，也正好违反它自己那句「地址由 CDS 下发，不由前端拼」。
 */

const HOLDS = [2000, 1700, 1700, 1900, 2800];
/**
 * 五拍对着 i18n 里的五个 moment：说一句话 → 它开分支 → 推上去 → 地址就位 → 点通过。
 * 别的幕都有这张表，这一幕原本只用 `beat >= last` 就地算 —— 结果是「哪一拍在干什么」
 * 只存在于阅读者脑子里，机器读不到，衔接守卫也就扫不到这一幕的点击。
 */
const B = { ask: 0, branch: 1, push: 2, ready: 3, approve: 4 } as const;

/** 要等手真的落到「通过」上才开始的拍（理由见 useSceneTimeline 的 gates 说明）。 */
const GATED = new Set<number>([B.approve]);

const pine = inkTone(SCENE_HUE.pine);
const clay = inkTone(SCENE_HUE.clay);

/** 人做的事画成实心陶土，机器做的事画成空心松绿。轨道上一眼看得出谁在动。 */
function actorTone(actor: 'you' | 'it') {
  return actor === 'you' ? clay : pine;
}

export function CdsScene({ variant }: { variant?: SceneVariant }) {
  const { t } = useLanguage();
  const s = t.tail.cds;
  // 必须在节拍器之前取：gates 要用它决定启不启用（不画指针就没人 release）
  const { isDesktop } = useBreakpoint();
  const { beat, ref, armed, release } = useSceneTimeline(HOLDS, { gates: isDesktop ? GATED : undefined });
  const last = s.moments.length - 1;

  /**
   * 指针走位表。这一幕的拍号跟着 moments 走，没有 B 常量表，所以直接按下标写：
   * 倒数第二拍（地址就位）手移过去，最后一拍按下「通过」。前面三拍是机器在干活，
   * 不该有手 —— 这一幕的卖点正是「你没动手」。
   */
  const cursorSpot: CursorSpot | null = ((at: number) =>
    at === B.ready ? { target: 'approve-button' }
      : at === B.approve ? { target: 'approve-button', press: true }
        : null)(armed ?? beat);

  /** 地址在倒数第二拍就位，最后一拍才轮到人点通过 */
  const previewReady = beat >= last - 1;
  const approved = beat >= last;

  return (
    <SceneFrame
      id="scene-cds"
      variant={variant}
      hue={SCENE_HUE.pine}
      eyebrow={s.eyebrow}
      title={s.title}
      description={s.description}
      note={s.note}
      panelStyle={{ background: SCENE.base }}
    >
      <div ref={ref} className="relative">
        {/* 演示指针：这一幕的命题就是「你这一天只动了两次手」，那两次手就更得看得见。
            地址就位那一拍手先移到「通过」上，最后一拍才按下去。窄屏不画。 */}
        {isDesktop && <SceneCursor spot={cursorSpot} beat={armed ?? beat} onArrive={release} />}
        <div
          className="flex items-center gap-2.5"
          style={{ padding: '12px 16px', borderBottom: `1px solid ${SCENE.hair}` }}
        >
          <SceneIcon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8v4l3 2" size={14} />
          <SceneMono style={{ letterSpacing: '0.16em', textTransform: 'uppercase' }}>{s.dayLabel}</SceneMono>
        </div>

        {/* 一天：五个时刻横着排。每个时刻只有一行字，多一行都是负担 */}
        <div style={{ padding: '22px 16px 6px' }}>
          <div className="relative flex flex-col md:flex-row gap-5 md:gap-3">
            {/* 轨道：横线只在宽屏出现，窄屏改成竖排就不需要它 */}
            <span
              className="hidden md:block absolute"
              style={{
                left: '5%', right: '5%', top: '9px', height: '1px',
                background: `linear-gradient(90deg, ${clay.border}, ${SCENE.line} 22%, ${SCENE.line} 78%, ${clay.border})`,
              }}
            />

            {s.moments.map((m, i) => {
              const tone = actorTone(m.actor);
              const lit = beat >= i;
              const isYou = m.actor === 'you';
              return (
                <div key={m.time} className="relative flex-1 min-w-0 flex flex-col items-start md:items-center gap-2">
                  {/* 节点：人是实心，机器是空心 */}
                  <span
                    className="relative block shrink-0"
                    style={{
                      width: '19px', height: '19px', borderRadius: '999px',
                      background: lit && isYou ? tone.solid : SCENE.base,
                      border: `2px solid ${lit ? tone.solid : SCENE.line}`,
                      boxShadow: lit && isYou ? `0 0 0 5px ${tone.faint}` : undefined,
                      transition: 'background .5s ease, border-color .5s ease, box-shadow .5s ease',
                    }}
                  />
                  <SceneMono size={13} color={lit ? SCENE.inkMid : SCENE.inkGhost} style={{ transition: 'color .5s ease' }}>
                    {m.time}
                  </SceneMono>
                  <span
                    style={{
                      height: '18px', padding: '0 8px', borderRadius: '999px', fontSize: '10.5px',
                      display: 'inline-flex', alignItems: 'center',
                      background: lit ? tone.soft : SCENE.tile,
                      color: lit ? tone.bright : SCENE.inkGhost,
                      transition: 'background .5s ease, color .5s ease',
                    }}
                  >
                    {s.actorLabels[m.actor]}
                  </span>
                  <span
                    className="md:text-center"
                    style={{
                      fontSize: '12.5px', lineHeight: 1.65, maxWidth: '19em',
                      color: lit ? SCENE.inkSoft : SCENE.inkGhost,
                      opacity: lit ? 1 : 0.55,
                      transition: 'color .5s ease, opacity .5s ease',
                    }}
                  >
                    {m.text}
                  </span>
                </div>
              );
            })}
          </div>

          {/* 中间那段人不在。这条横杠才是整幕真正要说的话 */}
          <div className="hidden md:flex items-center" style={{ margin: '16px 0 0', paddingLeft: '11%', paddingRight: '11%' }}>
            <span className="block flex-1" style={{ height: '1px', background: SCENE.line }} />
            <span
              className="shrink-0"
              style={{
                margin: '0 10px', padding: '0 11px', height: '23px', borderRadius: '999px',
                display: 'inline-flex', alignItems: 'center', fontSize: '11px',
                background: SCENE.tile, border: `1px solid ${SCENE.edge}`, color: SCENE.inkDim,
              }}
            >
              {s.awayLabel}
            </span>
            <span className="block flex-1" style={{ height: '1px', background: SCENE.line }} />
          </div>
        </div>

        {/* 下午的产物：一个能打开的地址 + 唯一那颗按钮 */}
        <div style={{ padding: '10px 16px 16px' }}>
          <div
            className="flex items-center gap-2.5 flex-wrap"
            style={{
              padding: '13px 14px', borderRadius: '12px',
              background: previewReady ? pine.faint : SCENE.tile,
              border: `1px solid ${previewReady ? pine.border : SCENE.edge}`,
              opacity: previewReady ? 1 : 0.42,
              transition: 'background .6s ease, border-color .6s ease, opacity .6s ease',
            }}
          >
            <SceneMono size={12} color={SCENE.inkGhost} className="shrink-0">{s.previewLabel}</SceneMono>
            <span className="min-w-0 flex items-center gap-2">
              <SceneIcon d="M9 15l6-6M11 6l1-1a4 4 0 1 1 6 6l-1 1M13 18l-1 1a4 4 0 1 1-6-6l1-1" size={12} />
              <SceneMono size={12} color={previewReady ? pine.bright : SCENE.inkGhost} className="truncate">
                {s.previewShape}
              </SceneMono>
            </span>

            <span className="ml-auto flex items-center gap-2 shrink-0">
              <span
                style={{
                  height: '28px', padding: '0 12px', borderRadius: '8px', fontSize: '12px',
                  display: 'inline-flex', alignItems: 'center',
                  background: SCENE.ghost, border: `1px solid ${SCENE.edge}`, color: SCENE.inkFaint,
                }}
              >
                {s.reject}
              </span>
              {/* 唯一那颗按钮：最后一拍才亮，亮的时候带一圈光晕 */}
              <span
                data-cursor-target="approve-button"
                className="flex items-center gap-1.5"
                style={{
                  height: '28px', padding: '0 14px', borderRadius: '8px', fontSize: '12px',
                  background: approved ? clay.solid : SCENE.tileHi,
                  color: approved ? SCENE.ink : SCENE.inkDim,
                  boxShadow: approved ? `0 0 0 5px ${clay.faint}` : undefined,
                  transition: 'background .5s ease, color .5s ease, box-shadow .5s ease',
                }}
              >
                {approved && <SceneIcon d="M20 6L9 17l-5-5" size={11} strokeWidth={2.6} />}
                {s.approve}
              </span>
            </span>
          </div>

          {/* 一天下来的账：三个数，说完就走 */}
          <div className="flex items-center gap-5 flex-wrap" style={{ marginTop: '13px' }}>
            {s.tally.map((item) => (
              <span key={item.label} className="flex items-baseline gap-2">
                <span
                  style={{
                    fontFamily: 'var(--font-display)', fontSize: '1.05rem', fontWeight: 500,
                    letterSpacing: '-0.01em', color: SCENE.ink,
                  }}
                >
                  {item.value}
                </span>
                <span style={{ fontSize: '11.5px', color: SCENE.inkDim }}>{item.label}</span>
              </span>
            ))}
            <span className="min-w-0" style={{ fontSize: '11.5px', lineHeight: 1.7, color: SCENE.inkFaint }}>
              {s.footer}
            </span>
          </div>
        </div>

        <BeatNarration beats={s.beats} beat={beat} hue={SCENE_HUE.pine} />
      </div>
    </SceneFrame>
  );
}
