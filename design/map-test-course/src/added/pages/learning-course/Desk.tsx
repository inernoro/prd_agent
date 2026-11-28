import type { ReactNode } from 'react';

/* 书桌：左边主舞台（材料本身），右边伴读栏（本课要点 + 跟着材料变的导航）与练习。 */
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
          <div className="lc-side-sec" style={{ borderBottom: '1px solid var(--line-2)' }}>
            <div className="t-strong">本课要点</div>
            <ul className="mt-2 flex flex-col gap-1.5 t-mute" style={{ listStyle: 'disc', paddingLeft: 18 }}>
              {keyPoints.map(k => <li key={k}>{k}</li>)}
            </ul>
          </div>
          <div className="lc-side-head"><span className="t-strong">{companionTitle}</span>{companionHint && <span className="t-meta t-mute">{companionHint}</span>}</div>
          <div className="lc-scroll flex-1 px-2 pb-2 relative">{companion}</div>
        </div>
        {ticket}
      </aside>
    </div>
  );
}
