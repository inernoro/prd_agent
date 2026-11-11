import { Button } from '@/components/design/Button';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { arenaUnavailableSlots } from '@/lib/arenaModelReferences';
import type { ArenaSlot } from '@/services/contracts/arena';

/** 对战前只展示状态与数量，不能提前揭晓具体模型身份。 */
export function ArenaLineupNotice({ slots, error, checking, onRepair, onRefresh }: {
  slots: ArenaSlot[];
  error?: string | null;
  checking?: boolean;
  onRepair: () => void;
  onRefresh: () => void;
}) {
  const unavailable = arenaUnavailableSlots(slots).length;
  if (!unavailable && !error && !checking) return null;
  return <div role="status" className="flex items-center justify-between gap-3 px-5 py-2 text-xs" style={{ color: 'var(--text-primary)', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-subtle)' }}>
    <span>{checking ? <span className="inline-flex items-center gap-2"><MapSpinner size={14} />正在核对阵容</span> : error ? '阵容状态未确认，请重新读取后开始。' : `${unavailable} 个模型引用需要修复，当前无法开始对战。`}</span>
    <span className="flex gap-2 shrink-0"><Button size="xs" variant="ghost" disabled={checking} onClick={onRefresh}>重新读取</Button>{unavailable ? <Button size="xs" variant="ghost" disabled={checking} onClick={onRepair}>修复阵容</Button> : null}</span>
  </div>;
}
