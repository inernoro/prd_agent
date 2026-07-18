import type { CSSProperties } from 'react';
import type { WeeklyReportSection, WeeklyReportItem } from '@/services/contracts/reportAgent';
import { DEFAULT_TABLE_COLUMNS } from '@/services/contracts/reportAgent';

/** 行单元格兜底：无 cells 的历史行按 content 的 " | " 镜像拆分 */
function resolveRowCells(item: WeeklyReportItem, columnCount: number): string[] {
  const raw = item.cells && item.cells.length > 0
    ? [...item.cells]
    : (item.content ? item.content.split(' | ') : []);
  const cells = raw.slice(0, columnCount);
  while (cells.length < columnCount) cells.push('');
  return cells;
}

/** Table 章节只读渲染（周报详情页 / 详情面板共用） */
export function ReportTableSectionView({ section, isLight }: { section: WeeklyReportSection; isLight: boolean }) {
  const columns = section.templateSection.tableColumns && section.templateSection.tableColumns.length > 0
    ? section.templateSection.tableColumns
    : DEFAULT_TABLE_COLUMNS;
  // 列宽：0 = 自动；任一列有自定义宽度则整表切 fixed 布局，与编辑器观感一致
  const widths = columns.map((_, i) => section.templateSection.tableColumnWidths?.[i] ?? 0);
  const hasCustomWidths = widths.some((w) => w > 0);
  const tableMinWidth = widths.reduce((sum, w) => sum + (w > 0 ? w : 110), 0);
  const borderColor = isLight ? 'rgba(15, 23, 42, 0.10)' : 'rgba(148, 163, 184, 0.18)';
  const cellStyle: CSSProperties = {
    border: `1px solid ${borderColor}`,
    padding: '7px 10px',
    fontSize: 12.5,
    lineHeight: 1.55,
    verticalAlign: 'top',
    minWidth: 88,
  };

  return (
    <div style={{ overflowX: 'auto', overscrollBehavior: 'contain' }}>
      <table
        className="w-full"
        style={{
          borderCollapse: 'collapse',
          tableLayout: hasCustomWidths ? 'fixed' : 'auto',
          minWidth: tableMinWidth,
        }}
      >
        <colgroup>
          {widths.map((w, i) => (
            <col key={i} style={w > 0 ? { width: w } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((col, cIdx) => (
              <th
                key={cIdx}
                style={{
                  ...cellStyle,
                  fontWeight: 600,
                  textAlign: 'left',
                  color: 'var(--text-secondary)',
                  background: isLight ? 'rgba(15, 23, 42, 0.03)' : 'rgba(148, 163, 184, 0.08)',
                }}
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {section.items.map((item, rIdx) => {
            const cells = resolveRowCells(item, columns.length);
            return (
              <tr key={rIdx}>
                {cells.map((cell, cIdx) => (
                  <td key={cIdx} style={{ ...cellStyle, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {cell || ''}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
