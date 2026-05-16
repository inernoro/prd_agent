import GithubSlugger from 'github-slugger';

/**
 * 知识库文档"本页章节"目录（TOC）解析。
 *
 * 关键约束：生成的 slug id 必须与 DocBrowser.tsx 里 MarkdownViewer 的
 * `mkHeading` 完全一致，否则点击目录跳不到对应标题。两边都遵守：
 *   1. 取标题纯文本（剥离 markdown 行内标记）
 *   2. normalizeHeadingText：去尾部 ` ###`、合并空白、trim
 *   3. 用同一个 GithubSlugger 按文档顺序 slug（保证重名标题的 -1/-2 后缀一致）
 *
 * 因此本文件复用同一套 normalizeHeadingText 规则（与 DocBrowser 保持字面一致），
 * 并按文档出现顺序喂给 slugger。
 */

export type TocHeading = {
  /** slug id，对应正文 heading 元素的 id */
  id: string;
  /** 展示文本 */
  text: string;
  /** 1-6 */
  level: number;
};

/** 与 DocBrowser.tsx 的 normalizeHeadingText 保持字面一致 */
export function normalizeHeadingText(raw: string): string {
  return String(raw || '').replace(/\s+#+\s*$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * 解码常见 HTML 实体。
 * MarkdownViewer 启用了 rehypeRaw，标题里的内嵌 HTML（如 `<kbd>Enter</kbd>`）
 * 会被渲染成真实元素，正文 heading 的 id 由其纯文本（已解码实体）算出；
 * TOC 这边喂的是原始 markdown 行，必须做等价解码才能 slug 一致。
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // & 必须最后解，避免把已解码内容里的 & 二次误判
    .replace(/&amp;/g, '&');
}

/** 剥离标题行里的常见 markdown 行内标记，得到与 ReactMarkdown 渲染后等价的纯文本 */
function stripInlineMarkdown(s: string): string {
  let t = s;
  // 图片 ![alt](url) → alt
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 链接 [text](url) → text
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 行内代码 `code` → code
  t = t.replace(/`([^`]*)`/g, '$1');
  // 加粗 / 斜体 / 删除线标记
  t = t.replace(/(\*\*\*|\*\*|\*|___|__|_|~~)/g, '');
  return t;
}

/**
 * SSOT：标题文本 → slug id。两条调用路径共用最后的 normalize + slugger，
 * 但前置规整步骤不同，由 opts.alreadyRendered 区分：
 *
 * raw markdown 路径（parseMarkdownToc，opts.alreadyRendered=false / 默认）：
 *   输入是原始 markdown 标题行，需要完整规整：
 *   1. 剥 markdown 行内标记（**bold** / `code` / [link]() 等）
 *   2. 剥内嵌 HTML 标签（<kbd>x</kbd> → x；rehypeRaw 渲染后正文为纯文本）
 *   3. HTML 实体解码（&amp; &lt; &nbsp; 等）
 *   4. normalizeHeadingText（去尾部 ###、合并空白、trim）
 *
 * rendered 路径（DocBrowser mkHeading 的 childrenToText 结果，opts.alreadyRendered=true）：
 *   输入已是 ReactMarkdown 渲染后的"最终可见文本"——
 *   不再含真 HTML 标签（已成 DOM 元素）、实体已解码（&lt; 已是可见的 <）。
 *   若再剥标签会把 `Use <T> generics` 里的 `<T>` 当标签误删 → 与 TOC 不一致。
 *   因此 rendered 路径**跳过剥标签、跳过实体解码**，
 *   只做 markdown 行内剥离（无害幂等）+ 同一 normalize + 同一 slugger。
 *
 * 两条路径对以下输入都产出相同 slug：
 *   `# Use &lt;T&gt; generics`  → raw: 解码得 "Use <T> generics" / rendered: childrenToText 即 "Use <T> generics"
 *   `## Press <kbd>Enter</kbd>` → raw: 剥标签得 "Press Enter"     / rendered: childrenToText 即 "Press Enter"
 *   `## **加粗** 标题`          → 两侧均得 "加粗 标题"
 *   `## 普通标题`               → 两侧均得 "普通标题"
 *
 * @param headingText raw 路径传 markdown 标题行去掉前导 # 后的原文；rendered 路径传渲染后纯文本
 * @param slugger 必须传入按文档顺序复用的同一个 GithubSlugger 实例
 * @param opts.alreadyRendered true=rendered 路径（跳过剥标签/解实体）
 */
export function headingTextToSlug(
  headingText: string,
  slugger: { slug: (s: string) => string },
  opts?: { alreadyRendered?: boolean },
): { text: string; id: string } {
  let t = stripInlineMarkdown(headingText);
  if (!opts?.alreadyRendered) {
    // 仅 raw markdown 路径：剥内嵌 HTML 标签 + 解 HTML 实体
    // rendered 路径已是最终可见文本（标签已成元素、实体已解码），跳过这两步
    t = t.replace(/<[^>]+>/g, '');
    t = decodeHtmlEntities(t);
  }
  const text = normalizeHeadingText(t);
  const id = text ? slugger.slug(text) : '';
  return { text, id };
}

/**
 * SSOT：解析单行 ATX 标题（`#`~`######`），返回层级 + 去掉「闭合式尾部 #」后的
 * 原始标题文本。`frontmatter.firstHeadingText` 与 `parseMarkdownToc` 必须复用此函数，
 * 保证同一行标题在右侧 TOC 与左侧栏的展示文本完全一致。
 *
 * 尾部 `#` 处理与 normalizeHeadingText 的 `\s+#+\s*$` 语义一致：
 * 只有当 `#` 串前存在空白时才视为闭合标记并剥离。
 *   - `## Heading ##`   → { level:2, text:'Heading' }（` ##` 被吃掉）
 *   - `## 标题`          → { level:2, text:'标题' }
 *   - `## C# 入门`       → { level:2, text:'C# 入门' }（`C#` 的 # 紧贴字母，不剥）
 *   - `### a ### `       → { level:3, text:'a' }
 * 非标题行返回 null。
 */
export function parseAtxHeadingLine(
  line: string,
): { level: number; text: string } | null {
  const m = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
  if (!m) return null;
  return { level: m[1].length, text: m[2] };
}

/**
 * 从 markdown 原文按文档顺序解析 ATX 标题（# ~ ######），
 * 忽略 fenced code block（``` / ~~~）内的伪标题。
 */
export function parseMarkdownToc(content: string | null | undefined): TocHeading[] {
  if (!content) return [];
  const slugger = new GithubSlugger();
  const lines = content.split(/\r?\n/);
  const headings: TocHeading[] = [];
  let inFence = false;
  let fenceMarker = '';

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;

    const parsed = parseAtxHeadingLine(line);
    if (!parsed) continue;
    const { text, id } = headingTextToSlug(parsed.text, slugger);
    if (!text) continue;
    headings.push({ id, text, level: parsed.level });
  }

  return headings;
}
