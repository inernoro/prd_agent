import { Button } from '@/components/ui/button';
import type { AcceptanceView } from '@/lib/acceptance-api';

export const ACCEPTANCE_LAYOUT_CLASS = 'flex h-full min-h-0 flex-col gap-3';

export const ACCEPTANCE_TABS: Array<{ id: AcceptanceView; label: string }> = [
  { id: 'templates', label: '测试清单' }, { id: 'tasks', label: '执行任务' }, { id: 'matrix', label: '历史矩阵' }, { id: 'reports', label: '验收报告' },
];

/** 代码未就绪时保留相同导航槽，只展示当前视图，不接受未接线的操作。 */
export function AcceptanceNavigation({ view, onChange }: { view: AcceptanceView; onChange?: (view: AcceptanceView) => void }): JSX.Element {
  return <nav className="flex shrink-0 flex-wrap gap-1 border-b border-border pb-2" aria-label="验收中心导航">{ACCEPTANCE_TABS.map((tab) => <Button key={tab.id} size="sm" variant={view === tab.id ? 'secondary' : 'ghost'} aria-current={view === tab.id ? 'page' : undefined} disabled={!onChange} onClick={() => onChange?.(tab.id)}>{tab.label}</Button>)}</nav>;
}
