export interface DesktopPresetServer {
  label: string;
  url: string;
}

export const DESKTOP_DEFAULT_API_URL = (
  import.meta.env.VITE_DESKTOP_API_BASE_URL as string | undefined
)?.trim() ?? '';

export function parseDesktopPresetServers(raw: string | undefined): DesktopPresetServer[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const label = typeof record.label === 'string' ? record.label.trim() : '';
      const url = typeof record.url === 'string' ? record.url.trim() : '';
      return label && /^https?:\/\//i.test(url) ? [{ label, url }] : [];
    });
  } catch {
    return [];
  }
}

export const DESKTOP_PRESET_SERVERS = parseDesktopPresetServers(
  import.meta.env.VITE_DESKTOP_PRESET_SERVERS_JSON,
);
