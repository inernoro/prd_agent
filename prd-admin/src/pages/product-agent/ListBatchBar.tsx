/**
 * 产品管理 — 列表批量操作条（多选后出现：导出 / 删除 / 指派等）。
 * 需求与功能走后端 batch API；其余类型循环单条 API。
 */
import { useState } from 'react';
import { Download, Trash2, X } from 'lucide-react';
import { MapSpinner } from '@/components/ui/VideoLoader';
import {
  batchUpdateItems,
  deleteProduct,
  deleteCustomer,
  untraceDefect,
} from '@/services/real/productAgent';
import { BatchBar } from './BatchBar';

export type ListBatchEntityType = 'requirement' | 'feature' | 'defect' | 'product' | 'customer';

const DELETE_LABEL: Record<ListBatchEntityType, string> = {
  requirement: '删除',
  feature: '删除',
  defect: '取消追溯',
  product: '删除',
  customer: '删除',
};

const DELETE_CONFIRM: Record<ListBatchEntityType, (n: number) => string> = {
  requirement: (n) => `确认删除选中的 ${n} 条需求？`,
  feature: (n) => `确认删除选中的 ${n} 条功能？`,
  defect: (n) => `确认取消追溯选中的 ${n} 条缺陷？`,
  product: (n) => `确认删除选中的 ${n} 个产品？关联数据将不可访问。`,
  customer: (n) => `确认删除选中的 ${n} 个客户？`,
};

async function runBatchDelete(entityType: ListBatchEntityType, ids: string[]) {
  if (entityType === 'requirement' || entityType === 'feature') {
    return batchUpdateItems({ entityType, ids, op: 'delete' });
  }
  for (const id of ids) {
    if (entityType === 'product') {
      const res = await deleteProduct(id);
      if (!res.success) return res;
    } else if (entityType === 'customer') {
      const res = await deleteCustomer(id);
      if (!res.success) return res;
    } else if (entityType === 'defect') {
      const res = await untraceDefect(id);
      if (!res.success) return res;
    }
  }
  return { success: true as const, data: { affected: ids.length } };
}

export function ListBatchBar({
  entityType,
  ids,
  onDone,
  onClear,
  onExport,
  exportLabel = '导出选中',
}: {
  entityType: ListBatchEntityType;
  ids: string[];
  onDone: () => void | Promise<void>;
  onClear: () => void;
  onExport?: () => void;
  exportLabel?: string;
}) {
  if (ids.length === 0) return null;

  if (entityType === 'requirement' || entityType === 'feature') {
    return (
      <div className="flex flex-col gap-2">
        <BatchBar entityType={entityType} ids={ids} onDone={onDone} onClear={onClear} />
        {onExport && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onExport}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/60 border border-white/10 hover:bg-white/5"
            >
              <Download size={12} /> {exportLabel}
            </button>
          </div>
        )}
      </div>
    );
  }

  return <GenericListBatchBar entityType={entityType} ids={ids} onDone={onDone} onClear={onClear} onExport={onExport} exportLabel={exportLabel} />;
}

function GenericListBatchBar({
  entityType,
  ids,
  onDone,
  onClear,
  onExport,
  exportLabel,
}: {
  entityType: Exclude<ListBatchEntityType, 'requirement' | 'feature'>;
  ids: string[];
  onDone: () => void | Promise<void>;
  onClear: () => void;
  onExport?: () => void;
  exportLabel: string;
}) {
  const [busy, setBusy] = useState(false);

  const runDelete = async () => {
    if (!window.confirm(DELETE_CONFIRM[entityType](ids.length))) return;
    setBusy(true);
    const res = await runBatchDelete(entityType, ids);
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
      {onExport && (
        <>
          <div className="w-px h-5 bg-white/15" />
          <button
            type="button"
            disabled={busy}
            onClick={onExport}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/70 border border-white/10 hover:bg-white/10 disabled:opacity-50"
          >
            <Download size={12} /> {exportLabel}
          </button>
        </>
      )}
      <div className="w-px h-5 bg-white/15" />
      <button
        type="button"
        disabled={busy}
        onClick={() => void runDelete()}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-300/80 border border-red-500/30 hover:bg-red-500/10 disabled:opacity-50"
      >
        <Trash2 size={12} /> {DELETE_LABEL[entityType]}
      </button>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/50 hover:text-white hover:bg-white/5"
      >
        <X size={12} /> 取消
      </button>
    </div>
  );
}

/** 仅导出 / 导出+自定义删除（版本流程、知识库等无统一 entityType 的列表） */
export function ExportOnlyBatchBar({
  ids,
  onClear,
  onExport,
  onDelete,
  deleteLabel = '删除选中',
  exportLabel = '导出选中',
}: {
  ids: string[];
  onClear: () => void;
  onExport: () => void;
  onDelete?: () => void | Promise<void>;
  deleteLabel?: string;
  exportLabel?: string;
}) {
  if (ids.length === 0) return null;
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 flex-wrap rounded-lg border border-cyan-500/30 bg-cyan-500/[0.08] px-3 py-2">
      <span className="text-xs text-cyan-100">已选 {ids.length} 项</span>
      <button
        type="button"
        onClick={onExport}
        className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/70 border border-white/10 hover:bg-white/10"
      >
        <Download size={12} /> {exportLabel}
      </button>
      {onDelete && (
        <>
          <div className="w-px h-5 bg-white/15" />
          <button
            type="button"
            onClick={() => void onDelete()}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-red-300/80 border border-red-500/30 hover:bg-red-500/10"
          >
            <Trash2 size={12} /> {deleteLabel}
          </button>
        </>
      )}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/50 hover:text-white hover:bg-white/5"
      >
        <X size={12} /> 取消
      </button>
    </div>
  );
}
