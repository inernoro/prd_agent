import JSZip from 'jszip';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp']);
const MAX_GALLERY_IMAGES = 50;
const MAX_GALLERY_BYTES = 100 * 1024 * 1024;

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char] ?? char);
}

export function isGallerySelection(files: readonly File[]): boolean {
  return files.length > 1 && files.every(file => file.size > 0 && IMAGE_EXTENSIONS.has(extensionOf(file.name)));
}

export function renderGalleryHtml(items: readonly { name: string; path: string }[]): string {
  const figures = items.map(item =>
    `<figure><img src="${item.path}" alt="${escapeHtml(item.name)}" loading="lazy" /><figcaption>${escapeHtml(item.name)}</figcaption></figure>`
  ).join('\n');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'" />
<title>图片画廊</title><style>
:root{color-scheme:light dark}body{margin:0;padding:24px;background:Canvas;color:CanvasText;font-family:system-ui,sans-serif}
h1{max-width:1200px;margin:0 auto 24px}.gallery{max-width:1200px;margin:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:20px}
figure{margin:0;background:Canvas;border:1px solid color-mix(in srgb, CanvasText 20%, Canvas);border-radius:12px;overflow:hidden}img{display:block;width:100%;height:320px;object-fit:contain}figcaption{padding:10px 14px;overflow-wrap:anywhere}
</style></head><body><h1>图片画廊</h1><main class="gallery">${figures}</main></body></html>`;
}

/** 多图变成标准 HTML+图片 ZIP，沿用现有托管与分享链，不在 MongoDB 保存图片字节。 */
export async function createImageGalleryZip(files: readonly File[]): Promise<File> {
  if (files.some(file => file.size === 0))
    throw new Error('图片不能为空，请移除空文件后重试');
  if (!isGallerySelection(files))
    throw new Error('多图展示请选择至少两张支持的图片');
  if (files.length > MAX_GALLERY_IMAGES)
    throw new Error(`一次最多上传 ${MAX_GALLERY_IMAGES} 张图片`);
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_GALLERY_BYTES)
    throw new Error('多图合计不能超过 100MB，请分批上传');

  const zip = new JSZip();
  const items: { name: string; path: string }[] = [];
  for (const [index, file] of files.entries()) {
    const path = `images/image-${String(index + 1).padStart(2, '0')}${extensionOf(file.name)}`;
    zip.file(path, await file.arrayBuffer());
    items.push({ name: file.name, path });
  }
  zip.file('index.html', renderGalleryHtml(items));
  const bytes = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return new File([bytes], `图片画廊-${files.length}张.zip`, { type: 'application/zip' });
}
