/**
 * BuildShaChip — Dashboard 顶栏常驻 chip(B'.6)
 *
 * 对应 spec.cds-blue-green-mece-acceptance.md C-6.2 / C-6.3
 * 详见 doc/design.cds-control-data-split.md §4.4
 *
 * 显示形态(由 buildShaChip.logic.ts 计算):
 *   - 正常:    "build: <8位 sha> · <color>"  蓝/青背景
 *   - standby: "standby · <color>"          灰底
 *   - 切换中:   "切换中"                       琥珀
 *   - 漂移(drift): "build: <sha> · <color>" 红底 + 闪烁 1 次 + tooltip 漂移信息
 *   - 离线:    "离线"                          红底
 *
 * 数据走 /api/self-status,30 秒轮询(POLL_INTERVAL_MS)。
 * 点击跳转 /cds-settings#maintenance,drift 时 hash 携带 highlight 标记。
 */

import { useEffect, useRef, useState } from 'react';
import {
  chipBackgroundClass,
  computeChipState,
  POLL_INTERVAL_MS,
  type SelfStatusPayload,
} from './buildShaChip.logic.js';

interface FetchSelfStatus {
  (): Promise<SelfStatusPayload | null>;
}

/** 默认实现:走 /api/self-status,失败返 null。 */
const defaultFetch: FetchSelfStatus = async () => {
  try {
    const res = await fetch('/api/self-status', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as SelfStatusPayload;
  } catch {
    return null;
  }
};

export interface BuildShaChipProps {
  /** 单测注入用 — 默认走 fetch('/api/self-status')。 */
  fetchSelfStatus?: FetchSelfStatus;
  /** 单测注入用 — 跳过 setInterval。 */
  skipPolling?: boolean;
  /** 测试 hook:每次 state 变化通知。 */
  onStateChange?: (state: ReturnType<typeof computeChipState>) => void;
}

export function BuildShaChip({
  fetchSelfStatus = defaultFetch,
  skipPolling = false,
  onStateChange,
}: BuildShaChipProps) {
  const [payload, setPayload] = useState<SelfStatusPayload | null>(null);
  const [hasFetched, setHasFetched] = useState(false);
  const [blinkTick, setBlinkTick] = useState(0);
  const lastModeRef = useRef<string | null>(null);

  // 初次拉 + 30s 轮询
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const p = await fetchSelfStatus();
      if (cancelled) return;
      setPayload(p);
      setHasFetched(true);
    };
    tick();
    if (skipPolling) return () => { cancelled = true; };
    const handle = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [fetchSelfStatus, skipPolling]);

  const state = computeChipState(hasFetched ? payload : payload);
  // 进入 drift 时触发一次 blink 动画。
  useEffect(() => {
    if (state.shouldBlink && lastModeRef.current !== 'drift') {
      setBlinkTick(t => t + 1);
    }
    lastModeRef.current = state.mode;
    onStateChange?.(state);
  }, [state, onStateChange]);

  const handleClick = () => {
    if (typeof window === 'undefined') return;
    if (state.highlightSelfUpdate) {
      window.location.hash = '#maintenance-self-update';
      window.location.assign(state.navigateTo);
    } else {
      window.location.assign(state.navigateTo);
    }
  };

  const className = [
    'inline-flex items-center gap-1.5 px-2 py-0.5 rounded border',
    'text-xs font-mono cursor-pointer select-none',
    chipBackgroundClass(state),
    state.shouldBlink ? `animate-pulse-once-${blinkTick}` : '',
  ].filter(Boolean).join(' ');

  return (
    <button
      type="button"
      data-testid="build-sha-chip"
      data-mode={state.mode}
      data-color={state.color ?? ''}
      title={state.tooltip}
      className={className}
      onClick={handleClick}
    >
      <span aria-hidden="true">●</span>
      <span>{state.label}</span>
    </button>
  );
}

export default BuildShaChip;
