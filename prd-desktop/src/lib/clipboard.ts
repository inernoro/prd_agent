import { isTauri } from './tauri';

function resolveUrl(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    // 兼容相对路径
    return new URL(s, window.location.href).toString();
  } catch {
    return s;
  }
}

async function fallbackCopyText(text: string) {
  // 兜底：旧 WebView / 非安全上下文可能没有 navigator.clipboard
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', 'true');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  ta.style.top = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('execCommand(copy) failed');
  } finally {
    document.body.removeChild(ta);
  }
}

export async function copyText(text: string): Promise<void> {
  const s = String(text ?? '');
  if (!s) return;

  // Tauri：优先使用系统剪贴板插件（不依赖浏览器权限/安全上下文）
  if (isTauri()) {
    const mod = await import('@tauri-apps/plugin-clipboard-manager');
    await mod.writeText(s);
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(s);
    return;
  }

  await fallbackCopyText(s);
}

function escapeMdCell(raw: string) {
  const s = String(raw ?? '').replace(/\r\n/g, '\n');
  // Markdown 表格：换行改为 <br/>；竖线要转义
  return s.replace(/\|/g, '\\|').replace(/\n/g, '<br/>').trim();
}

function rowToMarkdown(cells: string[], colCount: number) {
  const padded = cells.slice(0, colCount);
  while (padded.length < colCount) padded.push('');
  return `| ${padded.map(escapeMdCell).join(' | ')} |`;
}

export function tableElementToMarkdown(table: HTMLTableElement): string {
  if (!table) return '';

  const headRows = Array.from(table.tHead?.rows || []);
  const bodyRows = Array.from(table.tBodies?.[0]?.rows || []);

  // fallback：没有 thead 时，把第一行当 header
  const headerRow = headRows[0] || bodyRows[0] || null;
  const bodyStartIndex = headRows.length > 0 ? 0 : (bodyRows.length > 0 ? 1 : 0);

  if (!headerRow) return '';

  const headerCells = Array.from(headerRow.cells).map((c) => c.innerText ?? c.textContent ?? '');
  const bodyCells = bodyRows.slice(bodyStartIndex).map((r) =>
    Array.from(r.cells).map((c) => c.innerText ?? c.textContent ?? '')
  );

  const colCount = Math.max(
    headerCells.length,
    ...bodyCells.map((r) => r.length)
  );
  if (!Number.isFinite(colCount) || colCount <= 0) return '';

  const lines: string[] = [];
  lines.push(rowToMarkdown(headerCells, colCount));
  lines.push(`| ${Array.from({ length: colCount }).map(() => '---').join(' | ')} |`);
  for (const r of bodyCells) lines.push(rowToMarkdown(r, colCount));
  return lines.join('\n');
}

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    // 尽量允许跨域（需要服务器允许 CORS 才能读像素）
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

async function imageUrlToRgba(srcRaw: string) {
  const src = resolveUrl(srcRaw);
  if (!src) throw new Error('图片地址为空');

  // 优先 fetch -> createImageBitmap（更稳定），失败再退回 <img/>
  let bitmap: ImageBitmap | null = null;
  try {
    const resp = await fetch(src);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    bitmap = await createImageBitmap(blob);
  } catch {
    bitmap = null;
  }

  let width = 0;
  let height = 0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 不可用');

  if (bitmap) {
    width = Math.max(1, Math.floor(bitmap.width));
    height = Math.max(1, Math.floor(bitmap.height));
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  } else {
    const img = await loadImageElement(src);
    width = Math.max(1, Math.floor(img.naturalWidth || img.width));
    height = Math.max(1, Math.floor(img.naturalHeight || img.height));
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(img, 0, 0);
  }

  const imageData = ctx.getImageData(0, 0, width, height);
  return { rgba: new Uint8Array(imageData.data), width, height };
}

export async function copyImageFromUrl(src: string): Promise<void> {
  if (!isTauri()) {
    throw new Error('当前环境不支持复制图片到剪贴板');
  }

  const { rgba, width, height } = await imageUrlToRgba(src);
  const { Image } = await import('@tauri-apps/api/image');
  const { writeImage } = await import('@tauri-apps/plugin-clipboard-manager');
  const img = await Image.new(rgba, width, height);
  await writeImage(img);
}


