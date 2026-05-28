import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/BranchTopologyPage.tsx'),
  'utf8',
);

describe('BranchTopologyPage SSE contract', () => {
  it('routes branch stream events through the shared safe reducer instead of replacing the full list', () => {
    expect(source).toContain('reduceBranchListState');
    expect(source).toContain("type: 'sseSnapshot'");
    expect(source).toContain('confirmEmptyBranchList');
    expect(source).toContain("type: 'sseMalformed'");
    expect(source).toContain("type: 'sseBranchRemove'");
    expect(source).not.toContain('branches: data.branches || []');
    expect(source).not.toContain('JSON.parse((ev as MessageEvent).data)');
  });
});
