export const AVATAR_PATH_PREFIX = 'icon/backups/head';
export const DEFAULT_BOT_AVATAR_FILES: Record<string, string> = {
  pm: 'bot_pm.gif',
  dev: 'bot_dev.gif',
  qa: 'bot_qa.gif',
};
export const DEFAULT_NOHEAD_FILE = 'nohead.png';

function joinUrl(base: string, path: string) {
  const b = (base ?? '').trim().replace(/\/+$/, '');
  const p = (path ?? '').trim().replace(/^\/+/, '');
  // 优先使用“可配置前缀”（例如 https://...），但为了保证各页面始终有 src 占位，未配置时允许退化成相对路径（/icon/backups/head/xxx）
  if (!b) return p ? `/${p}` : '';
  if (!p) return b;
  return `${b}/${p}`;
}

export function getAvatarBaseUrl(): string {
  const raw = (import.meta.env.TENCENT_COS_PUBLIC_BASE_URL as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

export function resolveAvatarUrl(args: {
  username?: string | null;
  userType?: string | null; // Human/Bot
  botKind?: string | null; // PM/DEV/QA
  avatarFileName?: string | null;
}): string {
  // 头像 URL = TENCENT_COS_PUBLIC_BASE_URL + /icon/backups/head + /{file}
  // 不把域名/路径写入数据库；数据库只存 fileName。
  const cosBase = getAvatarBaseUrl();
  const base = joinUrl(cosBase, AVATAR_PATH_PREFIX);
  const fileRaw = (args.avatarFileName ?? '').trim();
  if (fileRaw) return joinUrl(base, fileRaw.toLowerCase());

  const isBot =
    String(args.userType || '').trim().toLowerCase() === 'bot' ||
    String(args.username || '').trim().toLowerCase().startsWith('bot_');

  if (isBot) {
    const kind =
      String(args.botKind || '')
        .trim()
        .toLowerCase() ||
      String(args.username || '')
        .trim()
        .toLowerCase()
        .replace(/^bot_/, '');
    const file2 = DEFAULT_BOT_AVATAR_FILES[kind];
    if (file2) return joinUrl(base, file2.toLowerCase());
    // botKind 异常时兜底 dev
    return joinUrl(base, DEFAULT_BOT_AVATAR_FILES.dev.toLowerCase());
  }

  const username = String(args.username || '').trim().toLowerCase();
  if (username) return joinUrl(base, `${username}.png`);

  return joinUrl(base, DEFAULT_NOHEAD_FILE);
}

export function resolveNoHeadAvatarUrl(): string {
  const cosBase = getAvatarBaseUrl();
  const base = joinUrl(cosBase, AVATAR_PATH_PREFIX);
  return joinUrl(base, DEFAULT_NOHEAD_FILE);
}


