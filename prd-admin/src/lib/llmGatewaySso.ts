const MAP_SSO_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
type GatewayLocation = Pick<Location, 'hostname' | 'protocol'>;

/** DNS 单个标签的长度上限，超出就没法解析出这个子域。 */
const DNS_LABEL_MAX = 63;
const PREVIEW_SUFFIX = '.miduo.org';
const GATEWAY_SERVICE_SUFFIX = '-llmgw-web';

export function resolveGatewayConsoleHref(location: GatewayLocation = window.location): string | null {
  if (!location.hostname.endsWith(PREVIEW_SUFFIX)) return '/llmgw/';

  if (location.hostname.endsWith(`${GATEWAY_SERVICE_SUFFIX}${PREVIEW_SUFFIX}`)) return '/';

  const previewSlug = location.hostname.slice(0, -PREVIEW_SUFFIX.length);
  const serviceLabel = `${previewSlug}${GATEWAY_SERVICE_SUFFIX}`;
  if (serviceLabel.length > DNS_LABEL_MAX) return null;
  return `${location.protocol}//${serviceLabel}${PREVIEW_SUFFIX}/`;
}

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
 * 此前两者都被调用方笼统报成「登录凭据未通过安全校验」。但预览域名超长跟凭据毫无关系——
 * 票据其实是签发成功的，只是拼不出网关子域。把主机名问题说成凭据问题，
 * 会让人以为账号被封或鉴权坏了，从完全错误的方向开始排查。
 */
export type LlmGatewaySsoFailureReason = 'invalid-code' | 'preview-host-too-long';

export type LlmGatewaySsoResolution =
  | { ok: true; href: string }
  | { ok: false; reason: LlmGatewaySsoFailureReason; message: string };

function previewHostTooLongMessage(location: GatewayLocation): string {
  const previewSlug = location.hostname.slice(0, -PREVIEW_SUFFIX.length);
  const overflow = previewSlug.length + GATEWAY_SERVICE_SUFFIX.length - DNS_LABEL_MAX;
  return `预览分支名过长，网关子域超出 DNS ${DNS_LABEL_MAX} 字符上限 ${overflow} 个字符，无法解析。请用更短的分支名重新部署，或在正式域名上打开。`;
}

/** 带失败原因的解析结果。调用方据此给出可排查的提示，而不是一律说凭据有问题。 */
export function resolveLlmGatewaySso(
  code: unknown,
  location: GatewayLocation = window.location,
  returnTo?: string,
): LlmGatewaySsoResolution {
  if (typeof code !== 'string' || !MAP_SSO_CODE_PATTERN.test(code)) {
    return { ok: false, reason: 'invalid-code', message: '登录凭据未通过安全校验' };
  }
  const gatewayBase = resolveGatewayConsoleHref(location);
  if (!gatewayBase) {
    return { ok: false, reason: 'preview-host-too-long', message: previewHostTooLongMessage(location) };
  }
  const safeReturnTo = normalizeGatewayReturnTo(returnTo);
  const query = safeReturnTo ? `?returnTo=${encodeURIComponent(safeReturnTo)}` : '';
  return { ok: true, href: `${gatewayBase}auth/map${query}#code=${code}` };
}

export function resolveLlmGatewaySsoHref(
  code: unknown,
  location: GatewayLocation = window.location,
  returnTo?: string,
): string | null {
  const resolution = resolveLlmGatewaySso(code, location, returnTo);
  return resolution.ok ? resolution.href : null;
}
