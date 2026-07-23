/** 版本工作流详情页共用：卡片 + 属性表 + 记录列表表 */
import type { ReactNode } from 'react';

export function WorkflowDetailCard({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-token-subtle bg-token-nested p-4">
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between">
          {title && <div className="text-xs font-semibold text-token-secondary">{title}</div>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function WorkflowAttributeTable({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-token-subtle">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col style={{ width: '22%' }} />
          <col />
        </colgroup>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-token-subtle first:border-t-0">
              <td className="px-4 py-3 text-xs font-medium text-token-muted bg-token-nested align-top">{row.label}</td>
              <td className="px-4 py-3 text-sm text-token-primary min-w-0 break-words">{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WorkflowRecordTable({
  columns,
  rows,
  emptyText,
  onRowClick,
}: {
  columns: { header: string; width?: string; className?: string; render: (row: { id: string }) => ReactNode }[];
  rows: { id: string }[];
  emptyText: string;
  onRowClick?: (id: string) => void;
}) {
  const cell = 'px-3 py-2.5 text-xs text-token-secondary truncate';
  return (
    <div className="overflow-x-auto rounded-lg border border-token-subtle">
      <table className="w-full table-fixed text-left text-sm min-w-[720px]">
        {columns.some((c) => c.width) && (
          <colgroup>
            {columns.map((c, i) => (
              <col key={i} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
        )}
        <thead className="bg-token-nested text-[11px] text-token-muted border-b border-token-subtle">
          <tr>
            {columns.map((c) => (
              <th key={c.header} className={`px-3 py-2.5 font-medium whitespace-nowrap ${c.className ?? ''}`}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-10 text-center text-sm text-token-muted">
                {emptyText}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => onRowClick?.(row.id)}
                className={`border-t border-token-subtle ${onRowClick ? 'cursor-pointer hover-bg-soft' : ''}`}
              >
                {columns.map((c) => (
                  <td key={c.header} className={`${cell} ${c.className ?? ''}`}>{c.render(row)}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function workflowFmtDate(value?: string | null) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
