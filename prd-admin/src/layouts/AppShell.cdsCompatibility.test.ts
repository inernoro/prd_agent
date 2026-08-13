import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const layoutSource = readFileSync(path.resolve(testDirectory, 'AppShell.tsx'), 'utf8');
const globalsSource = readFileSync(path.resolve(testDirectory, '../styles/globals.css'), 'utf8');

describe('AppShell CDS preview compatibility', () => {
  it('keeps the sidebar account controls clear of the injected CDS badge', () => {
    expect(layoutSource).toContain('data-app-sidebar-account');
    expect(globalsSource).toContain('body:has(> [data-cds-widget-root]) [data-app-sidebar-account]');
    expect(globalsSource).toContain('padding-bottom: 52px');
  });
});
