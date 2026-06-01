/**
 * SQL 助手纯函数：IN 转换、SQL 单引号转义、按行去重。
 *
 * 这里只放无副作用的字符串处理函数，方便 vitest 直接断言。
 * UI 组件 (`CcasSqlInConverter`, `CcasSqlDeduper`) 只负责状态 + 复制 + toast。
 */

/** 将 SQL 字符串字面量中的单引号按标准方式转义：`'` → `''`。 */
export function escapeSqlSingleQuote(value: string): string {
  return value.replace(/'/g, "''");
}

export interface InConverterResult {
  /** 输出的 IN 子句字符串，格式 `('a', 'b', 'c')`；输入全为空时返回空串 */
  output: string;
  /** 有效行数（过滤空白行后） */
  validRows: number;
  /** 项目数（等于 validRows，分两个字段是为了和源页统计 chip 对齐） */
  itemCount: number;
}

/**
 * 把"每行一个值"的原始输入转成 SQL `IN` 子句可用的括号列表。
 *
 * - 自动 trim 每一行，空行忽略
 * - 单引号会按 SQL 标准转义为两个单引号 (`'O''Brien'`)
 * - 输出格式：`('a', 'b', 'c')`
 */
export function toInClause(raw: string): InConverterResult {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    return { output: '', validRows: 0, itemCount: 0 };
  }
  const escaped = lines.map((l) => `'${escapeSqlSingleQuote(l)}'`).join(', ');
  return { output: `(${escaped})`, validRows: lines.length, itemCount: lines.length };
}

export interface DedupOptions {
  /** 保持输入的原始顺序；false 时按 localeCompare 升序排序 */
  keepOrder: boolean;
  /** 比较时忽略大小写 */
  ignoreCase: boolean;
  /** 比较前去掉每行首尾空白 */
  trimSpaces: boolean;
}

export interface DedupResult {
  /** 去重后的输出，每行一个值 */
  output: string;
  /** 原始有效行数（按 trimSpaces 选项过滤空行后） */
  rawRows: number;
  /** 去重后唯一行数 */
  uniqueRows: number;
  /** 重复个数（每多出现一次算一个，等于 rawRows - uniqueRows） */
  duplicateCount: number;
  /** 移除的总条数（同 duplicateCount，分两个字段对齐源页 chip 显示） */
  removedCount: number;
}

/**
 * 按行去重。
 *
 * 算法严格对照源页 `https://bd.t.miduonet.com/easy-bug/sql` 去重 tab 的实现：
 * 1. split('\n')
 * 2. 如选 trimSpaces，先 trim
 * 3. 过滤空行
 * 4. Set 去重（ignoreCase 时按小写比较，但保留原始大小写）
 * 5. keepOrder=false 时按 localeCompare 排序
 */
export function dedupLines(raw: string, options: DedupOptions): DedupResult {
  const { keepOrder, ignoreCase, trimSpaces } = options;
  const splitted = raw.split('\n');
  const normalized = splitted
    .map((l) => (trimSpaces ? l.trim() : l))
    .filter((l) => l.length > 0);

  const seen = new Set<string>();
  const unique: string[] = [];
  let duplicate = 0;
  for (const line of normalized) {
    const key = ignoreCase ? line.toLowerCase() : line;
    if (seen.has(key)) {
      duplicate += 1;
    } else {
      seen.add(key);
      unique.push(line);
    }
  }

  if (!keepOrder) {
    unique.sort((a, b) => {
      const ka = ignoreCase ? a.toLowerCase() : a;
      const kb = ignoreCase ? b.toLowerCase() : b;
      return ka.localeCompare(kb);
    });
  }

  return {
    output: unique.join('\n'),
    rawRows: normalized.length,
    uniqueRows: unique.length,
    duplicateCount: duplicate,
    removedCount: normalized.length - unique.length,
  };
}
