import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { X, ChevronRight, Sparkles, Check, Circle, CircleDot } from 'lucide-react';
import {
  SPOTLIGHT_ACTION_KEY,
  SPOTLIGHT_TARGET_KEY,
  SPOTLIGHT_PAYLOAD_UPDATED_EVENT,
  type SpotlightActionPayload,
} from './TipsRotator';
import type { DailyTipAutoAction } from '@/services/real/dailyTips';
import { useDailyTipsStore } from '@/stores/dailyTipsStore';
import { fireConfetti } from './fireConfetti';

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

  // ---- 启动 + 同路由事件:读 sessionStorage 解析 payload ----
  // 初次 mount 读一次;TipsRotator 写完 payload 会广播 SPOTLIGHT_PAYLOAD_UPDATED_EVENT,
  // 解决「同页面点 CTA 时 React Router 不 re-mount」导致 overlay 不启动的 bug。
  useEffect(() => {
    const readAndStart = () => {
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
  }, []);

  // ---- 当前 step 的 selector(Steps 优先,否则用 payload.selector)----
  const steps = payload?.autoAction?.steps ?? null;
  const currentSelector =
    steps && steps[stepIndex] ? steps[stepIndex].selector : payload?.selector ?? null;

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

    // 单步模式:无 step + 无 autoClick 时,5s 自动淡出(保持旧行为)
    let fadeTimer: number | null = null;
    if (!hasSteps && !autoAction?.autoClick) {
      fadeTimer = window.setTimeout(() => setDismissed(true), 5000);
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
        setDismissed(true);
      }, delay);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDismissed(true);
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
  }, [rect, currentSelector, payload, dismissed]);

  // 渲染后实测气泡高度,供下面的定位逻辑把整张卡片（含底部按钮行）夹在视口内。
  // 只在高度真正变化(>1px)时 setState,守住「setState → 重渲染 → 再测」不成死循环;
  // deps 覆盖所有会改变卡片高度的输入(切步 / 换 payload / 重定位 / 失败卡 / 关闭)。
  useLayoutEffect(() => {
    const h = bubbleRef.current?.offsetHeight ?? null;
    if (h != null && (bubbleHeight == null || Math.abs(h - bubbleHeight) > 1)) {
      setBubbleHeight(h);
    }
  }, [rect, stepIndex, payload, seekTimedOut, dismissed, bubbleHeight]);

  if (dismissed || !payload) return null;

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
            onClick={() => setDismissed(true)}
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
      <div
        aria-label="关闭高亮引导"
        onClick={() => setDismissed(true)}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9997,
          cursor: 'pointer',
          background: 'transparent',
        }}
      />
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
            onClick={() => setDismissed(true)}
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
            {/* 多步教程的进度在上方任务进度条展示;单步/零步无需「步骤 N/M」计数(1/1、1/0 都无意义,Bugbot)。 */}
            <div style={{ flex: 1 }} />
            {steps && !isLastStep && (
              <button
                type="button"
                onClick={() => {
                  // 下一步如果配置了 navigateTo,先切路由,新页面元素会在 poll 里被找到
                  const nextStep = payload.autoAction?.steps?.[stepIndex + 1];
                  // 先把当前 step 的元素「点」一下,再前进:解决「下一步后面板消失」的 bug
                  // —— 很多步骤的下一个 selector 依赖当前这步被点击后才出现
                  // (如 defect-full-flow:点「+ 提交缺陷」后 description 才存在)。
                  // 但只在「下一步元素当前还不存在」时才自动点(说明确实需要这次点击来揭示它);
                  // 若下一步元素已在 DOM(如网页托管下一步是同排的另一个按钮),就别点——
                  // 否则点了像「分享统计」这种按钮会弹出 z-10000 抽屉挡住整个引导(Codex P2)。
                  //
                  // 关于逗号兜底选择器(如 "[data-tour-id=a], [data-tour-id=b]"):querySelector 取「任一」命中,
                  // 这正是想要的语义 —— 只有「一个候选都不在 DOM」时才算需要揭示去点当前元素;只要常驻兜底在场
                  // (权限/tab/视图门控下 primary 不在、但兜底在),就说明下一步「可展示」,不该强点当前元素
                  // (那些 primary 由 app 状态门控,点当前按钮也揭示不出来,反而可能误开抽屉)。
                  // 约束:别给「靠点击当前步才揭示」的揭示步配逗号兜底的 next selector,否则兜底在场会跳过该点击。
                  const nextNeedsReveal = !nextStep?.navigateTo
                    && (!nextStep?.selector || !document.querySelector(nextStep.selector));
                  try {
                    if (currentSelector && nextNeedsReveal) {
                      const el = document.querySelector(currentSelector);
                      if (
                        el instanceof HTMLButtonElement ||
                        el instanceof HTMLAnchorElement ||
                        (el instanceof HTMLElement && el.getAttribute('role') === 'button')
                      ) {
                        el.click();
                      }
                    }
                  } catch {
                    /* noop */
                  }
                  if (nextStep?.navigateTo) navigate(nextStep.navigateTo);
                  // 不清 rect,保留旧光圈直到下一步元素找到再更新位置,
                  // 避免「点下一步面板消失、等 3s 再出现」的闪烁
                  setStepIndex((i) => i + 1);
                }}
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
                  // 多步 Tour 走到最后:撒花庆祝 + 标记「已学会」(写 LearnedTips 含 Version)
                  // 与 dismiss-forever 不同 — 管理员升级 tip.Version 后用户会再次看到。
                  // 单步模式也走同样逻辑,但效果只是"关闭引导"
                  if (steps && steps.length > 0) {
                    // 从按钮 DOM 取中心坐标,让撒花从用户刚点的按钮位置喷出
                    const btn = e.currentTarget.getBoundingClientRect();
                    fireConfetti({
                      originX: btn.left + btn.width / 2,
                      originY: btn.top + btn.height / 2,
                    });
                    if (payload.id) {
                      // 走 store action:服务端写 LearnedTips + 本地立即移除,
                      // 抽屉里马上不再显示这条;seed-* 后端也支持(查 BuildDefaultTips)
                      void useDailyTipsStore.getState().markLearned(payload.id);
                    }
                  }
                  setDismissed(true);
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
