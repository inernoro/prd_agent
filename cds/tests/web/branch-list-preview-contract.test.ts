import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/pages/BranchListPage.tsx'),
  'utf8',
);
const styles = fs.readFileSync(
  path.resolve(process.cwd(), '../cds/web/src/index.css'),
  'utf8',
);

describe('BranchListPage preview contract', () => {
  it('does not let the branch-card preview button silently deploy stopped branches', () => {
    expect(source).toContain('const openPreview = useCallback(async (branch: BranchSummary, deployWhenNeeded = false)');
    // 2026-07-09 性能重构：卡片回调改走稳定 handlers 对象（latest-ref 模式），
    // 契约不变——预览按钮必须以 deployWhenNeeded=false 调 openPreview。
    expect(source).toContain('onPreview: (branch: BranchSummary) => void cardCallbacksRef.current.openPreview(branch, false)');
    expect(source).toContain('预览不会自动部署，请手动点击部署');
    expect(source).not.toContain('openPreview(branch, true)');
  });

  it('keeps preview visually primary and quick start visually secondary', () => {
    expect(source).toContain("className={isAiOperated ? '' : 'w-32'}");
    expect(source).toContain("previewLabel={isAiOperated ? undefined : '预览'}");
    expect(source).toContain('className="cursor-pointer border-[hsl(var(--hairline-strong))] bg-transparent text-muted-foreground shadow-none hover:bg-muted/40 hover:text-foreground"');
  });

  it('keeps commit history separate from the current commit summary', () => {
    expect(source).toContain('bottom-[calc(100%+8px)]');
    expect(source).toContain('grid-cols-[64px_minmax(0,1fr)] gap-3');
    expect(source).toContain('block truncate font-mono text-muted-foreground');
  });

  it('uses a single shiny branch-title signal for active AI operation cards', () => {
    expect(source).toContain("import { ShinyText } from '@/components/effects/ShinyText'");
    expect(source).toContain('<ShinyText');
    expect(source).toContain('text={branch.branch}');
    expect(source).toContain('delay={1.4}');
    expect(source).toContain('cds-ai-active-rail');
    expect(source).not.toContain('cds-ai-active-card ring-1');
    expect(source).not.toContain("isAiActive ? 'cds-ai-kinetic-icon");
    expect(source).not.toContain('cds-ai-kinetic-dot');
    expect(styles).toContain('@keyframes cds-ai-rail-breathe');
    expect(styles).toContain("[data-theme='light'] .cds-ai-active-card");
    expect(styles).not.toContain('@keyframes cds-ai-trace');
    expect(styles).not.toContain('--cds-ai-angle');
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

  it('wires the 波5 detect-stack dialog into the empty (no build profiles) state', () => {
    // 空项目(无构建配置)时引导「检测技术栈」,而非只让用户去建分支。
    expect(source).toContain('<DetectStackDialog');
    expect(source).toContain('state.buildProfiles.length === 0');
    expect(source).toContain('检测技术栈');
    // apply 成功后刷新,让新生成的构建配置可见。
    expect(source).toContain('onApplied={() =>');
  });
});
