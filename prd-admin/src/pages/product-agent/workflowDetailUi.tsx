/** 版本工作流详情页共用：卡片 + 属性表 + 记录列表表 */
import type { ReactNode } from 'react';

export function WorkflowDetailCard({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      {(title || action) && (
        <div className="mb-3 flex items-center justify-between">
          {title && <div className="text-xs font-semibold text-white/60">{title}</div>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function WorkflowAttributeTable({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col style={{ width: '22%' }} />
          <col />
        </colgroup>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-white/5 first:border-t-0">
              <td className="px-4 py-3 text-xs font-medium text-white/45 bg-white/[0.02] align-top">{row.label}</td>
              <td className="px-4 py-3 text-sm text-white/80 min-w-0 break-words">{row.value}</td>
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
  if (rows.length === 0) {
    return <div className="py-10 text-center text-sm text-white/35">{emptyText}</div>;
  }
  const cell = 'px-3 py-2.5 text-xs text-white/65 truncate';
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full table-fixed text-left text-sm min-w-[720px]">
        {columns.some((c) => c.width) && (
          <colgroup>
            {columns.map((c, i) => (
              <col key={i} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
        )}
        <thead className="bg-white/[0.03] text-[11px] text-white/45 border-b border-white/10">
          <tr>
            {columns.map((c) => (
              <th key={c.header} className={`px-3 py-2.5 font-medium whitespace-nowrap ${c.className ?? ''}`}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => onRowClick?.(row.id)}
              className={`border-t border-white/5 ${onRowClick ? 'cursor-pointer hover:bg-white/[0.03]' : ''}`}
            >
              {columns.map((c) => (
                <td key={c.header} className={`${cell} ${c.className ?? ''}`}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
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
