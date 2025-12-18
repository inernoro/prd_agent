import GithubSlugger from 'github-slugger';

export type TocItem = {
  id: string;
  text: string;
  level: number; // 1-6
  line: number; // 1-based
};

function isFenceStart(line: string) {
  const m = line.match(/^\s*(```+|~~~+)\s*(\w+)?\s*$/);
  if (!m) return null;
  return { fence: m[1] };
}

function normalizeHeadingText(raw: string) {
  // Trim trailing hashes: "Title ###" -> "Title"
  let s = raw.replace(/\s+#+\s*$/, '').trim();
  // Collapse inner whitespace
  s = s.replace(/\s+/g, ' ');
  return s;
}

/**
 * Extract ATX headings (#..######) for TOC.
 * - Ignores headings inside fenced code blocks (``` / ~~~)
 * - Does not attempt to parse setext headings
 */
export function extractToc(markdown: string): TocItem[] {
  const items: TocItem[] = [];
  const slugger = new GithubSlugger();

  const lines = (markdown || '').split(/\r?\n/);
  let inFence = false;
  let fenceToken: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = isFenceStart(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceToken = fence.fence;
      } else if (fenceToken && line.trimStart().startsWith(fenceToken)) {
        inFence = false;
        fenceToken = null;
      }
      continue;
    }

    if (inFence) continue;

    const m = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;

    const level = m[1].length;
    const text = normalizeHeadingText(m[2]);
    if (!text) continue;

    items.push({
      id: slugger.slug(text),
      text,
      level,
      line: i + 1,
    });
  }

  return items;
}
