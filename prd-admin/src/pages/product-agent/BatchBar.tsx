/**
 * 产品管理智能体 — 批量操作条（需求/功能列表多选后出现，P1）。
 *
 * 支持批量：指派处理人 / 改分级 / 删除。作用于已勾选的对象，完成后回调刷新。
 */
import { useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import { UserSearchSelect } from '@/components/UserSearchSelect';
import { batchUpdateItems } from '@/services/real/productAgent';
import { ITEM_GRADE_LABEL } from './types';
import type { ItemGrade } from './types';

const GRADES: ItemGrade[] = ['p0', 'p1', 'p2', 'p3'];

export function BatchBar({
  entityType,
  ids,
  onDone,
  onClear,
}: {
  entityType: 'requirement' | 'feature';
  ids: string[];
  onDone: () => void | Promise<void>;
  onClear: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async (op: 'delete' | 'assign' | 'grade', extra?: { assigneeId?: string; grade?: string }) => {
    if (ids.length === 0) return;
    if (op === 'delete' && !window.confirm(`确认删除选中的 ${ids.length} 项？`)) return;
    setBusy(true);
    const res = await batchUpdateItems({ entityType, ids, op, ...extra });
    setBusy(false);
    if (res.success) {
      onClear();
      await onDone();
    }
  };

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 flex-wrap rounded-lg border border-cyan-500/30 bg-cyan-500/[0.08] px-3 py-2">
      <span className="text-xs text-cyan-100">已选 {ids.length} 项</span>
      {busy && <MapSpinner size={14} />}
      <div className="w-px h-5 bg-white/15" />
      <span className="text-[11px] text-white/50">指派</span>
      <div className="w-40">
        <UserSearchSelect value="" onChange={(uid) => uid && run('assign', { assigneeId: uid })} placeholder="选处理人" />
      </div>
      {entityType === 'requirement' && (
        <>
          <div className="w-px h-5 bg-white/15" />
          <span className="text-[11px] text-white/50">分级</span>
          {GRADES.map((g) => (
            <button
              key={g}
              disabled={busy}
              onClick={() => run('grade', { grade: g })}
              className="px-2 py-1 rounded-md text-xs border text-white/60 border-white/10 hover:bg-white/10 disabled:opacity-50"
            >
              {ITEM_GRADE_LABEL[g]}
            </button>
          ))}
        </>
      )}
      <div className="w-px h-5 bg-white/15" />
      <button
        disabled={busy}
        onClick={() => run('delete')}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-300/80 border border-red-500/30 hover:bg-red-500/10 disabled:opacity-50"
      >
        <Trash2 size={12} /> 删除
      </button>
      <button onClick={onClear} className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/50 hover:text-white hover:bg-white/5">
        <X size={12} /> 取消
      </button>
    </div>
  );
}
