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

// ── 行内（词级）diff ────────────────────────────────────────────────────────
//
// 行级 diff 判「这一行变了没有」，改一个词也会把整行标成「删一行 + 加一行」，
// 用户得自己逐字比对才知道到底改了哪儿——2026-08-25 用户说的「diff 不够精准」就是这个。
// 下面这层在「配对上的那一对行」里再算一次，只标真正变了的那几个词。
//
// 切词必须按 markdown 的**原子**切，不能按字符：把 `**加粗**` 从中间劈开，
// 一半进 <ins> 一半留在外面，落单的星号会当场把后文全变成加粗。
// 所以行内标记（加粗/斜体/行内代码/删除线/链接/双链/图片）整个算一个原子，不可分。

/** 一个不可再分的行内片段 */
const ATOM_RE = new RegExp([
  '!?\\[\\[[^\\]]*\\]\\]',        // 双链 [[x]] / 图片双链
  '!?\\[[^\\]]*\\]\\([^)]*\\)',   // 链接 / 图片
  '\\*\\*\\*[^*]+\\*\\*\\*',      // 粗斜体
  '\\*\\*[^*]+\\*\\*',            // 加粗
  '(?<![*\\w])\\*[^*]+\\*',       // 斜体
  '~~[^~]+~~',                    // 删除线
  '`[^`]+`',                      // 行内代码
  '\\s+',                         // 空白（整段算一个原子，保留原样）
  '[\\u3400-\\u9fff\\uf900-\\ufaff]', // CJK 逐字切，改一个字就只标一个字
  '[0-9]+(?:\\.[0-9]+)*',         // 数字（含小数/版本号）
  '[A-Za-z][A-Za-z\'-]*',         // 拉丁词
  '[^\\s]',                       // 其余标点符号逐个
].join('|'), 'g');

/** 把一行切成不可再分的原子序列 */
export function tokenizeInlineAtoms(line: string): string[] {
  return line.match(ATOM_RE) ?? [];
}

export interface DiffSeg {
  type: DiffLineType;
  text: string;
}

/**
 * 两行的相似度，用来判断这两行值不值得做行内 diff。
 *
 * 用 Dice 系数 `2*LCS/(len_a+len_b)`，不是「LCS / 较长的一方」：
 * 后者对「把一句话扩写成两倍长」判得过严——原句 14 个字全留着、只是后面追了一大段，
 * 也只算 0.37，于是退回整行删+整行增，用户又得自己逐字找差异（2026-08-25 实测撞到）。
 * Dice 对这种「一边长很多但共有部分完整」的改写给 0.53，正是该逐词标的情形。
 */
export function lineSimilarity(a: string, b: string): number {
  const ta = tokenizeInlineAtoms(a);
  const tb = tokenizeInlineAtoms(b);
  if (!ta.length && !tb.length) return 1;
  if (!ta.length || !tb.length) return 0;
  if (ta.length * tb.length > LCS_CELL_CAP) return 0;
  const dp: number[][] = Array.from({ length: ta.length + 1 }, () => new Array<number>(tb.length + 1).fill(0));
  for (let i = ta.length - 1; i >= 0; i--) {
    for (let j = tb.length - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return (2 * dp[0][0]) / (ta.length + tb.length);
}

/**
 * 一行之内的 diff：返回按原子对齐、并把连续同类原子合并后的片段序列。
 * 合并很重要——不合并的话「可落地」三个字会变成三个各自带底色的小块，比不标还乱。
 */
export function computeInlineDiff(original: string, modified: string): DiffSeg[] {
  const a = tokenizeInlineAtoms(original);
  const b = tokenizeInlineAtoms(modified);
  if (a.length * b.length > LCS_CELL_CAP) {
    return [{ type: 'del', text: original }, { type: 'add', text: modified }];
  }
  const raw = lcsDiff(a, b);
  const out: DiffSeg[] = [];
  for (const seg of raw) {
    const last = out[out.length - 1];
    if (last && last.type === seg.type) last.text += seg.text;
    else out.push({ type: seg.type, text: seg.text });
  }
  // 只在两侧之间的空白原子，跟着哪边都行——归到 eq 里，避免「删掉一个空格」这种噪音
  return out.filter((s) => s.text !== '');
}
