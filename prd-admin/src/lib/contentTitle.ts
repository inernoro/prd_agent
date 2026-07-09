/**
 * 知识库文档「人类正文标题」派生工具。
 * 从 entry.summary(正文前 200 字,含 frontmatter)推导可读标题,
 * 供知识星球(DocumentGalaxyView)与 Obsidian 双链图(UniverseGraphPage)共用。
 */
import { parseFrontmatter } from '@/lib/frontmatter';

/**
 * 从正文标题里剥掉重复的「文件名前缀」。
 * doc/ 作者约定：H1 常写成「{点分文件名} — {真标题}」甚至纯文件名。
 * 直接拿 H1 当标题会把文件名带进来（用户「都是文件名字」的根因）。
 * 尝试两种前缀：完整文件名、去掉 {type}. 段后的剩余；命中则连同其后的分隔符一并剥掉。
 */
export function stripFilenamePrefix(title: string, filenameBare: string): string {
  let t = title.trim();
  const cands = [filenameBare];
  const dot = filenameBare.indexOf('.');
  if (dot > 0) cands.push(filenameBare.slice(dot + 1)); // 去掉 type 前缀（如 web-hosting-client-ip）
  for (const c of cands) {
    if (c && t.toLowerCase().startsWith(c.toLowerCase())) {
      // 剥掉前缀后，去掉紧跟的分隔符（— – -- - · : ： | 及空白）
      t = t.slice(c.length).replace(/^[\s—–―·:：|/-]+/, '').trim();
      break;
    }
  }
  return t;
}

/**
 * 从知识库 entry 的 summary 推导「人类正文标题」：frontmatter title / 首个标题，
 * 再剥掉重复的文件名前缀。无可用人类标题（如 H1 就是文件名本身）返回 null。
 */
export function deriveContentTitle(summary: string | null | undefined, filenameBare: string): string | null {
  if (!summary) return null;
  if (summary.trimStart().startsWith('<')) return null; // HTML/XML 片段不参与
  const raw = parseFrontmatter(summary).title?.trim();
  if (!raw) return null;
  const cleaned = stripFilenamePrefix(raw, filenameBare);
  return cleaned || null;
}
