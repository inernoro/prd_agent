/*
 * 界面尺度控制器（2026-09-08）。
 *
 * 整站尺寸全部用 rem，所以「多大」只有一个杠杆：根字号。这里把它做成三档，
 * 落到 <html data-ui-scale>，CSS 据此设 font-size（默认 85%，见 index.css）。
 * 存 localStorage；index.html 的预加载脚本在首帧前先落一次，避免闪一下。
 * 与 theme.ts 同构：applyUiScale 是唯一落地路径，内含同页广播。
 */
import { useCallback, useEffect, useState } from 'react';

export type UiScale = '80' | '85' | '100';
export const UI_SCALE_STORAGE_KEY = 'cds_ui_scale';
export const DEFAULT_UI_SCALE: UiScale = '85';

export const UI_SCALE_PRESETS: ReadonlyArray<{ value: UiScale; label: string; hint: string }> = [
  { value: '80', label: '紧凑', hint: '同屏更多内容，正文约 11 像素' },
  { value: '85', label: '标准', hint: '默认档，正文约 12 像素' },
  { value: '100', label: '宽松', hint: '浏览器原始尺寸，正文 14 像素' },
];

export function isUiScale(value: unknown): value is UiScale {
  return value === '80' || value === '85' || value === '100';
}

export function readStoredUiScale(): UiScale {
  try {
    const v = localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if (isUiScale(v)) return v;
  } catch {
    /* private mode */
  }
  return DEFAULT_UI_SCALE;
}

type Listener = (scale: UiScale) => void;
const listeners = new Set<Listener>();

export function applyUiScale(scale: UiScale): void {
  const root = document.documentElement;
  if (scale === DEFAULT_UI_SCALE) delete root.dataset.uiScale;
  else root.dataset.uiScale = scale;
  try {
    localStorage.setItem(UI_SCALE_STORAGE_KEY, scale);
  } catch {
    /* ignore */
  }
  listeners.forEach((listener) => listener(scale));
}

export function useUiScale(): { scale: UiScale; setScale: (next: UiScale) => void } {
  const [scale, setScaleState] = useState<UiScale>(() => readStoredUiScale());

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === UI_SCALE_STORAGE_KEY && isUiScale(event.newValue)) setScaleState(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    const onBroadcast: Listener = (next) => setScaleState(next);
    listeners.add(onBroadcast);
    return () => { listeners.delete(onBroadcast); };
  }, []);

  useEffect(() => {
    applyUiScale(scale);
  }, [scale]);

  const setScale = useCallback((next: UiScale) => {
    applyUiScale(next);
    setScaleState(next);
  }, []);

  return { scale, setScale };
}
