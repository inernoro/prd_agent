import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// 生成的任务逻辑在 useSiteGenerationRun，表单（要求、资料）在 NewSiteStage，工作台每次打开都重新挂载它。
const dialog = readFileSync(new URL('./workbench/useSiteGenerationRun.ts', import.meta.url), 'utf8');
const stage = readFileSync(new URL('./workbench/NewSiteStage.tsx', import.meta.url), 'utf8');
const workbench = readFileSync(new URL('./workbench/SiteWorkbench.tsx', import.meta.url), 'utf8');

/**
 * 恢复失败时说的话必须与表单此刻的真实状态一致（Codex P2，2026-09-15）。
 *
 * NOT_FOUND 分支原本写的是「原来的知识与要求仍保留，可以直接重新生成」。但打开弹窗
 * 那一步无条件 setInstruction('')，并且只有带 initialSource 时才预选知识——所以刷新后
 * 撞上这条分支的用户，生成按钮是禁用的：承诺了能直接重来，点下去却点不动，又是一次
 * 「白做一场」。
 *
 * 这是源码层守卫，不是渲染断言：断的是「这句话由 initialSource 推导出来」这条接线，
 * 以及它所依赖的两个前提（打开即清空、按钮确实卡这两项）。前提若被改动，companion
 * 断言会先红，提醒重审这段文案。
 */
describe('生成任务恢复不到时，不许承诺表单里还留着东西', () => {
  it('打开工作台确实会清空要求，没有带来源时连资料也清空', () => {
    // companion：这两条是整条判断的前提，它们变了这段文案就得重写。
    expect(workbench, '每次打开没有重新挂载新建阶段，上一轮的输入会漏进来').toContain('key={session}');
    expect(stage).toContain("const [instruction, setInstruction] = useState('');");
    expect(stage).toMatch(/useState<KnowledgeEntrySelection\[\]>\(\(\) => \(source \?/);
  });

  it('生成按钮确实卡着「有资料」', () => {
    // 资料 = 知识引用或已上传完的文件（含粘贴的纪要），任一即可；要求可以不写，有默认说法。
    expect(stage).toContain('const hasSources = selectedKnowledge.length > 0 || uploads.readyIds.length > 0;');
    expect(stage).toMatch(/!hasSources\s*\n?\s*\?/);
    expect(stage).toContain('sendDisabled={run.generating || Boolean(sendBlocker)}');
  });

  it('NOT_FOUND 那句话按 initialSource 分两种说法，且不再承诺「直接重新生成」', () => {
    const start = dialog.indexOf("result.error?.code === 'NOT_FOUND'");
    expect(start).toBeGreaterThan(-1);
    const branch = dialog.slice(start, start + 900);
    // companion：确实截到了那条分支（它会清掉 runId）。
    expect(branch).toContain('forgetActiveRun();');

    expect(branch, '文案得从真实状态推出来，不能是一句不看状态的承诺')
      .toContain('hasInitialSourceRef.current');
    expect(branch, '表单已被清空，不许再说「仍保留 / 可以直接重新生成」')
      .not.toContain('仍保留');
  });
});
