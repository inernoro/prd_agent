// Mirrors the file extensions excluded by HostedSiteService from published ZIP sites.
const blockedExtensions = new Set([
  '.exe', '.dll', '.sh', '.bat', '.cmd', '.ps1', '.msi', '.com', '.scr', '.pif',
  '.vbs', '.vbe', '.wsf', '.wsh', '.jar', '.class', '.py', '.rb', '.php',
]);

export async function readZipEntryOptions(file: File) {
  // BlobReader 只读 ZIP 目录所需的范围，支持 ZIP64，也不会把整个大文件读进内存。
  const { BlobReader, ZipReader } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new BlobReader(file), { filenameEncoding: 'utf-8' });
  try {
    const entries = (await reader.getEntries()).filter(entry => !entry.directory);
    const first = entries[0]?.filename;
    const prefix = first?.includes('/') ? first.slice(0, first.indexOf('/') + 1) : '';
    const root = prefix && entries.every(entry => entry.filename.startsWith(prefix)) ? prefix : '';
    return entries.flatMap(entry => {
      const path = entry.filename.slice(root.length);
      const fileName = path.slice(path.lastIndexOf('/') + 1);
      const extension = fileName.match(/\.[^.]+$/)?.[0].toLowerCase() ?? '';
      if (path.startsWith('.') || path.startsWith('/') || path.includes('..')
        || path.startsWith('__MACOSX/') || path.includes('/__MACOSX/')) return [];
      if (!entry.uncompressedSize || entry.encrypted || blockedExtensions.has(extension)) return [];
      return [{ name: entry.filename, path }];
    }).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  } finally {
    await reader.close();
  }
}
