import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/BranchListPage.tsx'),
  'utf8',
);

describe('BranchCard stopped branch restart contract', () => {
  it('shows a direct restart action for stopped containers without opening the detail drawer', () => {
    expect(source).toContain("createAction('restart', '正在重新启动')");
    expect(source).toContain("/restart`, { method: 'POST' }");
    expect(source).toContain('onRestart: (branch: BranchSummary) => void cardCallbacksRef.current.restartBranch(branch)');
    expect(source).toContain(') : hasStopSignal ? (');
    expect(source).toContain('aria-label={`一键启动 ${branch.branch}`}');
    expect(source).toContain('onClick={onRestart}');
    expect(source).toContain('一键启动已停止的容器，不拉取代码、不重建镜像');
  });
});
