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

    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    const level = m[1].length;
    const text = normalizeHeadingText(stripInlineMarkdown(m[2]));
    if (!text) continue;
    const id = slugger.slug(text);
    headings.push({ id, text, level });
  }

  return headings;
}
