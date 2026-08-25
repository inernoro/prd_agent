import { useState, type CSSProperties } from 'react';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { SceneIcon, SceneMono } from './SceneFrame';
import { SCENE, SCENE_HUE, inkTone } from './sceneTokens';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * VisualCanvasStage —— 第一屏的视觉创作工作台（照 `pages/ai-chat/AdvancedVisualAgentTab.tsx` 复刻）。
 *
 * 真实结构（这一版之前画错过一次，是照着 import 列表凭空想的，重画时读了真实 return）：
 *   · 画布**铺满整块**，没有全宽顶栏；
 *   · 左边是竖向浮动工具条（胶囊，选择 / 上传 / 形状 / 文字 / 生成器 / 手绘 / 删除）；
 *   · 右边是 420px 的浮动对话面板，贴右贴顶、撑满高度；
 *   · 顶部居中只有一个缩放胶囊。
 *
 * 可交互：点画布上任意一张图，选中环与动作条（ImageQuickActionBar）跟着移到那张上方。
 * 这不是装饰——真实产品里选中图才会浮出动作条，这一屏要让人看懂这件事。
 */

const clay = inkTone(SCENE_HUE.clay);
const steel = inkTone(SCENE_HUE.steel);
const pine = inkTone(SCENE_HUE.pine);
const amber = inkTone(SCENE_HUE.amber);

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

/**
 * 三张图在画布上的位置（相对「画布可用区」的百分比，随宽度自适应）。
 *
 * 手机上不是把桌面这套等比缩小——那样画布下半屏是空的、动作条又和缩放胶囊打架。
 * 窄屏另排一套：图铺开占满，动作条落到画布底部横滑，第二张生成卡与生成器元素退场。
 */
const TILES_WIDE = [
  { id: 'a', hue: SCENE_HUE.steel, left: 8, top: 10, width: 34, fog: false },
  { id: 'b', hue: SCENE_HUE.clay, left: 46, top: 17, width: 26, fog: false },
  { id: 'c', hue: SCENE_HUE.pine, left: 14, top: 50, width: 29, fog: true },
] as const;

const TILES_NARROW = [
  { id: 'a', hue: SCENE_HUE.steel, left: 5, top: 9, width: 45, fog: false },
  { id: 'b', hue: SCENE_HUE.clay, left: 55, top: 22, width: 38, fog: false },
  { id: 'c', hue: SCENE_HUE.pine, left: 9, top: 48, width: 42, fog: true },
] as const;

type TileId = (typeof TILES_WIDE)[number]['id'];

export function VisualCanvasStage() {
  const { t } = useLanguage();
  const s = t.scenes.visual;
  const isMobile = useIsMobile();
  const tiles = isMobile ? TILES_NARROW : TILES_WIDE;
  const [picked, setPicked] = useState<TileId>('a');
  const active = tiles.find((tile) => tile.id === picked) ?? tiles[0];

  return (
    <div className="w-full">
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
        {/* 品类渗光 */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: `radial-gradient(360px 190px at 5% 0%, ${clay.faint} 0%, transparent 100%)` }}
        />

        {/* ── 画布可用区：宽屏时给右侧对话面板让出 432px ── */}
        <div className="absolute inset-0 lg:right-[444px]">
          {tiles.map((tile) => {
            const on = tile.id === picked;
            const tone = inkTone(tile.hue);
            return (
              <button
                key={tile.id}
                type="button"
                onClick={() => setPicked(tile.id)}
                aria-pressed={on}
                aria-label={s.tiles[tile.id]}
                className="absolute overflow-hidden rounded-[10px] transition-shadow duration-200"
                style={{
                  left: `${tile.left}%`,
                  top: `${tile.top}%`,
                  width: `${tile.width}%`,
                  aspectRatio: '3 / 2',
                  border: `1px solid ${on ? tone.solid : SCENE.line}`,
                  boxShadow: on ? `0 0 0 1px ${tone.solid}` : 'none',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                <CanvasArt id={tile.id} hue={tile.hue} fog={tile.fog} />
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
              </button>
            );
          })}

          {/* 生成中占位卡 —— GenSweepLoader 形态，就落在画布上（等待期主视觉是产物本身在长） */}
          <GenTile
            style={isMobile ? { left: '56%', top: '52%', width: '38%' } : { left: '75%', top: '10%', width: '24%' }}
            label={s.genRunning.label}
            status={s.genRunning.status}
            percent={70}
            tone={steel}
          />
          {/* 超预计态：转琥珀「即将完成」，进度封顶 95%——不假装精确后卡死 */}
          {!isMobile && (
            <GenTile
              style={{ left: '46%', top: '52%', width: '28%' }}
              label={s.genOvertime.label}
              status={s.genOvertime.status}
              percent={95}
              tone={amber}
              statusColor={amber.bright}
            />
          )}

          {/* 图像生成器：画布上的一个元素，不是一个弹窗 */}
          <div
            className="absolute hidden sm:flex flex-col justify-center gap-2 rounded-[10px]"
            style={{
              left: '75%',
              top: '56%',
              width: '24%',
              padding: '15px',
              border: `1px dashed ${SCENE.edgeStrong}`,
              background: SCENE.faintFill,
            }}
          >
            <SceneMono className="flex items-center gap-2" style={{ letterSpacing: '0.18em', textTransform: 'uppercase' }}>
              <span className="block w-[5px] h-[5px] rounded-full" style={{ background: clay.solid }} />
              {s.generator.title}
            </SceneMono>
            <span style={{ fontSize: '12px', color: SCENE.inkMid, lineHeight: 1.7 }}>{s.generator.body}</span>
          </div>

          {/*
           * 动作条：ImageQuickActionBar，跟着选中项走。
           *
           * 定位挂在一个和选中图同尺寸的隐形框上（同样的 left/top/width + 3:2），
           * 于是「贴着这张图的上沿 / 下沿」可以用 100% 表达，不必知道像素高度。
           * 靠画布顶部的两张图把动作条放到图**下方**：放上方会和顶部居中的缩放胶囊
           * 撞在一起——真实产品里画布很高不会撞，这里画布被压扁了才暴露出来。
           */}
          <div
            className="absolute pointer-events-none transition-all duration-300 ease-out"
            style={
              isMobile
                ? { left: '8px', right: '8px', bottom: '10px' }
                : { left: `${active.left}%`, top: `${active.top}%`, width: `${active.width}%`, aspectRatio: '3 / 2' }
            }
          >
          <div
            className="absolute flex items-center z-[4] pointer-events-auto"
            style={{
              ...(isMobile
                ? { left: 0, right: 0, bottom: 0 }
                : active.top < 30
                  ? { left: 0, top: 'calc(100% + 8px)' }
                  : { left: 0, bottom: 'calc(100% + 8px)' }),
              // 上限按「这张图右边还剩多少画布」折算成自身宽度的百分比：
              // 直接写死一个倍数，窄的那张图会把动作条截断（第一版 132% 就切掉了「AI 分层 / 下载」）。
              maxWidth: isMobile ? '100%' : `${Math.round(((100 - active.left) / active.width) * 100)}%`,
              overflowX: 'auto',
              gap: '2px',
              padding: '4px',
              background: SCENE.overlay,
              border: `1px solid ${SCENE.edgeStrong}`,
              borderRadius: '10px',
              boxShadow: SCENE.liftBar,
            }}
          >
            {s.actions.map((name, i) => (
              <span key={name} className="flex items-center" style={{ gap: '2px' }}>
                {(i === 3 || i === 5) && (
                  <span
                    className="block shrink-0"
                    style={{ width: '1px', height: '17px', background: SCENE.hair, margin: '0 3px' }}
                  />
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
          </div>
          </div>

          {/* 顶部居中：缩放胶囊（真实位置，不是全宽顶栏） */}
          <div
            className="absolute z-[5] flex items-center whitespace-nowrap"
            style={{
              top: '14px',
              left: '50%',
              transform: 'translateX(-50%)',
              height: '36px',
              gap: '4px',
              padding: '0 6px',
              borderRadius: '999px',
              background: SCENE.pill,
              border: `1px solid ${SCENE.edge}`,
              boxShadow: SCENE.liftSm,
            }}
          >
            <PillButton d="M5 12h14" />
            <SceneMono size={15} color={SCENE.inkMid} style={{ minWidth: '46px', textAlign: 'center' }}>
              100%
            </SceneMono>
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
            <SceneMono
              size={13}
              color={SCENE.inkMid}
              style={{ border: `1px solid ${SCENE.line}`, borderRadius: '4px', padding: '0 5px', margin: '0 3px' }}
            >
              Ctrl
            </SceneMono>
            {s.gesture.after}
          </div>
        </div>

        {/* ── 左侧：竖向浮动工具条（胶囊） ── */}
        <div
          className="absolute z-[5] hidden sm:flex flex-col"
          style={{
            left: '12px',
            top: '50%',
            transform: 'translateY(-50%)',
            gap: '6px',
            padding: '6px',
            borderRadius: '999px',
            background: SCENE.pill,
            border: `1px solid ${SCENE.edge}`,
            boxShadow: SCENE.liftMd,
          }}
        >
          {TOOL_PATHS.map((d, i) => (
            <span
              key={d}
              className="flex items-center justify-center"
              style={{
                width: '44px',
                height: '44px',
                borderRadius: '14px',
                background: i === 0 ? clay.soft : 'transparent',
                color: i === 0 ? clay.solid : SCENE.inkMid,
              }}
            >
              <SceneIcon d={d} size={18} />
            </span>
          ))}
        </div>

        {/* ── 右侧：浮动对话面板（420px，贴右贴顶，撑满高度） ── */}
        <div
          className="absolute z-[6] hidden lg:flex flex-col rounded-[14px]"
          style={{
            right: '12px',
            top: '12px',
            bottom: '12px',
            width: '420px',
            padding: '12px',
            background: SCENE.panel,
            border: `1px solid ${SCENE.edge}`,
            boxShadow: SCENE.liftLg,
          }}
        >
          <ChatPanel />
        </div>
      </div>

      {/* 窄屏：对话面板落到画布下方，保持「画布 + 设计师」两件东西都在 */}
      <div
        className="lg:hidden mt-3 flex flex-col rounded-[14px]"
        style={{
          padding: '12px',
          background: SCENE.panel,
          border: `1px solid ${SCENE.edge}`,
          boxShadow: SCENE.liftMd,
        }}
      >
        <ChatPanel compact />
      </div>
    </div>
  );
}

/** 右侧对话面板的内容。窄屏下只保留头 / 最后两条 / 模型行 / 输入区。 */
function ChatPanel({ compact = false }: { compact?: boolean }) {
  const { t } = useLanguage();
  const s = t.scenes.visual;

  return (
    <>
      {/* 面板头 */}
      <div className="flex items-start gap-2 shrink-0">
        <div className="min-w-0 flex-1">
          <div style={{ fontSize: '13px', fontWeight: 500, color: SCENE.ink }}>{s.chat.title}</div>
          <div style={{ marginTop: '3px', fontSize: '10.5px', lineHeight: 1.5, color: SCENE.inkDim }}>
            {s.chat.subtitle}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <IconSlot d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z" />
          <IconSlot d="M8 6h8v3a4 4 0 0 1-8 0zM6 13h12M4 10h2M18 10h2M5 17h3M16 17h3" />
          <span
            className="flex items-center gap-1"
            style={{
              height: '24px',
              padding: '0 8px',
              borderRadius: '6px',
              background: clay.soft,
              border: `1px solid ${clay.border}`,
              color: clay.bright,
              fontSize: '11px',
              whiteSpace: 'nowrap',
            }}
          >
            <SceneIcon d="M22 2L11 13M22 2l-7 20-4-9-9-4z" size={11} strokeWidth={2} />
            {s.chat.submit}
          </span>
        </div>
      </div>

      <div className="shrink-0" style={{ height: '1px', background: SCENE.hair, margin: '11px 0' }} />

      {/* 对话流 */}
      <div className="flex-1 min-h-0 flex flex-col justify-end gap-3 overflow-hidden">
        <div
          className="self-end"
          style={{
            maxWidth: '82%',
            padding: '9px 12px',
            borderRadius: '12px 12px 3px 12px',
            background: clay.soft,
            border: `1px solid ${clay.border}`,
            fontSize: '12.5px',
            lineHeight: 1.75,
            color: SCENE.ink,
          }}
        >
          {s.chat.user}
        </div>

        {!compact && (
          <div style={{ maxWidth: '88%' }}>
            <SceneMono size={13} color={SCENE.inkGhost} style={{ letterSpacing: '0.14em', textTransform: 'uppercase' }}>
              {s.chat.thinking}
            </SceneMono>
            <div
              style={{
                marginTop: '5px',
                padding: '9px 12px',
                borderRadius: '12px 12px 12px 3px',
                background: SCENE.tile,
                border: `1px solid ${SCENE.edge}`,
                fontSize: '12.5px',
                lineHeight: 1.8,
                color: SCENE.inkSoft,
              }}
            >
              {s.chat.reply}
            </div>
          </div>
        )}

        {/* 落回画布的产物条 —— 产物在哪、有没有压住别的图，都说清楚 */}
        <div
          className="flex items-center gap-2"
          style={{
            padding: '8px 10px',
            borderRadius: '10px',
            background: SCENE.ghost,
            border: `1px solid ${SCENE.hair}`,
          }}
        >
          <span
            className="shrink-0"
            style={{
              width: '40px',
              height: '28px',
              borderRadius: '5px',
              background: `linear-gradient(160deg, hsl(${SCENE_HUE.pine} 26% 20%), hsl(${SCENE_HUE.pine} 20% 10%))`,
            }}
          />
          <span style={{ fontSize: '11.5px', color: SCENE.inkMid, lineHeight: 1.5 }}>{s.chat.landed}</span>
        </div>

        <div
          style={{
            maxWidth: '88%',
            padding: '9px 12px',
            borderRadius: '12px 12px 12px 3px',
            background: SCENE.tile,
            border: `1px solid ${SCENE.edge}`,
            fontSize: '12.5px',
            lineHeight: 1.8,
            color: SCENE.inkSoft,
          }}
        >
          {s.chat.streaming}
          <span
            className="inline-block map-scene-anim"
            style={{
              width: '2px',
              height: '13px',
              background: clay.solid,
              marginLeft: '3px',
              verticalAlign: '-2px',
              animation: 'mapSceneCaret 1s steps(1) infinite',
            }}
          />
        </div>
      </div>

      {/* 模型可见性（ai-model-visibility：当前模型与模型池必须露出） */}
      <SceneMono className="flex items-center gap-2 shrink-0" style={{ margin: '10px 0 8px' }}>
        <span className="block w-[5px] h-[5px] rounded-full" style={{ background: pine.solid }} />
        {s.chat.model}
        <span className="block" style={{ width: '1px', height: '12px', background: SCENE.line }} />
        {s.chat.pool}
      </SceneMono>

      {/* 输入区 */}
      <div
        className="shrink-0"
        style={{
          borderRadius: '12px',
          background: SCENE.tileHi,
          border: `1px solid ${SCENE.line}`,
          padding: '10px 11px',
        }}
      >
        <div style={{ fontSize: '12.5px', color: SCENE.inkFaint, lineHeight: 1.6 }}>{s.chat.placeholder}</div>
        <div className="flex items-center gap-1.5" style={{ marginTop: '10px' }}>
          <IconSlot d="M21 15l-5-5L5 21M3 5h18v14H3z" boxed />
          <IconSlot d="M12 3v18M3 12h18" boxed />
          <span
            className="flex items-center gap-1.5 ml-auto"
            style={{
              height: '28px',
              padding: '0 14px',
              borderRadius: '8px',
              background: SCENE.brand,
              color: SCENE.brandFg,
              fontSize: '12.5px',
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
    <span
      className="flex items-center justify-center"
      style={{ width: '28px', height: '28px', borderRadius: '999px', color: SCENE.inkMid }}
    >
      <SceneIcon d={d} size={14} strokeWidth={2} />
    </span>
  );
}

/**
 * 生成中的占位卡。等待期屏幕上是**产物的形状**在长，不是一个居中 spinner
 * （artifact-is-experience）；并且给「已耗时 / 预计」而不是一个会卡死的百分比
 * （expectation-management）。
 */
function GenTile({
  style,
  label,
  status,
  percent,
  tone,
  statusColor,
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
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(180deg, ${tone.faint} 0%, transparent 45%, ${tone.faint} 100%), ${SCENE.hatch}`,
        }}
      />
      <div
        className="absolute map-scene-anim"
        style={{
          top: '-10%',
          bottom: '-10%',
          left: 0,
          width: '92%',
          background: `linear-gradient(108deg, transparent 0%, ${SCENE.sweepEdge} 22%, ${tone.soft} 50%, ${SCENE.sweepEdge} 78%, transparent 100%)`,
          animation: 'mapSceneSweep 2.8s linear infinite',
        }}
      />
      {/* 一行放不下就让状态先省略，绝不换行——「HD 放 / 大」那样断开比截断更难读 */}
      <div
        className="absolute flex items-baseline gap-2 overflow-hidden"
        style={{ left: '9px', right: '9px', bottom: '14px' }}
      >
        <SceneMono style={{ letterSpacing: '0.08em', whiteSpace: 'nowrap' }}>{label}</SceneMono>
        <SceneMono
          className="ml-auto min-w-0 truncate"
          color={statusColor ?? SCENE.inkFaint}
          style={{ letterSpacing: '0.08em' }}
        >
          {status}
        </SceneMono>
      </div>
      <div
        className="absolute overflow-hidden"
        style={{ left: '9px', right: '9px', bottom: '8px', height: '2px', borderRadius: '2px', background: SCENE.line }}
      >
        <span
          className="block h-full"
          style={{ width: `${percent}%`, background: `linear-gradient(90deg, ${tone.border}, ${tone.solid})` }}
        />
      </div>
    </div>
  );
}

/**
 * 画布上那几张「图」。不是占位灰块——画一张有山脊线、有光源、有前后景的图，
 * 才看得出「把主视觉改成雾天、山脊线保留」这句话到底改了什么。
 */
function CanvasArt({ id, hue, fog }: { id: string; hue: number; fog: boolean }) {
  const gid = `mapCanvasArt-${id}`;
  return (
    <svg
      viewBox="0 0 300 200"
      preserveAspectRatio="none"
      className="block w-full h-full"
      aria-hidden="true"
    >
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
      <path
        d="M0 118 L58 88 L104 116 L152 78 L206 112 L262 92 L300 118 L300 200 L0 200 Z"
        fill={`hsl(${hue} 27% 13%)`}
      />
      {fog ? (
        <rect y="72" width="300" height="128" fill={`url(#${gid}-fog)`} />
      ) : (
        <path
          d="M0 146 L64 128 L128 150 L196 130 L262 152 L300 138 L300 200 L0 200 Z"
          fill={`hsl(${hue} 22% 10%)`}
        />
      )}
    </svg>
  );
}
