import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(__dirname, 'SiteGenerateDialog.tsx'), 'utf8');
const dialogSource = readFileSync(path.resolve(__dirname, '../ui/Dialog.tsx'), 'utf8');

describe('SiteGenerateDialog responsive layout contract', () => {
  it('keeps critical modal height inline and every grid branch shrinkable', () => {
    expect(source).toContain("width: 'min(1080px, calc(100vw - 16px))'");
    expect(source).toContain("maxWidth: 'calc(100vw - 16px)'");
    expect(source).toContain("height: 'min(760px, calc(100vh - 24px))'");
    expect(source).not.toContain('contentClassName="h-[');
    expect(source.match(/min-w-0/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('allows the shared dialog title block to shrink before the close button clips', () => {
    expect(dialogSource).toContain('className="min-w-0 flex-1"');
    expect(dialogSource).not.toContain('className="min-w-0 flex-shrink-0"');
  });

  it('keeps the primary action visible while mobile configuration scrolls and hides an empty preview', () => {
    expect(source).toContain('sticky bottom-0 z-10');
    expect(source).toContain("generating || previewHtml || completedSite ? 'flex' : 'hidden lg:flex'");
  });

  it('submits only knowledge identities and never truncates or uploads browser-fetched content', () => {
    expect(source).not.toContain('getDocumentContent');
    expect(source).not.toContain('.slice(0, 20_000)');
    expect(source).toContain('entryId: entry.id');
    expect(source).toContain('storeId: entry.storeId');
  });
});
