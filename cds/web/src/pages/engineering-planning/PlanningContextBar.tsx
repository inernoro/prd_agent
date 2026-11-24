/* 工程规划页头第二行的「一句因果」（V1 新增，合并时放进 cds/web/src/pages/engineering-planning/）。
 * 决策主线和债务分支用同一个组件、同一个位置：只显示排第一的原因（根因），其余收进「还有 N 件」。原因由程序从数据算出。 */
import { ChevronDown, CircleAlert, CircleCheck } from 'lucide-react';
import type { Cause } from './planning-timeline-model';

export function PlanningContextBar({ causes, loading, onFocus }: { causes: Cause[]; loading: boolean; onFocus: (key: string) => void }) {
  if (loading) return <p className="ep-cause" data-tone="muted"><span>正在核对到期和关联…</span></p>;
  const [first, ...rest] = causes;
  if (!first) return <p className="ep-cause" data-tone="ok"><CircleCheck aria-hidden /><span>没有逾期、待定或一周内到期的事</span></p>;
  return <div className="ep-cause" data-tone={first.tone}>
    <CircleAlert aria-hidden />
    <button type="button" className="ep-cause-main" onClick={() => onFocus(first.key)} title={first.text}>{first.text}</button>
    {rest.length > 0 && <details className="ep-new ep-cause-more">
      <summary>还有 {rest.length} 件<ChevronDown aria-hidden /></summary>
      <div><ol>{rest.map(cause => <li key={cause.key + cause.text} data-tone={cause.tone}>
        <button type="button" onClick={event => { (event.currentTarget.closest('details') as HTMLDetailsElement).open = false; onFocus(cause.key); }}>{cause.text}</button>
      </li>)}</ol></div>
    </details>}
  </div>;
}
