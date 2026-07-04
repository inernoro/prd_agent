import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { X, ChevronRight, Sparkles, Check, Circle, CircleDot, GraduationCap } from 'lucide-react';
import {
  SPOTLIGHT_ACTION_KEY,
  SPOTLIGHT_TARGET_KEY,
  SPOTLIGHT_PAYLOAD_UPDATED_EVENT,
  type SpotlightActionPayload,
} from './TipsRotator';
import type { DailyTipAutoAction } from '@/services/real/dailyTips';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';
import { fireConfetti } from './fireConfetti';

/** 安全 querySelector:逗号兜底选择器 / 非法选择器都不抛错。 */
function safeQuery(sel: string | null | undefined): Element | null {
  if (!sel) return null;
  try {
    return document.querySelector(sel);
  } catch {
    return null;
  }
}

function isVisualAuditMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('visualAudit') === '1';
  } catch {
    return false;
  }
}

/**
 * 飞回 + 接住的共享时序(SSOT)。两段动画必须挂在同一条「合成层时钟」上,且都用 delay 预约,
 * 不靠「飞完 onfinish → setState → 重渲染」那条主线程链路触发 —— 否则页面卡顿时主线程被占满,
 * 帽子(合成层)早落地、闪光(主线程二次渲染)还堵在队列里,出现「接触与闪烁差几秒」的脱钩(用户 2026-06-15 实测)。
 * LAND_DELAY 略小于 FLY_DURATION,让挤压/辉光在帽子最后接触的那一刻引爆(留 ~120ms 重叠)。
 */
const FLY_DURATION = 1440;
const LAND_OVERLAP = 120;
const LAND_DELAY = FLY_DURATION - LAND_OVERLAP;

/**
 * 「飞回教程入口」完成动画(诉求 6):教程走完后,一枚毕业帽徽章从最后高亮的光圈中心
 * 飞向右上角「本页教程」pill(data-tour-entry),提醒用户"以后从这里再看",避免学完即忘。
 * 用 Web Animations API 走任意两点曲线,结束后回调清理。
 */
function FlyingToken({
  from,
  to,
  onDone,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      onDone();
      return;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const anim = el.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 0.95 },
        {
          transform: `translate(-50%,-50%) translate(${dx * 0.5}px, ${dy * 0.5 - 36}px) scale(0.85)`,
          opacity: 1,
          offset: 0.55,
        },
        { transform: `translate(-50%,-50%) translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0 },
      ],
      // 半速(FLY_DURATION,原 720 的两倍):用户反馈关闭教程时飞回动画太快「看不见」,
      // 放慢一倍让毕业帽明显地飞回右上角入口,提醒以后从这里重看。
      { duration: FLY_DURATION, easing: 'cubic-bezier(.4,0,.2,1)' },
    );
    anim.onfinish = onDone;
    return () => {
      anim.onfinish = null;
      anim.cancel();
    };
  }, [from, to, onDone]);
  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: from.x,
        top: from.y,
        zIndex: 10001,
        pointerEvents: 'none',
        width: 30,
        height: 30,
        borderRadius: 999,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg,#a78bfa,#818cf8)',
        boxShadow: '0 8px 24px -6px rgba(129,140,248,0.7)',
        color: '#fff',
      }}
    >
      <GraduationCap size={16} strokeWidth={2.4} />
    </div>
  );
}

/**
 * 把一条阻尼谐振子(弹簧)采样成 WAAPI 关键帧 —— 这是 iOS/SwiftUI `.spring(response,dampingFraction)`
 * 的手感来源:位移带自然过冲再收敛,而非贝塞尔那种「编出来」的速度曲线。
 * response=弹簧周期(越小越快),zeta=阻尼系数(1=不过冲,<1 越小越弹);sx0/sy0=撞击瞬间的初始挤压。
 * v 在过冲段会 >1,自动得到反向挤压(secondary motion),正是「被撞扁又回弹」的实感。
 */
function springScaleFrames(response: number, zeta: number, sx0: number, sy0: number, n = 48): Keyframe[] {
  const w0 = (2 * Math.PI) / response;
  const settle = response * (zeta < 1 ? 2.4 : 1.7);
  const frames: Keyframe[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (settle * i) / n;
    let v: number;
    if (zeta < 1) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta);
      v = 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
    } else {
      v = 1 - Math.exp(-w0 * t) * (1 + w0 * t);
    }
    const sx = sx0 + (1 - sx0) * v;
    const sy = sy0 + (1 - sy0) * v;
    frames.push({ transform: `scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`, offset: i / n });
  }
  return frames;
}

/**
 * 毕业帽飞回入口「落地」那一刻在 pill 位置引爆的「接住」效果:pill 弹簧挤压 + 环形辉光 + 涟漪。
 *
 * 关键:本组件在**飞行一开始**就和 FlyingToken 一起挂载,三段动画全部用 `delay: LAND_DELAY` 预约,
 * 在合成层(GPU)上自行按点引爆 —— 不经过「飞完 onfinish → setState → 重渲染」那条主线程链路。
 * 这样页面卡顿时帽子(合成层)与闪光(合成层)仍共享同一时钟、严丝合缝,根治「接触与闪烁差几秒」。
 * delay 期间所有元素 opacity 0 / pill 维持原状,飞行途中不可见,落地瞬间才亮。
 * 只动 opacity/transform(合成层,不动 box-shadow 扩散);环形 halo 中心镂空不遮挡 pill 文字。
 */
function EntryLandingFx({
  rect,
  onDone,
}: {
  rect: { x: number; y: number; w: number; h: number };
  onDone: () => void;
}) {
  const glowRef = useRef<HTMLDivElement>(null);
  const rippleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const glow = glowRef.current;
    const ripple = rippleRef.current;
    const anims: Animation[] = [];
    // pill 挤压跑在常驻的真实入口节点(data-tour-entry)上,单独跟踪:卸载时**只取消仍在 delay 预约期**
    // 的那一份(见 cleanup),避免「新教程在接住延迟未引爆时启动 → 本 FX 卸载 → 预约动画却幽灵引爆并和
    // 下一次接住重叠」(Bugbot Medium);已进入播放期的不取消,任其自然播完(fill:none 自动复位),
    // 这样既不留幽灵、又不会把播放中的挤压 cancel 出突兀回弹。
    const pillAnims: Animation[] = [];
    // pill 本体弹簧挤压(非等比:撞击 X 宽 Y 扁 → 弹簧收敛回 1,过冲自然反挤压),与辉光同一 delay 引爆。
    const entry = document.querySelector('[data-tour-entry]');
    if (entry instanceof HTMLElement) {
      try {
        pillAnims.push(
          entry.animate(springScaleFrames(0.42, 0.55, 1.16, 0.86), {
            duration: 560,
            delay: LAND_DELAY,
            easing: 'linear',
          }),
        );
        pillAnims.push(
          entry.animate([{ borderColor: 'rgba(196,181,253,0.95)', color: '#fff', offset: 0 }, { offset: 1 }], {
            duration: 700,
            delay: LAND_DELAY,
            easing: 'ease-out',
          }),
        );
      } catch {
        /* 老浏览器不支持 WAAPI 时静默降级,不影响教程功能本身 */
      }
    }
    if (glow) {
      const a = glow.animate(
        [
          { opacity: 0, transform: 'scale(0.55)' },
          { opacity: 0.95, transform: 'scale(1.05)', offset: 0.12 },
          { opacity: 0.3, transform: 'scale(1.25)', offset: 0.4 },
          { opacity: 0, transform: 'scale(1.45)' },
        ],
        { duration: 620, delay: LAND_DELAY, easing: 'cubic-bezier(.2,.7,.3,1)' },
      );
      a.onfinish = onDone; // 落地播完后清理(纯卸载,即便因卡顿迟到也无副作用——视觉已在合成层准时播完)
      anims.push(a);
    } else {
      onDone();
    }
    if (ripple) {
      anims.push(
        ripple.animate(
          [
            { opacity: 0.9, transform: 'scale(1)' },
            { opacity: 0, transform: 'scale(1.9)' },
          ],
          { duration: 520, delay: LAND_DELAY, easing: 'cubic-bezier(.1,.6,.3,1)' },
        ),
      );
    }
    return () => {
      anims.forEach((a) => {
        a.onfinish = null;
        a.cancel();
      });
      // pill 动画:仍在 delay 预约期(尚未视觉播放)的取消掉,防幽灵引爆;已开始播放的留它播完。
      pillAnims.forEach((a) => {
        const ct = typeof a.currentTime === 'number' ? a.currentTime : 0;
        if (ct < LAND_DELAY) a.cancel();
      });
    };
  }, [onDone]);
  return createPortal(
    <>
      <div
        ref={glowRef}
        style={{
          position: 'fixed',
          left: rect.x - 16,
          top: rect.y - 16,
          width: rect.w + 32,
          height: rect.h + 32,
          borderRadius: 18,
          zIndex: 10000,
          pointerEvents: 'none',
          opacity: 0,
          transformOrigin: 'center',
          // 中心镂空的环形辉光:不盖 pill 文字,只在边缘点亮一圈
          background:
            'radial-gradient(closest-side, rgba(167,139,250,0) 46%, rgba(167,139,250,0.55) 70%, rgba(167,139,250,0) 100%)',
          filter: 'blur(2px)',
        }}
      />
      <div
        ref={rippleRef}
        style={{
          position: 'fixed',
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          borderRadius: 10,
          zIndex: 10000,
          pointerEvents: 'none',
          opacity: 0,
          transformOrigin: 'center',
          border: '1.5px solid rgba(196,181,253,0.9)',
        }}
      />
    </>,
    document.body,
  );
}

/**
 * JetBrains-style 功能高亮 + 自动引导。
 *
 * 挂载时从 sessionStorage 读取 SpotlightActionPayload(新)或 SPOTLIGHT_TARGET_KEY(旧兼容):
 *   1) 按顺序执行 autoAction: scroll → expand → prefill
 *   2) 定位元素,画脉冲光圈 + 浮层说明卡(若 payload 带 title)
 *   3) 若配置 Steps,渲染"下一步"按钮依次高亮
 *   4) 若配置 autoClick,延迟后自动点击
 *   5) 用户点遮罩/ESC/光圈关闭按钮可随时退出
 *
 * 设计:fixed 定位,createPortal 到 body 避免父 transform 干扰。
 */
export function SpotlightOverlay() {
  const navigate = useNavigate();
  const visualAuditMode = isVisualAuditMode();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [payload, setPayload] = useState<SpotlightActionPayload | null>(null);
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [dismissed, setDismissed] = useState(false);
  /** 6 秒还没找到 selector 就置 true,显示「找不到元素」友好卡片 */
  const [seekTimedOut, setSeekTimedOut] = useState(false);
  const autoClickTimerRef = useRef<number | null>(null);
  /** 每个 payload 只允许 autoClick 触发一次,避免多步 Tour 里每切一步都自动点击 */
  const autoClickFiredForPayloadRef = useRef<SpotlightActionPayload | null>(null);
  /** 任务清单里「当前步骤」的行,切步时滚动到可见,长清单也不丢当前任务 */
  const curStepRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    curStepRef.current?.scrollIntoView({ block: 'nearest' });
  }, [stepIndex]);
  /** 引导气泡 DOM ref + 实测高度:用真实高度做「贴着光圈上/下方又不超出视口」的定位,
   *  避免老版本用硬编码 180px 估高导致气泡溢出屏幕底、把「下一步 / 完成」按钮顶到视口外
   *  （高光目标是右侧很高的投放面板时尤其明显 —— 用户点不到「完成」就永远走不完、存不上）。 */
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const [bubbleHeight, setBubbleHeight] = useState<number | null>(null);
  /** 完成飞回动画的起止坐标(诉求 6),null=不播放 */
  const [flyBack, setFlyBack] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);
  const clearFlyBack = useCallback(() => setFlyBack(null), []);
  /** 毕业帽落地后在 pill 位置播放的「接住」辉光/涟漪 rect(诉求:发个光、闪一闪),null=不播放 */
  const [landFx, setLandFx] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // 稳定引用:landFx 与 flyBack 同帧设、要等延迟动画播完(~1940ms)才清,期间父组件会因 clearFlyBack
  // 等重渲染。若用内联 onDone,EntryLandingFx 的 effect 会随每次父渲染重跑、把落地动画中途重启 —— 必须稳。
  const clearLandFx = useCallback(() => setLandFx(null), []);

  // ---- 启动 + 同路由事件:读 sessionStorage 解析 payload ----
  // 初次 mount 读一次;TipsRotator 写完 payload 会广播 SPOTLIGHT_PAYLOAD_UPDATED_EVENT,
  // 解决「同页面点 CTA 时 React Router 不 re-mount」导致 overlay 不启动的 bug。
  useEffect(() => {
    const readAndStart = () => {
      if (visualAuditMode) {
        try {
          sessionStorage.removeItem(SPOTLIGHT_ACTION_KEY);
          sessionStorage.removeItem(SPOTLIGHT_TARGET_KEY);
        } catch {
          /* noop */
        }
        setPayload(null);
        setDismissed(true);
        return;
      }
      let initial: SpotlightActionPayload | null = null;
      try {
        const raw = sessionStorage.getItem(SPOTLIGHT_ACTION_KEY);
        if (raw) {
          initial = JSON.parse(raw) as SpotlightActionPayload;
        }
      } catch {
        /* JSON 坏了就走旧路径 */
      }
      if (!initial) {
        let legacy: string | null = null;
        try {
          legacy = sessionStorage.getItem(SPOTLIGHT_TARGET_KEY);
        } catch {
          /* noop */
        }
        if (legacy) {
          initial = { selector: legacy };
        }
      }

      // 消费一次就清理,防止同路由反复弹
      try {
        sessionStorage.removeItem(SPOTLIGHT_ACTION_KEY);
        sessionStorage.removeItem(SPOTLIGHT_TARGET_KEY);
      } catch {
        /* noop */
      }

      if (!initial) return;
      // 新教程启动前,先清掉上一次关闭遗留的「飞回 + 接住」FX:否则 setDismissed(false) 会让 landFxNode
      // 停止渲染、EntryLandingFx 卸载,而其挂在入口节点上的预约挤压动画若还没引爆就会变成幽灵(Bugbot)。
      // 这里显式置空 → 触发 EntryLandingFx 卸载的 cleanup(取消预约期的 pill 动画),状态也不残留。
      setFlyBack(null);
      setLandFx(null);
      setRect(null);
      setPayload(initial);
      setStepIndex(0);
      setDismissed(false);
      setSeekTimedOut(false);
    };

    readAndStart();
    window.addEventListener(SPOTLIGHT_PAYLOAD_UPDATED_EVENT, readAndStart);
    return () => {
      window.removeEventListener(SPOTLIGHT_PAYLOAD_UPDATED_EVENT, readAndStart);
    };
  }, [visualAuditMode]);

  // ---- 当前 step 的 selector(Steps 优先,否则用 payload.selector)----
  const steps = payload?.autoAction?.steps ?? null;
  const currentSelector =
    steps && steps[stepIndex] ? steps[stepIndex].selector : payload?.selector ?? null;

  // ---- 飞回右上角「本页教程」pill 动画(任何关闭路径都播一次)----
  // 历史:飞回动画原先只在「完成」末步触发,且 720ms 太快 —— 用户关闭/取消教程时
  // 「看不见」入口在哪。现在抽成公共函数,X / 点空白 / ESC / 我已学会 / 完成 全部复用,
  // 半速播放(见 FlyingToken),让用户每次关闭都看到毕业帽飞回入口。
  // 全站「教程」入口是同一个组件 TipsEntryButton(都带 data-tour-entry),且本 Overlay 是 App 根
  // 全局唯一挂载 —— 所以这套飞回 + 接住效果改这一处,任何页面、任何关闭路径(完成/我已学会/X/ESC)
  // 只要帽子飞回来就一致触发。
  //
  // flyBack(帽子)与 landFx(接住光效)**同帧一起设**:两者在同一次渲染里挂载,共享同一条合成层时钟。
  // 接住动画在 EntryLandingFx 内用 delay 预约(LAND_DELAY),不靠「飞完 onfinish → setState → 重渲染」
  // 这条主线程链路触发 —— 根治页面卡顿时「帽子早落地、闪光迟几秒」的脱钩(用户 2026-06-15 实测)。
  const flyBackToEntry = useCallback(() => {
    const entry = document.querySelector('[data-tour-entry]');
    if (!entry) return;
    // 优先从当前光圈起飞;光圈不在(定位中/超时态)则从气泡卡片起飞;都没有就不播。
    const src = safeQuery(currentSelector) ?? bubbleRef.current;
    if (!src) return;
    const sr = src.getBoundingClientRect();
    const er = entry.getBoundingClientRect();
    setFlyBack({
      from: { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 },
      to: { x: er.left + er.width / 2, y: er.top + er.height / 2 },
    });
    setLandFx({ x: er.left, y: er.top, w: er.width, h: er.height });
  }, [currentSelector]);

  // 统一关闭:先播飞回动画,再隐藏卡片。flyBack 与 dismissed 同帧设置,
  // FlyingToken 在 dismissed 后仍由 flyBackNode 续播(见底部渲染)。
  const closeWithFlyBack = useCallback(() => {
    flyBackToEntry();
    setDismissed(true);
  }, [flyBackToEntry]);

  // 「我已学会」:标记该教程已学会(该页不再自动开讲/脉冲),再播飞回动画关闭。
  // 给「觉得每天弹窗烦」的用户一个一键退出口,无需走完整套步骤。
  const handleLearnedClose = useCallback(() => {
    if (payload?.id) void useDailyTipsStore.getState().markLearned(payload.id);
    closeWithFlyBack();
  }, [payload, closeWithFlyBack]);

  // ---- 推进到下一步(下一步按钮 / 用户亲手点高亮目标 共用)----
  // fromUserClick=true:用户已经亲手点了高亮目标(镂空可点),不再自动 click 揭示。
  const goNext = useCallback(
    (fromUserClick?: boolean) => {
      const all = payload?.autoAction?.steps;
      if (!all || stepIndex >= all.length - 1) return;
      const nextStep = all[stepIndex + 1];
      // 下一步元素当前不在 DOM 且无 navigateTo → 需要点当前元素来揭示它(仅非用户点场景)。
      const nextNeedsReveal =
        !nextStep?.navigateTo && (!nextStep?.selector || !safeQuery(nextStep.selector));
      if (!fromUserClick && currentSelector && nextNeedsReveal) {
        const el = safeQuery(currentSelector);
        if (
          el instanceof HTMLButtonElement ||
          el instanceof HTMLAnchorElement ||
          (el instanceof HTMLElement && el.getAttribute('role') === 'button')
        ) {
          try {
            el.click();
          } catch {
            /* noop */
          }
        }
      }
      if (nextStep?.navigateTo) navigate(nextStep.navigateTo);
      setStepIndex((i) => i + 1);
    },
    [payload, stepIndex, currentSelector, navigate],
  );

  // ---- 完成教程:撒花 + markLearned + 飞回 pill 动画 ----
  const completeTour = useCallback(
    (originX?: number, originY?: number) => {
      const all = payload?.autoAction?.steps;
      if (all && all.length > 0) {
        if (originX != null && originY != null) fireConfetti({ originX, originY });
        if (payload?.id) void useDailyTipsStore.getState().markLearned(payload.id);
      }
      // 飞回右上角「本页教程」入口,提醒以后从这里重看(诉求 6)
      flyBackToEntry();
      setDismissed(true);
    },
    [payload, flyBackToEntry],
  );

  // ---- 镂空可点:用户亲手点高亮目标即推进/完成(诉求 8「跟我做」)----
  // 让元素自身的 onClick 先跑(60ms),再推进;单步教程不挂(无"下一步"语义)。
  useEffect(() => {
    if (!rect || dismissed) return;
    const all = payload?.autoAction?.steps ?? null;
    if (!all || all.length === 0 || !currentSelector) return;
    const el = safeQuery(currentSelector);
    if (!el) return;
    const onClick = () => {
      window.setTimeout(() => {
        if (stepIndex >= all.length - 1) {
          const r = el.getBoundingClientRect();
          completeTour(r.left + r.width / 2, r.top + r.height / 2);
        } else {
          goNext(true);
        }
      }, 80);
    };
    el.addEventListener('click', onClick, { once: true });
    return () => el.removeEventListener('click', onClick);
  }, [rect, currentSelector, dismissed, stepIndex, payload, goNext, completeTour]);

  // ---- expand / prefill 一次性 setup:只在 payload 初次设置时执行 ----
  // ★ 不能放在下面依赖 stepIndex 的 effect 里,否则每次「下一步」都会:
  //   - 重新 click 折叠面板(可能把已展开的折叠回去)
  //   - 重新 prefill + focus 输入框(覆盖用户已输入内容)
  const setupRanForPayloadRef = useRef<SpotlightActionPayload | null>(null);
  useEffect(() => {
    if (!payload || dismissed) return;
    if (setupRanForPayloadRef.current === payload) return;
    setupRanForPayloadRef.current = payload;

    const autoAction = payload.autoAction ?? null;
    if (!autoAction) return;

    // 1) expand:若有,先点击一次折叠触发器(常见:summary / role=button)
    if (autoAction.expand) {
      try {
        const trigger = document.querySelector(autoAction.expand);
        if (trigger instanceof HTMLElement) trigger.click();
      } catch {
        /* 选择器无效不阻塞 */
      }
    }

    // 2) prefill:用原生 setter 触发 React onChange
    if (autoAction.prefill) {
      try {
        const el = document.querySelector(autoAction.prefill.selector);
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto =
            el instanceof HTMLTextAreaElement
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, autoAction.prefill.value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.focus();
        }
      } catch {
        /* noop */
      }
    }
  }, [payload, dismissed]);

  // ---- 每步 scroll + poll selector + 画光圈 ----
  useEffect(() => {
    if (!payload || !currentSelector || dismissed) return;

    let cancelled = false;
    const autoAction: DailyTipAutoAction | null = payload.autoAction ?? null;
    const scroll = (autoAction?.scroll as 'center' | 'top' | 'none' | null) ?? 'center';

    // 切步时:若新一步的目标当前不在 DOM,先清掉旧光圈(改显「正在定位…」气泡),
    // 避免连续多步都找不到目标时,旧光圈一直停在上一处元素上,
    // 让用户误以为「每一步都指向同一个元素」(用户 2026-06-04 反馈的网页托管教程现象)。
    // 若目标已在 DOM,则保留旧 rect 等下方 poll 立即覆盖,保持无闪烁切换。
    try {
      if (!document.querySelector(currentSelector)) setRect(null);
    } catch {
      setRect(null);
    }

    // 轮询等目标元素就绪(Reveal 动效 + 异步加载场景)
    // 250ms × 40 = 10s 上限,给慢服务器 + 慢网络 + React 渲染余地
    // 找不到就 setSeekTimedOut(true) 走友好失败卡片
    setSeekTimedOut(false);
    let attempts = 0;
    const maxAttempts = 40;
    const pollId = window.setInterval(() => {
      attempts += 1;
      if (cancelled) {
        window.clearInterval(pollId);
        return;
      }
      try {
        const el = document.querySelector(currentSelector);
        if (el) {
          if (scroll !== 'none') {
            // 用 behavior: 'auto' 同步滚动,避免 smooth 动画期间 rect 读到
            // 还没滚过去的 stale 位置导致光圈闪到屏外再滑回来。
            // 淡入动画已足够自然,不需要 smooth scroll 效果。
            el.scrollIntoView({
              behavior: 'auto',
              block: scroll === 'top' ? 'start' : 'center',
            });
          }
          setRect(el.getBoundingClientRect());
          window.clearInterval(pollId);
          return;
        }
      } catch {
        window.clearInterval(pollId);
        return;
      }
      if (attempts >= maxAttempts) {
        window.clearInterval(pollId);
        setSeekTimedOut(true);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearInterval(pollId);
    };
  }, [payload, currentSelector, dismissed, stepIndex]);

  // ---- 光圈挂上后:绑 ESC / resize / scroll / autoClick / 单步自动淡出 ----
  useEffect(() => {
    if (!rect || dismissed) return;

    const autoAction = payload?.autoAction ?? null;
    const hasSteps = (autoAction?.steps?.length ?? 0) > 0;

    // 单步模式:无 step + 无 autoClick 时,5s 自动淡出。也走 closeWithFlyBack ——
    // 单步提示(如 *-update-reminder 粘贴气泡)自动淡出同样属于「关闭」,要播飞回动画,
    // 与手动关闭口径一致(否则 reminder 不交互、5s 后静默消失,不提示入口位置;Bugbot)。
    let fadeTimer: number | null = null;
    if (!hasSteps && !autoAction?.autoClick) {
      fadeTimer = window.setTimeout(() => closeWithFlyBack(), 5000);
    }

    // autoClick:延迟后自动点击目标(光圈已显示一段时间,让用户看清)
    // ★ 语义上 autoClick 是"单次自动操作",跟多步 Tour 的"用户手动推进"天然冲突:
    //   如果 tour 里每找到一步的 rect 就启动新 timer,1.2s 后会自动 click +
    //   dismiss,导致整个 Tour 被打断。所以多步 Tour 时直接忽略 autoClick;
    //   单步模式下再用 setupRanForPayloadRef 确保同一 payload 只触发一次。
    if (autoAction?.autoClick && !hasSteps && autoClickFiredForPayloadRef.current !== payload) {
      autoClickFiredForPayloadRef.current = payload;
      const delay = autoAction.autoClickDelayMs ?? 1200;
      autoClickTimerRef.current = window.setTimeout(() => {
        try {
          const target = document.querySelector(autoAction.autoClick!);
          if (target instanceof HTMLElement) target.click();
        } catch {
          /* noop */
        }
        closeWithFlyBack(); // autoClick 完成后关闭也走飞回(口径统一;若已导航离开则 flyBackToEntry 取不到光圈静默跳过)
      }, delay);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeWithFlyBack();
    };
    const onResize = () => {
      if (!currentSelector) return;
      try {
        const el = document.querySelector(currentSelector);
        if (el) setRect(el.getBoundingClientRect());
      } catch {
        /* noop */
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onResize, true);

    return () => {
      if (fadeTimer) window.clearTimeout(fadeTimer);
      if (autoClickTimerRef.current) window.clearTimeout(autoClickTimerRef.current);
      autoClickTimerRef.current = null;
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onResize, true);
    };
  }, [rect, currentSelector, payload, dismissed, closeWithFlyBack]);

  // 渲染后实测气泡高度,供下面的定位逻辑把整张卡片（含底部按钮行）夹在视口内。
  // 只在高度真正变化(>1px)时 setState,守住「setState → 重渲染 → 再测」不成死循环;
  // deps 覆盖所有会改变卡片高度的输入(切步 / 换 payload / 重定位 / 失败卡 / 关闭)。
  useLayoutEffect(() => {
    const h = bubbleRef.current?.offsetHeight ?? null;
    if (h != null && (bubbleHeight == null || Math.abs(h - bubbleHeight) > 1)) {
      setBubbleHeight(h);
    }
  }, [rect, stepIndex, payload, seekTimedOut, dismissed, bubbleHeight]);

  // 完成飞回动画即使在 dismissed 后也要继续播放(completeTour 同帧设了 flyBack + dismissed)。
  const flyBackNode = flyBack
    ? createPortal(<FlyingToken from={flyBack.from} to={flyBack.to} onDone={clearFlyBack} />, document.body)
    : null;
  // 帽子落地后的「接住」辉光/涟漪 —— 与 flyBackNode 一样,dismissed 后仍需续播(落地发生在飞行结束、卡片已隐藏时)。
  const landFxNode = landFx ? <EntryLandingFx rect={landFx} onDone={clearLandFx} /> : null;

  if (dismissed || !payload)
    return (
      <>
        {flyBackNode}
        {landFxNode}
      </>
    );

  // 「等待中」阶段:payload 有但 rect 还没到 & 未超时 → 显示蓝色「正在定位…」小卡片
  // 避免用户点跳转后 6s 内啥都看不到,以为没反应
  if (!rect && !seekTimedOut) {
    const stepsTotal = payload.autoAction?.steps?.length ?? 0;
    const stepLabel = stepsTotal > 0 ? `第 ${stepIndex + 1} / ${stepsTotal} 步` : '目标';
    return createPortal(
      <div
        style={{
          position: 'fixed',
          right: 20,
          bottom: 150,
          padding: '8px 12px',
          borderRadius: 999,
          background: 'linear-gradient(180deg, rgba(24,28,40,0.95), rgba(16,18,28,0.98))',
          border: '1px solid rgba(129,140,248,0.35)',
          boxShadow: '0 6px 20px -8px rgba(76,29,149,0.45)',
          zIndex: 9999,
          color: 'rgba(196,181,253,0.85)',
          fontSize: 12,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          animation: 'spotlightBubbleIn 160ms ease-out',
        }}
      >
        <Sparkles size={12} style={{ animation: 'spin 1.5s linear infinite' }} />
        正在定位「{stepLabel}」…
        <style>{`@keyframes spin { 0% { transform: rotate(0) } 100% { transform: rotate(360deg) } }`}</style>
      </div>,
      document.body,
    );
  }

  // 找不到目标元素 + 超时 → 渲染友好失败卡片(不再静默消失)
  // 多步 Tour 切步时故意保留旧 rect 防闪烁,所以不能用 `!rect` 判断超时;
  // seekTimedOut 置 true 就必须显示失败卡,不管此时 rect 是旧值还是 null
  if (seekTimedOut) {
    const stepsTotal = payload.autoAction?.steps?.length ?? 0;
    const stepLabel = stepsTotal > 0 ? `第 ${stepIndex + 1} / ${stepsTotal} 步` : '当前步骤';
    return createPortal(
      <div
        style={{
          position: 'fixed',
          right: 20,
          bottom: 150,
          width: 340,
          padding: '12px 14px',
          borderRadius: 14,
          background: 'linear-gradient(180deg, rgba(30,20,22,0.98), rgba(15,10,12,0.98))',
          border: '1px solid rgba(251,146,60,0.4)',
          boxShadow: '0 20px 50px -20px rgba(0,0,0,0.8)',
          zIndex: 9999,
          color: 'rgba(255,255,255,0.9)',
          animation: 'spotlightBubbleIn 240ms cubic-bezier(.2,.8,.2,1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: '#fdba74', marginBottom: 4 }}>
          <Sparkles size={12} />
          没找到「{stepLabel}」的目标元素
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginBottom: 10, lineHeight: 1.55 }}>
          可能原因:当前页面还没有相关数据(比如还没创建过任何知识库 / 暂无本周更新),
          或页面正在加载。<br />
          Selector: <code style={{ fontSize: 11, opacity: 0.7 }}>{currentSelector}</code>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          {stepsTotal > 0 && stepIndex < stepsTotal - 1 && (
            <button
              type="button"
              onClick={() => {
                setSeekTimedOut(false);
                const nextStep = payload.autoAction?.steps?.[stepIndex + 1];
                if (nextStep?.navigateTo) navigate(nextStep.navigateTo);
                setStepIndex((i) => i + 1);
              }}
              style={{
                fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 999,
                border: '1px solid rgba(251,146,60,0.4)', background: 'rgba(251,146,60,0.12)',
                color: '#fdba74', cursor: 'pointer',
              }}
            >
              跳过这一步
            </button>
          )}
          <button
            type="button"
            onClick={closeWithFlyBack}
            style={{
              fontSize: 12, fontWeight: 600, padding: '5px 10px', borderRadius: 999,
              border: 'none', background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.8)',
              cursor: 'pointer',
            }}
          >
            关闭引导
          </button>
        </div>
      </div>,
      document.body,
    );
  }

  if (!rect) return null;

  const isLastStep = !steps || stepIndex >= steps.length - 1;
  const currentStep = steps ? steps[stepIndex] : null;
  const bubbleTitle = currentStep?.title ?? payload.title ?? null;
  const bubbleBody = currentStep?.body ?? payload.body ?? null;

  // 气泡挂在光圈下方;若下方空间不够就放上方。
  // 用实测高度（首帧未测出前给个保守估值）而非硬编码 180,并把气泡整体夹进视口,
  // 保证底部「下一步 / 完成」按钮永远可见、可点(否则走不完 → markLearned 不触发 → 每次进页都重弹)。
  const VIEWPORT_MARGIN = 16;
  const GAP = 12;
  const vh = window.innerHeight;
  // 气泡自身最高占满视口(留上下边距);超出部分由内部滚动区消化。
  const maxBubbleH = Math.max(200, vh - VIEWPORT_MARGIN * 2);
  const estBubbleH = Math.min(bubbleHeight ?? 240, maxBubbleH);
  const PAD = 8;
  const ringBox = {
    left: rect.left - PAD,
    top: rect.top - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };
  const belowTop = ringBox.top + ringBox.height + GAP;
  const fitsBelow = belowTop + estBubbleH <= vh - VIEWPORT_MARGIN;
  // 下方放得下就放下方;否则放到光圈上方;无论哪种都再夹一次,确保整卡片(尤其底部按钮)在屏内。
  const bubbleTop = Math.max(
    VIEWPORT_MARGIN,
    Math.min(
      fitsBelow ? belowTop : ringBox.top - GAP - estBubbleH,
      vh - estBubbleH - VIEWPORT_MARGIN,
    ),
  );
  const bubbleLeft = Math.max(
    16,
    Math.min(window.innerWidth - 360 - 16, ringBox.left + ringBox.width / 2 - 180),
  );

  const ringStyle: React.CSSProperties = {
    position: 'fixed',
    left: ringBox.left,
    top: ringBox.top,
    width: ringBox.width,
    height: ringBox.height,
    borderRadius: 12,
    pointerEvents: 'none',
    boxShadow:
      '0 0 0 2px rgba(129, 140, 248, 0.9), 0 0 0 9999px rgba(0, 0, 0, 0.55), 0 0 30px 6px rgba(129, 140, 248, 0.55)',
    animation: 'spotlightPulse 1.6s ease-out infinite',
    zIndex: 9998,
  };

  const overlay = (
    <>
      {/* 镂空可点(诉求 8):四块透明遮罩围住光圈、中间留洞 → 高亮元素可被用户真实点击「跟我做」。
          点洞外(四块)= 关闭引导;点洞内 = 命中真实元素(由 target-click effect 推进/完成)。
          替代了旧的整屏点击拦截层(那会让用户点哪都是关闭、永远点不到高亮目标)。 */}
      {(() => {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const holeBottom = ringBox.top + ringBox.height;
        const holeRight = ringBox.left + ringBox.width;
        const panels = [
          { left: 0, top: 0, width: vw, height: Math.max(0, ringBox.top) },
          { left: 0, top: holeBottom, width: vw, height: Math.max(0, vh - holeBottom) },
          { left: 0, top: ringBox.top, width: Math.max(0, ringBox.left), height: ringBox.height },
          { left: holeRight, top: ringBox.top, width: Math.max(0, vw - holeRight), height: ringBox.height },
        ];
        return panels.map((p, i) => (
          <div
            key={i}
            aria-label="关闭高亮引导"
            onClick={closeWithFlyBack}
            style={{ position: 'fixed', zIndex: 9997, cursor: 'pointer', background: 'transparent', ...p }}
          />
        ));
      })()}
      <div style={ringStyle} />
      {bubbleTitle && (
        <div
          ref={bubbleRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: bubbleLeft,
            top: bubbleTop,
            width: 360,
            maxHeight: maxBubbleH,
            // border-box:让 maxHeight 夹的是「含 padding/border 的整框」,与下面用 estBubbleH(实测
            // offsetHeight,本就是 border-box)做的视口夹取定位口径一致;否则 content-box 下 padding
            // 会额外撑高 ~28px,触顶时底部按钮仍可能被挤出屏幕(Codex P2)。
            boxSizing: 'border-box',
            display: 'flex',
            flexDirection: 'column',
            padding: '12px 14px 14px',
            borderRadius: 14,
            background: 'linear-gradient(180deg, rgba(26,26,34,0.98), rgba(15,16,20,0.98))',
            border: '1px solid rgba(129,140,248,0.35)',
            boxShadow: '0 20px 50px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.04)',
            zIndex: 9999,
            animation: 'spotlightBubbleIn 240ms cubic-bezier(.2,.8,.2,1)',
            color: 'rgba(255,255,255,0.92)',
            overflow: 'hidden',
          }}
        >
          <button
            type="button"
            onClick={closeWithFlyBack}
            title="关闭"
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              border: 'none',
              background: 'transparent',
              color: 'rgba(255,255,255,0.45)',
              cursor: 'pointer',
              padding: 4,
              display: 'inline-flex',
            }}
          >
            <X size={12} />
          </button>
          <div
            style={{
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 13,
              fontWeight: 600,
              color: '#c4b5fd',
              marginBottom: bubbleBody ? 4 : 8,
              paddingRight: 20,
            }}
          >
            <Sparkles size={12} />
            {bubbleTitle}
          </div>
          {/* 中段可滚区:进度+步骤清单+正文。flex-1 + min-h-0 + 内部滚动,把底部按钮行(shrink-0)
              永远挤在卡片内、卡片又被夹在视口内 → 「下一步 / 完成」任何情况下都点得到。 */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', margin: '0 -2px', padding: '0 2px' }}>
          {/* 任务式进度 + 步骤清单(多步教程):像做任务一样,有进度、有步骤,一个个打勾完成 */}
          {steps && steps.length > 1 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
                <span>任务进度</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{stepIndex + 1} / {steps.length}</span>
              </div>
              <div style={{ height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginBottom: 8 }}>
                <div style={{ height: '100%', width: `${((stepIndex + 1) / steps.length) * 100}%`, background: 'linear-gradient(90deg,#818cf8,#a78bfa)', transition: 'width 260ms cubic-bezier(.2,.8,.2,1)' }} />
              </div>
              <div style={{ maxHeight: 128, overflowY: 'auto', overscrollBehavior: 'contain', margin: '0 -2px', padding: '0 2px' }}>
                {steps.map((s, i) => {
                  const done = i < stepIndex;
                  const cur = i === stepIndex;
                  return (
                    <div key={i} ref={cur ? curStepRef : undefined} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: '3px 0', opacity: cur ? 1 : done ? 0.75 : 0.45 }}>
                      <span style={{ marginTop: 1, flexShrink: 0, display: 'inline-flex', color: done ? '#34d399' : cur ? '#c4b5fd' : 'rgba(255,255,255,0.3)' }}>
                        {done ? <Check size={13} strokeWidth={2.6} /> : cur ? <CircleDot size={13} /> : <Circle size={13} />}
                      </span>
                      <span style={{ fontSize: 11.5, lineHeight: 1.4, color: cur ? '#e9d5ff' : 'rgba(255,255,255,0.72)', fontWeight: cur ? 600 : 400, textDecoration: done ? 'line-through' : 'none' }}>
                        {s.title}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {bubbleBody && (
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.55,
                color: 'rgba(255,255,255,0.7)',
                marginBottom: 10,
                whiteSpace: 'pre-wrap',
              }}
            >
              {bubbleBody}
            </div>
          )}
          </div>
          <div
            style={{
              flexShrink: 0,
              marginTop: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            {/* 「我已学会」:多步教程提供一键退出口。觉得每天弹窗烦的用户点这里即标记学会,
                该页不再自动开讲(markLearned),并播飞回动画提示入口位置。仅多步教程显示
                (单步/零步的「知道了」本身就是确认,无需再加)。 */}
            {steps && steps.length > 0 && payload?.id && (
              <button
                type="button"
                onClick={handleLearnedClose}
                title="我已学会,该页不再自动弹出(可从右上角入口重看)"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '5px 10px',
                  border: 'none',
                  borderRadius: 999,
                  background: 'rgba(52,211,153,0.12)',
                  color: 'rgba(52,211,153,0.95)',
                  cursor: 'pointer',
                }}
              >
                <GraduationCap size={12} strokeWidth={2.4} />
                我已学会
              </button>
            )}
            {/* 多步教程的进度在上方任务进度条展示;单步/零步无需「步骤 N/M」计数(1/1、1/0 都无意义,Bugbot)。 */}
            <div style={{ flex: 1 }} />
            {steps && !isLastStep && (
              <button
                type="button"
                onClick={() => goNext()}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '5px 10px',
                  border: '1px solid rgba(129,140,248,0.4)',
                  borderRadius: 999,
                  background: 'rgba(129,140,248,0.15)',
                  color: '#c4b5fd',
                  cursor: 'pointer',
                }}
              >
                下一步
                <ChevronRight size={12} />
              </button>
            )}
            {(!steps || isLastStep) && (
              <button
                type="button"
                onClick={(e) => {
                  // 多步 Tour 走到最后:撒花 + markLearned + 飞回 pill 动画(completeTour 统一处理)。
                  // 单步/零步教程没有 steps,completeTour 内部跳过 markLearned,只关闭引导。
                  const btn = e.currentTarget.getBoundingClientRect();
                  completeTour(btn.left + btn.width / 2, btn.top + btn.height / 2);
                }}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '5px 10px',
                  border: 'none',
                  borderRadius: 999,
                  background: 'rgba(255,255,255,0.08)',
                  color: 'rgba(255,255,255,0.8)',
                  cursor: 'pointer',
                }}
              >
                {steps && steps.length > 0 ? '完成 🎉' : '知道了'}
              </button>
            )}
          </div>
        </div>
      )}
      <style>{`
        @keyframes spotlightPulse {
          0%   { box-shadow: 0 0 0 2px rgba(129,140,248,0.9), 0 0 0 9999px rgba(0,0,0,0.55), 0 0 20px 4px rgba(129,140,248,0.5); }
          50%  { box-shadow: 0 0 0 3px rgba(167,139,250,1),  0 0 0 9999px rgba(0,0,0,0.55), 0 0 40px 10px rgba(167,139,250,0.75); }
          100% { box-shadow: 0 0 0 2px rgba(129,140,248,0.9), 0 0 0 9999px rgba(0,0,0,0.55), 0 0 20px 4px rgba(129,140,248,0.5); }
        }
        @keyframes spotlightBubbleIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );

  return createPortal(overlay, document.body);
}
