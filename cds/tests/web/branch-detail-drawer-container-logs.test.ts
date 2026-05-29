import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/components/BranchDetailDrawer.tsx'),
  'utf8',
);

describe('BranchDetailDrawer container log loading contract', () => {
  it('loads the default active deployment service logs without requiring a tab switch', () => {
    expect(source).toContain("activeTab !== 'deployments'");
    expect(source).toContain('!activeDeployment || !deploymentLogProfileId');
    expect(source).toContain('serviceLogs.profileId === deploymentLogProfileId && serviceLogs.status !== \'idle\'');
    expect(source).toContain('void loadServiceLogs(deploymentLogProfileId);');
  });
});
