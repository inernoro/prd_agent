/**
 * YAML frontmatter 解析（知识库文档统一规则 SSOT）。
 *
 * 项目未安装 remark-frontmatter，这里用正则剥离首个 frontmatter 块，
 * 标题提取（DocBrowser 左侧"正文标题"模式）与正文渲染（MarkdownViewer）
 * 必须调用同一个 parseFrontmatter，避免两边规则不一致导致
 * "左侧显示对了但正文还把 ---/title: 当内容渲染"这种割裂。
 *
 * 规则：
 *   - 仅当文档以 `---`（允许前置空行）开头，且后面存在闭合 `---` 行时，
 *     才认定为 frontmatter；否则原样返回（title = undefined, body = raw）
 *   - frontmatter 内按 `key: value` 逐行解析，value 两端成对引号
 *     （单引号或双引号）会被剥掉
 *   - title 优先取 frontmatter 的 `title`；没有则回退到 body 里第一个
 *     ATX 标题行（`# xxx`）的文本
 */

export type ParsedFrontmatter = {
  /** frontmatter.title（去引号）或回退的首个正文标题；都没有则 undefined */
  title?: string;
  /** 去掉 frontmatter 块后的正文（用于 ReactMarkdown 渲染 / TOC 解析） */
  body: string;
  /** 解析出的全部 frontmatter 键值（已去引号），无 frontmatter 时为空对象 */
  data: Record<string, string>;
};

/** 去掉字符串两端成对的单引号或双引号（仅当首尾同号时） */
export function stripPairedQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** 取正文里第一个 ATX 标题（`#`~`######`）的纯文本，没有则 undefined */
function firstHeadingText(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
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
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (m) {
      const t = m[2].trim();
      if (t) return t;
    }
  }
  return undefined;
}

export function parseFrontmatter(raw: string | null | undefined): ParsedFrontmatter {
  const src = String(raw ?? '');
  if (!src.trim()) return { title: undefined, body: src, data: {} };

  // 允许 frontmatter 前有空行；首个非空内容必须是 `---`
  const leading = src.match(/^\s*/)?.[0] ?? '';
  const afterLeading = src.slice(leading.length);
  // 必须 `---` 单独成行（允许行尾空白）后紧跟换行
  const fmMatch = afterLeading.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);

  if (!fmMatch) {
    // 无 frontmatter：标题回退到首个正文标题
    return { title: firstHeadingText(src), body: src, data: {} };
  }

  const fmBlock = fmMatch[1];
  const consumed = leading.length + fmMatch[0].length;
  const body = src.slice(consumed);

  const data: Record<string, string> = {};
  for (const line of fmBlock.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = stripPairedQuotes(kv[2]);
    if (key) data[key] = value;
  }

  const title =
    (data.title && data.title.trim()) || firstHeadingText(body) || undefined;

  return { title, body, data };
}
