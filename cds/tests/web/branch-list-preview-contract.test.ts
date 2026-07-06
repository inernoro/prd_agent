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

  it('exposes an optional config-source (派生) selector wired into the create-branch POST body', () => {
    // 波3 补 UI:新建分支支持「配置来源分支」——UI 入口 + 透传 sourceBranchId。
    // 选择器控件常驻建议下拉,默认「项目模板(不派生)」。
    expect(source).toContain('配置来源');
    expect(source).toContain('项目模板(默认,不派生)');
    expect(source).toContain('onChangeConfigSource={setConfigSourceBranchId}');
    // 两条创建路径(手输/回车 + 选远程分支)都必须把选中的来源分支透传给后端。
    expect(source).toContain('void previewBranchByName(manualBranchName, configSourceBranchId)');
    expect(source).toContain('void previewRemoteBranch(remote, configSourceBranchId)');
    // 后端派生契约:仅在选了来源分支时带 sourceBranchId(默认走项目模板)。
    expect(source).toContain('...(sourceBranchId ? { sourceBranchId } : {})');
  });
});
