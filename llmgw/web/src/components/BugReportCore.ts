/**
 * 快捷提 bug 的纯逻辑层（无 React、无 DOM 依赖，可直接单测）。
 *
 * 拆出来的理由：快捷键判定与 payload 组装是最容易回归的两处
 * （抢占输入框、自动带入字段漏字段），必须能脱离浏览器断言。
 * cds/web 有一份等价实现（两个前端是独立包，无法跨包 import）。
 */

/** 缺陷严重程度，与 MAP 缺陷系统的 DefectSeverity 取值一致。 */
export type BugSeverity = 'critical' | 'major' | 'minor' | 'trivial';

export const BUG_SEVERITY_OPTIONS: Array<{ value: BugSeverity; label: string }> = [
  { value: 'critical', label: '致命' },
  { value: 'major', label: '严重' },
  { value: 'minor', label: '一般' },
  { value: 'trivial', label: '轻微' },
];

/** 键盘事件的最小结构（便于测试构造假事件，不依赖 DOM KeyboardEvent）。 */
export interface ShortcutEventLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  target?: unknown;
}

/**
 * 目标是否为可编辑元素（input / textarea / contenteditable）。
 * 用结构化判断而不是 instanceof，测试里可以传普通对象。
 */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const node = target as { tagName?: unknown; isContentEditable?: unknown; getAttribute?: unknown };
  if (node.isContentEditable === true) return true;
  const tag = typeof node.tagName === 'string' ? node.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * 是否应当触发「快捷提 bug」。
 *
 * 规则：
 *  - Control+B（Windows/Linux）或 Command+B（Mac）都算命中；
 *  - Alt 组合不算（避免抢占浏览器/输入法既有组合键）；
 *  - 长按重复触发（repeat）不算；
 *  - 焦点在 input / textarea / contenteditable 上时**不抢占**——用户可能在
 *    用输入法或编辑器的加粗快捷键。
 */
export function shouldTriggerBugReportShortcut(event: ShortcutEventLike): boolean {
  if (typeof event.key !== 'string' || event.key.toLowerCase() !== 'b') return false;
  if (!(event.metaKey === true || event.ctrlKey === true)) return false;
  if (event.altKey === true) return false;
  if (event.repeat === true) return false;
  if (isEditableTarget(event.target)) return false;
  return true;
}

/** 快捷键提示文案：Mac 显示 Command，其他平台显示 Control。 */
export function shortcutHint(platform: string | undefined): string {
  const isMac = typeof platform === 'string' && /mac|iphone|ipad/i.test(platform);
  return isMac ? 'Command+B' : 'Ctrl+B';
}

/** 自动采集的环境信息（用户不需要手填的部分）。 */
export interface BugReportEnvironment {
  /** 完整地址（含 query / hash）。 */
  url: string;
  /** 路由路径（不含域名），便于按页面聚合。 */
  route: string;
  /** 来源页。 */
  referrer: string;
  userAgent: string;
  /** 视口尺寸，形如 1440x900。 */
  viewport: string;
  /** 屏幕尺寸 + 像素比。 */
  screen: string;
  language: string;
  /** 当前主题（暗色/白天），复现视觉类缺陷必备。 */
  theme: string;
  /** 客户端本地时间（ISO）。 */
  occurredAt: string;
}

/** collectBugReportEnvironment 的输入源（结构化，便于测试注入假 window）。 */
export interface EnvironmentSource {
  location?: { href?: string; pathname?: string; search?: string; hash?: string };
  document?: { referrer?: string; documentElement?: { getAttribute?: (name: string) => string | null } };
  navigator?: { userAgent?: string; language?: string };
  innerWidth?: number;
  innerHeight?: number;
  screen?: { width?: number; height?: number };
  devicePixelRatio?: number;
}

/** 采集环境信息。任何字段取不到都退化为 'unknown'，不抛异常。 */
export function collectBugReportEnvironment(
  source: EnvironmentSource | undefined,
  now: Date = new Date(),
): BugReportEnvironment {
  const loc = source?.location ?? {};
  const route = `${loc.pathname ?? ''}${loc.search ?? ''}${loc.hash ?? ''}` || 'unknown';
  const width = source?.innerWidth;
  const height = source?.innerHeight;
  const screenWidth = source?.screen?.width;
  const screenHeight = source?.screen?.height;
  const dpr = source?.devicePixelRatio;
  const themeAttr = source?.document?.documentElement?.getAttribute?.('data-theme') ?? null;
  return {
    url: loc.href || 'unknown',
    route,
    referrer: source?.document?.referrer || '',
    userAgent: source?.navigator?.userAgent || 'unknown',
    viewport: width && height ? `${width}x${height}` : 'unknown',
    screen: screenWidth && screenHeight
      ? `${screenWidth}x${screenHeight}${dpr ? `@${dpr}x` : ''}`
      : 'unknown',
    language: source?.navigator?.language || 'unknown',
    theme: themeAttr || 'unknown',
    occurredAt: now.toISOString(),
  };
}

/** 附件（截图）的传输结构：base64 不含 data: 前缀。 */
export interface BugReportAttachment {
  name: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}

/** 用户填写的部分。 */
export interface BugReportDraft {
  title: string;
  description: string;
  severity: BugSeverity;
  attachments?: BugReportAttachment[];
}

/** 提交给后端的完整 payload。 */
export interface BugReportPayload {
  /** 来源前端，后端据此打标签。 */
  source: string;
  title: string;
  description: string;
  severity: BugSeverity;
  environment: BugReportEnvironment;
  attachments: BugReportAttachment[];
  /** 组装好的正文：描述 + 环境附录，缺陷系统可直接落库展示。 */
  content: string;
}

/** 从描述里提取标题（首个非空行，超长截断），与 MAP 缺陷面板口径一致。 */
export function deriveTitleFromDescription(description: string): string {
  for (const line of description.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.length > 100 ? `${trimmed.slice(0, 100)}...` : trimmed;
  }
  return '';
}

/** 校验草稿。返回 null 表示通过，否则返回中文错误原因。 */
export function validateBugReportDraft(draft: BugReportDraft): string | null {
  if (!draft.description || !draft.description.trim()) return '请填写问题描述';
  if (!BUG_SEVERITY_OPTIONS.some((opt) => opt.value === draft.severity)) return '严重程度取值非法';
  return null;
}

/** 环境附录的中文标签，UI 与后端正文共用同一份口径。 */
const ENVIRONMENT_LABELS: Array<[keyof BugReportEnvironment, string]> = [
  ['url', '页面地址'],
  ['route', '路由'],
  ['theme', '主题'],
  ['viewport', '视口'],
  ['screen', '屏幕'],
  ['userAgent', '浏览器'],
  ['language', '语言'],
  ['referrer', '来源页'],
  ['occurredAt', '发生时间'],
];

/** 把环境信息渲染成正文附录（Markdown 列表）。 */
export function renderEnvironmentSection(env: BugReportEnvironment): string {
  const lines = ENVIRONMENT_LABELS
    .filter(([key]) => Boolean(env[key]))
    .map(([key, label]) => `- ${label}：${env[key]}`);
  return `## 环境信息（自动采集）\n${lines.join('\n')}`;
}

/** 组装最终 payload：补标题、拼正文附录、附件兜底为空数组。 */
export function buildBugReportPayload(input: {
  source: string;
  draft: BugReportDraft;
  environment: BugReportEnvironment;
}): BugReportPayload {
  const description = input.draft.description.trim();
  const title = input.draft.title.trim() || deriveTitleFromDescription(description) || '未命名缺陷';
  const attachments = input.draft.attachments ?? [];
  const attachmentSection = attachments.length > 0
    ? `\n\n## 附件\n${attachments.map((a) => `- ${a.name}（${a.mimeType || '未知类型'}）`).join('\n')}`
    : '';
  return {
    source: input.source,
    title,
    description,
    severity: input.draft.severity,
    environment: input.environment,
    attachments,
    content: `${description}\n\n${renderEnvironmentSection(input.environment)}${attachmentSection}`,
  };
}

/** 单个附件大小上限（5 MB），超出直接在前端拒绝，避免打爆请求体。 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** 附件数量上限。 */
export const MAX_ATTACHMENT_COUNT = 4;

/** 提交结果的投递去向，决定 UI 说什么话（禁止假装成功）。 */
export type BugReportDelivery = 'forwarded' | 'local';

export interface BugReportSubmitResult {
  id: string;
  delivery: BugReportDelivery;
  /** 投递到缺陷系统后的编号 / 链接（本地留存时为空）。 */
  reference?: string | null;
  /** 未能投递到缺陷系统时的原因（如「未配置转发」「转发失败：401」）。 */
  degradeReason?: string | null;
}

/** 依据投递结果给出用户可见的结论文案，绝不把本地留存说成已同步。 */
export function describeSubmitResult(result: BugReportSubmitResult): string {
  if (result.delivery === 'forwarded') {
    return result.reference
      ? `已提交到缺陷系统（${result.reference}）`
      : '已提交到缺陷系统';
  }
  const reason = result.degradeReason ? `：${result.degradeReason}` : '';
  return `已记录到本地待办，未同步到缺陷系统${reason}`;
}
