import { useEffect, useMemo, useRef, useState } from 'react';
import type { TableSelectionProps } from './listSelection';
import { ListSelectionCell, ListSelectionHeaderCell } from './listSelection';

export const DEFAULT_CELL_TEXT_MAX = 40;
const MIN_COL_WIDTH = 56;

export function truncateDisplayText(text: string, maxChars = DEFAULT_CELL_TEXT_MAX): { display: string; title?: string } {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return { display: text };
  if (normalized.length <= maxChars) return { display: normalized };
  return { display: `${normalized.slice(0, maxChars)}…`, title: normalized };
}

export function TruncateCell({
  text,
  maxChars = DEFAULT_CELL_TEXT_MAX,
  className = '',
}: {
  text: string;
  maxChars?: number;
  className?: string;
}) {
  const { display, title } = truncateDisplayText(text, maxChars);
  return (
    <span className={`block max-w-full truncate ${className}`} title={title}>
      {display}
    </span>
  );
}

export interface OverviewTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  className?: string;
  defaultWidth?: number;
  /** 默认 true；最后一列不提供拖动手柄 */
  resizable?: boolean;
}

function loadColumnWidths(storageKey: string, defaults: number[]): number[] {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== defaults.length) return defaults;
    return parsed.map((value, index) => {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) && n >= MIN_COL_WIDTH ? n : defaults[index];
    });
  } catch {
    return defaults;
  }
}

export function OverviewDataTable<T extends { id: string }>({
  tableKey,
  columns,
  rows,
  onRowClick,
  selection,
}: {
  tableKey: string;
  columns: OverviewTableColumn<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  /** 传入则首列显示复选框，支持多选批量操作 */
  selection?: TableSelectionProps;
}) {
  const defaultWidthsKey = columns.map((c) => `${c.key}:${c.defaultWidth ?? 120}`).join('|');
  const defaultWidths = useMemo(
    () => columns.map((c) => c.defaultWidth ?? 120),
    [defaultWidthsKey],
  );
  const storageKey = `pa-overview-col-widths:${tableKey}`;
  const [widths, setWidths] = useState<number[]>(() => loadColumnWidths(storageKey, defaultWidths));
  const dragRef = useRef<{ index: number; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    setWidths(loadColumnWidths(storageKey, defaultWidths));
  }, [storageKey, defaultWidthsKey]);

  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = Math.max(MIN_COL_WIDTH, drag.startWidth + (event.clientX - drag.startX));
      setWidths((prev) => {
        const copy = [...prev];
        copy[drag.index] = next;
        return copy;
      });
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setWidths((prev) => {
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(prev));
        } catch {
          // ignore quota errors
        }
        return prev;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [storageKey]);

  const selectColWidth = 40;
  const tableMinWidth = widths.reduce((sum, width) => sum + width, 0) + (selection ? selectColWidth : 0);

  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-xl border border-white/10">
      <table className="table-fixed text-sm" style={{ minWidth: tableMinWidth, width: '100%' }}>
        <colgroup>
          {selection ? <col style={{ width: selectColWidth }} /> : null}
          {widths.map((width, index) => (
            <col key={columns[index]?.key ?? index} style={{ width }} />
          ))}
        </colgroup>
        <thead>
          <tr className="bg-white/[0.03] text-white/45 text-[11px]">
            {selection ? (
              <ListSelectionHeaderCell
                allSelected={selection.allSelected}
                indeterminate={selection.indeterminate}
                onToggleAll={selection.onToggleAll}
                disabled={rows.length === 0}
                className="px-3 py-2"
              />
            ) : null}
            {columns.map((column, index) => (
              <th
                key={column.key}
                className={`relative text-left font-medium px-3 py-2 select-none ${column.className ?? ''}`}
              >
                <span className="block truncate pr-1">{column.header}</span>
                {column.resizable !== false && index < columns.length - 1 ? (
                  <span
                    role="separator"
                    aria-orientation="vertical"
                    title="拖动调整列宽"
                    className="absolute right-0 top-0 z-10 h-full w-2 cursor-col-resize touch-none hover:bg-cyan-500/25 active:bg-cyan-500/40"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      dragRef.current = {
                        index,
                        startX: event.clientX,
                        startWidth: widths[index] ?? defaultWidths[index],
                      };
                    }}
                  />
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => onRowClick?.(row)}
              className={`border-t border-white/5 ${onRowClick ? 'cursor-pointer hover:bg-white/[0.03]' : ''}`}
            >
              {selection ? (
                <ListSelectionCell
                  checked={selection.selectedIds.has(row.id)}
                  onToggle={() => selection.onToggle(row.id)}
                />
              ) : null}
              {columns.map((column) => (
                <td key={column.key} className={`px-3 py-2 text-white/80 max-w-0 ${column.className ?? ''}`}>
                  <div className="min-w-0 overflow-hidden">{column.render(row)}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
