import { useEffect, useState } from 'react';

export type ThemeFadeDirection = 'to-dark' | 'to-light';

export default function ThemeFadeTransition(props: {
  active: boolean;
  direction: ThemeFadeDirection;
  /**
   * 总时长（ms）
   */
  durationMs?: number;
  /**
   * 切换主题的时间点（ms）
   */
  switchAtMs?: number;
  onSwitch?: () => void;
  onDone?: () => void;
}) {
  // 采用“淡入 -> 停留 -> 淡出”，并把切主题放在停留区间中间，
  // 确保切换发生在遮罩完全覆盖时，避免白/黑/白闪烁。
  const { active, direction, durationMs = 520, switchAtMs = 260, onSwitch, onDone } = props;
  const [mounted, setMounted] = useState(false);
  const [switched, setSwitched] = useState(false);

  useEffect(() => {
    if (!active) {
      setMounted(false);
      setSwitched(false);
      return;
    }

    setMounted(true);
    setSwitched(false);

    const t1 = window.setTimeout(() => {
      setSwitched(true);
      onSwitch?.();
    }, Math.max(0, switchAtMs));

    const t2 = window.setTimeout(() => {
      setMounted(false);
      setSwitched(false);
      onDone?.();
    }, Math.max(0, durationMs));

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [active, durationMs, switchAtMs, onDone, onSwitch]);

  if (!mounted) return null;

  return (
    <div
      className={`prd-theme-fade ${direction === 'to-dark' ? 'is-to-dark' : 'is-to-light'} ${switched ? 'is-switched' : ''}`}
      aria-hidden="true"
    />
  );
}


