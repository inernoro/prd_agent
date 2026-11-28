import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Button } from '@/components/design/Button';

/* 基础部件。动作按钮以 design/Button 为载体（框架规则 R-05），外观由 .lc-act 统一。 */
export function Act({ tone = 'secondary', className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'secondary' | 'ghost'; children: ReactNode }) {
  return <Button variant={tone} className={`lc-act ${className}`} {...rest}>{children}</Button>;
}

export function Kicker({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`t-meta t-mute ${className}`}>{children}</div>;
}

/* 等待时显示页面形状的占位 */
export function SheetSkeleton({ label }: { label: string }) {
  return (
    <div className="lc-root h-full min-h-0 flex flex-col gap-4" aria-busy="true" aria-label={label}>
      <div className="lc-panel p-6 flex flex-col gap-4"><div className="lc-skel" style={{ width: 280, height: 28 }} /><div className="lc-skel" style={{ height: 36 }} /></div>
      <div className="lc-desk flex-1">
        <div className="lc-panel p-6 flex flex-col gap-4"><div className="lc-skel" style={{ height: 24, width: '40%' }} /><div className="lc-skel flex-1" style={{ minHeight: 240 }} /></div>
        <div className="lc-panel p-4 flex flex-col gap-2 max-md:hidden">{[0, 1, 2, 3].map(i => <div key={i} className="lc-skel" style={{ height: 40 }} />)}</div>
      </div>
      <div className="t-meta t-mute">{label}</div>
    </div>
  );
}

export function Busy() {
  return <span className="lc-dotpulse" aria-hidden />;
}
