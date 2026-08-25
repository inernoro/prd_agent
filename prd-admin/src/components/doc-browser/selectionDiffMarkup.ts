// 知识库「逐句修改」的就地 diff 标记：把「原选区 → AI 改写结果」的差异写回 Markdown 正文，
// 新增包 <ins>、删除包 <del>，交给正文渲染器（MarkdownViewer）直接渲染。
//
// 为什么是标记正文而不是另开一个 diff 面板（artifact-is-experience.md）：
// 用户等的产物就是「改完的文章」，所以变化必须发生在文章本身上——流式期间逐字长出蓝色新句、
// 原句挂删除线，而不是在浮层里看一段与正文无关的文本。
//
// 为什么独立成纯函数模块（predicate-and-wiring-discipline.md 形状 4）：
// 标记逻辑要在真实 markdown 语法上成立（列表/标题/引用/表格/代码围栏），只能靠单测锁住，
// 不能靠人肉回归。渲染侧的契约（<ins>/<del> 能穿过 rehypeRaw + rehypeSanitize 活下来）
// 由 __tests__/selectionDiffMarkup.test.ts 用 MarkdownViewer 的真实插件链断言。

import { computeLineDiff } from '@/lib/lineDiff';
import type { ResolvedRange } from './selectionEdit';

export interface InlineDiffMarkup {
  /** 带 <del>/<ins> 标记的完整正文，可直接喂给正文渲染器 */
  body: string;
  /** 新增行数 */
  added: number;
  /** 删除行数 */
  removed: number;
  /**
   * 代码围栏内部发生了改动、但无法标色。
   * 围栏内一切字符都是代码，塞 <del>/<ins> 会把标签本身渲染成代码文本，
   * 所以围栏内的删除行直接不渲染（只呈现改后的代码），由 UI 明说这一点，
   * 不假装「代码块没变」（no-rootless-tree.md：做不到就暴露，不装作做到）。
   */
  codeChangeUnmarked: boolean;
}

/** ``` 或 ~~~ 围栏行（允许最多 3 个前导空格，与 CommonMark 一致） */
const FENCE_RE = /^ {0,3}(?:```|~~~)/;

/**
 * 流式期间放进正文的**空锚点**：AI 正在写的那段文字由共享组件 StreamingText 用 portal
 * 渲染进这个节点，正文 markdown 本身与「已经吐出多少字」无关，全程一个常量。
 *
 * 为什么是锚点而不是把流式文本拼进 markdown（doc/rule.frontend.streaming-text.md）：
 * 规则明令「流式期间使用轻量纯文本动效，完成后再切换完整 Markdown 渲染」「禁止每个 chunk
 * 都执行完整 Markdown 高亮和布局」。逐 token 重算正文会让 MarkdownViewer 整棵重挂
 *（它的 components 是每次 render 新建的内联函数），进场动画被无限重启，用户看到的是
 * 「一闪一闪，像老电脑」。锚点让正文这一层彻底不动，节奏与光标交给 StreamingText。
 */
export const STREAM_ANCHOR_ID = 'doc-rewrite-stream';
// div 而不是 span：正在写的那段现在按 markdown 渲染（标题/列表/代码块都是块级元素），
// 塞进一个 span 会被浏览器判成 <p> 里嵌块级元素，排版当场错位。
export const STREAM_ANCHOR_HTML = `<div id="${STREAM_ANCHOR_ID}"></div>`;

/**
 * 锚点在**真实 DOM 里**的 id：rehype-sanitize 会给正文内嵌 HTML 的 id 加 `user-content-`
 * 前缀（防上传文档拿 id 撞应用自身的锚点），所以写进 markdown 的那个 id 查不到节点。
 * 这正是 predicate-and-wiring-discipline.md 形状 6——判据要读真正生效的那个值。
 * 两个都收在选择器里：前缀策略若变，DOM 侧不至于当场失灵，测试会先红。
 */
export const STREAM_ANCHOR_DOM_ID = `user-content-${STREAM_ANCHOR_ID}`;
export const STREAM_ANCHOR_SELECTOR = `#${STREAM_ANCHOR_DOM_ID}, #${STREAM_ANCHOR_ID}`;

/**
 * 行首的块级标记：引用符 > / 列表符 -*+ 或 1. / 任务框 [ ] / 标题 #。
 * 标记要留在 <del>/<ins> 外面——包进去就不再是列表/标题，块级结构当场塌掉。
 */
const LEAD_MARKER_RE = /^([ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(?:\[[ xX]\][ \t]+)?(?:#{1,6}[ \t]+)?)([\s\S]*)$/;

/** 表格行：分隔用的注释会把一张表切成两张，第二张没有表头就塌成段落，所以表格行两侧不插 */
const TABLE_ROW_RE = /^[ \t]*\|/;

/**
 * 删除块与新增块之间的隐形分隔。缺了它有两种可见的坏相：
 * 1. 被删的 1./2./3. 与新增条目被解析成同一个列表，新条目从 4. 开始编号，像是「原来有六条」；
 * 2. 紧跟在被删列表项后面的新增段落会被当成该列表项的延续行，缩进跑到列表里面去
 *    （流式期间尤其明显——新句子边长边挂在上一条的屁股后面）。
 * HTML 注释在 remark 解析期就截断块，之后被 sanitize 丢掉，渲染结果里看不见。
 */
const BLOCK_SPLIT = '<!-- -->';

/** 分隔线（--- / *** / ___）：没有可标注的文字 */
const THEMATIC_BREAK_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/** 表格分隔行（|---|:--:|）：标注它会把表格拆成普通段落 */
function isTableDelimiterRow(line: string): boolean {
  return line.includes('|') && line.includes('-') && /^[\s|:-]+$/.test(line);
}

/** 在保留首尾空白的前提下包裹一段文本 */
function wrapKeepingPadding(segment: string, tag: 'del' | 'ins'): string {
  const m = /^([ \t]*)([\s\S]*?)([ \t]*)$/.exec(segment);
  if (!m || !m[2]) return segment;
  return `${m[1]}<${tag}>${m[2]}</${tag}>${m[3]}`;
}

/**
 * 给一行正文打上 del/ins 标记，保留它的块级结构。
 * 标记只包「文字内容」：行首的 > / - / 1. / # 与表格竖线一律留在外面。
 */
export function markLine(line: string, tag: 'del' | 'ins'): string {
  if (!line.trim()) return line;
  if (THEMATIC_BREAK_RE.test(line)) return line;
  if (isTableDelimiterRow(line)) return line;
  // 表格行：逐单元格标注，竖线保持原位
  if (/^[ \t]*\|/.test(line)) {
    return line
      .split('|')
      .map((cell) => (cell.trim() ? wrapKeepingPadding(cell, tag) : cell))
      .join('|');
  }
  const m = LEAD_MARKER_RE.exec(line);
  const lead = m ? m[1] : '';
  const rest = m ? m[2] : line;
  if (!rest.trim()) return line;
  return `${lead}<${tag}>${rest}</${tag}>`;
}

/** 统计一段文本结束时是否停在代码围栏内部 */
function endsInsideFence(text: string, initial = false): boolean {
  let inside = initial;
  for (const line of text.split('\n')) {
    if (FENCE_RE.test(line)) inside = !inside;
  }
  return inside;
}


/**
 * 生成「原选区 → newText」的就地 diff 正文。
 *
 * @param body   当前正文（已剥 frontmatter，与选区 offset 同一坐标系）
 * @param range  选区在 body 中的位置（resolveSelectionRange 的结果）
 * @param newText AI 改写结果（流式期间是不完整的前缀，同样可以渲染）
 */
export function buildInlineDiffBody(body: string, range: ResolvedRange, newText: string): InlineDiffMarkup {
  const original = body.slice(range.start, range.end);
  const lines = computeLineDiff(original, newText);

  // 选区本身可能落在一个代码围栏内部（用户选了代码块里的几行）——
  // 围栏状态必须从正文开头算起，否则会把代码当普通文字标注、把 <del> 渲染成代码。
  const startsInsideFence = endsInsideFence(body.slice(0, range.start));
  let outFence = startsInsideFence; // 已输出内容（eq + ins）的围栏状态
  let delFence = startsInsideFence; // 被删除内容（del）自己的围栏状态
  let codeChangeUnmarked = false;
  let added = 0;
  let removed = 0;

  const out: string[] = [];
  // 上一条真正输出了的行是「删除」还是「新增」—— 删/增交界处要插隐形分隔，否则两侧会粘成一个块
  let lastEmitted: { type: 'del' | 'add' | 'eq'; isTableRow: boolean } | null = null;
  const emit = (text: string, type: 'del' | 'add' | 'eq') => {
    const isTableRow = TABLE_ROW_RE.test(text);
    if (
      lastEmitted
      && lastEmitted.type !== type
      && lastEmitted.type !== 'eq' && type !== 'eq'
      && !lastEmitted.isTableRow && !isTableRow
      && !outFence // 围栏里的一切字符都是代码，注释会原样显示成代码文本
    ) {
      out.push(BLOCK_SPLIT);
    }
    out.push(text);
    lastEmitted = { type, isTableRow };
  };

  for (const l of lines) {
    if (l.type === 'del') {
      removed += 1;
      const isFence = FENCE_RE.test(l.text);
      if (isFence) {
        // 被删掉的代码块围栏：整块不渲染（渲染出来只会是一段没法标色的裸代码）
        delFence = !delFence;
        codeChangeUnmarked = true;
        continue;
      }
      if (delFence || outFence) {
        // 围栏内的删除行同理丢弃，只保留改后的代码
        codeChangeUnmarked = true;
        continue;
      }
      emit(markLine(l.text, 'del'), 'del');
      continue;
    }

    if (l.type === 'add') added += 1;
    const isFence = FENCE_RE.test(l.text);
    if (outFence || isFence) {
      // 围栏行与围栏内部原样输出：保证代码块永远是合法的、能高亮的代码
      if (l.type === 'add') codeChangeUnmarked = true;
      emit(l.text, l.type === 'add' ? 'add' : 'eq');
      if (isFence) outFence = !outFence;
      continue;
    }
    // 流式锚点原样输出，不包 <ins>：它承载的是一整块 markdown，
    // 而 <ins> 是行内元素，包住块级内容的圆角底色会糊成一团。
    // 「这是新写的」由 portal 里那个容器自己的样式表达（doc-diff.css 的 .doc-rewrite-stream）。
    if (l.type === 'add' && l.text.trim() === STREAM_ANCHOR_HTML) {
      emit(l.text, 'add');
      continue;
    }
    emit(l.type === 'add' ? markLine(l.text, 'ins') : l.text, l.type === 'add' ? 'add' : 'eq');
  }

  // 流式期间常常停在「开了围栏还没写完」的半截状态：不补上收尾围栏，
  // 这条没闭合的 ``` 会把选区之后的整篇文档一起吞进代码块（也吞掉后面的 diff 着色）。
  // 收尾后围栏状态必须回到进入选区时的样子，否则文档尾部同样错位。
  if (outFence !== startsInsideFence) out.push('```');

  return {
    body: body.slice(0, range.start) + out.join('\n') + body.slice(range.end),
    added,
    removed,
    codeChangeUnmarked,
  };
}
