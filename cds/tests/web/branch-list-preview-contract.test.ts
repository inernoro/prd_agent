import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/BranchListPage.tsx'),
  'utf8',
);

describe('BranchListPage preview contract', () => {
  it('does not let the branch-card preview button silently deploy stopped branches', () => {
    expect(source).toContain('const openPreview = useCallback(async (branch: BranchSummary, deployWhenNeeded = false)');
    expect(source).toContain('onPreview={() => void openPreview(branch, false)}');
    expect(source).toContain('预览不会自动部署，请手动点击部署');
    expect(source).not.toContain('onPreview={() => void openPreview(branch, true)}');
  });
});
