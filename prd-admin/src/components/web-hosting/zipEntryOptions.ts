export async function readZipEntryOptions(file: File) {
  // BlobReader 只读 ZIP 目录所需的范围，支持 ZIP64，也不会把整个大文件读进内存。
  const { BlobReader, ZipReader } = await import('@zip.js/zip.js');
  const reader = new ZipReader(new BlobReader(file), { filenameEncoding: 'utf-8' });
  try {
    const entries = (await reader.getEntries()).filter(entry => !entry.directory);
    const first = entries[0]?.filename;
    const prefix = first?.includes('/') ? first.slice(0, first.indexOf('/') + 1) : '';
    const root = prefix && entries.every(entry => entry.filename.startsWith(prefix)) ? prefix : '';
    const candidates = entries.flatMap(entry => {
      if (!entry.uncompressedSize || entry.encrypted) return [];
      const path = entry.filename.slice(root.length);
      if (path.startsWith('.') || path.startsWith('/') || path.includes('..')
        || path.startsWith('__MACOSX/') || path.includes('/__MACOSX/')) return [];
      return /\.(html?|md|markdown)$/i.test(path) ? [{ name: entry.filename, path }] : [];
    });
    const html = candidates.filter(entry => /\.html?$/i.test(entry.path));
    const automatic = html.find(entry => /^index\.html$/i.test(entry.path))
      ?? html.find(entry => /^index\.htm$/i.test(entry.path))
      ?? html[0];
    return { candidates, automatic: automatic?.path };
  } finally {
    await reader.close();
  }
}
