import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronRight, Sparkles } from 'lucide-react';
import {
  SPOTLIGHT_ACTION_KEY,
  SPOTLIGHT_TARGET_KEY,
  SPOTLIGHT_PAYLOAD_UPDATED_EVENT,
  type SpotlightActionPayload,
} from './TipsRotator';
import type { DailyTipAutoAction } from '@/services/real/dailyTips';
import { dismissTipForever } from '@/services/real/dailyTips';
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
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [payload, setPayload] = useState<SpotlightActionPayload | null>(null);
  const [stepIndex, setStepIndex] = useState<number>(0);
  const [dismissed, setDismissed] = useState(false);
  /** 6 秒还没找到 selector 就置 true,显示「找不到元素」友好卡片 */
  const [seekTimedOut, setSeekTimedOut] = useState(false);
  const autoClickTimerRef = useRef<number | null>(null);

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

  // ---- 找到元素 + scroll + expand + prefill,然后画光圈 ----
  useEffect(() => {
    if (!payload || !currentSelector || dismissed) return;

    let cancelled = false;
    const autoAction: DailyTipAutoAction | null = payload.autoAction ?? null;
    const scroll = (autoAction?.scroll as 'center' | 'top' | 'none' | null) ?? 'center';

    // 1) expand:若有,先点击一次折叠触发器(常见:summary / role=button)
    if (autoAction?.expand) {
      try {
        const trigger = document.querySelector(autoAction.expand);
        if (trigger instanceof HTMLElement) trigger.click();
      } catch {
        /* 选择器无效不阻塞 */
      }
    }

    // 2) prefill:用原生 setter 触发 React onChange
    if (autoAction?.prefill) {
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

    // 3) 轮询等目标元素就绪(Reveal 动效 + 异步加载场景)
    // 性能优化:250ms × 24 = 6s 上限(原 150ms × 50 = 7.5s,减 52% tick 次数)
    // 找不到就 setSeekTimedOut(true) 走友好失败卡片
    setSeekTimedOut(false);
    let attempts = 0;
    const maxAttempts = 24;
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
            el.scrollIntoView({
              behavior: 'smooth',
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
    if (autoAction?.autoClick) {
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

  if (dismissed || !payload) return null;

  // 找不到目标元素 + 超时 → 渲染友好失败卡片(不再静默消失)
  if (!rect && seekTimedOut) {
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

  // 气泡挂在光圈下方;若下方空间不够就放上方
  const PAD = 8;
  const ringBox = {
    left: rect.left - PAD,
    top: rect.top - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };
  const bubbleBelow = ringBox.top + ringBox.height + 12;
  const useAbove = bubbleBelow + 180 > window.innerHeight;
  const bubbleTop = useAbove ? Math.max(16, ringBox.top - 180) : bubbleBelow;
  const bubbleLeft = Math.max(
    16,
    Math.min(window.innerWidth - 340 - 16, ringBox.left + ringBox.width / 2 - 170),
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
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: bubbleLeft,
            top: bubbleTop,
            width: 340,
            padding: '12px 14px 14px',
            borderRadius: 14,
            background: 'linear-gradient(180deg, rgba(26,26,34,0.98), rgba(15,16,20,0.98))',
            border: '1px solid rgba(129,140,248,0.35)',
            boxShadow: '0 20px 50px -20px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.04)',
            zIndex: 9999,
            animation: 'spotlightBubbleIn 240ms cubic-bezier(.2,.8,.2,1)',
            color: 'rgba(255,255,255,0.92)',
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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            {steps && (
              <div
                style={{
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.45)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                步骤 {stepIndex + 1} / {steps.length}
              </div>
            )}
            <div style={{ flex: 1 }} />
            {steps && !isLastStep && (
              <button
                type="button"
                onClick={() => {
                  // 先把当前 step 的元素「点」一下,再前进:解决「下一步后面板消失」的 bug
                  // —— 很多步骤的下一个 selector 依赖当前这步被点击后才出现
                  // (如 defect-full-flow:点「+ 提交缺陷」后 description 才存在)。
                  // 可交互元素(按钮/input)直接 click;不是则跳过,让用户自己操作。
                  try {
                    if (currentSelector) {
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
                onClick={() => {
                  // 多步 Tour 走到最后:撒花庆祝 + 永久 dismiss(用户已学完,不再骚扰)
                  // 单步模式也走同样逻辑,但效果只是"关闭引导"
                  if (steps && steps.length > 0) {
                    fireConfetti();
                    if (payload.id && !payload.id.startsWith('seed-')) {
                      // seed-* 是兜底虚拟 id,后端会忽略;只对真实入库 tip 永久 dismiss
                      void dismissTipForever(payload.id);
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
