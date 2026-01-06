import { useEffect, useState } from 'react';

export type ThemeFlipDirection = 'to-dark' | 'to-light';

export default function ThemeFlipTransition(props: {
  active: boolean;
  direction: ThemeFlipDirection;
  /**
   * 过渡总时长（ms）：建议与 CSS 动画时长一致
   */
  durationMs?: number;
  /**
   * 中点触发（ms）：用于在遮罩“覆盖到位”时切换主题
   */
  switchAtMs?: number;
  onSwitch?: () => void;
  onDone?: () => void;
}) {
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

    let t1 = window.setTimeout(() => {
      setSwitched(true);
      onSwitch?.();
    }, Math.max(0, switchAtMs));

    let t2 = window.setTimeout(() => {
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
      className={`prd-theme-flip ${direction === 'to-dark' ? 'is-to-dark' : 'is-to-light'} ${switched ? 'is-switched' : ''}`}
      aria-hidden="true"
    >
      <div className="prd-theme-flip__veil" />
      <div className="prd-theme-flip__line" />
      <div className="prd-theme-flip__glow" />
    </div>
  );
}


