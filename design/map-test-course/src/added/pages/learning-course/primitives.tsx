import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Button } from '@/components/design/Button';

/* 检验台的基础部件。动作按钮以 design/Button 为载体（框架规则 R-05），外观由 .lc-act 自定义。 */

export function Act({ tone = 'secondary', className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'primary' | 'secondary' | 'ghost'; children: ReactNode }) {
  return <Button variant={tone} className={`lc-act ${className}`} {...rest}>{children}</Button>;
}

export function Kicker({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`lc-kicker ${className}`}>{children}</div>;
}

/* 等待时显示产物形状的骨架，而不是转圈 */
export function SheetSkeleton({ label }: { label: string }) {
  return (
    <div className="lc-root h-full min-h-0 flex flex-col gap-3" aria-busy="true" aria-label={label}>
      <div className="lc-panel p-5 flex flex-col gap-4">
        <div className="lc-skel" style={{ width: 260, height: 26 }} />
        <div className="flex gap-6">{[0, 1, 2, 3, 4].map(i => <div key={i} className="lc-skel" style={{ width: 42, height: 42, borderRadius: 99 }} />)}</div>
      </div>
      <div className="lc-desk flex-1">
        <div className="lc-panel p-5 flex flex-col gap-3"><div className="lc-skel" style={{ height: 30, width: '40%' }} /><div className="lc-skel flex-1" style={{ minHeight: 240 }} /></div>
        <div className="lc-panel p-4 flex flex-col gap-2 max-md:hidden">{[0, 1, 2, 3, 4].map(i => <div key={i} className="lc-skel" style={{ height: 40 }} />)}</div>
      </div>
      <div className="lc-kicker">{label}</div>
    </div>
  );
}

export function Busy() {
  return <span className="lc-dotpulse" aria-hidden />;
}
