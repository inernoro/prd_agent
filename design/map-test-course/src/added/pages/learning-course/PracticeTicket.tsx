import { useState } from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { Act, Kicker } from './primitives';
import { SKILL_REGISTRY } from './registry';
import type { PracticeSummary } from './types';

const STATUS: Record<PracticeSummary['status'], string> = { todo: '未开始', doing: '进行中，可续上', done: '已完成' };

/* 练习票：三选一，默认选中和本课配套的那个。撕下票根就是开始练习。 */
export function PracticeTicket({ practices, suggestedId, onStart }: { practices: PracticeSummary[]; suggestedId?: string; onStart: (p: PracticeSummary) => void }) {
  const [pick, setPick] = useState(suggestedId ?? practices[0]?.id);
  const chosen = practices.find(p => p.id === pick) ?? practices[0];
  if (!chosen) return null;
  return (
    <section className="lc-ticket shrink-0" style={{ ['--cut' as string]: 'calc(100% - 70px)' }} data-tour-id="course-practice-cta" aria-label="选一个练习">
      <div className="px-3.5 pt-3 pb-1 flex items-baseline justify-between">
        <Kicker>练一练 · 选一个</Kicker>
        <span className="text-[11px] lc-ink3">约 10 分钟走完一个闭环</span>
      </div>
      <div className="px-1.5 pb-2" role="radiogroup">
        {practices.map(p => {
          const s = SKILL_REGISTRY[p.skill];
          const Icon = s.icon;
          return (
            <button key={p.id} type="button" role="radio" data-pick={p.id} aria-checked={p.id === chosen.id} className="lc-pick" data-active={p.id === chosen.id} onClick={() => setPick(p.id)}>
              <span className="lc-glyph"><Icon size={16} /></span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold truncate">{p.title}</span>
                <span className="block text-[11.5px] lc-ink3">{s.label} · {p.minutes} 分钟 · {STATUS[p.status]}{p.id === suggestedId ? ' · 本课配套' : ''}</span>
              </span>
              <span className="lc-mono text-[11px] lc-ink3">{p.id === chosen.id ? '已选' : ''}</span>
            </button>
          );
        })}
      </div>
      <div className="lc-perf" />
      <div className="p-3">
        <Act tone="primary" className="w-full" onClick={() => onStart(chosen)} data-lc="start-practice">
          {chosen.status === 'doing' ? <><RotateCcw size={15} />接着做</> : chosen.status === 'done' ? <><RotateCcw size={15} />再做一遍</> : <>开始练习<ArrowRight size={15} /></>}
        </Act>
      </div>
    </section>
  );
}
