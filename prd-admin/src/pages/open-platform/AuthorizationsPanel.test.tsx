import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AuthorizationTable } from './AuthorizationsPanel';
import type { AuthorizationSummary } from '@/services/real/authorizations';

const readOnlyAuthorization: AuthorizationSummary = {
  id: 'github:user-1',
  type: 'github',
  name: 'GitHub account',
  status: 'active',
  readOnly: true,
  metadata: { login: 'example-user' },
  lastUsedAt: '2026-07-22T00:00:00.000Z',
  lastValidatedAt: '2026-07-22T00:00:00.000Z',
  expiresAt: null,
  createdAt: '2026-07-22T00:00:00.000Z',
  updatedAt: '2026-07-22T00:00:00.000Z',
};

describe('AuthorizationsPanel authorization table', () => {
  it('renders read-only rows with SVG icons and theme-aware text tokens', () => {
    const html = renderToStaticMarkup(
      <AuthorizationTable
        items={[readOnlyAuthorization]}
        onValidate={vi.fn()}
        onEdit={vi.fn()}
        onRevoke={vi.fn()}
      />,
    );

    expect(html).toContain('<svg');
    expect(html).toContain('>github</span>');
    expect(html).toContain('text-token-primary');
    expect(html).toContain('text-token-secondary');
    expect(html).toContain('border-token-subtle');
    expect(html).toContain('surface-row');
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
