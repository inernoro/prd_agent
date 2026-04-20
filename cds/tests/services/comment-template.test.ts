import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TEMPLATE_BODY,
  VARIABLE_DEFS,
  buildPrReviewDeeplink,
  buildTemplateVariables,
  renderTemplate,
} from '../../src/services/comment-template.js';

/**
 * Comment-template renderer tests.
 *
 * These protect the three invariants the feature depends on:
 *   1. Placeholder substitution is literal, not eval-style (so a template
 *      author can't accidentally run code or embed regex).
 *   2. Unknown `{{foo}}` stays as-is, making typos visible rather than
 *      silent data loss.
 *   3. `{{prReviewUrl}}` becomes empty when the base URL is unset, so
 *      the default template doesn't render a broken link on installs
 *      that haven't configured the deeplink target yet.
 */

describe('renderTemplate', () => {
  it('substitutes simple placeholders', () => {
    expect(renderTemplate('Hello {{name}}', { branch: 'x' } as unknown as Parameters<typeof renderTemplate>[1]))
      .toBe('Hello {{name}}'); // unknown key → stays
    expect(renderTemplate('[{{branch}}]', { branch: 'main' } as unknown as Parameters<typeof renderTemplate>[1]))
      .toBe('[main]');
  });

  it('tolerates whitespace inside braces', () => {
    expect(renderTemplate('{{ branch }} / {{  branch}}', { branch: 'feat/x' } as unknown as Parameters<typeof renderTemplate>[1]))
      .toBe('feat/x / feat/x');
  });

  it('does not recurse — value that looks like a placeholder stays literal', () => {
    expect(renderTemplate('{{branch}}', { branch: '{{commitSha}}' } as unknown as Parameters<typeof renderTemplate>[1]))
      .toBe('{{commitSha}}');
  });

  it('leaves unknown keys visible so typos surface', () => {
    expect(renderTemplate('Hi {{branhc}}', { branch: 'main' } as unknown as Parameters<typeof renderTemplate>[1]))
      .toBe('Hi {{branhc}}');
  });

  it('treats undefined values as "do not substitute"', () => {
    expect(renderTemplate('{{prUrl}}', {} as unknown as Parameters<typeof renderTemplate>[1]))
      .toBe('{{prUrl}}');
  });
});

describe('buildPrReviewDeeplink', () => {
  it('returns empty string when base URL is missing', () => {
    expect(buildPrReviewDeeplink(undefined, 'https://github.com/o/r/pull/1')).toBe('');
    expect(buildPrReviewDeeplink('', 'https://github.com/o/r/pull/1')).toBe('');
    expect(buildPrReviewDeeplink(null, 'https://github.com/o/r/pull/1')).toBe('');
  });

  it('returns empty string when PR URL is missing', () => {
    expect(buildPrReviewDeeplink('https://app.example.com', '')).toBe('');
  });

  it('drops trailing slash from base and URL-encodes PR URL', () => {
    expect(buildPrReviewDeeplink('https://app.example.com/', 'https://github.com/o/r/pull/1'))
      .toBe('https://app.example.com/pr-review?prUrl=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1&autoStart=1');
  });
});

describe('buildTemplateVariables', () => {
  it('derives shortSha and proxies empty fields safely', () => {
    const vars = buildTemplateVariables({
      branch: 'main',
      commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
      previewUrl: 'https://main.example.com',
      dashboardUrl: 'https://cds.example.com/branch-panel?id=main',
      repoFullName: 'o/r',
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      prReviewBaseUrl: 'https://app.example.com',
    });
    expect(vars.branch).toBe('main');
    expect(vars.shortSha).toBe('a1b2c3d');
    expect(vars.prNumber).toBe('7');
    expect(vars.prReviewUrl).toContain('/pr-review?prUrl=');
    expect(vars.prReviewUrl).toContain('autoStart=1');
  });

  it('yields empty prReviewUrl when no base is configured', () => {
    const vars = buildTemplateVariables({
      branch: 'main',
      commitSha: 'abc',
      previewUrl: '',
      dashboardUrl: '',
      repoFullName: 'o/r',
      prNumber: 1,
      prUrl: 'https://github.com/o/r/pull/1',
      prReviewBaseUrl: undefined,
    });
    expect(vars.prReviewUrl).toBe('');
  });
});

describe('DEFAULT_TEMPLATE_BODY + VARIABLE_DEFS integration', () => {
  it('default template references only variables we declare', () => {
    const declared = new Set(VARIABLE_DEFS.map((v) => v.key));
    const used = Array.from(DEFAULT_TEMPLATE_BODY.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g))
      .map((m) => m[1]);
    for (const name of used) {
      expect(declared.has(name), `default template references {{${name}}} which is not in VARIABLE_DEFS`).toBe(true);
    }
  });

  it('renders a believable preview when all vars are supplied', () => {
    const vars = buildTemplateVariables({
      branch: 'feature/login',
      commitSha: 'abcdef1234567890',
      previewUrl: 'https://feature-login.example.com',
      dashboardUrl: 'https://cds.example.com/branch-panel?id=feature-login',
      repoFullName: 'acme/demo',
      prNumber: 42,
      prUrl: 'https://github.com/acme/demo/pull/42',
      prReviewBaseUrl: 'https://app.example.com',
    });
    const rendered = renderTemplate(DEFAULT_TEMPLATE_BODY, vars);
    expect(rendered).toContain('feature/login');
    expect(rendered).toContain('abcdef1');
    expect(rendered).toContain('https://feature-login.example.com');
    expect(rendered).toContain('/pr-review?prUrl=');
    expect(rendered).not.toMatch(/\{\{[^}]+\}\}/); // no unresolved placeholders
  });
});
