import type { OutgoingHttpHeaders } from 'node:http';

/** Describe the matched branch's public authority without changing its upstream Host. */
export function setCdsForwardedHost(headers: OutgoingHttpHeaders, publicHost: string | undefined): void {
  // The incoming request may already have this header. It is owned by the proxy;
  // requests outside a branch route must never pass a client-supplied value through.
  if (publicHost) headers['x-cds-forwarded-host'] = publicHost;
  else delete headers['x-cds-forwarded-host'];
}
