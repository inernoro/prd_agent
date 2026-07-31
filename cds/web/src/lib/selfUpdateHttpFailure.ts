/**
 * 更新请求「还没进到 SSE 就失败」时的中文归因（2026-07-30）。
 *
 * 后端的失败归因（services/self-update-failure-diagnosis.ts）只能覆盖请求
 * **进到应用之后**的失败。但更新还有一整类失败发生在更早：请求被边缘层
 * （反向代理 / CDN 规则 / 鉴权）挡回来，压根没到 Express。这时前端拿到的只有
 * 一个 HTTP 状态码和一段响应体，于是原样弹给用户：
 *
 *   触发更新失败 (503): self-update temporarily disabled by operations
 *   /api/self-update -> 503
 *
 * 这正是用户投诉的「普通更新总是有问题报错，还是英文错」里**最刺眼**的那一条：
 * 它每次必现（规则无条件生效）、全英文、而且因为没进应用，连更新历史都不会留记录，
 * 查历史还查不到——看上去就像系统随机抽风。
 *
 * 本模块把这一层也翻成「中文原因 + 下一步」。与后端归因同一套纪律，
 * 但**必须留在前端**：这些响应根本不经过后端。
 */

export interface SelfUpdateHttpFailure {
  cause: string;
  nextAction: string;
  /** 服务端返回的原文（多为英文），前端折叠展示，不做主文案。 */
  raw: string;
}

/** 从非 JSON / JSON 两种响应体里取出可读的原文。 */
function extractRawText(body: string): string {
  const trimmed = (body || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['message', 'error', 'reason']) {
      const value = parsed[key];
      if (typeof value === 'string' && value) return value;
    }
  } catch { /* 非 JSON，按纯文本处理 */ }
  return trimmed.slice(0, 500);
}

/**
 * 把「更新请求被挡回来」翻成中文。
 *
 * @param status HTTP 状态码
 * @param body   响应体原文
 * @param retryAfterSeconds Retry-After 头（秒），有的话用来说明"多久之后再试"
 */
export function diagnoseSelfUpdateHttpFailure(
  status: number,
  body: string,
  retryAfterSeconds?: number,
): SelfUpdateHttpFailure {
  const raw = extractRawText(body);
  const lower = raw.toLowerCase();

  // 503 + 明确写着 disabled：这是有人**主动**关掉了自更新，不是故障。
  // 说清楚「谁关的、去哪儿开」，否则用户只会反复点更新反复看到同一句英文。
  if (status === 503 && (lower.includes('disabled') || lower.includes('maintenance'))) {
    const window = retryAfterSeconds && retryAfterSeconds > 0
      ? `（服务端建议 ${Math.round(retryAfterSeconds / 60)} 分钟后再试）`
      : '';
    return {
      cause: `自更新入口已被运维主动关闭${window}，请求没有进到 CDS 应用，所以更新历史里也不会留记录。`,
      nextAction:
        '这不是 CDS 故障，也不是代码问题：需要先在反向代理 / CDN 侧解除对 '
        + '/api/self-update 的拦截规则，更新才会重新可用。若这条规则是某次事故期间临时加的，'
        + '确认事故已结束后移除即可。',
      raw,
    };
  }
  if (status === 503) {
    return {
      cause: '更新入口暂时不可用，请求被前置层挡回，没有进到 CDS 应用。',
      nextAction: '稍后重试；若持续如此，检查反向代理 / CDN 是否对该路径设了拦截或限流规则。',
      raw,
    };
  }
  if (status === 401 || status === 403) {
    return {
      cause: '登录状态已失效或当前账号没有执行更新的权限。',
      nextAction: '刷新页面重新登录后再试；仍不行则确认该账号是否具备 CDS 系统级操作权限。',
      raw,
    };
  }
  if (status === 429) {
    return {
      cause: '触发更新过于频繁，被限流挡下。',
      nextAction: '等待一分钟后再试，不要连续点击更新按钮。',
      raw,
    };
  }
  if (status === 502 || status === 504) {
    return {
      cause: 'CDS 应用没有响应，前置代理返回了网关错误。',
      nextAction: '确认 CDS 进程是否存活（可能正在重启）；等它起来后再试。',
      raw,
    };
  }
  return {
    cause: `更新请求被拒绝（HTTP ${status}），没有进入更新流程。`,
    nextAction: '展开原始响应看服务端说明；若无有效信息，检查前置代理与 CDS 进程状态。',
    raw,
  };
}

/** 拼成弹窗用的单串中文文案。 */
export function formatSelfUpdateHttpFailure(failure: SelfUpdateHttpFailure): string {
  return `更新失败：${failure.cause}\n\n下一步：${failure.nextAction}`;
}
