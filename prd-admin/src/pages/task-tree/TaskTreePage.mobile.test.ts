import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./taskTree.css', import.meta.url), 'utf8');
const mobileRules = css.slice(css.indexOf('@media (max-width: 640px)'));

describe('TaskTreePage mobile layout contract', () => {
  it('keeps the toolbar on one horizontal line without shrinking its title', () => {
    expect(mobileRules).toContain('overflow-x: auto');
    expect(mobileRules).toMatch(/\.tt-brand\s*\{[^}]*flex:\s*0 0 auto[^}]*white-space:\s*nowrap/s);
  });

  it('stacks the canvas and details panel within the phone width', () => {
    expect(mobileRules).toMatch(/\.tt-main\s*\{[^}]*flex-direction:\s*column/s);
    expect(mobileRules).toMatch(/\.tt-stage\s*\{[^}]*min-height:\s*320px/s);
    expect(mobileRules).toMatch(/\.tt-side\s*\{[^}]*width:\s*100%[^}]*border-left:\s*0/s);
  });
});
