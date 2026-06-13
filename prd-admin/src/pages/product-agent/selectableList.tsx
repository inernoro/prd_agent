/**
 * 产品管理 — 可勾选列表组合层（在 listSelection / ListBatchBar 之上）。
 *
 * 页面侧只需：useOverviewTableSelection + SelectionActionBar + OverviewDataTable/SelectableRow。
 * 禁止在各 tab 重复写 rowIds / exportSelected / 批量条 JSX。
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import {
  useListSelection,
  ListCheckbox,
  ListSelectionCell,
  ListSelectionHeaderCell,
  type TableSelectionProps,
} from './listSelection';
import { ListBatchBar, ExportOnlyBatchBar, type ListBatchEntityType } from './ListBatchBar';
import { downloadListCsv } from './listExport';

export type ListSelectionState = ReturnType<typeof useListSelection>;

/** 从当前列表行派生多选态 + CSV 导出回调 */
export function useOverviewTableSelection<T extends { id: string }>(
  rows: T[],
  exportConfig: {
    filename: string;
    headers: string[];
    mapRow: (row: T) => string[];
  },
) {
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selection = useListSelection(rowIds);
  const exportSelected = useSelectionCsvExport(rows, selection, (r) => r.id, exportConfig);
  return {
    selection,
    exportSelected,
    tableSelection: selection.tableSelection,
  };
}

/** 任意 id 列表的多选 + 导出（成员 userId、知识 entry.id 等） */
export function useSelectableListExport<T>(
  items: T[],
  getId: (item: T) => string,
  exportConfig: {
    filename: string;
    headers: string[];
    mapRow: (item: T) => string[];
  },
) {
  const allIds = useMemo(() => items.map(getId), [items, getId]);
  const selection = useListSelection(allIds);
  const exportSelected = useSelectionCsvExport(items, selection, getId, exportConfig);
  return { selection, exportSelected, tableSelection: selection.tableSelection };
}

export function useSelectionCsvExport<T>(
  items: T[],
  selection: ListSelectionState,
  getId: (item: T) => string,
  config: {
    filename: string;
    headers: string[];
    mapRow: (item: T) => string[];
  },
) {
  const { filename, headers, mapRow } = config;
  return useCallback(() => {
    const picked = items.filter((item) => selection.selected.has(getId(item)));
    downloadListCsv(filename, headers, picked.map(mapRow));
  }, [items, selection.selected, getId, filename, headers, mapRow]);
}

type SelectionActionBarProps = {
  selection: ListSelectionState;
  className?: string;
  exportLabel?: string;
} & (
  | {
      mode: 'entity';
      entityType: ListBatchEntityType;
      onDone: () => void | Promise<void>;
      onExport?: () => void;
    }
  | {
      mode: 'export';
      onExport: () => void;
      onDelete?: () => void | Promise<void>;
      deleteLabel?: string;
    }
);

/** 选中项 > 0 时渲染批量操作条（统一入口，替代各页 copy-paste） */
export function SelectionActionBar(props: SelectionActionBarProps) {
  const { selection, className = 'mb-2', exportLabel } = props;
  if (selection.count === 0) return null;

  if (props.mode === 'entity') {
    return (
      <div className={className}>
        <ListBatchBar
          entityType={props.entityType}
          ids={selection.selectedIds}
          onClear={selection.clear}
          onDone={props.onDone}
          onExport={props.onExport}
          exportLabel={exportLabel}
        />
      </div>
    );
  }

  return (
    <div className={className}>
      <ExportOnlyBatchBar
        ids={selection.selectedIds}
        onClear={selection.clear}
        onExport={props.onExport}
        onDelete={props.onDelete}
        deleteLabel={props.deleteLabel}
        exportLabel={exportLabel}
      />
    </div>
  );
}

/** 行式列表（缺陷 / 知识 / 团队）：左侧复选框 + 可点击内容区 */
export function SelectableRow({
  id,
  selection,
  onClick,
  children,
  trailing,
  className = 'pa-row group flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/10 bg-white/[0.02]',
}: {
  id: string;
  selection: ListSelectionState;
  onClick?: () => void;
  children: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`${className}${onClick ? ' cursor-pointer' : ''}`}
      onClick={onClick}
    >
      <span onClick={(e) => e.stopPropagation()} className="shrink-0">
        <ListCheckbox checked={selection.selected.has(id)} onChange={() => selection.toggle(id)} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      {trailing}
    </div>
  );
}

/** 自定义 table（非 OverviewDataTable）的首列全选 */
export function ListTableSelectionHeader({
  selection,
  disabled,
  className,
}: {
  selection: TableSelectionProps;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <ListSelectionHeaderCell
      allSelected={selection.allSelected}
      indeterminate={selection.indeterminate}
      onToggleAll={selection.onToggleAll}
      disabled={disabled}
      className={className}
    />
  );
}

/** 自定义 table 的行首列复选框 */
export function ListTableSelectionCell({
  selection,
  id,
  className,
}: {
  selection: TableSelectionProps;
  id: string;
  className?: string;
}) {
  return (
    <ListSelectionCell
      checked={selection.selectedIds.has(id)}
      onToggle={() => selection.onToggle(id)}
      className={className}
    />
  );
}
