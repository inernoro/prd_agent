import { useAuthStore } from '@/stores/authStore';

export const AVATAR_PATH_PREFIX = 'icon/backups/head';
export const DEFAULT_BOT_AVATAR_FILES: Record<string, string> = {
  pm: 'bot_pm.gif',
  dev: 'bot_dev.gif',
  qa: 'bot_qa.gif',
};
export const DEFAULT_NOHEAD_FILE = 'nohead.png';

/**
 * 用户头像信息接口
 * 
 * 【重要】在模型中存储用户信息时，必须使用 avatarFileName 而非 username 来获取头像！
 * - username 会被拼接成 `{username}.png`，无法正确显示 .gif 等其他格式的头像
 * - avatarFileName 是用户实际的头像文件名，如 `admin.gif`、`test.png` 等
 * 
 * 示例（后端模型）：
 * ```csharp
 * public string? ReporterAvatarFileName { get; set; }  // ✓ 正确
 * public string? ReporterUsername { get; set; }        // ✗ 错误 - 不要用于头像
 * ```
 * 
 * 示例（前端调用）：
 * ```typescript
 * resolveAvatarUrl({ avatarFileName: user.avatarFileName })  // ✓ 正确
 * resolveAvatarUrl({ username: user.username })              // ✗ 错误
 * ```
 */
export interface UserAvatarInfo {
  /** 头像文件名（如 admin.gif）- 用于获取头像 */
  avatarFileName?: string | null;
  /** 显示名称 - 用于 alt 文本和 fallback */
  displayName?: string | null;
}

/**
 * 从用户头像信息获取头像 URL
 * 这是推荐的获取用户头像的方式
 */
export function getUserAvatarUrl(info: UserAvatarInfo): string {
  return resolveAvatarUrl({ avatarFileName: info.avatarFileName });
}

function joinUrl(base: string, path: string) {
  const b = (base ?? '').trim().replace(/\/+$/, '');
  const p = (path ?? '').trim().replace(/^\/+/, '');
  // 优先使用“可配置前缀”（例如 https://...），但为了保证各页面始终有 src 占位，未配置时允许退化成相对路径（/icon/backups/head/xxx）
  if (!b) return p ? `/${p}` : '';
  if (!p) return b;
  return `${b}/${p}`;
}

/**
 * 获取 CDN 基础地址：从 authStore 读取（后端 /api/authz/me 下发）。
 * 前端不硬编码任何域名，域名迁移只需改后端环境变量。
 */
export function getAvatarBaseUrl(): string {
  return useAuthStore.getState().cdnBaseUrl ?? '';
}

export function resolveAvatarUrl(args: {
  username?: string | null;
  userType?: string | null; // Human/Bot
  botKind?: string | null; // PM/DEV/QA
  avatarFileName?: string | null;
  /** 服务端下发的完整 URL（若存在且非空，直接使用） */
  avatarUrl?: string | null;
}): string {
  // 1. 优先使用服务端下发的完整 URL（如果有）
  const directUrl = (args.avatarUrl ?? '').trim();
  if (directUrl) return directUrl;

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


