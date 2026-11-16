/** 与后端 HostedSiteUploadLimits 对齐；ZIP 包总量与单个资源分别限制。 */
export const HOSTED_SITE_MAX_PACKAGE_BYTES = 5000 * 1024 * 1024;
export const HOSTED_SITE_MAX_FILE_BYTES = 500 * 1024 * 1024;

/** 所有托管上传入口共用，图片与后端 WebPagesController.ImageExtensions 保持一致。 */
export const WEB_HOSTING_UPLOAD_EXTENSIONS = [
  '.html', '.htm', '.zip', '.md', '.markdown', '.pdf',
  '.mp4', '.webm', '.mov', '.m4v', '.ogg', '.ogv',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico', '.bmp',
] as const;
export const WEB_HOSTING_UPLOAD_ACCEPT = WEB_HOSTING_UPLOAD_EXTENSIONS.join(',');

export function getWebHostingUploadError(file: Pick<File, 'name' | 'size'>): string | null {
  const isZip = file.name.toLowerCase().endsWith('.zip');
  const limit = isZip ? HOSTED_SITE_MAX_PACKAGE_BYTES : HOSTED_SITE_MAX_FILE_BYTES;
  if (file.size <= 0) return '请选择非空文件';
  if (file.size > limit) return isZip
    ? 'ZIP 包不能超过 5000 MB，请缩小文件后再上传'
    : '单个文件不能超过 500 MB，请拆分大文件后再上传';
  return null;
}
