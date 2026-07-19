type ConsoleLocation = Pick<Location, 'hostname' | 'protocol'>;

export function resolveMapHomeHref(location: ConsoleLocation = window.location): string {
  if (location.hostname.endsWith('.ebcone.net') && location.hostname !== 'map.ebcone.net') {
    return `${location.protocol}//map.ebcone.net/`;
  }

  const firstDot = location.hostname.indexOf('.');
  if (firstDot < 0) return '/';

  const hostPrefix = location.hostname.slice(0, firstDot);
  const gatewaySuffix = '-llmgw-web';
  if (!hostPrefix.endsWith(gatewaySuffix)) return '/';

  const mapHost = `${hostPrefix.slice(0, -gatewaySuffix.length)}${location.hostname.slice(firstDot)}`;
  return `${location.protocol}//${mapHost}/`;
}
