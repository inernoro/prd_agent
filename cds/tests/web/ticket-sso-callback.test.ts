import { describe, expect, it } from 'vitest';

import { parseTicketSsoCallback } from '../../web/src/lib/ticket-sso-callback.js';

describe('ticket SSO callback parser', () => {
  it('parses the callback without mutating browser history', () => {
    const code = 'a'.repeat(43);
    const state = 'b'.repeat(43);

    expect(parseTicketSsoCallback(`#code=${code}&state=${state}`)).toEqual({ code, state });
    expect(parseTicketSsoCallback(`#code=${code}&state=${state}`)).toEqual({ code, state });
  });

  it('rejects missing, short, or malformed callback values', () => {
    expect(parseTicketSsoCallback('')).toBeNull();
    expect(parseTicketSsoCallback('#code=short&state=short')).toBeNull();
    expect(parseTicketSsoCallback(`#code=${'a'.repeat(43)}&state=invalid%20state`)).toBeNull();
  });
});
