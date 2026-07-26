export interface TicketSsoCallback {
  code: string;
  state: string;
}

export function parseTicketSsoCallback(hash: string): TicketSsoCallback | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const code = params.get('code') || '';
  const state = params.get('state') || '';
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(code) || !/^[A-Za-z0-9_-]{32,256}$/.test(state)) {
    return null;
  }
  return { code, state };
}
