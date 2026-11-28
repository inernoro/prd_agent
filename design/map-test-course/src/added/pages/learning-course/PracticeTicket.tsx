import { useState } from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { Act } from './primitives';
import { SKILL_REGISTRY } from './registry';
import type { PracticeSummary } from './types';

const STATUS: Record<PracticeSummary['status'], string> = { todo: '未开始', doing: '进行中', done: '已完成' };

/* 练习：三选一，默认选中本课配套的那个。 */
export function PracticeTicket({ practices, suggestedId, onStart }: { practices: PracticeSummary[]; suggestedId?: string; onStart: (p: PracticeSummary) => void }) {
  const [pick, setPick] = useState(suggestedId ?? practices[0]?.id);
  const chosen = practices.find(p => p.id === pick) ?? practices[0];
  if (!chosen) return null;
  return (
    <section className="lc-panel shrink-0" data-tour-id="course-practice-cta" aria-label="选一个练习">
      <div className="lc-side-head"><span className="t-strong">动手练习</span><span className="t-meta t-mute">选一个，约 10 分钟</span></div>
      <div className="px-2 pb-2" role="radiogroup">
        {practices.map(p => (
          <button key={p.id} type="button" role="radio" data-pick={p.id} aria-checked={p.id === chosen.id} className="lc-pick" data-active={p.id === chosen.id} data-lc="practice-card" data-practice={p.id} data-status={p.status} onClick={() => setPick(p.id)}>
            <span className="lc-pick-dot" />
            <span className="min-w-0">
              <span className="block truncate">{p.title}</span>
              <span className="block t-meta t-mute">{SKILL_REGISTRY[p.skill].label} · {STATUS[p.status]}{p.id === suggestedId ? ' · 本课配套' : ''}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="px-4 pb-4">
        <Act tone="primary" className="w-full" onClick={() => onStart(chosen)} data-lc="start-practice">
          {chosen.status === 'doing' ? <><RotateCcw size={15} />接着做</> : chosen.status === 'done' ? <><RotateCcw size={15} />再做一遍</> : <>开始练习<ArrowRight size={15} /></>}
        </Act>
      </div>
    </section>
  );
}
