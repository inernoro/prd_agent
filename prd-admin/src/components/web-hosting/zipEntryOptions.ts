// Mirrors the file extensions excluded by HostedSiteService from published ZIP sites.
const blockedExtensions = new Set([
  '.exe', '.dll', '.sh', '.bat', '.cmd', '.ps1', '.msi', '.com', '.scr', '.pif',
  '.vbs', '.vbe', '.wsf', '.wsh', '.jar', '.class', '.py', '.rb', '.php',
]);

export async function readZipEntryOptions(file: File) {
  // BlobReader 只读 ZIP 目录所需的范围，支持 ZIP64，也不会把整个大文件读进内存。
  const { BlobReader, ZipReader } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entries = (await reader.getEntries()).map((entry, index) => ({
      entry, index, name: entry.filename.replace(/\\/g, '/'),
    })).filter(({ entry, name }) => !entry.directory && !name.endsWith('/'));
    const first = entries[0]?.name;
    const prefix = first?.includes('/') ? first.slice(0, first.indexOf('/') + 1) : '';
    const root = prefix && entries.every(({ name }) => name.startsWith(prefix)) ? prefix : '';
    return entries.flatMap(({ entry, index, name }) => {
      const path = name.slice(root.length);
      const fileName = path.slice(path.lastIndexOf('/') + 1);
      const extension = fileName.match(/\.[^.]+$/)?.[0].toLowerCase() ?? '';
      if (!path || name.startsWith('/') || name.startsWith('../') || /^[a-z]:/i.test(name) || path.startsWith('.') || path.includes('..')
        || path.startsWith('__MACOSX/') || path.includes('/__MACOSX/')) return [];
      if (!entry.uncompressedSize || entry.encrypted || blockedExtensions.has(extension)) return [];
      return [{ index, path }];
    }).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  } finally {
    await reader.close();
  }
}
