import type { CSSProperties } from 'react';
import { useBreakpoint, useIsMobile } from '@/hooks/useBreakpoint';
import { BeatNarration, SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { enterAt, useSceneTimeline, useTypewriter } from './useSceneTimeline';
import { useLanguage } from '../contexts/LanguageContext';
import { useLandingAsset } from '../hooks/useLandingAssets';
import { SceneCursor, type CursorSpot } from '../components/SceneCursor';

/**
 * VisualCanvasStage —— 第一屏的视觉创作工作台（照 `pages/ai-chat/AdvancedVisualAgentTab.tsx` 复刻）。
 *
 * 真实结构：画布铺满整块；左边竖向浮动工具条；右边 420px 浮动对话面板贴右贴顶撑满；
 * 顶部居中只有一个缩放胶囊——没有全宽顶栏。
 *
 * 这一版最要紧的改动：**它开始时是空的，演给你看**。
 * 滚到这里才起拍：打字 → 发送 → 思考 → 回话 → 渲染 → 落回画布 → 再出一张 →
 * 选中 → 选第二张做混合计算 → 混合结果落地。
 * 之前是「已经做完的样子」，看不出这些图是怎么来的，也就看不出这个产品在干什么。
 *
 * 顺带一个性能收益：扫光只在「渲染中」那一拍存在，不再是常驻的无限循环。
 */

const clay = inkTone(SCENE_HUE.clay);
const steel = inkTone(SCENE_HUE.steel);
const pine = inkTone(SCENE_HUE.pine);
const amber = inkTone(SCENE_HUE.amber);
const olive = inkTone(SCENE_HUE.olive);

/** 节拍表。索引即拍号，值是这一拍停多久（ms）。 */
const HOLDS = [
  1000, // 0 空画布
  1700, // 1 打字
  1000, // 2 发送（要装得下「指针走到发送键 → 再按下」这两步，别把波纹截断）
  1100, // 3 思考
  1500, // 4 回话
  2300, // 5 渲染中
  1500, // 6 落回画布
  1700, // 7 再出一张
  1500, // 8 选中
  2100, // 9 混合计算中
  1800, // 10 混合结果落地
];
const B = {
  idle: 0, typing: 1, sent: 2, thinking: 3, replying: 4,
  rendering: 5, landed: 6, warm: 7, selected: 8, mixing: 9, mixed: 10,
} as const;

/** 左侧竖向工具条：选择 / 上传图片 / 形状 / 文字 / 图像生成器 / 手绘板 / 删除 */
const TOOL_PATHS = [
  'M3 3l7.5 18 2.5-7.5L20.5 11z',
  'M21 15l-5-5L5 21M3 5h18v14H3z',
  'M4 4h7v7H4zM17 20a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  'M5 6V4h14v2M12 4v16M9 20h6',
  'M12 3l2.2 5.1L20 9.3l-4 3.8 1 5.6-5-2.8-5 2.8 1-5.6-4-3.8 5.8-1.2z',
  'M18.4 2.6a2 2 0 0 1 3 3L9 18l-4 1 1-4zM14 6l4 4',
  'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
];

const ACTION_PATHS = [
  'M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3',
  'M20 20H9L4 15a2 2 0 0 1 0-3l8-8a2 2 0 0 1 3 0l5 5a2 2 0 0 1 0 3L11 20M6 13h11',
  'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',
  'M18.4 2.6a2 2 0 0 1 3 3L9 18l-4 1 1-4zM14 6l4 4',
  'M12 2l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  'M12 3v12m0 0l4-4m-4 4l-4-4M4 19h16',
];
const MIX_PATH = 'M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3M15 9a6 6 0 1 0 0 12 6 6 0 0 0 0-12';

interface TileSpec {
  id: 'a' | 'c' | 'b' | 'mix';
  /** 真实产物图的槽位；管理员没生成时回落到手绘底图 */
  slot: string;
  hue: number;
  at: number;          // 第几拍出现
  fog: boolean;
  wide: CSSProperties; // 宽屏位置
  narrow: CSSProperties;
}

/**
 * 画布上的图。位置是相对「画布可用区」的百分比，随宽度自适应。
 * 手机上不是把桌面这套等比缩小——那样下半屏是空的、动作条又和缩放胶囊打架，另排一套。
 */
const TILES: TileSpec[] = [
  { id: 'a', slot: 'landing.visual.draft', hue: SCENE_HUE.steel, at: B.idle, fog: false,
    wide: { left: '7%', top: '11%', width: '33%' }, narrow: { left: '5%', top: '9%', width: '43%' } },
  { id: 'c', slot: 'landing.visual.fog', hue: SCENE_HUE.pine, at: B.landed, fog: true,
    wide: { left: '13%', top: '52%', width: '28%' }, narrow: { left: '8%', top: '48%', width: '40%' } },
  { id: 'b', slot: 'landing.visual.warm', hue: SCENE_HUE.clay, at: B.warm, fog: false,
    wide: { left: '45%', top: '18%', width: '25%' }, narrow: { left: '54%', top: '20%', width: '38%' } },
  { id: 'mix', slot: 'landing.visual.mixed', hue: SCENE_HUE.olive, at: B.mixed, fog: false,
    wide: { left: '46%', top: '54%', width: '27%' }, narrow: { left: '54%', top: '52%', width: '38%' } },
];

export function VisualCanvasStage() {
  const { t } = useLanguage();
  const s = t.scenes.visual;
  const isMobile = useIsMobile();
  // 指针只在 lg 以上画：对话面板在 lg 以下会挪到面板外面，
  // 「发送键」就不在指针能量到的坐标系里了
  const { isDesktop } = useBreakpoint();
  const { beat, ref } = useSceneTimeline(HOLDS);
  const typed = useTypewriter(s.chat.user, beat === B.typing, 1500);

  /** 这一拍谁被选中：先选雾天，混合时雾天 + 暖调两张都亮 */
  const isPicked = (id: TileSpec['id']) =>
    (beat >= B.selected && id === 'c') || (beat >= B.mixing && beat < B.mixed && id === 'b');

  const barAnchor = TILES[1]; // 动作条永远挂在「雾天版本」那张上
  const showBar = beat >= B.selected;

  return (
    <div className="w-full" ref={ref}>
      <div
        className="relative w-full overflow-hidden rounded-2xl"
        style={{
          height: isMobile ? '392px' : 'clamp(460px, 64vh, 700px)',
          border: `1px solid ${SCENE.edge}`,
          background: SCENE.canvas,
          backgroundImage: SCENE.canvasDots,
          backgroundSize: '48px 48px',
          boxShadow: SCENE.liftLg,
        }}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: `radial-gradient(360px 190px at 5% 0%, ${clay.faint} 0%, transparent 100%)` }}
        />

        {/* 演示指针：窄屏不画 —— 小屏本来就没有鼠标，画一枚箭头反而突兀 */}
        {isDesktop && <SceneCursor spot={CURSOR_AT[beat] ?? null} beat={beat} />}

        {/* ── 画布可用区：宽屏时给右侧对话面板让出 444px ── */}
        <div className="absolute inset-0 lg:right-[444px]">
          {TILES.map((tile) => {
            const on = beat >= tile.at;
            const picked = isPicked(tile.id);
            const tone = inkTone(tile.hue);
            return (
              <div
                key={tile.id}
                data-cursor-target={`tile-${tile.id}`}
                className="absolute overflow-hidden rounded-[10px]"
                style={{
                  ...(isMobile ? tile.narrow : tile.wide),
                  aspectRatio: '3 / 2',
                  border: `1px solid ${picked ? tone.solid : SCENE.line}`,
                  boxShadow: picked ? `0 0 0 1px ${tone.solid}, 0 0 26px ${tone.faint}` : 'none',
                  opacity: on ? 1 : 0,
                  // 图是「落」下来的，不是「淡」出来的：产物落位要有重量
                  animation: on ? 'mapSceneLand .62s cubic-bezier(.19,1,.22,1) both' : undefined,
                  transition: 'border-color .4s ease, box-shadow .4s ease',
                }}
              >
                <CanvasArt id={tile.id} slot={tile.slot} hue={tile.hue} fog={tile.fog} />
                <span
                  className="absolute inset-x-0 bottom-0 text-left"
                  style={{
                    padding: '16px 9px 6px',
                    fontSize: '10.5px',
                    color: SCENE.captionFg,
                    background: SCENE.captionScrim,
                  }}
                >
                  {s.tiles[tile.id]}
                </span>
              </div>
            );
          })}

          {/* 渲染中的占位卡：只在那一拍存在。产物就在它自己的位置上长出来，
              下一拍原地换成成品——而不是「转圈转完，图从别处飞进来」 */}
          {beat === B.rendering && (
            <GenTile
              style={isMobile ? TILES[1].narrow : TILES[1].wide}
              label={s.genRunning.label}
              status={s.genRunning.status}
              percent={70}
              tone={steel}
            />
          )}
          {beat === B.mixing && (
            <GenTile
              style={isMobile ? TILES[3].narrow : TILES[3].wide}
              label={s.mixAction}
              status={s.genOvertime.status}
              percent={95}
              tone={amber}
              statusColor={amber.bright}
            />
          )}

          {/* 图像生成器：画布上的一个元素，不是一个弹窗 */}
          <div
            className="absolute hidden xl:flex flex-col justify-center gap-2 rounded-[10px]"
            style={{
              left: '75%', top: '13%', width: '23%',
              padding: '15px',
              border: `1px dashed ${SCENE.edgeStrong}`,
              background: SCENE.faintFill,
              ...enterAt(beat, B.idle),
            }}
          >
            <SceneMono className="flex items-center gap-2" style={{ letterSpacing: '0.18em', textTransform: 'uppercase' }}>
              <span className="block w-[5px] h-[5px] rounded-full" style={{ background: clay.solid }} />
              {s.generator.title}
            </SceneMono>
            <span style={{ fontSize: '12px', color: SCENE.inkMid, lineHeight: 1.7 }}>{s.generator.body}</span>
          </div>

          {/* 动作条：ImageQuickActionBar。挂在与选中图同尺寸的隐形框上，
              于是「贴着这张图的下沿」可以用 100% 表达，不必知道像素高度。
              放下方是因为这张图靠上，放上方会撞到顶部居中的缩放胶囊。 */}
          <div
            className="absolute pointer-events-none"
            style={
              isMobile
                ? { left: '8px', right: '8px', bottom: '10px' }
                : { ...barAnchor.wide, aspectRatio: '3 / 2' }
            }
          >
            <div
              className="absolute flex items-center z-[4] pointer-events-auto"
              style={{
                ...(isMobile ? { left: 0, right: 0, bottom: 0 } : { left: 0, bottom: 'calc(100% + 8px)' }),
                maxWidth: isMobile ? '100%' : '270%',
                overflowX: 'auto',
                gap: '2px',
                padding: '4px',
                background: SCENE.overlay,
                border: `1px solid ${SCENE.edgeStrong}`,
                borderRadius: '10px',
                boxShadow: SCENE.liftBar,
                opacity: showBar ? 1 : 0,
                transform: showBar ? 'translateY(0)' : 'translateY(6px)',
                transition: 'opacity .38s cubic-bezier(.19,1,.22,1), transform .38s cubic-bezier(.19,1,.22,1)',
                pointerEvents: showBar ? 'auto' : 'none',
              }}
            >
              {s.actions.map((name, i) => (
                <span key={name} className="flex items-center" style={{ gap: '2px' }}>
                  {(i === 3 || i === 5) && (
                    <span className="block shrink-0" style={{ width: '1px', height: '17px', background: SCENE.hair, margin: '0 3px' }} />
                  )}
                  <span
                    className="flex items-center gap-1.5 whitespace-nowrap"
                    style={{ fontSize: '12px', padding: '6px 10px', borderRadius: '7px', color: SCENE.inkSoft }}
                  >
                    <SceneIcon d={ACTION_PATHS[i]} size={12} strokeWidth={1.9} style={{ opacity: 0.75 }} />
                    {name}
                  </span>
                </span>
              ))}
              {/* 选中两张才出现的第七个动作 —— 混合计算 */}
              <span
                className="flex items-center whitespace-nowrap"
                style={{
                  gap: '6px',
                  fontSize: '12px',
                  padding: '6px 10px',
                  borderRadius: '7px',
                  marginLeft: '3px',
                  background: beat >= B.mixing ? olive.soft : 'transparent',
                  border: `1px solid ${beat >= B.mixing ? olive.border : 'transparent'}`,
                  color: beat >= B.mixing ? olive.bright : SCENE.inkGhost,
                  maxWidth: beat >= B.mixing ? '160px' : '0px',
                  overflow: 'hidden',
                  transition: 'max-width .45s cubic-bezier(.19,1,.22,1), background .3s ease, color .3s ease',
                }}
              >
                <SceneIcon d={MIX_PATH} size={12} strokeWidth={1.9} />
                {s.mixAction}
              </span>
            </div>
          </div>

          {/* 顶部居中：缩放胶囊（真实位置，不是全宽顶栏） */}
          <div
            className="absolute z-[5] flex items-center whitespace-nowrap"
            style={{
              top: '14px', left: '50%', transform: 'translateX(-50%)',
              height: '36px', gap: '4px', padding: '0 6px',
              borderRadius: '999px',
              background: SCENE.pill,
              border: `1px solid ${SCENE.edge}`,
              boxShadow: SCENE.liftSm,
            }}
          >
            <PillButton d="M5 12h14" />
            <SceneMono size={15} color={SCENE.inkMid} style={{ minWidth: '46px', textAlign: 'center' }}>100%</SceneMono>
            <PillButton d="M12 5v14M5 12h14" />
            <span className="block" style={{ width: '1px', height: '16px', background: SCENE.line, margin: '0 2px' }} />
            <PillButton d="M3 9V5a2 2 0 0 1 2-2h4M21 9V5a2 2 0 0 0-2-2h-4M3 15v4a2 2 0 0 0 2 2h4M21 15v4a2 2 0 0 1-2 2h-4" />
          </div>

          {/* 手势说明 —— 画布手势全站统一（gesture-unification） */}
          <div
            className="absolute z-[5] hidden md:block"
            style={{ left: '84px', bottom: '12px', fontSize: '11.5px', color: SCENE.inkFaint }}
          >
            {s.gesture.before}
            <SceneMono size={13} color={SCENE.inkMid} style={{ border: `1px solid ${SCENE.line}`, borderRadius: '4px', padding: '0 5px', margin: '0 3px' }}>
              Ctrl
            </SceneMono>
            {s.gesture.after}
          </div>
        </div>

        {/* ── 左侧：竖向浮动工具条 ── */}
        <div
          className="absolute z-[5] hidden sm:flex flex-col"
          style={{
            left: '12px', top: '50%', transform: 'translateY(-50%)',
            gap: '6px', padding: '6px', borderRadius: '999px',
            background: SCENE.pill, border: `1px solid ${SCENE.edge}`, boxShadow: SCENE.liftMd,
          }}
        >
          {TOOL_PATHS.map((d, i) => (
            <span
              key={d}
              className="flex items-center justify-center"
              style={{
                width: '44px', height: '44px', borderRadius: '14px',
                background: i === 0 ? clay.soft : 'transparent',
                color: i === 0 ? clay.solid : SCENE.inkMid,
              }}
            >
              <SceneIcon d={d} size={18} />
            </span>
          ))}
        </div>

        {/* ── 右侧：浮动对话面板（420px） ── */}
        <div
          className="absolute z-[6] hidden lg:flex flex-col rounded-[14px]"
          style={{
            right: '12px', top: '12px', bottom: '12px', width: '420px', padding: '12px',
            background: SCENE.panel, border: `1px solid ${SCENE.edge}`, boxShadow: SCENE.liftLg,
          }}
        >
          <ChatPanel beat={beat} typed={typed} />
        </div>
      </div>

      {/* 窄屏：对话面板落到画布下方，保持「画布 + 设计师」两件东西都在 */}
      <div
        className="lg:hidden mt-3 flex flex-col rounded-[14px]"
        style={{ padding: '12px', background: SCENE.panel, border: `1px solid ${SCENE.edge}`, boxShadow: SCENE.liftMd }}
      >
        <ChatPanel beat={beat} typed={typed} compact />
      </div>

      {/* 旁白：此刻在发生什么 */}
      <div
        className="mt-3 rounded-[14px]"
        style={{ background: SCENE.panel, border: `1px solid ${SCENE.edge}` }}
      >
        <BeatNarration beats={s.beats} beat={beat} hue={SCENE_HUE.clay} />
      </div>
    </div>
  );
}

/** 右侧对话面板。窄屏下省掉思考行与流式追问，其余一致。 */
function ChatPanel({ beat, typed, compact = false }: { beat: number; typed: string; compact?: boolean }) {
  const { t } = useLanguage();
  const s = t.scenes.visual;
  const composing = beat === B.typing;

  return (
    <>
      <div className="flex items-start gap-2 shrink-0">
        <div className="min-w-0 flex-1">
          <div style={{ fontSize: '13px', fontWeight: 500, color: SCENE.ink }}>{s.chat.title}</div>
          <div style={{ marginTop: '3px', fontSize: '10.5px', lineHeight: 1.5, color: SCENE.inkDim }}>{s.chat.subtitle}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <IconSlot d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6" />
          <span
            className="flex items-center gap-1"
            style={{
              height: '24px', padding: '0 8px', borderRadius: '6px',
              background: clay.soft, border: `1px solid ${clay.border}`, color: clay.bright,
              fontSize: '11px', whiteSpace: 'nowrap',
            }}
          >
            <SceneIcon d="M22 2L11 13M22 2l-7 20-4-9-9-4z" size={11} strokeWidth={2} />
            {s.chat.submit}
          </span>
        </div>
      </div>

      <div className="shrink-0" style={{ height: '1px', background: SCENE.hair, margin: '11px 0' }} />

      {/* 对话流：新消息贴底，跟真实聊天一致 */}
      <div className="flex-1 min-h-0 flex flex-col justify-end gap-3 overflow-hidden">
        <Bubble side="user" style={enterAt(beat, B.sent)}>{s.chat.user}</Bubble>

        {!compact && beat >= B.thinking && (
          <div style={{ maxWidth: '88%', ...enterAt(beat, B.thinking) }}>
            <SceneMono size={13} color={SCENE.inkGhost} style={{ letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              {beat === B.thinking ? `${s.chat.thinking} ·` : s.chat.thinking}
            </SceneMono>
            {beat >= B.replying && (
              <Bubble side="agent" style={{ marginTop: '5px' }}>{s.chat.reply}</Bubble>
            )}
          </div>
        )}

        {/* 产物条：落在哪、有没有压住别的图，都说清楚 */}
        {beat >= B.landed && (
          <div
            className="flex items-center gap-2"
            style={{
              padding: '8px 10px', borderRadius: '10px',
              background: SCENE.ghost, border: `1px solid ${SCENE.hair}`,
              ...enterAt(beat, B.landed),
            }}
          >
            {/*
              这句话是「雾天版本已落在画布」，那么这枚缩略片就该是那张雾天图本身。
              以前是块绿渐变——话说着已经出图了，旁边配一块色卡，等于自己拆自己的台。
              没配图时仍回落到渐变，不开天窗。
            */}
            <LandedThumb />
            <span style={{ fontSize: '11.5px', color: SCENE.inkMid, lineHeight: 1.5 }}>{s.chat.landed}</span>
          </div>
        )}

        {!compact && beat >= B.warm && beat < B.mixing && (
          <Bubble side="agent" style={enterAt(beat, B.warm)}>
            {s.chat.streaming}
            <span
              className="inline-block map-scene-anim"
              style={{
                width: '2px', height: '13px', background: clay.solid,
                marginLeft: '3px', verticalAlign: '-2px',
                animation: 'mapSceneCaret 1s steps(1) infinite',
              }}
            />
          </Bubble>
        )}

        {beat >= B.mixing && (
          <Bubble side="user" style={enterAt(beat, B.mixing)}>{s.chat.user2}</Bubble>
        )}
      </div>

      {/* 模型可见性（ai-model-visibility：当前模型与模型池必须露出） */}
      <SceneMono className="flex items-center gap-2 shrink-0" style={{ margin: '10px 0 8px' }}>
        <span className="block w-[5px] h-[5px] rounded-full" style={{ background: pine.solid }} />
        {s.chat.model}
        <span className="block" style={{ width: '1px', height: '12px', background: SCENE.line }} />
        {s.chat.pool}
      </SceneMono>

      {/* 输入区：正在输入那一拍逐字吐字，发送后清空 */}
      <div
        className="shrink-0"
        style={{
          borderRadius: '12px',
          background: SCENE.tileHi,
          border: `1px solid ${composing ? clay.border : SCENE.line}`,
          padding: '10px 11px',
          transition: 'border-color .35s ease',
        }}
      >
        <div data-cursor-target="chat-input" style={{ fontSize: '12.5px', color: composing ? SCENE.ink : SCENE.inkFaint, lineHeight: 1.6, minHeight: '20px' }}>
          {composing ? (
            <>
              {typed}
              <span
                className="inline-block map-scene-anim"
                style={{ width: '2px', height: '13px', background: clay.solid, marginLeft: '2px', verticalAlign: '-2px', animation: 'mapSceneCaret 1s steps(1) infinite' }}
              />
            </>
          ) : (
            s.chat.placeholder
          )}
        </div>
        <div className="flex items-center gap-1.5" style={{ marginTop: '10px' }}>
          <IconSlot d="M21 15l-5-5L5 21M3 5h18v14H3z" boxed />
          <IconSlot d="M12 3v18M3 12h18" boxed />
          <span
            data-cursor-target="chat-send"
            className="flex items-center gap-1.5 ml-auto"
            style={{
              height: '28px', padding: '0 14px', borderRadius: '8px',
              background: SCENE.brand, color: SCENE.brandFg, fontSize: '12.5px',
              // 发送那一拍按钮自己有反应，不是文字凭空跳走
              transform: beat === B.sent ? 'scale(0.94)' : 'scale(1)',
              boxShadow: beat === B.sent ? `0 0 0 4px ${clay.soft}` : 'none',
              transition: 'transform .28s cubic-bezier(.19,1,.22,1), box-shadow .28s ease',
            }}
          >
            {s.chat.send}
            <SceneIcon d="M5 12h14M13 6l6 6-6 6" size={12} strokeWidth={2} />
          </span>
        </div>
      </div>
    </>
  );
}

function Bubble({ side, children, style }: { side: 'user' | 'agent'; children: React.ReactNode; style?: CSSProperties }) {
  const user = side === 'user';
  return (
    <div
      className={user ? 'self-end' : undefined}
      style={{
        maxWidth: user ? '82%' : '88%',
        padding: '9px 12px',
        borderRadius: user ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
        background: user ? clay.soft : SCENE.tile,
        border: `1px solid ${user ? clay.border : SCENE.edge}`,
        fontSize: '12.5px',
        lineHeight: user ? 1.75 : 1.8,
        color: user ? SCENE.ink : SCENE.inkSoft,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function IconSlot({ d, boxed = false }: { d: string; boxed?: boolean }) {
  return (
    <span
      className="flex items-center justify-center shrink-0"
      style={{
        width: boxed ? '26px' : '24px',
        height: boxed ? '26px' : '24px',
        borderRadius: boxed ? '7px' : '6px',
        color: SCENE.inkDim,
        border: boxed ? `1px solid ${SCENE.edge}` : undefined,
      }}
    >
      <SceneIcon d={d} size={boxed ? 13 : 14} />
    </span>
  );
}

function PillButton({ d }: { d: string }) {
  return (
    <span className="flex items-center justify-center" style={{ width: '28px', height: '28px', borderRadius: '999px', color: SCENE.inkMid }}>
      <SceneIcon d={d} size={14} strokeWidth={2} />
    </span>
  );
}

/**
 * 生成中的占位卡。等待期屏幕上是**产物的形状**在长，不是一个居中 spinner
 * （artifact-is-experience）；给「已耗时 / 预计」而不是一个会卡死的百分比
 * （expectation-management）。只在对应那一拍挂载，不做常驻循环。
 */
function GenTile({
  style, label, status, percent, tone, statusColor,
}: {
  style: CSSProperties;
  label: string;
  status: string;
  percent: number;
  tone: ReturnType<typeof inkTone>;
  statusColor?: string;
}) {
  return (
    <div
      className="absolute overflow-hidden rounded-[10px]"
      style={{
        ...style,
        aspectRatio: '3 / 2',
        border: `1px solid ${SCENE.line}`,
        background: SCENE.base,
        animation: 'mapSceneLand .5s cubic-bezier(.19,1,.22,1) both',
      }}
    >
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(180deg, ${tone.faint} 0%, transparent 45%, ${tone.faint} 100%), ${SCENE.hatch}` }}
      />
      <div
        className="absolute map-scene-anim"
        style={{
          top: '-10%', bottom: '-10%', left: 0, width: '92%',
          background: `linear-gradient(108deg, transparent 0%, ${SCENE.sweepEdge} 22%, ${tone.soft} 50%, ${SCENE.sweepEdge} 78%, transparent 100%)`,
          animation: 'mapSceneSweep 2.8s linear infinite',
        }}
      />
      <div className="absolute flex items-baseline gap-2 overflow-hidden" style={{ left: '9px', right: '9px', bottom: '14px' }}>
        <SceneMono style={{ letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>{label}</SceneMono>
        <SceneMono className="ml-auto min-w-0 truncate" color={statusColor ?? SCENE.inkFaint} style={{ letterSpacing: '0.08em' }}>
          {status}
        </SceneMono>
      </div>
      <div
        className="absolute overflow-hidden"
        style={{ left: '9px', right: '9px', bottom: '8px', height: '2px', borderRadius: '2px', background: SCENE.line }}
      >
        <span className="block h-full" style={{ width: `${percent}%`, background: `linear-gradient(90deg, ${tone.border}, ${tone.solid})` }} />
      </div>
    </div>
  );
}

/**
 * 画布上那几张「图」。不是占位灰块——画一张有山脊线、有光源、有前后景的图，
 * 才看得出「把主视觉改成雾天、山脊线保留」这句话到底改了什么。
 */

/**
 * 指针走位表：这一幕里「那只手」按拍号走到哪、什么时候按下。
 *
 * 顺序刻意是「先走到、再发生」：`sent` 那一拍指针压在发送键上，图才在下一拍开始渲染；
 * `selected` 那一拍指针压在雾天那张上，选中框才亮起来。反过来（东西先变、指针后到）
 * 比没有指针更假。
 *
 * 每一拍只说**指向谁**，落点由 SceneCursor 当场量目标元素。画布上的图活在
 * `lg:right-[444px]` 的子容器里，而指针挂在面板根上——手写百分比必然差一整个
 * 对话面板的宽度，这也正是第一版指针全程落在空处的原因。
 */
const CURSOR_AT: Record<number, CursorSpot> = {
  [B.idle]: { target: 'chat-input', hidden: true },
  [B.typing]: { target: 'chat-input', ax: 0.42 },   // 停在正在吐字的那行上
  [B.sent]: { target: 'chat-send', press: true },   // 按下发送
  [B.thinking]: { target: 'chat-send' },
  [B.replying]: { target: 'tile-c', ay: 0.25 },     // 手往画布挪，等图长出来
  [B.rendering]: { target: 'tile-c' },              // 就在它自己的位置上长出来
  [B.landed]: { target: 'tile-c' },
  // 提前一拍就停在待会儿要点的那张上：等 selected 那拍按下时是「原地按」，
  // 不是「一边飞过去一边已经选中了」
  [B.warm]: { target: 'tile-c' },
  [B.selected]: { target: 'tile-c', press: true },  // 按下雾天那张 → 选中框亮
  [B.mixing]: { target: 'tile-b', press: true },    // 再按暖调那张 → 两张都选中，混合计算亮起
  [B.mixed]: { target: 'tile-mix' },                // 看着结果落地
};

/** 对话里「已落在画布」那枚缩略片：直接引用雾天那张真图。 */
function LandedThumb() {
  const photo = useLandingAsset('landing.visual.fog');
  return (
    <span
      className="shrink-0 overflow-hidden block"
      style={{
        width: '40px', height: '28px', borderRadius: '5px',
        background: photo
          ? undefined
          : `linear-gradient(160deg, hsl(${SCENE_HUE.pine} 26% 20%), hsl(${SCENE_HUE.pine} 20% 10%))`,
      }}
    >
      {photo && (
        <img src={photo} alt="" loading="lazy" decoding="async" className="block w-full h-full" style={{ objectFit: 'cover' }} />
      )}
    </span>
  );
}

/**
 * 画布上那张图。
 *
 * 管理员在「系统设置 → 首页预览图」生成过真照片就显示照片，没生成才回落到下面这张
 * 手绘山脊。回落不是可有可无的兜底：这一幕是首屏，配图没配好也不能开天窗。
 *
 * 演生图的产品在自己的界面里摆手绘假图，是这一版之前的样子 —— 用户一眼就看穿了。
 */
function CanvasArt({ id, slot, hue, fog }: { id: string; slot: string; hue: number; fog: boolean }) {
  const gid = `mapCanvasArt-${id}`;
  const photo = useLandingAsset(slot);
  if (photo) {
    return (
      <img
        src={photo}
        alt=""
        loading="lazy"
        decoding="async"
        className="block w-full h-full"
        style={{ objectFit: 'cover' }}
      />
    );
  }
  return (
    <svg viewBox="0 0 300 200" preserveAspectRatio="none" className="block w-full h-full" aria-hidden="true">
      <defs>
        <linearGradient id={`${gid}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`hsl(${hue} 32% 17%)`} />
          <stop offset="1" stopColor={`hsl(${hue} 24% 8%)`} />
        </linearGradient>
        <radialGradient id={`${gid}-sun`} cx="0.66" cy="0.3" r="0.55">
          <stop offset="0" stopColor={`hsla(${hue}, 54%, 72%, 0.48)`} />
          <stop offset="1" stopColor={`hsla(${hue}, 54%, 72%, 0)`} />
        </radialGradient>
        <linearGradient id={`${gid}-fog`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`hsla(${hue}, 14%, 74%, 0)`} />
          <stop offset="1" stopColor={`hsla(${hue}, 14%, 74%, 0.32)`} />
        </linearGradient>
      </defs>
      <rect width="300" height="200" fill={`url(#${gid}-sky)`} />
      <rect width="300" height="200" fill={`url(#${gid}-sun)`} />
      <path d="M0 118 L58 88 L104 116 L152 78 L206 112 L262 92 L300 118 L300 200 L0 200 Z" fill={`hsl(${hue} 27% 13%)`} />
      {fog ? (
        <rect y="72" width="300" height="128" fill={`url(#${gid}-fog)`} />
      ) : (
        <path d="M0 146 L64 128 L128 150 L196 130 L262 152 L300 138 L300 200 L0 200 Z" fill={`hsl(${hue} 22% 10%)`} />
      )}
    </svg>
  );
}
