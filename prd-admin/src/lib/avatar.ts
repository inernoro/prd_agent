import { useAuthStore } from '@/stores/authStore';

/**
 * 内联 SVG 默认头像（data URI）
 * 当 CDN 头像加载失败时的终极兜底，无需网络请求，永不失败。
 * 设计：深色圆形底 + 靛紫描边 + 半透明用户剪影，匹配项目液态玻璃视觉风格。
 */
const _DEFAULT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#18182a"/><circle cx="32" cy="32" r="30.5" fill="none" stroke="#6366f1" stroke-opacity=".25" stroke-width="1.2"/><circle cx="32" cy="25" r="8" fill="#6366f1" fill-opacity=".5"/><path d="M18 53c0-10 6-15 14-15s14 5 14 15" fill="#6366f1" fill-opacity=".5"/></svg>`;
export const DEFAULT_AVATAR_FALLBACK = `data:image/svg+xml,${encodeURIComponent(_DEFAULT_AVATAR_SVG)}`;

export const AVATAR_PATH_PREFIX = 'icon/backups/head';
export const DEFAULT_BOT_AVATAR_FILES: Record<string, string> = {
  pm: 'bot_pm.gif',
  dev: 'bot_dev.gif',
  qa: 'bot_qa.gif',
};
export const DEFAULT_NOHEAD_FILE = 'nohead.png';

/**
 * 同源的轻量默认头像（128px WebP，几 KB）。
 *
 * 对象存储上的 nohead.png 是一张 1024×1536、3 MB 的原图，每个未设头像的用户、每一屏都要跨域拉一次；
 * 2026-09-14 稳定冒烟在业务首页记到「头像备用资源加载失败两次」——慢链路下这张图要么超时、
 * 要么被页面切换中断，浏览器里就是一枚碎图。默认头像不该依赖任何外部网络，所以它随前端一起打包。
 */
export const LOCAL_NOHEAD_AVATAR = `${(import.meta.env?.BASE_URL || '/').replace(/\/+$/, '')}/avatars/nohead.webp`;

/** 服务端下发的地址是不是对象存储上的那张默认头像：是就换成同源轻量版，不再跨域拉 3 MB。 */
export function isRemoteNoHeadAvatarUrl(value?: string | null): boolean {
  const raw = (value ?? '').trim();
  if (!raw) return false;
  const path = raw.replace(/[?#].*$/, '');
  return new RegExp(`/${AVATAR_PATH_PREFIX}/${DEFAULT_NOHEAD_FILE}$`, 'i').test(path);
}

/**
 * 用户头像信息接口
 * 
 * 【重要】在模型中存储用户信息时，必须使用 avatarFileName 而非 username 来获取头像！
 * - username 已不再用于拼接头像 URL（之前会拼成 `{username}.png` 但文件不存在）
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
  return normalizePublicAssetBaseUrl(useAuthStore.getState().cdnBaseUrl);
}

export function normalizePublicAssetBaseUrl(value?: string | null): string {
  const raw = (value ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? raw : '';
  } catch {
    return '';
  }
}

function normalizeRenderableAssetUrl(value?: string | null): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('/')) return raw;
  return normalizePublicAssetBaseUrl(raw);
}

export function resolveAvatarUrl(args: {
  username?: string | null;
  userType?: string | null; // Human/Bot
  botKind?: string | null; // PM/DEV/QA
  avatarFileName?: string | null;
  /** 服务端下发的完整 URL（若存在且非空，直接使用） */
  avatarUrl?: string | null;
}): string {
  // 1. 优先使用服务端下发的完整 URL（如果有）；默认头像例外，走同源轻量版
  const directUrl = normalizeRenderableAssetUrl(args.avatarUrl);
  if (directUrl) return isRemoteNoHeadAvatarUrl(directUrl) ? LOCAL_NOHEAD_AVATAR : directUrl;

  // 头像 URL = TENCENT_COS_PUBLIC_BASE_URL + /icon/backups/head + /{file}
  // 不把域名/路径写入数据库；数据库只存 fileName。
  const cosBase = getAvatarBaseUrl();
  const fileRaw = (args.avatarFileName ?? '').trim();
  if (fileRaw.toLowerCase() === DEFAULT_NOHEAD_FILE) return LOCAL_NOHEAD_AVATAR;
  if (!cosBase) return DEFAULT_AVATAR_FALLBACK;
  const base = joinUrl(cosBase, AVATAR_PATH_PREFIX);
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

  // 人类用户未设置头像：用同源轻量默认头像（不拼接不存在的 {username}.png，也不跨域拉原图）
  return LOCAL_NOHEAD_AVATAR;
}

export function resolveNoHeadAvatarUrl(): string {
  return LOCAL_NOHEAD_AVATAR;
}

/**
 * 对象存储上由管理员托管的那张默认头像（资源管理页「无头像兜底」上传的目标）。
 * 管理端页面自己已改用同源打包版，但服务端 `avatarUrl` 仍把它下发给桌面端等其它客户端，
 * 所以上传流程与预览要继续指向真实的对象存储地址，不能拿打包版冒充「你刚上传的那张」。
 */
export function resolveManagedNoHeadAvatarUrl(): string {
  const cosBase = getAvatarBaseUrl();
  if (!cosBase) return '';
  return joinUrl(joinUrl(cosBase, AVATAR_PATH_PREFIX), DEFAULT_NOHEAD_FILE);
}

