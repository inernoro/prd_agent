import { ButtonHTMLAttributes, ReactNode } from 'react';
import './ClickMeButton.css';

export type ClickMeEffect = 'spin' | 'wipe' | 'flicker' | 'wave' | 'throb' | 'pulse';

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  children: ReactNode;
  effect?: ClickMeEffect;
  nudge?: boolean;
};

export default function ClickMeButton({
  children,
  effect = 'flicker',
  nudge = true,
  className,
  ...props
}: Props) {
  return (
    <button
      {...props}
      data-effect={effect}
      data-nudge={nudge ? '1' : '0'}
      className={[
        // 保持与原按钮一致的布局尺寸（主要由外部 className 控制）
        'prd-clickmeBtn',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="prd-clickmeLabel">{children}</span>
      <span className="prd-clickmeShimmer" aria-hidden="true" />
    </button>
  );
}
