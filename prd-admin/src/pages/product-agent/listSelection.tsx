/**
 * 产品管理 — 列表多选 SSOT（复选框 + 全选 + 选中态 hook）。
 * 所有表格 / 行列表统一使用，配合 ListBatchBar 做批量操作。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';

const CHECKBOX_CLS = 'accent-cyan-500 shrink-0';

/** 表格首列复选框固定宽度（colgroup / th / td 共用） */
export const LIST_SELECTION_COL_WIDTH = 40;

const selectionColStyle = {
  width: LIST_SELECTION_COL_WIDTH,
  minWidth: LIST_SELECTION_COL_WIDTH,
  maxWidth: LIST_SELECTION_COL_WIDTH,
} as const;

function SelectionCheckboxWrap({
  children,
  className = 'py-2.5',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`flex items-center justify-center ${className}`}>{children}</div>;
}

export function useListSelection(allIds: string[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const allIdsKey = allIds.join('\u0001');

  useEffect(() => {
    setSelected((prev) => {
      const idSet = new Set(allIds);
      const next = new Set([...prev].filter((id) => idSet.has(id)));
      if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev;
      return next;
    });
  }, [allIdsKey, allIds]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      if (allIds.length > 0 && allIds.every((id) => prev.has(id))) return new Set();
      return new Set(allIds);
    });
  }, [allIdsKey, allIds]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));
  const indeterminate = !allSelected && allIds.some((id) => selected.has(id));

  const tableSelection = useMemo(
    () => ({
      selectedIds: selected,
      onToggle: toggle,
      onToggleAll: toggleAll,
      allSelected,
      indeterminate,
    }),
    [selected, toggle, toggleAll, allSelected, indeterminate],
  );

  const selectedIds = useMemo(() => [...selected], [selected]);

  return {
    selected,
    selectedIds,
    toggle,
    toggleAll,
    clear,
    allSelected,
    indeterminate,
    count: selected.size,
    tableSelection,
  };
}

export type TableSelectionProps = ReturnType<typeof useListSelection>['tableSelection'];

export function ListCheckbox({
  checked,
  indeterminate,
  onChange,
  onClick,
  className = '',
  'aria-label': ariaLabel = '选择',
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  onClick?: (e: MouseEvent) => void;
  className?: string;
  'aria-label'?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      aria-label={ariaLabel}
      className={`${CHECKBOX_CLS} ${className}`}
    />
  );
}

export function ListSelectionHeaderCell({
  allSelected,
  indeterminate,
  onToggleAll,
  disabled,
  className = 'py-2.5',
}: {
  allSelected: boolean;
  indeterminate: boolean;
  onToggleAll: () => void;
  disabled?: boolean;
  /** 仅用于 inner 垂直间距，勿传 px-* */
  className?: string;
}) {
  return (
    <th className="box-border p-0 align-middle font-medium whitespace-nowrap" style={selectionColStyle}>
      <SelectionCheckboxWrap className={className}>
        <ListCheckbox
          checked={allSelected}
          indeterminate={indeterminate}
          onChange={onToggleAll}
          aria-label="全选"
          className={disabled ? 'opacity-40 pointer-events-none' : ''}
        />
      </SelectionCheckboxWrap>
    </th>
  );
}

export function ListSelectionCell({
  checked,
  onToggle,
  className = 'py-2.5',
}: {
  checked: boolean;
  onToggle: () => void;
  /** 仅用于 inner 垂直间距，勿传 px-* */
  className?: string;
}) {
  return (
    <td className="box-border p-0 align-middle" style={selectionColStyle} onClick={(e) => e.stopPropagation()}>
      <SelectionCheckboxWrap className={className}>
        <ListCheckbox checked={checked} onChange={onToggle} />
      </SelectionCheckboxWrap>
    </td>
  );
}
