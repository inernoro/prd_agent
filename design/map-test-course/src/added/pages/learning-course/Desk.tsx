import type { ReactNode } from 'react';
import { Kicker } from './primitives';

/* 书桌：左边主舞台（材料本身），右边伴读栏（跟着材料变的导航 + 本课要点 + 练习票）。 */
export function Desk({ head, stage, companionTitle, companionHint, companion, keyPoints, ticket, ready }: {
  head: ReactNode; stage: ReactNode; companionTitle: string; companionHint?: string; companion: ReactNode; keyPoints: string[]; ticket: ReactNode; ready: string;
}) {
  return (
    <div className="lc-desk flex-1" data-lc-ready={ready}>
      <section className="lc-panel lc-sheet">
        {head}
        <div className="lc-stage">{stage}</div>
      </section>
      <aside className="lc-side">
        <div className="lc-panel lc-side-panel">
          <div className="px-3.5 pt-3 pb-2" style={{ borderBottom: '1px solid var(--lc-line)' }}>
            <Kicker>本课要点</Kicker>
            <ol className="mt-1.5 flex flex-col gap-1">
              {keyPoints.map((k, i) => (
                <li key={k} className="grid gap-2 text-[12.5px] leading-relaxed lc-ink2" style={{ gridTemplateColumns: '18px 1fr' }}>
                  <span className="lc-mono text-[11px]" style={{ color: 'var(--lc-hi)', paddingTop: 2 }}>{i + 1}</span>{k}
                </li>
              ))}
            </ol>
          </div>
          <div className="lc-side-head"><span className="text-[13px] font-semibold">{companionTitle}</span>{companionHint && <span className="text-[11.5px] lc-ink3">{companionHint}</span>}</div>
          <div className="lc-scroll flex-1 px-2 pb-2 relative">{companion}</div>
        </div>
        {ticket}
      </aside>
    </div>
  );
}
