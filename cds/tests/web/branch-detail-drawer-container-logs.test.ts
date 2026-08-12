import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/components/BranchDetailDrawer.tsx'),
  'utf8',
);
const deploymentSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/components/deployment/ActiveDeployment.tsx'),
  'utf8',
);
const monitoringSource = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/components/monitoring/MonitoringDialog.tsx'),
  'utf8',
);

describe('BranchDetailDrawer container log loading contract', () => {
  it('loads the default active deployment service logs without requiring a tab switch', () => {
    expect(source).toContain("activeTab !== 'deployments'");
    expect(source).toContain('!activeDeployment || !deploymentLogProfileId');
    expect(source).toContain('serviceLogs.profileId === deploymentLogProfileId && serviceLogs.status !== \'idle\'');
    expect(source).toContain('void loadServiceLogs(deploymentLogProfileId);');
  });

  it('分支详情在桌面端保持三分之二屏宽，移动端仍使用全屏', () => {
    expect(source).toContain('w-full flex-col');
    expect(source).toContain('md:w-2/3 md:border-l');
  });

  it('资源工作台和运维面板使用完整可用宽度，不保留桌面端最大宽度上限', () => {
    expect(source).not.toContain('max-w-[1760px]');
    expect(monitoringSource).not.toMatch(/max-w-\[min\(1100px/);
  });

  it('所有日志视图由 flex 分配剩余空间，不再硬编码 424px 高度', () => {
    expect(source).not.toContain('h-[424px]');
    expect(deploymentSource).not.toContain('h-[424px]');
    expect(source).toContain("const DETAIL_LOG_VIEWPORT_CLASS = 'min-h-0 flex-1 overflow-auto'");
    expect(source).toContain("activeTab === 'logs' ? 'flex min-h-0 flex-1 flex-col p-5'");
  });

  it('移动端容器选择器自动换行，不让服务按钮落到复制操作下方', () => {
    const selectorStart = source.indexOf('容器选择器：主容器 / 副本容器分两行分组');
    const selectorRegion = source.slice(selectorStart, source.indexOf('<ServiceLogsPanel', selectorStart));

    expect(selectorRegion).toContain('flex min-w-0 flex-1 flex-wrap gap-2');
    expect(selectorRegion).not.toContain('overflow-x-auto');
  });
});
