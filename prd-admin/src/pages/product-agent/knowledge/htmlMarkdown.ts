/**
 * 知识库 HTML ↔ Markdown 轻量互转。
 *
 * 用途：知识文档「格式」在 Markdown / 富文本(HTML) 间切换时，把正文真正转换过去，
 * 而非只翻 contentType 标记（否则 Markdown 渲染器会把 HTML 标签当纯文本吐出，一片乱码）。
 * 仅覆盖知识文档常见结构（标题/段落/引用/列表/代码块/链接/图片/强调/分隔线），
 * 不追求完备的 CommonMark/HTML 兼容。
 */

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

// ── HTML → Markdown ──

function inlineMd(node: Node): string {
  let s = '';
  node.childNodes.forEach((c) => {
    if (c.nodeType === TEXT_NODE) { s += (c.textContent ?? '').replace(/\u00a0/g, ' '); return; }
    if (c.nodeType !== ELEMENT_NODE) return;
    const el = c as HTMLElement;
    const tag = el.tagName.toLowerCase();
    const inner = inlineMd(el);
    if (tag === 'br') s += '  \n';
    else if (tag === 'strong' || tag === 'b') s += inner.trim() ? `**${inner.trim()}**` : '';
    else if (tag === 'em' || tag === 'i') s += inner.trim() ? `*${inner.trim()}*` : '';
    else if (tag === 'code') s += '`' + inner + '`';
    else if (tag === 'a') s += `[${inner}](${el.getAttribute('href') ?? ''})`;
    else if (tag === 'img') s += `![${el.getAttribute('alt') ?? ''}](${el.getAttribute('src') ?? ''})`;
    else s += inner; // u / span / 其它 → 保留文本
  });
  return s;
}

const BLOCK_TAGS = /^(h[1-6]|p|div|ul|ol|li|blockquote|pre|hr|img|table|section|article)$/;

function walkBlocks(node: Node, out: string[]): void {
  node.childNodes.forEach((c) => {
    if (c.nodeType === TEXT_NODE) {
      const t = (c.textContent ?? '').replace(/\u00a0/g, ' ').trim();
      if (t) { out.push(t, ''); }
      return;
    }
    if (c.nodeType !== ELEMENT_NODE) return;
    const el = c as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      out.push('#'.repeat(Number(tag[1])) + ' ' + inlineMd(el).trim(), '');
    } else if (tag === 'blockquote') {
      inlineMd(el).trim().split('\n').forEach((l) => out.push('> ' + l.trim()));
      out.push('');
    } else if (tag === 'pre') {
      out.push('```', (el.textContent ?? '').replace(/\n$/, ''), '```', '');
    } else if (tag === 'ul' || tag === 'ol') {
      let i = 1;
      Array.from(el.children).forEach((li) => {
        if (li.tagName.toLowerCase() !== 'li') return;
        out.push((tag === 'ol' ? `${i++}. ` : '- ') + inlineMd(li).trim());
      });
      out.push('');
    } else if (tag === 'img') {
      out.push(`![${el.getAttribute('alt') ?? ''}](${el.getAttribute('src') ?? ''})`, '');
    } else if (tag === 'hr') {
      out.push('---', '');
    } else if (tag === 'br') {
      // 段间空行交给相邻块处理
    } else if (tag === 'p') {
      const m = inlineMd(el).trim();
      if (m) out.push(m, '');
    } else if (tag === 'div' || tag === 'section' || tag === 'article') {
      // div 既可能是块容器也可能是段落：含块级子元素则递归，否则当段落
      const hasBlockChild = Array.from(el.children).some((ch) => BLOCK_TAGS.test(ch.tagName.toLowerCase()));
      if (hasBlockChild) walkBlocks(el, out);
      else { const m = inlineMd(el).trim(); if (m) out.push(m, ''); }
    } else {
      const m = inlineMd(el).trim();
      if (m) out.push(m, '');
    }
  });
}

export function htmlToMarkdown(html: string): string {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  walkBlocks(doc.body, out);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Markdown → HTML（行级轻量，供切到富文本时使用）──

function inlineHtml(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;margin:6px 0;" />')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

export function markdownToHtml(md: string): string {
  if (!md) return '';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let inCode = false;
  const codeBuf: string[] = [];
  const closeList = () => { if (listType) { html.push(`</${listType}>`); listType = null; } };

  for (const raw of lines) {
    const line = raw;
    if (line.trim().startsWith('```')) {
      if (inCode) { html.push(`<pre>${codeBuf.join('\n').replace(/</g, '&lt;')}</pre>`); codeBuf.length = 0; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeList(); const lv = h[1].length; html.push(`<h${lv}>${inlineHtml(h[2].trim())}</h${lv}>`); continue; }
    if (/^>\s?/.test(line)) { closeList(); html.push(`<blockquote>${inlineHtml(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { closeList(); html.push('<hr />'); continue; }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ul) { if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; } html.push(`<li>${inlineHtml(ul[1])}</li>`); continue; }
    if (ol) { if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; } html.push(`<li>${inlineHtml(ol[1])}</li>`); continue; }
    if (line.trim() === '') { closeList(); continue; }
    closeList();
    html.push(`<p>${inlineHtml(line)}</p>`);
  }
  if (inCode && codeBuf.length) html.push(`<pre>${codeBuf.join('\n').replace(/</g, '&lt;')}</pre>`);
  closeList();
  return html.join('\n');
}
