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

  /*
   * 2026-08-05 契约更替：AI 活跃态从「标题扫光是唯一主动态」换成方案 C（工位接管）——
   * 环境光扫掠 + AI 进度轨 + 徽章环形巡光，标题不再扫光。
   *
   * 旧版本的这条用例逐字要求 `import { ShinyText }` 与 `<ShinyText` 存在，属于
   * `.claude/rules/predicate-and-wiring-discipline.md` 形状 4a「反向锁死」——
   * 断言的是某段实现的字面存在，于是「谁换实现谁的 CI 红」。现在改成断言**契约**：
   * 每个信号各自表达一层信息、段数来自数据、类名不被摇树。
   */
  it('drives the AI-active card with scheme C signals (no stacked title shine)', () => {
    // 标题不再叠第四个动效：环境光 + 进度轨 + 徽章环已经表达了「被接管」
    expect(source).not.toContain('<ShinyText');
    expect(source).not.toContain("import { ShinyText } from '@/components/effects/ShinyText'");
    // 三个信号都必须真的接上（删掉任一处这条会红）
    expect(source).toContain('cds-ai-card-sweep');
    expect(source).toContain('cds-ai-badge-ring');
    expect(source).toContain('<AiRail state={aiRail}');
    // 历史上被砍掉的抢注意力动效不许回流
    expect(source).not.toContain('cds-ai-active-card ring-1');
    expect(source).not.toContain("isAiActive ? 'cds-ai-kinetic-icon");
    expect(source).not.toContain('cds-ai-kinetic-dot');
    expect(styles).toContain("[data-theme='light'] .cds-ai-active-card");
    expect(styles).not.toContain('@keyframes cds-ai-trace');
    expect(styles).not.toContain('--cds-ai-angle');
  });

  it('never hard-codes the AI progress rail segment count', () => {
    // 纪律：不知道总步数就不画分段——分段这个形状本身在承诺「共 N 步」，
    // 用户会据此估还要等多久。段数只能来自 state，退化档一律不分段。
    expect(source).toContain('AI_DEPLOY_STAGE_INDEX');
    expect(source).toContain("mode: 'indeterminate'");
    expect(source).toContain("mode: 'heartbeat'");
    // running 不许进阶段表：到 running 部署已结束，再显示「就绪 3/3」等于拿一条
    // 跑完的流水线冒充当前活动，会永远挂在那儿不动。
    const stageTable = source.match(/AI_DEPLOY_STAGE_INDEX[^=]*=\s*\{([^}]*)\}/);
    expect(stageTable, 'AI_DEPLOY_STAGE_INDEX 找不到了，守卫失效').not.toBeNull();
    expect(stageTable![1]).toMatch(/building\s*:/);
    expect(stageTable![1]).not.toMatch(/\brunning\s*:/);
    // heartbeat 档不画条，只用脉冲点——一条不表示任何进度的横线是噪音
    expect(source).toContain("aiRail.mode === 'heartbeat'");
    expect(source).toContain('cds-ai-pulse-dot');
  });

  it('writes rail modifier class names literally so Tailwind cannot tree-shake them', () => {
    /*
     * 真实事故（2026-08-05）：AiRail 曾写成 `cds-ai-rail--${orientation}`。这几条规则
     * 在 index.css 的 @layer components 里，Tailwind 会摇掉「选择器里的类没在源码
     * 字面出现过」的规则——拼接结果扫不到，--v/--h 两条规则被整条删除，而
     * tsc / vite build / 通读全都是绿的，只有比对构建产物才看得见。
     */
    expect(source).not.toMatch(/cds-ai-rail--\$\{/);
    expect(source).toContain("'cds-ai-rail cds-ai-rail--v'");
    expect(source).toContain("'cds-ai-rail cds-ai-rail--h'");
    expect(styles).toContain('.cds-ai-rail--v');
    expect(styles).toContain('.cds-ai-rail--h');
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
