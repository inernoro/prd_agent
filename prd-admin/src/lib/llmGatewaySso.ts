const MAP_SSO_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
type GatewayLocation = Pick<Location, 'hostname' | 'protocol'>;

export function resolveGatewayConsoleHref(location: GatewayLocation = window.location): string | null {
  const previewSuffix = '.miduo.org';
  if (!location.hostname.endsWith(previewSuffix)) return '/llmgw/';

  if (location.hostname.endsWith(`-llmgw-web${previewSuffix}`)) return '/';

  const previewSlug = location.hostname.slice(0, -previewSuffix.length);
  const serviceLabel = `${previewSlug}-llmgw-web`;
  if (serviceLabel.length > 63) return null;
  return `${location.protocol}//${serviceLabel}${previewSuffix}/`;
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

export function resolveLlmGatewaySsoHref(
  code: unknown,
  location: GatewayLocation = window.location,
  returnTo?: string,
): string | null {
  if (typeof code !== 'string' || !MAP_SSO_CODE_PATTERN.test(code)) return null;
  const gatewayBase = resolveGatewayConsoleHref(location);
  if (!gatewayBase) return null;
  const safeReturnTo = normalizeGatewayReturnTo(returnTo);
  const query = safeReturnTo ? `?returnTo=${encodeURIComponent(safeReturnTo)}` : '';
  return `${gatewayBase}auth/map${query}#code=${code}`;
}
