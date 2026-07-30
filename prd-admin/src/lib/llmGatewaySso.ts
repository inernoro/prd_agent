const MAP_SSO_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * 网关控制台的落点，由**服务端**下发（`POST /api/llm-gateway/sso/ticket` 的 `console` 字段）。
 *
 * 这里刻意不再有任何域名推算。2026-07-29 之前本文件按 `location.hostname` 拼
 * `<预览 slug>-llmgw-web.miduo.org`，那是 CDS 之外的第二份域名实现（违反根 CLAUDE.md
 * 规则 #11），并且在分支名长时会拼出一个 CDS 根本没发布的 host：命名子域第一 DNS 标签
 * 超过 63 octet 时平台直接跳过不发布，前端却照拼，用户点开只看到「域名不存在」，
 * 而提示写的却是「登录凭据未通过安全校验」。
 *
 * 现在链路是单向的：CDS 注入已发布入口表 → prd-api 读取并下发 → 前端只消费。
 * 表里没有这一项，就如实说没有（no-rootless-tree：不假定不存在的能力）。
 */
export type LlmGatewayConsoleTarget = {
  /** 独立控制台基址（以 `/` 结尾）。空表示本部署没有独立入口，控制台与本站同源。 */
  baseUrl?: string | null;
  /** 有值表示「这是预览环境但该入口确实没发布」，文案由服务端给（含原因）。 */
  unavailableReason?: string | null;
};

/** 同源部署（正式环境）时控制台挂在这个路径下。 */
const SAME_ORIGIN_CONSOLE_BASE = '/llmgw/';

/** 只把固定格式的一次性 code 放进受控 Gateway 消费地址的 fragment。 */
function normalizeGatewayReturnTo(returnTo: unknown): string | null {
  if (returnTo == null || returnTo === '') return null;
  if (typeof returnTo !== 'string' || returnTo.length > 512) return null;
  if (!returnTo.startsWith('/') || returnTo.startsWith('//') || [...returnTo].some(char => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  })) return null;
  return returnTo;
}

/**
 * 跳转失败的两种原因，必须能分辨。
 *
 * 此前两者都被调用方笼统报成「登录凭据未通过安全校验」。但入口没发布跟凭据毫无关系——
 * 票据其实是签发成功的，只是这个环境没有独立的网关控制台。把部署拓扑问题说成凭据问题，
 * 会让人以为账号被封或鉴权坏了，从完全错误的方向开始排查。
 */
export type LlmGatewaySsoFailureReason = 'invalid-code' | 'console-entry-unpublished';

export type LlmGatewaySsoResolution =
  | { ok: true; href: string }
  | { ok: false; reason: LlmGatewaySsoFailureReason; message: string };

/** 带失败原因的解析结果。调用方据此给出可排查的提示，而不是一律说凭据有问题。 */
export function resolveLlmGatewaySso(
  code: unknown,
  target?: LlmGatewayConsoleTarget | null,
  returnTo?: string,
): LlmGatewaySsoResolution {
  if (typeof code !== 'string' || !MAP_SSO_CODE_PATTERN.test(code)) {
    return { ok: false, reason: 'invalid-code', message: '登录凭据未通过安全校验' };
  }

  const unavailableReason = target?.unavailableReason;
  if (typeof unavailableReason === 'string' && unavailableReason.length > 0) {
    return { ok: false, reason: 'console-entry-unpublished', message: unavailableReason };
  }

  const declared = target?.baseUrl;
  // 服务端没给基址 = 同源部署。绝不在这里按 hostname 推算一个跨域地址。
  const gatewayBase = typeof declared === 'string' && declared.length > 0
    ? (declared.endsWith('/') ? declared : `${declared}/`)
    : SAME_ORIGIN_CONSOLE_BASE;

  const safeReturnTo = normalizeGatewayReturnTo(returnTo);
  const query = safeReturnTo ? `?returnTo=${encodeURIComponent(safeReturnTo)}` : '';
  return { ok: true, href: `${gatewayBase}auth/map${query}#code=${code}` };
}

export function resolveLlmGatewaySsoHref(
  code: unknown,
  target?: LlmGatewayConsoleTarget | null,
  returnTo?: string,
): string | null {
  const resolution = resolveLlmGatewaySso(code, target, returnTo);
  return resolution.ok ? resolution.href : null;
}
