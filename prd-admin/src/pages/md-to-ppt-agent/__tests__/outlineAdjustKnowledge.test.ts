import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../MdToPptAgentPage.tsx', import.meta.url), 'utf8');

/**
 * 调整大纲会另起一个大纲 run。确认生成时后端用新 run 的冻结知识来源与前端送上来的
 * activeKnowledgeRefs 逐条比对（MdToPptController.KnowledgeReferenceSetsMatch），
 * 对不上就 409 outline_knowledge_mismatch。所以调整请求必须把当前知识来源带过去——
 * 传空数组的话，知识驱动的 PPT 一经 AI 调整就再也生成不出来（Codex P1，2026-09-15）。
 *
 * 这是同一条判据的第二份写法：同文件里的旧调整路径本来就传了 knowledgeRefs（形状 3）。
 */
describe('AI 调整大纲要带上知识来源', () => {
  const body = source.slice(
    source.indexOf('const requestOutlineAdjust ='),
    source.indexOf('const startPatch ='),
  );

  it('调整请求把 activeKnowledgeRefs 传给 requestOutline，而不是空数组', () => {
    // companion：确实截到了那段函数体，否则下面几条会对着空串判绿。
    expect(body).toContain('requestOutline(');
    expect(body).toContain('adjustMode');
    expect(body, '调整请求把知识来源传成了空数组，知识驱动的 PPT 会 409 outline_knowledge_mismatch')
      .not.toMatch(/\[\],\s*\[\],/);
    expect(body).toContain('[], activeKnowledgeRefs,');
  });

  it('activeKnowledgeRefs 进了依赖数组，否则闭包会锁住旧值', () => {
    expect(body).toMatch(/\[outlineDraft, isProcessing, activeKnowledgeRefs, requestOutline/);
  });

  it('adjustMode 下 requestOutline 不回写 activeKnowledgeRefs，所以传它不会自覆盖', () => {
    expect(source).toContain('if (!adjustMode) setActiveKnowledgeRefs(kbRefs);');
  });
});
