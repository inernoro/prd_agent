/** Parse database-client output only; never split or re-execute submitted SQL. */
export interface SqlConsoleResultSet {
  columns: string[];
  rows: Array<Array<string | null>>;
  rowCount: number;
  statement?: string;
}

export interface SqlConsoleResult extends SqlConsoleResultSet {
  resultSets?: SqlConsoleResultSet[];
  output?: string;
  truncated?: boolean;
}

function decodeMarkup(value: string): string {
  return value.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (_match, numeric: string | undefined, name: string | undefined) => {
    if (numeric) {
      const point = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
      return point <= 0x10ffff ? String.fromCodePoint(point) : '\uFFFD';
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name!.toLowerCase()];
  });
}

export function parseSqlConsoleResults(stdout: string, runtime: 'mysql' | 'postgres'): SqlConsoleResult {
  const cap = 256 * 1024;
  const text = stdout.slice(0, cap);
  const resultSets: SqlConsoleResultSet[] = [];
  let output = text;
  if (runtime === 'mysql') {
    output = text.replace(/(?:<\?xml[^>]*>\s*)?<resultset\b([^>]*)>([\s\S]*?)<\/resultset>/g, (_block, attributes: string, content: string) => {
      const statement = decodeMarkup(attributes.match(/\bstatement="([^"]*)"/)?.[1] || '');
      const columns: string[] = [];
      const rows: Array<Array<string | null>> = [];
      for (const row of content.matchAll(/<row>([\s\S]*?)<\/row>/g)) {
        const values: Array<string | null> = [];
        const names: string[] = [];
        for (const field of row[1].matchAll(/<field\b([^>]*?)(?:\s*\/>|>([\s\S]*?)<\/field>)/g)) {
          names.push(decodeMarkup(field[1].match(/\bname="([^"]*)"/)?.[1] || ''));
          values.push(/\bxsi:nil="true"/.test(field[1]) ? null : decodeMarkup(field[2] || ''));
        }
        if (!columns.length) columns.push(...names);
        rows.push(values);
      }
      resultSets.push({ columns, rows, rowCount: rows.length, statement });
      return `[查询结果 ${resultSets.length}：${rows.length} 行]`;
    });
  } else {
    output = text.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_block, content: string) => {
      const columns: string[] = [];
      const rows: Array<Array<string | null>> = [];
      for (const row of content.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        const headers = [...row[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)];
        const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
        const decodeCell = (value: string) => decodeMarkup(value.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, ''));
        if (headers.length) columns.push(...headers.map((item) => decodeCell(item[1])));
        if (cells.length) rows.push(cells.map((item) => decodeCell(item[1])));
      }
      resultSets.push({ columns, rows, rowCount: rows.length });
      return `[查询结果 ${resultSets.length}：${rows.length} 行]`;
    });
  }
  return { columns: [], rows: [], rowCount: resultSets.reduce((sum, item) => sum + item.rowCount, 0), resultSets, output: output.trim() || 'SQL 执行完成。', truncated: stdout.length > cap };
}

export class SqlConsoleExecutionError extends Error {
  constructor(message: string, public partialResult: SqlConsoleResult) { super(message); }
}
