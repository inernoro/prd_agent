// 轻量行级 diff（无第三方依赖）。
//
// 用途：知识库「AI 文档对话」写回前的 diff 预览闸 —— 让用户在 AI 覆盖原文之前，
// 先看清「原文 vs 改后」逐行差异（红删绿增），确认才落库（满足「让用户感知改动」）。
//
// 为什么自己写而不引库：项目未装任何 diff 依赖（package.json 无 diff/jsdiff/react-diff），
// 而预览只需行级粒度，LCS + 前后缀裁剪足够，引一个库不划算。纯函数，便于单测。

export type DiffLineType = 'eq' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

// LCS 退化保护：差异中段行数乘积超过这个阈值时，不跑 O(n*m) 的 LCS，
// 直接「整段删 + 整段增」。40k 字文档极端情况（全是换行）也不会卡死 UI。
const LCS_CELL_CAP = 1200 * 1200;

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'eq', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++] });
  while (j < m) out.push({ type: 'add', text: b[j++] });
  return out;
}

/**
 * 计算 original → modified 的行级 diff。
 * 先裁掉公共前缀 / 后缀（让 append、小改动这类「大部分不变」的场景秒出），
 * 只对真正差异的中段跑 LCS；中段过大则退化为整段替换。
 */
export function computeLineDiff(original: string, modified: string): DiffLine[] {
  const a = original === '' ? [] : original.split('\n');
  const b = modified === '' ? [] : modified.split('\n');

  const out: DiffLine[] = [];

  // 公共前缀
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    out.push({ type: 'eq', text: a[start] });
    start++;
  }

  // 公共后缀（不越过已匹配的前缀）
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  let mid: DiffLine[];
  if (midA.length === 0) {
    mid = midB.map((text) => ({ type: 'add' as const, text }));
  } else if (midB.length === 0) {
    mid = midA.map((text) => ({ type: 'del' as const, text }));
  } else if (midA.length * midB.length > LCS_CELL_CAP) {
    mid = [
      ...midA.map((text) => ({ type: 'del' as const, text })),
      ...midB.map((text) => ({ type: 'add' as const, text })),
    ];
  } else {
    mid = lcsDiff(midA, midB);
  }
  out.push(...mid);

  // 公共后缀（a 与 b 该段逐行相等，取 a 的即可）
  for (let k = endA; k < a.length; k++) out.push({ type: 'eq', text: a[k] });

  return out;
}

export function diffStats(lines: DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === 'add') added++;
    else if (l.type === 'del') removed++;
  }
  return { added, removed };
}

/** 两段文本是否逐行完全一致（写回前可据此提示「无变化」）。 */
export function isIdentical(original: string, modified: string): boolean {
  return (original ?? '') === (modified ?? '');
}
