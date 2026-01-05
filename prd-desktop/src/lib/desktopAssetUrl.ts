function normalizeKey(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/\\/g, '')
    .replace(/\//g, '');
}

export function buildDesktopAssetUrl(args: {
  baseUrl: string;
  key: string;
  skin?: string | null;
}): { skinUrl: string; baseUrl: string } {
  const b = String(args.baseUrl || '').trim().replace(/\/+$/, '');
  const k = normalizeKey(args.key);
  const s = String(args.skin || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();

  const base = b && k ? `${b}/icon/desktop/${k}` : '';
  const skinUrl = b && k && s ? `${b}/icon/desktop/${s}/${k}` : '';
  return { skinUrl, baseUrl: base };
}


