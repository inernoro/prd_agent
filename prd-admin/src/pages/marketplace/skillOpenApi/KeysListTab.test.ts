import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./KeysListTab.tsx', import.meta.url), 'utf8');

describe('KeysListTab destructive action confirmations', () => {
  it('uses the in-app dialog instead of a browser-native confirmation', () => {
    expect(source).toContain("import { systemDialog } from '@/lib/systemDialog';");
    expect(source).not.toContain('window.confirm');
  });

  it('keeps revoke and delete as explicit danger confirmations', () => {
    expect(source).toContain("title: '确认撤销 Key'");
    expect(source).toContain("confirmText: '撤销 Key'");
    expect(source).toContain("title: '确认删除 Key'");
    expect(source).toContain("confirmText: '彻底删除'");
    expect(source.match(/tone: 'danger'/g)).toHaveLength(2);
  });
});
