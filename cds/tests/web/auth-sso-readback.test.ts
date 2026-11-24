import { describe, expect, it } from 'vitest';
import { normalizeTicketSsoConfig } from '../../src/services/ticket-sso.js';
import { normalizeSsoReadbackFields } from '../../web/src/pages/cds-settings/tabs/AuthTab.js';

describe('SSO未知保存的可读字段核对合同', () => {
  for (const override of [
    { defaultRedirect: '', providerId: '  fixture-provider  ', clientId: '  fixture-client  ' },
    { defaultRedirect: ' /project-list?view=mine ', authorizationUrl: ' https://sso.example.invalid/authorize#fragment ', tokenUrl: 'https://sso.example.invalid' },
    { defaultRedirect: '//outside.example.invalid', providerId: '', label: '', clientId: 'x'.repeat(170) },
  ]) it(`读回核对与服务端归一化一致：${JSON.stringify(override)}`, () => {
    const input = { enabled: false, providerId: 'fixture', label: 'fixture label', authorizationUrl: 'https://sso.example.invalid/authorize', tokenUrl: 'https://sso.example.invalid/token', clientId: 'fixture-client', defaultRedirect: '/project-list', hasClientSecret: true, managedByEnvironment: false, ...override };
    const server = normalizeTicketSsoConfig(input), client = normalizeSsoReadbackFields(input);
    for (const key of ['enabled', 'providerId', 'label', 'authorizationUrl', 'tokenUrl', 'clientId', 'defaultRedirect'] as const) expect(client[key], key).toEqual(server[key]);
    expect(client).not.toHaveProperty('clientSecret');
  });
});
