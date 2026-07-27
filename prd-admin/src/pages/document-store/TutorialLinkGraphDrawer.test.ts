import { describe, expect, it } from 'vitest';
import { resolveTutorialProductRoute } from './TutorialLinkGraphDrawer';

describe('resolveTutorialProductRoute', () => {
  it('falls back from parameterized and query-dependent routes to safe list pages', () => {
    expect(resolveTutorialProductRoute('/logs/:id')).toBe('/logs');
    expect(resolveTutorialProductRoute('/app-callers/:id/prompt-policy')).toBe('/app-callers');
    expect(resolveTutorialProductRoute('/models/view')).toBe('/models');
  });

  it('keeps concrete routes unchanged', () => {
    expect(resolveTutorialProductRoute('/quickstart')).toBe('/quickstart');
  });
});
