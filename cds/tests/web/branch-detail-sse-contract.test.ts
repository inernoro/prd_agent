import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/BranchDetailPage.tsx'),
  'utf8',
);

describe('BranchDetailPage SSE contract', () => {
  it('keeps detail stream parsing safe and avoids reconnecting on every state mutation', () => {
    expect(source).toContain('function parseSseJson<T>(event: Event): T | null');
    expect(source).toContain('const branchStreamProjectId =');
    expect(source).toContain('const branchStreamBranchId =');
    expect(source).toContain('parseSseJson<{ branchId?: string; projectId?: string; status?: BranchSummary');
    expect(source).toContain('parseSseJson<{ branch?: BranchSummary }>');
    expect(source).toContain('}, [branchStreamBranchId, branchStreamProjectId]);');
    expect(source).not.toContain('JSON.parse((ev as MessageEvent).data)');
  });
});
