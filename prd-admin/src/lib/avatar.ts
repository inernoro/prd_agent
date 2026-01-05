export const AVATAR_PATH_PREFIX = 'icon/backups/head';
export const DEFAULT_BOT_AVATAR_FILES: Record<string, string> = {
  pm: 'bot_pm.gif',
  dev: 'bot_dev.gif',
  qa: 'bot_qa.gif',
};

function joinUrl(base: string, path: string) {
  const b = (base ?? '').trim().replace(/\/+$/, '');
  const p = (path ?? '').trim().replace(/^\/+/, '');
  // 头像必须依赖“可配置前缀”（例如 https://.../icon/backups/head/），不允许在未配置时退化成相对路径（如 /dev_robot.gif）
  if (!b) return '';
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
  if (!base) return '';
  const file = (args.avatarFileName ?? '').trim();
  if (file) return joinUrl(base, file);

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
    if (file2) return joinUrl(base, file2);
  }
  return '';
}


