export type UserReadableErrorOptions = {
  fallbackMessage: string;
  recoveryMessage: string;
  code?: string | null;
};

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  error?: unknown;
};

const RECOVERY_WORDS = [
  '重试',
  '重新',
  '稍后',
  '检查',
  '更换',
  '减少',
  '上传',
  '输入',
  '选择',
  '登录',
  '联系管理员',
  '返回',
  '取消',
  '移除',
];

const INTERNAL_DIAGNOSTIC_PATTERNS = [
  /\bHTTP\s*\d{3}\b/i,
  /\b(?:traceId|requestId|runId|provider|offering|endpoint|model|protocol|token|stack|exception)\b/i,
  /\/api\//i,
  /<!doctype|<html|<body/i,
  /input must have at least/i,
  /unexpected token/i,
  /failed to fetch|networkerror|load failed/i,
  /system\.(?:invalidoperation|exception)/i,
  /\b(?:econnrefused|econnreset|enotfound|etimedout|socket|authorization|api[ _-]?key|secret|password)\b/i,
  /\b(?:sk|pk|rk)-[a-z0-9_-]{6,}\b/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/,
  /https?:\/\//i,
];

const USER_MESSAGE_ALLOWLIST = new Map<string, ReadonlySet<string>>([
  ['INVALID_FORMAT', new Set([
    '文件内容无法解析',
    '文件格式不受支持，请更换文件后重试。',
    '头像上传未完成，请稍后重新上传。',
  ])],
  ['AVATAR_SOURCE_UNAVAILABLE', new Set([
    '当前头像无法用于生成，请重新上传一张清晰图片后重试。',
  ])],
]);

const USER_FACING_CODE_MESSAGES = new Map<string, string>([
  ['NOT_FOUND', '目标内容不存在或已被删除，请返回后刷新列表。'],
  ['CONTENT_EMPTY', '提交内容为空，请输入内容后重试。'],
  ['DOCUMENT_NOT_FOUND', '目标文档不存在或已被删除，请返回后刷新列表。'],
  ['DOCUMENT_ASSET_CLEANUP_FAILED', '文件清理暂时未完成，请稍后重试删除。'],
  ['SESSION_NOT_FOUND', '当前会话不存在或已失效，请返回后重新打开。'],
  ['SESSION_EXPIRED', '当前会话已过期，请返回后重新打开。'],
  ['INVALID_CREDENTIALS', '用户名或密码错误，请检查后重新登录。'],
  ['USERNAME_EXISTS', '用户名已存在，请更换用户名后重试。'],
  ['INVALID_INVITE_CODE', '邀请码无效或已使用，请更换邀请码后重试。'],
  ['INVALID_INVITE_LINK', '邀请入口无效，请联系邀请人重新生成。'],
  ['INVITE_EXPIRED', '邀请码已过期，请联系邀请人重新生成。'],
  ['ALREADY_MEMBER', '当前账号已加入该群组，请返回群组列表查看。'],
  ['GROUP_FULL', '群组人数已达上限，请联系群组管理员处理。'],
  ['GROUP_NOT_FOUND', '目标群组不存在或已被删除，请返回后刷新列表。'],
  ['ACCOUNT_DISABLED', '账号已被禁用，请联系管理员处理。'],
  ['PASSWORD_LOGIN_DISABLED', '当前环境已禁用密码登录，请使用 SSO 登录。'],
  ['SSO_PROVIDER_DISABLED', 'SSO 提供方尚未启用，请联系管理员启用后重试。'],
  ['SSO_DISABLED', '当前 SSO 登录已停用，请改用页面上的其他登录方式，或联系管理员处理。'],
  ['SSO_AUTHORIZE_INVALID', 'SSO 授权参数无效，请返回模型网关重新发起登录。'],
  ['SSO_ADMIN_REQUIRED', '当前账号不是管理员，无法进入外部控制台，请使用管理员账号登录后重试。'],
  ['SSO_BINDING_DUPLICATED', '米多星球账号绑定不唯一，请联系管理员处理。'],
  ['SSO_AUTO_CREATE_FAILED', '米多星球账号自动创建未完成，请稍后重试。'],
  ['MIDUO_SSO_NOT_CONFIGURED', '米多星球 SSO 尚未配置，请先在系统设置中配置 appCode 后重试。'],
  ['SSO_BINDING_EXISTS', '该米多星球绑定值已被其他用户使用，请先解除原绑定或更换绑定值后重试。'],
  ['MAP_SSO_BROWSER_SESSION_REQUIRED', '当前会话不能进入模型网关，请先通过管理后台登录后重试。'],
  ['MAP_ADMIN_REQUIRED', '当前账号不是管理员，无法进入模型网关，请使用管理员账号登录后重试。'],
  ['SYNTHETIC_SESSION_FEDERATION_FORBIDDEN', '合成测试会话不能进入外部控制台，请使用真人管理员账号登录后重试。'],
  ['PASSWORD_MISMATCH', '两次输入的密码不一致，请重新输入。'],
  ['WEAK_PASSWORD', '新密码不符合强度要求，请按页面规则调整后重试。'],
  ['USER_NOT_FOUND', '用户不存在，请返回后重新选择。'],
  ['TEAM_LEADER_TRANSFER_REQUIRED', '团队负责人不能直接退出，请先在成员管理中将负责人移交给其他成员。'],
  ['INVALID_CONFIG', '模型配置不完整，请先在模型平台补充 API 地址和密钥后再测试。'],
  ['PROFILE_KEY_EMPTY', '运行配置缺少可用密钥，请先在模型平台完成配置后重试。'],
  ['UNSUPPORTED_TYPE', '当前文件类型不受支持，请更换文件类型后重试。'],
  ['GENERATION_FAILED', '智能生成未完成，请稍后重试。'],
  ['AI_GENERATION_FAILED', '智能生成未完成，请稍后重试。'],
  ['AVATAR_GENERATION_FAILED', '头像生成未完成，请稍后重试。'],
  ['DUPLICATE_MODEL', '该模型名称已存在，请刷新模型列表后确认；如需新增，请改用其他模型名称。'],
  ['DUPLICATE_NAME', '该名称已存在，请刷新列表后确认；如需新增，请改用其他名称。'],
  ['SYNTHETIC_LOGIN_DISABLED', '合成测试登录未启用，请由管理员开启后重新生成入口。'],
  ['SYNTHETIC_LOGIN_ACCOUNT_NOT_ALLOWED', '当前账号不是合成测试专用账号，请更换已授权账号后重试。'],
  ['SYNTHETIC_LOGIN_RETURN_URL_INVALID', '目标页面必须是当前站点内的有效路径，请修改后重试。'],
  ['SYNTHETIC_LOGIN_ACCOUNT_UNAVAILABLE', '合成测试账号不可用，请检查账号状态后重新生成入口。'],
  ['SYNTHETIC_LOGIN_TICKET_INVALID', '一次性登录入口已失效，请重新生成后再试。'],
  ['INVALID_ATTACHMENT_TYPE', '附件格式不受支持，请更换文件后重新上传。'],
  ['INVALID_ATTACHMENT', '评论中包含已失效或无权使用的图片，请移除后重新上传再提交。'],
  ['ATTACHMENT_TOO_LARGE', '附件超过当前大小限制，请缩小文件后重新上传。'],
  ['UPLOAD_TIMEOUT', '附件上传超时，请检查网络后重新上传。'],
  ['LLM_ERROR', '智能处理未完成，请稍后重试。'],
  ['INTERNAL_ERROR', '服务处理未完成，请稍后重试。'],
  ['PRD_COMMENT_NOT_FOUND', '目标评论不存在或已被删除，请刷新页面后重试。'],
  ['NO_PRD_DOCUMENT', '当前群组尚未绑定 PRD 文档，请先在群组设置中绑定后重试。'],
  ['WORKSPACE_NOT_FOUND', '当前视觉项目不存在或已被删除，请返回项目列表并刷新后重新打开。'],
  ['IMAGE_GEN_RUN_NOT_FOUND', '图片生成任务不存在或已失效，请重新发起生成。'],
  ['IMAGE_GEN_UNAVAILABLE', '图片生成服务暂时不可用，请稍后重新生成。'],
  ['IMAGE_GEN_REQUEST_REJECTED', '图片生成请求未被接受，请调整描述或素材后重试。'],
  ['IMAGE_GEN_TIMEOUT', '图片生成等待超时，请稍后查看结果或重新生成。'],
  ['ASSET_NOT_FOUND', '这张生成图片已失效，请重新生成预览后再使用。'],
  ['AVATAR_NOT_FOUND', '头像文件已失效，请重新上传或生成后再试。'],
  ['AVATAR_STORAGE_UNAVAILABLE', '头像存储暂时不可用，原头像未变更，请稍后重试。'],
  ['TAPD_AUTH_INVALID', 'TAPD 登录凭据已失效，请刷新并替换 TAPD Cookie 后重试。'],
  ['PLAN_TITLE_DUPLICATE', '已存在同名计划，请修改标题后重试。'],
  ['INVALID_STATE', '内容状态已发生变化，请刷新页面确认后重试。'],
  ['STALE_UPDATE', '内容已被其他操作更新，请刷新页面后重新提交。'],
  ['QUOTA_EXCEEDED', '当前可用额度不足，请联系管理员补充额度后重试。'],
  ['LLM_QUOTA_EXCEEDED', '当前可用额度不足，请联系管理员补充额度或切换可用配置后重试。'],
  ['WORKSPACE_GENERATION_ACTIVE', '该项目仍有图片正在生成，请先取消任务并等待状态结束后再删除。'],
  ['HAS_MODELS', '该平台下仍有模型，请刷新页面确认后选择级联删除，或先移除模型再重试。'],
  ['SHARE_EXPIRED', '分享入口已过期，请联系分享者重新生成。'],
  ['SHARE_REVOKED', '分享入口已被撤销，请联系分享者重新生成。'],
  ['DUPLICATE', '相同内容已存在，请刷新确认或修改后重试。'],
  ['ALREADY_EXISTS', '相同内容已存在，请返回列表刷新并查看已有内容。'],
  ['TEMPLATE_VALIDATION_FAILED', '提交内容不符合模板要求，请按页面提示补全后重试。'],
]);

function registeredUserFacingMessage(code: string, message: string): string | null {
  const normalized = code.trim().toUpperCase();
  if (normalized === 'ACCOUNT_LOCKED') {
    const seconds = message.match(/^账号已被锁定，请在\s+(\d{1,6})\s+秒后重试。?$/)?.[1];
    return seconds
      ? `账号已被锁定，请在 ${seconds} 秒后重试。`
      : '账号已被锁定，请稍后重试。';
  }
  return USER_FACING_CODE_MESSAGES.get(normalized) ?? null;
}

function extractErrorLike(value: unknown): { code?: string; message?: string } {
  if (!value) return {};
  if (value instanceof Error) return { message: value.message };
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return {};
    if (/^[{[]/.test(text)) {
      try {
        return extractErrorLike(JSON.parse(text) as unknown);
      } catch {
        return { message: text };
      }
    }
    return { message: text };
  }
  if (typeof value !== 'object') return {};

  const candidate = value as ErrorLike;
  const nested = extractErrorLike(candidate.error);
  const code = typeof candidate.code === 'string' ? candidate.code : nested.code;
  const message = typeof candidate.message === 'string' ? candidate.message : nested.message;
  return { code, message };
}

function messageContainsRecovery(message: string): boolean {
  return RECOVERY_WORDS.some((word) => message.includes(word));
}

function isSafeUserMessage(message: string, code: string): boolean {
  const text = message.trim();
  const normalizedCode = code.trim().toUpperCase();
  const isStructuredBusinessMessage = (
    normalizedCode === 'HAS_SPECIAL_MODELS'
      && /^以下模型被设置为系统模型，请先取消设置后再删除平台：.{1,200}$/u.test(text)
  ) || (
    normalizedCode === 'HAS_MODEL_POOL_REFS'
      && /^平台下的模型被以下模型池引用，请先从模型池移除：.{1,200}$/u.test(text)
  );
  if (!text || text.length > 320) return false;
  if (/[\r\n]/u.test(text)) return false;
  if (/^[{[]/.test(text)) return false;
  if (!/[\u3400-\u9fff]/u.test(text)) return false;
  if (INTERNAL_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(text))) return false;

  const isExplicitlyAllowed = USER_MESSAGE_ALLOWLIST.get(normalizedCode)?.has(text) === true;
  const isStableContractCode = /^[A-Z][A-Z0-9_]{2,80}$/u.test(normalizedCode);
  const isRegisteredCode = USER_FACING_CODE_MESSAGES.has(normalizedCode)
    || USER_MESSAGE_ALLOWLIST.has(normalizedCode);
  const containsUnregisteredTechnicalIdentifier = /\b[A-Za-z][A-Za-z0-9_.-]{2,}\b/u.test(text);
  // 未登记的新业务码只有在文案本身已满足“中文结果 + 恢复动作 + 无内部诊断”时才保留。
  // 这样新增端点不会被通用输入提示覆盖，同时仍禁止透传异常和上游原文。
  return isExplicitlyAllowed
    || isStructuredBusinessMessage
    || (!isRegisteredCode
      && isStableContractCode
      && !containsUnregisteredTechnicalIdentifier
      && messageContainsRecovery(text));
}

function classifiedMessage(code: string, recoveryMessage: string): string | null {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === 'UNAUTHORIZED') {
    return '当前登录状态无法完成此操作，请重新登录后重试。';
  }
  if (normalized === 'PERMISSION_DENIED') {
    return '当前账号没有执行此操作的权限，请联系管理员开通后重试。';
  }
  if (normalized === 'RATE_LIMITED') {
    return '当前请求较多，请稍后重试。';
  }
  if (normalized === 'TIMEOUT') {
    return '本次等待超时，请稍后重试。';
  }
  if (normalized === 'SHORT_VIDEO_INTERRUPTED') {
    return '短视频解析因服务重启而中断，请重新解析。';
  }
  if (normalized === 'SHORT_VIDEO_TIMEOUT') {
    return '短视频解析等待超时，请重新解析。';
  }
  if (normalized === 'DOCUMENT_TOO_LARGE' || normalized === 'FILE_TOO_LARGE') {
    return '文件超过当前大小限制，请缩小文件后重新上传。';
  }
  if (normalized === 'UNSUPPORTED_FILE_TYPE') {
    return '文件格式不受支持，请更换文件后重试。';
  }
  if (normalized === 'CONTENT_REJECTED') {
    return `提交内容未通过安全检查，${recoveryMessage}`;
  }
  if (normalized === 'NETWORK_ERROR' || normalized === 'SERVER_UNAVAILABLE' || normalized === 'SERVER_ERROR') {
    return `服务暂时不可用，${recoveryMessage}`;
  }
  return null;
}

export function toUserReadableErrorMessage(
  value: unknown,
  options: UserReadableErrorOptions,
): string {
  const extracted = extractErrorLike(value);
  const code = options.code || extracted.code || '';
  const classified = classifiedMessage(code, options.recoveryMessage);
  if (classified) return classified;

  const message = extracted.message?.trim() || '';
  const registered = registeredUserFacingMessage(code, message);
  if (registered) return registered;
  if (isSafeUserMessage(message, code)) {
    return messageContainsRecovery(message)
      ? message
      : `${message}，${options.recoveryMessage}`;
  }
  return `${options.fallbackMessage}，${options.recoveryMessage}`;
}
