/** Database protocol results; submitted SQL is never split or re-executed. */
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

export class SqlConsoleExecutionError extends Error {
  constructor(message: string, public partialResult: SqlConsoleResult) { super(message); }
}
